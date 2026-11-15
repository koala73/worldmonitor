/**
 * Reservoir level alerts: rule evaluation, the producer, and delivery through the relay's
 * real rule evaluation (processEvent), including a realtime rule, which only critical events pass.
 */
import { describe, it, before, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SEASONAL_Z_ALERT, computeChange } from '../scripts/_reservoir-levels.mjs';
import { toAlertRecord } from '../scripts/seed-reservoir-levels.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const lib = require('../scripts/lib/reservoir-level-alerts.cjs');
const { RESERVOIR_ALERT_EVENT_TYPE, reservoirAlertDecision, buildReservoirLevelEvent, publishReservoirLevelAlerts } = lib;

process.env.UPSTASH_REDIS_REST_URL ??= 'https://stub.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN ??= 'stub-token';
process.env.CONVEX_URL ??= 'https://stub.convex.cloud';
process.env.CONVEX_NOTIFICATION_RELAY_SECRET ??= 'stub-secret';
process.env.TELEGRAM_BOT_TOKEN ??= 'stub-bot-token';

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
afterEach(() => { globalThis.fetch = originalFetch; });

const record = (overrides = {}) => ({
  id: 'nasser',
  name: 'Lake Nasser',
  country: 'EG',
  latest: { date: '2026-09-14', levelM: 160.24 },
  percentOfRange: 12.3,
  seasonalAnomalyM: -2.4,
  seasonalZ: -1.9,
  belowSeasonalBaseline: true,
  ...overrides,
});
const payloadOf = (overrides) => buildReservoirLevelEvent(record(overrides)).payload;

describe('reservoirAlertDecision', () => {
  const settings = (over = {}) => ({ reservoirs: ['nasser'], ...over });

  it('fires below the chosen share of the measured range, and not at or above it', () => {
    assert.equal(reservoirAlertDecision(settings({ belowPercent: 15 }), payloadOf()).fire, true);
    assert.equal(reservoirAlertDecision(settings({ belowPercent: 12 }), payloadOf()).fire, false);
    assert.equal(reservoirAlertDecision(settings({ belowPercent: 10 }), payloadOf()).fire, false);
  });

  it('fires on a drop beyond the seasonal baseline when the rule asks for it', () => {
    assert.deepEqual(reservoirAlertDecision(settings({ seasonalDrop: true }), payloadOf()).reasons, ['seasonal_drop']);
    assert.equal(reservoirAlertDecision(settings({ seasonalDrop: true }), payloadOf({ belowSeasonalBaseline: false, seasonalZ: -0.4 })).fire, false);
  });

  it('a rise beyond the baseline is not a drop', () => {
    const high = payloadOf({ seasonalZ: 2.2, seasonalAnomalyM: 3, belowSeasonalBaseline: false });
    assert.equal(reservoirAlertDecision(settings({ seasonalDrop: true }), high).fire, false);
  });

  it('a rule with neither criterion, or a reservoir not on its list, never fires', () => {
    assert.equal(reservoirAlertDecision(settings(), payloadOf()).fire, false);
    assert.equal(reservoirAlertDecision({ reservoirs: ['tana'], belowPercent: 50, seasonalDrop: true }, payloadOf()).fire, false);
    assert.equal(reservoirAlertDecision({ reservoirs: [], belowPercent: 50, seasonalDrop: true }, payloadOf()).fire, false);
    assert.equal(reservoirAlertDecision(undefined, payloadOf()).fire, false);
  });

  it('the threshold cannot fire when the reservoir has no measured range yet', () => {
    const p = payloadOf({ percentOfRange: null });
    assert.equal(reservoirAlertDecision(settings({ belowPercent: 50 }), p).fire, false);
    assert.equal(reservoirAlertDecision(settings({ belowPercent: 50, seasonalDrop: true }), p).fire, true);
  });

  it('never fires without a dated measurement', () => {
    for (const measuredAt of [undefined, null, '', 'yesterday', '2026-13-40']) {
      const p = { ...payloadOf(), measuredAt };
      assert.equal(reservoirAlertDecision(settings({ belowPercent: 50, seasonalDrop: true }), p).fire, false, String(measuredAt));
    }
  });
});

