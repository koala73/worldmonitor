import { CHOKEPOINT_THREAT_LEVELS } from '../../shared/chokepoint-threat-levels.js';
import { narrowFlowSource } from '../../server/_shared/flow-source';
import { argStr, argStrList, ciIncludes, pickMapKeysLike } from './filters';
// @ts-expect-error — shared Edge-safe JavaScript content contract.
import { buildContentFreshnessAssessment } from '../_content-freshness.js';

export type ChokepointPanelRead = { value: unknown; reuseUntil: number | null };
export const CHOKEPOINT_DATASETS = ['transit-summaries', 'chokepoint_transits', '_countries', 'chokepoint-baselines', 'ref', 'chokepoint-flows'] as const;
const MAX_AGE_MS = [30, 30, 2160, 60 * 24 * 400, 60 * 24 * 14, 720].map(minutes => minutes * 60_000);
const BASELINE_IDS = ['hormuz', 'malacca', 'suez', 'babelm', 'danish', 'turkish', 'panama'];
const FLOW_IDS = ['hormuz_strait', 'malacca_strait', 'suez', 'bab_el_mandeb', 'dover_strait', 'bosphorus', 'panama'];
const TRANSIT_NAMES = ['Strait of Hormuz', 'Suez Canal', 'Malacca Strait', 'Bab el-Mandeb Strait', 'Panama Canal', 'Taiwan Strait', 'South China Sea', 'Black Sea', 'Cape of Good Hope', 'Gibraltar Strait', 'Bosporus Strait', 'Korea Strait', 'Dover Strait', 'Kerch Strait', 'Lombok Strait'];
const CONTENT_REQUIREMENT = { countries: ['CN', 'HK'], budgetMinutes: 10 * 24 * 60 };

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function clock(value: unknown, now: number): number | null {
  const stamp = typeof value === 'string' ? Date.parse(value) : value;
  return typeof stamp === 'number' && Number.isSafeInteger(stamp) && stamp > 0 && stamp <= now ? stamp : null;
}
function failed(value: Record<string, unknown>): boolean {
  return Boolean(value.error) || ['error', 'degraded', 'unavailable', 'processing', 'failed'].includes(String(value.status)) || ['stale', 'degraded', 'unavailable', 'upstreamUnavailable', 'rateLimited', 'fallback'].some(key => value[key] === true)
    || value.dataAvailable === false || ['errorCode', 'skipReason', 'errorReason'].some(key => typeof value[key] === 'string' && value[key] !== '')
    || value.sourceState !== undefined && value.sourceState !== 'ok'
    || ['failedSources', 'failedDatasets'].some(key => Array.isArray(value[key]) && value[key].length > 0);
}
function nonnegative(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every(key => key in value); }
function selectedRows(value: Record<string, unknown>, params: Record<string, unknown>): Record<string, unknown> {
  return pickMapKeysLike(value, argStr(params.chokepoint)) as Record<string, unknown>;
}

export function chokepointCacheIdentity(params: Record<string, unknown>): { dataset: string[]; chokepoint: string } {
  const requested = argStrList(params.dataset);
  const known = CHOKEPOINT_DATASETS.filter(label => requested.includes(label));
  return { dataset: [...(known.length ? known : CHOKEPOINT_DATASETS)], chokepoint: argStr(params.chokepoint) };
}

function sourceCount(data: Record<string, unknown>, index: number): number | null {
  const bucket = data[CHOKEPOINT_DATASETS[index]!];
  if (index === 2) return Array.isArray(bucket) ? bucket.length : null;
  if (!record(bucket)) return null;
  if (index === 0) return record(bucket.summaries) ? Object.values(bucket.summaries).filter(row => record(row) && row.dataAvailable === true).length : null;
  if (index === 1) return record(bucket.transits) ? Object.keys(bucket.transits).length : null;
  if (index === 3) return Array.isArray(bucket.chokepoints) ? bucket.chokepoints.length : null;
  return Object.keys(bucket).length;
}

function validSource(data: Record<string, unknown>, index: number, params: Record<string, unknown>): boolean {
  const bucket = data[CHOKEPOINT_DATASETS[index]!];
  if (index === 2) return Array.isArray(bucket) && bucket.length >= 174 && new Set(bucket).size === bucket.length && bucket.every(code => typeof code === 'string' && /^[A-Z]{2}$/.test(code)) && ['CN', 'HK'].every(code => bucket.includes(code));
  if (!record(bucket) || failed(bucket)) return false;
  if (index === 0 || index === 1) {
    const rows = bucket[index === 0 ? 'summaries' : 'transits'];
    if (!record(rows) || !exactKeys(rows, index === 0 ? Object.keys(CHOKEPOINT_THREAT_LEVELS) : TRANSIT_NAMES)) return false;
    return Object.values(selectedRows(rows, params)).every(row => record(row) && !failed(row)
      && (index === 0 ? row.dataAvailable === true && ['todayTotal', 'todayTanker', 'todayCargo', 'todayOther'].every(field => nonnegative(row[field]))
        && row.todayTotal === Number(row.todayTanker) + Number(row.todayCargo) + Number(row.todayOther)
        : row.available === true && ['total', 'tanker', 'cargo', 'other'].every(field => nonnegative(row[field]))
          && row.total === Number(row.tanker) + Number(row.cargo) + Number(row.other)));
  }
  if (index === 3) {
    const baselines = bucket.chokepoints;
    if (!Array.isArray(baselines) || baselines.length !== 7
      || new Set(baselines.map(row => record(row) ? row.id : null)).size !== 7
      || !BASELINE_IDS.every(id => baselines.some(row => record(row) && row.id === id))) return false;
    const cp = argStr(params.chokepoint);
    const rows = baselines.filter(row => !cp || record(row) && [row.id, row.relayId, row.name].some(value => ciIncludes(value, cp)));
    return rows.length > 0 && rows.every(row => record(row) && !failed(row) && typeof row.name === 'string' && typeof row.relayId === 'string' && nonnegative(row.mbd));
  }
  if (index === 4) return Object.keys(bucket).length === 28 && Object.entries(bucket).every(([id, row]) => record(row) && !failed(row) && row.portId === id && typeof row.portName === 'string' && typeof row.lat === 'number' && Number.isFinite(row.lat) && typeof row.lon === 'number' && Number.isFinite(row.lon));
  const rows = selectedRows(bucket, params);
  const expected = selectedRows(Object.fromEntries(FLOW_IDS.map(id => [id, true])), params);
  return Object.keys(bucket).length >= 3 && Object.keys(bucket).every(id => FLOW_IDS.includes(id))
    && exactKeys(rows, Object.keys(expected)) && Object.values(rows).every(row => record(row) && !failed(row)
      && ['currentMbd', 'baselineMbd', 'flowRatio'].every(field => nonnegative(row[field])) && typeof row.disrupted === 'boolean'
      && narrowFlowSource(row.source) !== 'FLOW_SOURCE_UNSPECIFIED');
}

