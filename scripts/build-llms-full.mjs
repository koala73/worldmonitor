#!/usr/bin/env node
/**
 * Generate the two agent files (#7463, #7746):
 *   - public/llms.txt is hand-authored except its `## Comparisons` section,
 *     which is rendered from the comparison-page registry and spliced in
 *     ahead of `## Live Instances` on every run.
 *   - public/llms-full.txt keeps its hand-authored brief above `## Generated
 *     corpus`; the comparisons index, glossary bodies, chokepoint
 *     methodology, published chokepoint explainers, CRI methodology, the
 *     corrections log, and the current ranking snapshot are inlined below
 *     that heading.
 *
 * Usage:
 *   npm run build:llms-full          # rewrite whichever file is stale
 *   npm run build:llms-full:check    # exit 1 naming every stale file
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { GLOSSARY_TERMS } from '../blog-site/src/data/glossary.ts';
import { COMPARISON_MATRIX_COLUMNS, comparisonDiscoveryEntries } from './build-comparison-pages.mjs';
import { resolveLatestResilienceSnapshotPath } from './build-crawlable-corpus.mjs';
import { CHOKEPOINT_CONTENT } from './chokepoint-page-content.mjs';
import { SITE_ORIGIN } from './discover-content-corpus-pages.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_PATH = 'public/llms-full.txt';
export const LLMS_TXT_PATH = 'public/llms.txt';
export const LLMS_FULL_GENERATED_HEADING = '## Generated corpus';
export const COMPARISONS_HEADING = '## Comparisons';
const COMPARISONS_ANCHOR_HEADING = '## Live Instances';

const CHOKEPOINT_BLOGS = [
  'blog-site/src/content/blog/what-is-a-maritime-chokepoint.md',
  'blog-site/src/content/blog/tracking-global-trade-routes-chokepoints-freight-costs.md',
  'blog-site/src/content/blog/energy-shock-monitoring-chokepoints-worldmonitor.md',
];

function read(rootDir, relativePath) {
  return readFileSync(join(rootDir, relativePath), 'utf8');
}

function stripFrontmatter(source) {
  return redactInternalApiOrigins(String(source).replace(/^---\n[\s\S]*?\n---\n/, '').trim());
}

const PUBLIC_API_HOSTNAME = 'api.worldmonitor.app';
const PUBLIC_API_ALLOWLIST_COMMENT = ' <!-- // pragma: allowlist secret -->';

export function redactInternalApiOrigins(text) {
  // The generated corpus copies methodology markdown. Some source pages cite
  // preview or internal API-prefixed hosts, which this repo treats as
  // configured secrets. Collapse those hosts to the existing [REDACTED]
  // placeholder used in the hand-authored brief. Keep the canonical public
  // API origin so agents can follow documented runtime-manifest links, and
  // stamp the existing allowlist pragma so the committed corpus can keep it.
  const redacted = String(text).replace(
    /https?:\/\/([^/\s)"'`<>]+)([^\s)"'`<>]*)/g,
    (full, host, rest) => {
      const hostname = String(host).toLowerCase();
      if (hostname === PUBLIC_API_HOSTNAME) return full;
      if (hostname === 'api' || hostname.split('.')[0] === 'api') {
        return `[REDACTED]${rest}`;
      }
      return full;
    },
  );
  return redacted.split('\n').map((line) => {
    if (!line.toLowerCase().includes(PUBLIC_API_HOSTNAME)) return line;
    if (line.includes('pragma: allowlist secret')) return line;
    return `${line}${PUBLIC_API_ALLOWLIST_COMMENT}`;
  }).join('\n');
}

function stripMdx(source) {
  let text = stripFrontmatter(source);
  text = text.replace(/<[A-Z][A-Za-z0-9]*[^>]*\/>/g, '');
  text = text.replace(/<\/?[A-Z][A-Za-z0-9]*[^>]*>/g, '');
  return redactInternalApiOrigins(text.replace(/\n{3,}/g, '\n\n').trim());
}

function briefPrefix(existing) {
  const heading = `\n${LLMS_FULL_GENERATED_HEADING}\n`;
  const idx = existing.indexOf(heading);
  const prefix = idx === -1 ? existing : existing.slice(0, idx);
  return prefix.replace(/\s+$/, '');
}

export const VERSION_HEADER_RE = /^> Version: \d+\.\d+\.\d+ · Last updated: \d{4}-\d{2}-\d{2}$/m;

/**
 * llms.txt declares the corpus version and date; llms-full.txt did not, so a
 * consumer had no way to tell whether the 240 KB file was current (#6038).
 * Copy the short briefing's header verbatim rather than restating it, so the
 * two files cannot claim different versions of the same product.
 */