describe('buildReservoirLevelEvent', () => {
  it('is not critical, carries the measurement date, and never reads as live', () => {
    const event = buildReservoirLevelEvent(record());
    assert.equal(event.eventType, RESERVOIR_ALERT_EVENT_TYPE);
    assert.equal(event.severity, 'medium', 'a measurement that is days old is never urgent');
    assert.equal(event.payload.measuredAt, '2026-09-14');
    assert.match(event.payload.title, /measured 2026-09-14/);
    assert.doesNotMatch(event.payload.title, /\b(now|currently|live|today|just)\b/i);
    assert.equal(event.payload.reservoirId, 'nasser');
    assert.equal(event.payload.percentOfRange, 12.3);
    assert.equal(event.payload.beyondSeasonalBaseline, true);
    assert.equal(event.payload.dedupe_key, 'reservoir_level_alert:nasser:2026-09-14');
    assert.equal(event.payload.coalesceKey, 'reservoir_level_alert:nasser:2026-09-14');
    assert.equal('description' in event.payload, false);
  });

  it('has no event without a dated measurement', () => {
    assert.equal(buildReservoirLevelEvent(record({ latest: null })), null);
    assert.equal(buildReservoirLevelEvent(record({ latest: { date: 'soon', levelM: 1 } })), null);
    assert.equal(buildReservoirLevelEvent(record({ latest: { date: '2026-09-14', levelM: Number.NaN } })), null);
  });
});

describe('toAlertRecord reuses the seasonal baseline of the seeder', () => {
  it('marks a drop with the seeder own SEASONAL_Z_ALERT limit', () => {
    const at = (z) => toAlertRecord({ id: 'x', name: 'X', country: 'EG', latest: { date: '2026-09-14', levelM: 1 }, seasonalZ: z });
    assert.equal(at(-SEASONAL_Z_ALERT).belowSeasonalBaseline, true);
    assert.equal(at(-SEASONAL_Z_ALERT + 0.01).belowSeasonalBaseline, false);
    assert.equal(at(SEASONAL_Z_ALERT).belowSeasonalBaseline, false);
    assert.equal(at(null).belowSeasonalBaseline, false);
  });

  it('a series with three prior seasons and a low latest level yields a seasonal drop from computeChange', () => {
    const DAY = 86_400_000;
    const now = Date.parse('2026-09-14T00:00:00Z');
    const passes = [];
    for (let y = 1; y <= 4; y += 1) {
      for (const off of [-6, -2, 2, 6]) {
        const t = now - Math.round(y * 365.25 * DAY) + off * DAY;
        passes.push({ time: new Date(t).toISOString(), date: new Date(t).toISOString().slice(0, 10), levelM: 150 + (y % 2) * 0.3 + off * 0.01, madM: 0.05, n: 40, ok: true });
      }
    }
    passes.push({ time: new Date(now).toISOString(), date: '2026-09-14', levelM: 140, madM: 0.05, n: 40, ok: true });
    const m = computeChange(passes, now + DAY);
    assert.ok(m.seasonalZ != null && m.seasonalZ <= -SEASONAL_Z_ALERT, `seasonalZ ${m.seasonalZ}`);
    const out = toAlertRecord({ id: 'x', name: 'X', country: 'EG', ...m });
    assert.equal(out.belowSeasonalBaseline, true);
    assert.equal(out.latest.date, '2026-09-14');
  });
});

function harness({ publishResult = () => true } = {}) {
  let stored = null;
  const published = [];
  return {
    published,
    get state() { return stored; },
    run(records, { failRead = false, failWrite = false } = {}) {
      return publishReservoirLevelAlerts(records, {
        readState: async (_key, onError) => { if (failRead) { onError(); return null; } return stored ? structuredClone(stored) : null; },
        writeState: async (_key, state) => { if (failWrite) return false; stored = structuredClone(state); return true; },
        publish: async (event) => { published.push(event); return publishResult(event); },
      });
    },
  };
}

describe('publishReservoirLevelAlerts', () => {
  it('the first run records what is already measured and publishes nothing', async () => {
    const h = harness();
    const summary = await h.run([record(), record({ id: 'tana', name: 'Lake Tana' })]);
    assert.equal(h.published.length, 0);
    assert.equal(summary.seeded, 2);
    assert.deepEqual(h.state, { nasser: '2026-09-14', tana: '2026-09-14' });
  });

  it('publishes once per new measurement date, and not again for the same one', async () => {
    const h = harness();
    await h.run([record()]);
    await h.run([record({ latest: { date: '2026-10-02', levelM: 159.9 } })]);
    await h.run([record({ latest: { date: '2026-10-02', levelM: 159.9 } })]);
    assert.equal(h.published.length, 1);
    assert.equal(h.published[0].payload.measuredAt, '2026-10-02');
  });

  it('an older or undated measurement publishes nothing', async () => {
    const h = harness();
    await h.run([record()]);
    await h.run([record({ latest: { date: '2026-08-01', levelM: 161 } }), record({ id: 'tana', latest: null })]);
    assert.equal(h.published.length, 0);
  });

  it('a failed publish is retried on the next run', async () => {
    let ok = false;
    const h = harness({ publishResult: () => ok });
    await h.run([record()]);
    const newer = record({ latest: { date: '2026-10-02', levelM: 159.9 } });
    const first = await h.run([newer]);
    assert.equal(first.failed, 1);
    assert.equal(h.state.nasser, '2026-09-14');
    ok = true;
    await h.run([newer]);
    assert.equal(h.published.length, 2);
    assert.equal(h.state.nasser, '2026-10-02');
  });

  it('publishes nothing when the state cannot be read', async () => {
    const h = harness();
    assert.equal(await h.run([record()], { failRead: true }), null);
    assert.equal(h.published.length, 0);
  });
});

