import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  BASELINE_ADVISORIES_BY_LOCKFILE,
  DEFAULT_GRACE_DAYS,
  baselineEntriesFor,
  classifyAudit,
  collectAdvisoryIds,
  collectAuditFindings,
  collectIntroducedIds,
  collectStaleBaselineEntries,
  collectUnbaselinedFindings,
  formatAuditReport,
  isBaselineExpired,
  isInvokedAsScript,
  isUpstreamAuditOutage,
  resolveAuditErrorMessage,
  validateBaselineEntries,
} from '../.github/scripts/audit-production-dependencies.mjs';

// Frozen clock: every grace/expiry boundary below is expressed relative to this
// instant, so no assertion depends on when the suite happens to run.
const NOW = Date.parse('2026-08-07T00:00:00Z');
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

function finding(id, overrides = {}) {
  return {
    id,
    name: overrides.name ?? 'some-package',
    severity: 'high',
    title: 'some advisory',
    url: `https://github.com/advisories/${id}`,
    ...overrides,
  };
}

function auditReportWith(via) {
  return {
    vulnerabilities: {
      [via.name]: {
        name: via.name,
        severity: via.severity,
        via: [via],
      },
    },
  };
}

function readRepoJson(relativePath) {
  return JSON.parse(readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8'));
}

/**
 * Numeric semver compare. String compare is NOT usable here: '3.9.0' >= '3.15.1'
 * is true lexicographically, which would false-pass the exact regression this
 * assertion exists to catch.
 */
function atLeast(version, minimum) {
  const parse = (v) => String(v).split('-')[0].split('.').map(Number);
  const [a, b] = [parse(version), parse(minimum)];
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

const LOCK = 'test-lock.json';
const FRESH_ADVISORY = 'GHSA-aaaa-bbbb-cccc';
const OLD_ADVISORY = 'GHSA-dddd-eeee-ffff';

/** Published 1 day ago — comfortably inside the grace window. */
const publishedFresh = new Map([[FRESH_ADVISORY, iso(NOW - 1 * DAY)]]);
/** Published well past the grace window. */
const publishedOld = new Map([[OLD_ADVISORY, iso(NOW - (DEFAULT_GRACE_DAYS + 3) * DAY)]]);

describe('classifyAudit verdicts', () => {
  it('defers an inherited advisory that is still inside its grace window', () => {
    const result = classifyAudit({
      findings: [finding(FRESH_ADVISORY)],
      lockfile: LOCK,
      presentAdvisoryIds: new Set([FRESH_ADVISORY]),
      introducedIds: new Set(),
      publishedAt: publishedFresh,
      now: NOW,
      baseline: { [LOCK]: [] },
    });

    assert.deepEqual(result.blocking, []);
    assert.equal(result.deferred.length, 1);
    assert.equal(result.deferred[0].verdict, 'grace');
    assert.equal(formatAuditReport(result, { now: NOW }).failed, false);
  });

  it('blocks the same advisory once the grace window has elapsed', () => {
    const result = classifyAudit({
      findings: [finding(OLD_ADVISORY)],
      lockfile: LOCK,
      presentAdvisoryIds: new Set([OLD_ADVISORY]),
      introducedIds: new Set(),
      publishedAt: publishedOld,
      now: NOW,
      baseline: { [LOCK]: [] },
    });

    assert.equal(result.deferred.length, 0);
    assert.equal(result.blocking.length, 1);
    assert.equal(result.blocking[0].verdict, 'grace-expired');
    assert.equal(formatAuditReport(result, { now: NOW }).failed, true);
  });

  it('blocks an advisory THIS change introduced even though grace has not elapsed', () => {
    // Fixture isolation: the advisory is fresh (grace would defer it) and is not
    // baselined, so `introducedIds` is the ONLY route to a blocking verdict.
    const result = classifyAudit({
      findings: [finding(FRESH_ADVISORY)],
      lockfile: LOCK,
      presentAdvisoryIds: new Set([FRESH_ADVISORY]),
      introducedIds: new Set([FRESH_ADVISORY]),
      publishedAt: publishedFresh,
      now: NOW,
      baseline: { [LOCK]: [] },
    });

    assert.deepEqual(result.deferred, []);
    assert.equal(result.blocking.length, 1);
    assert.equal(result.blocking[0].verdict, 'introduced');
  });

  it('suppresses a baselined advisory only while its lease is unexpired', () => {
    const baseline = {
      [LOCK]: [
        {
          id: OLD_ADVISORY,
          expiresAt: iso(NOW + 30 * DAY),
          reason: 'unreachable from the shipped bundle; documented at length here',
        },
      ],
    };
    const args = {
      findings: [finding(OLD_ADVISORY)],
      lockfile: LOCK,
      presentAdvisoryIds: new Set([OLD_ADVISORY]),
      introducedIds: new Set(),
      publishedAt: publishedOld,
      now: NOW,
      baseline,
    };

    const live = classifyAudit(args);
    assert.equal(live.suppressed.length, 1);
    assert.deepEqual(live.blocking, []);
    assert.equal(formatAuditReport(live, { now: NOW }).failed, false);

    // Same input, clock advanced past the lease: the suppression must lapse.
    const lapsed = classifyAudit({ ...args, now: NOW + 60 * DAY });
    assert.deepEqual(lapsed.suppressed, []);
    assert.equal(lapsed.blocking.length, 1);
    assert.equal(lapsed.blocking[0].verdict, 'baseline-expired');
    assert.equal(formatAuditReport(lapsed, { now: NOW + 60 * DAY }).failed, true);
  });

  it('a baselined advisory outranks grace, so a lease cannot be bypassed by age', () => {
    // An expired lease on an advisory that is ALSO past grace must report the
    // lease as the reason — the actionable instruction is "re-review the
    // suppression", not "the world published this a while ago".
    const result = classifyAudit({
      findings: [finding(OLD_ADVISORY)],
      lockfile: LOCK,
      presentAdvisoryIds: new Set([OLD_ADVISORY]),
      introducedIds: new Set(),
      publishedAt: publishedOld,
      now: NOW,
      baseline: {
        [LOCK]: [{ id: OLD_ADVISORY, expiresAt: iso(NOW - DAY), reason: 'lease that lapsed yesterday, long enough' }],
      },
    });

    assert.equal(result.blocking.length, 1);
    assert.equal(result.blocking[0].verdict, 'baseline-expired');
  });

  it('defers rather than guesses when the advisory publication date is unknown', () => {
    const result = classifyAudit({
      findings: [finding(FRESH_ADVISORY)],
      lockfile: LOCK,
      presentAdvisoryIds: new Set([FRESH_ADVISORY]),
      introducedIds: new Set(),
      publishedAt: new Map(),
      now: NOW,
      baseline: { [LOCK]: [] },
    });

    assert.equal(result.deferred.length, 1);
    assert.equal(result.deferred[0].verdict, 'grace-unknown');
    // Default (PR) run: warns. Scheduled sweep: hard-fails on the same input.
    assert.equal(formatAuditReport(result, { now: NOW }).failed, false);
    assert.equal(formatAuditReport(result, { now: NOW, failOnOutage: true }).failed, true);
  });

  it('rejects an unparseable publication date instead of treating it as epoch', () => {
    // Date.parse('not-a-date') is NaN. If that fell through the arithmetic it
    // would compare NaN < now === false and silently DEFER forever; if it were
    // coerced to 0 it would block every advisory. Neither is acceptable.
    const result = classifyAudit({
      findings: [finding(FRESH_ADVISORY)],
      lockfile: LOCK,
      presentAdvisoryIds: new Set([FRESH_ADVISORY]),
      introducedIds: new Set(),
      publishedAt: new Map([[FRESH_ADVISORY, 'not-a-date']]),
      now: NOW,
      baseline: { [LOCK]: [] },
    });

    assert.equal(result.deferred[0].verdict, 'grace-unknown');
  });
});

describe('grace boundary', () => {
  const at = (offsetMs) =>
    classifyAudit({
      findings: [finding(FRESH_ADVISORY)],
      lockfile: LOCK,
      presentAdvisoryIds: new Set([FRESH_ADVISORY]),
      introducedIds: new Set(),
      publishedAt: new Map([[FRESH_ADVISORY, iso(NOW - DEFAULT_GRACE_DAYS * DAY + offsetMs)]]),
      now: NOW,
      baseline: { [LOCK]: [] },
    });

  it('still defers one millisecond before the deadline', () => {
    assert.equal(at(1).deferred[0]?.verdict, 'grace');
  });

  it('blocks exactly at the deadline', () => {
    assert.equal(at(0).blocking[0]?.verdict, 'grace-expired');
  });
});

describe('baseline rot', () => {
  it('FAILS the gate on a baseline entry whose advisory is no longer reported', () => {
    // The rot fix: this used to be a `::warning` nobody ever actioned, which is
    // how three dead pro-test entries survived. No blocking finding here, so
    // staleness is the only possible route to `failed`.
    const result = classifyAudit({
      findings: [],
      lockfile: LOCK,
      presentAdvisoryIds: new Set(),
      introducedIds: new Set(),
      publishedAt: new Map(),
      now: NOW,
      baseline: {
        [LOCK]: [{ id: OLD_ADVISORY, expiresAt: iso(NOW + 30 * DAY), reason: 'still-valid lease, advisory withdrawn' }],
      },
    });

    assert.deepEqual(result.blocking, []);
    assert.equal(result.stale.length, 1);
    const report = formatAuditReport(result, { now: NOW });
    assert.equal(report.failed, true);
    assert.match(report.errors.join('\n'), /Stale baseline entry/);
  });

  it('does not report a stale entry while its advisory is still present', () => {
    const result = classifyAudit({
      findings: [finding(OLD_ADVISORY)],
      lockfile: LOCK,
      presentAdvisoryIds: new Set([OLD_ADVISORY]),
      introducedIds: new Set(),
      publishedAt: publishedOld,
      now: NOW,
      baseline: {
        [LOCK]: [{ id: OLD_ADVISORY, expiresAt: iso(NOW + 30 * DAY), reason: 'a sufficiently long stated reason' }],
      },
    });

    assert.deepEqual(result.stale, []);
    assert.equal(formatAuditReport(result, { now: NOW }).failed, false);
  });

  it('an EMPTY baseline can never manufacture a failure', () => {
    // Standing trap: an anti-rot mechanism that fires on an empty suppression
    // list arms a red with nothing to review. With zero entries there is
    // nothing that can rot, so the verdict must be clean.
    const result = classifyAudit({
      findings: [],
      lockfile: LOCK,
      presentAdvisoryIds: new Set(),
      introducedIds: new Set(),
      publishedAt: new Map(),
      now: NOW + 3650 * DAY,
      baseline: { [LOCK]: [] },
    });

    assert.deepEqual(result.stale, []);
    assert.deepEqual(result.blocking, []);
    assert.equal(formatAuditReport(result, { now: NOW + 3650 * DAY }).failed, false);
  });

  it('reports the actionable finding BEFORE the terminal baseline condition', () => {
    // Ordering lesson from formatAcceptanceReport(): on the run where a
    // suppression lapses, an operator most needs to see what is actually broken.
    const result = classifyAudit({
      findings: [finding(OLD_ADVISORY, { name: 'blocking-pkg' })],
      lockfile: LOCK,
      presentAdvisoryIds: new Set([OLD_ADVISORY]),
      introducedIds: new Set(),
      publishedAt: publishedOld,
      now: NOW,
      baseline: {
        [LOCK]: [{ id: 'GHSA-9999-9999-9999', expiresAt: iso(NOW + DAY), reason: 'a stale entry with a long reason' }],
      },
    });

    const { errors } = formatAuditReport(result, { now: NOW });
    const blockingAt = errors.findIndex((line) => /blocking advisor/i.test(line));
    const staleAt = errors.findIndex((line) => /no longer match any advisory/.test(line));
    assert.ok(blockingAt >= 0 && staleAt >= 0);
    assert.ok(blockingAt < staleAt, 'blocking advisories must be listed before the stale-baseline block');
  });
});

describe('baseline entry validation', () => {
  it('accepts the baseline this repo actually ships', () => {
    assert.equal(validateBaselineEntries(), true);
  });

  it('rejects a suppression with no stated reason', () => {
    assert.throws(
      () => validateBaselineEntries({ [LOCK]: [{ id: OLD_ADVISORY, expiresAt: iso(NOW + DAY) }] }),
      /substantive `reason`/,
    );
    assert.throws(
      () => validateBaselineEntries({ [LOCK]: [{ id: OLD_ADVISORY, expiresAt: iso(NOW + DAY), reason: 'too short' }] }),
      /substantive `reason`/,
    );
  });

  it('rejects a suppression with no expiry — the defect that let entries rot', () => {
    assert.throws(
      () => validateBaselineEntries({ [LOCK]: [{ id: OLD_ADVISORY, reason: 'a perfectly good long-enough reason' }] }),
      /expiresAt/,
    );
    assert.throws(
      () =>
        validateBaselineEntries({
          [LOCK]: [{ id: OLD_ADVISORY, expiresAt: 'whenever', reason: 'a perfectly good long-enough reason' }],
        }),
      /expiresAt/,
    );
  });

  it('rejects a malformed advisory id', () => {
    assert.throws(
      () => validateBaselineEntries({ [LOCK]: [{ id: 'CVE-2026-1', expiresAt: iso(NOW + DAY), reason: 'long enough reason here' }] }),
      /GHSA id/,
    );
  });

  it('tracks a baseline entry for each audited lockfile', () => {
    assert.deepEqual(Object.keys(BASELINE_ADVISORIES_BY_LOCKFILE).sort(), [
      'blog-site/package-lock.json',
      'consumer-prices-core/package-lock.json',
      'docker/runtime-package-lock.json',
      'package-lock.json',
      'pro-test/package-lock.json',
      'scripts/package-lock.json',
    ]);
  });

  it('isBaselineExpired compares against the lease, not the advisory age', () => {
    assert.equal(isBaselineExpired({ expiresAt: iso(NOW + DAY) }, NOW), false);
    assert.equal(isBaselineExpired({ expiresAt: iso(NOW - DAY) }, NOW), true);
  });
});

describe('introduced-vs-inherited split', () => {
  it('treats every finding as inherited when there is no base ref', () => {
    // push-to-main and the scheduled sweep have no base to diff against, so
    // nothing may be attributed to "this change".
    assert.deepEqual(
      collectIntroducedIds({ baseRef: '', lockfile: LOCK, packageJson: 'p.json', headFindings: [finding(OLD_ADVISORY)] }),
      new Set(),
    );
  });
});

describe('security audit baseline', () => {
  it('allows a currently baselined high advisory', () => {
    const report = auditReportWith({
      name: 'shell-quote',
      severity: 'high',
      title: 'shell-quote DoS',
      url: 'https://github.com/advisories/GHSA-395f-4hp3-45gv',
    });

    assert.deepEqual(collectUnbaselinedFindings(report, 'pro-test/package-lock.json'), []);
  });

  it('ignores moderate production advisories for the high-severity gate', () => {
    const report = auditReportWith({
      name: 'uuid',
      severity: 'moderate',
      title: 'moderate advisory',
      url: 'https://github.com/advisories/GHSA-w5hq-g745-h8pq',
    });

    assert.deepEqual(collectAuditFindings(report), []);
  });

  it('surfaces a new unbaselined high advisory', () => {
    const report = auditReportWith({
      name: 'new-package',
      severity: 'high',
      title: 'new advisory',
      url: 'https://github.com/advisories/GHSA-1111-2222-3333',
    });

    assert.deepEqual(collectUnbaselinedFindings(report, 'package-lock.json'), [
      {
        id: 'GHSA-1111-2222-3333',
        name: 'new-package',
        severity: 'high',
        title: 'new advisory',
        url: 'https://github.com/advisories/GHSA-1111-2222-3333',
      },
    ]);
  });

  it('keeps js-yaml on the backported CVE-2026-59870 fix in every production tree', () => {
    // GHSA-5p4m-2wfm-xmqj: 3.x is fixed in 3.15.1, 4.x in 4.3.1. Both land
    // inside the existing semver ranges, so a lockfile refresh is the whole fix.
    const rootLock = readRepoJson('package-lock.json');
    const blogLock = readRepoJson('blog-site/package-lock.json');
    const cpcLock = readRepoJson('consumer-prices-core/package-lock.json');

    for (const [label, entry] of [
      ['root @istanbuljs', rootLock.packages['node_modules/@istanbuljs/load-nyc-config/node_modules/js-yaml']],
      ['blog-site gray-matter', blogLock.packages['node_modules/gray-matter/node_modules/js-yaml']],
    ]) {
      assert.ok(entry, `${label} js-yaml must be present`);
      assert.ok(atLeast(entry.version, '3.15.1'), `${label} js-yaml ${entry.version} is below the patched 3.15.1`);
    }

    for (const [label, entry] of [
      ['blog-site', blogLock.packages['node_modules/js-yaml']],
      ['consumer-prices-core', cpcLock.packages['node_modules/js-yaml']],
    ]) {
      assert.ok(entry, `${label} js-yaml must be present`);
      assert.ok(atLeast(entry.version, '4.3.1'), `${label} js-yaml ${entry.version} is below the patched 4.3.1`);
    }

    // The helper must reject the lexicographic trap it exists to avoid.
    assert.equal(atLeast('3.9.0', '3.15.1'), false);
    assert.equal(atLeast('3.15.1', '3.15.1'), true);
    assert.equal(atLeast('4.3.0', '4.3.1'), false);
  });

  it('keeps consumer-prices-core on the Fastify v5 audit fix', () => {
    const packageJson = readRepoJson('consumer-prices-core/package.json');
    const lockfile = readRepoJson('consumer-prices-core/package-lock.json');

    assert.match(packageJson.dependencies.fastify, /^\^5\./);
    assert.match(packageJson.dependencies['@fastify/cors'], /^\^11\./);
    assert.match(packageJson.dependencies['js-yaml'], /^\^4\.(?:[2-9]|\d{2,})\./);
    assert.match(lockfile.packages['node_modules/fastify']?.version, /^5\./);
    assert.match(lockfile.packages['node_modules/@fastify/cors']?.version, /^11\./);
    assert.deepEqual(baselineEntriesFor('consumer-prices-core/package-lock.json'), []);
  });

  it('keeps the root esbuild audit fix scoped away from Vite build tooling', () => {
    const packageJson = readRepoJson('package.json');
    const lockfile = readRepoJson('package-lock.json');
    const rootEsbuild = lockfile.packages['node_modules/esbuild'];
    const vite = lockfile.packages['node_modules/vite'];
    const viteEsbuild = lockfile.packages['node_modules/vite/node_modules/esbuild'];

    assert.equal(packageJson.overrides?.esbuild, undefined);
    assert.equal(packageJson.overrides?.convex?.esbuild, '0.28.1');
    assert.equal(rootEsbuild?.version, '0.28.1');
    assert.equal(vite?.dependencies?.esbuild, '^0.25.0');
    assert.ok(viteEsbuild, 'Vite must keep its own esbuild when root uses the audit-patched version');
    assert.match(viteEsbuild.version, /^0\.25\./);
    assert.notEqual(viteEsbuild.version, rootEsbuild.version);
  });

  it('flags a baseline entry that no longer matches any current advisory', () => {
    // Every advisory currently baselined for pro-test must be present in the
    // report for the no-stale case — one package (image-size) carries two.
    const withAllBaselined = {
      vulnerabilities: {
        'shell-quote': {
          name: 'shell-quote',
          severity: 'high',
          via: [{
            name: 'shell-quote',
            severity: 'high',
            title: 'shell-quote DoS',
            url: 'https://github.com/advisories/GHSA-395f-4hp3-45gv',
          }],
        },
        'image-size': {
          name: 'image-size',
          severity: 'high',
          via: [
            {
              name: 'image-size',
              severity: 'high',
              title: 'image-size JXL/HEIF DoS',
              url: 'https://github.com/advisories/GHSA-5p2g-fcmc-qvqq',
            },
            {
              name: 'image-size',
              severity: 'high',
              title: 'image-size ICNS DoS',
              url: 'https://github.com/advisories/GHSA-w3rx-r6r6-pgpr',
            },
          ],
        },
      },
    };

    assert.deepEqual(collectStaleBaselineEntries(withAllBaselined, 'pro-test/package-lock.json'), []);
    assert.deepEqual(collectStaleBaselineEntries({ vulnerabilities: {} }, 'pro-test/package-lock.json'), [
      'GHSA-395f-4hp3-45gv',
      'GHSA-5p2g-fcmc-qvqq',
      'GHSA-w3rx-r6r6-pgpr',
    ]);
    assert.deepEqual(collectStaleBaselineEntries({ vulnerabilities: {} }, 'scripts/package-lock.json'), []);
  });

  it('collectAdvisoryIds sees every advisory regardless of severity', () => {
    const report = auditReportWith({
      name: 'uuid',
      severity: 'low',
      title: 'low advisory',
      url: 'https://github.com/advisories/GHSA-w5hq-g745-h8pq',
    });
    assert.deepEqual([...collectAdvisoryIds(report)], ['GHSA-w5hq-g745-h8pq']);
  });

  it('treats a symlinked entry path as direct invocation (no silent fail-open)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-guard-'));
    try {
      const real = join(dir, 'audit.mjs');
      writeFileSync(real, '// stub\n');
      const link = join(dir, 'audit-link.mjs');
      symlinkSync(real, link);
      const moduleUrl = pathToFileURL(real).href;

      // Invoked through the symlink, the guard still fires (the bug being fixed).
      assert.equal(isInvokedAsScript(link, moduleUrl), true);
      assert.equal(isInvokedAsScript(real, moduleUrl), true);
      // A different file must not be mistaken for the module entry.
      assert.equal(isInvokedAsScript(join(dir, 'other.mjs'), moduleUrl), false);
      assert.equal(isInvokedAsScript(undefined, moduleUrl), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('npm audit failure reporting', () => {
  // The exact payload registry.npmjs.org returned on 2026-07-26, which reddened
  // audit-lockfile repo-wide. Empty strings, real text only in `message`.
  const OUTAGE_REPORT = {
    message:
      "invalid json response body at https://registry.npmjs.org/-/npm/v1/security/advisories/bulk reason: Unexpected token '', \" \"... is not valid JSON",
    error: { summary: '', detail: '' },
  };

  it('does not let an empty summary swallow the real reason', () => {
    // The bug: `summary ?? detail ?? fallback` returns '' because ?? only
    // falls through on null/undefined, so the gate failed printing a blank line.
    assert.notEqual(OUTAGE_REPORT.error.summary ?? 'fallback', 'fallback');
    const message = resolveAuditErrorMessage(OUTAGE_REPORT, 'blog-site');
    assert.notEqual(message.trim(), '');
    assert.match(message, /advisories\/bulk/);
  });

  it('prefers a populated summary over detail and message', () => {
    const message = resolveAuditErrorMessage(
      { message: 'ignored', error: { summary: 'real summary', detail: 'ignored' } },
      'blog-site',
    );
    assert.equal(message, 'real summary');
  });

  it('falls back to a named error when npm supplies nothing usable', () => {
    for (const report of [{}, { error: {} }, { error: { summary: '   ', detail: '' } }]) {
      assert.equal(resolveAuditErrorMessage(report, 'blog-site'), 'npm audit failed for blog-site');
    }
  });

  it('classifies the advisory-endpoint outage as upstream, not actor-fixable', () => {
    assert.equal(isUpstreamAuditOutage(OUTAGE_REPORT), true);
    for (const text of [
      'npm error audit endpoint returned an error',
      'request to https://registry.npmjs.org failed, reason: ETIMEDOUT',
      'FetchError: request failed, reason: ECONNRESET',
      'Service Unavailable 503',
      'network timeout at: https://registry.npmjs.org',
    ]) {
      assert.equal(isUpstreamAuditOutage({ message: text }), true, text);
    }
  });

  it('does NOT classify a real audit failure as an outage (must stay hard-fail)', () => {
    // The security-relevant direction: anything that could be a genuine
    // dependency problem must not be softened into a warning.
    for (const report of [
      {},
      { error: { summary: '', detail: '' } },
      { error: { summary: 'ENOLOCK: no lockfile found' } },
      { message: 'npm error code EUSAGE' },
      { message: 'Missing: [email protected] from lock file' },
    ]) {
      assert.equal(isUpstreamAuditOutage(report), false, JSON.stringify(report));
    }
  });
});
