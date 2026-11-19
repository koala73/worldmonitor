/**
 * The www /desktop-sign-in page (#9396 follow-up): reads the desktop's launch
 * parameters from the URL fragment, asks the signed-in user to confirm, binds
 * a one-time code to the desktop's PKCE challenge, and hands it to the
 * desktop on a 127.0.0.1 loopback redirect.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LAUNCH_STORAGE_KEY,
  callbackUrl,
  parseLaunchFragment,
  resolveLaunch,
  runDesktopSignInContinue,
  type LaunchParams,
} from '../src/services/desktop-sign-in-page.ts';

const STATE = 's1aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789-_abc';
const CHALLENGE = 'c1aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789-_abc';
const LAUNCH: LaunchParams = { port: 51234, state: STATE, challenge: CHALLENGE };

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: (key: string) => data.get(key) ?? null,
    set: (key: string, value: string) => { data.set(key, value); },
    remove: (key: string) => { data.delete(key); },
  };
}

describe('parseLaunchFragment', () => {
  it('reads port, state and challenge', () => {
    assert.deepEqual(parseLaunchFragment(`#port=51234&state=${STATE}&challenge=${CHALLENGE}`), LAUNCH);
  });

  it('rejects anything that is not a well-formed launch', () => {
    for (const hash of [
      '',
      '#',
      `#port=80&state=${STATE}&challenge=${CHALLENGE}`,
      `#port=70000&state=${STATE}&challenge=${CHALLENGE}`,
      `#port=5x&state=${STATE}&challenge=${CHALLENGE}`,
      `#port=51234&state=short&challenge=${CHALLENGE}`,
      `#port=51234&state=${STATE}`,
      `#port=51234&state=${STATE}&challenge=${CHALLENGE}=`,
    ]) {
      assert.equal(parseLaunchFragment(hash), null, hash);
    }
  });
});

describe('resolveLaunch', () => {
  it('moves a fragment launch into session storage and asks to clear the hash', () => {
    const storage = memoryStorage();
    const result = resolveLaunch(`#port=51234&state=${STATE}&challenge=${CHALLENGE}`, storage);
    assert.deepEqual(result, { launch: LAUNCH, clearHash: true });
    assert.deepEqual(JSON.parse(storage.data.get(LAUNCH_STORAGE_KEY)!), LAUNCH);
  });

  it('recovers the launch after a sign-in redirect dropped the fragment', () => {
    const storage = memoryStorage({ [LAUNCH_STORAGE_KEY]: JSON.stringify(LAUNCH) });
    assert.deepEqual(resolveLaunch('', storage), { launch: LAUNCH, clearHash: false });
  });

  it('ignores a tampered stored launch', () => {
    const storage = memoryStorage({ [LAUNCH_STORAGE_KEY]: JSON.stringify({ ...LAUNCH, port: 22 }) });
    assert.deepEqual(resolveLaunch('', storage), { launch: null, clearHash: false });
  });
});

describe('callbackUrl', () => {
  it('targets the literal loopback address, never localhost', () => {
    const url = new URL(callbackUrl(51234, 'the-code', STATE));
    assert.equal(url.origin, 'http://127.0.0.1:51234');
    assert.equal(url.pathname, '/callback');
    assert.equal(url.searchParams.get('code'), 'the-code');
    assert.equal(url.searchParams.get('state'), STATE);
  });
});

describe('runDesktopSignInContinue', () => {
  it('binds the code to the challenge and navigates to the desktop', async () => {
    const storage = memoryStorage({ [LAUNCH_STORAGE_KEY]: JSON.stringify(LAUNCH) });
    const requests: Array<{ body: unknown; auth: string | null }> = [];
    const navigations: string[] = [];

    const outcome = await runDesktopSignInContinue(LAUNCH, {
      getToken: async () => 'jwt',
      fetch: async (_url, init) => {
        requests.push({
          body: JSON.parse(String(init?.body)),
          auth: new Headers(init?.headers).get('authorization'),
        });
        return new Response(JSON.stringify({ code: 'the-code' }), { status: 200 });
      },
      navigate: (url) => navigations.push(url),
      storage,
    });

    assert.deepEqual(outcome, { kind: 'redirected' });
    assert.deepEqual(requests, [{ body: { code_challenge: CHALLENGE }, auth: 'Bearer jwt' }]);
    assert.deepEqual(navigations, [callbackUrl(51234, 'the-code', STATE)]);
    assert.equal(storage.data.has(LAUNCH_STORAGE_KEY), false, 'a used launch must not be replayable');
  });

  it('never sends the state or port to the server', async () => {
    let body = '';
    await runDesktopSignInContinue(LAUNCH, {
      getToken: async () => 'jwt',
      fetch: async (_url, init) => {
        body = String(init?.body);
        return new Response(JSON.stringify({ code: 'c' }), { status: 200 });
      },
      navigate: () => {},
      storage: memoryStorage(),
    });
    assert.equal(body.includes(STATE), false);
    assert.equal(body.includes('51234'), false);
  });

  it('reports a signed-out user without calling the server', async () => {
    let calls = 0;
    const outcome = await runDesktopSignInContinue(LAUNCH, {
      getToken: async () => null,
      fetch: async () => { calls += 1; return new Response('{}'); },
      navigate: () => assert.fail('must not navigate'),
      storage: memoryStorage(),
    });
    assert.deepEqual(outcome, { kind: 'signed_out' });
    assert.equal(calls, 0);
  });

  it('reports a server refusal and keeps the launch for a retry', async () => {
    const storage = memoryStorage({ [LAUNCH_STORAGE_KEY]: JSON.stringify(LAUNCH) });
    const outcome = await runDesktopSignInContinue(LAUNCH, {
      getToken: async () => 'jwt',
      fetch: async () => new Response(JSON.stringify({ error: 'service_unavailable' }), { status: 503 }),
      navigate: () => assert.fail('must not navigate'),
      storage,
    });
    assert.deepEqual(outcome, { kind: 'failed', status: 503 });
    assert.equal(storage.data.has(LAUNCH_STORAGE_KEY), true);
  });
});
