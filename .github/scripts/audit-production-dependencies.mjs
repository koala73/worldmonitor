#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SEVERITY_RANK = new Map([
  ['info', 0],
  ['low', 1],
  ['moderate', 2],
  ['high', 3],
  ['critical', 4],
]);

/**
 * Days an advisory the repo INHERITED (i.e. nobody's PR introduced it) may warn
 * before it starts blocking. See the verdict table in classifyAudit().
 */
export const DEFAULT_GRACE_DAYS = 7;

const DAY_MS = 86_400_000;

/**
 * Accepted-risk suppressions, per lockfile.
 *
 * Every entry MUST carry `reason` (why this is not exploitable here) and
 * `expiresAt` (when the reasoning must be re-checked). validateBaselineEntries()
 * enforces both, so a suppression cannot be added without a justification or an
 * end date — the two things the previous flat `['GHSA-…']` array let authors
 * skip, which is how three dead entries accumulated under pro-test.
 *
 * An entry that outlives `expiresAt`, or whose advisory stops being reported at
 * all, FAILS the gate. Suppressions are leases, not grants.
 */
export const BASELINE_ADVISORIES_BY_LOCKFILE = {
  'package-lock.json': [
    {
      id: 'GHSA-f88m-g3jw-g9cj',
      expiresAt: '2026-11-05',
      reason:
        'sharp inherited libvips decode CVEs need attacker-crafted image BYTES fed to sharp. Neither root chain decodes untrusted input: @vercel/og\'s sharp only converts satori-rendered first-party buffers (brief carousel), and @xenova/transformers is consumed solely by the browser ML worker (src/workers/ml.worker.ts) — its Node-only sharp binary never executes server-side. The clean fix (sharp 0.35.x) is semver-major across both chains; baselined until the parents bump.',
    },
    {
      id: 'GHSA-5p2g-fcmc-qvqq',
      expiresAt: '2026-11-05',
      reason:
        'image-size JXL/HEIF infinite-loop DoS needs attacker-supplied image bytes parsed by image-size. Both root chains are inert here: metro (via @clerk/clerk-js -> solana wallet adapters -> react-native) is React Native\'s bundler and never executes in this web app, and texture-compressor (via deck.gl -> @loaders.gl/textures) is a Node build-time CLI the browser bundle never invokes — no untrusted bytes ever reach either copy. No patched release exists (every version <= 2.0.2 is affected, first_patched_version is null), so there is nothing to bump; drop when a fixed image-size ships or a parent sheds the dependency.',
    },
    {
      id: 'GHSA-w3rx-r6r6-pgpr',
      expiresAt: '2026-11-05',
      reason:
        'image-size ICNS infinite-loop DoS — same two inert transitive chains as GHSA-5p2g-fcmc-qvqq (metro under react-native, texture-compressor under @loaders.gl/textures), neither of which parses untrusted input in this web app. No patched release exists (<= 2.0.2 affected, first_patched_version null); re-review with its sibling entry when a fix ships.',
    },
  ],
  'consumer-prices-core/package-lock.json': [],
  'blog-site/package-lock.json': [],
  'pro-test/package-lock.json': [
    {
      id: 'GHSA-395f-4hp3-45gv',
      expiresAt: '2026-11-05',
      reason:
        'shell-quote quadratic-complexity DoS in parse() reaches pro-test only via react-native -> react-devtools-core, a mobile/dev-tooling chain the Vite web build never bundles into public/pro/. The parse() DoS is unreachable from the shipped browser bundle, and forcing shell-quote up (an `overrides` pin bump) would drag an otherwise-untouched public/pro/ rebuild into a lockfile-hygiene change. Drop once react-native leaves pro-test\'s tree.',
    },
    {
      id: 'GHSA-5p2g-fcmc-qvqq',
      expiresAt: '2026-11-05',
      reason:
        'image-size JXL/HEIF infinite-loop DoS reaches pro-test only via metro under the same react-native mobile/dev-tooling chain as GHSA-395f-4hp3-45gv — never bundled into public/pro/, never fed untrusted image bytes. No patched release exists (every version <= 2.0.2 affected, first_patched_version null), so there is nothing to bump; drop when a fixed image-size ships or react-native leaves pro-test\'s tree.',
    },
    {
      id: 'GHSA-w3rx-r6r6-pgpr',
      expiresAt: '2026-11-05',
      reason:
        'image-size ICNS infinite-loop DoS — same inert metro/react-native dev-tooling chain as its sibling GHSA-5p2g-fcmc-qvqq, unreachable from the shipped public/pro/ bundle. No patched release exists (<= 2.0.2 affected, first_patched_version null); re-review with the sibling entry when a fix ships.',
    },
  ],
  'scripts/package-lock.json': [],
  'docker/runtime-package-lock.json': [],
};

