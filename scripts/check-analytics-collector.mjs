#!/usr/bin/env node

/**
 * Scheduled liveness probe for the self-hosted Umami analytics collector
 * (`abacus.worldmonitor.app`).
 *
 * Why this exists: on 2026-07-20 the collector's Node process OOM-died and
 * Railway neither restarted it nor flipped the deployment off `SUCCESS`, so
 * nothing alerted. Every product-analytics event was dropped for 4 days
 * (~1.1M events) and the gap was only found by hand while asking an unrelated
 * question about a funnel. See #5565.
 *
 * Deliberately probes the collector directly rather than trusting Railway's
 * deployment status, which was green throughout that outage.
 */

import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { extractCollectorFailureMetadata } from '../shared/collector-failure-metadata.js';

export { extractCollectorFailureMetadata };

const DEFAULT_COLLECTOR_ORIGIN = 'https://abacus.worldmonitor.app';
export const ANALYTICS_CANARY_WEBSITE_ID = '373c80a2-1109-42a7-868b-565bcf7bf168';
const ANALYTICS_CANARY_HOSTNAME = 'analytics-canary.worldmonitor.app';
/**
 * Generated per run, not hard-coded. The repo is public, so a fixed session key
 * published alongside the (necessarily unauthenticated) `/api/send` endpoint is
 * a stable target an outsider can contend with to force false monitor pages.
 * A fresh UUID keeps the same-session property for THIS run's probes while
 * giving nobody a key to squat on, and matches the UUID shape Umami expects.
 */
const ANALYTICS_CANARY_SESSION_ID = randomUUID();

/**
 * Cloudflare's WAF 403s a bare `curl/*` User-Agent on this host (verified
 * 2026-07-24: `curl` default → 403, named agent → 200). A probe without a
 * named agent alerts on a perfectly healthy collector, so this is required,
 * not cosmetic.
 */
const USER_AGENT = 'worldmonitor-analytics-collector-monitor/1.0';
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

const REQUEST_TIMEOUT_MS = 20_000;
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 3_000;
const WRITE_RECEIPT_FIELDS = Object.freeze(['cache', 'sessionId', 'visitId']);

/**
 * Write canaries are fired as synchronized BURSTS, not through the liveness
 * retry helper. Retrying one failing probe on its own would both (a) hide the
 * failure the moment a lone retry succeeds and (b) destroy the concurrency that
 * is the entire point of the probe. Every burst re-fires the whole set at once
 * and every attempt is retained for the rate.
 */
const WRITE_CANARY_BURSTS = 3;
const WRITE_BURST_DELAY_MS = 3_000;

/**
 * Alert threshold for the attempt-level write failure rate.
 *
 * Umami #4183 is unfixed upstream and produced a 4-8% background failure rate
 * in production, so alerting on any single failure would page on a known,
 * accepted condition and train everyone to ignore this monitor — the alert
 * fatigue path back to #5565. This sits above that band so a step change pages
 * while the known race does not. Tune once a baseline exists in the job logs;
 * the rate is printed on every run precisely so the baseline is observable.
 */
const WRITE_FAILURE_ALERT_RATE = 0.25;

const ANALYTICS_CANARY_PAYLOAD = Object.freeze({
  website: ANALYTICS_CANARY_WEBSITE_ID,
  hostname: ANALYTICS_CANARY_HOSTNAME,
  url: '/__monitor__/analytics-collector',
  title: 'World Monitor analytics collector canary',
  referrer: '',
  screen: '1x1',
  language: 'en-US',
  // One session id across the whole burst. The dedicated website keeps this
  // exercise outside product funnels.
  id: ANALYTICS_CANARY_SESSION_ID,
});

/**
 * The data key the contending identify probes write.
 *
 * This has to be ONE key shared by at least two concurrent `identify` requests.
 * Umami routes `type: 'event'` through saveEvent() -> saveEventData(), which
 * never touches `session_data`; only `type: 'identify'` reaches
 * saveSessionData(), which is where #4183's `updateMany()` race lives. Probes
 * that write different keys — or that are events at all — touch disjoint rows
 * and cannot contend, so a burst of mixed shapes proves only that the collector
 * accepts concurrent requests, not that the race is absent.
 */
