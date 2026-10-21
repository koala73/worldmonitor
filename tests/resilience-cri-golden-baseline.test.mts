import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import goldenArtifact from './fixtures/resilience-cri-golden-baseline-2026-08-13.json' with { type: 'json' };
import {
  FROZEN_CLOCK_ISO,
  GOLDEN_ENV_FLAGS,
  INPUT_FIXTURE_RELATIVE_PATH,
  applyGoldenEnvFlags,
  computeFrozenCriBytes,
  createBaselineReader,
  installFrozenClock,
  restoreEnvFlags,
  restoreRealClock,
  sha256File,
} from '../scripts/generate-cri-golden-baseline.mts';
import {
  RESILIENCE_HISTORY_KEY_PREFIX,
  RESILIENCE_SCORE_CACHE_PREFIX,
  getCurrentCacheFormula,
} from '../server/worldmonitor/resilience/v1/_shared.ts';
import wholeIndexFixture from './fixtures/resilience-whole-index-pairs-2026-08-13.json' with { type: 'json' };

// This is the NON-REGRESSION half of the CRI proof (issue #7728). The
// five-factor isolation test compares before/after with the same live scorer,
// so a shared-scorer defect moves both sides together and passes. Here the
// expected bytes come from the committed golden artifact instead: any change to
// the live CRI scorer output (scores, ranking, dimension payloads) fails until
// the baseline is intentionally regenerated with `npm run
// freeze:resilience-cri-golden`. Full rationale and the regeneration flows
// (including the in-PR --allow-non-main path):
// docs/methodology/country-resilience-index/golden-baseline.md
//
// The frozen input (fixture + synthetic tech-readiness override), the frozen
// clock, the pinned env flags, the stable country order, and the serialization
// are all defined in scripts/generate-cri-golden-baseline.mts — the same module
// that generated the artifact — so the generator and this test cannot drift.

const REGENERATION_HINT =
  'if this is an intentional CRI methodology change, regenerate with ' +
  'npm run freeze:resilience-cri-golden — from an up-to-date accepted main checkout, ' +
  'or on the branch making the change with --allow-non-main';

const artifact = goldenArtifact as typeof goldenArtifact & {
  schemaVersion: number;
  artifactKind: string;
  acceptedSourceCommit: string;
  formula: string;
  scorerCacheIdentity: { scoreCachePrefix: string; historyKeyPrefix: string };
  frozenClockIso: string;
  envFlags: Record<string, string>;
  inputFixture: { path: string; capturedAt: string; sha256: string };
  golden: { countryScores: string; ranking: string };
};

const fixture = wholeIndexFixture as typeof wholeIndexFixture & {
  __fixture: { countries: string[] };
};
const TESTS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.resolve(TESTS_ROOT, '..');

let previousFlags: Record<string, string | undefined> = {};

before(() => {
  previousFlags = applyGoldenEnvFlags();
  installFrozenClock();
});

after(() => {
  restoreRealClock();
  restoreEnvFlags(previousFlags);
});

describe('CRI golden baseline non-regression (#7728)', () => {
  it('matches the committed golden country-score and ranking bytes byte-for-byte', async () => {
    assert.ok(
      fixture.__fixture.countries.length >= 10,
      'the frozen cohort must cover an approximately ten-country hand-check scale; an empty or truncated cohort would make vacuous golden bytes',
    );
    const live = await computeFrozenCriBytes(
      createBaselineReader(),
      fixture.__fixture.countries,
    );
    assert.equal(
      live.countryScores,
      artifact.golden.countryScores,
      `live CRI country scores drifted from the committed golden baseline; ${REGENERATION_HINT}`,
    );
    assert.equal(
      live.ranking,
      artifact.golden.ranking,
      `live CRI ranking drifted from the committed golden baseline; ${REGENERATION_HINT}`,
    );
  });

  it('keeps the golden artifact pinned to the input fixture it was generated from', async () => {
    assert.equal(artifact.artifactKind, 'cri-golden-baseline');
    assert.match(artifact.acceptedSourceCommit, /^[0-9a-f]{40}$/, 'the artifact must record a full 40-hex source commit');
    const fixtureSha256 = await sha256File(path.join(REPO_ROOT, INPUT_FIXTURE_RELATIVE_PATH));
    assert.equal(
      artifact.inputFixture.path,
      INPUT_FIXTURE_RELATIVE_PATH,
      'the artifact must reference the committed frozen input fixture',
    );
    assert.equal(
      artifact.inputFixture.capturedAt,
      fixture.__fixture.capturedAt,
      'the artifact must reference the frozen input fixture capture date',
    );
    assert.equal(
      artifact.inputFixture.sha256,
      fixtureSha256,
      `the frozen input fixture changed without regenerating the golden baseline; ${REGENERATION_HINT}`,
    );
  });

  it('flags a CRI cache-identity change as a required baseline regeneration', () => {
    assert.equal(
      artifact.formula,
      getCurrentCacheFormula(),
      `the CRI formula tag changed; ${REGENERATION_HINT}`,
    );
    assert.equal(
      artifact.scorerCacheIdentity.scoreCachePrefix,
      RESILIENCE_SCORE_CACHE_PREFIX,
      `the CRI score cache prefix changed; ${REGENERATION_HINT}`,
    );
    assert.equal(
      artifact.scorerCacheIdentity.historyKeyPrefix,
      RESILIENCE_HISTORY_KEY_PREFIX,
      `the CRI history key prefix changed; ${REGENERATION_HINT}`,
    );
    assert.equal(
      artifact.frozenClockIso,
      FROZEN_CLOCK_ISO,
      `the frozen clock constant changed without regenerating the golden baseline; ${REGENERATION_HINT}`,
    );
    assert.deepEqual(
      artifact.envFlags,
      GOLDEN_ENV_FLAGS,
      `the pinned env flags changed without regenerating the golden baseline; ${REGENERATION_HINT}`,
    );
  });
});
