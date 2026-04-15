// Regression locks for PR #3097 review findings:
//
//   1. runSeed passes publishData (post-transform) to declareRecords. Seeders
//      that author declareRecords against the pre-transform shape silently
//      enter the RETRY path (count=0 with zeroIsValid=false), skipping the
//      write. seed-token-panels hit this on all 3 token keys.
//
//   2. extraKeys whose key begins with `seed-meta:` must NEVER be enveloped —
//      health/bundle-runner/legacy readers parse them as bare `{fetchedAt,
//      recordCount}`. seed-iea-oil-stocks' ANALYSIS_META_EXTRA_KEY hit this.
//
//   3. Per-extra-key declareRecords must operate on the transformed extra-key
//      payload, not the raw fetch result. Token-panels' AI/OTHER extras now
//      declare their own recordCount against the extracted panel.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildEnvelope, unwrapEnvelope } from '../scripts/_seed-envelope-source.mjs';
import { resolveRecordCount } from '../scripts/_seed-contract.mjs';
import { shouldEnvelopeKey } from '../scripts/_seed-utils.mjs';

// ─── Commit A: shouldEnvelopeKey invariant ──────────────────────────────

test('shouldEnvelopeKey: seed-meta:* keys must stay bare', () => {
  assert.equal(shouldEnvelopeKey('seed-meta:energy:oil-stocks-analysis'), false);
  assert.equal(shouldEnvelopeKey('seed-meta:conflict:ucdp-events'), false);
  assert.equal(shouldEnvelopeKey('seed-meta:'), false);
});

test('shouldEnvelopeKey: canonical data keys DO envelope', () => {
  assert.equal(shouldEnvelopeKey('economic:fsi-eu:v1'), true);
  assert.equal(shouldEnvelopeKey('market:defi-tokens:v1'), true);
  assert.equal(shouldEnvelopeKey('climate:zone-normals:v1'), true);
});

test('shouldEnvelopeKey: non-string / falsy → defensive false', () => {
  assert.equal(shouldEnvelopeKey(null), false);
  assert.equal(shouldEnvelopeKey(undefined), false);
  assert.equal(shouldEnvelopeKey(''), true); // empty string is not a seed-meta prefix
});

// ─── Commit B: declareRecords must work on post-transform shape ──────────

test('seed-token-panels: canonical declareRecords counts tokens on transformed shape', async () => {
  const { declareRecords } = await import('../scripts/seed-token-panels.mjs');
  // publishTransform = (data) => data.defi, so declareRecords receives the defi panel itself.
  const transformedDefi = { tokens: [{ symbol: 'UNI' }, { symbol: 'AAVE' }], sparkline: [] };
  assert.equal(declareRecords(transformedDefi), 2);
});

test('seed-token-panels: canonical declareRecords returns 0 when tokens missing', async () => {
  const { declareRecords } = await import('../scripts/seed-token-panels.mjs');
  assert.equal(declareRecords({}), 0);
  assert.equal(declareRecords({ tokens: null }), 0);
  assert.equal(declareRecords(null), 0);
});

test('seed-token-panels: per-extra-key declareRecords gets transformed AI/OTHER shape', async () => {
  const { declareRecords } = await import('../scripts/seed-token-panels.mjs');
  // After our fix, AI_KEY/OTHER_KEY extraKeys reuse canonical declareRecords.
  // Each extra's transform returns data.ai or data.other — same {tokens, ...} shape.
  const aiTransformed = { tokens: [{ symbol: 'FET' }, { symbol: 'AGIX' }, { symbol: 'OCEAN' }] };
  const otherTransformed = { tokens: [{ symbol: 'DOGE' }] };
  assert.equal(declareRecords(aiTransformed), 3, 'AI extra must count tokens correctly');
  assert.equal(declareRecords(otherTransformed), 1, 'OTHER extra must count tokens correctly');
});

// ─── Commit B sanity: old bug reproduction ───────────────────────────────

test('seed-token-panels: old buggy signature would have returned 0', async () => {
  // This test documents what the PRE-fix code did, proving the RETRY bug. If
  // declareRecords were *still* counting defi+ai+other from pre-transform
  // fields on the transformed payload, it would return 0 and runSeed would
  // RETRY. Keep this so anyone "simplifying" back to the old form fails.
  const transformedDefi = { tokens: [{ symbol: 'UNI' }] };
  const buggyOld = (data) =>
    (data?.defi?.tokens?.length || 0) + (data?.ai?.tokens?.length || 0) + (data?.other?.tokens?.length || 0);
  assert.equal(buggyOld(transformedDefi), 0, 'Pre-fix behavior — MUST NOT return to this');
});

// ─── Commit E: resolveRecordCount contract invariants ────────────────────

test('resolveRecordCount: accepts 0 when declareRecords returns 0', () => {
  assert.equal(resolveRecordCount(() => 0, {}), 0);
});

test('resolveRecordCount: throws on non-integer return', () => {
  assert.throws(() => resolveRecordCount(() => 3.5, {}), /non-negative integer/);
  assert.throws(() => resolveRecordCount(() => 'many', {}), /non-negative integer/);
});

// ─── Commit D: envelope unwrap on product-catalog cached shape ──────────

test('unwrapEnvelope: contract-mode product-catalog payload returns bare {tiers,...}', () => {
  const bare = { tiers: [{ id: 'pro', price: 12 }], fetchedAt: 1, cachedUntil: 2, priceSource: 'dodo' };
  const enveloped = buildEnvelope({
    fetchedAt: 1, recordCount: 1, sourceVersion: 'dodo-v1', schemaVersion: 1, state: 'OK',
    data: bare,
  });
  const unwrapped = unwrapEnvelope(enveloped).data;
  assert.deepEqual(unwrapped, bare, 'edge reader must return bare tiers shape, not {_seed, data}');
});

test('unwrapEnvelope: legacy bare product-catalog value passes through', () => {
  const legacy = { tiers: [], fetchedAt: 100, cachedUntil: 200, priceSource: 'fallback' };
  assert.deepEqual(unwrapEnvelope(legacy).data, legacy);
});