/**
 * Reject a suppression that cannot be audited later: no id, no stated reason, or
 * a missing/unparseable expiry. Runs on every invocation so a malformed entry
 * fails the gate that owns it rather than silently suppressing an advisory.
 */
export function validateBaselineEntries(baseline = BASELINE_ADVISORIES_BY_LOCKFILE) {
  for (const [lockfile, entries] of Object.entries(baseline)) {
    if (!Array.isArray(entries)) {
      throw new Error(`Baseline for ${lockfile} must be an array of entries.`);
    }
    for (const entry of entries) {
      if (!entry?.id || !/^GHSA-[a-z0-9-]+$/i.test(String(entry.id))) {
        throw new Error(`Baseline entry for ${lockfile} needs a GHSA id (got ${JSON.stringify(entry?.id)}).`);
      }
      if (!entry.reason || String(entry.reason).trim().length < 20) {
        throw new Error(`Baseline entry ${entry.id} (${lockfile}) needs a substantive \`reason\`.`);
      }
      if (!Number.isFinite(Date.parse(entry.expiresAt))) {
        throw new Error(
          `Baseline entry ${entry.id} (${lockfile}) needs an ISO \`expiresAt\` (got ${JSON.stringify(entry.expiresAt)}).`,
        );
      }
    }
  }
  return true;
}

export function baselineEntriesFor(lockfile, baseline = BASELINE_ADVISORIES_BY_LOCKFILE) {
  return baseline[lockfile] ?? [];
}

export function isBaselineExpired(entry, now = Date.now()) {
  return Date.parse(entry.expiresAt) < now;
}

function severityRank(severity) {
  return SEVERITY_RANK.get(String(severity ?? '').toLowerCase()) ?? -1;
}

function advisoryId(advisory) {
  const urlId = String(advisory.url ?? '').match(/GHSA-[a-z0-9-]+/i)?.[0];
  if (urlId) return urlId;
  if (advisory.source) return String(advisory.source);
  return `${advisory.name ?? 'unknown'}:${advisory.title ?? 'untitled'}`;
}

export function collectAuditFindings(report, auditLevel = 'high') {
  const findings = new Map();

  for (const vulnerability of Object.values(report?.vulnerabilities ?? {})) {
    for (const via of vulnerability?.via ?? []) {
      if (!via || typeof via !== 'object') continue;

      const severity = via.severity ?? vulnerability.severity;
      if (severityRank(severity) < severityRank(auditLevel)) continue;

      const id = advisoryId(via);
      const name = via.name ?? vulnerability.name ?? 'unknown';
      const key = `${id}:${name}`;
      findings.set(key, {
        id,
        name,
        severity,
        title: via.title ?? 'Untitled advisory',
        url: via.url ?? '',
      });
    }
  }

  return [...findings.values()].sort((a, b) => `${a.id}:${a.name}`.localeCompare(`${b.id}:${b.name}`));
}

export function collectUnbaselinedFindings(report, lockfile, auditLevel = 'high') {
  const baseline = new Set(baselineEntriesFor(lockfile).map((entry) => entry.id));
  return collectAuditFindings(report, auditLevel).filter((finding) => !baseline.has(finding.id));
}

