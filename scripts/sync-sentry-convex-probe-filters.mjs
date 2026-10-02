#!/usr/bin/env node
/**
 * Generate and enforce Sentry `filters:error_messages` coverage for Convex
 * `internal*` probe noise.
 *
 * Convex answers `Could not find public function for 'X'` in two situations:
 *
 *   1. `X` is an `internal{Query,Mutation,Action}` — never client-callable.
 *      Probe or first-party bug. Safely enumerable from `convex/` source.
 *   2. `X` does not exist at all — probe OR genuine deploy skew where an old
 *      client calls a removed/renamed public function. Must keep reporting.
 *
 * Hand-listing tutorial module names (`tasks:*`, `messages:*`, …) is a
 * name-shaped allowlist treadmill: the next probe round uses our real module
 * names and nothing matches. This script derives case-1 patterns from source
 * and fails CI when the committed list drifts.
 *
 * Modes:
 *   --write   regenerate scripts/data/sentry-convex-internal-probe-filters.txt
 *   --check   fail when the committed list ≠ source (default for CI)
 *   --apply   read live Sentry options, merge (never wipe protected lines),
 *             PUT, read back to confirm
 *   --dry-run with --apply: print the merged string, do not PUT
 *
 * Auth for --apply:
 *   SENTRY_API_TOKEN / SENTRY_AUTH_TOKEN / SENTRY_SESSION_TOKEN — sntryu_
 *   user token with project:read + project:write
 *
 * API traps (bitten before):
 *   - `filters:error_messages` is NOT on `/filters/` (toggles only). Read/write
 *     via GET/PUT `/api/0/projects/{org}/{project}/` → options["filters:error_messages"]
 *   - The option is one newline-joined string. A naive write that sends only
 *     the generated patterns drops the incumbents (timeout + disconnect).
 *   - Relay matches each glob case-insensitively against `"<type>: <value>"`.
 *   - These events arrive with sdk.name = "convex", so browser ignoreErrors /
 *     beforeSend never see them.
 *   - Relay can take >1 min to pick up a PUT. A probe sent immediately after
 *     apply may still be accepted; wait, then confirm with event-id lookup
 *     (filtered → HTTP 404) rather than assuming the first sample.
 *   - `stats_v2` `filtered/error-message` is only visible when the request
 *     scopes `project=<numeric id>`; org-wide queries can omit that reason.
 *     Poll — the series lags ingestion by >1 min.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { isMainModule } from './lib/main-module.mjs';
import {
  convexMissingPublicFunctionPattern,
  listInternalMissingPublicFunctionPatterns,
  listPublicConvexFunctionExports,
} from './lib/convex-function-exports.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const CONVEX_ROOT = join(REPO_ROOT, 'convex');
const COMMITTED_LIST_PATH = join(
  REPO_ROOT,
  'scripts/data/sentry-convex-internal-probe-filters.txt',
);

const SENTRY_HOST = 'https://us.sentry.io';
const DEFAULT_ORG = 'elie-habib';
const DEFAULT_PROJECT = 'worldmonitor';
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Non-probe incumbents that must survive every apply. A naive replace that
 * drops these is the failure mode this merge exists to prevent.
 */
export const PROTECTED_ERROR_MESSAGE_FILTERS = Object.freeze([
  '*Your request timed out performing too many system operations*',
  'Error: Client disconnected',
]);

/**
 * Tutorial/template patterns from an earlier probe round. They name modules
 * we do not have; keep them out of the live filter once source-generated
 * patterns cover the real internal surface.
 */
export const LEGACY_TUTORIAL_PROBE_FILTERS = Object.freeze([
  "*Could not find public function for 'tasks:*",
  "*Could not find public function for 'messages:*",
  "*Could not find public function for 'posts:*",
  "*Could not find public function for 'items:*",
  "*Could not find public function for 'auth:*",
  "*Could not find public function for 'users:create'*",
]);

const CONVEX_MISSING_PUBLIC_RE =
  /^\*?Could not find public function for '/i;

/**
 * @param {string} text
 * @returns {string[]}
 */
