#!/usr/bin/env node
/**
 * Build-time docs page date manifest for the /docs JSON-LD rewrite.
 *
 * Mintlify serves docs HTML with no per-page dates, and routing middleware
 * cannot reach git history at request time — so Article publication and
 * modification dates come from this build-time map of each docs slug to its
 * first and latest git commit dates (YYYY-MM-DD).
 *
 * Slugs mirror Mintlify's path mapping: docs/architecture.mdx serves at
 * /docs/architecture and docs/zh/about.mdx at /docs/zh/about.
 *
 * Usage:
 *   npm run docs:dates          # regenerate src/config/docs-page-dates.generated.ts
 *   npm run docs:dates -- --fetch-history  # prepare a shallow web-build checkout
 *   npm run docs:dates:check    # validate the generated build output
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = 'src/config/docs-page-dates.generated.ts';
const CHECK = process.argv.includes('--check');
const FETCH_HISTORY = process.argv.includes('--fetch-history');

function listDocPages() {
  const pages = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${dir}/${entry.name}`);
      else if (entry.name.endsWith('.mdx')) {
        const file = `${dir}/${entry.name}`;
        pages.set(file.replace(/^docs\//, '').replace(/\.mdx$/, ''), file);
      }
    }
  };
  walk('docs');
  // Mintlify derives API page paths from each operation's tag and summary.
  // Read the configured sources so unlisted specs do not create phantom pages.
  const sources = new Set();
  const collectSources = (value) => {
    if (Array.isArray(value)) value.forEach(collectSources);
    else if (value && typeof value === 'object') {
      if (typeof value.openapi === 'string') sources.add(`docs/${value.openapi}`);
      Object.values(value).forEach(collectSources);
    }
  };
  collectSources(JSON.parse(readFileSync(join(ROOT, 'docs/docs.json'), 'utf8')));
  const slugify = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  for (const file of sources) {
    const spec = loadYaml(readFileSync(join(ROOT, file), 'utf8'));
    for (const paths of [spec.paths, spec.webhooks]) {
      for (const methods of Object.values(paths ?? {})) {
        for (const [method, operation] of Object.entries(methods)) {
          if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'].includes(method)) continue;
          const tag = operation.tags?.[0];
          const name = operation.summary || operation.operationId;
          if (!tag || !name) throw new Error(`docs page dates: missing API page tag or name in ${file}`);
          pages.set(`api-reference/${slugify(tag)}/${slugify(name)}`, file);
        }
      }
    }
  }
  return pages;
}

function commitDateRanges() {
  const isShallow = () => execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
    cwd: ROOT, encoding: 'utf8',
  }).trim() === 'true';
  if (isShallow() && FETCH_HISTORY) {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const remotes = execFileSync('git', ['remote'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n');
    let remote = 'origin';
    if (!remotes.includes(remote)) {
      const { VERCEL_GIT_PROVIDER: provider, VERCEL_GIT_REPO_OWNER: owner, VERCEL_GIT_REPO_SLUG: repo } = process.env;
      if (provider !== 'github' || !/^[a-z\d][a-z\d-]*$/i.test(owner ?? '') || !/^[a-z\d][a-z\d._-]*$/i.test(repo ?? '')) {
        throw new Error('docs page dates: no origin remote or valid Vercel GitHub repository identity');
      }
      remote = `https://github.com/${owner}/${repo}.git`;
    }
    execFileSync('git', ['fetch', '--unshallow', '--no-tags', '--filter=blob:none', '--no-write-fetch-head', remote, sha], {
      cwd: ROOT, stdio: 'pipe', timeout: 120_000,
    });
  }
  if (isShallow()) {
    throw new Error(
      'docs page dates need full git history (fetch-depth: 0); a shallow checkout resolves every file to HEAD',
    );
  }
  // One pass, newest-first: retain the latest date and walk back to publication.
  const output = execFileSync(
    'git',
    [
      'log',
      '--topo-order',
      '--date=format-local:%Y-%m-%d',
      '--format=COMMIT:%cd',
      '--name-only',
      '--',
      'docs/',
    ],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } },
  );
  const dates = new Map();
  let current = null;
  for (const line of output.split('\n')) {
    const commit = line.match(/^COMMIT:(\d{4}-\d{2}-\d{2})$/);
    if (commit) {
      current = commit[1];
      continue;
    }
    const file = line.trim();
    if (file && current) {
      const existing = dates.get(file);
      if (existing) existing.datePublished = current;
      else dates.set(file, { datePublished: current, dateModified: current });
    }
  }
  return dates;
}

function render(dates) {
  const entries = [...dates.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([slug, date]) => `  ${JSON.stringify(slug)}: ${JSON.stringify(date)},`);
  return [
    '// Generated by scripts/generate-docs-page-dates.mjs. Do not edit.',
    'export const DOCS_PAGE_DATES: Record<string, { datePublished: string; dateModified: string }> = {',
    ...entries,
    '};',
    '',
  ].join('\n');
}

const pages = listDocPages();
const commitDates = commitDateRanges();
const missing = [...new Set(pages.values())].filter((file) => !commitDates.has(file));
if (missing.length > 0) {
  throw new Error(
    `docs page dates missing git history for: ${missing.join(', ')}`,
  );
}
const dates = new Map(
  [...pages].map(([slug, file]) => [slug, commitDates.get(file)]),
);
const expected = render(dates);
const outputPath = join(ROOT, OUTPUT);
const actual = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : null;
if (actual === expected) {
  console.log(`docs page dates unchanged (${dates.size} pages)`);
} else if (CHECK) {
  throw new Error(`${OUTPUT} is stale — run npm run docs:dates`);
} else {
  writeFileSync(outputPath, expected);
  console.log(`docs page dates wrote ${dates.size} pages to ${OUTPUT}`);
}
