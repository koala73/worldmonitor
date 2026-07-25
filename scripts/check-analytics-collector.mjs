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

/**
 * Cloudflare's WAF 403s a bare `curl/*` User-Agent on this host (verified
 * 2026-07-24: `curl` default → 403, named agent → 200). A probe without a
 * named agent alerts on a perfectly healthy collector, so this is required,
 * not cosmetic.
 */
const USER_AGENT = 'worldmonitor-analytics-collector-monitor/1.0';

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
    // The write path. GET is the wrong verb on purpose: a mounted route
    // rejects it (405/400) without recording anything, while a dead origin
    // returns 5xx. Never POST here — that would pollute production analytics
    // with synthetic monitor traffic.
    okStatuses: Object.freeze([400, 405]),
  }),
]);

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
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // Only read the body when a probe actually asserts on it — the tracker is
    // ~4.6 KB, but /api/send responses are not worth buffering.
    const body = probe.mustInclude ? await response.text() : '';
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

  const resultsByName = {};
  for (const probe of COLLECTOR_PROBES) {
    resultsByName[probe.name] = await runProbeWithRetries(origin, probe);
  }

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
