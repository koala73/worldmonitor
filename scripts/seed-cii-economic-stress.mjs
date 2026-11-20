#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRedisCredentials, loadEnvFile, writeExtraKeyWithMetaAtomically } from './_seed-utils.mjs';
import { upstashCommand } from './_upstash-rest.mjs';
import ISO3_TO_ISO2 from './shared/iso3-to-iso2.json' with { type: 'json' };

export const ECONOMIC_KEY = 'intelligence:cii-economic-stress:v1';
export const ECONOMIC_META_KEY = 'seed-meta:intelligence:cii-economic-stress';
export const ECONOMIC_ACTIVATION_KEY = 'seed-activated:intelligence:cii-economic-stress';
// Scripts-only Railway root; parity with shared/cii-weights.ts is tested.
export const ECONOMIC_COUNTRIES = Object.freeze('US RU CN UA IR IL TW KP SA TR PL DE FR GB IN PK SY YE MM VE CU MX BR AE KR IQ AF LB EG JP QA'.split(' '));
export const ECONOMIC_EXTRA_COUNTRIES = Object.freeze('PH TH ID VN MY KH'.split(' '));
export const INPUT_KEYS = Object.freeze({
  currency: 'economic:fx:yoy:v1',
  inflation: 'economic:world-cpi:imf:v1',
  eurostat: 'economic:world-cpi:eurostat:v1',
  japan: 'economic:world-cpi:estat:v1',
  usCpi: 'economic:us-cpi:v1',
  yield: 'economic:yield-curve:oecd-lt:v1',
});
const DAY = 86400000;
const INPUT_COUNTRY_CODES = new Set(Object.values(ISO3_TO_ISO2));

function addMonths(ms, count) {
  const d = new Date(ms);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + count + 1, 0)).getUTCDate();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + count, Math.min(d.getUTCDate(), last), 23, 59, 59, 999);
}

function periodEnd(period) {
  const monthly = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period ?? '');
  if (monthly) return Date.UTC(+monthly[1], +monthly[2], 0, 23, 59, 59, 999);
  const quarterly = /^(\d{4})-Q([1-4])$/.exec(period ?? '');
  if (quarterly) return Date.UTC(+quarterly[1], +quarterly[2] * 3, 0, 23, 59, 59, 999);
  return NaN;
}

const absent = (reason, observedAt = null) => ({ status: 'absent', reason, observedAt });
function observation(value, observedMs, expiresAt, sourceKey, unit, nowMs, reference) {
  const observedAt = new Date(observedMs).toISOString().slice(0, 10);
  if (observedMs > nowMs + DAY) return absent('future-observation', observedAt);
  if (expiresAt < nowMs) return absent('stale', observedAt);
  if (!Number.isFinite(value)) return absent('insufficient-history', observedAt);
  return { status: 'fresh', value, observedAt, expiresAt, sourceKey, unit, reference };
}

const dailyOnlyRows = raw => (Array.isArray(raw.dailyOnly) ? raw.dailyOnly : []);

function currencyMember(raw, code, nowMs) {
  if (['US', 'DE', 'FR'].includes(code)) return absent('not-applicable');
  // A Yahoo row keeps priority; daily-only rows come from the second source alone.
  const row = raw.rates.find(x => x?.countryCode === code) ?? dailyOnlyRows(raw).find(x => x?.countryCode === code);
  if (!row) return absent('missing');
  // seed-fx-yoy cleans the daily quotes upstream: medians remove isolated bad
  // prints, and a series that keeps reverting is flagged, not compared.
  const daily = row.daily90;
  if (!daily) return absent('insufficient-history', row.asOf ?? null);
  const observedMs = Date.parse(daily.asOf);
  if (!Number.isFinite(observedMs)) return absent('invalid-date');
  if (nowMs - observedMs > 7 * DAY) return absent('stale', daily.asOf);
  if (daily.reliable !== true) return absent('unreliable-quotes', daily.asOf);
  if (!Number.isFinite(daily.latest) || !(daily.latest > 0) || !Number.isFinite(daily.anchor?.value) || !(daily.anchor.value > 0)) return absent('insufficient-history', daily.asOf);
  return observation(100 * (1 - daily.latest / daily.anchor.value), observedMs, observedMs + 7 * DAY, INPUT_KEYS.currency, 'percent', nowMs,
    { date: daily.anchor.date, value: daily.anchor.value, method: 'median-of-5-sessions-depreciation-vs-90-day-anchor', quoteSource: daily.source ?? 'yahoo', noiseShare: daily.noiseShare ?? daily.yahooNoiseShare ?? null });
}

function inflationMember(inputs, code, nowMs) {
  const candidates = ['inflation', 'eurostat', 'japan'].flatMap(id => {
    const entry = inputs[id].countries[code];
    return entry ? [{ ...entry, sourceKey: INPUT_KEYS[id] }] : [];
  });
  if (code === 'US') candidates.push({ frequency: 'M', points: inputs.usCpi.components.headline.map(p => ({ ...p, date: p.date.slice(0, 7) })), sourceKey: INPUT_KEYS.usCpi });
  const results = candidates.map(entry => {
    const points = (entry.points ?? []).filter(p => Number.isFinite(p?.value) && p.value > 0 && Number.isFinite(periodEnd(p.date)))
      .map(p => ({ ...p, ms: periodEnd(p.date) })).sort((a, b) => a.ms - b.ms);
    const latest = points.at(-1);
    if (!latest || !['M', 'Q'].includes(entry.frequency)) return absent('insufficient-history');
    const anchor = years => points.find(p => p.date === `${Number(latest.date.slice(0, 4)) - years}${latest.date.slice(4)}`);
    const previous = anchor(1), earlier = anchor(2);
    const value = previous && earlier ? 100 * (latest.value / previous.value - previous.value / earlier.value) : NaN;
    return observation(value, latest.ms, addMonths(latest.ms, entry.frequency === 'Q' ? 7 : 4), entry.sourceKey, 'percentage-points', nowMs,
      { method: 'year-on-year-inflation-minus-prior-year', period: latest.date, previousPeriod: previous?.date, earlierPeriod: earlier?.date });
  });
  // One inflation member, from the freshest usable mirror; ties retain source order.
  return results.filter(x => x.status === 'fresh').sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0]
    ?? results.sort((a, b) => (b.observedAt ?? '').localeCompare(a.observedAt ?? ''))[0] ?? absent('missing');
}

