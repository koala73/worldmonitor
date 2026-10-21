#!/usr/bin/env node

/**
 * Read-only migration audit for release-pinned Sentry resolutions.
 *
 * The old stable browser release could not advance past SHA-named pins.
 * Browser and uploader release alignment addresses that mismatch for new
 * builds, but does not prove deployed Sentry regression handling or migrate
 * old tabs. Keep reporting every pin until the live acceptance procedure in
 * docs/solutions/workflow-issues/sentry-resolve-by-shipping-permanently-mutes-issues.md
 * passes and a compatibility-aware audit replaces this migration gate.
 * A pin is a review candidate, not proof that an issue cannot reopen.
 * Nothing here mutates Sentry or clears valid automatic resolutions.
 *
 * The API traps are encoded here rather than documented elsewhere:
 *
 *   1. `statsPeriod` is a closed set of '', '24h' and '14d'. A plausible '30d'
 *      or '90d' is rejected with HTTP 400 "Invalid stats_period". Probed
 *      2026-09-07: all three accepted values return the same 253 resolved
 *      issues, so the parameter gates the per-issue stats series and not the
 *      population. This sends '' because the audit reads no stats series.
 *   2. Pagination is driven by the `Link` response header, whose `rel="next"`
 *      entry is present on the LAST page too, carrying `results="false"`.
 *      Following `rel="next"` without reading `results` loops forever.
 *   3. `.env.local` holds a `sntrys_` release-scoped upload token, which
 *      returns 403 on the issues endpoint. Reading issues needs a `sntryu_`
 *      user token with `event:read` and `project:read`. A 403 is the expected
 *      first failure, so the error message names the fix.
 *
 * A live read that comes back with zero resolved issues fails rather than
 * reporting a clean board. A misconfigured org or project, or a token that
 * cannot see the project, produces exactly that empty list, and an audit whose
 * broken state is indistinguishable from its passing state protects nothing.
 *
 * A resolution is classified on which pin key `statusDetails` carries, never on
 * whether `statusDetails` is empty. Pinned rows also carry an `actor` object,
 * so an emptiness test would report every clean row as pinned the moment Sentry
 * starts attaching `actor` to plain resolves as well. For the same reason rows
 * whose `status` is not `resolved` are skipped rather than trusted from the
 * query string: an archived issue legitimately carries `statusDetails`, and
 * `archived_until_condition_met` populates `{ignoreCount, ignoreWindow}` that
 * an emptiness-based audit would flag as an intentional archive gone wrong.
 *
 * `statusDetails` on a pinned row contains the resolver's email, gravatar URL
 * and login timestamps. Only the short ID, permalink, pin kind and the
 * sanitized pin value ever reach the report.
 *
 * Run manually:
 *   node scripts/audit-sentry-resolve-pins.mjs
 *   node scripts/audit-sentry-resolve-pins.mjs --input fixture.json
 */

import { readFileSync } from 'node:fs';
import { parseArgs as parseNodeArgs } from 'node:util';

import { isMainModule } from './lib/main-module.mjs';

const SENTRY_HOST = 'https://us.sentry.io';
const DEFAULT_ORG = 'elie-habib';
const DEFAULT_PROJECT = 'worldmonitor';
const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const REQUEST_TIMEOUT_MS = 30_000;

function commitLike(value) {
  if (value && typeof value === 'object') {
    const id = value.id ?? value.sha ?? null;
    return id === null ? 'unknown commit' : String(id);
  }
  return String(value);
}

export const PIN_KINDS = Object.freeze([
  Object.freeze({
    kind: 'in-release',
    statusDetailsKey: 'inRelease',
    describe: (value) => `release ${String(value)}`,
  }),
  Object.freeze({
    kind: 'in-next-release',
    statusDetailsKey: 'inNextRelease',
    describe: (value) => (value === true ? 'the next release' : `next release ${String(value)}`),
  }),
  Object.freeze({
    kind: 'in-commit',
    statusDetailsKey: 'inCommit',
    describe: (value) => `commit ${commitLike(value)}`,
  }),
]);

export function parseLinkHeader(header) {
  if (typeof header !== 'string' || header.length === 0) return { next: null };
  for (const entry of header.split(/,\s*(?=<)/u)) {
    const [, url] = entry.match(/^\s*<([^>]+)>/u) ?? [];
    if (!url) continue;
    if (!/;\s*rel="next"/u.test(entry)) continue;
    if (!/;\s*results="true"/u.test(entry)) continue;
    return { next: url };
  }
  return { next: null };
}

export function classifyResolution(issue) {
  const statusDetails = issue?.statusDetails;
  if (statusDetails && typeof statusDetails === 'object') {
    for (const pin of PIN_KINDS) {
      const value = statusDetails[pin.statusDetailsKey];
      if (value === undefined || value === null) continue;
      return { kind: pin.kind, pinKey: pin.statusDetailsKey, pinValue: pin.describe(value) };
    }
  }
  return { kind: 'plain', pinKey: null, pinValue: null };
}

export function auditResolvedIssues(issues) {
  if (!Array.isArray(issues)) {
    throw new Error(
      'Expected an array of Sentry issues. A Sentry error body is an object, so coercing this '
        + 'to an empty list would report an authentication failure as a clean board.',
    );
  }
  const violations = [];
  let checked = 0;
  let skippedNonResolved = 0;

  for (const issue of issues) {
    if (issue?.status !== 'resolved') {
      skippedNonResolved += 1;
      continue;
    }
    checked += 1;
    const { kind, pinValue } = classifyResolution(issue);
    if (kind === 'plain') continue;
    violations.push({
      shortId: issue.shortId ?? null,
      id: issue.id ?? null,
      permalink: issue.permalink ?? null,
      kind,
      pinValue,
    });
  }

  return { checked, skippedNonResolved, violations };
}

