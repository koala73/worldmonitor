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

import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_COLLECTOR_ORIGIN = 'https://abacus.worldmonitor.app';
export const ANALYTICS_CANARY_WEBSITE_ID = '373c80a2-1109-42a7-868b-565bcf7bf168';
const ANALYTICS_CANARY_HOSTNAME = 'analytics-canary.worldmonitor.app';

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

export const COLLECTOR_PROBES = Object.freeze([
  Object.freeze({
    name: 'heartbeat',
    path: '/api/heartbeat',
    okStatuses: Object.freeze([200]),
    // Proves the app process is alive and serving. The OOM death surfaced
    // here as a Cloudflare 502 after a ~15s origin timeout.
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
    // Keeps the original no-write route-mount check from #5565. The canary
    // below separately proves that the database-backed write path succeeds.
    okStatuses: Object.freeze([400, 405]),
  }),
  Object.freeze({
    name: 'write-canary',
    path: '/api/send',
    method: 'POST',
    okStatuses: Object.freeze([200]),
    userAgent: BROWSER_USER_AGENT,
    receiptFields: Object.freeze(['cache', 'sessionId', 'visitId']),
    // This website is deliberately separate from World Monitor's production
    // website id, so one synthetic event every 5 minutes cannot contaminate
    // product funnels or pageview counts.
    body: Object.freeze({
      type: 'event',
      payload: Object.freeze({
        website: ANALYTICS_CANARY_WEBSITE_ID,
        hostname: ANALYTICS_CANARY_HOSTNAME,
        url: '/__monitor__/analytics-collector',
        title: 'World Monitor analytics collector canary',
        referrer: '',
        screen: '1x1',
        language: 'en-US',
        name: 'collector-write-canary',
        data: Object.freeze({ source: 'github-actions' }),
      }),
    }),
  }),
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
    return `HTTP ${result.status} (expected ${probe.okStatuses.join(' or ')})${hint}`;
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

async function runProbe(origin, probe) {
  const url = new URL(probe.path, origin).toString();
  try {
    const response = await fetch(url, {
      ...buildProbeRequest(probe),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // Only read bodies asserted by a probe — the tracker is ~4.6 KB and the
    // write canary needs its receipt, while the other /api/send probe does not.
    const body = probe.mustInclude || probe.receiptFields ? await response.text() : '';
    return { status: response.status, body };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Retry before alerting so a single transient blip (deploy restart, edge
 * hiccup) does not page anyone. A sustained failure is what matters: the
 * outage this monitor exists for lasted four days.
 */
async function runProbeWithRetries(origin, probe) {
  let last;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    last = await runProbe(origin, probe);
    if (evaluateProbeResult(probe, last) === null) return last;
    if (attempt < ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  return last;
}

async function main() {
  const origin = process.env.ANALYTICS_COLLECTOR_ORIGIN || DEFAULT_COLLECTOR_ORIGIN;

  const resultsByName = Object.fromEntries(
    await Promise.all(
      COLLECTOR_PROBES.map(async (probe) => [
        probe.name,
        await runProbeWithRetries(origin, probe),
      ]),
    ),
  );

  const failures = summarizeProbeFailures(COLLECTOR_PROBES, resultsByName);
  if (failures.length === 0) {
    console.log(`Analytics collector healthy at ${origin}: ${COLLECTOR_PROBES.length} probes OK.`);
    return;
  }

  console.error(
    `Analytics collector alert: ${failures.length}/${COLLECTOR_PROBES.length} probe(s) failing at ${origin} after ${ATTEMPTS} attempts.`,
  );
  for (const failure of failures) {
    console.error(`- ${failure.name} (${failure.path}): ${failure.reason}`);
  }
  console.error(
    'Events are being dropped while this is red. Check the Railway `umami` service — a green deployment status does not mean the process is alive (#5565).',
  );
  process.exitCode = 1;
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
