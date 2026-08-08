#!/usr/bin/env node

import { getRedisCredentials, loadEnvFile, readSeedSnapshot } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'resilience:recovery:import-hhi:v1';
const SEED_META_KEY = 'seed-meta:resilience:recovery:import-hhi';
const DEFAULT_REPORTERS = ['AE', 'RU', 'NO', 'CH'];
const API_BASE = process.env.API_BASE_URL || 'https://api.worldmonitor.app';
const REDIS_ONLY = process.env.IMPORT_HHI_VERIFY_REDIS_ONLY === '1';
const WM_KEY = process.env.WORLDMONITOR_API_KEY
  || (process.env.WORLDMONITOR_VALID_KEYS ?? '').split(',').map(k => k.trim()).filter(Boolean)[0]
  || '';

function parseReporters() {
  const raw = process.env.IMPORT_HHI_VERIFY_REPORTERS;
  if (!raw) return DEFAULT_REPORTERS;
  const reporters = raw.split(',').map(v => v.trim().toUpperCase()).filter(Boolean);
  return reporters.length > 0 ? reporters : DEFAULT_REPORTERS;
}

function findImportConcentration(score) {
  for (const domain of score?.domains ?? []) {
    const hit = (domain?.dimensions ?? []).find(dim => dim?.id === 'importConcentration');
    if (hit) return hit;
  }
  return null;
}

async function fetchLiveScore(countryCode) {
  const headers = {
    'User-Agent': 'WorldMonitor-ImportHHI-Verify/1.0',
    Accept: 'application/json',
  };
  if (WM_KEY) headers['X-WorldMonitor-Key'] = WM_KEY;
  const url = `${API_BASE.replace(/\/$/, '')}/api/resilience/v1/get-resilience-score?countryCode=${encodeURIComponent(countryCode)}`;
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text);
}

function formatValue(value) {
  return value == null || value === '' ? 'n/a' : String(value);
}

async function main() {
  getRedisCredentials();
  const reporters = parseReporters();
  const [canonical, seedMeta] = await Promise.all([
    readSeedSnapshot(CANONICAL_KEY),
    readSeedSnapshot(SEED_META_KEY),
  ]);

  const countries = canonical?.countries ?? {};
  const failures = [];
  console.log(`[import-hhi-verify] seedMeta.fetchedAt=${formatValue(seedMeta?.fetchedAt)} recordCount=${formatValue(seedMeta?.recordCount)}`);

  for (const countryCode of reporters) {
    const canonicalEntry = countries[countryCode] ?? null;
    let liveDim = null;
    let liveError = '';
    if (!REDIS_ONLY) {
      try {
        const liveScore = await fetchLiveScore(countryCode);
        liveDim = findImportConcentration(liveScore);
      } catch (err) {
        liveError = err?.message || String(err);
      }
    }

    const canonicalOk = Boolean(canonicalEntry);
    const liveOk = REDIS_ONLY || (liveDim && liveDim.coverage > 0 && !liveDim.imputationClass);
    if (!canonicalOk) failures.push(`${countryCode}:missing-canonical`);
    if (!liveOk) failures.push(`${countryCode}:live-not-observed`);

    console.log(
      `[import-hhi-verify] ${countryCode} ` +
      `canonical=${canonicalOk ? 'present' : 'missing'} ` +
      `hhi=${formatValue(canonicalEntry?.hhi)} year=${formatValue(canonicalEntry?.year)} ` +
      `liveCoverage=${REDIS_ONLY ? 'skipped' : formatValue(liveDim?.coverage)} ` +
      `liveImputation=${REDIS_ONLY ? 'skipped' : formatValue(liveDim?.imputationClass)} ` +
      `liveError=${formatValue(liveError)}`,
    );
  }

  if (failures.length > 0) {
    console.error(`[import-hhi-verify] FAIL ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log(`[import-hhi-verify] OK ${reporters.join(',')} present in ${CANONICAL_KEY}${REDIS_ONLY ? ' (Redis-only)' : ' and observed in live scores'}`);
}

main().catch((err) => {
  console.error(`[import-hhi-verify] FATAL ${err?.message || err}`);
  process.exit(1);
});
