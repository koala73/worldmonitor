import assert from 'node:assert/strict';
import { afterEach, it, mock } from 'node:test';

import { oauthRateLimitHeaders } from '../api/oauth/_rate-limit-headers.js';

afterEach(() => mock.restoreAll());

// Each Date.now() call returns the next value; the last one repeats.
function stubClock(...values) {
  let i = 0;
  mock.method(Date, 'now', () => values[Math.min(i++, values.length - 1)]);
}

const T0 = 1_700_000_000_000;

it('derives Retry-After and RateLimit-Reset from one clock read', () => {
  // The first read sees 30.002 s left (ceil 31). A second read 5 ms later sees
  // 29.997 s (ceil 30). Two independent reads would publish 31 and 30.
  stubClock(T0, T0 + 5);
  const headers = oauthRateLimitHeaders({ limit: 10, reset: T0 + 30_002 });
  assert.equal(headers['Retry-After'], '31');
  assert.equal(headers['RateLimit-Reset'], '31');
  assert.equal(headers.RateLimit, '"default";r=0;t=31');
});

it('floors both headers at one second when the reset is already past', () => {
  stubClock(T0);
  const headers = oauthRateLimitHeaders({ limit: 10, reset: T0 - 5_000 });
  assert.equal(headers['Retry-After'], '1');
  assert.equal(headers['RateLimit-Reset'], '1');
  assert.equal(headers['X-RateLimit-Reset'], String(T0 + 1_000));
});

it('falls back to one whole window when the limiter gave no reset', () => {
  stubClock(T0);
  const headers = oauthRateLimitHeaders({ limit: 10, reset: 0 });
  assert.equal(headers['Retry-After'], '60');
  assert.equal(headers['RateLimit-Reset'], '60');
  assert.equal(headers['RateLimit-Policy'], '"default";q=10;w=60');
});
