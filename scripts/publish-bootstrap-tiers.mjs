#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import {
  BOOTSTRAP_CACHE_KEYS,
  bootstrapTierKeyNames,
} from '../shared/bootstrap-tier-keys.js';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';
import { compactWildfireDashboardPayload } from './_wildfire-dashboard.mjs';
import { loadEnvFile } from './_seed-utils.mjs';
import {
  putR2JsonObject,
  resolveR2StorageConfig,
} from './_r2-storage.mjs';
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

/**
 * Assemble the exact public `{ data, missing }` payload for an ordered registry.
 * Infrastructure or command-shape failures reject the whole operation; missing,
 * malformed, negative-sentinel values remain per-key misses.
 */
export async function assembleBootstrapTierPayload(registry, options = {}) {
  const env = options.env ?? process.env;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? REDIS_PIPELINE_TIMEOUT_MS;
  const { url, token } = redisCredentials(env);
  const names = Object.keys(registry);
  const keys = Object.values(registry);
  const response = await fetchFn(`${url}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'WorldMonitor Bootstrap Publisher/1.0',
    },
    body: JSON.stringify(keys.map(key => ['GET', key])),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Bootstrap Redis pipeline HTTP ${response.status}`);
  }

  const results = await response.json();
  if (!Array.isArray(results) || results.length !== keys.length) {
    throw new Error('Bootstrap Redis pipeline returned the wrong result count');
  }

  const data = {};
  const missing = [];
  for (let index = 0; index < names.length; index += 1) {
    const entry = results[index];
    if (!entry || typeof entry !== 'object' || !Object.hasOwn(entry, 'result') || entry.error != null) {
      throw new Error(`Bootstrap Redis pipeline command failed at index ${index}`);
    }

    let value;
    if (entry.result) {
      try {
        const parsed = JSON.parse(entry.result);
        if (parsed !== NEG_SENTINEL) value = unwrapEnvelope(parsed).data;
      } catch {
        // Malformed values match /api/bootstrap: omit from data and report missing.
      }
    }

    if (value === undefined) {
      missing.push(names[index]);
      continue;
    }

    if (
      names[index] === 'forecasts'
      && value !== null
      && typeof value === 'object'
      && !Array.isArray(value)
      && Object.hasOwn(value, 'enrichmentMeta')
    ) {
      const { enrichmentMeta: _stripped, ...rest } = value;
      value = rest;
    }
    if (names[index] === 'wildfires') value = compactWildfireDashboardPayload(value);
    data[names[index]] = value;
  }

  return { data, missing };
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

  const payload = await assembleBootstrapTierPayload(registry, {
    env,
    fetchFn: options.fetchFn,
    timeoutMs: options.redisTimeoutMs,
  });
  const resolveStorage = options.resolveStorage
    ?? (storageEnv => resolveR2StorageConfig(storageEnv, { profile: 'bootstrap' }));
  const storage = resolveStorage(env);
  if (!storage) throw new Error('Bootstrap publisher R2 credentials are missing');

  const generatedAt = (options.now ?? Date.now)();
  const envelope = { generatedAt, tier, payload };
  const putObject = options.putObject ?? putR2JsonObject;
  const write = await putObject(storage, `${tier}.json`, envelope, {
    tier,
    generatedAt: String(generatedAt),
  });

  // KV parity write (#5300 KV serving plan). The SAME envelope, keyed by bare tier name
  // (`fast`/`slow`) so the serving Worker reads `env.KV.get(tier)`. Best-effort and gated by
  // credential presence: a KV failure — including the 25 MiB guard tripping — must never abort
  // the canonical R2 publish, but it is logged loudly so a chronic failure is visible.
  const kv = await publishTierToKv(tier, envelope, { ...options, env, logger: options.logger });

  return { tier, generatedAt, missing: payload.missing.length, bytes: write?.bytes ?? null, kv };
}

/**
 * Best-effort KV write of a tier envelope. Skips silently when KV is unconfigured (so R2-only
 * deploys are unaffected); on failure, logs and returns `{ ok: false }` without throwing.
 */
export async function publishTierToKv(tier, envelope, options = {}) {
  const env = options.env ?? process.env;
  const resolveKv = options.resolveKvStorage ?? resolveKvStorageConfig;
  const config = resolveKv(env);
  if (!config) return { skipped: true };

  const putKv = options.putKv ?? putKvJsonValue;
  const logger = options.logger ?? console;
  try {
    const result = await putKv(config, tier, envelope, { fetchFn: options.kvFetchFn });
    return { ok: true, bytes: result?.bytes ?? null };
  } catch (err) {
    logger.error?.(`[bootstrap-kv] tier=${tier} KV write failed: ${err?.message ?? err}`);
    return { ok: false, error: err?.message ?? String(err) };
  }
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
      const kvStatus = result?.kv?.skipped ? 'skipped'
        : result?.kv?.ok ? `${result.kv.bytes}b`
        : `FAILED(${result?.kv?.error ?? 'unknown'})`;
      logger.info?.(`[bootstrap-r2] published tier=${tier} generatedAt=${result?.generatedAt ?? 'unknown'} bytes=${result?.bytes ?? 'unknown'} missing=${result?.missing ?? 'unknown'} kv=${kvStatus}`);
    } catch (error) {
      logger.warn?.(`[bootstrap-r2] publish failed tier=${tier}: ${error?.message ?? String(error)}`);
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
    console.info(`[bootstrap-r2] received ${signal}; stopping after the active publish`);
    controller.abort();
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
  await runPublisherLoop({ signal: controller.signal });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`[bootstrap-r2] fatal: ${error?.message ?? String(error)}`);
    process.exitCode = 1;
  });
}
