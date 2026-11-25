#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import {
  BOOTSTRAP_CACHE_KEYS,
  bootstrapTierKeyNames,
} from '../shared/bootstrap-tier-keys.js';
import {
  canadaAlertsCutoverFallbackValue,
  extraCanadaAlertsCutoverReadKeys,
} from '../shared/canada-alerts-cutover.js';
import { buildBootstrapTierEnvelope } from '../shared/bootstrap-tier-envelope.js';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';
import { evaluatePublishedBootstrapVolume } from './_bootstrap-payload-budget.mjs';
import { restoreWildfireBootstrapMetadata, sanitizeBootstrapValue } from './_bootstrap-public-payload.mjs';
import { loadEnvFile } from './_seed-utils.mjs';
import {
  putKvJsonValue,
  resolveKvStorageConfig,
} from './_kv-storage.mjs';

const NEG_SENTINEL = '__WM_NEG__';
const REDIS_PIPELINE_TIMEOUT_MS = 30_000;
const TIER_INTERVAL_MS = Object.freeze({
  fast: 2 * 60_000,
  slow: 10 * 60_000,
});
const TIER_ORDER = Object.freeze(['fast', 'slow']);
const PUBLISHER_LARGEST_KEY_LIMIT = 5;

// R4 (#6654) fields that must never appear in a bootstrap-tier payload.
// `text` is the X post body (first-party only, via /api/x-feed); `pollState` is
// seed-internal cursor state.
// Kept in sync with stripXFeedRestrictedFields in api/bootstrap.js.
export { stripXFeedRestrictedFields } from './_bootstrap-public-payload.mjs';

function assertTier(tier) {
  if (!Object.hasOwn(TIER_INTERVAL_MS, tier)) {
    throw new TypeError(`Unknown tier: ${tier}`);
  }
}

function canonicalRegistries(env = process.env) {
  const rawIranEventsEnabled = env.IRAN_EVENTS_ENABLED;
  if (!/^(?:true|false)$/i.test(rawIranEventsEnabled ?? '')) {
    throw new Error('Bootstrap publisher requires explicit IRAN_EVENTS_ENABLED=true|false');
  }
  const iranEventsEnabled = rawIranEventsEnabled.toLowerCase() === 'true';
  return Object.fromEntries(TIER_ORDER.map(tier => [
    tier,
    Object.fromEntries(bootstrapTierKeyNames(tier, { iranEventsEnabled }).map(name => [
      name,
      BOOTSTRAP_CACHE_KEYS[name],
    ])),
  ]));
}

function redisCredentials(env) {
  const url = env.UPSTASH_REDIS_REST_URL?.replace(/\/+$/, '');
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Bootstrap publisher Redis credentials are missing');
  return { url, token };
}

function parseBootstrapPipelineEntry(entry, index, key) {
  if (!entry || typeof entry !== 'object' || !Object.hasOwn(entry, 'result') || entry.error != null) {
    throw new Error(`Bootstrap Redis pipeline command failed at index ${index}`);
  }

  if (!entry.result) return { present: false, value: undefined };
  try {
    const parsed = JSON.parse(entry.result);
    if (parsed !== NEG_SENTINEL) {
      // Presence is independent of the unwrapped value. A well-formed envelope
      // can unwrap to `data === undefined`; origin still records Map.has(key)
      // and reports that field missing instead of applying a sibling fallback.
      const { data, _seed } = unwrapEnvelope(parsed);
      return {
        present: true,
        value: key === BOOTSTRAP_CACHE_KEYS.wildfires ? restoreWildfireBootstrapMetadata(data, _seed) : data,
      };
    }
  } catch {
    // Malformed values match /api/bootstrap: omit from data and report missing.
  }
  return { present: false, value: undefined };
}

/**
 * Assemble the exact public `{ data, missing }` payload for an ordered registry.
 * Infrastructure or command-shape failures reject the whole operation; missing,
 * malformed, negative-sentinel values remain per-key misses.
 *
 * When `canadaAlerts` is in the registry, the #6659 cutover fallback keys are
 * also read so a missing `alerts:canada:v1` still hydrates the field — the same
 * contract `/api/bootstrap` applies on the origin path. KV serving must not
 * bypass that fallback (#7291).
 */