export function collectAdvisoryIds(report) {
  const ids = new Set();
  for (const vulnerability of Object.values(report?.vulnerabilities ?? {})) {
    for (const via of vulnerability?.via ?? []) {
      if (!via || typeof via !== 'object') continue;
      ids.add(advisoryId(via));
    }
  }
  return ids;
}

export function collectStaleBaselineEntries(report, lockfile) {
  const present = collectAdvisoryIds(report);
  return baselineEntriesFor(lockfile)
    .filter((entry) => !present.has(entry.id))
    .map((entry) => entry.id);
}

/**
 * Sort every high+ finding into exactly one verdict.
 *
 *   baselined, unexpired          -> suppressed  (info)
 *   baselined, past expiresAt     -> blocking    ("re-review the suppression")
 *   introduced by THIS change     -> blocking    (the author can fix it)
 *   inherited, inside grace       -> deferred    (warn + countdown)
 *   inherited, past grace         -> blocking    (the deadline arrived)
 *   inherited, publish date unknown -> deferred  (upgraded to blocking under --fail-on-outage)
 *
 * The split exists because the old gate collapsed three unrelated events —
 * "you added a vulnerable dependency", "the world published an advisory against
 * a lockfile you did not touch", and "CI could not reach the registry" — into a
 * single red that blocked every open PR. Only the first is actor-fixable, and
 * making the other two block is what generated the pressure to paper over
 * findings with permanent baseline entries.
 *
 * Grace is measured from the advisory's OWN publication date, not from when CI
 * first noticed it, so the clock cannot be reset by re-running a job and needs
 * no state persisted in the repo.
 */
export function classifyAudit({
  findings,
  lockfile,
  presentAdvisoryIds = new Set(),
  introducedIds = new Set(),
  publishedAt = new Map(),
  now = Date.now(),
  graceDays = DEFAULT_GRACE_DAYS,
  baseline = BASELINE_ADVISORIES_BY_LOCKFILE,
}) {
  const entries = baselineEntriesFor(lockfile, baseline);
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));

  const suppressed = [];
  const deferred = [];
  const blocking = [];

  for (const finding of findings) {
    const entry = entryById.get(finding.id);

    if (entry) {
      if (isBaselineExpired(entry, now)) {
        blocking.push({ ...finding, verdict: 'baseline-expired', expiresAt: entry.expiresAt });
      } else {
        suppressed.push({ ...finding, verdict: 'suppressed', expiresAt: entry.expiresAt, reason: entry.reason });
      }
      continue;
    }

    if (introducedIds.has(finding.id)) {
      blocking.push({ ...finding, verdict: 'introduced' });
      continue;
    }

    const published = publishedAt.get(finding.id);
    const publishedMs = published ? Date.parse(published) : Number.NaN;
    if (!Number.isFinite(publishedMs)) {
      deferred.push({ ...finding, verdict: 'grace-unknown' });
      continue;
    }

    const deadline = publishedMs + graceDays * DAY_MS;
    if (now < deadline) {
      deferred.push({ ...finding, verdict: 'grace', deadline, publishedAt: published });
    } else {
      blocking.push({ ...finding, verdict: 'grace-expired', deadline, publishedAt: published });
    }
  }

  // A suppression whose advisory stopped being reported has outlived its cause.
  const stale = entries.filter((entry) => !presentAdvisoryIds.has(entry.id));

  return { blocking, deferred, suppressed, stale, lockfile };
}

function describeFinding(finding) {
  const suffix = finding.url ? ` (${finding.url})` : '';
  return `${finding.severity} ${finding.id} ${finding.name}: ${finding.title}${suffix}`;
}

function formatDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Pure renderer for one audit run. Split from main() so the ORDER of the report
 * — actionable findings BEFORE any terminal condition — is testable without a
 * network round trip, matching formatAcceptanceReport() in
 * scripts/check-seed-freshness.mjs.
 */
