// Drives the REAL establishWmKeySessionOutcome through a stubbed fetch and
// pins what counts as "the server rejected this key": only /api/wm-session's
// own 401 with its "Invalid session key" body. Every other status, a 401 from
// something in front of the handler (the desktop sidecar's auth gate), a
// malformed body and a transport failure must keep the legacy key.
import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';

const memoryStorage = new Map<string, string>();
const storage = (m: Map<string, string>): Storage => ({
  get length() { return m.size; },
  clear() { m.clear(); },
  getItem(k) { return m.has(k) ? m.get(k)! : null; },
  key(i) { return Array.from(m.keys())[i] ?? null; },
  removeItem(k) { m.delete(k); },
  setItem(k, v) { m.set(k, String(v)); },
});
type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
let currentFetchHandler: FetchHandler = () => Promise.resolve(new Response('default', { status: 200 }));
const g = globalThis as unknown as Record<string, unknown>;
g.window = globalThis;
g.document = { visibilityState: 'visible', addEventListener() {} };
g.sessionStorage = storage(memoryStorage);
g.localStorage = storage(new Map());
g.setInterval = () => 1;
g.fetch = (input: RequestInfo | URL, init?: RequestInit) => currentFetchHandler(input, init);
g.location = { href: 'https://worldmonitor.app/', origin: 'https://worldmonitor.app', hostname: 'worldmonitor.app', protocol: 'https:', host: 'worldmonitor.app' };

let mod: typeof import('../src/services/wm-session.ts');
before(async () => { mod = await import('../src/services/wm-session.ts'); });
beforeEach(() => { memoryStorage.clear(); mod.__resetWmSessionForTests(); });

const bodies: unknown[] = [];
function respondWith(status: number, body = 'nope', contentType = 'application/json') {
  currentFetchHandler = (_input, init) => {
    bodies.push(typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body);
    return Promise.resolve(new Response(body, { status, headers: { 'Content-Type': contentType } }));
  };
}

describe('establishWmKeySessionOutcome: what counts as a rejected key', () => {
  it("the handler's own 401 with its body marks the key rejected", async () => {
    respondWith(401, JSON.stringify({ error: 'Invalid session key' }));
    assert.deepEqual(await mod.establishWmKeySessionOutcome({ proKey: 'bad' }), { ok: false, rejected: true });
    assert.deepEqual(bodies.at(-1), { proKey: 'bad' });
  });

  it("a 401 from the desktop sidecar's auth gate keeps the key", async () => {
    respondWith(401, JSON.stringify({ error: 'Unauthorized' }));
    assert.deepEqual(await mod.establishWmKeySessionOutcome({ proKey: 'valid' }), { ok: false, rejected: false });
  });

  it('a 401 with an HTML or empty body keeps the key', async () => {
    respondWith(401, '<html>Authentication Required</html>', 'text/html');
    assert.deepEqual(await mod.establishWmKeySessionOutcome({ widgetKey: 'k' }), { ok: false, rejected: false });
    respondWith(401, '');
    assert.deepEqual(await mod.establishWmKeySessionOutcome({ widgetKey: 'k' }), { ok: false, rejected: false });
  });

  for (const status of [400, 403, 404, 405, 429, 500, 502, 503]) {
    it(`${status} keeps the key even with the rejection body`, async () => {
      respondWith(status, JSON.stringify({ error: 'Invalid session key' }));
      assert.deepEqual(await mod.establishWmKeySessionOutcome({ widgetKey: 'k' }), { ok: false, rejected: false });
    });
  }

  it('a 200 with a malformed body keeps the key', async () => {
    respondWith(200, 'not json');
    assert.deepEqual(await mod.establishWmKeySessionOutcome({ widgetKey: 'k' }), { ok: false, rejected: false });
  });

  it('a transport failure keeps the key', async () => {
    currentFetchHandler = () => Promise.reject(new TypeError('Failed to fetch'));
    assert.deepEqual(await mod.establishWmKeySessionOutcome({ widgetKey: 'k' }), { ok: false, rejected: false });
  });

  it('a 200 with an exp establishes the session and the boolean wrapper mirrors both outcomes', async () => {
    respondWith(200, JSON.stringify({ exp: Date.now() + 3_600_000, hadSession: false, token: 'wms_x' }));
    assert.deepEqual(await mod.establishWmKeySessionOutcome({ proKey: 'good' }), { ok: true });
    assert.equal(await mod.establishWmKeySession({ proKey: 'good' }), true);
    respondWith(401, JSON.stringify({ error: 'Invalid session key' }));
    assert.equal(await mod.establishWmKeySession({ proKey: 'bad' }), false);
  });
});