export function formatReport(result) {
  const lines = [];
  if (result.violations.length === 0) {
    lines.push(`Sentry resolve pins clean: ${result.checked} resolved issues, all plain resolves.`);
  } else {
    lines.push(
      `Sentry resolve pins require review: ${result.violations.length} of ${result.checked} `
        + 'resolved issues are pinned; verify deployed release compatibility before repair.',
    );
    for (const violation of result.violations) {
      lines.push(`  ${violation.shortId ?? violation.id ?? 'unknown issue'}`
        + ` pinned to ${violation.pinValue} (${violation.kind})`);
      if (violation.permalink) lines.push(`    ${violation.permalink}`);
    }
  }
  if (result.skippedNonResolved > 0) {
    lines.push(`Skipped ${result.skippedNonResolved} issues that are not resolved.`);
  }
  return lines.join('\n');
}

export function formatRepairRecipe() {
  return [
    'Only repair a confirmed incompatible pin; preserve valid automatic resolutions.',
    'Check deployed release identity and recurrence evidence before changing status.',
    '  1. PUT status=unresolved on the issue.',
    '  2. GET the issue and confirm status is unresolved.',
    '  3. PUT status=resolved with no statusDetails.',
    '  4. GET the issue and confirm statusDetails has no release or commit pin keys.',
    'Step 1 is not optional. A resolved-to-resolved write silently no-ops and',
    'leaves the pin in place while reporting success.',
  ].join('\n');
}

export function assertLiveBoardIsNotEmpty(issues, org, project) {
  if (Array.isArray(issues) && issues.length > 0) return;
  throw new Error(
    `Sentry returned no resolved issues for ${org}/${project}. A project with history always `
      + 'has some, so this is a misread rather than a clean board: check SENTRY_ORG and '
      + 'SENTRY_PROJECT, and that the token can see this project. Reporting it clean would be '
      + 'the silent pass this audit exists to prevent.',
  );
}

export function parseArguments(argv) {
  const { values } = parseNodeArgs({
    args: argv,
    options: {
      input: { type: 'string' },
    },
    allowPositionals: false,
    strict: true,
  });
  return values;
}

export function issuesUrl(org, project) {
  const url = new URL(`${SENTRY_HOST}/api/0/projects/${org}/${project}/issues/`);
  url.searchParams.set('query', 'is:resolved');
  url.searchParams.set('limit', String(PAGE_SIZE));
  url.searchParams.set('statsPeriod', '');
  return url.toString();
}

// The cursor URL is echoed straight back from a response header and is then
// sent the bearer token, so it is pinned to the host we chose to trust.
function sameOriginCursor(next) {
  if (new URL(next).origin !== new URL(SENTRY_HOST).origin) {
    throw new Error(`Sentry pagination cursor left ${SENTRY_HOST}: ${new URL(next).origin}`);
  }
  return next;
}

export async function fetchResolvedIssues(token, org, project, fetchImpl = globalThis.fetch) {
  const issues = [];
  let url = issuesUrl(org, project);

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 403) {
      throw new Error(
        'Sentry returned 403 for the issues endpoint. A release-scoped `sntrys_` upload '
          + 'token cannot read issues, no matter which project it was minted for. Export a '
          + '`sntryu_` user token carrying `event:read` and `project:read` as SENTRY_AUTH_TOKEN '
          + '(or SENTRY_SESSION_TOKEN) and rerun.',
      );
    }
    if (!response.ok) {
      throw new Error(`Sentry issues request failed: HTTP ${response.status} ${response.statusText}`);
    }
    const batch = await response.json();
    if (!Array.isArray(batch)) throw new Error('Sentry issues response was not an array');
    issues.push(...batch);

    const { next } = parseLinkHeader(response.headers.get('link'));
    if (!next) {
      assertLiveBoardIsNotEmpty(issues, org, project);
      return issues;
    }
    url = sameOriginCursor(next);
  }

  throw new Error(`Sentry issues pagination exceeded ${MAX_PAGES} pages`);
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const org = process.env.SENTRY_ORG || DEFAULT_ORG;
  const project = process.env.SENTRY_PROJECT || DEFAULT_PROJECT;

  let issues;
  if (args.input) {
    issues = JSON.parse(readFileSync(args.input, 'utf8'));
  } else {
    const token = process.env.SENTRY_SESSION_TOKEN || process.env.SENTRY_AUTH_TOKEN;
    if (!token) {
      throw new Error(
        'Set SENTRY_AUTH_TOKEN (or SENTRY_SESSION_TOKEN) to a `sntryu_` user token with '
          + '`event:read` and `project:read`, or pass --input <path> to audit a saved payload.',
      );
    }
    issues = await fetchResolvedIssues(token, org, project);
  }

  const result = auditResolvedIssues(issues);
  console.log(formatReport(result));

  if (result.violations.length > 0) {
    for (const violation of result.violations) {
      console.error(
        `::error::${violation.shortId ?? violation.id} is resolved and pinned to `
          + `${violation.pinValue}; deployed release compatibility needs verification.`,
      );
    }
    console.error(formatRepairRecipe());
    process.exitCode = 1;
  }
}

const isMain = isMainModule(import.meta.url, process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(`Sentry resolve-pin audit failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
