/**
 * Sprint 1 / U4 — tests for the per-channel/per-cluster delivered-log writer.
 *
 * Contract being verified (full rationale lives in the writer's module
 * docblock at scripts/lib/digest-delivered-log.mjs — JSDoc and code
 * comments here reference back to that header rather than re-stating it):
 *
 *   1. Key shape is `digest:sent:v1:${userId}:${channel}:${ruleId}:${clusterId}`
 *      with EVERY discriminator explicit. No fallback collapse.
 *   2. Value is `JSON.stringify({ sentAt, sourceCount, severity })` —
 *      U5's cooldown evaluator's read contract.
 *   3. TTL = 30d base + uniform random jitter [0, 3d) — prevents
 *      synchronized cliff expiry of every key 30d after first deploy.
 *   4. SET NX EX in JSON-body pipeline form — idempotent without
 *      write-then-reread. Caller trusts the boolean response.
 *   5. Tri-state result `{written, conflicts, errors}`. Caller MUST
 *      early-return on errors > 0 BEFORE any subsequent stamp/log.
 *   6. Empty / invalid key components throw BEFORE the network call —
 *      malformed keys never reach Upstash.
 *
 * Run: node --test tests/digest-delivered-log.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALLOWED_CHANNELS,
  aggregateResults,
  buildDeliveredLogKey,
  computeTtlSecondsWithJitter,
  writeDeliveredEntry,
} from '../scripts/lib/digest-delivered-log.mjs';
import {
  buildScanPattern,
  buildSingleKey,
  parseArgs,
  runClear,
} from '../scripts/clear-delivered-entry.mjs';

// ── Mocks ──────────────────────────────────────────────────────────────────────

/**
 * Programmable Upstash pipeline mock. Records every commands payload
 * (pipeline takes Array<unknown[]>) and returns a fixed cell sequence.
 *
 * Default cell = { result: 'OK' } (success / new write). Override per
 * test via `responses` to drive conflict / error branches.
 *
 * Set `throwOnce: true` to simulate a transient fetch reject — the
 * writer should map this to errors=1 and not surface the throw.
 */
function mockPipeline({ responses = [{ result: 'OK' }], throwOnce = false } = {}) {
  const calls = [];
  let didThrow = false;
  const impl = async (commands) => {
    calls.push(commands);
    if (throwOnce && !didThrow) {
      didThrow = true;
      throw new Error('mock pipeline transient throw');
    }
    return responses;
  };
  return { impl, calls };
}

/** Deterministic random source for jitter tests. */
function seqRandom(values) {
  let i = 0;
  return () => {
    const v = values[i % values.length];
    i++;
    return v;
  };
}

// ── buildDeliveredLogKey ───────────────────────────────────────────────────────

describe('buildDeliveredLogKey — key shape + validation', () => {
  it('produces digest:sent:v1:{userId}:{channel}:{ruleId}:{clusterId}', () => {
    const k = buildDeliveredLogKey({
      userId: 'user_abc',
      channel: 'email',
      ruleId: 'full:en:high',
      clusterId: 'sha256-deadbeef',
    });
    assert.equal(k, 'digest:sent:v1:user_abc:email:full:en:high:sha256-deadbeef');
  });

  it('throws on empty userId / channel / ruleId / clusterId', () => {
    const valid = { userId: 'u', channel: 'email', ruleId: 'r', clusterId: 'c' };
    for (const field of ['userId', 'ruleId', 'clusterId']) {
      assert.throws(
        () => buildDeliveredLogKey({ ...valid, [field]: '' }),
        new RegExp(`${field} must be a non-empty string`),
      );
      assert.throws(
        () => buildDeliveredLogKey({ ...valid, [field]: null }),
        new RegExp(`${field} must be a non-empty string`),
      );
    }
    assert.throws(
      () => buildDeliveredLogKey({ ...valid, channel: '' }),
      /channel must be a non-empty string/,
    );
  });

  it('rejects unknown channel — only ALLOWED_CHANNELS', () => {
    for (const ch of [...ALLOWED_CHANNELS]) {
      assert.doesNotThrow(() =>
        buildDeliveredLogKey({ userId: 'u', channel: ch, ruleId: 'r', clusterId: 'c' }),
      );
    }
    assert.throws(
      () => buildDeliveredLogKey({ userId: 'u', channel: 'sms', ruleId: 'r', clusterId: 'c' }),
      /channel must be one of/,
    );
  });
});

// ── computeTtlSecondsWithJitter ────────────────────────────────────────────────

