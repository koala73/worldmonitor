import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { derivePipelinePublicBadge } from '../src/shared/pipeline-evidence';

// Regression tests for the bootstrap-first-paint path of PipelineStatusPanel.
// The exact bug this guards against: bootstrap hydrates raw JSON from
// scripts/data/pipelines-{gas,oil}.json, which does NOT include publicBadge.
// Before this fix, the panel passed raw entries straight into badgeChip()
// and crashed on `undefined.charAt(0)`. Ensure EVERY curated pipeline
// produces a valid badge client-side.

const __dirname = dirname(fileURLToPath(import.meta.url));
const gasRaw = JSON.parse(readFileSync(resolve(__dirname, '../scripts/data/pipelines-gas.json'), 'utf-8')) as { pipelines: Record<string, any> };
const oilRaw = JSON.parse(readFileSync(resolve(__dirname, '../scripts/data/pipelines-oil.json'), 'utf-8')) as { pipelines: Record<string, any> };

const VALID_BADGES = new Set(['flowing', 'reduced', 'offline', 'disputed']);

describe('PipelineStatusPanel bootstrap path — every raw pipeline yields a valid badge', () => {
  test('gas registry — every entry produces a valid public badge', () => {
    for (const [id, p] of Object.entries(gasRaw.pipelines)) {
      const badge = derivePipelinePublicBadge(p.evidence);
      assert.ok(VALID_BADGES.has(badge), `gas ${id}: badge=${badge}`);
    }
  });

  test('oil registry — every entry produces a valid public badge', () => {
    for (const [id, p] of Object.entries(oilRaw.pipelines)) {
      const badge = derivePipelinePublicBadge(p.evidence);
      assert.ok(VALID_BADGES.has(badge), `oil ${id}: badge=${badge}`);
    }
  });

  test('raw bootstrap entry never has a pre-computed publicBadge (it is derived)', () => {
    for (const p of Object.values(gasRaw.pipelines)) {
      assert.equal(p.publicBadge, undefined, `gas ${p.id} should not ship with a pre-computed publicBadge`);
    }
    for (const p of Object.values(oilRaw.pipelines)) {
      assert.equal(p.publicBadge, undefined, `oil ${p.id} should not ship with a pre-computed publicBadge`);
    }
  });

  test('undefined/null evidence on a raw entry does not crash the deriver', () => {
    // If a future data curator accidentally removes the evidence block,
    // the deriver must return "disputed" instead of throwing — which is
    // what caused the original crash (undefined.charAt(0)).
    assert.equal(derivePipelinePublicBadge(undefined), 'disputed');
    assert.equal(derivePipelinePublicBadge(null), 'disputed');
    assert.equal(derivePipelinePublicBadge({}), 'disputed');
  });

  test('known Nord Stream 1 entry derives "offline" (paperwork + operator + sanction)', () => {
    const ns1 = gasRaw.pipelines['nord-stream-1'];
    assert.ok(ns1, 'nord-stream-1 should exist in curated registry');
    assert.equal(derivePipelinePublicBadge(ns1.evidence, Date.parse('2026-04-22T12:00:00Z')), 'offline');
  });

  test('known Druzhba-South entry derives "disputed" (stale evidence 2026-04 fixture)', () => {
    // Druzhba-South evidence.lastEvidenceUpdate is 2026-04-22 (fresh), with
    // reduced physical state. Badge should be "reduced" when NOW is close
    // to that date.
    const druzhbaS = oilRaw.pipelines['druzhba-south'];
    assert.ok(druzhbaS, 'druzhba-south should exist in curated registry');
    assert.equal(derivePipelinePublicBadge(druzhbaS.evidence, Date.parse('2026-04-22T12:00:00Z')), 'reduced');
    // And demote to disputed if we pretend 60 days have passed with no update.
    assert.equal(derivePipelinePublicBadge(druzhbaS.evidence, Date.parse('2026-06-22T12:00:00Z')), 'disputed');
  });
});