export function readVersionHeader(rootDir) {
  const header = read(rootDir, 'public/llms.txt').match(VERSION_HEADER_RE)?.[0];
  if (!header) {
    throw new Error('public/llms.txt must carry a "> Version: X.Y.Z · Last updated: YYYY-MM-DD" line');
  }
  return header;
}

export function withVersionHeader(prefix, versionHeader) {
  if (prefix.trim() === '') {
    throw new Error(`${OUTPUT_PATH} must exist with its hand-authored brief — this generator appends a corpus, it does not author the file`);
  }
  const lines = prefix.split('\n').filter((line) => !line.startsWith('> Version: '));
  const summaryAt = lines.findIndex((line) => line.startsWith('> '));
  if (summaryAt === -1) {
    throw new Error(`${OUTPUT_PATH} must open with the llms.txt-style summary blockquote`);
  }
  // Past the WHOLE first blockquote, not just its opening line: a two-line
  // summary would otherwise be split in half by the inserted header.
  let insertAt = summaryAt;
  while (lines[insertAt + 1]?.startsWith('> ')) insertAt += 1;
  const rest = lines.slice(insertAt + 1);
  // Collapse the blank left behind by a removed header so re-runs are stable.
  while (rest[0] === '' && rest[1] === '') rest.shift();
  return [...lines.slice(0, insertAt + 1), '', versionHeader, ...rest].join('\n');
}

function renderGlossary() {
  const lines = ['## Glossary', ''];
  for (const term of GLOSSARY_TERMS) {
    const title = term.abbr ? `${term.term} (${term.abbr})` : term.term;
    lines.push(`### ${title}`, '', term.short, '');
    for (const paragraph of term.body || []) {
      lines.push(paragraph, '');
    }
  }
  return lines.join('\n');
}

function renderChokepointBlurbs() {
  const lines = ['## Monitored chokepoints', ''];
  for (const content of Object.values(CHOKEPOINT_CONTENT)) {
    lines.push(`### ${content.region}`, '', content.blurb, '');
  }
  return lines.join('\n');
}

