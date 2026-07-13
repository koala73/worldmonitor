import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { publicRpcFetch } from '../src/services/public-rpc-fetch.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('publicRpcFetch', () => {
  it('adds the isolated public cache marker and strips credential-bearing request state', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    await publicRpcFetch('https://api.worldmonitor.app/api/news/v1/list-feed-digest?variant=full&lang=en', {
      credentials: 'include',
      headers: {
        Authorization: 'Bearer secret',
        'X-WorldMonitor-Key': 'wm_secret',
        'X-Api-Key': 'legacy-secret',
        Accept: 'application/json',
      },
    });

    const url = new URL(capturedUrl);
    assert.equal(url.searchParams.get('public'), '1');
    assert.equal(capturedInit?.credentials, 'omit');
    const headers = new Headers(capturedInit?.headers);
    assert.equal(headers.get('Authorization'), null);
    assert.equal(headers.get('X-WorldMonitor-Key'), null);
    assert.equal(headers.get('X-Api-Key'), null);
    assert.equal(headers.get('Accept'), 'application/json');
  });

  it('rejects routes outside the narrow shared-RPC allowlist before fetching', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    await assert.rejects(
      publicRpcFetch('https://api.worldmonitor.app/api/intelligence/v1/get-risk-scores'),
      /not an allowlisted public RPC/,
    );
    assert.equal(calls, 0);
  });
});
