// Drives the REAL fetchWmKeySessionStatus (GET /api/wm-session) through a
// stubbed fetch. Only a well-formed 200 with two booleans is a status; every
// other answer resolves null so an unknown is never read as "no session".
import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';

const storage = (m: Map<string, string>): Storage => ({
  get length() { return m.size; },
  clear() { m.clear(); },
  getItem(k) { return m.has(k) ? m.get(k)! : null; },
  key(i) { return Array.from(m.keys())[i] ?? null; },
  removeItem(k) { m.delete(k); },
  setItem(k, v) { m.set(k, String(v)); },
});
type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
let handler: FetchHandler = () => Promise.resolve(new Response('{}', { status: 200 }));
const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
const g = globalThis as unknown as Record<string, unknown>;
g.window = globalThis;
g.document = { visibilityState: 'visible', addEventListener() {} };
g.sessionStorage = storage(new Map());
g.localStorage = storage(new Map());
g.setInterval = () => 1;
g.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  calls.push({ url: String(input), init });
  return handler(input, init);
};
g.location = { href: 'https://worldmonitor.app/', origin: 'https://worldmonitor.app', hostname: 'worldmonitor.app', protocol: 'https:', host: 'worldmonitor.app' };

let mod: typeof import('../src/services/wm-session.ts');
before(async () => { mod = await import('../src/services/wm-session.ts'); });
beforeEach(() => { calls.length = 0; mod.__resetWmSessionForTests(); });

function answer(status: number, body: string): void {
  handler = () => Promise.resolve(new Response(body, { status, headers: { 'Content-Type': 'application/json' } }));
}

describe('fetchWmKeySessionStatus', () => {
  it('a 200 with two booleans resolves as-is, from a credentialed no-store GET', async () => {
    answer(200, JSON.stringify({ widget: true, pro: false }));
    assert.deepEqual(await mod.fetchWmKeySessionStatus(), { widget: true, pro: false });
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /\/api\/wm-session$/);
    assert.equal(calls[0]!.init?.method, 'GET');
    assert.equal(calls[0]!.init?.credentials, 'include');
    assert.equal(calls[0]!.init?.cache, 'no-store');
  });

  for (const [label, status, body] of [
    ['a 401', 401, JSON.stringify({ widget: false, pro: false })],
    ['a 500', 500, '{}'],
    ['a non-JSON 200', 200, '<html>proxy</html>'],
    ['a 200 with a non-boolean field', 200, JSON.stringify({ widget: 'yes', pro: false })],
    ['a 200 missing a field', 200, JSON.stringify({ widget: true })],
  ] as const) {
    it(`${label} resolves null`, async () => {
      answer(status, body);
      assert.equal(await mod.fetchWmKeySessionStatus(), null);
    });
  }

  it('a transport failure resolves null', async () => {
    handler = () => Promise.reject(new TypeError('Failed to fetch'));
    assert.equal(await mod.fetchWmKeySessionStatus(), null);
  });
});
