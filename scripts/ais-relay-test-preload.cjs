'use strict';

// Deterministic upstreams for ais-relay-ingestion.test.cjs. This file is only
// loaded through NODE_OPTIONS by that test; production relay processes never
// load it.
const { EventEmitter } = require('node:events');
const https = require('node:https');

const googleStatuses = (process.env.RELAY_TEST_GOOGLE_STATUS_SEQUENCE || '429')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter(Number.isFinite);
const rssCalls = new Map();

function nextValue(values, fallback) {
  return values.length > 0 ? values.shift() : fallback;
}

function targetUrl(input) {
  if (typeof input === 'string') return new URL(input);
  if (input?.href) return new URL(input.href);
  const protocol = input?.protocol || 'https:';
  const hostname = input?.hostname || input?.host || 'localhost';
  const port = input?.port ? `:${input.port}` : '';
  const path = input?.path || '/';
  return new URL(`${protocol}//${hostname}${port}${path}`);
}

function response(statusCode, body, headers, callback) {
  const result = new EventEmitter();
  result.statusCode = statusCode;
  result.headers = headers;
  process.nextTick(() => {
    callback(result);
    process.nextTick(() => {
      if (body) result.emit('data', Buffer.from(body));
      result.emit('end');
    });
  });
}

function request({ callback, statusCode, body = '', headers = {}, error = null }) {
  const req = new EventEmitter();
  req.write = () => {};
  req.end = () => {};
  req.setTimeout = () => req;
  req.destroy = () => req;
  process.nextTick(() => {
    if (error) {
      const err = new Error(error);
      err.code = 'ECONNRESET';
      req.emit('error', err);
      return;
    }
    response(statusCode, body, headers, callback);
  });
  return req;
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url).includes('FlightsFrontendService')) {
    const status = nextValue(googleStatuses, 200);
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => '',
    };
  }
  if (typeof originalFetch === 'function') return originalFetch(url);
  throw new Error(`Unexpected test fetch: ${url}`);
};

const originalRequest = https.request;
https.request = function patchedRequest(...args) {
  const [input, options, callback] = args;
  const cb = typeof options === 'function' ? options : callback;
  const parsed = targetUrl(input);
  if (parsed.hostname === 'auth.opensky-network.org') {
    return request({
      callback: cb,
      statusCode: 200,
      body: JSON.stringify({ access_token: 'test-opensky-token', expires_in: 3600 }),
      headers: { 'content-type': 'application/json' },
    });
  }
  return originalRequest.apply(this, args);
};

const originalGet = https.get;
https.get = function patchedGet(...args) {
  const [input, options, callback] = args;
  const cb = typeof options === 'function' ? options : callback;
  const parsed = targetUrl(input);
  if (parsed.hostname === 'opensky-network.org') {
    return request({
      callback: cb,
      statusCode: 429,
      body: JSON.stringify({ states: [], time: Date.now() }),
      headers: { 'content-type': 'application/json' },
    });
  }
  if (parsed.hostname === 'feeds.bbci.co.uk') {
    const key = parsed.searchParams.get('test') || parsed.pathname;
    const callNumber = (rssCalls.get(key) || 0) + 1;
    rssCalls.set(key, callNumber);
    const mode = key === 'stale' && callNumber === 1 ? 'success' : 'error';
    if (mode === 'error') return request({ callback: cb, error: 'RSS upstream reset' });
    return request({
      callback: cb,
      statusCode: 200,
      body: '<rss><channel><title>test</title></channel></rss>',
      headers: { 'content-type': 'application/rss+xml' },
    });
  }
  return originalGet.apply(this, args);
};
