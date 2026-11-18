/**
 * #10976: when no realtime rule matches an event, the relay logs one line with
 * the number of rules each gate dropped, so a silent miss names its gate.
 * Drives the real processEvent with stubbed Convex, Upstash and Telegram.
 */

import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

process.env.UPSTASH_REDIS_REST_URL ??= 'https://stub.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN ??= 'stub-token';
process.env.CONVEX_URL ??= 'https://stub.convex.cloud';
process.env.CONVEX_NOTIFICATION_RELAY_SECRET ??= 'stub-secret';
const savedEnv = { TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN, IMPORTANCE_SCORE_MIN: process.env.IMPORTANCE_SCORE_MIN, IMPORTANCE_SCORE_LIVE: process.env.IMPORTANCE_SCORE_LIVE };
// The relay reads these at import: a real token so Telegram sends are counted,
// and an ingress floor below the fixtures' scores so the per-rule gates decide.
process.env.TELEGRAM_BOT_TOKEN = 'stub-bot-token';
process.env.IMPORTANCE_SCORE_MIN = '40';
delete process.env.IMPORTANCE_SCORE_LIVE;

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, ...rest) {
  if (request === 'resend') return { Resend: class {} };
  if (request === 'convex/browser') return { ConvexHttpClient: class { async query() {} } };
  return originalLoad.call(this, request, parent, ...rest);
};

let relay;
let originalFetch;
before(() => {
  relay = require(resolve(__dirname, '..', 'scripts', 'notification-relay.cjs'));
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.IMPORTANCE_SCORE_LIVE;
});
after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const base = { userId: 'user-1', digestMode: 'realtime', eventTypes: [], sensitivity: 'critical', countries: [], tickers: [], channels: ['telegram'], variant: 'full' };

let seq = 0;
const adnoc = (importanceScore) => ({
  eventType: 'rss_alert',
  severity: 'critical',
  variant: 'full',
  payload: { title: `ADNOC vessel attacked in Strait of Hormuz #${++seq}`, source: 'OilPrice.com', importanceScore },
});

async function run(rules, event) {
  const logs = [];
  let telegram = 0;
  const silence = [console.log, console.warn, console.error, console.info];
  console.log = (...a) => logs.push(a.join(' '));
  console.warn = console.error = console.info = () => {};
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.includes('/relay/enabled-rules')) return { ok: true, json: async () => rules.map((r) => ({ ...base, ...r })) };
    if (parsed.pathname.includes('/relay/entitlement')) return { ok: true, json: async () => ({ tier: 1 }) };
    if (parsed.pathname.includes('/relay/channels')) {
      return { ok: true, json: async () => [{ channelType: 'telegram', verified: true, telegramOwnership: 'verified_callback', chatId: 'chat-1' }] };
    }
    if (parsed.hostname === 'api.telegram.org') {
      telegram += 1;
      return { status: 200, ok: true, json: async () => ({ ok: true }) };
    }
    if (parsed.pathname.endsWith('/pipeline')) return { ok: true, json: async () => [] };
    if (String(url).includes('/SET/')) return { ok: true, json: async () => ({ result: 'OK' }) };
    return { ok: true, json: async () => ({ result: null }) };
  };
  try {
    await relay.processEvent(event);
  } finally {
    [console.log, console.warn, console.error, console.info] = silence;
  }
  const line = logs.find((l) => l.startsWith('[relay] No rule matched:'));
  return { telegram, line, drops: line ? JSON.parse(line.slice(line.indexOf('drops=') + 6)) : null };
}

describe('zero-match drop reasons', () => {
  it('counts each rule under the gate that dropped it', async () => {
    process.env.IMPORTANCE_SCORE_LIVE = '1';
    const { telegram, drops, line } = await run([
      {},
      { userId: 'user-2' },
      { userId: 'user-3', digestMode: 'daily' },
      { userId: 'user-4', variant: 'finance' },
      { userId: 'user-5', eventTypes: ['market_alert'] },
    ], adnoc(73));
    assert.equal(telegram, 0);
    assert.deepEqual(drops, { score_bar: 2, digest_mode: 1, edition: 1, event_type: 1 });
    assert.match(line, /"rss_alert" severity="critical" score=73 edition="full" rules=5/);
  });

  it('names severity and country scope', async () => {
    const event = { eventType: 'weather_alert', severity: 'critical', payload: { title: `Wind warning #${++seq}`, countryCode: 'KZ' } };
    const { drops } = await run([{ countries: ['US'] }, { userId: 'user-2', countries: [] }], event);
    assert.deepEqual(drops, { delivery_scope: 2 });
    const high = { ...adnoc(90), severity: 'high' };
    assert.deepEqual((await run([{}], high)).drops, { severity: 1 });
  });

  it('logs nothing when a rule matches', async () => {
    process.env.IMPORTANCE_SCORE_LIVE = '1';
    const { telegram, line } = await run([{}, { userId: 'user-2', variant: 'finance' }], adnoc(85));
    assert.equal(telegram, 1);
    assert.equal(line, undefined);
  });
});
