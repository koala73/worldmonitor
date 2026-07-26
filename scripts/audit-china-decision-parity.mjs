#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateChinaDecisionSignalSnapshot } from './seed-china-decision-signals.mjs';

export const CHINA_DECISION_PARITY_MANIFEST = Object.freeze([
  Object.freeze({
    groupId: 'macro',
    provenanceFamily: 'china_macro_official_numeric_observation',
    sourceKey: 'economic:china:macro:v2',
  }),
  Object.freeze({
    groupId: 'policy-enforcement',
    provenanceFamily: 'typed_document_event',
    sourceKey: 'china:policy-events:v1',
  }),
  Object.freeze({
    groupId: 'cross-strait-activity',
    provenanceFamily: 'operational_activity_record',
    sourceKey: 'military:cross-strait-activity:v1',
  }),
  Object.freeze({
    groupId: 'corporate-disclosures',
    provenanceFamily: 'exchange_disclosure',
    sourceKey: 'market:china:corporate-disclosures:v1',
  }),
  Object.freeze({
    groupId: 'corridor-conditions',
    provenanceFamily: 'composed_corridor_condition',
    sourceKey: 'supply-chain:china-corridor-control-towers',
  }),
  Object.freeze({
    groupId: 'activity-nowcast',
    provenanceFamily: 'derived_comparison',
    sourceKey: 'economic:china-activity-nowcast',
  }),
]);

const ROUTE = '/api/intelligence/v1/get-china-decision-signals';
const BOOTSTRAP_ROUTE = '/api/bootstrap?keys=chinaDecisionSignals&public=1';
const CANONICAL_KEY = 'intelligence:china-decision-signals:v1';
const META_KEY = 'seed-meta:intelligence:china-decision-signals';

const REQUIRED_REGISTRATIONS = Object.freeze([
  ['shared/china-decision-signals.ts', ...CHINA_DECISION_PARITY_MANIFEST.map(({ groupId }) => `'${groupId}'`)],
  ['shared/decision-signal-provenance-families.ts', ...CHINA_DECISION_PARITY_MANIFEST.map(({ provenanceFamily }) => `${provenanceFamily}: Object.freeze({`)],
  ['proto/worldmonitor/intelligence/v1/get_china_decision_signals.proto', 'message GetChinaDecisionSignalsResponse'],
  ['proto/worldmonitor/intelligence/v1/service.proto', 'GetChinaDecisionSignals'],
  ['api/mcp/registry/rpc-tools.ts', 'get_china_decision_signals', ROUTE, CANONICAL_KEY],
  ['server/gateway.ts', `'${ROUTE}': 'fast'`, `'${ROUTE}',`],
  ['shared/bootstrap-tier-keys.js', `chinaDecisionSignals: '${CANONICAL_KEY}'`],
  ['api/_bootstrap-tier-keys.js', `chinaDecisionSignals: '${CANONICAL_KEY}'`],
  ['api/bootstrap.js', 'chinaDecisionSignals: {', "s-maxage=900"],
  ['api/health.js', 'chinaDecisionSignals: BOOTSTRAP_CACHE_KEYS.chinaDecisionSignals', `key: '${META_KEY}'`],
  ['api/seed-health.js', `'intelligence:china-decision-signals': { key: '${META_KEY}'`],
  ['scripts/seed-bundle-derived-signals.mjs', 'seed-china-decision-signals.mjs', 'canonicalKey: CHINA_DECISION_SIGNALS_KEY'],
  ['scripts/seed-china-decision-signals.mjs', ROUTE, `CHINA_DECISION_SIGNALS_KEY = '${CANONICAL_KEY}'`],
  ['scripts/china-decision-alerts.mjs', 'buildChinaDecisionAlertEvents', 'dedupe_key', 'pending'],
  ['scripts/seed-china-decision-signals.mjs', 'CHINA_DECISION_SIGNAL_ALERT_OUTBOX_KEY', 'afterPublish'],
  ['docs/china-decision-signals.mdx', 'bounded_public_summary', 'same_provenance_via_mcp', 'source_health_only'],
]);

