#!/usr/bin/env node

import { loadEnvFile, runSeed, CHROME_UA } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

export const CANONICAL_KEY = 'supply_chain:portwatch:v1';
const TTL = 43_200; // 12h — 2× the 6h cron interval

const ARCGIS_BASE =
  'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Chokepoints_Data/FeatureServer/0/query';
const PAGE_SIZE = 2000;
const FETCH_TIMEOUT = 30_000;
const HISTORY_DAYS = 180;
const CONCURRENCY = 3;

export const CHOKEPOINTS = [
  { name: 'Suez Canal',          id: 'suez' },
  { name: 'Malacca Strait',      id: 'malacca_strait' },
  { name: 'Strait of Hormuz',    id: 'hormuz_strait' },
  { name: 'Bab el-Mandeb Strait', id: 'bab_el_mandeb' },
  { name: 'Panama Canal',        id: 'panama' },
  { name: 'Taiwan Strait',       id: 'taiwan_strait' },
  { name: 'Cape of Good Hope',   id: 'cape_of_good_hope' },
  { name: 'Gibraltar Strait',    id: 'gibraltar' },
  { name: 'Bosporus Strait',     id: 'bosphorus' },
  { name: 'Korea Strait',        id: 'korea_strait' },
  { name: 'Dover Strait',        id: 'dover_strait' },
  { name: 'Kerch Strait',        id: 'kerch_strait' },
  { name: 'Lombok Strait',       id: 'lombok_strait' },
];

function formatDate(epochMs) {
  const d = new Date(epochMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function epochToTimestamp(epochMs) {
  const d = new Date(epochMs);
  const p = (n) => String(n).padStart(2, '0');
  return `timestamp '${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}'`;
}

function computeWow(history) {
  if (history.length < 14) return 0;
  const sorted = [...history].sort((a, b) => b.date.localeCompare(a.date));
  let thisWeek = 0;
  let lastWeek = 0;
  for (let i = 0; i < 7 && i < sorted.length; i++) thisWeek += sorted[i].total;
  for (let i = 7; i < 14 && i < sorted.length; i++) lastWeek += sorted[i].total;
  if (lastWeek === 0) return 0;
  return Math.round(((thisWeek - lastWeek) / lastWeek) * 1000) / 10;
}

async function fetchAllPages(portname, sinceEpoch) {
  const all = [];
  let offset = 0;
  for (;;) {
    const params = new URLSearchParams({
      where: `portname='${portname.replace(/'/g, "''")}' AND date >= ${epochToTimestamp(sinceEpoch)}`,
      outFields: [
        'date',
        'n_container', 'n_dry_bulk', 'n_general_cargo', 'n_roro', 'n_tanker', 'n_total',
        'capacity_container', 'capacity_dry_bulk', 'capacity_general_cargo', 'capacity_roro', 'capacity_tanker',
      ].join(','),
      f: 'json',
      resultOffset: String(offset),
      resultRecordCount: String(PAGE_SIZE),
    });
    const resp = await fetch(`${ARCGIS_BASE}?${params}`, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!resp.ok) throw new Error(`ArcGIS HTTP ${resp.status} for ${portname}`);
    const body = await resp.json();
    if (body.error) throw new Error(`ArcGIS error for ${portname}: ${body.error.message}`);
    if (body.features?.length) all.push(...body.features);
    if (!body.exceededTransferLimit) break;
    offset += PAGE_SIZE;
  }
  return all;
}

function buildHistory(features) {
  return features
    .filter(f => f.attributes?.date)
    .map(f => {
      const a = f.attributes;
      const container = Number(a.n_container ?? 0);
      const dryBulk = Number(a.n_dry_bulk ?? 0);
      const generalCargo = Number(a.n_general_cargo ?? 0);
      const roro = Number(a.n_roro ?? 0);
      const tanker = Number(a.n_tanker ?? 0);
      const total = Number(a.n_total ?? container + dryBulk + generalCargo + roro + tanker);
      return {
        date: formatDate(a.date),
        container, dryBulk, generalCargo, roro, tanker,
        cargo: container + dryBulk + generalCargo + roro,
        other: 0,
        total,
        capContainer: Number(a.capacity_container ?? 0),
        capDryBulk: Number(a.capacity_dry_bulk ?? 0),
        capGeneralCargo: Number(a.capacity_general_cargo ?? 0),
        capRoro: Number(a.capacity_roro ?? 0),
        capTanker: Number(a.capacity_tanker ?? 0),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function fetchAll() {
  const sinceEpoch = Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000;
  const result = {};
  for (let i = 0; i < CHOKEPOINTS.length; i += CONCURRENCY) {
    const batch = CHOKEPOINTS.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(batch.map(cp => fetchAllPages(cp.name, sinceEpoch)));
    for (let j = 0; j < batch.length; j++) {
      const outcome = settled[j];
      if (outcome.status === 'rejected') {
        console.warn(`  [PortWatch] ${batch[j].name}: ${outcome.reason?.message || outcome.reason}`);
        continue;
      }
      if (!outcome.value.length) continue;
      const history = buildHistory(outcome.value);
      result[batch[j].id] = { history, wowChangePct: computeWow(history) };
    }
  }
  if (Object.keys(result).length === 0) throw new Error('No chokepoints returned data');
  return result;
}

export function validateFn(data) {
  return data && typeof data === 'object' && Object.keys(data).length >= 5;
}

const isMain = process.argv[1]?.endsWith('seed-portwatch.mjs');
if (isMain) {
  runSeed('supply_chain', 'portwatch', CANONICAL_KEY, fetchAll, {
    validateFn,
    ttlSeconds: TTL,
    sourceVersion: 'imf-portwatch-arcgis-v1',
    recordCount: (data) => Object.keys(data).length,
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
