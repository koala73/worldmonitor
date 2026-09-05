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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  AI_SEARCH_PATH,
  COVERAGE_CLOSE,
  COVERAGE_HEADING,
  buildAiSearchText,
  isTrustworthyDate,
  mapLayerCoverageText,
  publishedRankedCountries,
  resolveReconciledAt,
  writeAiSearch,
} from '../scripts/build-ai-search.mjs';
import { VERSION_HEADER_RE, withVersionHeader } from '../scripts/build-llms-full.mjs';
import { SOURCE_DOMAINS } from '../scripts/crawlable-sources-page.mjs';
import { validateVolatileInventoryClaims, withStatsRoot } from '../scripts/docs-stats.mjs';
import { loadStatsForInventoryFacts } from '../scripts/generate-inventory-facts.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFileSync(join(repoRoot, relativePath), 'utf8');
/** The ISO date inside the coverage block's reconciliation line. */
const RECONCILED_ISO = /(?<=Coverage reconciled: )\d{4}-\d{2}-\d{2}/;

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

  it('does not claim a document freshness the generator cannot measure', () => {
    // The generator knows when the figures were reconciled; it cannot know when
    // the hand-authored prose was last touched, and a prose-only edit leaves
    // the date unmoved. "Last updated" asserted the latter.
    const briefing = read('public/ai-search.md');
    assert.match(briefing, /^Facts reconciled: \d{4}-\d{2}-\d{2}\b/m);
    assert.doesNotMatch(briefing, /^Last updated:/m);
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
    // written for AI citation published none of them. Pin the agreement — and
    // anchor each figure to the phrase it belongs to, not to the section as a
    // whole. A section-wide `\b<n>\b` search passes even when the generator
    // transposes two figures onto each other's bullets.
    for (const [phrase, value] of [
      ['%d active data providers', attribution.providerCount],
      ['across %d observed source hosts', attribution.activeHosts],
      ['(%d structured/API', attribution.structuredHosts],
      ['%d news & OSINT feed', attribution.feedHosts],
      ['grouped into %d signal domains', SOURCE_DOMAINS.length],
      ['%d MCP tools', stats.mcpToolCount],
      ['%d supported interface languages', stats.locales],
      ['%d map layer types in the shared registry', stats.layerDefinitions],
      ['%d feed definitions in the shared feed registry', stats.feedDefinitions],
      ['%d countries scored by the Country Instability Index', stats.tier1Countries],
      ['of which %d are ranked in the published snapshot', publishedRankedCountries(repoRoot).ranked],
    ]) {
      const expected = phrase.replace('%d', value.toLocaleString('en-US'));
      assert.ok(
        coverage.includes(expected),
        `Data Coverage must publish "${expected}" — the registry value attached to its own claim`,
      );
    }

    assert.equal(attribution.providerCount, published.sourceAttributionProviders);
    assert.equal(attribution.activeHosts, published.sourceAttributionHosts);
    assert.equal(stats.mcpToolCount, published.mcpTools);
    assert.equal(stats.locales, published.locales);
  });

  it('keeps the hand-authored CII prose agreeing with the generated bullet', () => {
    // The page states the Tier-1 count twice: once in generated coverage, once
    // in the hand-authored CII paragraph the generator preserves verbatim. When
    // the registry moves, only the bullet follows — leaving one page publishing
    // two answers to the same question. Nothing else catches that, because the
    // paragraph is prose the volatile-claim scanner allows.
    const prose = read(AI_SEARCH_PATH).match(/stress score for ([\d,]+) Tier-1 countries/);
    assert.ok(prose, 'the CII paragraph must state the Tier-1 country count');
    assert.equal(
      Number(prose[1].replace(/,/g, '')),
      loadStatsForInventoryFacts().tier1Countries,
      'the CII paragraph and the generated coverage bullet must not disagree',
    );
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

  it('states the layer gap correctly at every branch, including ones the registry cannot reach today', () => {
    assert.match(
      mapLayerCoverageText(58, 57),
      /58 map layer types in the shared registry, 57 of them reachable in the full variant.*the remaining 1 is sunset or build-flag gated/,
    );
    assert.match(mapLayerCoverageText(58, 56), /the remaining 2 are sunset or build-flag gated/);
    assert.match(mapLayerCoverageText(58, 58), /58 map layer types in the shared registry, all of them reachable/);
    assert.doesNotMatch(mapLayerCoverageText(58, 58), /remaining/);
    // A full-variant catalog larger than the registry it draws from means one
    // of the two readings is wrong; publishing either would be a false claim.
    assert.throws(() => mapLayerCoverageText(57, 58), /cannot exceed the registry/);
  });

  it('fails the check run when the committed figures are stale', () => {
    // An unchanged repo can never look stale, so stage a tree whose coverage
    // block carries a wrong figure. Only public/ is copied; docs/ is symlinked
    // so the resilience-snapshot read resolves without duplicating the tree.
    const sandbox = mkdtempSync(join(tmpdir(), 'wm-ai-search-'));
    try {
      mkdirSync(join(sandbox, 'public'), { recursive: true });
      symlinkSync(join(repoRoot, 'docs'), join(sandbox, 'docs'), 'dir');
      writeFileSync(
        join(sandbox, AI_SEARCH_PATH),
        read(AI_SEARCH_PATH).replace(/^- \d[\d,]* MCP tools.*$/m, '- 1 MCP tool; use `tools/list` for the live inventory'),
      );
      assert.throws(
        () => writeAiSearch({ rootDir: sandbox, check: true }),
        /is stale — run npm run build:ai-search/,
        'a stale committed figure must fail --check rather than pass quietly',
      );
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('regenerates ai-search.md when the monthly resilience snapshot refreshes', () => {
    // publishedRankedCountries() reads the latest resilience snapshot, so the
    // monthly cron that rotates that snapshot must rebuild this file too —
    // otherwise the committed ranked count and captured date go a month stale
    // and the drift test above turns red on main.
    const workflow = read('.github/workflows/resilience-snapshot-refresh.yml');
    assert.match(workflow, /npm run build:ai-search/);
    assert.match(workflow, /git add "\$snapshot_path".*public\/ai-search\.md/);
  });

  it('re-dates only when the figures move, so regeneration is idempotent', () => {
    const current = read(AI_SEARCH_PATH);
    const committed = current.match(/Coverage reconciled: (\d{4}-\d{2}-\d{2})/)[1];

    assert.equal(
      resolveReconciledAt({ current, candidate: current, today: '2099-01-01' }),
      committed,
      'an unchanged document must keep its committed date rather than stamping the build clock',
    );
    assert.equal(
      resolveReconciledAt({ current, candidate: `${current}\n- 1 new figure`, today: '2099-01-01' }),
      '2099-01-01',
      'changed figures must be re-dated',
    );
    // The date claims when the FIGURES were reconciled, which is why a
    // prose-only edit deliberately leaves it alone. This is the semantic the
    // "Facts reconciled" rename exists to state honestly.
    const proseEdited = current.replace(
      'This page is written for AI search systems',
      'This page is written for AI search engines',
    );
    assert.notEqual(proseEdited, current, 'the prose-edit fixture must actually differ');
    assert.equal(
      resolveReconciledAt({ current: proseEdited, candidate: proseEdited, today: '2099-01-01' }),
      committed,
      'a prose-only edit must not re-date the figures',
    );
  });

  it('refuses to carry forward a date that was never a real reconciliation', () => {
    const current = read(AI_SEARCH_PATH);
    const today = '2026-09-04';
    // withoutDates normalizes the date away before comparing, so an unchecked
    // carry-forward would republish any of these indefinitely under byte parity.
    for (const fabricated of ['2099-99-99', '0000-00-00', '2026-02-31', '2099-01-01']) {
      const tampered = current.replace(RECONCILED_ISO, fabricated);
      assert.notEqual(tampered, current, `${fabricated} fixture must differ`);
      assert.equal(
        resolveReconciledAt({ current: tampered, candidate: tampered, today }),
        today,
        `${fabricated} must be replaced, not carried forward`,
      );
    }
    assert.equal(isTrustworthyDate('2026-09-03', today), true);
    assert.equal(isTrustworthyDate(today, today), true, 'today itself is valid');
  });

  it('bumps a stale file once and then stays put', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'wm-ai-search-'));
    try {
      mkdirSync(join(sandbox, 'public'), { recursive: true });
      symlinkSync(join(repoRoot, 'docs'), join(sandbox, 'docs'), 'dir');
      const path = join(sandbox, AI_SEARCH_PATH);
      writeFileSync(path, read(AI_SEARCH_PATH).replace(/^- \d[\d,]* MCP tools.*$/m, '- 1 MCP tool'));

      const first = buildAiSearchText({ rootDir: sandbox, today: '2027-03-04' });
      assert.match(first, /Coverage reconciled: 2027-03-04/, 'stale figures must be re-dated on the fixing run');
      writeFileSync(path, first);

      // A later run on a different day must not churn the file again.
      assert.equal(buildAiSearchText({ rootDir: sandbox, today: '2028-11-19' }), first);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('keeps hand-authored copy outside the coverage block under the drift scanner', async () => {
    await withStatsRoot(async (sandbox) => {
      assert.deepEqual(validateVolatileInventoryClaims(), [], 'the sandbox copy must start clean');
      const path = join(sandbox, AI_SEARCH_PATH);
      const source = readFileSync(path, 'utf8');
      const claim = 'World Monitor ingests 500+ curated feeds.';

      writeFileSync(path, source.replace('## Source Examples\n', `## Source Examples\n\n${claim}\n`));
      assert.ok(
        validateVolatileInventoryClaims().some((f) => f.startsWith(`${AI_SEARCH_PATH}:`)),
        'a hand-authored inventory total outside the generated block must still fail the scan',
      );

      // The inverse: the same claim inside the sentinels is exempt, which is
      // what makes the exemption narrow rather than a hole in the whole file.
      writeFileSync(path, source.replace(COVERAGE_CLOSE, `${claim}\n${COVERAGE_CLOSE}`));
      assert.deepEqual(
        validateVolatileInventoryClaims().filter((f) => f.startsWith(`${AI_SEARCH_PATH}:`)),
        [],
        'the generated span is exempt from the scan — the drift test is what guards it',
      );

      // Removing the closing sentinel must fail closed, not exempt the tail.
      writeFileSync(path, source.replace(`${COVERAGE_CLOSE}\n`, '').replace('## Source Examples\n', `## Source Examples\n\n${claim}\n`));
      assert.ok(
        validateVolatileInventoryClaims().some((f) => f.startsWith(`${AI_SEARCH_PATH}:`)),
        'an unbalanced sentinel pair must scan the whole file rather than exempt it',
      );
    });
  });

  it('cannot have its exemption widened by an editorial heading change', async () => {
    await withStatsRoot(async (sandbox) => {
      const path = join(sandbox, AI_SEARCH_PATH);
      const source = readFileSync(path, 'utf8');
      // Demoting the following heading moved an inferred span's end past it,
      // handing the prose below a pass from a merge-blocking gate. Sentinels
      // make the span self-describing, so this edit changes nothing.
      writeFileSync(
        path,
        source
          .replace('## Source Examples', '### Source Examples')
          .replace('### Source Examples\n', '### Source Examples\n\nWorld Monitor ingests 500+ curated feeds.\n'),
      );
      assert.ok(
        validateVolatileInventoryClaims().some((f) => f.startsWith(`${AI_SEARCH_PATH}:`)),
        'demoting the next heading must not extend the exemption over hand-authored prose',
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

  it('inserts the header after the whole summary blockquote, and only once', () => {
    const header = '> Version: 9.9.9 · Last updated: 2099-01-01';
    const single = withVersionHeader('# T\n\n> One line.\n\nBody.', header);
    assert.equal(single, `# T\n\n> One line.\n\n${header}\n\nBody.`);

    // A two-line summary must not be split in half by the inserted header.
    const twoLine = withVersionHeader('# T\n\n> First.\n> Second.\n\nBody.', header);
    assert.equal(twoLine, `# T\n\n> First.\n> Second.\n\n${header}\n\nBody.`);

    // Re-running must be a no-op rather than stacking headers or blank lines.
    assert.equal(withVersionHeader(single, header), single);
    assert.equal(withVersionHeader(withVersionHeader(single, header), header), single);

    assert.throws(() => withVersionHeader('', header), /must exist with its hand-authored brief/);
    assert.throws(() => withVersionHeader('# T\n\nNo blockquote.', header), /summary blockquote/);
  });
});
