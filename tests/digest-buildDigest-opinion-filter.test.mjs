// Source-level regression guard for the digest read-path opinion exclusion.
//
// A classifier rule can be tightened while a story:track row with
// isOpinion="0" is still inside the accumulator window. Re-checking the
// cheap shared classifier on read keeps that in-flight residue out of the
// very next brief instead of waiting for a later feed poll to overwrite the
// stamp.

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

describe('buildDigest opinion filter — current classifier rule changes', () => {
  it('re-checks classifyOpinion even when Redis has an explicit non-opinion stamp', () => {
    assert.match(
      buildDigestBody,
      /stampedOpinion\s*\|\|\s*classifyOpinion\(\{[\s\S]*?title:\s*track\.title/,
      'must calculate the current shared classifier verdict for every non-opinion row',
    );
  });
});