export function formatAuditReport(
  { blocking, deferred, suppressed, stale, lockfile },
  { failOnOutage = false, now = Date.now() } = {},
) {
  const info = [];
  const errors = [];

  for (const finding of suppressed) {
    info.push(
      `::warning title=Baselined production advisory::${describeFinding(finding)} — suppressed until ${finding.expiresAt}.`,
    );
  }

  const unresolvedOutage = deferred.filter((finding) => finding.verdict === 'grace-unknown');
  const counting = deferred.filter((finding) => finding.verdict === 'grace');

  for (const finding of counting) {
    const daysLeft = Math.max(0, Math.ceil((finding.deadline - now) / DAY_MS));
    info.push(
      `::warning title=Inherited production advisory (grace)::${describeFinding(finding)} — published ${finding.publishedAt?.slice(0, 10)}, BLOCKS every build from ${formatDate(finding.deadline)} (${daysLeft} day(s) left). Fix it before then; no PR is blocked by it today.`,
    );
  }

  for (const finding of unresolvedOutage) {
    const line = `${describeFinding(finding)} — publication date unavailable, so its grace deadline could not be computed.`;
    if (failOnOutage) errors.push(`::error title=Advisory age unknown::${line}`);
    else info.push(`::warning title=Advisory age unknown::${line}`);
  }

  if (blocking.length > 0) {
    errors.push(`Production audit FAILED for ${lockfile}: ${blocking.length} blocking advisory/advisories.`);
    for (const finding of blocking) {
      if (finding.verdict === 'introduced') {
        errors.push(`::error title=Advisory introduced by this change::${describeFinding(finding)} — this change adds it; it did not exist on the base branch.`);
      } else if (finding.verdict === 'baseline-expired') {
        errors.push(`::error title=Baseline suppression expired::${describeFinding(finding)} — the suppression lapsed on ${finding.expiresAt}. Re-review it in BASELINE_ADVISORIES_BY_LOCKFILE and set a new expiresAt, or fix the dependency.`);
      } else {
        errors.push(`::error title=Grace period expired::${describeFinding(finding)} — published ${finding.publishedAt?.slice(0, 10)}, grace ended ${formatDate(finding.deadline)}.`);
      }
    }
  }

  if (stale.length > 0) {
    errors.push(
      `Production audit FAILED for ${lockfile}: ${stale.length} baseline entry/entries no longer match any advisory.`,
    );
    for (const entry of stale) {
      errors.push(
        `::error title=Stale baseline entry::${entry.id} is baselined for ${lockfile} but matched no current advisory. Delete it from BASELINE_ADVISORIES_BY_LOCKFILE — this is a one-line change.`,
      );
    }
  }

  if (errors.length === 0) {
    info.push(
      `Production audit OK for ${lockfile}: ${blocking.length} blocking, ${counting.length} in grace, ${suppressed.length} baselined.`,
    );
  }

  return { info, errors, failed: errors.length > 0 };
}

/**
 * Best available human-readable reason from a failed `npm audit --json`.
 *
 * npm returns `{"error": {"summary": "", "detail": ""}}` — EMPTY STRINGS, not
 * null — when the advisories endpoint misbehaves, and puts the only useful text
 * in the top-level `message`. `??` only falls through on null/undefined, so the
 * previous `summary ?? detail ?? fallback` threw `Error("")` and the gate went
 * red printing a single blank line. Pick the first NON-EMPTY value instead.
 */
export function resolveAuditErrorMessage(report, workspace) {
  const candidates = [report?.error?.summary, report?.error?.detail, report?.message];
  const found = candidates.find((value) => typeof value === 'string' && value.trim().length > 0);
  return found?.trim() ?? `npm audit failed for ${workspace}`;
}

