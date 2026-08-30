#!/usr/bin/env node

/**
 * Seed Shanghai Gold Exchange physical benchmarks against existing COMEX
 * futures snapshots.
 *
 * Usage:
 *   node scripts/seed-physical-premiums.mjs [--env production|preview|development] [--sha <sha>]
 */

import {
  CHROME_UA,
  SEED_EXTRA_KEY_COMMAND_TIMEOUT_MS,
  SEED_REDIS_COMMAND_TIMEOUT_MS,
  SEED_REDIS_RETRY_ATTEMPTS,
  SEED_REDIS_RETRY_BASE_MS,
  SEED_VERIFY_ATTEMPTS,
  SEED_VERIFY_COMMAND_TIMEOUT_MS,
  SEED_VERIFY_RETRY_DELAY_MS,
  httpRetryError,
  loadEnvFile,
  readSeedSnapshot,
  runSeed,
} from './_seed-utils.mjs';
import { DAY_MIN, tokensToContentMeta } from './_content-age-helpers.mjs';
import {
  UPSTASH_COMMAND_TIMEOUT_MS,
  UPSTASH_RETRY_AFTER_MAX_MS,
  getOptionalUpstashCreds,
  upstashCommand,
} from './_upstash-rest.mjs';
import { isMainModule } from './lib/main-module.mjs';
import {
  PHYSICAL_DIVERGENCE_FX_MAX_AGE_MS,
  PHYSICAL_DIVERGENCE_PAPER_MAX_AGE_MS,
  PHYSICAL_DIVERGENCE_STALE_AFTER_CALENDAR_DAYS,
  isPhysicalDivergenceDate,
  isPhysicalDivergenceInstant,
  isPhysicalDivergencePrintFuture,
  physicalDivergenceStaleReason,
} from './shared/physical-divergence-staleness.js';
import {
  HISTORY_LIMIT,
  METHODOLOGY_VERSION,
  MIN_HISTORY_POINTS,
  TRAILING_WINDOW_POINTS,
  TRANSITION_COOLDOWN_MS,
  buildPhysicalDivergenceReading,
  buildPhysicalStressComposite,
  createPhysicalPremiumTransition,
  isPhysicalPremiumHistoryPoint,
  physicalPremiumHistoryPoint,
} from './lib/physical-divergence.mjs';

export const PHYSICAL_PREMIUM_KEY = 'market:physical-premium:v1';
export const PHYSICAL_PREMIUM_HISTORY_KEY_PREFIX = 'market:physical-premium-history:v1';
export const PHYSICAL_DIVERGENCE_KEY = 'market:physical-divergence:v1';
export const PHYSICAL_DIVERGENCE_META_KEY = 'seed-meta:market:physical-divergence';
export const PHYSICAL_PREMIUM_ACTIVATION_KEY = 'seed-activated:market:physical-premium';
export const PHYSICAL_DIVERGENCE_ACTIVATION_KEY = 'seed-activated:market:physical-divergence';
export const COMMODITY_QUOTES_KEY = 'market:commodities-bootstrap:v1';
export const FX_RATES_KEY = 'shared:fx-rates:v1';
export const TROY_OUNCE_GRAMS = 31.1034768;

const CACHE_TTL_SECONDS = 3 * 24 * 3600;
export const PHYSICAL_PREMIUM_LOCK_TTL_MS = 10 * 60 * 1000;
export const PHYSICAL_PREMIUM_FETCH_TIMEOUT_MS = 60 * 1000;
const DIVERGENCE_TTL_SECONDS = 16 * 24 * 3600;
const TRANSITION_COOLDOWN_SECONDS = TRANSITION_COOLDOWN_MS / 1000;
export const DERIVED_REDIS_MAX_ATTEMPTS = 3;
export const DERIVED_REDIS_RETRY_BASE_MS = 250;
const DERIVED_REDIS_SEQUENTIAL_WAVES = 3;
const retryWorstCaseMs = (timeoutMs, attempts, retryBaseMs) => (
  attempts * timeoutMs
  + Array.from({ length: attempts - 1 }, (_, index) => retryBaseMs * 2 ** index)
    .reduce((sum, delay) => sum + delay, 0)
);
const SHARED_REDIS_RETRY_WORST_CASE_MS = retryWorstCaseMs(
  SEED_REDIS_COMMAND_TIMEOUT_MS,
  SEED_REDIS_RETRY_ATTEMPTS,
  SEED_REDIS_RETRY_BASE_MS,
);
const SHARED_EXTRA_KEY_WORST_CASE_MS = retryWorstCaseMs(
  SEED_EXTRA_KEY_COMMAND_TIMEOUT_MS,
  SEED_REDIS_RETRY_ATTEMPTS,
  SEED_REDIS_RETRY_BASE_MS,
);
const SHARED_VERIFY_WORST_CASE_MS = SEED_VERIFY_ATTEMPTS * retryWorstCaseMs(
  SEED_VERIFY_COMMAND_TIMEOUT_MS,
  SEED_REDIS_RETRY_ATTEMPTS,
  SEED_REDIS_RETRY_BASE_MS,
) + (SEED_VERIFY_ATTEMPTS - 1) * SEED_VERIFY_RETRY_DELAY_MS;
export const PHYSICAL_PREMIUM_SHARED_SEED_WORST_CASE_MS = (
  3 * SHARED_REDIS_RETRY_WORST_CASE_MS // lock, canonical publish, freshness metadata
  + SHARED_EXTRA_KEY_WORST_CASE_MS // bundle completion marker
  + SHARED_VERIFY_WORST_CASE_MS
  + SEED_REDIS_COMMAND_TIMEOUT_MS // best-effort lock release
);
export const PHYSICAL_PREMIUM_DERIVED_REDIS_WORST_CASE_MS = DERIVED_REDIS_SEQUENTIAL_WAVES * (
  DERIVED_REDIS_MAX_ATTEMPTS * UPSTASH_COMMAND_TIMEOUT_MS
  + (DERIVED_REDIS_MAX_ATTEMPTS - 1) * Math.max(
    UPSTASH_RETRY_AFTER_MAX_MS,
    DERIVED_REDIS_RETRY_BASE_MS * 2,
  )
);
export const PHYSICAL_PREMIUM_SECTION_WORST_CASE_MS = PHYSICAL_PREMIUM_FETCH_TIMEOUT_MS
  + PHYSICAL_PREMIUM_DERIVED_REDIS_WORST_CASE_MS
  + PHYSICAL_PREMIUM_SHARED_SEED_WORST_CASE_MS;