describe('computeTtlSecondsWithJitter — distribution', () => {
  const BASE = 30 * 24 * 60 * 60;            // 2_592_000
  const MAX = BASE + 3 * 24 * 60 * 60;       // 2_851_200

  it('default Math.random: 100 samples land in [BASE, BASE+3d)', () => {
    for (let i = 0; i < 100; i++) {
      const ttl = computeTtlSecondsWithJitter();
      assert.ok(ttl >= BASE, `ttl=${ttl} below base=${BASE}`);
      assert.ok(ttl < MAX, `ttl=${ttl} >= max=${MAX}`);
    }
  });

  it('deterministic: random=0 → exactly BASE, random=0.9999999 → BASE+3d-1', () => {
    assert.equal(computeTtlSecondsWithJitter(() => 0), BASE);
    // The clamp at 0.9999999 ensures random=1 still produces a value
    // strictly less than BASE+jitter — protects callers from off-by-one
    // bound assertions.
    const ttl = computeTtlSecondsWithJitter(() => 1);
    assert.ok(ttl < MAX, `ttl=${ttl} should be < ${MAX} when random=1 (clamped)`);
    assert.ok(ttl >= MAX - 1);
  });

  it('jitter spreads — 200 samples cover at least 50% of the [BASE, BASE+3d) range', () => {
    // Loose distribution check: with 200 uniform samples we expect the
    // observed range (max - min) to span well over half the jitter
    // window. Tighter-than-50% would invite flakes; the goal here is
    // "no clustering at exact BASE", not statistical purity.
    const samples = [];
    for (let i = 0; i < 200; i++) samples.push(computeTtlSecondsWithJitter());
    const min = Math.min(...samples);
    const max = Math.max(...samples);
    const span = max - min;
    const jitterWindow = MAX - BASE;
    assert.ok(
      span > jitterWindow * 0.5,
      `expected span > ${jitterWindow * 0.5}; got ${span} (min=${min}, max=${max})`,
    );
  });

  it('handles invalid random (NaN, negative, >1) defensively', () => {
    assert.equal(computeTtlSecondsWithJitter(() => Number.NaN), BASE);
    assert.equal(computeTtlSecondsWithJitter(() => -5), BASE);
    const ttl = computeTtlSecondsWithJitter(() => 5);
    assert.ok(ttl < MAX);
  });
});

// ── writeDeliveredEntry — happy path ───────────────────────────────────────────

describe('writeDeliveredEntry — happy path', () => {
  it('first write → { written: 1, conflicts: 0, errors: 0 }; key + value + TTL on the wire', async () => {
    const pipeline = mockPipeline();
    const result = await writeDeliveredEntry({
      userId: 'user_abc',
      channel: 'email',
      ruleId: 'full:en:high',
      clusterId: 'cluster-1',
      sentAt: 1_700_000_000_000,
      sourceCount: 4,
      severity: 'high',
      deps: { redisPipeline: pipeline.impl, randomFn: () => 0.5 },
    });
    assert.deepEqual(result, {
      written: 1,
      conflicts: 0,
      errors: 0,
      key: 'digest:sent:v1:user_abc:email:full:en:high:cluster-1',
    });
    // Pipeline received exactly one command in JSON-body form.
    assert.equal(pipeline.calls.length, 1);
    assert.deepEqual(pipeline.calls[0], [[
      'SET',
      'digest:sent:v1:user_abc:email:full:en:high:cluster-1',
      JSON.stringify({ sentAt: 1_700_000_000_000, sourceCount: 4, severity: 'high' }),
      // Codex PR #3617 round-4 P1 — SET (overwrite) semantics, NOT
      // SET NX. Every successful send refreshes the row so subsequent
      // cooldown reads see the most recent delivery.
      'EX',
      String(2_592_000 + Math.floor(0.5 * 259_200)),
    ]]);
  });

  it('value JSON parses back into { sentAt, sourceCount, severity }', async () => {
    const pipeline = mockPipeline();
    await writeDeliveredEntry({
      userId: 'u', channel: 'telegram', ruleId: 'r', clusterId: 'c',
      sentAt: 42, sourceCount: 7, severity: 'critical',
      deps: { redisPipeline: pipeline.impl, randomFn: () => 0 },
    });
    const sentValue = pipeline.calls[0][0][2];
    assert.deepEqual(JSON.parse(sentValue), { sentAt: 42, sourceCount: 7, severity: 'critical' });
  });

  // Greptile PR #3617 P2 — headline persistence for EVOLUTION_NEW_FACT.
  it('persists headline when caller provides it (drives U5 new-fact bypass next tick)', async () => {
    const pipeline = mockPipeline();
    await writeDeliveredEntry({
      userId: 'u', channel: 'email', ruleId: 'r', clusterId: 'c',
      sentAt: 42, sourceCount: 7, severity: 'critical',
      headline: 'Iran threatens to close Strait of Hormuz',
      deps: { redisPipeline: pipeline.impl, randomFn: () => 0 },
    });
    const parsed = JSON.parse(pipeline.calls[0][0][2]);
    assert.equal(parsed.headline, 'Iran threatens to close Strait of Hormuz');
  });

  it('omits headline field when caller passes empty string (forward-compat: no field at all)', async () => {
    // Older readers must not see an unexpected empty-string headline
    // and trip a "headline must be non-empty" check later. Cleanest
    // forward-compat: omit the field entirely when absent on write.
    const pipeline = mockPipeline();
    await writeDeliveredEntry({
      userId: 'u', channel: 'email', ruleId: 'r', clusterId: 'c',
      sentAt: 42, sourceCount: 7, severity: 'critical',
      headline: '',
      deps: { redisPipeline: pipeline.impl, randomFn: () => 0 },
    });
    const parsed = JSON.parse(pipeline.calls[0][0][2]);
    assert.equal(parsed.headline, undefined, 'empty-string headline must not be persisted');
  });

  it('omits headline field when caller does not pass headline at all (call-site back-compat)', async () => {
    const pipeline = mockPipeline();
    await writeDeliveredEntry({
      userId: 'u', channel: 'email', ruleId: 'r', clusterId: 'c',
      sentAt: 42, sourceCount: 7, severity: 'critical',
      // no `headline` arg
      deps: { redisPipeline: pipeline.impl, randomFn: () => 0 },
    });
    const parsed = JSON.parse(pipeline.calls[0][0][2]);
    assert.equal(parsed.headline, undefined);
  });

  it('writes to every channel in ALLOWED_CHANNELS', async () => {
    for (const ch of ALLOWED_CHANNELS) {
      const pipeline = mockPipeline();
      const r = await writeDeliveredEntry({
        userId: 'u', channel: ch, ruleId: 'r', clusterId: 'c',
        sentAt: 1, sourceCount: 1, severity: 'medium',
        deps: { redisPipeline: pipeline.impl },
      });
      assert.equal(r.written, 1, `channel=${ch} expected written=1`);
      assert.equal(r.errors, 0);
      assert.match(r.key, new RegExp(`:${ch}:`));
    }
  });
});

