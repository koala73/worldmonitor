/**
 * The category explainer's answer-first contract (#6217).
 *
 * The contract shipped inside tests/blog-seo-contract.test.mjs, which only runs
 * in the `unit` job. That job is gated on `changes.code == 'true'`, and the
 * changes filter drops every `.md` path — so the guard protecting a markdown
 * page did not run on markdown-only PRs, the exact change class that edits it
 * by hand. The `docs-stats` job is always-on for this reason (its own comment
 * says so), which is where the contract now lives.
 *
 * Every failure branch below is DRIVEN with a synthetic reader rather than
 * asserted about, so "the gate would have caught it" is executed. Each mutation
 * changes one thing and expects exactly one failure, so a validator that fires
 * for the wrong reason cannot masquerade as coverage.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeStats,
  validateCategoryExplainerCopy,
  CATEGORY_EXPLAINER_PATH,
  DOC_VALIDATORS,
} from '../scripts/docs-stats.mjs';

const ROOT = new URL('../', import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const REAL_STATS = computeStats();

/** Reader that applies one edit to the explainer and passes everything else through. */
const withCopy = (edit: (source: string) => string) => (p: string) =>
  p === CATEGORY_EXPLAINER_PATH ? edit(read(p)) : read(p);

describe('category explainer contract', () => {
  it('passes on the real repo', () => {
    assert.deepEqual(validateCategoryExplainerCopy(REAL_STATS, read), []);
  });

  it('reports a missing file rather than passing it over', () => {
    const failures = validateCategoryExplainerCopy(REAL_STATS, () => {
      throw new Error('ENOENT');
    });
    assert.deepEqual(failures, [`${CATEGORY_EXPLAINER_PATH}: file not found`]);
  });

  it('reports missing frontmatter rather than treating the page as body', () => {
    const failures = validateCategoryExplainerCopy(
      REAL_STATS,
      withCopy((s) => s.replace(/^---\n[\s\S]*?\n---\n/, '')),
    );
    assert.deepEqual(failures, [`${CATEGORY_EXPLAINER_PATH}: missing frontmatter`]);
  });
});

describe('answer-first opening', () => {
  it('fires when the narrative lede returns ahead of the definition', () => {
    const failures = validateCategoryExplainerCopy(
      REAL_STATS,
      withCopy((s) => s.replace('World Monitor is a **free, open-source', 'Imagine 100 tabs. World Monitor is a **free, open-source')),
    );
    assert.equal(failures.length, 1, failures.join('\n'));
    assert.match(failures[0], /must open with the self-contained/);
  });

  it('fires when the opening decays to a one-liner', () => {
    const failures = validateCategoryExplainerCopy(
      REAL_STATS,
      withCopy((s) => {
        const body = s.slice(s.match(/^---\n[\s\S]*?\n---\n/)![0].length);
        const opening = body.slice(0, body.indexOf('\n## '));
        return s.replace(opening, 'World Monitor is a **free, open-source, real-time global intelligence dashboard**.');
      }),
    );
    assert.equal(failures.length, 1, failures.join('\n'));
    assert.match(failures[0], /answer-first opening is \d+ words, expected 35-80/);
  });

  it('fires loudly when there is no H2 instead of silently reading the whole page', () => {
    // An indexOf(-1) slice would make the entire page the "opening" — the
    // shape check would then fail for an unrelated-looking reason.
    const failures = validateCategoryExplainerCopy(
      REAL_STATS,
      withCopy((s) => s.replaceAll('\n## ', '\n### ')),
    );
    assert.ok(failures.some((f) => /no H2 section/.test(f)), failures.join('\n'));
  });
});

