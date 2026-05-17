// Source-textual tests for U2: buildDigest's stories.push must carry
// track.category through to the envelope.
//
// buildDigest is not exported from scripts/seed-digest-notifications.mjs,
// so these are source-textual assertions (mirrors digest-no-reclassify
// and digest-buildDigest-feelgood-filter). The behavioral contract
// (track.category → envelope category) is exercised end-to-end by
// shared/brief-filter.js tests + tests/brief-from-digest-stories.test.mjs.
//
// What this file locks in:
//   T6 — the stories.push object includes a defensively-typed
//        `category: typeof track.category === 'string' ? track.category : ''`
//        line, matching how `description` is read.
//   T7 — the wiring is INSIDE the stories.push block, NOT inside the
//        isOpinion / isFeelGood filter blocks (which `continue` and
//        never reach the emit site).

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

// Locate buildDigest's body — from its declaration to the next
// top-level function declaration.
const buildDigestStart = seedSrc.indexOf('async function buildDigest(rule, windowStartMs)');
const afterBuildDigest = seedSrc.indexOf('\nfunction ', buildDigestStart + 1);
const afterBuildDigestAsync = seedSrc.indexOf('\nasync function ', buildDigestStart + 1);
const buildDigestEnd = Math.min(
  afterBuildDigest === -1 ? Number.POSITIVE_INFINITY : afterBuildDigest,
  afterBuildDigestAsync === -1 ? Number.POSITIVE_INFINITY : afterBuildDigestAsync,
);
const buildDigestBody = seedSrc.slice(buildDigestStart, buildDigestEnd);

describe('U2: buildDigest carries track.category through to the envelope', () => {
  it('T6: stories.push includes defensively-typed category passthrough', () => {
    // Must match the shape of how `description` is read at the same site:
    //   `category: typeof track.category === 'string' ? track.category : ''`
    assert.ok(
      /category:\s*typeof\s+track\.category\s*===\s*'string'\s*\?\s*track\.category\s*:\s*''/.test(buildDigestBody),
      'stories.push must read track.category defensively (mirror of description shape)',
    );
  });

  it('T7: the passthrough is in stories.push, not in the isOpinion/isFeelGood filter blocks', () => {
    // Find the stories.push site. The category passthrough must appear
    // inside the object literal (between `stories.push({` and the
    // matching `});`).
    const storiesPushIdx = buildDigestBody.indexOf('stories.push({');
    assert.ok(storiesPushIdx !== -1, 'stories.push site must exist in buildDigest');
    // Find the matching `});` — pragmatic: search forward for the next
    // `});` (the object literal here is shallow, no nested object).
    const closeIdx = buildDigestBody.indexOf('});', storiesPushIdx);
    assert.ok(closeIdx !== -1, 'stories.push must have a closing `});`');
    const pushBlock = buildDigestBody.slice(storiesPushIdx, closeIdx);
    assert.ok(
      pushBlock.includes('category: typeof track.category'),
      'category passthrough must live inside the stories.push object literal',
    );

    // Negative-space: the opinion / feel-good filter blocks `continue`
    // and never reach the emit site, so the category passthrough must
    // NOT appear before the matchesSensitivity check (which gates the
    // stories.push site).
    const matchesSensitivityIdx = buildDigestBody.indexOf('matchesSensitivity(');
    assert.ok(matchesSensitivityIdx !== -1, 'matchesSensitivity gate must exist before stories.push');
    const beforeSensitivity = buildDigestBody.slice(0, matchesSensitivityIdx);
    assert.ok(
      !/category:\s*typeof\s+track\.category/.test(beforeSensitivity),
      'category passthrough must not appear before the matchesSensitivity gate (i.e., not inside the filter blocks)',
    );
  });
});