// ── writeDeliveredEntry — refresh semantics (Codex PR #3617 round-4 P1) ────────

describe('writeDeliveredEntry — refresh-on-write semantics (post-Codex round-4 P1)', () => {
  // Pre-fix used SET NX so the row stuck to its first value forever.
  // After a high-event re-air was ALLOWED at 19h, the Redis row still
  // pointed to T0 — so the next re-air at 20h saw "20h beyond 18h
  // floor → allow" instead of "1h since last delivery → suppress".
  // Post-fix: every successful send overwrites the row.

  it('back-to-back writes both succeed → counters land at written=2, conflicts=0', async () => {
    // Both writes return OK under SET semantics (overwrite is fine).
    const impl = async () => [{ result: 'OK' }];
    const r1 = await writeDeliveredEntry({
      userId: 'u', channel: 'email', ruleId: 'r', clusterId: 'c',
      sentAt: 1, sourceCount: 1, severity: 'high',
      deps: { redisPipeline: impl },
    });
    const r2 = await writeDeliveredEntry({
      userId: 'u', channel: 'email', ruleId: 'r', clusterId: 'c',
      sentAt: 2, sourceCount: 2, severity: 'high',
      deps: { redisPipeline: impl },
    });
    const agg = aggregateResults([r1, r2]);
    // Post-fix: both writes succeed, conflicts always 0 under SET.
    assert.deepEqual(agg, { written: 2, conflicts: 0, errors: 0 });
  });

  it('writer issues SET (NOT SET NX) — NX would lock the row to first value forever', async () => {
    const pipeline = mockPipeline();
    await writeDeliveredEntry({
      userId: 'u', channel: 'email', ruleId: 'r', clusterId: 'c',
      sentAt: 1, sourceCount: 1, severity: 'high',
      deps: { redisPipeline: pipeline.impl, randomFn: () => 0 },
    });
    const cmd = pipeline.calls[0][0];
    // Verify the literal command shape — must NOT include 'NX'.
    assert.equal(cmd[0], 'SET');
    assert.equal(cmd[3], 'EX', `expected SET ... EX (not SET ... NX). Got: ${JSON.stringify(cmd)}`);
    assert.notEqual(cmd[3], 'NX', 'NX would lock the row; refresh requires plain SET');
  });

  it('refreshing the row updates {sentAt, sourceCount, severity} on each write', async () => {
    // Two writes for the same key with different values. Pre-fix the
    // second write was a no-op (NX). Post-fix the second value is what
    // a downstream cooldown read would see.
    const pipeline = mockPipeline();
    await writeDeliveredEntry({
      userId: 'u', channel: 'email', ruleId: 'r', clusterId: 'c',
      sentAt: 1_700_000_000_000, sourceCount: 3, severity: 'high',
      deps: { redisPipeline: pipeline.impl },
    });
    await writeDeliveredEntry({
      userId: 'u', channel: 'email', ruleId: 'r', clusterId: 'c',
      sentAt: 1_700_000_069_000, // 19h later
      sourceCount: 8, // +5 sources evolution
      severity: 'critical',
      deps: { redisPipeline: pipeline.impl },
    });
    // Both writes were issued (refresh, not skip).
    assert.equal(pipeline.calls.length, 2);
    // Second write carries the updated value — this is what makes the
    // subsequent cooldown read see lastDeliveredAt = 1700000069000.
    const secondValue = JSON.parse(pipeline.calls[1][0][2]);
    assert.equal(secondValue.sentAt, 1_700_000_069_000);
    assert.equal(secondValue.sourceCount, 8);
    assert.equal(secondValue.severity, 'critical');
  });
});

