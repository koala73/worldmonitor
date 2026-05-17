// Unit tests for the buildDigest feel-good filter (U3).
//
// buildDigest is not exported from scripts/seed-digest-notifications.mjs,
// so these tests are source-textual (mirroring digest-no-reclassify.test.mjs):
// they assert the structural invariants of the wiring rather than
// invoking buildDigest with live Redis fixtures. The classifier's
// behavior is fully covered by tests/feelgood-classifier.test.mjs.
//
// What this file locks in:
//   - U3 imports classifyFeelGood
//   - U3 declares the droppedFeelGood counter inside buildDigest
//   - The feel-good filter block runs AFTER the opinion filter (so a
//     row matched by BOTH is dropped by opinion first — the M6
//     asymmetry the implementation comment documents)
//   - The filter trusts the ingest stamp (isFeelGood === '1') AND
//     re-classifies stamp-missing residue rows (mirrors opinion)
//   - The conditional log line shape matches opinion's byte-for-byte
//     (variant/lang/sensitivity suffix, NO invented stamped/residue
//     breakdown per FEAS-001)
//   - The per-attempt `[digest] brief filter drops` log does NOT carry
//     dropped_feelgood= (T21 — negative-space; matches what
//     droppedOpinion already does)
//   - M6 asymmetry comment is documented in the source

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

// Locate the buildDigest function body — everything from its declaration
// to the next top-level `function`/`async function` declaration.
const buildDigestStart = seedSrc.indexOf('async function buildDigest(rule, windowStartMs)');
const afterBuildDigest = seedSrc.indexOf('\nfunction ', buildDigestStart + 1);
const afterBuildDigestAsync = seedSrc.indexOf('\nasync function ', buildDigestStart + 1);
const buildDigestEnd = Math.min(
  afterBuildDigest === -1 ? Number.POSITIVE_INFINITY : afterBuildDigest,
  afterBuildDigestAsync === -1 ? Number.POSITIVE_INFINITY : afterBuildDigestAsync,
);
const buildDigestBody = seedSrc.slice(buildDigestStart, buildDigestEnd);

describe('U3: buildDigest imports the feel-good classifier', () => {
  it('imports classifyFeelGood from server/_shared', () => {
    assert.ok(
      seedSrc.includes("import { classifyFeelGood } from '../server/_shared/feelgood-classifier.js'"),
      'must import classifyFeelGood as sibling to classifyOpinion',
    );
  });
});

describe('U3: buildDigest declares the droppedFeelGood counter', () => {
  it('declares `let droppedFeelGood = 0;` in buildDigest scope', () => {
    assert.ok(
      buildDigestBody.includes('let droppedFeelGood = 0;'),
      'must declare the counter sibling to droppedOpinion',
    );
  });
});

