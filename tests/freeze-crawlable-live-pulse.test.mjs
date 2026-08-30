import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  authedGet,
  mintSession,
  normalizeApiBase,
} from '../scripts/freeze-crawlable-live-pulse.mjs';

describe('freeze crawlable live pulse API base routing', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('normalizes trailing slashes on supplied API bases', () => {
    assert.equal(normalizeApiBase('https://staging.example/'), 'https://staging.example');
    assert.equal(normalizeApiBase('https://staging.example'), 'https://staging.example');
  });

  it('mints sessions and authenticated GETs against the supplied API base', async () => {
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      calls.push({
        url: String(url),
        method: options.method || 'GET',
        origin: options.headers?.Origin,
        referer: options.headers?.Referer,
        cookie: options.headers?.Cookie,
      });
      if (String(url).endsWith('/api/wm-session')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ token: 'test-token' }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true }),
      };
    };

    const base = 'https://staging.worldmonitor.test';
    const token = await mintSession(base);
    assert.equal(token, 'test-token');
    await authedGet('/api/intelligence/v1/get-country-risk?country_code=NO', token, base);

    assert.deepEqual(calls.map((call) => call.url), [
      `${base}/api/wm-session`,
      `${base}/api/intelligence/v1/get-country-risk?country_code=NO`,
    ]);
    assert.ok(calls.every((call) => call.origin === base && call.referer === `${base}/`));
    assert.equal(calls[1].cookie, 'wm-session=test-token');
  });
});
