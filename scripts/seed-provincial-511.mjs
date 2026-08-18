#!/usr/bin/env node
// Runs as the Provincial-511 member of seed-bundle-canada (#6711), not as its own
// Railway service — six Canada seeders do not earn six slots. The bundle gates it
// on intervalMs 15min and gives the section a 240s timeout, because seven
// endpoints x three runSeed attempts can also wait on the per-host 10/60 bucket.
// Seeds Ontario 511 (events/alerts/roadconditions), Alberta 511 events and
// alerts, and Manitoba 511 events and alerts. One process ticks all three
// jurisdictions, so they clear on the same tick. Manitoba requires
// MANITOBA_511_KEY via loadEnvFile; an unset key skips that jurisdiction,
// preserves last-good without rewriting freshness, and lets fetchedAt age into
// an actionable health failure. Do not add Canada loops to ais-relay.cjs.
// Each fetch goes through acquire511Slot(hostname) inside the adapter
// (511on.ca, 511.alberta.ca, and www.manitoba511.ca are separate 10/60 buckets).

import {
  loadEnvFile,
  CHROME_UA,
  runSeed,
  writeExtraKey,
  writeSeedMeta,
  extendExistingTtl,
} from './_seed-utils.mjs';
import {
  fetchVendor511,
  isCompleteVendor511,
  ONTARIO_511,
  ALBERTA_511,
  MANITOBA_511,
  select511Records,
} from './lib/provincial-511.mjs';

loadEnvFile(import.meta.url);

const ONTARIO_KEY = 'infra:ontario-511:v1';
const ALBERTA_KEY = 'infra:alberta-511:v1';
const ALBERTA_META_KEY = 'seed-meta:infra:alberta-511';
const MANITOBA_KEY = 'infra:manitoba-511:v1';
const MANITOBA_META_KEY = 'seed-meta:infra:manitoba-511';
const CACHE_TTL = 5400; // 90 min ≥ 3× the */15 cron (900s)
const STAGGER_MS = 7000;

function stampRecords(records, source) {
  return records.map((record) => ({ ...record, source }));
}

function readManitoba511Key() {
  const raw = process.env.MANITOBA_511_KEY;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : '';
}

async function fetchOntario511() {
  const envelope = await fetchVendor511(ONTARIO_511, {
    userAgent: CHROME_UA,
    staggerMs: STAGGER_MS,
  });
  if (!isCompleteVendor511(envelope, ONTARIO_511)) {
    const failed = envelope.failedResources?.join(', ') || 'incomplete';
    const err = new Error(`Ontario 511: partial poll (${failed} failed); keeping last-good`);
    err.nonRetryable = true;
    throw err;
  }
  const combined = [...envelope.events, ...envelope.alerts, ...envelope.conditions];
  // Publish the capped map payload only (NWS weather pattern). Kind is on
  // each record; do not also persist the uncapped event/alert/condition arrays.
  return { records: stampRecords(select511Records(combined), 'ontario-511') };
}

async function fetchAlberta511() {
  const envelope = await fetchVendor511(ALBERTA_511, {
    userAgent: CHROME_UA,
    staggerMs: STAGGER_MS,
  });
  if (!isCompleteVendor511(envelope, ALBERTA_511)) {
    const failed = envelope.failedResources?.join(', ') || 'incomplete';
    const err = new Error(`Alberta 511: partial poll (${failed} failed); keeping last-good`);
    err.nonRetryable = true;
    throw err;
  }
  const combined = [...envelope.events, ...envelope.alerts];
  return { records: stampRecords(select511Records(combined), 'alberta-511') };
}

async function fetchManitoba511() {
  const key = readManitoba511Key();
  if (!key) {
    const err = new Error('Manitoba 511: not configured (MANITOBA_511_KEY missing); keeping last-good');
    err.notConfigured = true;
    err.nonRetryable = true;
    throw err;
  }
  const envelope = await fetchVendor511(MANITOBA_511, {
    userAgent: CHROME_UA,
    staggerMs: STAGGER_MS,
    key,
  });
  if (!isCompleteVendor511(envelope, MANITOBA_511)) {
    const failed = envelope.failedResources?.join(', ') || 'incomplete';
    const err = new Error(`Manitoba 511: partial poll (${failed} failed); keeping last-good`);
    err.nonRetryable = true;
    throw err;
  }
  const combined = [...envelope.events, ...envelope.alerts];
  return { records: stampRecords(select511Records(combined), 'manitoba-511') };
}