// ── writeDeliveredEntry — error paths ──────────────────────────────────────────

describe('writeDeliveredEntry — error mapping', () => {
  it('pipeline returns null (creds missing / 5xx / fetch threw inside helper) → errors=1, NO write', async () => {
    const impl = async () => null;
    const r = await writeDeliveredEntry({
      userId: 'u', channel: 'email', ruleId: 'r', clusterId: 'c',
      sentAt: 1, sourceCount: 1, severity: 'high',
      deps: { redisPipeline: impl },
    });
    assert.deepEqual(r, {
      written: 0,
      conflicts: 0,
      errors: 1,
      key: 'digest:sent:v1:u:email:r:c',
    });
  });

  it('pipeline cell has { error } → errors=1', async () => {
    const impl = async () => [{ error: 'WRONGTYPE Operation against a key holding the wrong kind of value' }];
    const r = await writeDeliveredEntry({
      userId: 'u', channel: 'email', ruleId: 'r', clusterId: 'c',
      sentAt: 1, sourceCount: 1, severity: 'high',
      deps: { redisPipeline: impl },
    });
    assert.equal(r.errors, 1);
    assert.equal(r.written, 0);
  });

  it('pipeline throws → errors=1 (mapped, not propagated)', async () => {
    const pipeline = mockPipeline({ throwOnce: true });
    const r = await writeDeliveredEntry({
      userId: 'u', channel: 'email', ruleId: 'r', clusterId: 'c',
      sentAt: 1, sourceCount: 1, severity: 'high',
      deps: { redisPipeline: pipeline.impl },
    });
    assert.equal(r.errors, 1);
    assert.equal(r.written, 0);
  });

  it('unknown response shape (e.g. {result: 1}) → errors=1 (defensive)', async () => {
    const impl = async () => [{ result: 1 }];
    const r = await writeDeliveredEntry({
      userId: 'u', channel: 'email', ruleId: 'r', clusterId: 'c',
      sentAt: 1, sourceCount: 1, severity: 'high',
      deps: { redisPipeline: impl },
    });
    assert.equal(r.errors, 1);
  });
});

// ── writeDeliveredEntry — input validation throws (no Upstash call) ────────────

describe('writeDeliveredEntry — input validation', () => {
  it('clusterId === "" throws BEFORE any pipeline call', async () => {
    let pipelineCalled = false;
    const impl = async () => { pipelineCalled = true; return [{ result: 'OK' }]; };
    await assert.rejects(
      writeDeliveredEntry({
        userId: 'u', channel: 'email', ruleId: 'r', clusterId: '',
        sentAt: 1, sourceCount: 1, severity: 'high',
        deps: { redisPipeline: impl },
      }),
      /clusterId must be a non-empty string/,
    );
    assert.equal(pipelineCalled, false, 'pipeline must NOT be called for malformed keys');
  });

  it('non-positive sentAt throws BEFORE any pipeline call', async () => {
    let pipelineCalled = false;
    const impl = async () => { pipelineCalled = true; return [{ result: 'OK' }]; };
    for (const bad of [0, -1, Number.NaN, 'now', null, undefined]) {
      await assert.rejects(
        writeDeliveredEntry({
          userId: 'u', channel: 'email', ruleId: 'r', clusterId: 'c',
          sentAt: bad, sourceCount: 1, severity: 'high',
          deps: { redisPipeline: impl },
        }),
        /sentAt must be a positive epoch-ms number/,
      );
    }
    assert.equal(pipelineCalled, false);
  });

  it('weird sourceCount / severity coerce defensively (no throw)', async () => {
    const pipeline = mockPipeline();
    const r = await writeDeliveredEntry({
      userId: 'u', channel: 'email', ruleId: 'r', clusterId: 'c',
      sentAt: 1, sourceCount: -5, severity: '',
      deps: { redisPipeline: pipeline.impl },
    });
    assert.equal(r.errors, 0);
    const sentValue = JSON.parse(pipeline.calls[0][0][2]);
    assert.equal(sentValue.sourceCount, 0, 'negative coerces to 0');
    assert.equal(sentValue.severity, 'unknown', 'empty severity coerces to "unknown"');
  });
});

// ── aggregateResults ───────────────────────────────────────────────────────────