describe('U3: feel-good filter block trusts stamp + re-classifies residue', () => {
  it('reads track.isFeelGood stamp ("1" trusts the ingest verdict)', () => {
    assert.ok(
      buildDigestBody.includes("track.isFeelGood === '1'"),
      'must trust the ingest-time isFeelGood stamp when present',
    );
  });

  it('treats missing/non-string isFeelGood as residue-eligible', () => {
    assert.ok(
      /typeof\s+track\.isFeelGood\s*!==\s*'string'\s*\|\|\s*track\.isFeelGood\.length\s*===\s*0/.test(buildDigestBody),
      'residue rows (no stamp field) must fall through to re-classification',
    );
  });

  it('re-classifies stamp-missing residue from persisted title/link/description', () => {
    // Mirror the opinion-block shape: stampedFeelGood ||
    // (feelGoodStampMissing && classifyFeelGood({ title, link, description })).
    assert.ok(
      /classifyFeelGood\(\{[^}]*title:\s*track\.title/.test(buildDigestBody),
      'must call classifyFeelGood with track.title for residue re-classification',
    );
    assert.ok(
      /classifyFeelGood\(\{[\s\S]*?link:\s*track\.link\s*\?\?\s*''/.test(buildDigestBody),
      'must pass track.link ?? "" to classifyFeelGood',
    );
    assert.ok(
      /classifyFeelGood\(\{[\s\S]*?description:\s*typeof\s+track\.description\s*===\s*'string'\s*\?\s*track\.description\s*:\s*''/.test(buildDigestBody),
      'must defensively pass track.description as string',
    );
  });

  it('increments droppedFeelGood and `continue`s on match', () => {
    // The block must end with `droppedFeelGood++; continue;` so the
    // counter advances and the row is excluded from the pool.
    assert.ok(
      /droppedFeelGood\+\+;[\s\S]{0,80}continue;/.test(buildDigestBody),
      'must increment counter and continue the loop on match',
    );
  });
});

describe('U3: feel-good filter runs AFTER opinion filter (M6 asymmetry)', () => {
  it('classifyFeelGood call appears after classifyOpinion call in buildDigest', () => {
    const opinionIdx = buildDigestBody.indexOf('classifyOpinion(');
    const feelGoodIdx = buildDigestBody.indexOf('classifyFeelGood(');
    assert.ok(opinionIdx !== -1, 'classifyOpinion call must exist in buildDigest');
    assert.ok(feelGoodIdx !== -1, 'classifyFeelGood call must exist in buildDigest');
    assert.ok(
      feelGoodIdx > opinionIdx,
      'feel-good filter must run AFTER opinion (a row matched by BOTH increments only droppedOpinion — the M6 asymmetry)',
    );
  });

  it('feel-good filter runs BEFORE derivePhase / matchesSensitivity', () => {
    const feelGoodIdx = buildDigestBody.indexOf('classifyFeelGood(');
    const derivePhaseIdx = buildDigestBody.indexOf('derivePhase(');
    const matchesSensitivityIdx = buildDigestBody.indexOf('matchesSensitivity(');
    assert.ok(feelGoodIdx < derivePhaseIdx, 'feel-good filter precedes derivePhase');
    assert.ok(feelGoodIdx < matchesSensitivityIdx, 'feel-good filter precedes matchesSensitivity');
  });

  it('documents the M6 opinion+feel-good counter asymmetry in source comment', () => {
    // The comment helps future engineers reading droppedFeelGood
    // understand it is bounded by what opinion already dropped.
    assert.ok(
      /M6.*asymmetry|asymmetry.*M6|opinion\+feel-good/.test(buildDigestBody),
      'must document the M6 / adv-005 asymmetry in an inline comment',
    );
  });
});

describe('U3: conditional log line mirrors opinion shape exactly (FEAS-001)', () => {
  it('emits a separate conditional log when droppedFeelGood > 0', () => {
    assert.ok(
      /if\s*\(\s*droppedFeelGood\s*>\s*0\s*\)/.test(seedSrc),
      'must gate the log on droppedFeelGood > 0 (silent when zero, same as droppedOpinion)',
    );
  });

  it('log shape is "[digest] buildDigest feel-good filter dropped N feel-good/lifestyle item(s) from the pool (variant=… lang=… sensitivity=…)"', () => {
    assert.ok(
      seedSrc.includes('[digest] buildDigest feel-good filter dropped '),
      'log prefix must be sibling to the opinion log prefix',
    );
    assert.ok(
      seedSrc.includes('feel-good/lifestyle item(s) from the pool'),
      'content-type suffix must match opinion shape (no invented stamped/residue parenthetical per FEAS-001)',
    );
    assert.ok(
      /variant=\$\{rule\.variant\s*\?\?\s*'full'\}/.test(seedSrc),
      'variant= field must mirror opinion log',
    );
    assert.ok(
      /lang=\$\{rule\.lang\s*\?\?\s*'en'\}/.test(seedSrc),
      'lang= field must mirror opinion log',
    );
    assert.ok(
      /sensitivity=\$\{rule\.sensitivity\s*\?\?\s*'high'\}/.test(seedSrc),
      'sensitivity= field must mirror opinion log',
    );
  });

  it('does NOT add a `stamped=A, residue=B` breakdown (FEAS-001 — opinion mirror has none)', () => {
    // The U3 Goal originally promised a `(stamped=A, residue=B)`
    // parenthetical that the opinion mirror does not emit. FEAS-001
    // caught this; the implementation must mirror opinion exactly.
    assert.ok(
      !/feel-good filter dropped[^"`'\n]*stamped=/.test(seedSrc),
      'must NOT invent a stamped= breakdown the opinion log does not carry',
    );
    assert.ok(
      !/feel-good filter dropped[^"`'\n]*residue=/.test(seedSrc),
      'must NOT invent a residue= breakdown the opinion log does not carry',
    );
  });
});

describe('U3: per-attempt brief-filter-drops log line is unchanged (T21 negative-space)', () => {
  it('per-attempt log does NOT carry dropped_feelgood= field', () => {
    // The per-attempt `[digest] brief filter drops` log line lives in
    // composeAndStoreBriefForUser, NOT in buildDigest. droppedOpinion
    // is not on that line; droppedFeelGood must not be either.
    // (Mirrors the C1 / KTD decision baked into the plan.)
    const briefFilterDropsIdx = seedSrc.indexOf('[digest] brief filter drops');
    assert.ok(
      briefFilterDropsIdx !== -1,
      'per-attempt brief-filter-drops log line must still exist',
    );
    // Find the end of the line (~next blank line or 2KB ahead, whichever first)
    const slice = seedSrc.slice(briefFilterDropsIdx, briefFilterDropsIdx + 2000);
    assert.ok(
      !slice.includes('dropped_feelgood='),
      'per-attempt log must NOT carry dropped_feelgood= (mirrors what droppedOpinion does NOT do; see C1)',
    );
    assert.ok(
      !slice.includes('dropped_opinion='),
      'sanity: per-attempt log does NOT carry dropped_opinion= either (the precedent the feel-good log mirrors)',
    );
  });
});

describe('U3: integration with classifyFeelGood', () => {
  it('residue-path call uses defensive type-checking on track.description', () => {
    // typeof track.description === 'string' ? track.description : ''
    // guards against malformed redis rows where description is missing
    // or a non-string. Mirrors the opinion block's same guard.
    const slice = buildDigestBody.slice(buildDigestBody.indexOf('classifyFeelGood('));
    assert.ok(
      /typeof\s+track\.description\s*===\s*'string'/.test(slice.slice(0, 400)),
      'must defensively check track.description type before passing to classifyFeelGood',
    );
  });
});