export function chokepointSourcePolicy(data: Record<string, unknown>, seeds: unknown[], metas: unknown[], params: Record<string, unknown>, now: number, activationKnown: boolean): { reuseUntil: number | null; stale: boolean; freshnessUnknown: boolean } {
  const required = chokepointCacheIdentity(params).dataset;
  const deadlines: number[] = [];
  let stale = false, freshnessUnknown = false, valid = true;
  for (const [index, label] of CHOKEPOINT_DATASETS.entries()) {
    if (!required.includes(label)) continue;
    valid &&= validSource(data, index, params);
    const meta = metas[index];
    const fetched = record(meta) ? clock(meta.fetchedAt, now) : null;
    if (fetched === null) { valid = false; freshnessUnknown = true; }
    else { deadlines.push(fetched + MAX_AGE_MS[index]!); stale ||= now >= fetched + MAX_AGE_MS[index]!; }
    if (record(meta)) {
      if (failed(meta)) { stale = true; valid = false; }
      if (typeof meta.recordCount !== 'number' || !Number.isSafeInteger(meta.recordCount) || meta.recordCount !== sourceCount(data, index)) { valid = false; freshnessUnknown = true; }
    }
    const bucket = data[label];
    if (bucket === null || bucket === undefined || index !== 2 && !record(bucket) || index === 2 && !Array.isArray(bucket)) freshnessUnknown = true;
    if (record(bucket) && failed(bucket)) { stale = true; valid = false; }
    const seed = seeds[index];
    if (seed !== null && seed !== undefined) {
      const published = record(seed) ? clock(seed.fetchedAt, now) : null;
      if (!record(seed) || !['OK', 'OK_ZERO'].includes(String(seed.state)) || failed(seed)) {
        valid = false;
        if (record(seed) && (seed.state === 'ERROR' || failed(seed))) stale = true;
        else freshnessUnknown = true;
      }
      if (record(seed) && (seed.recordCount !== undefined && seed.recordCount !== sourceCount(data, index) || seed.state === 'OK_ZERO' && sourceCount(data, index) !== 0)) { valid = false; freshnessUnknown = true; }
      if (published === null) { valid = false; freshnessUnknown = true; }
      else { deadlines.push(published + MAX_AGE_MS[index]!); stale ||= now >= published + MAX_AGE_MS[index]!; }
    }
    const field = index < 2 ? 'fetchedAt' : index === 3 ? 'updatedAt' : null;
    if (field !== null) {
      const published = record(bucket) ? clock(bucket[field], now) : null;
      if (published === null) { valid = false; freshnessUnknown = true; }
      else { deadlines.push(published + MAX_AGE_MS[index]!); stale ||= now >= published + MAX_AGE_MS[index]!; }
    }
    if (index === 2) {
      const content = buildContentFreshnessAssessment(meta, CONTENT_REQUIREMENT, now);
      if (!activationKnown || !content?.usable || content.coveredCount !== sourceCount(data, index)) { valid = false; freshnessUnknown = true; }
      if (content?.usable) {
        stale ||= content.contentStale;
        const observed = clock(content.criticalOldestObservedAt, now);
        if (observed === null) { valid = false; freshnessUnknown = true; }
        else deadlines.push(observed + CONTENT_REQUIREMENT.budgetMinutes * 60_000);
      }
    }
  }
  const deadline = Math.min(...deadlines);
  return { reuseUntil: valid && !stale && !freshnessUnknown && Number.isSafeInteger(deadline) && deadline > now ? deadline : null, stale, freshnessUnknown };
}

export function validChokepointCache(value: unknown, params: Record<string, unknown>, now: number, expires: number): value is { value: unknown; reuseUntil: number } {
  if (!record(value) || Object.keys(value).sort().join(',') !== 'reuseUntil,value' || typeof value.reuseUntil !== 'number' || !Number.isSafeInteger(value.reuseUntil)
    || value.reuseUntil <= now || value.reuseUntil > expires || !record(value.value)) return false;
  const envelope = value.value;
  return clock(envelope.cached_at, now) !== null && envelope.stale === false && envelope.freshnessUnknown !== true && envelope.activationUnknown !== true
    && (!Array.isArray(envelope.unreadable) || envelope.unreadable.length === 0) && record(envelope.data)
    && chokepointCacheIdentity(params).dataset.every(label => validSource(envelope.data as Record<string, unknown>, CHOKEPOINT_DATASETS.indexOf(label as typeof CHOKEPOINT_DATASETS[number]), params));
}
