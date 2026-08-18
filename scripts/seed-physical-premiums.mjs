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
  httpRetryError,
  loadEnvFile,
  readSeedSnapshot,
  runSeed,
} from './_seed-utils.mjs';
import { DAY_MIN, tokensToContentMeta } from './_content-age-helpers.mjs';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';
import { isMainModule } from './lib/main-module.mjs';

export const PHYSICAL_PREMIUM_KEY = 'market:physical-premium:v1';
export const PHYSICAL_PREMIUM_ACTIVATION_KEY = 'seed-activated:market:physical-premium';
export const COMMODITY_QUOTES_KEY = 'market:commodities-bootstrap:v1';
export const FX_RATES_KEY = 'shared:fx-rates:v1';
export const TROY_OUNCE_GRAMS = 31.1034768;

const CACHE_TTL_SECONDS = 3 * 24 * 3600;
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

export function physicalPremiumActivationWrite(env) {
  return shouldWritePhysicalPremiumActivationMarker(env)
    ? ['SET', PHYSICAL_PREMIUM_ACTIVATION_KEY, '1']
    : null;
}

async function markPhysicalPremiumActivated({ env } = {}) {
  const command = physicalPremiumActivationWrite(env);
  if (!command) return;
  try {
    const creds = getOptionalUpstashCreds();
    if (!creds) return;
    await upstashCommand(creds, command);
  } catch (error) {
    console.warn(`  WARN: activation marker write failed: ${error?.message || error}`);
  }
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
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
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
      || !/^\d{4}-\d{2}-\d{2}$/.test(premium.physical.asOf ?? '')
      || !Number.isFinite(Date.parse(`${premium.physical.asOf}T00:00:00Z`))
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
  const html = await response.text();
  if (html.length > 256_000) throw nonRetryableError(`${contract} response exceeds 256 KB`);
  return html;
}

async function fetchPhysicalPremiums({ runStartedAtMs }) {
  const [goldHtml, silverHtml, commoditySnapshot, fxSnapshot] = await Promise.all([
    fetchSgeHtml(SGE_GOLD_URL, 'SHAU'),
    fetchSgeHtml(SGE_SILVER_URL, 'SHAG'),
    readSeedSnapshot(COMMODITY_QUOTES_KEY, { strict: true, includeEnvelopeMeta: true }),
    readSeedSnapshot(FX_RATES_KEY, { strict: true, includeEnvelopeMeta: true }),
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

export async function runPhysicalPremiumSeed(args = process.argv.slice(2)) {
  const { env, sha } = parseSeedTargetArgs(args);
  const prefix = env === 'production' ? '' : `${env}:${sha}:`;
  const resource = env === 'production' ? 'physical-premium' : `physical-premium:${env}:${sha}`;
  return runSeed('market', resource, `${prefix}${PHYSICAL_PREMIUM_KEY}`, fetchPhysicalPremiums, {
    validateFn: validatePhysicalPremiumPayload,
    ttlSeconds: CACHE_TTL_SECONDS,
    sourceVersion: 'sge-shau-shag+commodity-snapshot+shared-fx-v1',
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 3 * DAY_MIN,
    contentMeta: physicalPremiumContentMeta,
    maxContentAgeMin: SGE_MAX_CONTENT_AGE_MIN,
    afterPublish: () => markPhysicalPremiumActivated({ env }),
  });
}

if (isMainModule(import.meta.url, process.argv[1])) {
  loadEnvFile(import.meta.url);
  await runPhysicalPremiumSeed().catch((error) => {
    const cause = error?.cause ? ` (cause: ${error.cause.message || error.cause})` : '';
    console.error(`FATAL: ${error?.message || error}${cause}`);
    process.exit(1);
  });
}