// ── Delivery through the relay's real rule evaluation ────────────────────────

const rule = (userId, overrides = {}) => ({
  userId, digestMode: 'realtime', eventTypes: [RESERVOIR_ALERT_EVENT_TYPE], sensitivity: 'critical', countries: [], tickers: [], channels: ['telegram'], variant: 'full',
  reservoirAlert: { reservoirs: ['nasser'], belowPercent: 15 },
  ...overrides,
});

async function deliveries(rules, event, { tiers = {}, held = [] } = {}) {
  const chats = [];
  const texts = [];
  const silence = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = () => {};
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    if (path.includes('/relay/enabled-rules')) return { ok: true, json: async () => rules };
    if (path.includes('/relay/entitlement')) return { ok: true, json: async () => ({ tier: tiers[body?.userId] ?? 1 }) };
    if (path.includes('/relay/channels')) {
      return { ok: true, json: async () => [{ channelType: 'telegram', verified: true, telegramOwnership: 'verified_callback', chatId: `chat-${body?.userId}` }] };
    }
    if (parsed.hostname === 'api.telegram.org') {
      chats.push(body?.chat_id);
      texts.push(body?.text);
      return { status: 200, ok: true, json: async () => ({ ok: true }) };
    }
    if (path.startsWith('/RPUSH/')) { held.push(decodeURIComponent(path.split('/')[3])); return { ok: true, json: async () => ({ result: held.length }) }; }
    if (path.startsWith('/LLEN/')) return { ok: true, json: async () => ({ result: held.length }) };
    if (path.startsWith('/LRANGE/')) return { ok: true, json: async () => ({ result: [...held] }) };
    if (path.startsWith('/LREM/')) { const i = held.indexOf(decodeURIComponent(path.split('/')[4])); if (i >= 0) held.splice(i, 1); return { ok: true, json: async () => ({ result: i >= 0 ? 1 : 0 }) }; }
    if (path.startsWith('/DEL/')) { held.length = 0; return { ok: true, json: async () => ({ result: 1 }) }; }
    if (path.endsWith('/pipeline')) return { ok: true, json: async () => [] };
    if (String(url).includes('/SET/')) return { ok: true, json: async () => ({ result: 'OK' }) };
    return { ok: true, json: async () => ({ result: null }) };
  };
  try {
    await relay.processEvent(event);
  } finally {
    [console.log, console.warn, console.error] = silence;
  }
  return { chats, texts };
}

let seq = 0;
const freshEvent = (overrides = {}) => {
  seq += 1;
  return buildReservoirLevelEvent(record({ latest: { date: `2026-10-${String(seq).padStart(2, '0')}`, levelM: 160.24 }, ...overrides }));
};

