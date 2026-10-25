'use strict';

// Deterministic upstreams for ais-relay-ingestion.test.cjs. This file is only
// loaded through NODE_OPTIONS by that test; production relay processes never
// load it.
const { EventEmitter } = require('node:events');
const https = require('node:https');
// Node 24 loads the shared TypeScript module directly (type stripping), so the
// emergency codes have one source of truth across TS, ESM and CommonJS.
const { EMERGENCY_CODES } = require('../shared/aircraft-emergencies.ts');

const googleStatuses = (process.env.RELAY_TEST_GOOGLE_STATUS_SEQUENCE || '429')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter(Number.isFinite);
// Raw Google Flights results-page bodies consumed per response; exhausted -> ''.
const googleBodies = process.env.RELAY_TEST_GOOGLE_BODY_SEQUENCE
  ? JSON.parse(process.env.RELAY_TEST_GOOGLE_BODY_SEQUENCE)
  : [];
// OpenSky upstream statuses consumed per request; exhausted -> 429 (throttled,
// the production condition under test). A 200 serves one military-callsign
// state inside iran-theater bounds.
const openskyStatuses = (process.env.RELAY_TEST_OPENSKY_STATUS_SEQUENCE || '')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);
const openskyRetryAfterSeconds = Number(process.env.RELAY_TEST_OPENSKY_RETRY_AFTER_SECONDS || 0);
const openskyRemainingCredits = Number(process.env.RELAY_TEST_OPENSKY_REMAINING_CREDITS || 0);
const openskyResponseDelayMs = Number(process.env.RELAY_TEST_OPENSKY_RESPONSE_DELAY_MS || 0);
const openskyMalformedEncoding = process.env.RELAY_TEST_OPENSKY_MALFORMED_ENCODING === '1';
const wingbitsEchoAreas = process.env.RELAY_TEST_WINGBITS_ECHO_AREAS === '1';
const wingbitsGhostRows = process.env.RELAY_TEST_WINGBITS_GHOST_ROWS === '1';
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
const emergencyCodes = process.env.RELAY_TEST_EMERGENCY_ROWS === '1' ? [...EMERGENCY_CODES] : [];
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