describe('aggregateResults', () => {
  it('sums tri-state counters across multiple writes', () => {
    const agg = aggregateResults([
      { written: 1, conflicts: 0, errors: 0 },
      { written: 0, conflicts: 1, errors: 0 },
      { written: 1, conflicts: 0, errors: 0 },
      { written: 0, conflicts: 0, errors: 1 },
    ]);
    assert.deepEqual(agg, { written: 2, conflicts: 1, errors: 1 });
  });

  it('handles empty / non-array input safely', () => {
    assert.deepEqual(aggregateResults([]), { written: 0, conflicts: 0, errors: 0 });
    assert.deepEqual(aggregateResults(null), { written: 0, conflicts: 0, errors: 0 });
    assert.deepEqual(aggregateResults(undefined), { written: 0, conflicts: 0, errors: 0 });
  });

  it('tolerates partial cells (missing keys default to 0)', () => {
    const agg = aggregateResults([
      { written: 3 },
      { conflicts: 2 },
      { errors: 1 },
      {},
    ]);
    assert.deepEqual(agg, { written: 3, conflicts: 2, errors: 1 });
  });
});

// ── Integration-shape sanity (no live Upstash) ─────────────────────────────────

describe('writeDeliveredEntry — integration shape (single-user, multi-channel)', () => {
  it('full digest send across email + Telegram → exactly 2 entries with same {userId,ruleId,clusterId}, differing channel', async () => {
    const calls = [];
    const impl = async (commands) => {
      calls.push(commands);
      return [{ result: 'OK' }];
    };
    const common = {
      userId: 'user_xyz',
      ruleId: 'full:en:high',
      clusterId: 'sha256-cluster-A',
      sentAt: 1_700_000_000_000,
      sourceCount: 3,
      severity: 'critical',
      deps: { redisPipeline: impl },
    };
    const r1 = await writeDeliveredEntry({ ...common, channel: 'email' });
    const r2 = await writeDeliveredEntry({ ...common, channel: 'telegram' });
    assert.equal(r1.written, 1);
    assert.equal(r2.written, 1);
    assert.notEqual(r1.key, r2.key, 'channel discriminator must produce distinct keys');
    assert.match(r1.key, /:email:/);
    assert.match(r2.key, /:telegram:/);
    assert.equal(calls.length, 2);
  });

  it('failing channel (mock telegram pipeline returns error) → email entry exists, telegram does NOT', async () => {
    const writes = [];
    const emailPipeline = async (commands) => {
      writes.push({ channel: 'email', commands });
      return [{ result: 'OK' }];
    };
    const telegramPipeline = async (commands) => {
      writes.push({ channel: 'telegram', commands });
      return null; // simulate Upstash 5xx during the telegram entry write
    };
    const common = {
      userId: 'u', ruleId: 'r', clusterId: 'c',
      sentAt: 1, sourceCount: 1, severity: 'high',
    };
    const rEmail = await writeDeliveredEntry({
      ...common, channel: 'email',
      deps: { redisPipeline: emailPipeline },
    });
    const rTel = await writeDeliveredEntry({
      ...common, channel: 'telegram',
      deps: { redisPipeline: telegramPipeline },
    });
    assert.equal(rEmail.written, 1);
    assert.equal(rEmail.errors, 0);
    assert.equal(rTel.written, 0);
    assert.equal(rTel.errors, 1);
    // Cron caller's contract: rTel.errors > 0 → DO NOT mark stamp.
    // Story is eligible to re-air to telegram next tick. Verified by
    // the call-site behaviour in tests/digest-delivered-log-source-
    // guard.test.mjs (source-text guard for the integration site).
  });
});

// ── clearDeliveredEntry — operator one-shot ────────────────────────────────────
//
// The script lives at scripts/clear-delivered-entry.mjs; tests live here
// (not in a sibling file) so the .husky/pre-push glob picks them up
// alongside the writer's tests under the same `digest-delivered-log` name.
// Pattern matches the U2 + U3 unit-vs-integration colocation.