export const PHYSICAL_PREMIUM_SECTION_TIMEOUT_MS = 480_000;
const SGE_MAX_CONTENT_AGE_MIN = 10 * DAY_MIN;
const SGE_GOLD_URL = 'https://en.sge.com.cn/data_BenchmarkPrice_Daily';
const SGE_SILVER_URL = 'https://en.sge.com.cn/data/data_silver_daily';

const METALS = [
  {
    metal: 'gold',
    contract: 'SHAU',
    unit: 'gram',
    paperSymbol: 'GC=F',
    url: SGE_GOLD_URL,
  },
  {
    metal: 'silver',
    contract: 'SHAG',
    unit: 'kilogram',
    paperSymbol: 'SI=F',
    url: SGE_SILVER_URL,
  },
];

export function shouldWritePhysicalPremiumActivationMarker(env) {
  return env === 'production';
}

export const PUBLISH_PHYSICAL_PREMIUM_LUA = `
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
if ARGV[3] == '1' then
  redis.call('SET', KEYS[2], '1')
end
return 1
`.trim();

export function physicalPremiumPublishCommand({ canonicalKey, payload, ttlSeconds, env }) {
  return [
    'EVAL',
    PUBLISH_PHYSICAL_PREMIUM_LUA,
    '2',
    canonicalKey,
    PHYSICAL_PREMIUM_ACTIVATION_KEY,
    payload,
    String(ttlSeconds),
    shouldWritePhysicalPremiumActivationMarker(env) ? '1' : '0',
  ];
}

export async function publishPhysicalPremiumAtomically(context) {
  const creds = getOptionalUpstashCreds();
  if (!creds) throw new Error('Redis credentials are unavailable for physical-premium publication');
  await upstashCommand(creds, physicalPremiumPublishCommand(context));
}

export const APPEND_HISTORY_LUA = `
local existing = redis.call('LRANGE', KEYS[1], 0, -1)
for _, encoded in ipairs(existing) do
  local ok, item = pcall(cjson.decode, encoded)
  if ok and item.date == ARGV[1] then
    redis.call('LREM', KEYS[1], 0, encoded)
  end
end
redis.call('LPUSH', KEYS[1], ARGV[2])
redis.call('LTRIM', KEYS[1], 0, tonumber(ARGV[3]) - 1)
return redis.call('LRANGE', KEYS[1], 0, tonumber(ARGV[4]) - 1)
`.trim();

export const PUBLISH_DIVERGENCE_LUA = `
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
if ARGV[5] == '1' then
  redis.call('SET', KEYS[3], '1')
end
for index = 4, #KEYS do
  redis.call('SET', KEYS[index], ARGV[index + 2], 'EX', ARGV[4])
end
return #KEYS
`.trim();

export function physicalPremiumHistoryKey(metal, prefix = '') {
  if (!METALS.some((config) => config.metal === metal)) {
    throw nonRetryableError(`Unsupported physical premium history metal: ${metal}`);
  }
  return `${prefix}${PHYSICAL_PREMIUM_HISTORY_KEY_PREFIX}:${metal}`;
}

export function physicalPremiumHistoryWriteCommand(key, point) {
  if (typeof key !== 'string' || key.length === 0 || !isPhysicalPremiumHistoryPoint(point)) {
    throw nonRetryableError('Physical premium history append requires a key and valid point');
  }
  return [
    'EVAL',
    APPEND_HISTORY_LUA,
    '1',
    key,
    point.date,
    JSON.stringify(point),
    String(HISTORY_LIMIT),
    String(TRAILING_WINDOW_POINTS),
  ];
}

