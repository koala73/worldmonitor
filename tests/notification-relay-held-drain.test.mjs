/**
 * The quiet-hours drain splits a long held batch into parts that fit each channel's message limit,
 * keeps every alert whole, and never resends a part that already went out.
 * Drives the real drain through processEvent({ eventType: 'flush_quiet_held' }).
 */
import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { buildReservoirLevelEvent } = require('../scripts/lib/reservoir-level-alerts.cjs');

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

const reservoirEvent = (n) => buildReservoirLevelEvent({
  id: `reservoir-${n}`,
  name: `Strategic reservoir number ${n} on the upper river`,
  country: 'EG',
  latest: { date: '2026-10-01', levelM: 160.24 },
  percentOfRange: 12.3,
  seasonalAnomalyM: -2.4,
  seasonalZ: -1.9,
  belowSeasonalBaseline: true,
});

const heldEvents = (count) => Array.from({ length: count }, (_, n) => reservoirEvent(n));
const titleOf = (n) => reservoirEvent(n).payload.title;

/** Runs one drain. `failTelegramSend` lists 1-based send numbers that Telegram rejects. */
/** `lremFails(raw)` answers 'status' (the command errors), 'throw' (its request rejects), 'body-timeout' (its body read times out), 'bad-json' (its body is not JSON), 'short' (its response lacks a result), 'non-numeric' (its result is not a count) or 'http' (its request is non-OK). */
async function drain(held, { failTelegramSend = [], throwTelegramSend = [], onTelegramSend = null, lremFails = null, logs = null, removals = null, entitlement = 1 } = {}) {
  const sent = [];
  const silence = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = (...args) => { logs?.push(args.join(' ')); };
  let sends = 0;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname;
    const body = typeof init?.body === 'string' ? safeJson(init.body) : null;
    if (path.includes('/relay/enabled-rules')) {
      return { ok: true, json: async () => [{ userId: 'user-1', digestMode: 'realtime', eventTypes: [], sensitivity: 'critical', channels: ['telegram'], variant: 'full', quietHoursEnabled: true, quietHoursOverride: 'batch_on_wake' }] };
    }
    if (path.includes('/relay/channels')) {
      return { ok: true, json: async () => [{ channelType: 'telegram', verified: true, telegramOwnership: 'verified_callback', chatId: 'chat-1' }] };
    }
    // Reservoir alerts are Pro-only, so the drains here run as a Pro user
    // by default; without this the drain-time free-ladder clamp (#4273)
    // drops every medium-severity held alert and nothing is sent.
    // `entitlement: 'fail'` simulates an entitlement-endpoint outage, which
    // getUserTier fails CLOSED to tier 0.
    if (path.includes('/relay/entitlement')) {
      if (entitlement === 'fail') return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, json: async () => ({ tier: entitlement }) };
    }
    if (parsed.hostname === 'api.telegram.org') {
      sends += 1;
      if (onTelegramSend) onTelegramSend(sends, held);
      if (throwTelegramSend.includes(sends)) throw new TypeError('fetch failed');
      if (failTelegramSend.includes(sends)) return { status: 500, ok: false, json: async () => ({}) };
      // The real Bot API refuses text over 4096 characters, and nothing is delivered then.
      if ((body?.text ?? '').length > 4096) return { status: 400, ok: false, json: async () => ({ description: 'Bad Request: message is too long' }) };
      sent.push(body?.text ?? '');
      return { status: 200, ok: true, json: async () => ({ ok: true }) };
    }
    if (path.startsWith('/RPUSH/')) { held.push(decodeURIComponent(path.split('/')[3])); return { ok: true, json: async () => ({ result: held.length }) }; }
    if (path.startsWith('/LLEN/')) return { ok: true, json: async () => ({ result: held.length }) };
    if (path.startsWith('/LRANGE/')) return { ok: true, json: async () => ({ result: [...held] }) };
    if (path.startsWith('/LREM/')) throw new Error('held alerts are removed through /pipeline, not one request per alert');
    if (path.endsWith('/pipeline') && Array.isArray(body) && body.length > 0 && body.every((cmd) => cmd[0] === 'LREM')) {
      removals?.push(body.map((cmd) => cmd[3]));
      const modes = body.map((cmd) => lremFails?.(cmd[3]) ?? null);
      if (modes.includes('throw')) throw new TypeError('The operation was aborted due to timeout');
      if (modes.includes('http')) return { ok: false, status: 503, json: async () => ({}) };
      if (modes.includes('body-timeout')) return { ok: true, json: async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); } };
      if (modes.includes('bad-json')) return { ok: true, json: async () => { throw new SyntaxError('Unexpected token'); } };
      if (modes.includes('short')) return { ok: true, json: async () => body.slice(1).map(() => ({ result: 1 })) };
      return { ok: true, json: async () => body.map(([, , , raw], i) => {
        if (modes[i] === 'status') return { error: 'ERR stub' };
        if (modes[i] === 'non-numeric') return { result: 'OK' };
        const at = held.indexOf(raw);
        if (at >= 0) held.splice(at, 1);
        return { result: at >= 0 ? 1 : 0 };
      }) };
    }
    if (path.startsWith('/LTRIM/')) { held.splice(0, Number(path.split('/')[3])); return { ok: true, json: async () => ({ result: 'OK' }) }; }
    if (path.startsWith('/DEL/')) { held.length = 0; return { ok: true, json: async () => ({ result: 1 }) }; }
    if (path.endsWith('/pipeline')) return { ok: true, json: async () => [] };
    return { ok: true, json: async () => ({ result: 'OK' }) };
  };
  try {
    await relay.processEvent({ eventType: 'flush_quiet_held', userId: 'user-1', variant: 'full' });
  } finally {
    [console.log, console.warn, console.error] = silence;
  }
  return sent;
}
const safeJson = (text) => { try { return JSON.parse(text); } catch { return null; } };
const asHeld = (events) => events.map((e) => JSON.stringify(e));
const countOf = (texts, title) => texts.filter((t) => t.includes(title)).length;