async function fetchProvincial511Tick() {
  let ontario = null;
  let alberta = null;
  let manitoba = null;
  let ontarioErr = null;
  let albertaErr = null;
  let manitobaErr = null;

  try {
    ontario = await fetchOntario511();
  } catch (err) {
    ontarioErr = err;
    console.warn(`  Ontario 511: ${err.message || err}`);
  }

  try {
    alberta = await fetchAlberta511();
  } catch (err) {
    albertaErr = err;
    console.warn(`  Alberta 511: ${err.message || err}`);
  }

  try {
    manitoba = await fetchManitoba511();
  } catch (err) {
    manitobaErr = err;
    console.warn(`  Manitoba 511: ${err.message || err}`);
  }

  if (!ontario && !alberta && !manitoba) {
    throw ontarioErr || albertaErr || manitobaErr
      || new Error('provincial-511: Ontario, Alberta, and Manitoba fetches failed');
  }

  return {
    records: ontario?.records || [],
    alberta,
    manitoba,
    _ontarioFailed: !ontario,
    _albertaFailed: !alberta,
    _manitobaFailed: !manitoba,
    _manitobaNotConfigured: Boolean(manitobaErr?.notConfigured),
  };
}

async function publishAlbertaEnvelope(records) {
  const recordCount = records.length;
  await writeExtraKey(ALBERTA_KEY, { records }, CACHE_TTL, {
    fetchedAt: Date.now(),
    recordCount,
    sourceVersion: 'alberta-511-v1',
    schemaVersion: 1,
    state: recordCount > 0 ? 'OK' : 'OK_ZERO',
  });
  await writeSeedMeta(ALBERTA_KEY, recordCount, ALBERTA_META_KEY, undefined, undefined, {
    sourceVersion: 'alberta-511-v1',
  });
}

async function preserveAlberta() {
  await extendExistingTtl([ALBERTA_KEY, ALBERTA_META_KEY], CACHE_TTL);
}

async function publishAlbertaFromTick(data) {
  if (!data || data._albertaFailed) {
    console.warn('  Alberta 511: preserving last-good (fetch failed this tick)');
    await preserveAlberta();
    return;
  }
  const records = Array.isArray(data.alberta?.records) ? data.alberta.records : [];
  await publishAlbertaEnvelope(records);
}

async function publishManitobaEnvelope(records) {
  const recordCount = records.length;
  await writeExtraKey(MANITOBA_KEY, { records }, CACHE_TTL, {
    fetchedAt: Date.now(),
    recordCount,
    sourceVersion: 'manitoba-511-v1',
    schemaVersion: 1,
    state: recordCount > 0 ? 'OK' : 'OK_ZERO',
  });
  await writeSeedMeta(MANITOBA_KEY, recordCount, MANITOBA_META_KEY, undefined, undefined, {
    sourceVersion: 'manitoba-511-v1',
  });
}

async function preserveManitoba() {
  await extendExistingTtl([MANITOBA_KEY, MANITOBA_META_KEY], CACHE_TTL);
}

async function publishManitobaFromTick(data) {
  if (data?._manitobaNotConfigured) {
    console.warn('  Manitoba 511: not configured; preserving last-good while freshness metadata ages');
    await preserveManitoba();
    return;
  }
  if (!data || data._manitobaFailed) {
    console.warn('  Manitoba 511: preserving last-good (fetch failed this tick)');
    await preserveManitoba();
    return;
  }
  const records = Array.isArray(data.manitoba?.records) ? data.manitoba.records : [];
  await publishManitobaEnvelope(records);
}

async function publishExtraJurisdictionsFromTick(data) {
  await publishAlbertaFromTick(data);
  await publishManitobaFromTick(data);
}

export function declareRecords(data) {
  return Array.isArray(data?.records) ? data.records.length : 0;
}

function validateOntario511(data) {
  return data != null && typeof data === 'object' && Array.isArray(data.records);
}

function publishOntario(data) {
  // validateFn sees this transformed payload, so a failed Ontario fetch must
  // not look like a valid empty quiet cycle or last-good Ontario is emptied.
  if (!data || data._ontarioFailed) return null;
  return { records: data.records };
}

runSeed('infra', 'ontario-511', ONTARIO_KEY, fetchProvincial511Tick, {
  validateFn: validateOntario511,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'ontario-511-v1',
  declareRecords,
  zeroIsValid: true,
  schemaVersion: 1,
  maxStaleMin: 45,
  publishTransform: publishOntario,
  preserveKeys: [ALBERTA_KEY, ALBERTA_META_KEY, MANITOBA_KEY, MANITOBA_META_KEY],
  afterPublish: publishExtraJurisdictionsFromTick,
  afterValidationSkip: publishExtraJurisdictionsFromTick,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
