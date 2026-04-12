import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { INDICATOR_REGISTRY } from '../server/worldmonitor/resilience/v1/_indicator-registry.ts';

const CORE_MIN_COVERAGE = 180;

describe('signal tiering registry (Phase 2 T2.2a)', () => {
  it('every indicator has tier, coverage, license populated', () => {
    for (const entry of INDICATOR_REGISTRY) {
      assert.ok(
        entry.tier === 'core' || entry.tier === 'enrichment' || entry.tier === 'experimental',
        `${entry.id} missing or invalid tier`,
      );
      assert.ok(
        Number.isFinite(entry.coverage) && entry.coverage > 0,
        `${entry.id} missing or non-positive coverage`,
      );
      assert.ok(
        typeof entry.license === 'string' && entry.license.length > 0,
        `${entry.id} missing license`,
      );
    }
  });

  it('Core indicators have coverage >= 180 countries (Phase 2 A4 invariant)', () => {
    const offending = INDICATOR_REGISTRY
      .filter((e) => e.tier === 'core' && e.coverage < CORE_MIN_COVERAGE)
      .map((e) => `${e.id} (${e.coverage} countries, dimension=${e.dimension})`);
    assert.deepEqual(
      offending,
      [],
      `Core indicators must cover at least ${CORE_MIN_COVERAGE} countries. Demote to Enrichment or fix coverage: ${offending.join(', ')}`,
    );
  });

  it('Core indicators use a license compatible with commercial use', () => {
    const commercialOk = new Set(['public-domain', 'open-data', 'open-attribution']);
    const offending = INDICATOR_REGISTRY
      .filter((e) => e.tier === 'core' && !commercialOk.has(e.license))
      .map((e) => `${e.id} (license=${e.license})`);
    // Known exceptions the plan allows: GPI (IEP non-commercial, already
    // demoted to Enrichment) and UCDP (research-only, kept Core because it
    // is the canonical global conflict event source). These stay on the
    // allowlist until the Phase 2 A9 Licensing & Legal Review workstream
    // resolves carve-outs.
    const KNOWN_EXCEPTIONS = new Set<string>([
      // UCDP global conflict events: research-only license, kept Core per
      // parent plan section "Signal tiering". Tracked in Phase 2 A9.
      'ucdpConflict',
      // UCDP reused in recovery-capacity stateContinuity dimension.
      'recoveryConflictPressure',
    ]);
    const unexcused = offending.filter((s) => {
      const id = s.split(' ')[0];
      return !KNOWN_EXCEPTIONS.has(id);
    });
    assert.deepEqual(
      unexcused,
      [],
      `Core indicators with incompatible licenses must be demoted or added to KNOWN_EXCEPTIONS: ${unexcused.join(', ')}`,
    );
  });

  it('informationCognitive dimension indicators are Core (promoted in T2.9 after language normalization)', () => {
    const infoCogIndicators = INDICATOR_REGISTRY.filter((e) => e.dimension === 'informationCognitive');
    assert.ok(infoCogIndicators.length > 0, 'expected informationCognitive indicators in registry');
    for (const e of infoCogIndicators) {
      assert.equal(
        e.tier,
        'core',
        `${e.id}: informationCognitive indicators must be 'core' now that T2.9 language normalization has landed.`,
      );
    }
  });

  it('reports unknown-license count for the licensing audit workstream', () => {
    const unknown = INDICATOR_REGISTRY.filter((e) => e.license === 'unknown');
    // This is a visibility report, not a failure. Phase 2 A9 (Licensing &
    // Legal Review) chases these.
    if (unknown.length > 0) {
      console.warn(
        `[T2.2a] ${unknown.length} indicators have license='unknown': ${unknown.map((e) => e.id).join(', ')}`,
      );
    }
    assert.ok(unknown.length < INDICATOR_REGISTRY.length, 'every indicator has unknown license');
  });
});