describe('dashboard variants', () => {
  it('fires when a variant ships and the spelled-out count goes stale', () => {
    // The regression this gate exists for: the count was pinned as the literal
    // word "Six", so this exact mutation left the contract green.
    const failures = validateCategoryExplainerCopy({ ...REAL_STATS, variantCount: 7 }, read);
    assert.equal(failures.length, 2, failures.join('\n'));
    assert.ok(failures.some((f) => /must say "seven dashboard variants"/.test(f)), failures.join('\n'));
    assert.ok(failures.some((f) => /enumerates 6 dashboard variants, code has 7/.test(f)), failures.join('\n'));
  });

  it('fires when the enumeration loses a variant but keeps the count word', () => {
    const failures = validateCategoryExplainerCopy(
      REAL_STATS,
      withCopy((s) => s.replace('World, Tech, Finance, Commodity, Happy, and Energy Monitor', 'World, Tech, Finance, Commodity, and Happy')),
    );
    assert.equal(failures.length, 1, failures.join('\n'));
    assert.match(failures[0], /enumerates 5 dashboard variants, code has 6/);
  });

  it('fires when the enumeration is dropped entirely', () => {
    const failures = validateCategoryExplainerCopy(
      REAL_STATS,
      withCopy((s) => s.replace('dashboard variants**: World, Tech, Finance, Commodity, Happy, and Energy Monitor', 'dashboard variants**')),
    );
    assert.equal(failures.length, 1, failures.join('\n'));
    assert.match(failures[0], /missing the enumerated dashboard-variant list/);
  });

  it('asks for COUNT_WORDS to be extended rather than passing an unspellable count', () => {
    const failures = validateCategoryExplainerCopy({ ...REAL_STATS, variantCount: 99 }, read);
    assert.ok(failures.some((f) => /extend COUNT_WORDS/.test(f)), failures.join('\n'));
  });
});

describe('citation surface', () => {
  it('fires once per required link that is dropped', () => {
    for (const link of [
      'https://www.worldmonitor.app/docs/data-sources',
      'https://www.worldmonitor.app/pricing.md',
      '/blog/glossary/',
    ]) {
      const failures = validateCategoryExplainerCopy(
        REAL_STATS,
        withCopy((s) => s.replaceAll(link, 'https://example.invalid/')),
      );
      assert.equal(failures.length, 1, `${link}: expected exactly one failure, got ${failures.join('\n')}`);
      assert.equal(failures[0], `${CATEGORY_EXPLAINER_PATH}: citation surface must link ${link}`);
    }
  });
});

describe('required claims', () => {
  it('fires when the paid tiers stop being named', () => {
    // replaceAll, not replace: the copy names the tiers twice (the opening
    // definition and the open-source section). Dropping only the first left
    // the gate green and this test passing for the wrong reason.
    const failures = validateCategoryExplainerCopy(
      REAL_STATS,
      withCopy((s) => s.replaceAll('paid Pro, API, and Enterprise plans', 'paid plans')),
    );
    assert.equal(failures.length, 1, failures.join('\n'));
    assert.match(failures[0], /must still name the paid Pro\/API\/Enterprise tiers/);
  });
});

describe('retired claims', () => {
  it('fires once per stale claim reintroduced', () => {
    for (const [snippet, expected] of [
      ['Read more in Five Dashboards, One Platform.', /retired five-variant count/],
      ['There is no "enterprise tier" waiting behind the free version.', /retired "no enterprise tier" claim/],
      ['The stack is React + TypeScript + Vite.', /retired React frontend stack/],
      ['Calculated from baseline risk (40%), unrest indicators (20%).', /retired CII weight breakdown/],
    ] as [string, RegExp][]) {
      const failures = validateCategoryExplainerCopy(
        REAL_STATS,
        withCopy((s) => `${s}\n\n${snippet}\n`),
      );
      assert.equal(failures.length, 1, `${snippet}: expected exactly one failure, got ${failures.join('\n')}`);
      assert.match(failures[0], expected);
    }
  });
});

describe('--check wiring', () => {
  // A validator that is unit-tested but dropped from the CLI leaves the whole
  // suite green while the gate no longer runs. DOC_VALIDATORS is the wiring.
  it('runs the category explainer gate as part of --check', () => {
    assert.ok(DOC_VALIDATORS.includes(validateCategoryExplainerCopy));
  });

  it('exits 0 end to end on the real repo', () => {
    const result = spawnSync('node', ['scripts/docs-stats.mjs', '--check'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  });
});
