#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  arrayLiteralHasStringMember,
  extractDelimitedBlock,
  objectLiteralEntryValue,
} from './lib/js-source-structure.mjs';
import { isMainModule } from './lib/main-module.mjs';
import { readChinaDecisionSignalWireContract } from './lib/openapi-codegen.mjs';
import { validateChinaDecisionSignalSnapshot } from './seed-china-decision-signals.mjs';

export { isMainModule } from './lib/main-module.mjs';

const wireContract = readChinaDecisionSignalWireContract();
export const CHINA_DECISION_PARITY_MANIFEST = Object.freeze(
  wireContract.groupManifest.map((entry) => Object.freeze(entry)),
);

const ROUTE = '/api/intelligence/v1/get-china-decision-signals';
const BOOTSTRAP_ROUTE = '/api/bootstrap?keys=chinaDecisionSignals&public=1';
const CANONICAL_KEY = 'intelligence:china-decision-signals:v1';
const META_KEY = 'seed-meta:intelligence:china-decision-signals';
const ROUTE_CACHE_TIER = 'fast';

const ACCESS_TIERS = Object.freeze([
  Object.freeze(['anonymous', 'bounded_public_summary']),
  Object.freeze(['pro', 'same_provenance_via_mcp']),
  Object.freeze(['operator', 'source_health_only']),
]);

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
  ['docs/china-decision-signals.mdx', ...ACCESS_TIERS.map(([, tier]) => tier)],
]);

// Presence checks above prove a token was not deleted or renamed. They cannot
// prove it is still *wired*: a refactor that leaves the token behind as a dead
// duplicate, a commented-out line, or an entry that drifted into a neighbouring
// container satisfies `source.includes` just as well as correct code does.
//
// The checks below close that gap for the surfaces where a silent unwiring is
// most expensive — gateway routing (the route stops being publicly reachable or
// silently changes cache tier) and access-tier gating (the anonymous/Pro/
// operator split stops being enforced). Each one locates the real container and
// asks whether the value is a member of it, so every mutation above reads as a
// finding instead of a pass. Each `verify` is a pure function of source text so
// its truth table can be exercised against mutated sources in tests.
export const CHINA_DECISION_STRUCTURAL_CHECKS = Object.freeze([
  Object.freeze({
    id: 'gateway-cache-tier',
    file: 'server/gateway.ts',
    intent: `RPC_CACHE_TIER serves ${ROUTE} at the '${ROUTE_CACHE_TIER}' tier`,
    verify(source) {
      const body = extractDelimitedBlock(source, 'const RPC_CACHE_TIER');
      if (body === null) return 'the RPC_CACHE_TIER object literal is missing or was renamed';
      const tier = objectLiteralEntryValue(body, ROUTE);
      if (tier === null) return `${ROUTE} is not a top-level RPC_CACHE_TIER key`;
      if (tier !== `'${ROUTE_CACHE_TIER}'`) {
        return `RPC_CACHE_TIER serves ${ROUTE} at ${tier}, expected '${ROUTE_CACHE_TIER}'`;
      }
      return null;
    },
  }),
  Object.freeze({
    id: 'gateway-public-no-auth',
    file: 'server/gateway.ts',
    intent: `PUBLIC_NO_AUTH_RPC_PATHS keeps ${ROUTE} reachable anonymously`,
    verify(source) {
      const body = extractDelimitedBlock(source, 'export const PUBLIC_NO_AUTH_RPC_PATHS', '[', ']');
      if (body === null) return 'the PUBLIC_NO_AUTH_RPC_PATHS array literal is missing or was renamed';
      if (!arrayLiteralHasStringMember(body, ROUTE)) {
        return `${ROUTE} is not a member of PUBLIC_NO_AUTH_RPC_PATHS`;
      }
      return null;
    },
  }),
  Object.freeze({
    id: 'access-tier-composition',
    file: 'shared/china-decision-signals.ts',
    intent: 'composeChinaDecisionSignals stamps all three access tiers',
    verify(source) {
      const composed = extractDelimitedBlock(source, 'export function composeChinaDecisionSignals');
      if (composed === null) return 'composeChinaDecisionSignals is missing or was renamed';
      // Anchor on the returned snapshot literal, not on the first `access:`
      // token in the function: a type-annotated local (`const access: T = {...}`)
      // carries that token too, and a correct-looking one would mask wrong
      // tiers on the snapshot that actually gets published.
      const snapshot = extractDelimitedBlock(composed, 'return boundChinaDecisionSignalSnapshot(');
      if (snapshot === null) return 'composeChinaDecisionSignals no longer returns a bounded snapshot literal';
      const stampedAccess = objectLiteralEntryValue(snapshot, 'access');
      if (stampedAccess === null || !stampedAccess.startsWith('{') || !stampedAccess.endsWith('}')) {
        return 'the returned snapshot no longer stamps an inline access object literal';
      }
      const access = stampedAccess.slice(1, -1);
      for (const [tier, value] of ACCESS_TIERS) {
        const stamped = objectLiteralEntryValue(access, tier);
        if (stamped !== `'${value}'`) {
          return `composeChinaDecisionSignals stamps access.${tier} as ${stamped ?? '<absent>'}, expected '${value}'`;
        }
      }
      return null;
    },
  }),
  Object.freeze({
    id: 'access-tier-validator',
    file: 'shared/china-decision-signals.ts',
    intent: 'isChinaDecisionSignalSnapshot rejects every wrong access tier',
    verify(source) {
      const body = extractDelimitedBlock(source, 'export function isChinaDecisionSignalSnapshot');
      if (body === null) return 'isChinaDecisionSignalSnapshot is missing or was renamed';
      const rejection = extractDelimitedBlock(body, 'if', '(', ')');
      if (rejection === null) return 'isChinaDecisionSignalSnapshot no longer has a rejection condition';
      for (const [tier, value] of ACCESS_TIERS) {
        if (!rejection.includes(`access?.${tier} !== '${value}'`)) {
          return `isChinaDecisionSignalSnapshot no longer rejects a wrong access.${tier}`;
        }
      }
      return null;
    },
  }),
]);