describe('clear-delivered-entry — argument parsing', () => {
  it('rejects invocation without --reason (the dedicated audit-trail flag)', () => {
    const r = parseArgs(['--user', 'u', '--slot', 's', '--cluster', 'c']);
    assert.equal(r.kind, 'err');
    assert.match(r.message, /missing required flag: --reason/);
  });

  it('rejects invocation without --user / --slot / --cluster', () => {
    for (const missing of ['user', 'slot', 'cluster']) {
      const argv = ['--user', 'u', '--slot', 's', '--cluster', 'c', '--reason', 'r']
        .filter((_, i, a) => !(a[i - 1] === `--${missing}` || a[i] === `--${missing}`));
      const r = parseArgs(argv);
      assert.equal(r.kind, 'err', `missing --${missing} should error`);
      assert.match(r.message, new RegExp(`missing required flag: --${missing}`));
    }
  });

  it('accepts the minimum-args invocation (sweep mode)', () => {
    const r = parseArgs(['--user', 'u', '--slot', '2026-05-06-0800', '--cluster', 'c', '--reason', 'audit-recovery']);
    assert.equal(r.kind, 'ok');
    assert.deepEqual(r.args, {
      user: 'u',
      slot: '2026-05-06-0800',
      cluster: 'c',
      reason: 'audit-recovery',
    });
  });

  it('accepts the full-args invocation (single-key mode)', () => {
    const r = parseArgs([
      '--user', 'u', '--slot', '2026-05-06-0800', '--cluster', 'c',
      '--channel', 'email', '--rule', 'full:en:high',
      '--reason', 'classifier-misfire',
    ]);
    assert.equal(r.kind, 'ok');
    assert.equal(r.args.channel, 'email');
    assert.equal(r.args.rule, 'full:en:high');
  });

  it('rejects --channel without --rule (and vice versa) — must be paired', () => {
    const r1 = parseArgs(['--user', 'u', '--slot', 's', '--cluster', 'c', '--channel', 'email', '--reason', 'r']);
    assert.equal(r1.kind, 'err');
    assert.match(r1.message, /must be specified together/);
    const r2 = parseArgs(['--user', 'u', '--slot', 's', '--cluster', 'c', '--rule', 'r1', '--reason', 'r']);
    assert.equal(r2.kind, 'err');
    assert.match(r2.message, /must be specified together/);
  });

  it('rejects unknown channel values', () => {
    const r = parseArgs([
      '--user', 'u', '--slot', 's', '--cluster', 'c',
      '--channel', 'sms', '--rule', 'r', '--reason', 'r',
    ]);
    assert.equal(r.kind, 'err');
    assert.match(r.message, /channel must be one of/);
  });

  it('rejects unknown flags loudly (typo guard)', () => {
    const r = parseArgs(['--user', 'u', '--slott', '2026-05-06', '--cluster', 'c', '--reason', 'r']);
    assert.equal(r.kind, 'err');
    assert.match(r.message, /unknown flag/);
  });

  it('rejects flag with no value (or value that looks like another flag)', () => {
    const r1 = parseArgs(['--user', '--slot', 's', '--cluster', 'c', '--reason', 'r']);
    assert.equal(r1.kind, 'err');
    assert.match(r1.message, /requires a non-empty value/);
  });

  // Codex PR #3617 P1 — Redis SCAN glob-injection guard.
  // The sweep-mode pattern is `digest:sent:v1:${user}:*:*:${cluster}`.
  // If user OR cluster contains glob metacharacters (* ? [ ] \), the
  // pattern broadens and the followup DEL loop wipes far more rows
  // than the operator intended. Guard at parse time.
  it('rejects --cluster value containing * (Redis glob char)', () => {
    const r = parseArgs(['--user', 'u', '--slot', 's', '--cluster', '*', '--reason', 'oops']);
    assert.equal(r.kind, 'err');
    assert.match(r.message, /glob metacharacter/);
    assert.match(r.message, /--cluster/);
  });

  it('rejects --cluster value containing prefix wildcard (foo*)', () => {
    const r = parseArgs(['--user', 'u', '--slot', 's', '--cluster', 'foo*', '--reason', 'oops']);
    assert.equal(r.kind, 'err');
    assert.match(r.message, /glob metacharacter/);
  });

  it('rejects --user value containing * (would broaden across users)', () => {
    const r = parseArgs(['--user', 'u*', '--slot', 's', '--cluster', 'c', '--reason', 'oops']);
    assert.equal(r.kind, 'err');
    assert.match(r.message, /--user/);
    assert.match(r.message, /glob metacharacter/);
  });

  it('rejects --cluster value containing ? (single-char wildcard)', () => {
    const r = parseArgs(['--user', 'u', '--slot', 's', '--cluster', 'c?', '--reason', 'oops']);
    assert.equal(r.kind, 'err');
    assert.match(r.message, /glob metacharacter/);
  });

  it('rejects --cluster value containing [ (character class)', () => {
    const r = parseArgs(['--user', 'u', '--slot', 's', '--cluster', 'c[ab]', '--reason', 'oops']);
    assert.equal(r.kind, 'err');
    assert.match(r.message, /glob metacharacter/);
  });

  it('rejects --cluster value containing \\ (escape char)', () => {
    const r = parseArgs(['--user', 'u', '--slot', 's', '--cluster', 'c\\x', '--reason', 'oops']);
    assert.equal(r.kind, 'err');
    assert.match(r.message, /glob metacharacter/);
  });

  it('rejects --channel containing glob char (even though channel is from a fixed set, defence-in-depth)', () => {
    const r = parseArgs(['--user', 'u', '--slot', 's', '--cluster', 'c', '--channel', 'em*', '--rule', 'r', '--reason', 'oops']);
    assert.equal(r.kind, 'err');
    assert.match(r.message, /glob metacharacter|--channel must be one of/);
  });

  // Codex PR #3617 P2 update — exact-DEL mode (both --channel + --rule)
  // accepts glob chars in --rule because the resulting key is DEL'd
  // literally (Redis treats DEL args as exact strings, not patterns).
  // The pre-fix test rejected this case; the post-fix contract allows
  // it for legitimate ruleId composites that may contain `?` etc.
  it('exact-DEL mode (--channel + --rule) accepts --rule with glob char (post-Codex-P2)', () => {
    const r = parseArgs(['--user', 'u', '--slot', 's', '--cluster', 'c', '--channel', 'email', '--rule', 'full:*:high', '--reason', 'oops']);
    assert.equal(r.kind, 'ok');
    assert.equal(r.args.rule, 'full:*:high');
  });

  it('--reason is exempt (audit log, never reaches Redis pattern)', () => {
    // Operators may legitimately put glob chars in a reason string
    // (e.g. "duplicate * in test fixture"). The reason is logged but
    // never substituted into the SCAN pattern, so it's safe.
    const r = parseArgs(['--user', 'u', '--slot', 's', '--cluster', 'c', '--reason', 'wildcard * cleanup']);
    assert.equal(r.kind, 'ok');
  });

  // Codex PR #3617 P2 — exact-DEL mode must accept glob chars.
  // Legitimate clusterIds can be the level-3 fallback `url:${sourceUrl}`
  // (shared/brief-filter.js:300) and real URLs commonly contain `?` for
  // query strings. Rejecting these in exact-DEL mode would make those
  // delivered-log rows unrecoverable via this primitive. The guard is
  // sweep-mode-only (no --channel + no --rule).
  it('exact-DEL mode (--channel + --rule) accepts cluster with ? (URL-fallback clusterIds)', () => {
    const r = parseArgs([
      '--user', 'u',
      '--slot', 's',
      '--cluster', 'url:https://example.com/article?ref=rss',
      '--channel', 'email',
      '--rule', 'full:en:high',
      '--reason', 'cleanup-of-rss-fallback',
    ]);
    assert.equal(r.kind, 'ok', `expected exact-DEL with ? in clusterId to parse OK, got: ${JSON.stringify(r)}`);
    assert.equal(r.args.cluster, 'url:https://example.com/article?ref=rss');
  });

  it('exact-DEL mode accepts cluster with bracket chars (deep URL paths)', () => {
    const r = parseArgs([
      '--user', 'u',
      '--slot', 's',
      '--cluster', 'url:https://example.com/[breaking]/article',
      '--channel', 'email',
      '--rule', 'full:en:high',
      '--reason', 'cleanup-of-bracketed-url',
    ]);
    assert.equal(r.kind, 'ok');
  });

  it('sweep mode (no --channel/--rule) STILL rejects glob chars in cluster (regression guard for the original Codex P1)', () => {
    const r = parseArgs([
      '--user', 'u',
      '--slot', 's',
      '--cluster', 'url:https://example.com/article?ref=rss',
      '--reason', 'cleanup',
    ]);
    assert.equal(r.kind, 'err');
    assert.match(r.message, /sweep mode/);
    assert.match(r.message, /exact-DEL mode by also passing/);
  });

  it('sweep mode rejects --user with * (still guarded)', () => {
    const r = parseArgs(['--user', 'u*', '--slot', 's', '--cluster', 'c', '--reason', 'oops']);
    assert.equal(r.kind, 'err');
    assert.match(r.message, /--user/);
    assert.match(r.message, /sweep mode/);
  });

  it('legitimate values with `:` and `-` still parse cleanly (regression guard)', () => {
    // The glob-char regex is /[*?[\]\\]/ — must not over-match into
    // the legitimate ruleId-composite separator `:` or hash-id `-`.
    const r = parseArgs([
      '--user', 'user-abc-123',
      '--slot', '2026-05-06-2001',
      '--cluster', 'cluster-rep-hash-deadbeef',
      '--channel', 'email',
      '--rule', 'full:en:high',
      '--reason', 'cleanup',
    ]);
    assert.equal(r.kind, 'ok');
  });
});