export async function assembleBootstrapTierPayload(registry, options = {}) {
  const env = options.env ?? process.env;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? REDIS_PIPELINE_TIMEOUT_MS;
  const { url, token } = redisCredentials(env);
  const names = Object.keys(registry);
  const keys = Object.values(registry);
  const extraKeys = extraCanadaAlertsCutoverReadKeys(keys, BOOTSTRAP_CACHE_KEYS.canadaAlerts);
  const readKeys = extraKeys.length > 0 ? [...keys, ...extraKeys] : keys;
  const response = await fetchFn(`${url}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'WorldMonitor Bootstrap Publisher/1.0',
    },
    body: JSON.stringify(readKeys.map(key => ['GET', key])),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Bootstrap Redis pipeline HTTP ${response.status}`);
  }

  const results = await response.json();
  if (!Array.isArray(results) || results.length !== readKeys.length) {
    throw new Error('Bootstrap Redis pipeline returned the wrong result count');
  }

  const valuesByKey = new Map();
  for (let index = 0; index < readKeys.length; index += 1) {
    const parsed = parseBootstrapPipelineEntry(results[index], index, readKeys[index]);
    if (parsed.present) valuesByKey.set(readKeys[index], parsed.value);
  }

  const data = {};
  const missing = [];
  for (let index = 0; index < names.length; index += 1) {
    let value = keys[index] === BOOTSTRAP_CACHE_KEYS.canadaAlerts
      && !valuesByKey.has(BOOTSTRAP_CACHE_KEYS.canadaAlerts)
      ? canadaAlertsCutoverFallbackValue(valuesByKey)
      : valuesByKey.get(keys[index]);

    if (value === undefined) {
      missing.push(names[index]);
      continue;
    }

    data[names[index]] = sanitizeBootstrapValue(names[index], value);
  }

  return { data, missing };
}

/**
 * Measure the exact public `{ data, missing }` JSON payload. Key entries retain
 * payload insertion order; callers can sort a copy for bounded diagnostics.
 */
export function buildBootstrapPayloadByteLedger(payload) {
  if (
    !payload
    || typeof payload !== 'object'
    || Array.isArray(payload)
    || !payload.data
    || typeof payload.data !== 'object'
    || Array.isArray(payload.data)
    || !Array.isArray(payload.missing)
  ) {
    throw new TypeError('Bootstrap byte ledger requires a { data, missing } payload');
  }

  const keys = Object.entries(payload.data).map(([key, value]) => {
    const serializedValue = JSON.stringify(value);
    if (serializedValue === undefined) {
      throw new TypeError(`Bootstrap byte ledger cannot serialize key: ${key}`);
    }
    const valueBytes = Buffer.byteLength(serializedValue, 'utf8');
    return {
      key,
      bytes: Buffer.byteLength(JSON.stringify(key), 'utf8') + 1 + valueBytes,
      valueBytes,
    };
  });
  const dataEntryBytes = keys.reduce((total, entry) => total + entry.bytes, 0);
  const dataSeparatorBytes = Math.max(0, keys.length - 1);
  const missingJson = JSON.stringify(payload.missing);

  return {
    totalBytes: Buffer.byteLength('{"data":{', 'utf8')
      + dataEntryBytes
      + dataSeparatorBytes
      + Buffer.byteLength(`},"missing":${missingJson}}`, 'utf8'),
    keys,
  };
}

export async function publishBootstrapTier(tier, options = {}) {
  assertTier(tier);
  const env = options.env ?? process.env;
  const resolveRegistry = options.resolveRegistry ?? canonicalRegistries;
  const registries = resolveRegistry(env);
  const registry = registries[tier];
  if (!registry || typeof registry !== 'object') {
    throw new Error(`Bootstrap registry is unavailable for tier ${tier}`);
  }

  const resolveKvStorage = options.resolveKvStorage ?? resolveKvStorageConfig;
  const kvConfig = resolveKvStorage(env);
  if (!kvConfig) throw new Error('Bootstrap publisher KV credentials are missing');

  const payload = await assembleBootstrapTierPayload(registry, {
    env,
    fetchFn: options.fetchFn,
    timeoutMs: options.redisTimeoutMs,
  });
  const payloadLedger = buildBootstrapPayloadByteLedger(payload);
  const keyBytes = Object.fromEntries(
    payloadLedger.keys.map(({ key, valueBytes }) => [key, valueBytes]),
  );
  const largestKeys = [...payloadLedger.keys]
    .sort((left, right) => right.bytes - left.bytes || left.key.localeCompare(right.key))
    .slice(0, PUBLISHER_LARGEST_KEY_LIMIT)
    .map(({ key, bytes }) => ({ key, bytes }));
  const volume = evaluatePublishedBootstrapVolume(tier, payloadLedger);

  // Write the versioned envelope to Cloudflare Workers KV under the bare tier key
  // (`fast`/`slow`) so the serving Worker reads `env.KV.get(tier)`. Errors propagate
  // loudly so credential, network, or 25 MiB cap failures are never swallowed.
  const generatedAt = (options.now ?? Date.now)();
  const envelope = buildBootstrapTierEnvelope({ generatedAt, tier, payload });
  const putKv = options.putKv ?? putKvJsonValue;
  const write = await putKv(kvConfig, tier, envelope, { fetchFn: options.kvFetchFn });

  return {
    tier,
    generatedAt,
    missing: payload.missing.length,
    bytes: write?.bytes ?? null,
    payloadBytes: payloadLedger.totalBytes,
    keyBytes,
    largestKeys,
    volume,
  };
}

function defaultSleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Run one serialized, deadline-anchored dual-tier publisher loop. */
export async function runPublisherLoop(options = {}) {
  const publishTier = options.publishTier ?? (tier => publishBootstrapTier(tier));
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const signal = options.signal;
  const logger = options.logger ?? console;
  const maxPublishes = options.maxPublishes ?? Number.POSITIVE_INFINITY;
  const startedAt = now();
  const nextDue = { fast: startedAt, slow: startedAt };
  let publishCount = 0;

  while (!signal?.aborted && publishCount < maxPublishes) {
    const current = now();
    const due = TIER_ORDER
      .filter(tier => nextDue[tier] <= current)
      .sort((left, right) => nextDue[left] - nextDue[right]
        || TIER_ORDER.indexOf(left) - TIER_ORDER.indexOf(right));

    if (due.length === 0) {
      const waitMs = Math.max(0, Math.min(...TIER_ORDER.map(tier => nextDue[tier])) - current);
      await sleep(waitMs, signal);
      continue;
    }

    const tier = due[0];
    try {
      const result = await publishTier(tier);
      logger.info?.('[bootstrap-kv] published', {
        tier,
        generatedAt: result?.generatedAt ?? null,
        artifactBytes: result?.bytes ?? null,
        payloadBytes: result?.payloadBytes ?? null,
        missing: result?.missing ?? null,
        keyBytes: result?.keyBytes ?? {},
        largestKeys: result?.largestKeys ?? [],
        volumeAlerts: result?.volume?.alerts ?? [],
      });
      if (result?.volume?.alerts?.length) {
        logger.warn?.('[bootstrap-volume] published payload exceeded frozen budget', {
          tier,
          payloadBytes: result.payloadBytes ?? null,
          ceilingBytes: result.volume.ceilingBytes ?? null,
          alerts: result.volume.alerts,
        });
      }
    } catch (error) {
      logger.warn?.(`[bootstrap-kv] publish failed tier=${tier}: ${error?.message ?? String(error)}`);
    } finally {
      publishCount += 1;
      do {
        nextDue[tier] += TIER_INTERVAL_MS[tier];
      } while (nextDue[tier] <= now());
    }
  }
}

function parseArgs(args) {
  let mode = null;
  let tier = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--loop') mode = 'loop';
    else if (arg.startsWith('--tier=')) tier = arg.slice('--tier='.length);
    else if (arg === '--tier') tier = args[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (tier != null) {
    assertTier(tier);
    if (mode) throw new Error('Choose either --loop or --tier, not both');
    mode = 'tier';
  }
  if (!mode) throw new Error('Usage: publish-bootstrap-tiers.mjs --loop | --tier=fast|slow');
  return { mode, tier };
}

async function main() {
  loadEnvFile(import.meta.url);
  const { mode, tier } = parseArgs(process.argv.slice(2));
  if (mode === 'tier') {
    const result = await publishBootstrapTier(tier);
    console.log(JSON.stringify(result));
    return;
  }

  const controller = new AbortController();
  const stop = signal => {
    console.info(`[bootstrap-kv] received ${signal}; stopping after the active publish`);
    controller.abort();
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
  await runPublisherLoop({ signal: controller.signal });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Terminal success marker. Emitted from .then() so it can ONLY print after main() has fully
  // resolved — a throw anywhere inside, including a late publish step, skips it. Any marker
  // written INSIDE main() would print before later work and could vouch for a run that then
  // died (exactly how #6092 stayed invisible). Format mirrors runSeed() so the crash
  // diagnostic recognises it; without it a clean run is indistinguishable from a silent death.
  const __runStartedAt = Date.now();
  main()
    .then(() => console.log(`\n=== Done (${Date.now() - __runStartedAt}ms) ===`))
    .catch(error => {
      console.error(`[bootstrap-kv] fatal: ${error?.message ?? String(error)}`);
      process.exitCode = 1;
    });
}