/**
 * Whether the audit failed because the REGISTRY could not be reached or its
 * response was unusable — i.e. nothing an author of this PR can fix.
 *
 * Observed 2026-07-26: registry.npmjs.org's
 * `/-/npm/v1/security/advisories/bulk` served a gzip body npm could not parse
 * (the gzip magic number where JSON was expected), failing every audit
 * repo-wide. The same commit passed 7 hours earlier, so the lockfile was not
 * the variable; only the live advisory database was.
 */
export function isUpstreamAuditOutage(report) {
  const text = [report?.error?.summary, report?.error?.detail, report?.message]
    .filter((value) => typeof value === 'string')
    .join(' ');
  if (!text.trim()) return false;
  return (
    /security\/advisories\/bulk/i.test(text) ||
    /audit endpoint returned an error/i.test(text) ||
    /invalid json response body/i.test(text) ||
    /(ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network timeout)/i.test(text) ||
    /\b(502|503|504)\b/.test(text)
  );
}

function parseArgs(argv) {
  const args = {
    auditLevel: 'high',
    workspace: '.',
    packageJson: '',
    lockfile: '',
    baseRef: process.env.AUDIT_BASE_REF ?? '',
    graceDays: Number(process.env.AUDIT_GRACE_DAYS ?? DEFAULT_GRACE_DAYS),
    statusFile: process.env.AUDIT_STATUS_FILE ?? '',
    // A registry outage is not an actor-fixable defect, so by default it warns
    // loudly and exits 0 rather than bricking every merge on npm's uptime.
    // Set --fail-on-outage (or AUDIT_FAIL_ON_OUTAGE=1) where a missed audit is
    // less acceptable than a blocked pipeline, e.g. the scheduled sweep.
    failOnOutage: process.env.AUDIT_FAIL_ON_OUTAGE === '1',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--audit-level') args.auditLevel = argv[++i] ?? args.auditLevel;
    else if (arg === '--workspace') args.workspace = argv[++i] ?? args.workspace;
    else if (arg === '--package-json') args.packageJson = argv[++i] ?? args.packageJson;
    else if (arg === '--lockfile') args.lockfile = argv[++i] ?? args.lockfile;
    else if (arg === '--base-ref') args.baseRef = argv[++i] ?? args.baseRef;
    else if (arg === '--grace-days') args.graceDays = Number(argv[++i] ?? args.graceDays);
    else if (arg === '--status-file') args.statusFile = argv[++i] ?? args.statusFile;
    else if (arg === '--fail-on-outage') args.failOnOutage = true;
  }

  if (!args.lockfile) {
    throw new Error(
      'Usage: audit-production-dependencies.mjs --workspace <path> [--package-json <package.json>] --lockfile <package-lock.json> [--base-ref <ref>]',
    );
  }
  args.packageJson ||= `${args.workspace.replace(/\/$/, '')}/package.json`;
  if (!Number.isFinite(args.graceDays) || args.graceDays < 0) args.graceDays = DEFAULT_GRACE_DAYS;

  return args;
}

function resolveAuditWorkspace({ workspace, packageJson, lockfile }) {
  const workspacePackageJson = resolve(workspace, 'package.json');
  const workspaceLockfile = resolve(workspace, 'package-lock.json');

  if (packageJson === workspacePackageJson && lockfile === workspaceLockfile) {
    return {
      cwd: workspace,
      cleanup: () => {},
    };
  }

  const auditDir = mkdtempSync(join(tmpdir(), 'worldmonitor-security-audit-'));
  copyFileSync(packageJson, join(auditDir, 'package.json'));
  copyFileSync(lockfile, join(auditDir, 'package-lock.json'));

  return {
    cwd: auditDir,
    cleanup: () => rmSync(auditDir, { recursive: true, force: true }),
  };
}