describe('clear-delivered-entry — key shape helpers', () => {
  it('buildSingleKey matches the writer-side shape', () => {
    assert.equal(
      buildSingleKey('u', 'email', 'full:en:high', 'cluster-1'),
      'digest:sent:v1:u:email:full:en:high:cluster-1',
    );
  });

  it('buildScanPattern wildcards channel + rule, pins user + cluster', () => {
    assert.equal(
      buildScanPattern('user_abc', 'sha256-cluster-1'),
      'digest:sent:v1:user_abc:*:*:sha256-cluster-1',
    );
  });
});

describe('clear-delivered-entry — runClear (single-key mode)', () => {
  function captureLogs() {
    const lines = [];
    return { log: (l) => lines.push(['log', l]), warn: (l) => lines.push(['warn', l]), lines };
  }

  it('--channel email --rule X targets ONE key, leaves others untouched', async () => {
    const calls = [];
    const pipeline = async (cmds) => {
      calls.push(cmds);
      // Upstash returns one cell per command. DEL returns 1 on success.
      return cmds.map(() => ({ result: 1 }));
    };
    const cap = captureLogs();
    const r = await runClear({
      parsed: { user: 'u', slot: '2026-05-06-0800', cluster: 'c', channel: 'email', rule: 'r1', reason: 'audit' },
      deps: { scan: async () => { throw new Error('SCAN must NOT be called in single-key mode'); }, redisPipeline: pipeline, log: cap.log, warn: cap.warn },
    });
    assert.equal(r.code, 0);
    assert.equal(r.deleted, 1);
    assert.equal(r.ineligible.length, 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [['DEL', 'digest:sent:v1:u:email:r1:c']]);
    // Audit line emitted with reason.
    assert.ok(cap.lines.some(([level, line]) => level === 'log' && /DELETED key=digest:sent:v1:u:email:r1:c/.test(line) && /reason="audit"/.test(line)));
  });

  it('DEL returns 0 (key already absent) → 0 deleted, 1 ineligible, exit 0', async () => {
    const pipeline = async (cmds) => cmds.map(() => ({ result: 0 }));
    const cap = captureLogs();
    const r = await runClear({
      parsed: { user: 'u', slot: 's', cluster: 'c', channel: 'email', rule: 'r1', reason: 'audit' },
      deps: { scan: async () => ({ kind: 'ok', keys: [] }), redisPipeline: pipeline, log: cap.log, warn: cap.warn },
    });
    assert.equal(r.code, 0);
    assert.equal(r.deleted, 0);
    assert.equal(r.ineligible.length, 1);
  });
});

