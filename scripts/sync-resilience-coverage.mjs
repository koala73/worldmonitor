#!/usr/bin/env node
/**
 * Restate the newest resilience snapshot's "{ranked} of {universe}" pair on
 * the hand-written public surfaces that cannot import the snapshot helper
 * (static HTML meta, docs front matter, a blog table). Generated surfaces
 * (llms briefs, ai-search.md, the corpus, product facts) are rebuilt by their
 * own generators.
 *
 * The monthly snapshot refresh workflow runs this after freezing a new
 * snapshot, so a changed ranked count rewrites every surface instead of
 * failing the coverage tests and blocking the refresh PR.
 *
 * Usage:
 *   npm run resilience:coverage
 *   npm run resilience:coverage -- --check
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RESILIENCE_COVERAGE_PATTERN, publishedRankedCountries, resilienceCoveragePhrase } from './build-crawlable-corpus.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const standardPhrase = {
  pattern: RESILIENCE_COVERAGE_PATTERN,
  render: resilienceCoveragePhrase,
};

/**
 * Each surface names the wording it uses and how many times it must occur, so
 * copy that drifts away from the pattern fails loudly rather than going stale.
 */
export const RESILIENCE_COVERAGE_SURFACES = [
  { path: 'index.html', occurrences: 3, ...standardPhrase },
  { path: 'src/config/variant-meta.ts', occurrences: 1, ...standardPhrase },
  { path: 'docs/about.mdx', occurrences: 2, ...standardPhrase },
  {
    path: 'docs/methodology/country-resilience-index.mdx',
    occurrences: 1,
    pattern: /with \d+ of \d+ countries ranked/g,
    render: ({ ranked, universe }) => `with ${ranked} of ${universe} countries ranked`,
  },
  {
    path: 'docs/zh/methodology/country-resilience-index.mdx',
    occurrences: 1,
    pattern: /其中 \d+ 个国家进入排名（\d+\/\d+）/g,
    render: ({ ranked, universe }) => `其中 ${ranked} 个国家进入排名（${ranked}/${universe}）`,
  },
  {
    path: 'docs/overview.mdx',
    occurrences: 1,
    pattern: /ranks \d+ of \d+ countries/g,
    render: ({ ranked, universe }) => `ranks ${ranked} of ${universe} countries`,
  },
  {
    path: 'blog-site/src/content/blog/country-instability-index-methodology-explained.md',
    occurrences: 1,
    pattern: /Ranked for \d+ of \d+ countries/g,
    render: ({ ranked, universe }) => `Ranked for ${ranked} of ${universe} countries`,
  },
];

/** Rewrite one surface's text to state `coverage`; throws when the wording is missing. */
export function restateCoverage(text, surface, coverage) {
  const found = text.match(surface.pattern)?.length ?? 0;
  if (found !== surface.occurrences) {
    throw new Error(
      `${surface.path}: expected ${surface.occurrences} resilience coverage statement(s) matching ${surface.pattern}, found ${found}`,
    );
  }
  return text.replace(surface.pattern, surface.render(coverage));
}

/** Returns the surfaces that did not already state `coverage`. */
export function syncResilienceCoverage({
  rootDir = ROOT,
  coverage = publishedRankedCountries(rootDir),
  check = false,
} = {}) {
  const stale = [];
  for (const surface of RESILIENCE_COVERAGE_SURFACES) {
    const path = join(rootDir, surface.path);
    const current = readFileSync(path, 'utf8');
    const next = restateCoverage(current, surface, coverage);
    if (next === current) continue;
    stale.push(surface.path);
    if (!check) writeFileSync(path, next);
  }
  return stale;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes('--check');
  const stale = syncResilienceCoverage({ check });
  if (check && stale.length > 0) {
    console.error(`Stale resilience coverage (run npm run resilience:coverage):\n  ${stale.join('\n  ')}`);
    process.exit(1);
  }
  for (const path of stale) console.log(`  ✓ ${path}`);
}