const CONTENDED_SESSION_DATA_KEY = 'monitor';

function buildWriteCanaryProbe(name, type, extraPayload = {}) {
  return Object.freeze({
    name,
    path: '/api/send',
    method: 'POST',
    okStatuses: Object.freeze([200]),
    userAgent: BROWSER_USER_AGENT,
    receiptFields: WRITE_RECEIPT_FIELDS,
    writeCanary: true,
    body: Object.freeze({
      type,
      payload: Object.freeze({ ...ANALYTICS_CANARY_PAYLOAD, ...extraPayload }),
    }),
  });
}

/**
 * Two identify probes contending on one (session, data key) row reproduce the
 * #4183 write race; the pageview and named-event probes keep general
 * write-path coverage (saveEvent / saveEventData) that identify does not give.
 */
export const ANALYTICS_WRITE_CANARY_PROBES = Object.freeze([
  buildWriteCanaryProbe('write-canary-identify-a', 'identify', {
    data: Object.freeze({ [CONTENDED_SESSION_DATA_KEY]: 'github-actions-a' }),
  }),
  buildWriteCanaryProbe('write-canary-identify-b', 'identify', {
    data: Object.freeze({ [CONTENDED_SESSION_DATA_KEY]: 'github-actions-b' }),
  }),
  buildWriteCanaryProbe('write-canary-pageview', 'event'),
  buildWriteCanaryProbe('write-canary-event', 'event', {
    name: 'collector-write-canary',
    data: Object.freeze({ source: 'github-actions' }),
  }),
]);

export const COLLECTOR_PROBES = Object.freeze([
  Object.freeze({
    name: 'heartbeat',
    path: '/api/heartbeat',
    okStatuses: Object.freeze([200]),
    // Proves the app process is alive and serving. The OOM death surfaced
    // here as a Cloudflare 502 after a ~15s origin timeout.
    // Read the body on failure so a database-shaped error here carries the same
    // sanitized Prisma identifiers the write canaries report.
    captureFailureMetadata: true,
  }),
  Object.freeze({
    name: 'tracker-script',
    path: '/script.js',
    okStatuses: Object.freeze([200]),
    // A 200 alone is not enough — assert the served bytes really are the
    // tracker by requiring the ingest path it posts to. A browser that cannot
    // load this sends no events at all, whatever the collector reports about
    // its own health.
    mustInclude: '/api/send',
  }),
  Object.freeze({
    name: 'ingest-route',
    path: '/api/send',
    // Keeps the original no-write route-mount check from #5565. The canaries
    // below separately prove that the database-backed write path succeeds.
    okStatuses: Object.freeze([400, 405]),
    captureFailureMetadata: true,
  }),
  // Fired as synchronized bursts by runWriteCanaryBursts, NOT through the
  // per-probe liveness retry — see WRITE_CANARY_BURSTS.
  ...ANALYTICS_WRITE_CANARY_PROBES,
]);

/** Build the request shape for one probe without performing network I/O. */
export function buildProbeRequest(probe) {
  const headers = { 'User-Agent': probe.userAgent || USER_AGENT };
  const request = {
    method: probe.method || 'GET',
    headers,
  };
  if (probe.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    request.body = JSON.stringify(probe.body);
  }
  return request;
}

function formatFailureMetadata(body) {
  const metadata = extractCollectorFailureMetadata(body);
  if (!metadata.prismaCode && !metadata.constraint) return '';
  const details = [
    metadata.prismaCode ? `Prisma ${metadata.prismaCode}` : null,
    metadata.constraint ? `constraint ${metadata.constraint}` : null,
  ].filter(Boolean).join(' ');
  return ` — ${details}`;
}

/**
 * Classify one completed probe attempt. Returns null when healthy, otherwise a
 * human-readable reason for the alert.
 */