export async function appendPhysicalPremiumHistory(creds, key, point, commandFn = upstashCommand) {
  const body = await commandFn(creds, physicalPremiumHistoryWriteCommand(key, point));
  return parsePhysicalPremiumHistory(body, key, false);
}

function parsePhysicalPremiumHistory(body, key, allowEmpty) {
  if (!Array.isArray(body?.result)) {
    throw nonRetryableError(`Physical premium history read returned an invalid list for ${key}`);
  }
  // A stored point that does not match the CURRENT methodology is not corrupt — it is a
  // point from a previous methodology sharing the same unversioned key. Dropping it (the
  // same thing buildPhysicalDivergenceReading's own `.filter` does) lets a
  // METHODOLOGY_VERSION bump ride out naturally as the window refills; throwing here would
  // wedge every run for the ~250 print dates the old points take to age out, and — because
  // this runs under afterPublish — would previously have taken the whole premium seed with
  // it. The insufficient-history gate is what fails closed on the shrunken window.
  const decoded = body.result.map((encoded) => {
    if (typeof encoded !== 'string') return { malformed: true, point: null };
    try {
      const parsed = JSON.parse(encoded);
      if (isPhysicalPremiumHistoryPoint(parsed)) return { malformed: false, point: parsed };
      // Structurally a point, just a foreign methodology -> drop, do not fail.
      const foreignMethodology = !!parsed
        && typeof parsed === 'object'
        && typeof parsed.methodologyVersion === 'string'
        && parsed.methodologyVersion !== METHODOLOGY_VERSION;
      return { malformed: !foreignMethodology, point: null };
    } catch {
      return { malformed: true, point: null };
    }
  });
  const history = decoded.filter((entry) => entry.point != null).map((entry) => entry.point);
  if (
    decoded.some((entry) => entry.malformed)
    || (!allowEmpty && decoded.length === 0)
    || decoded.length > TRAILING_WINDOW_POINTS
  ) {
    throw nonRetryableError(`Physical premium history read produced invalid entries for ${key}`);
  }
  return history;
}

export async function readPhysicalPremiumHistory(creds, key, commandFn = upstashCommand) {
  const body = await commandFn(creds, [
    'LRANGE', key, '0', String(TRAILING_WINDOW_POINTS - 1),
  ]);
  return parsePhysicalPremiumHistory(body, key, true);
}

function parseStoredJson(body, label) {
  if (body?.result == null) return null;
  if (typeof body.result !== 'string') throw nonRetryableError(`${label} returned a non-string value`);
  try {
    return JSON.parse(body.result);
  } catch {
    throw nonRetryableError(`${label} returned malformed JSON`);
  }
}

function findPriorReading(snapshot, metal) {
  if (snapshot == null) return null;
  if (!Array.isArray(snapshot.readings)) throw nonRetryableError('Prior physical divergence snapshot has no readings');
  const reading = snapshot.readings.find((candidate) => candidate?.metal === metal);
  if (!reading) return null;
  if (!['ok', 'insufficient_history', 'stale_input', 'missing_input'].includes(reading.state)) {
    throw nonRetryableError(`Prior physical divergence snapshot has unknown state: ${reading.state}`);
  }
  return reading;
}

export function buildPhysicalDivergenceSnapshot({ premiums, fx, histories, previousSnapshot, cooldowns, nowMs }) {
  if (
    !Array.isArray(premiums)
    || !histories
    || !Number.isFinite(nowMs)
    || fx?.pair !== 'CNY/USD'
    || typeof fx?.source !== 'string'
    || typeof fx?.asOf !== 'string'
  ) {
    throw nonRetryableError('Physical divergence snapshot requires premiums, FX provenance, histories, and an evaluation clock');
  }
  const readings = METALS.map(({ metal }) => buildPhysicalDivergenceReading({
    metal,
    current: premiums.find((premium) => premium?.metal === metal) ?? null,
    history: histories[metal] ?? [],
    fx,
    nowMs,
  }));
  const transitions = [];
  for (const reading of readings) {
    const previous = findPriorReading(previousSnapshot, reading.metal);
    const transition = createPhysicalPremiumTransition({
      previous,
      next: reading,
      nowMs,
      lastEmittedAtMs: cooldowns?.[reading.metal]?.emittedAt ?? null,
      lastEmittedRegime: cooldowns?.[reading.metal]?.toRegime ?? null,
    });
    if (transition) transitions.push(transition);
  }
  return {
    evaluatedAt: new Date(nowMs).toISOString(),
    methodologyVersion: METHODOLOGY_VERSION,
    readings,
    composite: buildPhysicalStressComposite(readings),
    transitions,
  };
}

