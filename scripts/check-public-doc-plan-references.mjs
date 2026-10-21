#!/usr/bin/env node
/**
 * Internal planning documents must never be reachable from public Mintlify
 * content. Gitignore does not protect already-tracked plans, so enforce the
 * boundary at the documentation publication surface.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(SCRIPT_DIR, '..', 'docs');
const MINTLIFY_IGNORE_FILE = '.mintignore';
const REQUIRED_IGNORES = ['plans/', 'internal/'];
const PLAN_REFERENCE_PATTERN = /(?:(?:^|[^A-Za-z0-9_-])docs\/|(?:\.\.\/)+|\.\/|(?:^|[^A-Za-z0-9_-]))plans\//i;

function decodePercentEscape(encodedSequence) {
  try {
    return decodeURIComponent(encodedSequence);
  } catch {
    return encodedSequence;
  }
}

function normalizeReferenceText(text) {
  return text
    .replace(/%[0-9A-F]{2}/gi, decodePercentEscape)
    .replaceAll('\\', '/');
}

export function findPublicPlanReferences(content) {
  const references = [];

  for (const [index, line] of content.split('\n').entries()) {
    const text = line.trim();
    if (PLAN_REFERENCE_PATTERN.test(normalizeReferenceText(text))) {
      references.push({ line: index + 1, text });
    }
  }

  return references;
}

function readIgnoreEntries(docsDir) {
  const violations = [];
  const path = join(docsDir, MINTLIFY_IGNORE_FILE);
  let entries;

  try {
    entries = readFileSync(path, 'utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    violations.push(`docs/${MINTLIFY_IGNORE_FILE}: missing required Mintlify ignore file`);
    entries = [];
  }

  for (const entry of REQUIRED_IGNORES) {
    if (!entries.includes(entry)) {
      violations.push(`docs/${MINTLIFY_IGNORE_FILE}: must ignore ${entry}`);
    }
  }
  for (const entry of entries) {
    const reIncludedDirectory = REQUIRED_IGNORES.find(required =>
      entry.startsWith(`!${required}`) || entry.startsWith(`!/${required}`),
    );
    if (reIncludedDirectory) {
      violations.push(
        `docs/${MINTLIFY_IGNORE_FILE}: must not re-include ${reIncludedDirectory} content: ${entry}`,
      );
    }
  }

  return { entries, violations };
}

function isIgnored(path, ignoredEntries) {
  return ignoredEntries.some(entry => entry.endsWith('/')
    ? path.startsWith(entry)
    : path === entry);
}

function collectPublicDocFiles(directory, docsDir, ignoredEntries, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const docsPath = relative(docsDir, path).replaceAll('\\', '/');
    if (isIgnored(docsPath, ignoredEntries)) continue;

    if (entry.isDirectory()) {
      collectPublicDocFiles(path, docsDir, ignoredEntries, files);
    } else if (['.md', '.mdx'].includes(extname(entry.name))) {
      files.push({ path, docsPath });
    }
  }
  return files;
}

export function findPublicDocumentationViolations(docsDir = DOCS_DIR) {
  const { entries, violations } = readIgnoreEntries(docsDir);

  for (const { path, docsPath } of collectPublicDocFiles(docsDir, docsDir, entries)) {
    for (const reference of findPublicPlanReferences(readFileSync(path, 'utf8'))) {
      violations.push(`docs/${docsPath}:${reference.line}: references internal planning content: ${reference.text}`);
    }
  }

  return violations;
}

export function inspectDocumentationPublication(docsDir = DOCS_DIR) {
  const { entries, violations } = readIgnoreEntries(docsDir);
  for (const entry of entries) {
    if (/[!*?\[\]\\]/.test(entry) || entry.startsWith('/')) {
      violations.push(`docs/.mintignore: coverage check requires literal relative files or directories: ${entry}`);
    }
  }
  const config = JSON.parse(readFileSync(join(docsDir, 'docs.json'), 'utf8'));
  if (config.seo?.indexing === 'all') {
    violations.push('docs/docs.json: classify public pages in navigation instead of enabling seo.indexing: all');
  }
  const navigation = new Map();
  function collectPages(node, indexed = true) {
    if (Array.isArray(node)) {
      for (const child of node) collectPages(child, indexed);
    } else if (node && typeof node === 'object') {
      const visible = indexed && (node.hidden !== true || node.searchable === true);
      for (const page of node.pages ?? []) {
        if (typeof page === 'string') navigation.set(page, visible);
      }
      for (const child of Object.values(node)) collectPages(child, visible);
    }
  }
  collectPages(config.navigation);
  const documents = collectPublicDocFiles(docsDir, docsDir, []).map(({ path, docsPath }) => {
    const content = readFileSync(path, 'utf8');
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? '';
    const noindex = /^(?:noindex|hidden):\s*true\s*(?:#.*)?$/m.test(frontmatter);
    const slug = docsPath.replace(/\.mdx?$/, '');
    const status = isIgnored(docsPath, entries) ? 'excluded'
      : noindex ? 'noindex'
        : navigation.get(slug) ? 'public' : 'unclassified';
    if (status === 'unclassified') {
      violations.push(`docs/${docsPath}: add to navigation, set noindex: true, or exclude in .mintignore`);
    }
    if (status === 'excluded' && navigation.has(slug)) {
      violations.push(`docs/${docsPath}: excluded page is still in navigation`);
    }
    return { path: docsPath, status };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const sourceSlugs = new Set(documents.map(doc => doc.path.replace(/\.mdx?$/, '')));
  for (const slug of navigation.keys()) {
    if (!sourceSlugs.has(slug) && !/^https?:\/\//.test(slug)) {
      violations.push(`docs/docs.json: navigation page has no Markdown source: ${slug}`);
    }
  }
  return { documents, violations };
}

function main() {
  const publication = inspectDocumentationPublication();
  if (process.argv.includes('--inventory')) {
    console.log(JSON.stringify(publication, null, 2));
    process.exitCode = publication.violations.length ? 1 : 0;
    return;
  }
  const violations = [...findPublicDocumentationViolations(), ...publication.violations];
  if (violations.length > 0) {
    console.error('Public documentation publication check FAILED:');
    for (const violation of violations) console.error(`  - ${violation}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Public documentation publication check passed (${publication.documents.length} documents classified).`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
