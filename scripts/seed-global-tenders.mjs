#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed, writeExtraKeyWithMeta } from './_seed-utils.mjs';
import {
  GLOBAL_TENDER_KEY,
  buildSnapshot,
  isOpenOpportunity,
  normalizeSamOpportunity,
  normalizeTedNotice,
  normalizeContractsFinderRelease,
  normalizeWorldBankNotice,
} from './_global-tenders.mjs';

loadEnvFile(import.meta.url);

const CACHE_TTL_SECONDS = 10_800; // 3h, safely beyond the hourly Railway cadence.
const SOURCE_STATUS_TTL_SECONDS = CACHE_TTL_SECONDS;
const MAX_PER_SOURCE = 100;

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA, ...(options.headers || {}) },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function sourceStatus(source, state, records = [], error = '') {
  return {
    source,
    state,
    recordCount: records.length,
    fetchedAt: new Date().toISOString(),
    ...(error ? { error: error.slice(0, 200) } : {}),
  };
}

async function fetchSam() {
  const apiKey = process.env.SAM_GOV_API_KEY;
  if (!apiKey) return { records: [], status: sourceStatus('sam', 'unavailable', [], 'SAM_GOV_API_KEY is not configured') };
  const postedFrom = new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10);
  const postedTo = new Date().toISOString().slice(0, 10);
  const url = new URL('https://api.sam.gov/prod/opportunities/v2/search');
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('postedFrom', postedFrom);
  url.searchParams.set('postedTo', postedTo);
  url.searchParams.set('limit', String(MAX_PER_SOURCE));
  const payload = await fetchJson(url);
  const records = (payload?.opportunitiesData || []).map(normalizeSamOpportunity).filter((tender) => isOpenOpportunity(tender));
  return { records, status: sourceStatus('sam', 'ok', records) };
}

async function fetchTed() {
  // TED's documented ACTIVE scope limits results to current opportunities. OJ = () is
  // the documented neutral expert query; deadline filtering happens after normalization.
  const payload = await fetchJson('https://api.ted.europa.eu/v3/notices/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: 'OJ = ()',
      fields: ['notice-identifier', 'title-lot', 'publication-date', 'deadline-receipt-tender-date-lot', 'organisation-name-buyer', 'organisation-country-buyer', 'main-classification-proc', 'notice-type (form-type)'],
      page: 1,
      limit: MAX_PER_SOURCE,
      scope: 'ACTIVE',
      checkQuerySyntax: true,
      paginationMode: 'PAGE_NUMBER',
    }),
  });
  const records = (payload?.notices || payload?.results || []).map(normalizeTedNotice).filter((tender) => isOpenOpportunity(tender));
  return { records, status: sourceStatus('ted', 'ok', records) };
}

async function fetchContractsFinder() {
  const to = new Date().toISOString();
  const from = new Date(Date.now() - 14 * 86400_000).toISOString();
  const url = new URL('https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search');
  url.searchParams.set('publishedFrom', from);
  url.searchParams.set('publishedTo', to);
  url.searchParams.set('stages', 'tender');
  url.searchParams.set('limit', String(MAX_PER_SOURCE));
  const payload = await fetchJson(url);
  const releases = payload?.releases || payload?.records || [];
  const records = releases.map(normalizeContractsFinderRelease).filter((tender) => isOpenOpportunity(tender));
  return { records, status: sourceStatus('contracts-finder', 'ok', records) };
}

async function fetchWorldBank() {
  const url = 'https://search.worldbank.org/api/procnotices?format=json&rows=100&os=0&fl=id,url,notice_type,publication_date,project_id,bid_description,procurement_category,procurement_method,deadline_date,country_code,country_name,sector,borrower&sort=publication_date&order=desc';
  const payload = await fetchJson(url);
  const rawNotices = payload?.procnotices;
  const notices = Array.isArray(rawNotices) ? rawNotices : Object.values(rawNotices || {});
  const records = notices.map(normalizeWorldBankNotice).filter((tender) => isOpenOpportunity(tender));
  return { records, status: sourceStatus('world-bank', 'ok', records) };
}

export async function fetchGlobalTenders() {
  const sources = [fetchSam, fetchTed, fetchContractsFinder, fetchWorldBank];
  const settled = await Promise.allSettled(sources.map((fetchSource) => fetchSource()));
  const records = [];
  const sourceStatuses = [];
  for (let index = 0; index < settled.length; index += 1) {
    const result = settled[index];
    if (result.status === 'fulfilled') {
      records.push(...result.value.records);
      sourceStatuses.push(result.value.status);
      continue;
    }
    const source = ['sam', 'ted', 'contracts-finder', 'world-bank'][index];
    sourceStatuses.push(sourceStatus(source, 'error', [], result.reason?.message || 'upstream request failed'));
  }
  if (!sourceStatuses.some((status) => status.state === 'ok')) {
    throw new Error(`All global tender sources failed: ${sourceStatuses.map((status) => `${status.source}=${status.state}`).join(', ')}`);
  }
  return buildSnapshot({ results: records, sourceStatuses });
}

function validate(snapshot) {
  return snapshot?.dataAvailable === true && Array.isArray(snapshot?.tenders) && Array.isArray(snapshot?.sourceStatuses);
}

function contentMeta(snapshot) {
  const dates = snapshot.tenders.map((tender) => Date.parse(tender.publishedAt || tender.updatedAt)).filter(Number.isFinite);
  return dates.length ? { newestItemAt: Math.max(...dates), oldestItemAt: Math.min(...dates) } : null;
}

runSeed('economic', 'global-tenders', GLOBAL_TENDER_KEY, fetchGlobalTenders, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL_SECONDS,
  declareRecords: (snapshot) => snapshot?.tenders?.length || 0,
  sourceVersion: 'sam-ted-contractsfinder-worldbank-v1',
  schemaVersion: 1,
  maxStaleMin: 180,
  zeroIsValid: true,
  contentMeta,
  maxContentAgeMin: 14 * 24 * 60,
  afterPublish: async (snapshot) => {
    await Promise.all(snapshot.sourceStatuses.map((status) => writeExtraKeyWithMeta(
      `economic:global-tenders:v1:source:${status.source}`,
      status,
      SOURCE_STATUS_TTL_SECONDS,
      status.recordCount,
      `seed-meta:economic:global-tenders:${status.source}`,
      SOURCE_STATUS_TTL_SECONDS,
    )));
  },
}).catch((error) => {
  console.error('FATAL:', error?.message || error);
  process.exit(1);
});
