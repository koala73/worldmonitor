/**
 * Desktop Clerk relay (#9396). Clerk's production Frontend API answers
 * `400 origin_invalid` to the desktop WebView origins, so on desktop the
 * Frontend API calls clerk-js makes are routed through the Rust
 * `clerk_fapi_request` command. These tests pin which requests are routed and
 * how a relayed request and response are translated.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createClerkRelayFetch,
  toClerkRelayRequest,
  type ClerkRelayRequest,
  type ClerkRelayResponse,
} from '../src/services/clerk-desktop-relay.ts';

const HOST = 'clerk.worldmonitor.app';

function recordingInvoke(response: ClerkRelayResponse) {
  const calls: ClerkRelayRequest[] = [];
  const invoke = async (request: ClerkRelayRequest) => {
    calls.push(request);
    return response;
  };
  return { calls, invoke };
}

function failingBaseFetch(): typeof fetch {
  return (async () => {
    throw new Error('base fetch must not be called for a Frontend API request');
  }) as typeof fetch;
}

describe('toClerkRelayRequest', () => {
  it('routes a Frontend API GET with its query intact', async () => {
    const url = new URL(`https://${HOST}/v1/client?_clerk_js_version=6.25.6`);
    const request = await toClerkRelayRequest(url, { method: 'GET', credentials: 'include' }, HOST);
    assert.deepEqual(request, {
      host: HOST,
      method: 'GET',
      path: '/v1/client?_clerk_js_version=6.25.6',
    });
  });

  it('carries a form-encoded POST body and its content type', async () => {
    const request = await toClerkRelayRequest(
      `https://${HOST}/v1/client/sign_ins`,
      {
        method: 'POST',
        headers: new Headers({ 'content-type': 'application/x-www-form-urlencoded' }),
        body: 'identifier=a%40b.c',
      },
      HOST,
    );
    assert.deepEqual(request, {
      host: HOST,
      method: 'POST',
      path: '/v1/client/sign_ins',
      contentType: 'application/x-www-form-urlencoded',
      body: 'identifier=a%40b.c',
    });
  });

  it('serializes a URLSearchParams body', async () => {
    const request = await toClerkRelayRequest(
      `https://${HOST}/v1/client/sign_ins`,
      { method: 'POST', body: new URLSearchParams({ strategy: 'password' }) },
      HOST,
    );
    assert.equal(request?.body, 'strategy=password');
    assert.equal(request?.contentType, 'application/x-www-form-urlencoded;charset=UTF-8');
  });

  it('leaves every other request alone', async () => {
    for (const input of [
      `https://${HOST}/npm/@clerk/ui@1/dist/ui.browser.js`,
      'https://img.clerk.com/avatar.png',
      'https://api.worldmonitor.app/api/bootstrap',
      `https://${HOST}.evil.com/v1/client`,
      `http://${HOST}/v1/client`,
      '/api/news',
    ]) {
      assert.equal(await toClerkRelayRequest(input, undefined, HOST), null, input);
    }
  });

  it('refuses a multipart body instead of sending it with a cookie-less origin', async () => {
    const body = new FormData();
    body.append('file', 'x');
    await assert.rejects(
      toClerkRelayRequest(`https://${HOST}/v1/me/profile_image`, { method: 'POST', body }, HOST),
      TypeError,
    );
  });
});

describe('createClerkRelayFetch', () => {
  it('returns the relayed status and JSON body for a Frontend API request', async () => {
    const { calls, invoke } = recordingInvoke({
      status: 200,
      contentType: 'application/json',
      body: '{"response":{"object":"client"}}',
    });
    const relayFetch = createClerkRelayFetch(failingBaseFetch(), HOST, invoke);

    const response = await relayFetch(new URL(`https://${HOST}/v1/client`), { method: 'GET' });

    assert.equal(calls.length, 1);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.deepEqual(await response.json(), { response: { object: 'client' } });
  });

  it('keeps a relayed error status so clerk-js reports the Clerk error', async () => {
    const { invoke } = recordingInvoke({
      status: 422,
      contentType: 'application/json',
      body: '{"errors":[{"code":"form_password_incorrect"}]}',
    });
    const relayFetch = createClerkRelayFetch(failingBaseFetch(), HOST, invoke);
    const response = await relayFetch(`https://${HOST}/v1/client/sign_ins`, { method: 'POST', body: 'a=b' });
    assert.equal(response.ok, false);
    assert.equal(response.status, 422);
  });

  it('builds a body-less response for 204', async () => {
    const { invoke } = recordingInvoke({ status: 204, contentType: null, body: '' });
    const relayFetch = createClerkRelayFetch(failingBaseFetch(), HOST, invoke);
    const response = await relayFetch(`https://${HOST}/v1/client/sessions/sess_1/touch`, { method: 'POST' });
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
  });

  it('surfaces a relay failure as a fetch network error', async () => {
    const relayFetch = createClerkRelayFetch(failingBaseFetch(), HOST, async () => {
      throw 'Clerk request failed: dns error';
    });
    await assert.rejects(relayFetch(`https://${HOST}/v1/environment`), TypeError);
  });

  it('rejects with AbortError as soon as the caller aborts a request in flight', async () => {
    let started = false;
    const relayFetch = createClerkRelayFetch(failingBaseFetch(), HOST, () => {
      started = true;
      return new Promise<ClerkRelayResponse>(() => {});
    });
    const controller = new AbortController();
    const pending = relayFetch(`https://${HOST}/v1/client`, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(started, true);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
  });

  it('reports an abort, not a relay error, when Rust fails after the abort', async () => {
    const controller = new AbortController();
    const relayFetch = createClerkRelayFetch(failingBaseFetch(), HOST, async () => {
      controller.abort();
      throw 'Clerk request failed';
    });
    await assert.rejects(
      relayFetch(`https://${HOST}/v1/client`, { signal: controller.signal }),
      { name: 'AbortError' },
    );
  });

  it('honours an already-aborted signal without invoking the relay', async () => {
    const { calls, invoke } = recordingInvoke({ status: 200, contentType: null, body: '{}' });
    const relayFetch = createClerkRelayFetch(failingBaseFetch(), HOST, invoke);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      relayFetch(`https://${HOST}/v1/client`, { signal: controller.signal }),
      { name: 'AbortError' },
    );
    assert.equal(calls.length, 0);
  });

  it('passes non-Frontend-API requests to the wrapped fetch untouched', async () => {
    const seen: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const baseFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push([input, init]);
      return new Response('ok');
    }) as typeof fetch;
    const { calls, invoke } = recordingInvoke({ status: 200, contentType: null, body: '' });
    const relayFetch = createClerkRelayFetch(baseFetch, HOST, invoke);
    const init = { method: 'GET' };

    await relayFetch('/api/news', init);

    assert.equal(calls.length, 0);
    assert.deepEqual(seen, [['/api/news', init]]);
  });
});

describe('clerkRuntimeLoadOptions', () => {
  it('runs clerk-js in native mode on desktop and leaves the web on cookies', async () => {
    const { clerkRuntimeLoadOptions } = await import('../src/services/clerk.ts');
    assert.deepEqual(clerkRuntimeLoadOptions(true), { standardBrowser: false });
    assert.deepEqual(clerkRuntimeLoadOptions(false), {});
  });
});

describe('usesDesktopBrowserSignIn', () => {
  it('sends only production desktop builds through the browser', async () => {
    const { usesDesktopBrowserSignIn } = await import('../src/services/clerk.ts');
    assert.equal(usesDesktopBrowserSignIn(true, 'clerk.worldmonitor.app'), true);
    assert.equal(usesDesktopBrowserSignIn(true, 'happy-otter-12.clerk.accounts.dev'), false, 'dev builds use the in-app card');
    assert.equal(usesDesktopBrowserSignIn(false, 'clerk.worldmonitor.app'), false, 'the web never does');
  });
});
