import { unwrapEnvelope } from './_seed-envelope.js';

const CACHE_KEY = 'conflict:humanitarian:v1';
const RETENTION_MS = 6 * 60 * 60_000;
const COUNTS = ['conflictEventsTotal', 'conflictPoliticalViolenceEvents', 'conflictFatalities', 'conflictDemonstrations'];

function payload(raw) {
  try { return unwrapEnvelope(typeof raw === 'string' ? JSON.parse(raw) : raw).data; }
  catch { return null; }
}

// The producer supplies its current required-country contract, independently
// of the retained marker. Read the actual RPC payloads, not just that marker.
export async function readHumanitarianRetention(meta, requiredCountryCount, now, pipeline) {
  const codes = meta?.requiredCountryCodes;
  if (!Array.isArray(codes) || codes.length !== requiredCountryCount || codes.length > 100
    || codes.some((code) => typeof code !== 'string' || !/^[A-Z]{2}$/.test(code))
    || new Set(codes).size !== codes.length
    || !Number.isSafeInteger(meta.fetchedAt) || meta.fetchedAt <= 0 || meta.fetchedAt > now
    || (meta.lastSuccessAt !== undefined && meta.lastSuccessAt !== meta.fetchedAt)) return null;
  const results = await pipeline([
    ['GET', CACHE_KEY],
    ...codes.flatMap((code) => [['GET', `${CACHE_KEY}:${code}`], ['PTTL', `${CACHE_KEY}:${code}`]]),
  ], 4_000, true).catch(() => null);
  if (!Array.isArray(results) || results.length !== 1 + codes.length * 2
    || results.some((row) => !row || row.error)) return null;
  const sortedCodes = [...codes].sort();
  const marker = payload(results[0].result);
  if (marker?.updatedAt !== meta.fetchedAt
    || marker.requiredCountriesTotal !== codes.length
    || marker.requiredCountriesCovered !== codes.length
    || !Array.isArray(marker.requiredCountryCodes)
    || marker.requiredCountryCodes.length !== codes.length
    || [...marker.requiredCountryCodes].sort().some((code, index) => code !== sortedCodes[index])) return null;
  let until = meta.fetchedAt + RETENTION_MS;
  for (let i = 0; i < codes.length; i += 1) {
    const summary = payload(results[1 + i * 2].result)?.summary;
    const ttl = results[2 + i * 2].result;
    const referenceAt = typeof summary?.referencePeriod === 'string' ? Date.parse(summary.referencePeriod) : NaN;
    if (!summary || summary.countryCode !== codes[i]
      || typeof summary.countryName !== 'string' || !summary.countryName.trim()
      || !Number.isFinite(referenceAt) || referenceAt > now
      || new Date(referenceAt).toISOString().slice(0, 10) !== summary.referencePeriod.slice(0, 10)
      || COUNTS.some((field) => !Number.isFinite(summary[field]) || summary[field] < 0)
      || !Number.isSafeInteger(summary.updatedAt) || summary.updatedAt <= 0 || summary.updatedAt > meta.fetchedAt
      || !Number.isSafeInteger(ttl) || ttl <= 0) return null;
    until = Math.min(until, summary.updatedAt + RETENTION_MS, now + ttl);
  }
  return until > now ? { until, records: codes.length } : null;
}
