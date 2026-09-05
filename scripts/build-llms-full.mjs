#!/usr/bin/env node
/**
 * Expand public/llms-full.txt from a product brief into a crawler/LLM corpus
 * (#7463). The hand-authored brief above `## Generated corpus` is preserved;
 * glossary bodies, chokepoint methodology, published chokepoint explainers,
 * CRI methodology, the corrections log, and the current ranking snapshot are
 * inlined below that heading.
 *
 * Usage:
 *   npm run build:llms-full
 *   npm run build:llms-full:check
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { GLOSSARY_TERMS } from '../blog-site/src/data/glossary.ts';
import { resolveLatestResilienceSnapshotPath } from './build-crawlable-corpus.mjs';
import { CHOKEPOINT_CONTENT } from './chokepoint-page-content.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_PATH = 'public/llms-full.txt';
export const LLMS_FULL_GENERATED_HEADING = '## Generated corpus';

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

export function buildLlmsFullText({ rootDir = ROOT } = {}) {
  const existing = existsSync(join(rootDir, OUTPUT_PATH))
    ? read(rootDir, OUTPUT_PATH)
    : '';
  const prefix = withVersionHeader(briefPrefix(existing), readVersionHeader(rootDir));
  const generated = [
    LLMS_FULL_GENERATED_HEADING,
    '',
    'The sections below are produced by `npm run build:llms-full` from glossary terms, chokepoint methodology, published chokepoint explainers, the Country Resilience Index methodology, the corrections log, and the current published ranking snapshot.',
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

export function writeLlmsFull({ rootDir = ROOT, check = false } = {}) {
  const next = buildLlmsFullText({ rootDir });
  const path = join(rootDir, OUTPUT_PATH);
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (current === next) return { path: OUTPUT_PATH, changed: false, bytes: Buffer.byteLength(next) };
  if (check) {
    throw new Error(`${OUTPUT_PATH} is stale — run npm run build:llms-full`);
  }
  writeFileSync(path, next);
  return { path: OUTPUT_PATH, changed: true, bytes: Buffer.byteLength(next) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes('--check');
  try {
    const result = writeLlmsFull({ check });
    const kb = (result.bytes / 1000).toFixed(1);
    process.stdout.write(
      `${result.changed ? 'Wrote' : 'Unchanged'} ${result.path} (${kb} KB)\n`,
    );
  } catch (err) {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exit(1);
  }
}
