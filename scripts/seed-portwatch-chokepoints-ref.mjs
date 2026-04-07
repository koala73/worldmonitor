#!/usr/bin/env node

import { loadEnvFile, runSeed, CHROME_UA, resolveProxyForConnect, httpsProxyFetchRaw } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

export const CANONICAL_KEY = 'portwatch:chokepoints:ref:v1';
const TTL = 7 * 24 * 3600; // 604800 seconds = 7 days

const ARCGIS_BASE =
  'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/PortWatch_chokepoints_database/FeatureServer/0/query';
const FETCH_TIMEOUT = 30_000;

export async function fetchAll() {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: [
      'portid', 'portname', 'fullname', 'lat', 'lon',
      'vessel_count_tanker',
      'share_country_maritime_import', 'share_country_maritime_export',
      'industry_top1', 'industry_top2', 'industry_top3',
    ].join(','),
    returnGeometry: 'false',
    outSR: '4326',
    f: 'json',
  });

  const resp = await fetch(`${ARCGIS_BASE}?${params}`, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  let body;
  if (resp.status === 429) {
    const proxyAuth = resolveProxyForConnect();
    if (!proxyAuth) throw new Error('ArcGIS HTTP 429 (rate limited) and no PROXY_URL configured');
    console.warn('  [portwatch] 429 rate-limited on chokepoints-ref — retrying via proxy');
    const { buffer } = await httpsProxyFetchRaw(`${ARCGIS_BASE}?${params}`, proxyAuth, { accept: 'application/json', timeoutMs: FETCH_TIMEOUT });
    body = JSON.parse(buffer.toString('utf8'));
  } else {
    if (!resp.ok) throw new Error(`ArcGIS HTTP ${resp.status}`);
    body = await resp.json();
  }
  if (body.error) throw new Error(`ArcGIS chokepoints-ref error: ${body.error.message}`);

  const features = body.features ?? [];
  if (!features.length) throw new Error('No chokepoint reference rows returned from ArcGIS');

  const result = {};
  for (const f of features) {
    const a = f.attributes;
    if (a?.portid == null) continue;
    const portId = String(a.portid);
    const industries = [a.industry_top1, a.industry_top2, a.industry_top3].filter(Boolean);
    result[portId] = {
      portId,
      portName: String(a.portname || ''),
      fullName: String(a.fullname || ''),
      lat: Number(a.lat ?? 0),
      lon: Number(a.lon ?? 0),
      vesselCountTanker: Number(a.vessel_count_tanker ?? 0),
      shareMaritimeImport: Number(a.share_country_maritime_import ?? 0),
      shareMaritimeExport: Number(a.share_country_maritime_export ?? 0),
      industries,
    };
  }

  return result;
}

export function validateFn(data) {
  return data != null && typeof data === 'object' && Object.keys(data).length === 28;
}

const isMain = process.argv[1]?.endsWith('seed-portwatch-chokepoints-ref.mjs');
if (isMain) {
  runSeed('portwatch', 'chokepoints-ref', CANONICAL_KEY, fetchAll, {
    validateFn,
    ttlSeconds: TTL,
    sourceVersion: 'imf-portwatch-chokepoints-arcgis-v1',
    recordCount: (data) => Object.keys(data).length,
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
