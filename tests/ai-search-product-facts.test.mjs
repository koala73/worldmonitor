// Issue #6038 — AI-facing answer blocks must derive from current product facts.
//
// #6736 stripped every numeral out of the `## Data Coverage` section of
// public/ai-search.md because the hand-authored totals had rotted and nothing
// regenerated them. The round-5 GEO audit (finding M2) recorded the cost: the
// one file written for AI citation became uncitable, while /sources/ publishes
// exact provider and host counts one click away. These tests pin the repaired
// contract — the section is generated from the same registries /sources/ uses,
// and the AI briefings carry a machine-readable version header.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  AI_SEARCH_PATH,
  COVERAGE_HEADING,
  buildAiSearchText,
  publishedRankedCountries,
  resolveReconciledAt,
} from '../scripts/build-ai-search.mjs';
import { VERSION_HEADER_RE } from '../scripts/build-llms-full.mjs';
import { SOURCE_DOMAINS } from '../scripts/crawlable-sources-page.mjs';
import { validateVolatileInventoryClaims, withStatsRoot } from '../scripts/docs-stats.mjs';
import { loadStatsForInventoryFacts } from '../scripts/generate-inventory-facts.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFileSync(join(repoRoot, relativePath), 'utf8');

function section(source, heading) {
  const start = source.indexOf(`\n${heading}\n`);
  assert.notEqual(start, -1, `${heading} section must exist`);
  const after = source.indexOf('\n## ', start + heading.length + 1);
  return source.slice(start + 1, after === -1 ? source.length : after + 1);
}

function bulletsOf(text) {
  return text.split('\n').filter((line) => line.startsWith('- '));
}

describe('#6038 ai-search.md data coverage', () => {
  it('quantifies every coverage bullet instead of publishing bare nouns', () => {
    const coverage = section(read('public/ai-search.md'), '## Data Coverage');
    const bullets = bulletsOf(coverage);
    assert.ok(bullets.length > 0, 'Data Coverage must list coverage bullets');
    const unquantified = bullets.filter((line) => !/\d/.test(line));
    assert.deepEqual(
      unquantified,
      [],
      'every Data Coverage bullet must publish a citable figure, not a bare noun phrase',
    );
  });

  it('stamps the coverage section with a reconciliation date', () => {
    const coverage = section(read('public/ai-search.md'), '## Data Coverage');
    assert.match(
      coverage,
      /Coverage reconciled: \d{4}-\d{2}-\d{2}/,
      'the coverage section must date its figures so a citation can be attributed',
    );
  });
});

describe('#6038 ai-search.md is generated, not hand-maintained', () => {
  it('matches the generator byte for byte', () => {
    assert.equal(
      read(AI_SEARCH_PATH),
      buildAiSearchText({ rootDir: repoRoot }),
      `${AI_SEARCH_PATH} has drifted from its registries — run \`npm run build:ai-search\``,
    );
  });

  it('publishes the same figures /sources/ and product-facts.json publish', () => {
    const coverage = section(read(AI_SEARCH_PATH), COVERAGE_HEADING);
    const stats = loadStatsForInventoryFacts();
    const attribution = stats.sourceAttribution;
    const published = JSON.parse(read('public/product-facts.json')).capabilities;

    // The audit found /sources/ publishing 747/760/331/461/10 while the file
    // written for AI citation published none of them. Pin the agreement.
    for (const [label, value] of [
      ['active providers', attribution.providerCount],
      ['source hosts', attribution.activeHosts],
      ['structured hosts', attribution.structuredHosts],
      ['feed hosts', attribution.feedHosts],
      ['signal domains', SOURCE_DOMAINS.length],
      ['MCP tools', stats.mcpToolCount],
      ['locales', stats.locales],
      ['map layers', stats.layerDefinitions],
      ['feed definitions', stats.feedDefinitions],
      ['CII countries', stats.tier1Countries],
      ['ranked countries', publishedRankedCountries(repoRoot).ranked],
    ]) {
      assert.match(
        coverage,
        new RegExp(`\\b${value.toLocaleString('en-US')}\\b`),
        `Data Coverage must publish the registry value for ${label} (${value})`,
      );
    }

    assert.equal(attribution.providerCount, published.sourceAttributionProviders);
    assert.equal(attribution.activeHosts, published.sourceAttributionHosts);
    assert.equal(stats.mcpToolCount, published.mcpTools);
    assert.equal(stats.locales, published.locales);
  });

  it('reconciles the map-layer figure the homepage publishes instead of contradicting it', () => {
    // Live probe 2026-09-04: the homepage hero reads "57 · Map layer types"
    // while the registry holds 58 entries. Both are true under different
    // definitions; publishing one of them alone is what makes AI answers
    // disagree, so ai-search.md must state both and name which is which.
    const coverage = section(read(AI_SEARCH_PATH), COVERAGE_HEADING);
    const heroLayers = JSON.parse(read('pro-test/src/generated/hero-stats.json')).mapLayers;
    const registryLayers = loadStatsForInventoryFacts().layerDefinitions;

    assert.match(
      coverage,
      new RegExp(`${registryLayers} map layer types in the shared registry, ${heroLayers} of them reachable in the full variant`),
      'the coverage block must name both the registry total and the homepage figure',
    );
  });

  it('carries the reconciliation date forward when nothing changed', () => {
    const current = read(AI_SEARCH_PATH);
    assert.equal(
      resolveReconciledAt({ current, candidate: current, today: '2099-01-01' }),
      current.match(/Coverage reconciled: (\d{4}-\d{2}-\d{2})/)[1],
      'an unchanged document must keep its committed date rather than stamping the build clock',
    );
    assert.equal(
      resolveReconciledAt({ current, candidate: `${current}\nnew claim`, today: '2099-01-01' }),
      '2099-01-01',
      'a changed document must be re-dated',
    );
  });

  it('keeps hand-authored copy outside the coverage block under the drift scanner', async () => {
    await withStatsRoot(async (sandbox) => {
      assert.deepEqual(validateVolatileInventoryClaims(), [], 'the sandbox copy must start clean');
      const path = join(sandbox, AI_SEARCH_PATH);
      const source = readFileSync(path, 'utf8');
      writeFileSync(
        path,
        source.replace('## Source Examples\n', '## Source Examples\n\nWorld Monitor ingests 500+ curated feeds.\n'),
      );
      const failures = validateVolatileInventoryClaims();
      assert.ok(
        failures.some((failure) => failure.startsWith(`${AI_SEARCH_PATH}:`)),
        'a hand-authored inventory total outside the generated block must still fail the scan',
      );
    });
  });
});

describe('#6038 AI briefing version headers', () => {
  it('pins the llms.txt version to the published package version', () => {
    const header = read('public/llms.txt').match(VERSION_HEADER_RE)?.[0];
    assert.ok(header, 'public/llms.txt must carry a machine-readable version line');
    assert.equal(
      header.match(/\d+\.\d+\.\d+/)[0],
      JSON.parse(read('package.json')).version,
      'the briefing version must track the published package version',
    );
  });

  it('gives llms-full.txt the same version header as llms.txt', () => {
    const brief = read('public/llms.txt').match(VERSION_HEADER_RE)?.[0];
    const full = read('public/llms-full.txt').match(VERSION_HEADER_RE)?.[0];
    assert.ok(full, 'public/llms-full.txt must carry the same version header as llms.txt');
    assert.equal(full, brief, 'both briefings must declare the same version and date');
  });
});