describe('reservoir alert delivery through the relay', () => {
  it('reaches a realtime critical-only rule whose threshold is crossed, with the measurement date in the message', async () => {
    const event = freshEvent();
    const { chats, texts } = await deliveries([rule('user-1')], event);
    assert.deepEqual(chats, ['chat-user-1']);
    assert.match(texts[0], new RegExp(`measured ${event.payload.measuredAt}`));
  });

  it('also reaches a rule that asked for the seasonal drop only', async () => {
    const { chats } = await deliveries([rule('user-1', { reservoirAlert: { reservoirs: ['nasser'], seasonalDrop: true } })], freshEvent({ percentOfRange: 60 }));
    assert.deepEqual(chats, ['chat-user-1']);
  });

  it('is not delivered when the level is above the chosen threshold', async () => {
    const { chats } = await deliveries([rule('user-1', { reservoirAlert: { reservoirs: ['nasser'], belowPercent: 10 } })], freshEvent({ belowSeasonalBaseline: false }));
    assert.deepEqual(chats, []);
  });

  it('is opt-in: a wildcard rule with a reservoir list receives nothing', async () => {
    assert.deepEqual((await deliveries([rule('user-1', { eventTypes: [] })], freshEvent())).chats, []);
  });

  it('is scoped to the rule own reservoirs and own channels', async () => {
    const rules = [rule('user-1'), rule('user-2', { reservoirAlert: { reservoirs: ['tana'], belowPercent: 50 } }), rule('user-3', { reservoirAlert: undefined })];
    assert.deepEqual((await deliveries(rules, freshEvent())).chats, ['chat-user-1']);
  });

  it('a free account receives nothing even with a matching rule', async () => {
    assert.deepEqual((await deliveries([rule('user-free')], freshEvent(), { tiers: { 'user-free': 0 } })).chats, []);
  });

  it('is not dropped by country scope', async () => {
    assert.deepEqual((await deliveries([rule('user-1', { countries: ['FR'] })], freshEvent())).chats, ['chat-user-1']);
  });

  it('an event without a measurement date is not delivered even to a matching rule', async () => {
    const event = freshEvent();
    delete event.payload.measuredAt;
    assert.deepEqual((await deliveries([rule('user-1')], event)).chats, []);
  });

  it('does not restrict the other alerts of a rule that opts in', async () => {
    seq += 1;
    const rss = { eventType: 'rss_alert', severity: 'critical', payload: { title: `Headline #${seq}`, source: 'Reuters' } };
    assert.deepEqual((await deliveries([rule('user-1')], rss)).chats, ['chat-user-1']);
  });

  it('end to end: a seeded new measurement reaches the subscribed channel once', async () => {
    const h = harness();
    await h.run([record()]);
    await h.run([record({ latest: { date: '2026-11-01', levelM: 158.8 }, percentOfRange: 9.1 })]);
    assert.equal(h.published.length, 1);
    const { chats, texts } = await deliveries([rule('user-1'), rule('user-2', { reservoirAlert: { reservoirs: ['nasser'], belowPercent: 5 } })], h.published[0]);
    assert.deepEqual(chats, ['chat-user-1']);
    assert.match(texts[0], /Lake Nasser/);
    assert.match(texts[0], /measured 2026-11-01/);
  });
});

// ── Quiet hours ──────────────────────────────────────────────────────────────

const NIGHT = Date.parse('2026-11-15T02:00:00Z');
const DAY = Date.parse('2026-11-15T12:00:00Z');
const quiet = (override) => ({ quietHoursEnabled: true, quietHoursStart: 22, quietHoursEnd: 7, quietHoursTimezone: 'UTC', ...(override ? { quietHoursOverride: override } : {}) });
const at = (ms) => mock.method(Date, 'now', () => ms);
afterEach(() => mock.restoreAll());

describe('reservoir alerts and quiet hours', () => {
  it('a realtime critical-only rule delivers outside quiet hours although the event is not critical', async () => {
    at(DAY);
    assert.deepEqual((await deliveries([rule('user-1', quiet())], freshEvent())).chats, ['chat-user-1']);
  });

  it('quiet hours with the default critical-only override suppress it', async () => {
    at(NIGHT);
    const held = [];
    assert.deepEqual((await deliveries([rule('user-1', quiet())], freshEvent(), { held })).chats, []);
    assert.deepEqual(held, [], 'suppressed, not held');
  });

  it('quiet hours with silence-all suppress it', async () => {
    at(NIGHT);
    assert.deepEqual((await deliveries([rule('user-1', quiet('silence_all'))], freshEvent())).chats, []);
  });

  it('quiet hours with Batch hold it, and the batch delivers it with its measurement date once they end', async () => {
    const held = [];
    const batchRule = rule('user-1', quiet('batch_on_wake'));
    const event = freshEvent();
    at(NIGHT);
    assert.deepEqual((await deliveries([batchRule], event, { held })).chats, [], 'nothing at night');
    assert.equal(held.length, 1, 'held until quiet hours end');
    at(DAY);
    const drained = await deliveries([batchRule], { eventType: 'flush_quiet_held', userId: 'user-1', variant: 'full' }, { held });
    assert.deepEqual(drained.chats, ['chat-user-1']);
    assert.match(drained.texts[0], /1 held alert/);
    assert.match(drained.texts[0], new RegExp(`measured ${event.payload.measuredAt}`));
    assert.deepEqual(held, []);
  });
});