function yieldMember(raw, code, nowMs) {
  const entry = raw.countries[code];
  const points = (entry?.curves ?? []).filter(p => Number.isFinite(p?.tenors?.['10y']) && Number.isFinite(periodEnd(p.date?.slice(0, 7))))
    .map(p => ({ period: p.date.slice(0, 7), ms: periodEnd(p.date.slice(0, 7)), value: p.tenors['10y'] })).sort((a, b) => a.ms - b.ms);
  const latest = points.at(-1);
  if (!latest) return absent('missing');
  const prior = points.filter(p => p.ms < latest.ms && p.ms >= addMonths(latest.ms, -12));
  const months = new Set(prior.map(p => p.period));
  const value = months.size === 12 && prior.length === 12 ? latest.value - prior.reduce((n, p) => n + p.value, 0) / 12 : NaN;
  return observation(value, latest.ms, addMonths(latest.ms, 3), INPUT_KEYS.yield, 'percentage-points', nowMs,
    { method: '10-year-yield-minus-trailing-12-month-mean', period: latest.period });
}

function validateInputs(inputs) {
  for (const id of Object.keys(INPUT_KEYS)) {
    const raw = inputs[id];
    if (!raw || typeof raw !== 'object' || (id === 'currency' ? !Array.isArray(raw.rates)
      : id === 'usCpi' ? !Array.isArray(raw.components?.headline)
      : !raw.countries || typeof raw.countries !== 'object' || Array.isArray(raw.countries))) throw new Error(`Unreadable economic input: ${INPUT_KEYS[id]}`);
  }
}

export function economicCountry(inputs, code, nowMs) {
  const results = { currency: currencyMember(inputs.currency, code, nowMs), inflation: inflationMember(inputs, code, nowMs), yield: yieldMember(inputs.yield, code, nowMs) };
  const members = Object.fromEntries(Object.entries(results).filter(([, row]) => row.status === 'fresh'));
  const missing = Object.fromEntries(Object.entries(results).filter(([, row]) => row.status !== 'fresh'));
  const measured = Object.keys(members).length > 0;
  return { measured, members, absent: missing, coverage: Object.keys(members).length / 3, ...(!measured ? { label: 'economic stress not measured' } : {}) };
}

export function buildEconomicStress(inputs, nowMs = Date.now()) {
  validateInputs(inputs);
  // Keep unmeasured scored rows, and publish every country the sources carry.
  // Source aggregates and malformed identifiers must not become country rows.
  const codes = [...new Set([
    ...ECONOMIC_COUNTRIES,
    ...inputs.currency.rates.map(row => row?.countryCode),
    ...dailyOnlyRows(inputs.currency).map(row => row?.countryCode),
    ...['inflation', 'eurostat', 'japan', 'yield'].flatMap(id => Object.keys(inputs[id].countries)),
  ])].filter(code => INPUT_COUNTRY_CODES.has(code)).sort();
  const countries = Object.fromEntries(codes.map(code => [code, economicCountry(inputs, code, nowMs)]));
  return { schemaVersion: 1, generatedAt: nowMs, countries, measuredCount: Object.values(countries).filter(x => x.measured).length };
}

async function readInput(key) {
  const { url, token } = getRedisCredentials();
  const { result } = await upstashCommand({ restUrl: url, token }, ['GET', key]);
  if (result == null) throw new Error(`Unreadable economic input: ${key}`);
  const raw = JSON.parse(result);
  return raw?._seed ? raw.data : raw;
}
async function activate() {
  const { url, token } = getRedisCredentials();
  await upstashCommand({ restUrl: url, token }, ['SET', ECONOMIC_ACTIVATION_KEY, '1']);
}
export async function seedEconomicStress({ read = readInput, publish = writeExtraKeyWithMetaAtomically, activateKey = activate, dryRun = false, nowMs = Date.now() } = {}) {
  const inputs = Object.fromEntries(await Promise.all(Object.entries(INPUT_KEYS).map(async ([id, key]) => [id, await read(key)])));
  const payload = buildEconomicStress(inputs, nowMs);
  if (!ECONOMIC_COUNTRIES.every(code => Object.hasOwn(payload.countries, code))) throw new Error('Economic country list mismatch');
  if (!dryRun) {
    const ok = await publish({ key: ECONOMIC_KEY, data: payload, ttlSeconds: 2 * 86400, recordCount: Object.keys(payload.countries).length, metaKey: ECONOMIC_META_KEY, metaTtlSeconds: 2 * 86400, fetchedAt: nowMs });
    if (ok !== true) throw new Error('Economic-stress publication failed');
    await activateKey();
  }
  return { payload, additionalCountries: Object.fromEntries(ECONOMIC_EXTRA_COUNTRIES.map(code => [code, economicCountry(inputs, code, nowMs)])) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadEnvFile(import.meta.url);
  const dryRun = process.argv.includes('--dry-run');
  seedEconomicStress({ dryRun }).then(result => { console.log(JSON.stringify({ dryRun, ...result })); console.log('=== Done (CII economic stress) ==='); })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