async function readTransitionCooldown(creds, key, commandFn) {
  const stored = parseStoredJson(await commandFn(creds, ['GET', key]), `Transition cooldown ${key}`);
  if (stored == null) return null;
  if (!Number.isFinite(stored.emittedAt)) return null;
  // `toRegime` is what the cooldown is actually keyed on — the regime we last announced.
  // Records written before this field existed read back as null, which the classifier
  // treats as "nothing announced yet" and therefore does not suppress.
  return {
    emittedAt: stored.emittedAt,
    toRegime: typeof stored.toRegime === 'string' ? stored.toRegime : null,
  };
}

function isTransientDerivedRedisError(error) {
  const status = Number(error?.status ?? String(error?.message ?? '').match(/Upstash HTTP (\d{3})/)?.[1]);
  if (status === 408 || status === 429 || status >= 500) return true;
  return error?.name === 'AbortError'
    || error?.name === 'TimeoutError'
    || error instanceof TypeError;
}

export async function retryDerivedRedisCommand(creds, command, commandFn, delayFn) {
  for (let attempt = 0; attempt < DERIVED_REDIS_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await commandFn(creds, command);
    } catch (error) {
      if (!isTransientDerivedRedisError(error) || attempt === DERIVED_REDIS_MAX_ATTEMPTS - 1) throw error;
      const backoffMs = DERIVED_REDIS_RETRY_BASE_MS * (2 ** attempt);
      const retryAfterMs = Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : 0;
      await delayFn(Math.max(backoffMs, retryAfterMs));
    }
  }
  throw new Error('Unreachable derived Redis retry state');
}

function physicalPrintFreshUntil(value) {
  if (!isPhysicalDivergenceDate(value)) return null;
  const inputDay = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(inputDay)) return null;
  const shanghaiOffsetMs = 8 * 60 * 60 * 1000;
  return inputDay - shanghaiOffsetMs
    + (PHYSICAL_DIVERGENCE_STALE_AFTER_CALENDAR_DAYS + 1) * DAY_MIN * 60 * 1000;
}

function physicalDivergenceInputFreshUntil(snapshot) {
  const deadlines = [];
  for (const reading of snapshot?.readings ?? []) {
    const physicalDeadline = physicalPrintFreshUntil(reading?.physicalAsOf);
    const paperAsOf = Date.parse(reading?.paperAsOf ?? '');
    const fxAsOf = Date.parse(reading?.provenance?.fxAsOf ?? '');
    if (physicalDeadline == null || !Number.isFinite(paperAsOf) || !Number.isFinite(fxAsOf)) return null;
    deadlines.push(
      physicalDeadline,
      paperAsOf + PHYSICAL_DIVERGENCE_PAPER_MAX_AGE_MS,
      fxAsOf + PHYSICAL_DIVERGENCE_FX_MAX_AGE_MS,
    );
  }
  return deadlines.length > 0 ? Math.min(...deadlines) : null;
}

function physicalDivergenceMinHistoryPoints(snapshot) {
  if (!Array.isArray(snapshot?.readings) || snapshot.readings.length === 0) return 0;
  return Math.min(...snapshot.readings.map((reading) => (
    Number.isFinite(reading?.historyPoints) ? reading.historyPoints : 0
  )));
}

function physicalDivergencePriorHighWater(previousMeta) {
  if (!previousMeta || typeof previousMeta !== 'object') return 0;
  // History lists drop foreign-methodology points on read so a METHODOLOGY_VERSION
  // bump can ramp cleanly. Reset the high-water with that drop — otherwise a
  // prior full window keeps the probe degraded until the new methodology rebuilds
  // every point (well past the operational 60-day threshold).
  if (
    typeof previousMeta.methodologyVersion === 'string'
    && previousMeta.methodologyVersion !== METHODOLOGY_VERSION
  ) {
    return 0;
  }
  const fromMax = Number(previousMeta.maxHistoryPointsSeen);
  if (Number.isFinite(fromMax) && fromMax >= 0) return fromMax;
  // Pre-#7424 meta published minHistoryPoints without a high-water field. Carry
  // that floor forward so a mid-ramp or peak deployment cannot re-baseline
  // itself on the next tick. An already-trough publish (min already collapsed
  // under old code) cannot recover the lost peak from meta alone — that needs
  // a ramp-deadline gate or an operator-set high-water, which is out of scope.
  const fromMin = Number(previousMeta.minHistoryPoints);
  return Number.isFinite(fromMin) && fromMin >= 0 ? fromMin : 0;
}