export function evaluateProbeResult(probe, result) {
  if (!probe || typeof probe !== 'object' || Array.isArray(probe)) {
    throw new TypeError('probe must be an object');
  }
  if (!Array.isArray(probe.okStatuses) || probe.okStatuses.length === 0) {
    throw new TypeError(`probe ${probe.name} must declare okStatuses`);
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new TypeError('result must be an object');
  }

  if (result.error) return `request failed: ${result.error}`;

  if (!probe.okStatuses.includes(result.status)) {
    // 403 is the WAF rejecting the probe itself, not the collector being down.
    // Calling that out keeps a monitor bug from reading as an outage.
    const hint =
      result.status === 403
        ? ' — Cloudflare WAF rejected the probe; check the User-Agent, not the collector'
        : '';
    return `HTTP ${result.status} (expected ${probe.okStatuses.join(' or ')})${hint}${formatFailureMetadata(result.body)}`;
  }

  if (probe.mustInclude && !String(result.body ?? '').includes(probe.mustInclude)) {
    return `HTTP ${result.status} but body did not contain ${probe.mustInclude}`;
  }

  if (probe.receiptFields) {
    let receipt;
    try {
      receipt = JSON.parse(result.body);
    } catch {
      return `HTTP ${result.status} but write receipt was not valid JSON`;
    }
    for (const field of probe.receiptFields) {
      if (typeof receipt?.[field] !== 'string' || receipt[field].trim() === '') {
        return `HTTP ${result.status} but write receipt missing non-empty string ${field}`;
      }
    }
  }

  return null;
}

/** Collect the probes that failed, preserving probe order for stable output. */
export function summarizeProbeFailures(probes, resultsByName) {
  return probes
    .map((probe) => ({ probe, reason: evaluateProbeResult(probe, resultsByName[probe.name]) }))
    .filter(({ reason }) => reason !== null)
    .map(({ probe, reason }) => ({ name: probe.name, path: probe.path, reason }));
}

/**
 * Summarize write-path health over EVERY attempt, not just the surviving one.
 *
 * The rate has to be attempt-level or it cannot represent the condition this
 * monitor exists for. With a per-probe first-success-wins retry, a 4-8%
 * per-request failure rate reports 0.0% about 99.95% of the time — the monitor
 * would print a clean bill of health through exactly the incident that reopened
 * #5715.
 *
 * @param {Array<{ name: string, reason: string | null }>} attempts
 */
export function summarizeWriteCanaryResults(attempts) {
  const failures = attempts.filter(({ reason }) => reason !== null);
  return {
    total: attempts.length,
    failed: failures.length,
    failureRate: attempts.length === 0 ? 0 : failures.length / attempts.length,
    failures,
  };
}