function runNpmAudit(cwd, workspace) {
  const result = spawnSync('npm', ['audit', '--omit=dev', '--json'], { cwd, encoding: 'utf8' });
  const json = result.stdout.trim();

  if (!json) {
    process.stderr.write(result.stderr);
    const failure = new Error(`npm audit did not return JSON for ${workspace}`);
    // npm writes transport diagnostics to stderr, so classify from there.
    failure.upstreamOutage = isUpstreamAuditOutage({ message: result.stderr ?? '' });
    throw failure;
  }

  let report;
  try {
    report = JSON.parse(json);
  } catch (error) {
    process.stderr.write(result.stderr);
    const failure = new Error(`Could not parse npm audit JSON for ${workspace}: ${error.message}`);
    failure.upstreamOutage = isUpstreamAuditOutage({ message: result.stderr ?? '' });
    throw failure;
  }

  if (report.error) {
    const failure = new Error(resolveAuditErrorMessage(report, workspace));
    failure.upstreamOutage = isUpstreamAuditOutage(report);
    throw failure;
  }

  return report;
}

function readAuditReport({ workspace, packageJson, lockfile }) {
  const auditWorkspace = resolveAuditWorkspace({ workspace, packageJson, lockfile });
  try {
    return runNpmAudit(auditWorkspace.cwd, workspace);
  } finally {
    auditWorkspace.cleanup();
  }
}

function git(args) {
  return spawnSync('git', args, { encoding: 'utf8' });
}

/**
 * Advisory ids this change ADDS relative to `baseRef`.
 *
 * Short-circuits when the lockfile is byte-identical to the base: an unchanged
 * lockfile cannot introduce anything, so the (slow) second npm audit is skipped
 * for the overwhelming majority of PRs, which touch no dependencies at all.
 */
export function collectIntroducedIds({ baseRef, lockfile, packageJson, headFindings, auditLevel = 'high' }) {
  if (!baseRef) return new Set();

  const unchanged = git(['diff', '--quiet', baseRef, '--', lockfile]);
  if (unchanged.status === 0) return new Set();

  const baseLock = git(['show', `${baseRef}:${lockfile}`]);
  const basePackage = git(['show', `${baseRef}:${packageJson}`]);
  // A lockfile that did not exist on the base branch is entirely new: every
  // finding in it is introduced here.
  if (baseLock.status !== 0 || basePackage.status !== 0) {
    return new Set(headFindings.map((finding) => finding.id));
  }

  const baseDir = mkdtempSync(join(tmpdir(), 'worldmonitor-security-audit-base-'));
  try {
    writeFileSync(join(baseDir, 'package.json'), basePackage.stdout);
    writeFileSync(join(baseDir, 'package-lock.json'), baseLock.stdout);
    const baseReport = runNpmAudit(baseDir, `${lockfile}@${baseRef}`);
    const baseIds = new Set(collectAuditFindings(baseReport, auditLevel).map((finding) => finding.id));
    return new Set(headFindings.map((finding) => finding.id).filter((id) => !baseIds.has(id)));
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
}

/**
 * Publication dates for the given GHSA ids, from GitHub's global advisory API.
 *
 * Returns a Map missing any id it could not resolve; the caller degrades those
 * to `grace-unknown` rather than guessing an age. GITHUB_TOKEN lifts the
 * unauthenticated 60/hour rate limit and is present by default in Actions.
 */
export async function fetchAdvisoryPublishedAt(ids, { fetchImpl = fetch, token = process.env.GITHUB_TOKEN } = {}) {
  const published = new Map();
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'worldmonitor-security-audit/1.0',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };

  for (const id of ids) {
    if (!/^GHSA-[a-z0-9-]+$/i.test(id)) continue;
    try {
      const response = await fetchImpl(`https://api.github.com/advisories/${id}`, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) continue;
      const body = await response.json();
      if (body?.published_at) published.set(id, String(body.published_at));
    } catch {
      // Leave the id unresolved; classifyAudit() degrades it to grace-unknown.
    }
  }

  return published;
}

