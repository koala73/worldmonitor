#!/usr/bin/env node
/**
 * Regenerate the citable figures in public/ai-search.md (#6038).
 *
 * ai-search.md exists so an assistant can lift a fact and attribute it. #6736
 * removed every numeral from `## Data Coverage` because the hand-authored
 * totals had rotted and nothing regenerated them, which traded a wrong number
 * for an uncitable one — meanwhile /sources/ kept publishing exact provider and
 * host counts one click away. This generator restores the figures and takes
 * them from the same registries /sources/ reads, so the two surfaces cannot
 * disagree.
 *
 * The prose stays hand-authored. Only the `## Data Coverage` block and the
 * document's `Last updated:` line are generated; everything else in the file is
 * preserved verbatim.
 *
 * Usage:
 *   npm run build:ai-search
 *   npm run build:ai-search:check
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { AI_DATA_CENTERS } from '../src/config/ai-datacenters.ts';
import { CHOKEPOINT_REGISTRY } from '../src/config/chokepoint-registry.ts';
import { UNDERSEA_CABLES } from '../src/config/geo-map.ts';
import { getCompleteLayerCatalogKeys } from '../src/config/map-layer-definitions.ts';
import { PIPELINES } from '../shared/pipelines-data.ts';
import { INTEL_HOTSPOTS } from '../shared/geo-data.ts';
import { SOURCE_DOMAINS } from './crawlable-sources-page.mjs';
import { resolveLatestResilienceSnapshotPath } from './build-crawlable-corpus.mjs';
import { AI_SEARCH_COVERAGE_HEADING } from './docs-stats.mjs';
import { loadStatsForInventoryFacts } from './generate-inventory-facts.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const AI_SEARCH_PATH = 'public/ai-search.md';
// Single-sourced from docs-stats, which uses the same heading to exempt this
// block from its volatile-claim scan. Two independent copies of the literal
// would let the generator and the gate drift onto different headings. The
// import only goes this way: docs-stats stays dependency-free so it can run in
// container build stages that have no TypeScript loader.
export const COVERAGE_HEADING = AI_SEARCH_COVERAGE_HEADING;
const LAST_UPDATED_RE = /^Last updated: \d{4}-\d{2}-\d{2}$/m;
const RECONCILED_RE = /^Coverage reconciled: \d{4}-\d{2}-\d{2}\b.*$/m;

const read = (rootDir, relativePath) => readFileSync(join(rootDir, relativePath), 'utf8');
const readJson = (rootDir, relativePath) => JSON.parse(read(rootDir, relativePath));
const count = (value) => value.toLocaleString('en-US');

/** UTC so a late-evening run in a +04:00 timezone cannot date as tomorrow. */
export function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Countries in the latest published resilience ranking. The rankable universe
 * (196) and the published ranking (170) are different facts and third-party
 * coverage has conflated them, so ai-search.md states both with their
 * definitions attached.
 */
export function publishedRankedCountries(rootDir = ROOT) {
  const snapshot = readJson(rootDir, resolveLatestResilienceSnapshotPath(rootDir));
  if (!Array.isArray(snapshot.items) || snapshot.items.length === 0) {
    throw new Error('the published resilience ranking snapshot must contain ranked items');
  }
  return { ranked: snapshot.items.length, capturedAt: snapshot.capturedAt };
}

/**
 * The homepage publishes "57 · Map layer types" (the full variant's reachable
 * catalog) while the registry holds 58 entries. Both are true and both were
 * published under the same words, which is precisely the ambiguity that makes
 * AI answers disagree. State both with their definitions instead of picking
 * one and leaving the other surface to contradict it.
 */
export function mapLayerCoverage(stats) {
  return mapLayerCoverageText(stats.layerDefinitions, getCompleteLayerCatalogKeys('full').length);
}

/** Split from the registry read so every branch is reachable from a unit test. */
export function mapLayerCoverageText(registry, fullVariant) {
  if (fullVariant > registry) {
    throw new Error(`the full-variant layer catalog (${fullVariant}) cannot exceed the registry (${registry})`);
  }
  if (fullVariant === registry) {
    return `- ${count(registry)} map layer types in the shared registry, all of them reachable in the full variant`;
  }
  const gated = registry - fullVariant;
  return `- ${count(registry)} map layer types in the shared registry, ${count(fullVariant)} of them reachable in the full variant — the homepage publishes the full-variant figure; the remaining ${count(gated)} ${gated === 1 ? 'is' : 'are'} sunset or build-flag gated`;
}

/**
 * One bullet per registry, each stating the figure AND the definition that
 * produced it. A bare "747 providers" is unattributable; "747 active providers
 * across 760 observed source hosts" can be checked against /sources/.
 *
 * Host kinds overlap — a host can expose a structured API and publish a feed —
 * so the breakdown is phrased the way /sources/ phrases it, never as a
 * partition that would not sum.
 */
