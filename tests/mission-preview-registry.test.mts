/**
 * Mission preview registry (plan 2026-08-30-001, U5 / KTD3, R6, R15).
 *
 * The registry is the rollback switch: one entry per treated mission, keyed
 * by preset id, naming the single panel that hosts its Pro preview. Contract:
 *  1. Every registry entry targets a real panel key in the FULL catalog and a
 *     real mission preset id — key drift fails here, not silently in prod.
 *  2. One preview per treated mission (R8's one-invitation rule).
 *  3. crisis-desk has NO entry (KTD7 — its ResilienceWidget preview already
 *     ships; Release 1 adds instrumentation only).
 *  4. The untouched comparison missions and Country Watcher have NO entries
 *     (their absence is what makes the before/after read clean; Country
 *     Watcher's conversion moment is the follow cap, not a preview).
 *  5. Removing an entry removes exactly that mission's preview (R15) — pinned
 *     structurally by resolveMissionPreview returning null for missing keys.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const panels = await import('../src/config/panels.ts');
const presets = await import('../src/services/mission-presets.ts');
const registry = await import('../src/services/mission-preview-registry.ts');

const ENTRIES = Object.entries(registry.MISSION_PREVIEW_REGISTRY);

describe('mission preview registry', () => {
  it('targets only real panel keys and real mission ids', () => {
    const presetIds = new Set(presets.MISSION_PRESETS.map((p) => p.id));
    for (const [missionId, spec] of ENTRIES) {
      assert.ok(presetIds.has(missionId as never), `unknown mission id '${missionId}'`);
      assert.ok(
        Object.prototype.hasOwnProperty.call(panels.ALL_PANELS, spec.panelKey),
        `mission '${missionId}' targets unknown panel '${spec.panelKey}'`,
      );
    }
  });

  it('covers exactly the four component-preview missions from the plan', () => {
    assert.deepEqual(
      Object.keys(registry.MISSION_PREVIEW_REGISTRY).sort(),
      ['energy-security', 'macro-market-watch', 'osint-newsroom', 'supply-chain-risk'],
    );
  });

  it('maps each mission to the panel holding its gated depth', () => {
    const r = registry.MISSION_PREVIEW_REGISTRY;
    assert.equal(r['supply-chain-risk']?.panelKey, 'supply-chain');
    assert.equal(r['energy-security']?.panelKey, 'pipeline-status');
    assert.equal(r['osint-newsroom']?.panelKey, 'gdelt-intel');
    assert.equal(r['macro-market-watch']?.panelKey, 'macro-signals');
  });

  it('keeps crisis-desk, the untouched comparisons, and country-watcher preview-free', () => {
    for (const id of ['crisis-desk', 'tech-ai-watch', 'good-news-explorer', 'country-watcher', 'nq-day-trader']) {
      assert.equal(
        (registry.MISSION_PREVIEW_REGISTRY as Record<string, unknown>)[id],
        undefined,
        `'${id}' must not carry a component preview`,
      );
    }
  });

  it('resolves a preview only for the active mission + its target panel', () => {
    assert.equal(
      registry.resolveMissionPreview('supply-chain-risk', 'supply-chain')?.previewId,
      'supply-chain-depth',
    );
    assert.equal(registry.resolveMissionPreview('supply-chain-risk', 'cascade'), null);
    assert.equal(registry.resolveMissionPreview('tech-ai-watch', 'supply-chain'), null);
    assert.equal(registry.resolveMissionPreview(null, 'supply-chain'), null);
  });

  it('every entry carries the fields the preview component needs', () => {
    for (const [missionId, spec] of ENTRIES) {
      assert.ok(spec.previewId.length > 0, `${missionId}: empty previewId`);
      assert.ok(spec.unlockCopy.length > 10, `${missionId}: unlock copy missing`);
      assert.equal(typeof spec.renderSample, 'function', `${missionId}: renderSample missing`);
    }
  });
});
