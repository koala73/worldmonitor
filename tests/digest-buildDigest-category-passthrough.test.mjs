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
    // by scanning forward from `stories.push({` and matching braces at
    // the same depth to find the literal's closing `});`. Earlier this
    // test used `indexOf('});')` which would silently truncate the
    // search slice if a future change introduced a nested object literal
    // ending in `});` inside stories.push (e.g. a `.map()` callback) —
    // Greptile P2 review of PR #3751. Brace-depth tracking is robust to
    // that without locking the test to the current flat-literal shape.
    const storiesPushIdx = buildDigestBody.indexOf('stories.push({');
    assert.ok(storiesPushIdx !== -1, 'stories.push site must exist in buildDigest');
    let depth = 1; // we start AFTER the opening `{` of `stories.push({`
    let closeIdx = -1;
    const scanStart = storiesPushIdx + 'stories.push({'.length;
    for (let i = scanStart; i < buildDigestBody.length; i += 1) {
      const ch = buildDigestBody[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          // Expect the matching `}` to be followed by `);` (the
          // function-call close). Confirm before recording the slice end.
          if (buildDigestBody.slice(i, i + 3) === '});') {
            closeIdx = i + 3;
          }
          break;
        }
      }
    }
    assert.ok(closeIdx !== -1, 'stories.push must have a matched `});` at the same brace depth');
    const pushBlock = buildDigestBody.slice(storiesPushIdx, closeIdx);

    // Full-pattern assertion (not just substring containment): lock the
    // exact defensive-typeof shape so a coercion or different defensive
    // pattern would fail this test rather than passing on partial match.
    assert.match(
      pushBlock,
      /category:\s*typeof\s+track\.category\s*===\s*'string'\s*\?\s*track\.category\s*:\s*''/,
      'category passthrough must live inside the stories.push object literal with the exact defensive-typeof shape',
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
