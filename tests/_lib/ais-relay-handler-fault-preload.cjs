// Fault injection preloaded into a spawned relay by
// tests/ais-relay-handler-failure-e2e.test.mjs. RELAY_TEST_FAULT is a
// comma-separated list:
//   ucdp   -> the UCDP API answers page 0 with two pages, and the page 1 fetch
//             fails with a non-Error value, so the /ucdp-events handler's own
//             catch (`err.message`) throws after its first await.
//   status -> the X Post budget store rejects, so the router's own
//             `await xPostBudget.status()` on /status throws.
// No real network is used.
'use strict';

const https = require('node:https');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const faults = new Set(String(process.env.RELAY_TEST_FAULT || '').split(',').filter(Boolean));

if (faults.has('ucdp')) {
  const originalGet = https.get;
  https.get = function get(...args) {
    const [url, , callback] = args;
    const target = typeof url === 'string' ? new URL(url) : null;
    if (target?.hostname !== 'ucdpapi.pcr.uu.se') return originalGet.apply(this, args);
    // Thrown inside the caller's Promise executor, so the page promise rejects with null.
    if (target.searchParams.get('page') !== '0') throw null; // eslint-disable-line no-throw-literal
    const request = new EventEmitter();
    request.destroy = () => {};
    request.end = () => {};
    const response = new PassThrough();
    response.statusCode = 200;
    process.nextTick(() => {
      callback(response);
      response.end(JSON.stringify({ TotalPages: 2, Result: [{ id: 1, date_start: '2026-10-01' }] }));
    });
    return request;
  };
}

if (faults.has('status')) {
  const budget = require(path.join(__dirname, '..', '..', 'scripts', 'lib', 'x-post-budget.cjs'));
  const createXPostBudget = budget.createXPostBudget;
  budget.createXPostBudget = (...args) => ({
    ...createXPostBudget(...args),
    status: async () => { throw new Error('budget store unavailable'); },
  });
}