export function physicalDivergenceMeta(snapshot, nowMs, previousMeta = null) {
  const stateCounts = { ok: 0, insufficient_history: 0, stale_input: 0, missing_input: 0 };
  for (const reading of snapshot?.readings ?? []) {
    if (Object.hasOwn(stateCounts, reading?.state)) stateCounts[reading.state] += 1;
  }
  // Health gates read sourceState and inputFreshUntil. `insufficient_history`
  // maps to 'ok' during the initial ~60-day ramp (depth is still accruing). A
  // drop below the published high-water mark is the regression case that must
  // turn the probe non-green: history keys carry no TTL, so eviction/deletion
  // leaves every input clock fresh while the index can never print a value.
  const minHistoryPoints = physicalDivergenceMinHistoryPoints(snapshot);
  const maxHistoryPointsSeen = Math.max(
    physicalDivergencePriorHighWater(previousMeta),
    minHistoryPoints,
  );
  const historyRegressed = minHistoryPoints < maxHistoryPointsSeen;
  const compositeReason = typeof snapshot?.composite?.reason === 'string'
    ? snapshot.composite.reason.slice(0, 160)
    : '';
  let sourceState = 'ok';
  let sourceReason = compositeReason;
  if (stateCounts.missing_input > 0) {
    sourceState = 'error';
  } else if (stateCounts.stale_input > 0) {
    sourceState = 'stale';
  } else if (historyRegressed) {
    sourceState = 'degraded';
    sourceReason = `history_points_regressed:min=${minHistoryPoints}:max=${maxHistoryPointsSeen}`;
  }
  return {
    fetchedAt: nowMs,
    recordCount: Array.isArray(snapshot?.readings) ? snapshot.readings.length : 0,
    methodologyVersion: METHODOLOGY_VERSION,
    sourceState,
    sourceReason,
    minHistoryPoints,
    maxHistoryPointsSeen,
    stateCounts,
    inputFreshUntil: physicalDivergenceInputFreshUntil(snapshot),
  };
}

export function physicalDivergencePublishCommand({
  divergenceKey,
  metaKey,
  snapshot,
  nowMs,
  prefix = '',
  activate = prefix === '',
  previousMeta = null,
}) {
  const cooldownWrites = snapshot.transitions.map((transition) => ({
    key: `${prefix}market:physical-divergence-transition-cooldown:v1:${transition.metal}`,
    payload: JSON.stringify({
      emittedAt: nowMs,
      transitionId: transition.id,
      toRegime: transition.toRegime,
    }),
  }));
  const keys = [
    divergenceKey,
    metaKey,
    `${prefix}${PHYSICAL_DIVERGENCE_ACTIVATION_KEY}`,
    ...cooldownWrites.map((entry) => entry.key),
  ];
  return [
    'EVAL',
    PUBLISH_DIVERGENCE_LUA,
    String(keys.length),
    ...keys,
    JSON.stringify(snapshot),
    JSON.stringify(physicalDivergenceMeta(snapshot, nowMs, previousMeta)),
    String(DIVERGENCE_TTL_SECONDS),
    String(TRANSITION_COOLDOWN_SECONDS),
    activate ? '1' : '0',
    ...cooldownWrites.map((entry) => entry.payload),
  ];
}

export async function publishPhysicalDivergenceDerivedData({
  payload,
  prefix = '',
  nowMs = Date.now(),
  commandFn = upstashCommand,
  retryDelayFn = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
}) {
  const creds = getOptionalUpstashCreds();
  if (!creds) throw nonRetryableError('Physical divergence publication requires Redis credentials');

  const divergenceKey = `${prefix}${PHYSICAL_DIVERGENCE_KEY}`;
  const metaKey = `${prefix}${PHYSICAL_DIVERGENCE_META_KEY}`;
  const derivedCommand = (nextCreds, command) => (
    retryDerivedRedisCommand(nextCreds, command, commandFn, retryDelayFn)
  );
  const historyEntriesPromise = Promise.all((payload?.premiums ?? []).map(async (premium) => {
    const point = physicalPremiumHistoryPoint(premium);
    if (!point || !METALS.some((config) => config.metal === premium.metal)) {
      throw nonRetryableError('Physical divergence publication received an invalid premium');
    }
    const key = physicalPremiumHistoryKey(premium.metal, prefix);
    const staleReason = physicalDivergenceStaleReason({
      physicalAsOf: point.physicalAsOf,
      paperAsOf: point.paperAsOf,
      fxAsOf: payload.fx?.asOf ?? '',
    }, nowMs);
    const history = staleReason
      ? await readPhysicalPremiumHistory(creds, key, derivedCommand)
      : await appendPhysicalPremiumHistory(creds, key, point, derivedCommand);
    return [premium.metal, history];
  }));
  const previousSnapshotPromise = derivedCommand(creds, ['GET', divergenceKey]).then((body) => (
    parseStoredJson(body, 'Prior physical divergence snapshot')
  ));
  const previousMetaPromise = derivedCommand(creds, ['GET', metaKey]).then((body) => (
    parseStoredJson(body, 'Prior physical divergence seed meta')
  ));
  const [historyEntries, previousSnapshot, previousMeta] = await Promise.all([
    historyEntriesPromise,
    previousSnapshotPromise,
    previousMetaPromise,
  ]);
  const histories = Object.fromEntries(historyEntries);

  const cooldownEntries = await Promise.all(METALS.map(async ({ metal }) => {
    const previous = findPriorReading(previousSnapshot, metal);
    const currentHistory = histories[metal] ?? [];
    if (previous?.state !== 'ok' || currentHistory.length < MIN_HISTORY_POINTS) return null;
    const cooldownKey = `${prefix}market:physical-divergence-transition-cooldown:v1:${metal}`;
    const cooldown = await readTransitionCooldown(creds, cooldownKey, derivedCommand);
    return [metal, cooldown];
  }));
  const cooldowns = Object.fromEntries(cooldownEntries.filter((entry) => entry != null));

  const snapshot = buildPhysicalDivergenceSnapshot({
    premiums: payload.premiums,
    fx: payload.fx,
    histories,
    previousSnapshot,
    cooldowns,
    nowMs,
  });
  await derivedCommand(creds, physicalDivergencePublishCommand({
    divergenceKey,
    metaKey,
    snapshot,
    nowMs,
    prefix,
    previousMeta,
  }));
  return snapshot;
}