function read(repoRoot, relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

/**
 * Build the canonical snapshot the access-gating truth table is anchored on.
 *
 * `schemaVersion` defaults to the wire contract rather than a literal. Both
 * sides of this comparison used to hardcode 1 — the fixture here and
 * `validateChinaDecisionSignalSnapshot`'s own `schemaVersion === 1` — so a bump
 * to CHINA_DECISION_SIGNAL_SCHEMA_VERSION would have left the validator
 * rejecting every *real* published snapshot while this audit, testing a fixture
 * pinned to the old version, still reported a clean access-gating table.
 * Deriving it turns that silent production break into a finding at PR time.
 *
 * It is a parameter and not a closed-over constant so that mismatch stays
 * testable: today's contract version and the validator's literal are both 1, so
 * reading the default cannot tell derivation from a hardcode. Passing a bumped
 * version reproduces the post-bump world, where the validator must reject.
 *
 * @param {number} [schemaVersion] version to stamp; defaults to the contract's
 * @returns {object} a snapshot the validator is expected to accept
 */
export function canonicalAccessSnapshot(schemaVersion = wireContract.schemaVersion) {
  return {
    schemaVersion,
    generatedAt: '2026-01-01T00:00:00.000Z',
    groups: CHINA_DECISION_PARITY_MANIFEST.map(({ groupId }) => ({
      id: groupId,
      state: 'unavailable',
      reason: 'No reviewed source observation is available.',
      items: [],
      metadata: {},
    })),
    access: Object.fromEntries(ACCESS_TIERS),
  };
}

/**
 * Exercise the real published-snapshot validator instead of grepping for it:
 * the canonical shape must be accepted, and downgrading any single access tier
 * must be rejected. This is the one access-gating claim the audit can prove by
 * execution rather than by reading source text.
 *
 * @param {number} [schemaVersion] version to build the fixture at
 * @returns {string[]} one finding per broken row of the truth table
 */
export function auditChinaDecisionAccessGating(schemaVersion = wireContract.schemaVersion) {
  const findings = [];
  if (!validateChinaDecisionSignalSnapshot(canonicalAccessSnapshot(schemaVersion))) {
    findings.push('the published-snapshot validator rejects the canonical access block');
  }
  for (const [tier] of ACCESS_TIERS) {
    const mutated = canonicalAccessSnapshot(schemaVersion);
    mutated.access[tier] = 'unrestricted';
    if (validateChinaDecisionSignalSnapshot(mutated)) {
      findings.push(`the published-snapshot validator accepts a downgraded access.${tier}`);
    }
  }
  return findings;
}

export function auditChinaDecisionStaticRegistrations(repoRoot) {
  const findings = [];
  const sources = new Map();
  const failures = new Map();
  const load = (relativePath) => {
    if (!sources.has(relativePath)) {
      try {
        sources.set(relativePath, read(repoRoot, relativePath));
      } catch (error) {
        // Keep the reason: "missing" and "present but unreadable" (EACCES, a
        // dangling symlink, EISDIR) need different fixes, and this only ever
        // surfaces in a CI log where nobody can re-run it interactively.
        const code = error?.code ?? 'UNKNOWN';
        failures.set(relativePath, code === 'ENOENT' ? 'the file is missing' : `the file is unreadable (${code})`);
        sources.set(relativePath, null);
      }
    }
    return sources.get(relativePath);
  };
  const unreadable = (relativePath) => failures.get(relativePath) ?? 'the file is missing';

  for (const [relativePath, ...needles] of REQUIRED_REGISTRATIONS) {
    const source = load(relativePath);
    if (source === null) {
      findings.push({ file: relativePath, check: 'registration', detail: unreadable(relativePath) });
      continue;
    }
    for (const needle of needles) {
      if (!source.includes(needle)) {
        findings.push({ file: relativePath, check: 'registration', detail: `missing ${needle}` });
      }
    }
  }

  for (const check of CHINA_DECISION_STRUCTURAL_CHECKS) {
    const source = load(check.file);
    if (source === null) {
      findings.push({ file: check.file, check: check.id, detail: unreadable(check.file) });
      continue;
    }
    const failure = check.verify(source);
    if (failure !== null) findings.push({ file: check.file, check: check.id, detail: failure });
  }

  for (const detail of auditChinaDecisionAccessGating()) {
    findings.push({ file: 'scripts/seed-china-decision-signals.mjs', check: 'access-gating', detail });
  }

  return {
    ok: findings.length === 0,
    groupIds: CHINA_DECISION_PARITY_MANIFEST.map(({ groupId }) => groupId),
    canonicalKey: CANONICAL_KEY,
    seedMetaKey: META_KEY,
    route: ROUTE,
    structuralCheckIds: CHINA_DECISION_STRUCTURAL_CHECKS.map(({ id }) => id),
    findings,
  };
}

export const CHINA_DECISION_PARITY_USER_AGENT =
  'worldmonitor-china-parity-audit/1.0 (+https://worldmonitor.app)';

// Cloudflare managed-challenge 403s generic library User-Agents on both the
// versioned RPC paths and the public www /api/* surface, and Node's fetch sends
// `node` by default. Without a descriptive UA a keyless probe reads healthy
// production as an HTML 403 — reproduced against production on 2026-07-26,
// which is why the staging leg had never survived a real run.
const PROBE_HEADERS = Object.freeze({
  Accept: 'application/json',
  'User-Agent': CHINA_DECISION_PARITY_USER_AGENT,
});

export async function probeChinaDecisionParity(baseUrl, {
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  const url = new URL(ROUTE, `${baseUrl.replace(/\/+$/, '')}/`);
  const startedAt = now();
  const response = await fetchImpl(url, {
    headers: PROBE_HEADERS,
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
    headers: PROBE_HEADERS,
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

/**
 * Parse the audit CLI's arguments.
 *
 * `--require-live` exists because the failure mode of an automated gate is
 * silence: a workflow that loses its `--url` (typo, dropped variable, trailing
 * flag) would otherwise run only the static half and still exit 0, reporting a
 * staging audit that never happened. Unknown flags are rejected for the same
 * reason.
 *
 * @param {string[]} args argv without the node binary and script path
 * @returns {{ url: string | null, requireLive: boolean, error: string | null }}
 */
// Hosts that must never be probe targets. The probe reports HTTP status and
// latency, so an operator-supplied URL is a (weak) oracle against whatever it
// can reach; the workflow exposes the base URL as a dispatch input. This blocks
// the obvious internal targets by literal host. It deliberately does NOT claim
// to be SSRF-proof: a public hostname that resolves to a private address still
// passes, because that needs resolution-time checking this tool has no reason
// to carry.
const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.internal$/i,
  /\.local$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i,
];

/**
 * Validate a probe base URL, returning an error string or null.
 *
 * @param {string} value
 * @returns {string | null}
 */
export function validateProbeBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return `--url must be an absolute URL, got ${value}`;
  }
  if (parsed.protocol !== 'https:') {
    return `--url must use https, got ${parsed.protocol.replace(':', '') || '<none>'}`;
  }
  if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(parsed.hostname))) {
    return `--url must target a public host, got ${parsed.hostname}`;
  }
  return null;
}