function request({ callback, statusCode, body = '', headers = {}, error = null, timeout = false, delayMs = 0 }) {
  const req = new EventEmitter();
  req.write = () => {};
  req.end = () => {};
  req.setTimeout = () => req;
  req.destroy = () => req;
  const emitResponse = () => {
    if (timeout) {
      req.emit('timeout');
      return;
    }
    if (error) {
      const err = new Error(error);
      err.code = 'ECONNRESET';
      req.emit('error', err);
      return;
    }
    response(statusCode, body, headers, callback);
  };
  if (delayMs > 0) setTimeout(emitResponse, delayMs);
  else process.nextTick(emitResponse);
  return req;
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const target = String(url);
  if (target.includes('/travel/flights/search')) {
    const status = nextValue(googleStatuses, 200);
    const body = nextValue(googleBodies, '');
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => body,
    };
  }
  if (target.includes('api.adsb.lol')) {
    const mode = nextValue(adsbModes, 'error');
    if (mode === 'empty') {
      return { status: 200, ok: true, statusText: 'OK', text: async () => '', json: async () => ({ ac: [] }) };
    }
    if (mode === 'malformed') {
      return { status: 200, ok: true, statusText: 'OK', text: async () => '', json: async () => ({}) };
    }
    if (mode === 'flight') {
      return {
        status: 200,
        ok: true,
        statusText: 'OK',
        text: async () => '',
        json: async () => ({ ac: [{ hex: 'ae8888', flight: 'RCH888', lat: 30, lon: 45, alt_baro: 10000, track: 90, gs: 400 },
          ...emergencyCodes.map((squawk, index) => ({ hex: `ae000${index}`, flight: `RCH${squawk}`, squawk, lat: 30, lon: 45, alt_baro: 10000 }))] }),
      };
    }
    // Theater-posture fallback chain: adsb.lol is down, forcing Wingbits.
    return { status: 503, ok: false, statusText: 'Service Unavailable', text: async () => '', json: async () => ({}) };
  }
  if (target.includes('customer-api.wingbits.com')) {
    if (wingbitsEchoAreas) {
      const areas = JSON.parse(String(options?.body || '[]'));
      return {
        status: 200,
        ok: true,
        statusText: 'OK',
        text: async () => '',
        json: async () => areas.map((area, index) => ({
          alias: area.alias,
          data: [{ h: `tile${index}`, f: `TILE${index}`, la: area.la, lo: area.lo, ab: 30000 }],
        })),
      };
    }
    if (wingbitsGhostRows) {
      return {
        status: 200,
        ok: true,
        statusText: 'OK',
        text: async () => '',
        json: async () => ([{
          alias: 'iran-theater',
          data: [
            { h: 'ae0001', f: 'RCH001', ab: 30000 },
            { h: 'ae0002', f: 'RCH002', la: 0, lo: 0, ab: 30000 },
          ],
        }]),
      };
    }
    // One military-callsign flight inside iran-theater bounds.
    return {
      status: 200,
      ok: true,
      statusText: 'OK',
      text: async () => '',
      json: async () => ([{
        alias: 'iran-theater',
        data: [{ h: 'ae1234', f: 'RCH123', la: 30, lo: 45, ab: 30000, th: 90, gs: 400 },
          ...emergencyCodes.map((sq, index) => ({ h: `ae000${index}`, f: `RCH${sq}`, sq, la: 30, lo: 45, ab: 30000 }))],
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
    const headers = {
      'content-type': 'application/json',
      'x-rate-limit-remaining': String(openskyRemainingCredits),
    };
    if (status === 429 && openskyRetryAfterSeconds > 0) {
      headers['x-rate-limit-retry-after-seconds'] = String(openskyRetryAfterSeconds);
    }
    if (status === 429 && openskyMalformedEncoding) headers['content-encoding'] = 'gzip';
    return request({
      callback: cb,
      statusCode: status,
      body: JSON.stringify({ states: status === 200 ? [OPENSKY_MIL_STATE, ...emergencyCodes.map((squawk, index) => {
        const row = Array.from({ length: 15 }, (_, i) => OPENSKY_MIL_STATE[i] ?? null);
        row[0] = `ae000${index}`;
        row[1] = `RCH${squawk}`;
        row[14] = squawk;
        return row;
      })] : [], time: Date.now() }),
      headers,
      delayMs: openskyResponseDelayMs,
    });
  }
  if (parsed.hostname === 'feeds.bbci.co.uk') {
    const key = parsed.searchParams.get('test') || parsed.pathname;
    const callNumber = (rssCalls.get(key) || 0) + 1;
    rssCalls.set(key, callNumber);
    let mode = 'error';
    if ((key === 'stale' || key === 'forbidden' || key === 'server-error' || key === 'timeout' || key === 'dedup' || key === 'dedup-timeout') && callNumber === 1) {
      mode = 'success';
    } else if (key === 'forbidden') {
      mode = 'forbidden';
    } else if (key === 'server-error') {
      mode = 'server-error';
    } else if (key === 'timeout') {
      mode = 'timeout';
    } else if (key === 'dedup') {
      mode = 'forbidden';
    } else if (key === 'dedup-timeout') {
      mode = 'timeout';
    }
    if (mode === 'error') return request({ callback: cb, error: 'RSS upstream reset' });
    if (mode === 'timeout') return request({ callback: cb, timeout: true, delayMs: key === 'dedup-timeout' ? 25 : 0 });
    if (mode === 'server-error') {
      return request({
        callback: cb,
        statusCode: 503,
        body: 'Service unavailable',
        headers: { 'content-type': 'text/html' },
      });
    }
    if (mode === 'forbidden') {
      return request({
        callback: cb,
        statusCode: 403,
        body: 'Forbidden',
        headers: { 'content-type': 'text/html' },
        delayMs: key === 'dedup' ? 25 : 0,
      });
    }
    return request({
      callback: cb,
      statusCode: 200,
      body: '<rss><channel><title>test</title></channel></rss>',
      headers: { 'content-type': 'application/rss+xml' },
    });
  }
  return originalGet.apply(this, args);
};