function nonRetryableError(message) {
  return Object.assign(new Error(message), { nonRetryable: true });
}

function parseFinitePositive(value) {
  const parsed = Number(String(value).replaceAll(',', '').trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function stripCellMarkup(value) {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function cellsFromRow(rowHtml, tagName) {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  return [...rowHtml.matchAll(pattern)].map((match) => stripCellMarkup(match[1]));
}

function sgeDateToIso(value) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

export function parseSgeBenchmarkHtml(html, { contract, unit }) {
  if (typeof html !== 'string' || html.length === 0) {
    throw nonRetryableError(`No valid ${contract} benchmark rows in SGE response`);
  }

  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const rows = [...withoutComments.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  const expectedHeader = ['Trade Date', 'Contract', 'Benchmark Price AM', 'Benchmark Price PM'];
  const header = rows.map((match) => cellsFromRow(match[1], 'th')).find((cells) => cells.length > 0);
  if (!header || expectedHeader.some((cell, index) => header[index] !== cell)) {
    throw nonRetryableError(`Unexpected ${contract} benchmark columns in SGE response`);
  }

  const parsed = [];
  for (const row of rows) {
    const cells = cellsFromRow(row[1], 'td');
    if (cells.length < 4 || cells[1] !== contract) continue;
    const asOf = sgeDateToIso(cells[0]);
    const amPrice = parseFinitePositive(cells[2]);
    const pmPrice = parseFinitePositive(cells[3]);
    const price = pmPrice ?? amPrice;
    if (!asOf || price == null) continue;
    parsed.push({
      asOf,
      contract,
      amPrice,
      pmPrice,
      price,
      session: pmPrice == null ? 'AM' : 'PM',
      currency: 'CNY',
      unit,
    });
  }

  const unique = [...new Map(parsed.map((row) => [row.asOf, row])).values()]
    .sort((a, b) => b.asOf.localeCompare(a.asOf));
  if (unique.length === 0) {
    throw nonRetryableError(`No valid ${contract} benchmark rows in SGE response`);
  }
  return unique;
}

export function convertSgePriceToUsdPerOz(price, unit, cnyUsdRate) {
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(cnyUsdRate) || cnyUsdRate <= 0) {
    throw nonRetryableError('SGE conversion requires positive finite price and CNY/USD rate');
  }
  const gramsPerUnit = unit === 'gram' ? 1 : unit === 'kilogram' ? 1000 : null;
  if (gramsPerUnit == null) throw nonRetryableError(`Unsupported SGE price unit: ${unit}`);
  return (price / gramsPerUnit) * cnyUsdRate * TROY_OUNCE_GRAMS;
}

function round(value, decimals = 4) {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function parseIsoInstant(value) {
  return isPhysicalDivergenceInstant(value);
}

export function buildPhysicalPremiumPayload({
  goldRows,
  silverRows,
  commodityQuotes,
  fxRates,
  computedAt,
  paperAsOf = computedAt,
  fxAsOf = computedAt,
}) {
  if (!parseIsoInstant(computedAt) || !parseIsoInstant(paperAsOf) || !parseIsoInstant(fxAsOf)) {
    throw nonRetryableError('Physical premium timestamps must be valid ISO instants');
  }
  const cnyUsdRate = fxRates?.CNY;
  const fallbackCurrencies = Array.isArray(fxRates?.fallbackCurrencies)
    ? fxRates.fallbackCurrencies
    : [];
  if (!Number.isFinite(cnyUsdRate) || cnyUsdRate <= 0 || fallbackCurrencies.includes('CNY')) {
    throw nonRetryableError('shared:fx-rates:v1 has no live CNY/USD rate');
  }

  const rowsByMetal = { gold: goldRows, silver: silverRows };
  const quotes = Array.isArray(commodityQuotes?.quotes) ? commodityQuotes.quotes : [];
  const premiums = METALS.map((config) => {
    const physicalRow = rowsByMetal[config.metal]?.[0];
    const paperQuote = quotes.find((quote) => quote?.symbol === config.paperSymbol);
    if (!physicalRow || !Number.isFinite(paperQuote?.price) || paperQuote.price <= 0) {
      throw nonRetryableError(`Missing ${config.contract} or ${config.paperSymbol} benchmark leg`);
    }
    const physicalUsdPerOz = convertSgePriceToUsdPerOz(
      physicalRow.price,
      physicalRow.unit,
      cnyUsdRate,
    );
    const premiumUsdPerOz = physicalUsdPerOz - paperQuote.price;
    return {
      metal: config.metal,
      physical: {
        price: physicalRow.price,
        currency: 'CNY',
        unit: physicalRow.unit,
        source: `Shanghai Gold Exchange ${config.contract} ${physicalRow.session} benchmark`,
        asOf: physicalRow.asOf,
      },
      paper: {
        price: paperQuote.price,
        source: `COMEX ${config.paperSymbol} futures snapshot`,
        asOf: paperAsOf,
      },
      premiumUsdPerOz: round(premiumUsdPerOz),
      premiumPct: round((premiumUsdPerOz / paperQuote.price) * 100),
      computedAt,
    };
  });

  return {
    premiums,
    fx: {
      pair: 'CNY/USD',
      rate: cnyUsdRate,
      source: FX_RATES_KEY,
      asOf: fxAsOf,
    },
  };
}

export function validatePhysicalPremiumPayload(payload) {
  if (!payload || !Array.isArray(payload.premiums) || payload.premiums.length !== METALS.length) return false;
  if (
    payload.fx?.pair !== 'CNY/USD'
    || payload.fx?.source !== FX_RATES_KEY
    || !Number.isFinite(payload.fx?.rate)
    || payload.fx.rate <= 0
    || !parseIsoInstant(payload.fx?.asOf)
  ) return false;

  const expectedMetals = new Set(METALS.map((config) => config.metal));
  for (const premium of payload.premiums) {
    if (!expectedMetals.delete(premium?.metal)) return false;
    if (
      !Number.isFinite(premium?.physical?.price)
      || premium.physical.price <= 0
      || premium.physical.currency !== 'CNY'
      || !['gram', 'kilogram'].includes(premium.physical.unit)
      || !isPhysicalDivergenceDate(premium.physical.asOf)
      || isPhysicalDivergencePrintFuture(premium.physical.asOf, Date.parse(premium.computedAt))
      || !Number.isFinite(premium?.paper?.price)
      || premium.paper.price <= 0
      || !parseIsoInstant(premium.paper.asOf)
      || !parseIsoInstant(premium.computedAt)
      || !Number.isFinite(premium.premiumUsdPerOz)
      || !Number.isFinite(premium.premiumPct)
    ) return false;

    const physicalUsdPerOz = convertSgePriceToUsdPerOz(
      premium.physical.price,
      premium.physical.unit,
      payload.fx.rate,
    );
    const expectedUsd = round(physicalUsdPerOz - premium.paper.price);
    const expectedPct = round(((physicalUsdPerOz - premium.paper.price) / premium.paper.price) * 100);
    if (
      Math.abs(premium.premiumUsdPerOz - expectedUsd) > 0.0001
      || Math.abs(premium.premiumPct - expectedPct) > 0.0001
    ) return false;
  }
  return expectedMetals.size === 0;
}

export function declareRecords(payload) {
  return Array.isArray(payload?.premiums) ? payload.premiums.length : 0;
}

export function physicalPremiumContentMeta(payload, nowMs = Date.now()) {
  return tokensToContentMeta(
    payload?.premiums?.map((premium) => premium?.physical?.asOf) ?? [],
    nowMs,
  );
}

export function parseSeedTargetArgs(args = process.argv.slice(2)) {
  let env = 'production';
  let sha = '';
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--env' && args[index + 1]) env = args[++index];
    else if (arg === '--sha' && args[index + 1]) sha = args[++index];
    else if (arg.startsWith('--env=')) env = arg.slice('--env='.length);
    else if (arg.startsWith('--sha=')) sha = arg.slice('--sha='.length);
    else throw nonRetryableError(`Unknown argument: ${arg}`);
  }
  if (!['production', 'preview', 'development'].includes(env)) {
    throw nonRetryableError(`Invalid --env: ${env}`);
  }
  if (env !== 'production' && !sha) sha = 'dev';
  if (sha && !/^[A-Za-z0-9._-]+$/.test(sha)) throw nonRetryableError('Invalid --sha value');
  return { env, sha };
}

export async function fetchSgeHtml(url, contract, fetchFn = fetch) {
  const response = await fetchFn(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': CHROME_UA,
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw httpRetryError(response);
  const finalUrl = new URL(response.url || url);
  if (finalUrl.protocol !== 'https:' || finalUrl.hostname !== 'en.sge.com.cn') {
    throw nonRetryableError(`Unexpected ${contract} response origin: ${finalUrl.origin}`);
  }
  const contentType = response.headers.get('content-type');
  if (contentType && !contentType.toLowerCase().includes('text/html')) {
    throw nonRetryableError(`Unexpected ${contract} content type: ${contentType}`);
  }
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > 256_000) {
    throw nonRetryableError(`${contract} response exceeds 256 KB`);
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const html = await response.text();
    if (Buffer.byteLength(html, 'utf8') > 256_000) {
      throw nonRetryableError(`${contract} response exceeds 256 KB`);
    }
    return html;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw nonRetryableError(`Unexpected ${contract} response stream`);
      }
      totalBytes += value.byteLength;
      if (totalBytes > 256_000) {
        await reader.cancel().catch(() => {});
        throw nonRetryableError(`${contract} response exceeds 256 KB`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function fetchPhysicalPremiumPayload(
  { runStartedAtMs },
  {
    fetchSgeHtmlFn = fetchSgeHtml,
    readSeedSnapshotFn = readSeedSnapshot,
  } = {},
) {
  const [goldHtml, silverHtml, commoditySnapshot, fxSnapshot] = await Promise.all([
    fetchSgeHtmlFn(SGE_GOLD_URL, 'SHAU'),
    fetchSgeHtmlFn(SGE_SILVER_URL, 'SHAG'),
    readSeedSnapshotFn(COMMODITY_QUOTES_KEY, { strict: true, includeEnvelopeMeta: true }),
    readSeedSnapshotFn(FX_RATES_KEY, { strict: true, includeEnvelopeMeta: true }),
  ]);
  const commodityQuotes = commoditySnapshot?.data;
  const fxRates = fxSnapshot?.data;
  const commodityMeta = commoditySnapshot?.meta;
  const fxMeta = fxSnapshot?.meta;
  if (!commodityMeta || !fxMeta) {
    throw nonRetryableError('Commodity and FX input snapshots require seed envelope timestamps');
  }
  const computedAt = new Date(runStartedAtMs).toISOString();
  return buildPhysicalPremiumPayload({
    goldRows: parseSgeBenchmarkHtml(goldHtml, METALS[0]),
    silverRows: parseSgeBenchmarkHtml(silverHtml, METALS[1]),
    commodityQuotes,
    fxRates,
    computedAt,
    paperAsOf: new Date(commodityMeta.fetchedAt).toISOString(),
    fxAsOf: new Date(fxMeta.fetchedAt).toISOString(),
  });
}

export async function runPhysicalPremiumSeed(
  args = process.argv.slice(2),
  {
    runSeedFn = runSeed,
    publishPremiumFn = publishPhysicalPremiumAtomically,
    publishDivergenceFn = publishPhysicalDivergenceDerivedData,
  } = {},
) {
  const { env, sha } = parseSeedTargetArgs(args);
  const prefix = env === 'production' ? '' : `${env}:${sha}:`;
  const resource = env === 'production' ? 'physical-premium' : `physical-premium:${env}:${sha}`;
  const seedOptions = {
    lockTtlMs: PHYSICAL_PREMIUM_LOCK_TTL_MS,
    fetchPhaseTimeoutMs: PHYSICAL_PREMIUM_FETCH_TIMEOUT_MS,
    validateFn: validatePhysicalPremiumPayload,
    ttlSeconds: CACHE_TTL_SECONDS,
    sourceVersion: 'sge-shau-shag+commodity-snapshot+shared-fx-v1',
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 3 * DAY_MIN,
    contentMeta: physicalPremiumContentMeta,
    maxContentAgeMin: SGE_MAX_CONTENT_AGE_MIN,
    publishAtomically: async (_payload, { canonicalKey, payload, ttlSeconds }) => {
      await publishPremiumFn({ canonicalKey, payload, ttlSeconds, env });
    },
    // The DERIVED divergence index must not be able to fail the RAW premium seed. The
    // canonical premium is already published by the time this runs, but
    // writeFreshnessMetadataSafely — which refreshes the premium's own seed-meta that
    // /api/health reads — runs AFTER us, so an unguarded throw here strands fresh data
    // behind a stalled freshness clock and exits the run non-zero. Degrade instead, the
    // same contract writeFreshnessMetadataSafely established for issue #5478. The
    // divergence key keeps its previous value and its own seed-meta goes stale, which is
    // what the physicalDivergence health probe is there to catch.
    afterPublish: async (payload) => {
      try {
        await publishDivergenceFn({ payload, prefix });
      } catch (error) {
        console.warn(`  WARNING: physical divergence publication failed (premium seed unaffected): ${error?.message ?? error}`);
      }
    },
  };
  if (runSeedFn === runSeed) {
    return runSeed('market', resource, `${prefix}${PHYSICAL_PREMIUM_KEY}`, fetchPhysicalPremiumPayload, seedOptions);
  }
  return runSeedFn('market', resource, `${prefix}${PHYSICAL_PREMIUM_KEY}`, fetchPhysicalPremiumPayload, seedOptions);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  loadEnvFile(import.meta.url);
  await runPhysicalPremiumSeed().catch((error) => {
    const cause = error?.cause ? ` (cause: ${error.cause.message || error.cause})` : '';
    console.error(`FATAL: ${error?.message || error}${cause}`);
    process.exit(1);
  });
}