function read(repoRoot, relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

export function auditChinaDecisionStaticRegistrations(repoRoot) {
  const findings = [];
  for (const [relativePath, ...needles] of REQUIRED_REGISTRATIONS) {
    let source;
    try {
      source = read(repoRoot, relativePath);
    } catch {
      findings.push({ file: relativePath, missing: '<file>' });
      continue;
    }
    for (const needle of needles) {
      if (!source.includes(needle)) findings.push({ file: relativePath, missing: needle });
    }
  }
  return {
    ok: findings.length === 0,
    groupIds: CHINA_DECISION_PARITY_MANIFEST.map(({ groupId }) => groupId),
    canonicalKey: CANONICAL_KEY,
    seedMetaKey: META_KEY,
    route: ROUTE,
    findings,
  };
}

export async function probeChinaDecisionParity(baseUrl, {
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  const url = new URL(ROUTE, `${baseUrl.replace(/\/+$/, '')}/`);
  const startedAt = now();
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  const latencyMs = Math.max(0, now() - startedAt);
  if (!response.ok) {
    return { ok: false, route: ROUTE, httpStatus: response.status, latencyMs };
  }
  const wire = await response.json();
  const encoded = wire?.payloadJson ?? wire?.payload_json;
  if (typeof encoded !== 'string') {
    return {
      ok: false,
      route: ROUTE,
      httpStatus: response.status,
      latencyMs,
      error: 'missing_payload_json',
    };
  }
  let snapshot;
  try {
    snapshot = JSON.parse(encoded);
  } catch {
    return {
      ok: false,
      route: ROUTE,
      httpStatus: response.status,
      latencyMs,
      error: 'invalid_payload_json',
    };
  }
  if (!validateChinaDecisionSignalSnapshot(snapshot)) {
    return {
      ok: false,
      route: ROUTE,
      httpStatus: response.status,
      latencyMs,
      error: 'invalid_contract',
    };
  }
  const groupStates = Object.fromEntries(
    snapshot.groups.map((candidate) => [candidate.id, candidate.state]),
  );

  const bootstrapUrl = new URL(BOOTSTRAP_ROUTE, `${baseUrl.replace(/\/+$/, '')}/`);
  const bootstrapStartedAt = now();
  const bootstrapResponse = await fetchImpl(bootstrapUrl, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  const bootstrapLatencyMs = Math.max(0, now() - bootstrapStartedAt);
  if (!bootstrapResponse.ok) {
    return {
      ok: false,
      route: ROUTE,
      bootstrapRoute: BOOTSTRAP_ROUTE,
      httpStatus: response.status,
      bootstrapHttpStatus: bootstrapResponse.status,
      latencyMs,
      bootstrapLatencyMs,
      error: 'bootstrap_http_error',
    };
  }
  const bootstrapWire = await bootstrapResponse.json();
  const bootstrapSnapshot = bootstrapWire?.data?.chinaDecisionSignals;
  if (!validateChinaDecisionSignalSnapshot(bootstrapSnapshot)) {
    return {
      ok: false,
      route: ROUTE,
      bootstrapRoute: BOOTSTRAP_ROUTE,
      httpStatus: response.status,
      bootstrapHttpStatus: bootstrapResponse.status,
      latencyMs,
      bootstrapLatencyMs,
      error: 'invalid_bootstrap_contract',
    };
  }
  const bootstrapGeneratedAtMs = Date.parse(bootstrapSnapshot.generatedAt);
  const bootstrapAgeMs = now() - bootstrapGeneratedAtMs;
  if (
    !Number.isFinite(bootstrapGeneratedAtMs)
    || bootstrapAgeMs < -5 * 60 * 1000
    || bootstrapAgeMs > 60 * 60 * 1000
  ) {
    return {
      ok: false,
      route: ROUTE,
      bootstrapRoute: BOOTSTRAP_ROUTE,
      httpStatus: response.status,
      bootstrapHttpStatus: bootstrapResponse.status,
      latencyMs,
      bootstrapLatencyMs,
      error: 'stale_bootstrap_contract',
    };
  }
  return {
    ok: true,
    route: ROUTE,
    bootstrapRoute: BOOTSTRAP_ROUTE,
    httpStatus: response.status,
    bootstrapHttpStatus: bootstrapResponse.status,
    latencyMs,
    bootstrapLatencyMs,
    generatedAt: typeof snapshot?.generatedAt === 'string' ? snapshot.generatedAt : null,
    bootstrapGeneratedAt: bootstrapSnapshot.generatedAt,
    groupStates,
    bootstrapGroupStates: Object.fromEntries(
      bootstrapSnapshot.groups.map((candidate) => [candidate.id, candidate.state]),
    ),
  };
}

async function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const staticAudit = auditChinaDecisionStaticRegistrations(repoRoot);
  const urlIndex = process.argv.indexOf('--url');
  const live = urlIndex >= 0 && process.argv[urlIndex + 1]
    ? await probeChinaDecisionParity(process.argv[urlIndex + 1])
    : null;
  const result = { static: staticAudit, ...(live ? { live } : {}) };
  console.log(JSON.stringify(result, null, 2));
  if (!staticAudit.ok || (live && !live.ok)) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
