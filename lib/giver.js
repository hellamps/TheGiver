'use strict';
const async = require('async');
const http = require('http');
const url = require('url');
const https = require('https');
const _ = require('lodash');
const express = require('express');
const redis = require('redis');

const redis_config_update_channel = 'giver_config_update';
const redis_giver_config = 'giver_config';

class Giver {
	constructor(logger, config, redis) {
		this.logger = logger;
		this.config = config;
		if (redis) {
			this.init_redis(redis);
		}
		//data
		this.mappings = config.mappings || {};
		this.uri_cache={};
		this.rebuild_uri_cache();
		this.subscribe_path = config.subscribe_path || '/subscribe';
		this.error_cache = {};
		this.init();
	}
	/* Redis routines */
	init_redis(redis_url) {
		this.redis = redis.createClient(redis_url);
		this.redis_ps = redis.createClient(redis_url);
		this.redis.on('connect', () => {
			this.redis_ps.on('connect', this.handle_redis_connect.bind(this));
		});
		this.redis.on('error', this.handle_redis_error.bind(this));
	}
	handle_redis_error(error) {
		this.logger.err(`Redis is unavailable: ${error}, exiting`);
		process.exit(1);
	}
	handle_redis_connect() {
		this.redis_ps.subscribe(redis_config_update_channel);
		this.redis_ps.on('message', this.handle_redis_message.bind(this));
		this.handle_redis_message(redis_config_update_channel);
	}
	handle_redis_message(channel) {
		if (channel === redis_config_update_channel) {
			this.redis.hgetall(redis_giver_config, (error, config) => {
				this.handle_redis_config(_.mapValues(config, JSON.parse) || {});
			});
		}
	}
	handle_redis_config(config) {
		//if we are part of cluster, redis is the truth
		this.mappings = config;
		this.uri_cache = {};
		this.rebuild_uri_cache();
	}
	rebuild_uri_cache() {
		_.flatten(_.values(this.mappings)).forEach((uri) => {
			if (uri) {
				this.uri_cache[uri] = this.uri_cache[uri] || url.parse(uri);
			}
		});
	}
	init() {
		this.app = express();
		this.app.use(require('connect-requestid'));
		this.app.use('/subscribe', express.json());
		this.app.use(this.handle_req.bind(this));
		const port = this.config.port || 8080;
		if (this.config.ssl_config) {
			this.https_server = https.createServer(
				this.config.ssl_config,
				this.app
			);
			this.https_server.listen(port);
		}
		else {
			this.app.listen(port);
		}
	}
	handle_req(request, response) {
		if (request.path === this.subscribe_path) {
			return this.handle_register(request, response);
		}
		if (request.path === '/mappings') {
			return response.send(this.mappings);
		}
		const mapping = this.mappings[request.path];
		if (!mapping) {
			return response.send('No map');
		}
		const request_route = request.route ? request.route.path : request.url;
		this.logger.info(`[${request.id}] Gifting ` + [request.method, request.url, request_route, request.headers.host].join(' '));
		const sinks = mapping.map((sink) => {
			const uri_opts = this.uri_cache[sink];
			if (!uri_opts) {
				return null;
			}
			const options = {
				hostname: uri_opts.hostname,
				path: uri_opts.path,
				method: request.method,
				headers: request.headers
			};
			if(uri_opts.port) {
				options.port = uri_opts.port;
			}
			options.headers.host = uri_opts.hostname;
			const proto = uri_opts.protocol === 'http:' ? http : https;
			this.logger.info(`[${request.id}] Giving ` + JSON.stringify(options));
			const outgoing = proto.request(options, (response) => {
				this.logger.info("RESPONSE HEADERS:", response.req_id, JSON.stringify(response.headers));
				response.req_id = request.id;
			});
			outgoing.on('error', (error) => {
				this.logger.warn(`[${request.id}] Outgoing error: ${sink}`, JSON.stringify(error));
				this.error_cache[sink] = this.error_cache[sink] ? this.error_cache[sink] + 1 : 1;
			});
			outgoing.on('close', (error) => {
				this.logger.info(`[${request.id}] Gift given: ` + options.hostname);
			});
			return outgoing;
		});
		request.on('readable', () => {
			const chunk = request.read();
			if (chunk) {
				sinks.forEach((outgoing) => {
					if (outgoing) {
						outgoing.write(chunk);
					};
				});
			}
		});
		request.on('end', () => {
			sinks.forEach((outgoing) => {
				if (outgoing) {
					outgoing.end();
				}
			});
			this.logger.info(`[${request.id}] Sending 200 to incoming connection`);
			response.sendStatus(200);
		});
	}
	handle_register(request, response) {
		//not ACID really, but who cares...
		//we expect here: body.endpoint
		//body.uri - uri
		if (!_.get(request, 'body.endpoint')) {
			return response.sendStatus(500);
		}
		const hdels = [];
		const hsets = [];
		if (!this.redis) {
			this.merge_into_config(this.mappings, hdels, hsets, request.body.endpoint, request.body.uri);
			return response.sendStatus(200);
		}
		this.redis.hgetall(redis_giver_config, (error, config) => {
			if (error) {
				return response.sendStatus(500);
			}
			const parsed_config = _.mapValues(config, JSON.parse) || {};
			this.merge_into_config(parsed_config, hdels, hsets, request.body.endpoint, request.body.uri);
			async.parallel([
				(callback) => {
					async.parallel(
						hdels.map((hdel) => {
							return (cb) => { this.redis.hdel(redis_giver_config, hdel, cb);};
						}),
						(err) => {
							return callback(error);
						}
					);
				},
				(callback) => {
					async.parallel(
						hsets.map((hset) => {
							return (cb) => { this.redis.hset(redis_giver_config, hset.key, hset.value, cb); };
						}),
						(err) => {
							return callback(error);
						}
					);
				}],
				(err) => {
					this.redis.publish(redis_config_update_channel, 'config');
					response.sendStatus(200);
				});
		});
	}
	merge_into_config(parsed_config, hdels, hsets, endpoint, uri) {
		_.forEach(parsed_config, (uris, mapping) => {
			if (mapping === endpoint) {
				if (!(uris.indexOf(uri) > -1)) {
					uris.push(uri);
					hsets.push({key: mapping, value:JSON.stringify(uris)});
				}
			}
			else {
				if (uris.indexOf(uri) > -1) {
					_.pull(uris, uri);
					if (uris.length > 0) {
						hsets.push({key: mapping, value:JSON.stringify(uris)});
					}
					else {
						hdels.push(mapping);
					}
				}
			}
		});
		if (!parsed_config[endpoint]) {
			parsed_config[endpoint] = [uri];
			hsets.push({key: endpoint, value:JSON.stringify([uri])});
		}
	}
};
module.exports = Giver;