export function parseChinaParityAuditArgs(args) {
  let url = null;
  let requireLive = false;
  const fail = (error) => ({ url: null, requireLive: false, error });

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--url') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) return fail('--url requires a base URL value');
      const invalid = validateProbeBaseUrl(value);
      if (invalid !== null) return fail(invalid);
      url = value;
      i += 1;
      continue;
    }
    if (arg === '--require-live') {
      requireLive = true;
      continue;
    }
    return fail(`unknown argument ${arg}`);
  }

  if (requireLive && url === null) return fail('--require-live requires --url <base-url>');
  return { url, requireLive, error: null };
}

/**
 * @param {{ staticOk: boolean, live?: { ok: boolean } | null, requireLive?: boolean }} outcome
 * @returns {0 | 1}
 */
export function resolveChinaParityExitCode({ staticOk, live = null, requireLive = false }) {
  if (!staticOk) return 1;
  if (requireLive && live === null) return 1;
  if (live !== null && !live.ok) return 1;
  return 0;
}

async function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { url, requireLive, error } = parseChinaParityAuditArgs(process.argv.slice(2));
  if (error !== null) {
    console.error(`audit-china-decision-parity: ${error}`);
    process.exitCode = 2;
    return;
  }

  const staticAudit = auditChinaDecisionStaticRegistrations(repoRoot);
  let live = null;
  if (url !== null) {
    try {
      live = await probeChinaDecisionParity(url);
    } catch (probeError) {
      // A thrown fetch (DNS, TLS, timeout, non-JSON body) is a failed probe,
      // not a crash: report it in the same sanitized shape the probe uses so
      // the JSON output stays parseable for whoever reads the failed run.
      live = { ok: false, route: ROUTE, error: 'probe_failed', detail: String(probeError?.message ?? probeError) };
    }
  }

  const result = { static: staticAudit, ...(live ? { live } : {}) };
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = resolveChinaParityExitCode({ staticOk: staticAudit.ok, live, requireLive });
}

if (isMainModule(import.meta.url, process.argv[1])) {
  await main();
}