export function splitErrorMessageFilters(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

/**
 * @param {string[]} lines
 * @returns {string}
 */
export function joinErrorMessageFilters(lines) {
  return `${lines.join('\n')}\n`;
}

/**
 * Merge live filters with source-generated internal patterns.
 *
 * - Generated internal patterns become the sole Convex "missing public
 *   function" cohort (legacy tutorial globs are dropped).
 * - Protected non-probe lines are always retained.
 * - Any other non-Convex-probe line from the live option is retained so an
 *   unrelated hand-added filter is not wiped by this sync.
 *
 * @param {string[]} currentLines
 * @param {string[]} generatedInternalPatterns
 * @returns {{ merged: string[], appended: string[], removed: string[], preservedOther: string[] }}
 */
export function mergeErrorMessageFilters(currentLines, generatedInternalPatterns) {
  const generatedSet = new Set(generatedInternalPatterns);
  const protectedSet = new Set(PROTECTED_ERROR_MESSAGE_FILTERS);
  const legacySet = new Set(LEGACY_TUTORIAL_PROBE_FILTERS);

  /** @type {string[]} */
  const preservedOther = [];
  /** @type {string[]} */
  const removed = [];

  for (const line of currentLines) {
    if (protectedSet.has(line)) continue;
    if (generatedSet.has(line)) continue;
    if (legacySet.has(line) || CONVEX_MISSING_PUBLIC_RE.test(line)) {
      removed.push(line);
      continue;
    }
    preservedOther.push(line);
  }

  const merged = [
    ...generatedInternalPatterns,
    ...PROTECTED_ERROR_MESSAGE_FILTERS,
    ...preservedOther,
  ];

  const currentSet = new Set(currentLines);
  const appended = generatedInternalPatterns.filter((line) => !currentSet.has(line));

  return { merged, appended, removed, preservedOther };
}

/**
 * Assert the safety half of the invariant: no *public* Convex function name
 * is covered by the generated internal filter set. A removed/renamed public
 * call must still report (deploy-skew visibility).
 *
 * @param {string} convexRoot
 * @param {string[]} internalPatterns
 */
export function assertPublicFunctionsRemainVisible(convexRoot, internalPatterns) {
  const patternSet = new Set(internalPatterns);
  const collisions = [];
  for (const entry of listPublicConvexFunctionExports(convexRoot)) {
    const pattern = convexMissingPublicFunctionPattern(entry.moduleRef, entry.name);
    if (patternSet.has(pattern)) {
      collisions.push(`${entry.moduleRef}:${entry.name}`);
    }
  }
  if (collisions.length > 0) {
    throw new Error(
      'Generated internal probe filters incorrectly cover public function(s): '
        + `${collisions.join(', ')}. Deploy-skew visibility for removed public `
        + 'names would be lost.',
    );
  }
}

/**
 * @param {string[]} patterns
 * @returns {string}
 */
export function formatCommittedFilterList(patterns) {
  const header = [
    '# Generated by scripts/sync-sentry-convex-probe-filters.mjs --write',
    '# Do not edit by hand. Source of truth: convex/ internal{Query,Mutation,Action} exports.',
    '# Each line is a Sentry filters:error_messages glob for case-1 Convex probe noise.',
    '# Public function names are intentionally absent — deploy-skew must still report.',
    '#',
  ];
  return `${header.join('\n')}\n${patterns.join('\n')}\n`;
}

/**
 * @param {string} text
 * @returns {string[]}
 */
export function parseCommittedFilterList(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * Derive the expected internal probe patterns from convex/ and assert no
 * public function name is covered.
 *
 * @param {string} [convexRoot]
 * @returns {string[]}
 */
export function expectedInternalPatternsFromSource(convexRoot = CONVEX_ROOT) {
  const patterns = listInternalMissingPublicFunctionPatterns(convexRoot);
  assertPublicFunctionsRemainVisible(convexRoot, patterns);
  return patterns;
}

/**
 * Parse CLI flags for `--check` / `--write` / `--apply` / `--dry-run` / `--help`.
 *
 * @param {string[]} argv
 * @returns {Record<string, boolean>}
 */
function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      check: { type: 'boolean', default: false },
      write: { type: 'boolean', default: false },
      apply: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  return values;
}

/**
 * Resolve a sntryu_ user token from the supported env vars.
 *
 * @returns {string}
 */
function resolveToken() {
  return (
    process.env.SENTRY_API_TOKEN
    || process.env.SENTRY_SESSION_TOKEN
    || process.env.SENTRY_AUTH_TOKEN
    || ''
  );
}

/**
 * GET project options from Sentry (includes `filters:error_messages`).
 *
 * @param {string} token
 * @param {string} org
 * @param {string} project
 * @returns {Promise<Record<string, unknown>>}
 */
async function fetchProjectOptions(token, org, project) {
  const url = `${SENTRY_HOST}/api/0/projects/${org}/${project}/`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GET ${url} failed: HTTP ${response.status}`
        + (body ? ` — ${body.slice(0, 300)}` : '')
        + (response.status === 403
          ? ' (need sntryu_ user token with project:read)'
          : ''),
    );
  }
  return /** @type {Record<string, unknown>} */ (await response.json());
}

/**
 * PUT `filters:error_messages` on the Sentry project (merge-safe caller must
 * pass the full newline-joined option string).
 *
 * @param {string} token
 * @param {string} org
 * @param {string} project
 * @param {string} filtersText
 * @returns {Promise<Record<string, unknown>>}
 */
async function putErrorMessageFilters(token, org, project, filtersText) {
  const url = `${SENTRY_HOST}/api/0/projects/${org}/${project}/`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      options: { 'filters:error_messages': filtersText },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `PUT ${url} failed: HTTP ${response.status}`
        + (body ? ` — ${body.slice(0, 300)}` : '')
        + (response.status === 403
          ? ' (need sntryu_ user token with project:write)'
          : ''),
    );
  }
  return /** @type {Record<string, unknown>} */ (await response.json());
}

/**
 * Regenerate the committed internal probe filter list from source.
 *
 * @param {string[]} patterns
 */
function runWrite(patterns) {
  mkdirSync(dirname(COMMITTED_LIST_PATH), { recursive: true });
  writeFileSync(COMMITTED_LIST_PATH, formatCommittedFilterList(patterns), 'utf8');
  console.log(
    `Wrote ${patterns.length} internal probe filter pattern(s) to `
      + `${relativeToRepo(COMMITTED_LIST_PATH)}`,
  );
}

/**
 * Fail when the committed filter list drifts from current convex/ internals.
 *
 * @param {string[]} patterns
 */
function runCheck(patterns) {
  let committedText;
  try {
    committedText = readFileSync(COMMITTED_LIST_PATH, 'utf8');
  } catch {
    throw new Error(
      `Missing ${relativeToRepo(COMMITTED_LIST_PATH)}. `
        + 'Run `npm run generate:sentry-convex-probe-filters`.',
    );
  }
  const committed = parseCommittedFilterList(committedText);
  const expected = patterns;
  const expectedSet = new Set(expected);
  const committedSet = new Set(committed);

  const missing = expected.filter((line) => !committedSet.has(line));
  const extra = committed.filter((line) => !expectedSet.has(line));

  if (missing.length === 0 && extra.length === 0) {
    console.log(
      `check:sentry-convex-probe-filters: PASS — ${expected.length} internal `
        + 'pattern(s) match source; public functions remain unfiltered.',
    );
    return;
  }

  const parts = [
    'Committed Sentry Convex probe filter list drifted from convex/ source.',
    `  File: ${relativeToRepo(COMMITTED_LIST_PATH)}`,
    '  Run: npm run generate:sentry-convex-probe-filters',
  ];
  if (missing.length > 0) {
    parts.push(`  Missing (${missing.length}):`);
    for (const line of missing.slice(0, 20)) parts.push(`    + ${line}`);
    if (missing.length > 20) parts.push(`    … and ${missing.length - 20} more`);
  }
  if (extra.length > 0) {
    parts.push(`  Extra (${extra.length}):`);
    for (const line of extra.slice(0, 20)) parts.push(`    - ${line}`);
    if (extra.length > 20) parts.push(`    … and ${extra.length - 20} more`);
  }
  throw new Error(parts.join('\n'));
}

/**
 * Merge generated patterns into live Sentry filters, PUT, and read back.
 *
 * @param {string[]} patterns
 * @param {{ dryRun: boolean }} opts
 */
async function runApply(patterns, opts) {
  const token = resolveToken();
  if (!token) {
    throw new Error(
      'Set SENTRY_API_TOKEN (or SENTRY_AUTH_TOKEN / SENTRY_SESSION_TOKEN) to a '
        + 'sntryu_ user token with project:read and project:write.',
    );
  }
  const org = process.env.SENTRY_ORG || DEFAULT_ORG;
  const project = process.env.SENTRY_PROJECT || DEFAULT_PROJECT;

  const before = await fetchProjectOptions(token, org, project);
  const options = /** @type {Record<string, unknown>} */ (before.options ?? {});
  const currentText =
    typeof options['filters:error_messages'] === 'string'
      ? options['filters:error_messages']
      : '';
  const currentLines = splitErrorMessageFilters(currentText);
  const { merged, appended, removed, preservedOther } = mergeErrorMessageFilters(
    currentLines,
    patterns,
  );
  const mergedText = joinErrorMessageFilters(merged);

  console.log(`Sentry project ${org}/${project}`);
  console.log(`  current lines: ${currentLines.length}`);
  console.log(`  generated internal patterns: ${patterns.length}`);
  console.log(`  to append: ${appended.length}`);
  console.log(`  to remove (legacy/stale Convex probe): ${removed.length}`);
  console.log(`  preserved other: ${preservedOther.length}`);

  for (const line of PROTECTED_ERROR_MESSAGE_FILTERS) {
    if (!merged.includes(line)) {
      throw new Error(`Merge dropped protected filter: ${line}`);
    }
  }

  if (opts.dryRun) {
    console.log('--dry-run: skipping PUT. Merged filters:\n');
    console.log(mergedText);
    return;
  }

  await putErrorMessageFilters(token, org, project, mergedText);

  const after = await fetchProjectOptions(token, org, project);
  const afterOptions = /** @type {Record<string, unknown>} */ (after.options ?? {});
  const readBack =
    typeof afterOptions['filters:error_messages'] === 'string'
      ? afterOptions['filters:error_messages']
      : '';
  const readBackLines = splitErrorMessageFilters(readBack);
  const readBackSet = new Set(readBackLines);

  const missingAfter = patterns.filter((line) => !readBackSet.has(line));
  const missingProtected = PROTECTED_ERROR_MESSAGE_FILTERS.filter(
    (line) => !readBackSet.has(line),
  );
  if (missingAfter.length > 0 || missingProtected.length > 0) {
    throw new Error(
      'Read-back after PUT did not confirm expected filters.\n'
        + (missingAfter.length
          ? `  missing generated: ${missingAfter.slice(0, 5).join(' | ')}\n`
          : '')
        + (missingProtected.length
          ? `  missing protected: ${missingProtected.join(' | ')}\n`
          : ''),
    );
  }

  const leftoverLegacy = LEGACY_TUTORIAL_PROBE_FILTERS.filter((line) =>
    readBackSet.has(line),
  );
  if (leftoverLegacy.length > 0) {
    throw new Error(
      'Read-back still contains legacy tutorial probe filters:\n  '
        + leftoverLegacy.join('\n  '),
    );
  }

  console.log(
    `apply: PASS — read-back has ${patterns.length} internal pattern(s) and `
      + 'both protected non-probe lines; legacy tutorial patterns removed.',
  );
}

/**
 * Return `absPath` relative to the repo root when possible.
 *
 * @param {string} absPath
 * @returns {string}
 */
function relativeToRepo(absPath) {
  return absPath.startsWith(`${REPO_ROOT}/`)
    ? absPath.slice(REPO_ROOT.length + 1)
    : absPath;
}

/**
 * CLI entrypoint: default `--check`, or `--write` / `--apply`.
 *
 * @param {string[]} [argv]
 */
async function main(argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv);
  if (args.help) {
    console.log(`Usage:
  node scripts/sync-sentry-convex-probe-filters.mjs --check
  node scripts/sync-sentry-convex-probe-filters.mjs --write
  node scripts/sync-sentry-convex-probe-filters.mjs --apply [--dry-run]

Default with no flags: --check`);
    return;
  }

  const modeCount = [args.check, args.write, args.apply].filter(Boolean).length;
  if (modeCount > 1) {
    throw new Error('Pass only one of --check, --write, --apply');
  }
  const mode = args.write ? 'write' : args.apply ? 'apply' : 'check';

  const patterns = expectedInternalPatternsFromSource();
  if (patterns.length === 0) {
    throw new Error('No internal* Convex exports found under convex/ — refusing to proceed.');
  }

  if (mode === 'write') {
    runWrite(patterns);
    return;
  }
  if (mode === 'check') {
    runCheck(patterns);
    return;
  }
  await runApply(patterns, { dryRun: Boolean(args['dry-run']) });
}

const isMain = isMainModule(import.meta.url, process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  });
}
