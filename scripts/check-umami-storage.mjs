#!/usr/bin/env node

/**
 * Read-only capacity and growth check for the Railway Postgres volume backing
 * the external Umami service.
 *
 * Railway exposes the current volume size through `railway volume list`. The
 * scheduled workflow supplies that JSON and caches a bounded sample history so
 * this check can alert on projected days-to-full as well as absolute usage.
 * It never connects to Postgres and never deletes data.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs as parseNodeArgs } from 'node:util';

import { isMainModule } from './lib/main-module.mjs';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const UMAMI_STORAGE_POLICY = Object.freeze({
  serviceName: 'Postgres Umami',
  historyDays: 30,
  minimumProjectionWindowMs: DAY_MS,
  warningUsageRatio: 0.8,
  criticalUsageRatio: 0.9,
  warningHeadroomDays: 30,
  criticalHeadroomDays: 14,
});

function finiteNonNegative(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function timestampMs(value) {
  const valueMs = typeof value === 'number'
    ? value
    : value instanceof Date
      ? value.getTime()
      : Date.parse(String(value));
  return Number.isFinite(valueMs) ? valueMs : null;
}

function volumeIdentity(volume) {
  const identity = volume?.id ?? volume?.volumeId ?? volume?.name ?? volume?.serviceName;
  return identity === null || identity === undefined ? null : String(identity);
}

function unwrapCollection(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value.edges)) return value.edges.map((edge) => edge?.node ?? edge);
  if (Array.isArray(value.nodes)) return value.nodes;
  return [];
}

export function normalizeVolumeRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  return unwrapCollection(payload.volumes ?? payload);
}

function normalizeSamples(samples, nowMs) {
  if (!Array.isArray(samples)) return [];
  const cutoff = nowMs - UMAMI_STORAGE_POLICY.historyDays * DAY_MS;
  return samples
    .map((sample) => {
      const sampledAtMs = timestampMs(sample?.sampledAt);
      const currentSizeMB = finiteNonNegative(sample?.currentSizeMB);
      if (sampledAtMs === null || currentSizeMB === null) return null;
      if (sampledAtMs < cutoff || sampledAtMs > nowMs) return null;
      return {
        sampledAt: new Date(sampledAtMs).toISOString(),
        currentSizeMB,
      };
    })
    .filter(Boolean)
    .sort((a, b) => Date.parse(a.sampledAt) - Date.parse(b.sampledAt));
}

export function updateStorageState(previousState, volume, now = Date.now()) {
  const nowMs = timestampMs(now);
  if (nowMs === null) throw new Error('Storage sample time must be a valid timestamp');
  const capacityMB = finiteNonNegative(volume?.sizeMB);
  if (capacityMB === null || capacityMB <= 0) throw new Error('Umami volume sizeMB must be greater than zero');
  const currentSizeMB = finiteNonNegative(volume?.currentSizeMB);
  if (currentSizeMB === null) throw new Error('Umami volume currentSizeMB must be a non-negative number');
  const identity = volumeIdentity(volume);
  if (identity === null) throw new Error('Umami volume must have a stable identity');

  const priorCapacityMB = finiteNonNegative(previousState?.capacityMB);
  const sameVolume = previousState?.volumeIdentity === identity && priorCapacityMB === capacityMB;
  const samples = (sameVolume ? normalizeSamples(previousState?.samples, nowMs) : [])
    .filter((sample) => Date.parse(sample.sampledAt) !== nowMs);
  samples.push({ sampledAt: new Date(nowMs).toISOString(), currentSizeMB });
  return { version: 1, volumeIdentity: identity, capacityMB, samples };
}

export function evaluateUmamiStorage({ volume, samples = [], now = Date.now() }) {
  const nowMs = timestampMs(now);
  const capacityMB = finiteNonNegative(volume?.sizeMB);
  const currentSizeMB = finiteNonNegative(volume?.currentSizeMB);
  if (nowMs === null) throw new Error('Storage evaluation time must be a valid timestamp');
  if (capacityMB === null || capacityMB <= 0) throw new Error('Umami volume sizeMB must be greater than zero');
  if (currentSizeMB === null) throw new Error('Umami volume currentSizeMB must be a non-negative number');
  if (volume.status !== 'Ready') throw new Error(`Umami volume is not ready: ${volume.status ?? 'unknown'}`);

  const usageRatio = currentSizeMB / capacityMB;
  const history = normalizeSamples(samples, nowMs);
  const baseline = history
    .filter((sample) => nowMs - Date.parse(sample.sampledAt) >= UMAMI_STORAGE_POLICY.minimumProjectionWindowMs)
    .at(-1);

  let growthMBPerDay = null;
  let projectedHeadroomDays = null;
  if (baseline) {
    const elapsedDays = (nowMs - Date.parse(baseline.sampledAt)) / DAY_MS;
    const growthMB = currentSizeMB - baseline.currentSizeMB;
    if (elapsedDays > 0 && growthMB > 0) {
      growthMBPerDay = growthMB / elapsedDays;
      const remainingMB = Math.max(0, capacityMB - currentSizeMB);
      projectedHeadroomDays = remainingMB / growthMBPerDay;
    } else {
      growthMBPerDay = 0;
      projectedHeadroomDays = Infinity;
    }
  }

  const critical = usageRatio >= UMAMI_STORAGE_POLICY.criticalUsageRatio
    || (projectedHeadroomDays !== null && projectedHeadroomDays <= UMAMI_STORAGE_POLICY.criticalHeadroomDays);
  const warning = critical || usageRatio >= UMAMI_STORAGE_POLICY.warningUsageRatio
    || (projectedHeadroomDays !== null && projectedHeadroomDays <= UMAMI_STORAGE_POLICY.warningHeadroomDays);

  return {
    serviceName: volume.serviceName ?? null,
    volumeName: volume.name ?? null,
    capacityMB,
    currentSizeMB,
    usagePercent: usageRatio * 100,
    growthMBPerDay,
    projectedHeadroomDays,
    status: critical ? 'critical' : warning ? 'warning' : 'healthy',
    alerting: warning,
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function findUmamiVolume(rows, serviceName = UMAMI_STORAGE_POLICY.serviceName) {
  const matches = rows.filter((row) => row?.serviceName === serviceName);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one Railway volume for ${serviceName}, found ${matches.length}`);
  }
  return matches[0];
}

function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(temporaryPath, path);
}

function formatDays(value) {
  return value === null ? 'unavailable' : Number.isFinite(value) ? `${value.toFixed(1)} days` : 'no growth';
}

export function parseArguments(argv) {
  const { values } = parseNodeArgs({
    args: argv,
    options: {
      input: { type: 'string' },
      state: { type: 'string' },
    },
    allowPositionals: false,
    strict: true,
  });
  return values;
}

export function runUmamiStorageCheck({ payload, state = { version: 1, samples: [] }, now = Date.now() } = {}) {
  const rows = normalizeVolumeRows(payload);
  const volume = findUmamiVolume(rows, process.env.UMAMI_POSTGRES_SERVICE_NAME || UMAMI_STORAGE_POLICY.serviceName);
  const nextState = updateStorageState(state, volume, now);
  const result = evaluateUmamiStorage({ volume, samples: nextState.samples, now });
  return { result, state: nextState };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const inputPath = args.input || process.env.UMAMI_STORAGE_INPUT;
  const statePath = args.state || process.env.UMAMI_STORAGE_STATE || '.cache/umami-storage-state.json';
  if (!inputPath) throw new Error('Provide Railway volume JSON with --input <path> or UMAMI_STORAGE_INPUT');

  const payload = readJson(inputPath);
  const previousState = existsSync(statePath) ? readJson(statePath) : { version: 1, samples: [] };
  const { result, state } = runUmamiStorageCheck({ payload, state: previousState });
  writeState(statePath, state);

  const growth = result.growthMBPerDay === null
    ? 'growth baseline unavailable'
    : `${(result.growthMBPerDay / 1024).toFixed(3)} GiB/day`;
  console.log(
    `Umami storage ${result.status}: ${result.currentSizeMB.toFixed(1)}/${result.capacityMB.toFixed(1)} MB `
      + `(${result.usagePercent.toFixed(1)}% used), ${growth}, `
      + `projected headroom ${formatDays(result.projectedHeadroomDays)}.`,
  );
  if (result.status === 'critical') {
    console.error('::error::Umami Postgres storage is at a critical capacity or projected-headroom threshold.');
    process.exitCode = 1;
  } else if (result.status === 'warning') {
    console.error('::warning::Umami Postgres storage needs retention or capacity action before the next threshold.');
  }
}

const isMain = isMainModule(import.meta.url, process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(`Umami storage monitor failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