export function buildCoverageBullets({ stats, resilience }) {
  const attribution = stats.sourceAttribution;
  return [
    `- ${count(attribution.providerCount)} active data providers across ${count(attribution.activeHosts)} observed source hosts (${count(attribution.structuredHosts)} structured/API, ${count(attribution.feedHosts)} news & OSINT feed, ${count(attribution.operationalStatusHosts)} operational-status; a host can be more than one), grouped into ${count(SOURCE_DOMAINS.length)} signal domains — full catalog at https://www.worldmonitor.app/sources/`,
    `- ${count(stats.feedDefinitions)} feed definitions in the shared feed registry`,
    // "Freshness-tracked" is a different axis from the source catalog's signal
    // domains, and the two sat adjacent with no definition — an agent could
    // reasonably have collapsed them into one grouping. Name the axis.
    `- ${count(stats.freshnessSources)} named live data streams whose staleness is tracked and surfaced individually (ACLED, OpenSky, AIS, GDELT, RSS and the rest) — a different axis from the ${count(SOURCE_DOMAINS.length)} signal domains above, which group the source catalog by subject`,
    mapLayerCoverage(stats),
    `- ${count(stats.panelClasses)} concrete panel implementations across ${count(stats.variantCount)} product variants`,
    `- ${count(stats.mcpToolCount)} MCP tools; use \`tools/list\` for the live inventory`,
    `- ${count(stats.locales)} supported interface languages`,
    `- ${count(stats.tier1Countries)} countries scored by the Country Instability Index (CII v8)`,
    `- ${count(stats.rankableUniverseCountries)}-country rankable universe for the Country Resilience Index, of which ${count(resilience.ranked)} are ranked in the published snapshot captured ${resilience.capturedAt}`,
    `- ${count(CHOKEPOINT_REGISTRY.length)} maritime chokepoints with AIS-based transit intelligence`,
    `- ${count(UNDERSEA_CABLES.length)} submarine cable routes`,
    `- ${count(PIPELINES.length)} pipelines and LNG assets`,
    `- ${count(AI_DATA_CENTERS.length)} AI datacenters mapped`,
    `- ${count(INTEL_HOTSPOTS.length)} scored geopolitical hotspots`,
    `- ${count(stats.stockExchangeCount)} stock exchanges in the markets registry`,
  ];
}

export function buildCoverageSection({ stats, resilience, reconciledAt }) {
  return [
    COVERAGE_HEADING,
    '',
    `Coverage reconciled: ${reconciledAt}. Every figure below is generated from this repository's authoritative registries by \`npm run build:ai-search\` — the same registries that produce https://www.worldmonitor.app/sources/.`,
    '',
    ...buildCoverageBullets({ stats, resilience }),
    // Two trailing newlines: the replaced span runs up to the next `## `
    // heading, so the section owns the blank line that separates them.
    '',
    '',
  ].join('\n');
}

/**
 * Replace the block from `heading` up to the next level-2 heading, keeping the
 * rest of the document byte-identical.
 */
export function replaceSection(source, heading, replacement) {
  const start = source.indexOf(`${heading}\n`);
  if (start === -1) throw new Error(`${AI_SEARCH_PATH} is missing the ${heading} section`);
  const nextHeading = source.indexOf('\n## ', start + heading.length);
  const end = nextHeading === -1 ? source.length : nextHeading + 1;
  return `${source.slice(0, start)}${replacement}${source.slice(end)}`;
}

function withoutDates(text) {
  return text.replace(LAST_UPDATED_RE, 'Last updated: <date>').replace(RECONCILED_RE, 'Coverage reconciled: <date>');
}

/**
 * The reconciliation date moves only when the document's content moves.
 * Stamping the build clock unconditionally would dirty the working tree on
 * every run and make `--check` fail once a day for no reason; carrying the
 * committed date forward keeps regeneration idempotent.
 */
export function resolveReconciledAt({ current, candidate, today }) {
  const existing = current.match(RECONCILED_RE)?.[0].match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (!existing) return today;
  return withoutDates(candidate) === withoutDates(current) ? existing : today;
}

export function buildAiSearchText({ rootDir = ROOT, today = todayUtc() } = {}) {
  if (!existsSync(join(rootDir, AI_SEARCH_PATH))) {
    // The prose is hand-authored and committed; this generator only refreshes
    // the figures inside it and cannot author the document from nothing.
    throw new Error(`${AI_SEARCH_PATH} must exist — this generator rewrites its figures, not the file`);
  }
  const current = read(rootDir, AI_SEARCH_PATH);
  const stats = loadStatsForInventoryFacts();
  const resilience = publishedRankedCountries(rootDir);

  const render = (reconciledAt) => {
    const withCoverage = replaceSection(
      current,
      COVERAGE_HEADING,
      buildCoverageSection({ stats, resilience, reconciledAt }),
    );
    const dated = withCoverage.replace(LAST_UPDATED_RE, `Last updated: ${reconciledAt}`);
    if (!LAST_UPDATED_RE.test(dated)) {
      throw new Error(`${AI_SEARCH_PATH} must carry an ISO "Last updated: YYYY-MM-DD" line`);
    }
    return dated;
  };

  return render(resolveReconciledAt({ current, candidate: render(today), today }));
}

export function writeAiSearch({ rootDir = ROOT, check = false, today = todayUtc() } = {}) {
  const next = buildAiSearchText({ rootDir, today });
  const path = join(rootDir, AI_SEARCH_PATH);
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (current === next) return { path: AI_SEARCH_PATH, changed: false };
  if (check) throw new Error(`${AI_SEARCH_PATH} is stale — run npm run build:ai-search`);
  writeFileSync(path, next);
  return { path: AI_SEARCH_PATH, changed: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = writeAiSearch({ check: process.argv.includes('--check') });
    process.stdout.write(`${result.changed ? 'Wrote' : 'Unchanged'} ${result.path}\n`);
  } catch (err) {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exit(1);
  }
}