async function runProbe(origin, probe) {
  const url = new URL(probe.path, origin).toString();
  try {
    const response = await fetch(url, {
      ...buildProbeRequest(probe),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // Read only bodies needed for an assertion or sanitized failure metadata.
    // Never print this body: v3.1.0 could include the full Prisma stack and
    // request-adjacent details in a 500 response.
    const body = probe.mustInclude || probe.receiptFields || probe.captureFailureMetadata
      ? await response.text()
      : '';
    return { status: response.status, body };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Retry before alerting so a single transient blip (deploy restart, edge
 * hiccup) does not page anyone. A sustained failure is what matters: the
 * outage this monitor exists for lasted four days.
 *
 * Liveness probes only — write canaries deliberately do NOT come through here.
 */
async function runProbeWithRetries(origin, probe, runner, sleep) {
  let last;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    last = await runner(origin, probe);
    if (evaluateProbeResult(probe, last) === null) return last;
    if (attempt < ATTEMPTS) await sleep(RETRY_DELAY_MS);
  }
  return last;
}

/**
 * Fire every write canary at once, repeatedly. Each burst is itself concurrent,
 * so a retry still exercises session-data contention instead of degrading into
 * isolated sequential writes.
 */
async function runWriteCanaryBursts(origin, probes, runner, sleep) {
  const attempts = [];
  const lastByName = {};
  for (let burst = 1; burst <= WRITE_CANARY_BURSTS; burst += 1) {
    const results = await Promise.all(probes.map((probe) => runner(origin, probe)));
    probes.forEach((probe, index) => {
      const result = results[index];
      lastByName[probe.name] = result;
      attempts.push({ name: probe.name, reason: evaluateProbeResult(probe, result) });
    });
    if (burst < WRITE_CANARY_BURSTS) await sleep(WRITE_BURST_DELAY_MS);
  }
  return { attempts, lastByName };
}

/**
 * Run every probe and decide the outcome. Split out of `main()` so the alerting
 * contract — concurrent canary dispatch, the attempt-level rate, and the exit
 * decision — is reachable from tests with an injected runner.
 */
export async function runCollectorChecks({
  origin = DEFAULT_COLLECTOR_ORIGIN,
  runner = runProbe,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const livenessProbes = COLLECTOR_PROBES.filter((probe) => !probe.writeCanary);
  const writeProbes = COLLECTOR_PROBES.filter((probe) => probe.writeCanary);

  const [livenessEntries, writeRun] = await Promise.all([
    Promise.all(
      livenessProbes.map(async (probe) => [
        probe.name,
        await runProbeWithRetries(origin, probe, runner, sleep),
      ]),
    ),
    runWriteCanaryBursts(origin, writeProbes, runner, sleep),
  ]);

  const resultsByName = { ...Object.fromEntries(livenessEntries), ...writeRun.lastByName };
  const livenessFailures = summarizeProbeFailures(livenessProbes, resultsByName);
  const writeSummary = summarizeWriteCanaryResults(writeRun.attempts);

  // A write path that is entirely down is the #5565 class and pages regardless
  // of the rate threshold, which exists only to tolerate the known #4183 race.
  const writePathDead = writeSummary.total > 0 && writeSummary.failed === writeSummary.total;
  const writeRateBreached = writeSummary.failureRate > WRITE_FAILURE_ALERT_RATE;

  return {
    origin,
    resultsByName,
    livenessFailures,
    writeSummary,
    writePathDead,
    writeRateBreached,
    alerting: livenessFailures.length > 0 || writePathDead || writeRateBreached,
  };
}

function reportCollectorChecks(report) {
  const { origin, livenessFailures, writeSummary } = report;
  const writeRate = `${(writeSummary.failureRate * 100).toFixed(1)}%`;
  console.log(
    `Analytics collector write canary: ${writeSummary.failed}/${writeSummary.total} attempts failed (${writeRate}) across ${WRITE_CANARY_BURSTS} concurrent bursts.`,
  );

  if (!report.alerting) {
    console.log(`Analytics collector healthy at ${origin}: ${COLLECTOR_PROBES.length} probes OK.`);
    return;
  }

  console.error(`Analytics collector alert at ${origin}:`);
  if (livenessFailures.length > 0) {
    console.error(`- ${livenessFailures.length} liveness probe(s) failing after ${ATTEMPTS} attempts.`);
    for (const failure of livenessFailures) {
      console.error(`  - ${failure.name} (${failure.path}): ${failure.reason}`);
    }
    console.error(
      '  Events are being dropped while this is red. Check the Railway `umami` service — a green deployment status does not mean the process is alive (#5565).',
    );
  }
  if (report.writePathDead) {
    console.error('- Write path is fully down: every canary attempt failed.');
  } else if (report.writeRateBreached) {
    console.error(
      `- Write failure rate ${writeRate} exceeds the ${(WRITE_FAILURE_ALERT_RATE * 100).toFixed(0)}% threshold (known Umami #4183 baseline is 4-8%).`,
    );
  }
  // Deduplicate by reason so a race that hits every burst reads as one line.
  const seen = new Set();
  for (const failure of writeSummary.failures) {
    const line = `  - ${failure.name}: ${failure.reason}`;
    if (seen.has(line)) continue;
    seen.add(line);
    console.error(line);
  }
}

async function main() {
  const report = await runCollectorChecks({
    origin: process.env.ANALYTICS_COLLECTOR_ORIGIN || DEFAULT_COLLECTOR_ORIGIN,
  });
  reportCollectorChecks(report);
  if (report.alerting) process.exitCode = 1;
}

// realpath BOTH sides: through a symlinked checkout Node sets import.meta.url
// to the realpath while argv[1] keeps the symlink, and the naive comparison
// silently no-ops the whole monitor (exit 0, nothing checked).
const isMainModule =
  Boolean(process.argv[1]) &&
  pathToFileURL(realpathSync(process.argv[1])).href ===
    pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;

if (isMainModule) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