describe('quiet-hours drain with a long held batch', () => {
  it('splits 60 held reservoir alerts into Telegram messages of at most 4096 characters and delivers every alert once', async () => {
    const held = asHeld(heldEvents(60));
    const sent = await drain(held);
    assert.ok(sent.length >= 2, `needs more than one message, got ${sent.length}`);
    for (const text of sent) assert.ok(text.length <= 4096, `message of ${text.length} characters`);
    for (let n = 0; n < 60; n += 1) assert.equal(countOf(sent, titleOf(n)), 1, `alert ${n} delivered exactly once`);
    assert.deepEqual(held, [], 'the held queue is cleared once every part went out');
  });

  it('keeps each alert whole in one part and labels the parts', async () => {
    const sent = await drain(asHeld(heldEvents(60)));
    sent.forEach((text, i) => {
      assert.match(text, new RegExp(`\\(part ${i + 1} of ${sent.length}\\)`));
    });
    const lines = sent.flatMap((t) => t.split('\n')).filter((l) => l.startsWith('[MEDIUM]'));
    assert.equal(lines.length, 60);
    assert.ok(lines.every((l) => l.endsWith('seasonal norm')), 'no line is cut');
  });

  it('a short batch is still one message without part labels', async () => {
    const sent = await drain(asHeld(heldEvents(3)));
    assert.equal(sent.length, 1);
    assert.doesNotMatch(sent[0], /part \d+ of/);
  });

  it('when a later part fails, the parts that went out are not sent again on the next drain', async () => {
    const held = asHeld(heldEvents(60));
    const first = await drain(held, { failTelegramSend: [2] });
    assert.equal(first.length, 1, 'only the first part went out');
    assert.ok(held.length > 0 && held.length < 60, `the unsent alerts stay held (${held.length})`);
    const second = await drain(held);
    const all = [...first, ...second];
    for (let n = 0; n < 60; n += 1) assert.equal(countOf(all, titleOf(n)), 1, `alert ${n} delivered exactly once across both drains`);
    assert.deepEqual(held, []);
  });

  it('when the request for a later part rejects, the parts that went out are still not sent again', async () => {
    const held = asHeld(heldEvents(60));
    const first = await drain(held, { throwTelegramSend: [2] });
    assert.equal(first.length, 1, 'only the first part went out');
    assert.ok(held.length > 0 && held.length < 60, `the unsent alerts stay held (${held.length})`);
    const second = await drain(held);
    const all = [...first, ...second];
    for (let n = 0; n < 60; n += 1) assert.equal(countOf(all, titleOf(n)), 1, `alert ${n} delivered exactly once across both drains`);
    assert.deepEqual(held, []);
  });

  it('an alert held at the cap while the drain is sending is neither lost nor sent twice', async () => {
    const held = asHeld(heldEvents(100));
    // holdEvent: RPUSH, then keep only the newest 100. At the cap this drops the oldest entry from the head.
    const hold = (n) => (sendNumber, list) => {
      if (sendNumber !== 2) return;
      list.push(JSON.stringify(reservoirEvent(n)));
      while (list.length > 100) list.shift();
    };
    const first = await drain(held, { failTelegramSend: [2], onTelegramSend: hold(100) });
    const second = await drain(held);
    const all = [...first, ...second];
    for (let n = 0; n <= 100; n += 1) {
      const delivered = countOf(all, titleOf(n));
      const stillHeld = held.filter((raw) => raw.includes(titleOf(n))).length;
      assert.equal(delivered + stillHeld, 1, `alert ${n}: delivered ${delivered}, held ${stillHeld}`);
    }
  });

  it('an alert held while every send succeeds stays held, and only the delivered alerts are cleared', async () => {
    const held = asHeld(heldEvents(60));
    const late = JSON.stringify(reservoirEvent(60));
    const first = await drain(held, { onTelegramSend: (n, list) => { if (n === 1) list.push(late); } });
    for (let n = 0; n < 60; n += 1) assert.equal(countOf(first, titleOf(n)), 1, `alert ${n} delivered once`);
    assert.deepEqual(held, [late], 'the alert held mid-drain is still held');
    const second = await drain(held);
    assert.equal(countOf(second, titleOf(60)), 1);
    assert.deepEqual(held, []);
  });

  it('an unreadable held item does not shift which alerts stay held after a partial drain', async () => {
    const held = ['{not json', ...asHeld(heldEvents(60))];
    const first = await drain(held, { failTelegramSend: [2] });
    const second = await drain(held);
    const all = [...first, ...second];
    for (let n = 0; n < 60; n += 1) assert.equal(countOf(all, titleOf(n)), 1, `alert ${n} delivered exactly once`);
  });

  it('when the first part fails nothing is lost: the whole batch stays held', async () => {
    const held = asHeld(heldEvents(60));
    const sent = await drain(held, { failTelegramSend: [1] });
    assert.deepEqual(sent, []);
    assert.equal(held.length, 60);
  });

  it('an entitlement outage keeps the held batch for a later drain (Greptile review 3)', async () => {
    // getUserTier fails CLOSED to tier 0 on an outage, which clamps these
    // medium-severity alerts past the free ladder. That must hold them, not
    // delete them: once the tier resolves, the batch still delivers.
    const held = asHeld(heldEvents(5));
    const duringOutage = await drain(held, { entitlement: 'fail' });
    assert.deepEqual(duringOutage, []);
    assert.equal(held.length, 5, 'nothing is removed while the tier is fail-closed');
    const sent = await drain(held);
    for (let n = 0; n < 5; n += 1) assert.equal(countOf(sent, titleOf(n)), 1, `alert ${n} delivered once after the outage`);
    assert.deepEqual(held, [], 'the queue clears once the batch really delivers');
  });

  it('a genuinely free tier holds past-ladder alerts without deleting them (TTL retires them)', async () => {
    const held = asHeld(heldEvents(3));
    const sent = await drain(held, { entitlement: 0 });
    assert.deepEqual(sent, []);
    assert.equal(held.length, 3);
  });
});

