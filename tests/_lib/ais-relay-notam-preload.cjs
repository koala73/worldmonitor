// Preloaded into a spawned relay by tests/ais-relay-notam-locations-e2e.test.mjs.
// Answers the ICAO NOTAM request locally and logs the exact upstream query, so
// the test can see what the relay sent. No real network is used.
'use strict';

const https = require('node:https');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const originalGet = https.get;
https.get = function get(...args) {
  const [url, , callback] = args;
  const target = typeof url === 'string' ? new URL(url) : null;
  if (target?.hostname !== 'dataservices.icao.int') return originalGet.apply(this, args);
  console.log(`NOTAM_UPSTREAM_QUERY ${target.search}`);
  const request = new EventEmitter();
  request.destroy = () => {};
  request.end = () => {};
  const response = new PassThrough();
  response.statusCode = 200;
  response.headers = { 'content-type': 'application/json' };
  process.nextTick(() => {
    callback(response);
    response.end('[]');
  });
  return request;
};
