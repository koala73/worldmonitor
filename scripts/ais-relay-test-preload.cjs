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
// OpenSky upstream statuses consumed per request; exhausted -> 429 (throttled,
// the production condition under test). A 200 serves one military-callsign
// state inside iran-theater bounds.
const openskyStatuses = (process.env.RELAY_TEST_OPENSKY_STATUS_SEQUENCE || '')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);
// adsb.lol modes consumed per request: 'error' -> 503 (falls through to
// Wingbits), 'empty' -> 200 with zero aircraft (authoritative quiet skies —
// stops the fallback chain), 'flight' -> 200 with one military aircraft in
// iran-theater bounds. Exhausted -> 'error'.
const adsbModes = (process.env.RELAY_TEST_ADSB_MODE_SEQUENCE || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
// OpenSky /states/all row: [icao24, callsign, country, t_pos, t_contact, lon, lat, alt, onGround, velocity, heading]
const OPENSKY_MIL_STATE = ['ae9999', 'RCH999  ', '', 0, 0, 45, 30, 10000, false, 400, 90];
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
globalThis.fetch = async (url, options) => {
  const target = String(url);
  if (target.includes('FlightsFrontendService')) {
    const status = nextValue(googleStatuses, 200);
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => '',
    };
  }
  if (target.includes('api.adsb.lol')) {
    const mode = nextValue(adsbModes, 'error');
    if (mode === 'empty') {
      return { status: 200, ok: true, statusText: 'OK', text: async () => '', json: async () => ({ ac: [] }) };
    }
    if (mode === 'flight') {
      return {
        status: 200,
        ok: true,
        statusText: 'OK',
        text: async () => '',
        json: async () => ({ ac: [{ hex: 'ae8888', flight: 'RCH888', lat: 30, lon: 45, alt_baro: 10000, track: 90, gs: 400 }] }),
      };
    }
    // Theater-posture fallback chain: adsb.lol is down, forcing Wingbits.
    return { status: 503, ok: false, statusText: 'Service Unavailable', text: async () => '', json: async () => ({}) };
  }
  if (target.includes('customer-api.wingbits.com')) {
    // One military-callsign flight inside iran-theater bounds.
    return {
      status: 200,
      ok: true,
      statusText: 'OK',
      text: async () => '',
      json: async () => ([{
        alias: 'iran-theater',
        data: [{ h: 'ae1234', f: 'RCH123', la: 30, lo: 45, ab: 30000, th: 90, gs: 400 }],
      }]),
    };
  }
  if (typeof originalFetch === 'function') return originalFetch(url, options);
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
    const status = nextValue(openskyStatuses, 429);
    return request({
      callback: cb,
      statusCode: status,
      body: JSON.stringify({ states: status === 200 ? [OPENSKY_MIL_STATE] : [], time: Date.now() }),
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