describe('clear-delivered-entry — runClear (sweep mode, no channel/rule)', () => {
  it('SCAN finds 3 keys → DELETE pipeline issues 3 commands → 3 deleted', async () => {
    const scanned = [];
    const scan = async (pattern) => {
      scanned.push(pattern);
      return {
        kind: 'ok',
        keys: [
          'digest:sent:v1:u:email:r1:c',
          'digest:sent:v1:u:telegram:r1:c',
          'digest:sent:v1:u:slack:r1:c',
        ],
      };
    };
    const calls = [];
    const pipeline = async (cmds) => {
      calls.push(cmds);
      return cmds.map(() => ({ result: 1 }));
    };
    const r = await runClear({
      parsed: { user: 'u', slot: 's', cluster: 'c', reason: 'sweep-test' },
      deps: { scan, redisPipeline: pipeline, log: () => {}, warn: () => {} },
    });
    assert.equal(r.code, 0);
    assert.equal(r.deleted, 3);
    assert.equal(scanned[0], 'digest:sent:v1:u:*:*:c');
    assert.equal(calls[0].length, 3);
  });

  it('SCAN returns empty → 0 deleted, exit 0, no DEL pipeline call', async () => {
    let pipelineCalled = false;
    const r = await runClear({
      parsed: { user: 'u', slot: 's', cluster: 'c', reason: 'r' },
      deps: {
        scan: async () => ({ kind: 'ok', keys: [] }),
        redisPipeline: async () => { pipelineCalled = true; return []; },
        log: () => {}, warn: () => {},
      },
    });
    assert.equal(r.code, 0);
    assert.equal(r.deleted, 0);
    assert.equal(pipelineCalled, false);
  });

  it('SCAN transport error → exit code 2 (operator retries)', async () => {
    const cap = (() => {
      const lines = [];
      return { log: () => {}, warn: (l) => lines.push(l), lines };
    })();
    const r = await runClear({
      parsed: { user: 'u', slot: 's', cluster: 'c', reason: 'r' },
      deps: {
        scan: async () => ({ kind: 'transport-error', message: 'SCAN HTTP 503' }),
        redisPipeline: async () => { throw new Error('pipeline must NOT be called when SCAN failed'); },
        log: cap.log, warn: cap.warn,
      },
    });
    assert.equal(r.code, 2);
    assert.equal(r.deleted, 0);
    assert.ok(cap.lines.some((l) => /SCAN HTTP 503/.test(l)));
  });

  it('DEL pipeline returns null → exit code 2 (transport failure)', async () => {
    const r = await runClear({
      parsed: { user: 'u', slot: 's', cluster: 'c', channel: 'email', rule: 'r1', reason: 'r' },
      deps: {
        scan: async () => ({ kind: 'ok', keys: [] }),
        redisPipeline: async () => null,
        log: () => {}, warn: () => {},
      },
    });
    assert.equal(r.code, 2);
  });
});