describe('buildHeldTextParts', () => {
  const lines = Array.from({ length: 100 }, (_, n) => `[MEDIUM] ${titleOf(n)}`);

  for (const [name, limit, measure] of [
    ['Telegram', 4096, (t) => t.length],
    ['Discord', 2000, (t) => relay.escapeDiscordText(t).length],
    ['Slack', 3900, (t) => relay.escapeSlackText(t).length],
  ]) {
    it(`${name}: every part fits ${limit} characters after the channel's escaping, and every line is kept whole`, () => {
      const parts = relay.buildHeldTextParts(lines, { limit, measure });
      for (const part of parts) assert.ok(measure(part.text) <= limit, `${name} part of ${measure(part.text)}`);
      assert.equal(parts.reduce((n, p) => n + p.count, 0), 100);
      assert.deepEqual(parts.flatMap((p) => p.text.split('\n')).filter((l) => l.startsWith('[MEDIUM]')), lines);
    });
  }

  it('Discord content is not truncated by the sender', () => {
    const parts = relay.buildHeldTextParts(lines, { limit: 2000, measure: (t) => relay.escapeDiscordText(t).length });
    for (const part of parts) {
      const { content } = relay.buildDiscordMessagePayload(part.text);
      assert.equal(content, relay.escapeDiscordText(part.text));
      assert.ok(!content.endsWith('…'));
    }
  });

  it('a single line longer than the limit is shortened rather than dropped', () => {
    const parts = relay.buildHeldTextParts(['x'.repeat(9000)], { limit: 2000, measure: (t) => t.length });
    assert.equal(parts.length, 1);
    assert.ok(parts[0].text.length <= 2000);
    assert.equal(parts[0].count, 1);
  });
});

