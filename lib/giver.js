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
		this.logger = logger || console;
		this.config = config;
		if (redis) {
			this.init_redis(redis);
		}
		//data
		this.mappings = config.mappings || {};
		this.uri_cache={};
		this.rebuild_uri_cache();
		this.register_path = config.register_path || '/register';
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
		this.app.all('*', this.handle_req);
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
		if (request.path === this.register_path) {
			return handle_register(request, response);
		}
		const mapping = this.mappings[req.path];
		if (!mapping) {
			response.send('No map');
		}
		const request_route = request.route ? request.route.path : request.url;
		this.logger.info("Gifting " + [request.id, request.method, request.url, request_route, request.headers.host].join(' '));
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
			this.logger.info("giving " + req.id + " " + JSON.stringify(options));
			const outgoing = proto.request(options, (response) => {
				this.logger.info("RESPONSE HEADERS:", response.req_id, JSON.stringify(response.headers));
				response.req_id = request.id;
			});
			outgoing.on('error', function(error) {
				this.logger.warn("Outgoing error: " + endpoint, JSON.stringify(error));
				this.error_cache[sink] = this.error_cache[sink] ? this.error_cache[sink] + 1 : 1;
			});
			outgoing.on('close', function(error) {
				this.logger.info("gift given " + req.id + " " + options.hostname);
			});
			return outgoing;
		});
		request.on('readable', () => {
			const chunk = req.read();
			if (chunk) {
				outgoings.forEach((outgoing) => {
					if (outgoing) {
						outgoing.write(chunk);
					};
				});
			}
		});
		request.on('end', () => {
			outgoings.forEach((outgoing) => {
				if (outgoing) {
					outgoing.end();
				}
			});
		res.sendStatus(200);
		});
	}
	handle_register(request, response) {
		//stub for adding mappings on fly
	}
};

module.exports = Giver;