function renderSnapshotTable(rootDir) {
  const snapshotPath = resolveLatestResilienceSnapshotPath(rootDir);
  const snapshot = JSON.parse(read(rootDir, snapshotPath));
  const lines = [
    '## Published country resilience ranking',
    '',
    `Snapshot \`${snapshotPath}\` captured ${snapshot.capturedAt}. ${snapshot.snapshotNote}`,
    '',
    '| Rank | Country | Code | Score | Coverage |',
    '| ---: | --- | --- | ---: | ---: |',
  ];
  for (const item of snapshot.items || []) {
    const name = item.identity?.commonName || item.countryName || item.countryCode;
    const coverage = Number.isFinite(item.dimensionCoverage)
      ? `${Math.round(item.dimensionCoverage * 100)}%`
      : '—';
    const score = Number.isFinite(item.overallScore) ? item.overallScore.toFixed(1) : '—';
    lines.push(`| ${item.rank} | ${name} | ${item.countryCode} | ${score} | ${coverage} |`);
  }
  if (Array.isArray(snapshot.greyedOut) && snapshot.greyedOut.length > 0) {
    lines.push('', 'Unranked (greyed-out) countries in the same capture:', '');
    for (const item of snapshot.greyedOut) {
      const name = item.identity?.commonName || item.countryName || item.countryCode;
      lines.push(`- ${name} (${item.countryCode})`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * The /compare/ family scored 85–92 on citability yet was referenced from
 * none of the discovery surfaces (#7746). One entry per route, derived from
 * the same COMPARISON_PAGES that emit the pages, so a new comparison cannot
 * ship without an entry and a renamed one cannot leave a stale link.
 */
export function renderComparisons() {
  const entries = comparisonDiscoveryEntries(SITE_ORIGIN);
  return [
    COMPARISONS_HEADING,
    '',
    `A comparison hub plus ${entries.length - 1} head-to-head and category pages. Every page uses the same ${COMPARISON_MATRIX_COLUMNS.length}-column matrix (${COMPARISON_MATRIX_COLUMNS.join(', ')}), states what each competitor wins, and answers the questions engines lift verbatim. Prices were checked at publication and can change.`,
    '',
    ...entries.map((entry) => `- [${entry.title}](${entry.url}): ${entry.description}`),
  ].join('\n');
}

/**
 * Splice the generated Comparisons section into the hand-maintained
 * llms.txt: replace the existing section in place, or insert it ahead of
 * Live Instances the first time. Idempotent, so --check can diff it.
 */
export function withComparisonsSection(llmsTxt) {
  const text = String(llmsTxt);
  const block = renderComparisons();
  const headings = [...text.matchAll(/^## Comparisons$/gm)];
  if (headings.length > 1) {
    throw new Error(`${LLMS_TXT_PATH} carries ${headings.length} "${COMPARISONS_HEADING}" headings; keep exactly one`);
  }
  if (headings.length === 1) {
    const start = headings[0].index;
    const nextHeading = text.indexOf('\n## ', start + COMPARISONS_HEADING.length);
    const end = nextHeading === -1 ? text.length : nextHeading;
    return `${text.slice(0, start)}${block}\n${text.slice(end)}`;
  }
  const anchor = `\n${COMPARISONS_ANCHOR_HEADING}\n`;
  const at = text.indexOf(anchor);
  if (at === -1) {
    throw new Error(`${LLMS_TXT_PATH} must carry a "${COMPARISONS_ANCHOR_HEADING}" heading to anchor the Comparisons section`);
  }
  return `${text.slice(0, at + 1)}${block}\n${text.slice(at)}`;
}

export function buildLlmsFullText({ rootDir = ROOT } = {}) {
  const existing = existsSync(join(rootDir, OUTPUT_PATH))
    ? read(rootDir, OUTPUT_PATH)
    : '';
  const prefix = withVersionHeader(briefPrefix(existing), readVersionHeader(rootDir));
  const generated = [
    LLMS_FULL_GENERATED_HEADING,
    '',
    'The sections below are produced by `npm run build:llms-full` from the comparison-page registry, glossary terms, chokepoint methodology, published chokepoint explainers, the Country Resilience Index methodology, the corrections log, and the current published ranking snapshot.',
    '',
    renderComparisons().trim(),
    '',
    renderGlossary().trim(),
    '',
    renderChokepointBlurbs().trim(),
    '',
    '## Chokepoint methodology',
    '',
    stripMdx(read(rootDir, 'docs/methodology/chokepoints.mdx')),
    '',
    '## Chokepoint explainers',
    '',
    ...CHOKEPOINT_BLOGS.flatMap((relativePath) => [
      `### ${relativePath}`,
      '',
      stripFrontmatter(read(rootDir, relativePath)),
      '',
    ]),
    '## Country Resilience Index methodology',
    '',
    stripMdx(read(rootDir, 'docs/methodology/country-resilience-index.mdx')),
    '',
    '## Revision and corrections log',
    '',
    stripMdx(read(rootDir, 'docs/corrections.mdx')),
    '',
    renderSnapshotTable(rootDir).trim(),
    '',
  ].join('\n');

  return `${prefix}\n\n${generated}`;
}

/**
 * Writes both agent files: the Comparisons section spliced into llms.txt and
 * the full corpus. One script owns both so the section cannot drift between
 * them (#7746). Both outputs are rendered before anything is written or
 * judged, so --check names every stale file at once and a render failure
 * never leaves the pair half-written. Returns one entry per file.
 */
export function writeLlmsFull({ rootDir = ROOT, check = false } = {}) {
  const outputs = [
    { relativePath: LLMS_TXT_PATH, next: withComparisonsSection(read(rootDir, LLMS_TXT_PATH)) },
    { relativePath: OUTPUT_PATH, next: buildLlmsFullText({ rootDir }) },
  ].map(({ relativePath, next }) => {
    const path = join(rootDir, relativePath);
    const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
    return { path, relativePath, next, changed: current !== next, bytes: Buffer.byteLength(next) };
  });
  const stale = outputs.filter((output) => output.changed);
  if (check && stale.length > 0) {
    throw new Error(`${stale.map((output) => output.relativePath).join(' and ')} stale — run npm run build:llms-full`);
  }
  for (const output of stale) writeFileSync(output.path, output.next);
  return { files: outputs.map(({ relativePath, changed, bytes }) => ({ path: relativePath, changed, bytes })) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes('--check');
  try {
    const result = writeLlmsFull({ check });
    for (const file of result.files) {
      const kb = (file.bytes / 1000).toFixed(1);
      process.stdout.write(
        `${file.changed ? 'Wrote' : 'Unchanged'} ${file.path} (${kb} KB)\n`,
      );
    }
  } catch (err) {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exit(1);
  }
}
