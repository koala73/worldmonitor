// Runtime proof of the digestFor memo contract (#8690, replacing the
// source-text checks in digest-cache-key-sensitivity.test.mjs).
//
// buildDigest filters by rule.sensitivity BEFORE dedup, so the per-run memo
// must key on sensitivity or a stricter user inherits a looser populator's
// pool. The key builder and the memo factory were extracted from
// scripts/seed-digest-notifications.mjs into the orchestration helpers (the
// cron cannot be imported: it exits on missing env and calls main() at top
// level), the way #8686 extracted the score floor. One text check remains:
// that the cron actually uses the factory, since nothing else can observe that.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { createDigestMemo, digestMemoKey, digestWindowStartMs } from '../scripts/lib/digest-orchestration-helpers.mjs';

const NOW = Date.UTC(2026, 9, 20, 8, 0, 0);
const DAY = 86_400_000;

describe('digestMemoKey', () => {
  it('keys on variant, lang, sensitivity and the window start', () => {
    assert.equal(digestMemoKey({ variant: 'tech', lang: 'fr', sensitivity: 'critical' }, 42), 'tech:fr:critical:42');
  });

  it('defaults a missing sensitivity to high, the same default buildDigest applies', () => {
    assert.equal(digestMemoKey({ variant: 'full', lang: 'en' }, 1), digestMemoKey({ variant: 'full', lang: 'en', sensitivity: 'high' }, 1));
    assert.equal(digestMemoKey({}, 1), 'full:en:high:1');
    assert.equal(digestMemoKey(undefined, 1), 'full:en:high:1');
  });

  it('never lets a stricter sensitivity share a key with a looser one', () => {
    const base = { variant: 'full', lang: 'en' };
    const keys = new Set(['all', 'high', 'critical', undefined].map((sensitivity) => digestMemoKey({ ...base, sensitivity }, 1)));
    assert.equal(keys.size, 3, 'all, high (shared with undefined) and critical are distinct pools');
  });
});

describe('createDigestMemo', () => {
  const rule = (over) => ({ variant: 'full', lang: 'en', ...over });

  it('shares one buildDigest call across users with the same pool and builds a second pool for a stricter user', async () => {
    const calls = [];
    const buildDigest = async (r, windowStart) => { calls.push([r.sensitivity ?? 'high', windowStart]); return [{ hash: `h-${r.sensitivity ?? 'high'}` }]; };
    const digestFor = createDigestMemo(buildDigest, { nowMs: NOW, lookbackMs: DAY });
    const looser = await digestFor({ rule: rule({ sensitivity: 'high' }), lastSentAt: NOW - DAY });
    const omitted = await digestFor({ rule: rule({}), lastSentAt: NOW - DAY });
    const stricter = await digestFor({ rule: rule({ sensitivity: 'critical' }), lastSentAt: NOW - DAY });
    assert.equal(omitted, looser, 'an omitted sensitivity reads the high pool');
    assert.notEqual(stricter, looser, 'critical never inherits the high pool');
    assert.deepEqual(stricter, [{ hash: 'h-critical' }]);
    assert.deepEqual(calls.map(([s]) => s), ['high', 'critical']);
  });

  it('keys on the per-candidate window start, not a fixed lookback', async () => {
    const windows = [];
    const buildDigest = async (_r, windowStart) => { windows.push(windowStart); return []; };
    const digestFor = createDigestMemo(buildDigest, { nowMs: NOW, lookbackMs: DAY });
    await digestFor({ rule: rule({}), lastSentAt: NOW - 7 * DAY });
    await digestFor({ rule: rule({}), lastSentAt: NOW - 12 * 3_600_000 });
    await digestFor({ rule: rule({}), lastSentAt: NOW - 7 * DAY });
    assert.deepEqual(windows, [
      digestWindowStartMs(NOW - 7 * DAY, NOW, DAY),
      digestWindowStartMs(NOW - 12 * 3_600_000, NOW, DAY),
    ]);
  });

  it('caches an empty pool for a null build result instead of rebuilding it', async () => {
    let calls = 0;
    const digestFor = createDigestMemo(async () => { calls += 1; return null; }, { nowMs: NOW, lookbackMs: DAY });
    assert.deepEqual(await digestFor({ rule: rule({}), lastSentAt: null }), []);
    assert.deepEqual(await digestFor({ rule: rule({}), lastSentAt: null }), []);
    assert.equal(calls, 1);
  });

  it('is what the cron hands to the compose flow', () => {
    const cron = readFileSync(new URL('../scripts/seed-digest-notifications.mjs', import.meta.url), 'utf8');
    assert.match(cron, /const digestFor = createDigestMemo\(buildDigest, \{ nowMs, lookbackMs: DIGEST_LOOKBACK_MS \}\);/);
    assert.doesNotMatch(cron, /const digestCache = new Map\(\)/, 'the inline memo must not come back beside the helper');
  });
});
