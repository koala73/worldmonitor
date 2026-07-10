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

function main() {
  const violations = findPublicDocumentationViolations();
  if (violations.length > 0) {
    console.error('Public documentation plan-reference check FAILED:');
    for (const violation of violations) console.error(`  - ${violation}`);
    process.exitCode = 1;
    return;
  }

  console.log('Public documentation plan-reference check passed.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