export function isInvokedAsScript(entryPath, moduleUrl) {
  if (!entryPath) return false;
  try {
    // Resolve symlinks on both sides: Node sets import.meta.url to the realpath, but
    // process.argv[1] keeps the symlinked path (e.g. macOS /tmp -> /private/tmp), so a
    // raw href comparison silently no-ops — the dangerous fail-open for a security gate.
    const entry = pathToFileURL(realpathSync(entryPath)).href;
    const self = pathToFileURL(realpathSync(fileURLToPath(moduleUrl))).href;
    return entry === self;
  } catch {
    return moduleUrl === pathToFileURL(entryPath).href;
  }
}

/**
 * Record that THIS lockfile was actually audited.
 *
 * The aggregate job counts these to tell "a lockfile reported findings" apart
 * from "a matrix job died before it could audit anything" — the failure mode
 * that made a GitHub Actions outage (2026-08-06, `Failed to resolve action
 * download info`) report itself as `One or more production dependency audits
 * failed.`
 */
function writeStatusFile(statusFile, status) {
  if (!statusFile) return;
  try {
    writeFileSync(statusFile, `${status}\n`);
  } catch (error) {
    console.log(`::warning::Could not write audit status file ${statusFile}: ${error.message}`);
  }
}

/**
 * Hoisted so the top-level catch can still record a verdict. A crash IS a
 * verdict — without this, a thrown audit error writes no status file and the
 * aggregate would read it as "this job never ran", i.e. an infra outage that
 * does not block. That is the fail-open direction, so it must not be possible.
 */
let statusFilePath = '';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  statusFilePath = args.statusFile;
  validateBaselineEntries();

  const workspace = resolve(process.cwd(), args.workspace);
  const packageJson = resolve(process.cwd(), args.packageJson);
  const lockfile = resolve(process.cwd(), args.lockfile);

  let report;
  try {
    report = readAuditReport({ workspace, packageJson, lockfile });
  } catch (error) {
    // Split the failure classes: a broken registry is not a broken PR.
    if (error?.upstreamOutage && !args.failOnOutage) {
      writeStatusFile(args.statusFile, 'outage');
      console.log(
        `::warning title=Security audit could not run::${args.lockfile} was NOT audited — the npm advisory endpoint is unavailable (${error.message}). This is an upstream outage, not a dependency problem; re-run once it recovers.`,
      );
      return;
    }
    throw error;
  }

  const findings = collectAuditFindings(report, args.auditLevel);

  let introducedIds = new Set();
  try {
    introducedIds = collectIntroducedIds({
      baseRef: args.baseRef,
      lockfile: args.lockfile,
      packageJson: args.packageJson,
      headFindings: findings,
      auditLevel: args.auditLevel,
    });
  } catch (error) {
    // Never let a git/base-audit problem decide a security verdict: fall back to
    // "nothing proven introduced", which routes findings through the grace clock
    // instead of silently exonerating or silently blocking them.
    console.log(`::warning title=Base comparison unavailable::Could not audit ${args.lockfile} at ${args.baseRef} (${error.message}); every finding is treated as inherited.`);
  }

  const needDates = findings.filter((finding) => !introducedIds.has(finding.id)).map((finding) => finding.id);
  const publishedAt = needDates.length > 0 ? await fetchAdvisoryPublishedAt(needDates) : new Map();

  const classification = classifyAudit({
    findings,
    lockfile: args.lockfile,
    presentAdvisoryIds: collectAdvisoryIds(report),
    introducedIds,
    publishedAt,
    graceDays: args.graceDays,
  });

  const { info, errors, failed } = formatAuditReport(classification, { failOnOutage: args.failOnOutage });
  for (const line of info) console.log(line);
  for (const line of errors) console.error(line);

  writeStatusFile(args.statusFile, failed ? 'failed' : 'ok');
  if (failed) process.exitCode = 1;
}

if (isInvokedAsScript(process.argv[1], import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    writeStatusFile(statusFilePath || process.env.AUDIT_STATUS_FILE || '', 'failed');
    process.exitCode = 1;
  });
}
