/**
 * #6419 step 3: the public tier tables say what the source tables say.
 *
 * The roster links readers to docs/data-sources for what a tier means, so each
 * example outlet in every published tier table must resolve to a publisher
 * family that declares a label at that tier, and the English descriptions must
 * be TIER_MEANING verbatim.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { SOURCE_TIERS, TIER_MEANING, type DeclaredTier } from '../server/_shared/source-tiers.ts';
import { TIER_DOCS_HREF } from '../src/utils/tier-docs.ts';
import { WEB_APP_ORIGIN } from '../src/config/web-origin.ts';
import { publisherFamilyFor } from '../shared/publisher-families.js';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

type TierRow = { tier: DeclaredTier; cells: string[] };

function tierTable(markdown: string, heading: string): TierRow[] {
  const start = markdown.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, `heading ${heading} not found`);
  const rows: TierRow[] = [];
  for (const line of markdown.slice(start + heading.length + 2).split('\n')) {
    if (line.startsWith('#')) break;
    const match = /^\|\s*\*\*Tier (\d)\*\*\s*\|(.*)\|\s*$/.exec(line);
    if (!match) continue;
    rows.push({ tier: Number(match[1]) as DeclaredTier, cells: match[2]!.split('|').map((cell) => cell.trim()) });
  }
  return rows;
}

function declaredTiersOfFamily(example: string): Set<number> {
  const family = publisherFamilyFor(example);
  return new Set(Object.keys(SOURCE_TIERS).filter((label) => publisherFamilyFor(label) === family).map((label) => SOURCE_TIERS[label]!));
}

function assertExamplesResolve(rows: TierRow[], column: number, separator: RegExp, page: string): void {
  assert.deepEqual(rows.map((row) => row.tier), [1, 2, 3, 4], `${page} lists tiers 1 to 4 once each`);
  const wrong: string[] = [];
  for (const row of rows) {
    const examples = row.cells[column]!.split(separator).map((example) => example.trim()).filter(Boolean);
    assert.ok(examples.length > 0, `${page} tier ${row.tier} has no examples`);
    for (const example of examples) {
      const declared = [...declaredTiersOfFamily(example)].sort();
      if (!declared.includes(row.tier)) wrong.push(`${example}: listed tier ${row.tier}, declared [${declared.join(', ')}]`);
    }
  }
  assert.deepEqual(wrong, [], `${page} lists examples whose publisher declares no label at that tier`);
}

const EN_HEADING = '### Source Credibility & Feed Tiering';

describe('published tier tables match the source tables', () => {
  it('docs/data-sources.mdx: descriptions are TIER_MEANING and every example resolves at its tier', () => {
    const rows = tierTable(read('docs/data-sources.mdx'), EN_HEADING);
    assertExamplesResolve(rows, 1, /,/, 'docs/data-sources.mdx');
    for (const row of rows) assert.equal(row.cells[0], TIER_MEANING[row.tier], `tier ${row.tier} description`);
  });

  it('docs/zh/data-sources.mdx lists the same examples', () => {
    const en = tierTable(read('docs/data-sources.mdx'), EN_HEADING);
    const zh = tierTable(read('docs/zh/data-sources.mdx'), '### 来源可信度与源分级');
    assertExamplesResolve(zh, 1, /、/, 'docs/zh/data-sources.mdx');
    assert.deepEqual(
      zh.map((row) => row.cells[1]!.split('、').map((s) => s.trim())),
      en.map((row) => row.cells[1]!.split(',').map((s) => s.trim())),
    );
  });

  it('docs/signal-intelligence.mdx: every example resolves at its tier', () => {
    const rows = tierTable(read('docs/signal-intelligence.mdx'), '### Source Tiers (Authority Ranking)');
    assertExamplesResolve(rows, 0, /,/, 'docs/signal-intelligence.mdx');
  });
});

describe('tier meaning reaches readers intact', () => {
  it('TIER_DOCS_HREF is absolute on the web origin and points at the tier table heading as the docs site slugs it', () => {
    const url = new URL(TIER_DOCS_HREF);
    assert.equal(url.origin, WEB_APP_ORIGIN);
    assert.equal(url.pathname, '/docs/data-sources');
    assert.equal(decodeURIComponent(url.hash.slice(1)), EN_HEADING.replace(/^#+ /, '').toLowerCase().replace(/ /g, '-'));
  });

  it('the English chip titles are TIER_MEANING', () => {
    const en = JSON.parse(read('src/locales/en.json')) as { components: { corroboration: Record<string, string> } };
    for (const tier of [1, 2, 3, 4] as const) {
      assert.equal(en.components.corroboration[`tierTitle${tier}`], `Tier ${tier}: ${TIER_MEANING[tier]}`);
    }
  });
});