describe('removing delivered held alerts', () => {
  it('a command that errors is reported as not cleaned up, retried alone, and the other alerts are still removed', async () => {
    const held = asHeld(heldEvents(5));
    const stuck = held[2];
    const logs = [];
    const removals = [];
    const sent = await drain(held, { lremFails: (raw) => (raw === stuck ? 'status' : null), logs, removals });
    assert.equal(sent.length, 1);
    assert.deepEqual(held, [stuck], 'only the alert whose removal failed is still held');
    assert.deepEqual(removals.map((r) => r.length), [5, 1], 'one request for the batch, then a retry of the failed command only');
    assert.deepEqual(removals[1], [stuck]);
    assert.ok(logs.some((l) => /could not remove 1 delivered held alert/.test(l) && /1 non-OK/.test(l) && /0 timed out/.test(l)), logs.join('\n'));
    assert.ok(!logs.some((l) => /delivered 5 held events .*\(full\)$/.test(l)), 'not reported as a clean delivery');
  });

  it('a timed-out request is told apart from a non-OK one', async () => {
    const held = asHeld(heldEvents(5));
    const logs = [];
    await drain(held, { lremFails: () => 'throw', logs });
    assert.equal(held.length, 5);
    assert.ok(logs.some((l) => /could not remove 5 delivered held alerts/.test(l) && /0 non-OK/.test(l) && /5 timed out/.test(l)), logs.join('\n'));
  });

  it('a body read that times out after OK headers is counted as timed out, not as a refusal', async () => {
    const held = asHeld(heldEvents(5));
    const logs = [];
    await drain(held, { lremFails: () => 'body-timeout', logs });
    assert.equal(held.length, 5);
    assert.ok(logs.some((l) => /could not remove 5 delivered held alerts/.test(l) && /0 non-OK/.test(l) && /5 timed out/.test(l)), logs.join('\n'));
  });

  it('a body that is not JSON counts as non-OK', async () => {
    const held = asHeld(heldEvents(5));
    const logs = [];
    await drain(held, { lremFails: () => 'bad-json', logs });
    assert.equal(held.length, 5);
    assert.ok(logs.some((l) => /could not remove 5 delivered held alerts/.test(l) && /5 non-OK/.test(l) && /0 timed out/.test(l)), logs.join('\n'));
  });

  for (const mode of ['short', 'non-numeric']) {
    it(`a ${mode} pipeline response is retried, then counted as non-OK`, async () => {
      const held = asHeld(heldEvents(5));
      const logs = [];
      const removals = [];
      await drain(held, { lremFails: () => mode, logs, removals });
      assert.equal(held.length, 5);
      assert.deepEqual(removals.map((r) => r.length), [5, 5]);
      assert.ok(logs.some((l) => /could not remove 5 delivered held alerts/.test(l) && /5 non-OK/.test(l) && /0 timed out/.test(l)), logs.join('\n'));
    });
  }

  it('a non-OK request counts every command in it as not removed', async () => {
    const held = asHeld(heldEvents(5));
    const logs = [];
    await drain(held, { lremFails: () => 'http', logs });
    assert.equal(held.length, 5);
    assert.ok(logs.some((l) => /could not remove 5 delivered held alerts/.test(l) && /5 non-OK/.test(l) && /0 timed out/.test(l)), logs.join('\n'));
  });

  it('a removal that fails once is retried and counts as cleaned up when the retry works', async () => {
    const held = asHeld(heldEvents(3));
    const seen = new Map();
    const logs = [];
    await drain(held, { lremFails: (raw) => { const n = (seen.get(raw) ?? 0) + 1; seen.set(raw, n); return n === 1 ? 'throw' : null; }, logs });
    assert.deepEqual(held, []);
    assert.ok(!logs.some((l) => /could not remove/.test(l)));
  });

  it('clearing 100 held alerts takes two requests, and an alert held meanwhile survives', async () => {
    const held = asHeld(heldEvents(100));
    const late = JSON.stringify(reservoirEvent(100));
    const removals = [];
    await drain(held, { onTelegramSend: (n, list) => { if (n === 1) list.push(late); }, removals });
    assert.deepEqual(removals.map((r) => r.length), [50, 50]);
    assert.deepEqual(held, [late]);
  });
});
