// Source-textual guard for buildDigest's ephemeral live-coverage filter.
//
// buildDigest is not exported from scripts/seed-digest-notifications.mjs.
// The pure classifier behavior is covered in
// tests/ephemeral-live-classifier.test.mjs; this file locks the digest
// read-path wiring that keeps pre-stamp Redis residue out of delayed briefs.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const seedSrc = readFileSync(
  resolve(__dirname, '..', 'scripts', 'seed-digest-notifications.mjs'),
  'utf-8',
);

const buildDigestStart = seedSrc.indexOf('async function buildDigest(rule, windowStartMs)');
const afterBuildDigest = seedSrc.indexOf('\nfunction ', buildDigestStart + 1);
const afterBuildDigestAsync = seedSrc.indexOf('\nasync function ', buildDigestStart + 1);
const buildDigestEnd = Math.min(
  afterBuildDigest === -1 ? Number.POSITIVE_INFINITY : afterBuildDigest,
  afterBuildDigestAsync === -1 ? Number.POSITIVE_INFINITY : afterBuildDigestAsync,
);
const buildDigestBody = seedSrc.slice(buildDigestStart, buildDigestEnd);

describe('buildDigest ephemeral-live filter wiring', () => {
  it('imports classifyEphemeralLiveCoverage from the shared classifier', () => {
    assert.ok(
      seedSrc.includes("import { classifyEphemeralLiveCoverage } from '../shared/ephemeral-live-classifier.js'"),
      'must import the same classifier used by ingest and compose',
    );
  });

  it('declares and logs the droppedEphemeralLive counter', () => {
    assert.ok(buildDigestBody.includes('let droppedEphemeralLive = 0;'));
    assert.ok(buildDigestBody.includes('const droppedEphemeralLiveTitleSamples = [];'));
    assert.ok(buildDigestBody.includes('compactDroppedEphemeralLiveTitle(track.title)'));
    assert.ok(seedSrc.includes('[digest] buildDigest ephemeral-live filter dropped '));
    assert.ok(seedSrc.includes('live-programming teaser(s) from the pool'));
    assert.ok(seedSrc.includes('sample_titles=${JSON.stringify(droppedEphemeralLiveTitleSamples)}'));
  });

  it('trusts the ingest stamp and re-classifies stamp-missing residue rows', () => {
    assert.ok(
      buildDigestBody.includes("track.isEphemeralLiveCoverage === '1'"),
      'must trust ingest-time isEphemeralLiveCoverage=1',
    );
    assert.ok(
      /typeof\s+track\.isEphemeralLiveCoverage\s*!==\s*'string'\s*\|\|\s*track\.isEphemeralLiveCoverage\.length\s*===\s*0/.test(buildDigestBody),
      'missing/non-string stamp must be residue-eligible',
    );
    assert.ok(
      /classifyEphemeralLiveCoverage\(\{[\s\S]*?title:\s*track\.title/.test(buildDigestBody),
      'must re-classify residue using the persisted title',
    );
    assert.ok(
      /classifyEphemeralLiveCoverage\(\{[\s\S]*?link:\s*track\.link\s*\?\?\s*''/.test(buildDigestBody),
      'must pass track.link ?? "" to the residue classifier',
    );
    assert.ok(
      /classifyEphemeralLiveCoverage\(\{[\s\S]*?description:\s*typeof\s+track\.description\s*===\s*'string'\s*\?\s*track\.description\s*:\s*''/.test(buildDigestBody),
      'must defensively pass track.description as string',
    );
  });

  it('runs before phase/sensitivity filtering so live teasers never enter the digest pool', () => {
    const ephemeralIdx = buildDigestBody.indexOf('classifyEphemeralLiveCoverage(');
    const derivePhaseIdx = buildDigestBody.indexOf('derivePhase(');
    const matchesSensitivityIdx = buildDigestBody.indexOf('matchesSensitivity(');
    assert.ok(ephemeralIdx !== -1, 'classifier call must exist');
    assert.ok(ephemeralIdx < derivePhaseIdx, 'ephemeral filter precedes derivePhase');
    assert.ok(ephemeralIdx < matchesSensitivityIdx, 'ephemeral filter precedes matchesSensitivity');
  });
});
