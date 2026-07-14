#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import Papa from 'papaparse';

import { loadEnvFile, CHROME_UA, httpRetryError, readCanonicalValue, runSeed, withRetry, writeExtraKey } from './_seed-utils.mjs';
import {
  GLOBAL_TENDER_KEY,
  isOpenOpportunity,
  mergeTenderSourceResults,
  normalizeSamOpportunity,
  normalizeTedNotice,
  normalizeContractsFinderRelease,
  normalizeCanadaBuysNotice,
  normalizeGetsNotice,
  normalizeWorldBankNotice,
} from './_global-tenders.mjs';

const CACHE_TTL_SECONDS = 10_800; // 3h, safely beyond the hourly Railway cadence.
const SOURCE_STATUS_TTL_SECONDS = CACHE_TTL_SECONDS;
const MAX_PER_SOURCE = 100;
const GETS_FEED_URL = 'https://www.gets.govt.nz/ExternalRSSFeed.htm';
const CANADA_BUYS_OPEN_CSV_URL = 'https://canadabuys.canada.ca/opendata/pub/openTenderNotice-ouvertAvisAppelOffres.csv';

// Every tender source funnels through here, so this is the one place a transient
// upstream blip can be absorbed. Without it a single failed fetch failed the whole
// source and raised a health warn that self-healed on the next tick — noise the
// operator cannot act on.
//
// The retry budget is BOUNDED by the bundle section, not chosen for its own sake:
// Global-Tenders has timeoutMs 180_000 and CanadaBuys uses a 60s per-attempt
// timeout, so maxRetries 2 would cost 60+1+60+2+60 = 183s and BREACH the section.
// Callers with a long per-attempt timeout must lower maxRetries accordingly.
// Sources run in parallel, so the section pays the slowest source, not the sum.
async function fetchResponse(url, options = {}) {
  const { timeoutMs = 20_000, maxRetries = 2, ...fetchOptions } = options;
  return withRetry(async () => {
    const response = await fetch(url, {
      ...fetchOptions,
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA, ...(fetchOptions.headers || {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      // Reuse the repository retry contract: 408 and 429 remain retryable, permanent
      // 4xx responses fail fast, and Retry-After is capped before it reaches withRetry.
      throw httpRetryError(response);
    }
    return response;
  }, maxRetries, 1000);
}

async function fetchJson(url, options = {}) {
  return (await fetchResponse(url, options)).json();
}

async function fetchText(url, options = {}) {
  return (await fetchResponse(url, { ...options, headers: { Accept: 'application/rss+xml, application/xml, text/xml', ...(options.headers || {}) } })).text();
}

export function sourceStatus(source, state, records = [], error = '', now = Date.now()) {
  const fetchedAt = new Date(now).toISOString();
  return {
    source,
    state,
    recordCount: records.length,
    fetchedAt,
    lastSuccessfulAt: state === 'ok' ? fetchedAt : '',
    stale: false,
    ...(error ? { error: error.slice(0, 200) } : {}),
  };
}

function utcDate(value) {
  const date = new Date(value);
  return `${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')}/${date.getUTCFullYear()}`;
}

function tedDate(value) {
  return new Date(value).toISOString().slice(0, 10).replaceAll('-', '');
}

export async function fetchSam({ apiKey = process.env.SAM_GOV_API_KEY, now = Date.now(), fetchJsonFn = fetchJson } = {}) {
  if (!apiKey) return { records: [], status: sourceStatus('sam', 'unavailable', [], 'SAM_GOV_API_KEY is not configured', now) };
  const url = new URL('https://api.sam.gov/opportunities/v2/search');
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('postedFrom', utcDate(now - 14 * 86400_000));
  url.searchParams.set('postedTo', utcDate(now));
  url.searchParams.set('limit', String(MAX_PER_SOURCE));
  const payload = await fetchJsonFn(url);
  if (!Array.isArray(payload?.opportunitiesData)) throw new Error('SAM response is missing opportunitiesData');
  const records = payload.opportunitiesData.map(normalizeSamOpportunity).filter((tender) => isOpenOpportunity(tender, now));
  return { records, status: sourceStatus('sam', 'ok', records, '', now) };
}

export async function fetchTed({ now = Date.now(), fetchJsonFn = fetchJson } = {}) {
  const payload = await fetchJsonFn('https://api.ted.europa.eu/v3/notices/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `deadline-receipt-tender-date-lot >= ${tedDate(now)} SORT BY publication-date DESC`,
      fields: ['publication-number', 'title-lot', 'publication-date', 'deadline-receipt-tender-date-lot', 'organisation-name-buyer', 'organisation-country-buyer', 'main-classification-proc', 'notice-type'],
      page: 1,
      limit: MAX_PER_SOURCE,
      scope: 'ACTIVE',
      paginationMode: 'PAGE_NUMBER',
      onlyLatestVersions: true,
    }),
  });
  const notices = payload?.notices ?? payload?.results;
  if (!Array.isArray(notices)) throw new Error('TED response is missing notices');
  const records = notices.map(normalizeTedNotice).filter((tender) => isOpenOpportunity(tender, now));
  return { records, status: sourceStatus('ted', 'ok', records, '', now) };
}

export async function fetchContractsFinder({ now = Date.now(), fetchJsonFn = fetchJson } = {}) {
  const url = new URL('https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search');
  url.searchParams.set('publishedFrom', new Date(now - 14 * 86400_000).toISOString());
  url.searchParams.set('publishedTo', new Date(now).toISOString());
  url.searchParams.set('stages', 'tender');
  url.searchParams.set('limit', String(MAX_PER_SOURCE));
  const payload = await fetchJsonFn(url);
  const releases = payload?.releases ?? payload?.records;
  if (!Array.isArray(releases)) throw new Error('Contracts Finder response is missing releases');
  const records = releases.map(normalizeContractsFinderRelease).filter((tender) => isOpenOpportunity(tender, now));
  return { records, status: sourceStatus('contracts-finder', 'ok', records, '', now) };
}

export async function fetchCanadaBuys({ now = Date.now(), fetchTextFn = fetchText } = {}) {
  const csv = await fetchTextFn(CANADA_BUYS_OPEN_CSV_URL, {
    timeoutMs: 60_000,
    // 6 MB CSV on a 60s attempt timeout: one retry (60+1+60 = 121s) fits inside the
    // 180s Global-Tenders section budget; two (183s) would breach it.
    maxRetries: 1,
    headers: { Accept: 'text/csv, application/octet-stream;q=0.9, */*;q=0.1' },
  });
  const parsed = Papa.parse(csv, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.replace(/^\uFEFF/, ''),
  });
  const requiredHeaders = ['title-titre-eng', 'referenceNumber-numeroReference', 'noticeURL-URLavis-eng'];
  if (!requiredHeaders.every((header) => parsed.meta?.fields?.includes(header))) {
    throw new Error('CanadaBuys response is not the documented open-tender CSV');
  }
  if (parsed.errors?.length && !parsed.data?.length) throw new Error(`CanadaBuys CSV parse failed: ${parsed.errors[0]?.message || 'unknown error'}`);
  const records = parsed.data.map((row) => normalizeCanadaBuysNotice({
    title: row['title-titre-eng'],
    referenceNumber: row['referenceNumber-numeroReference'],
    publishedAt: row['publicationDate-datePublication'],
    updatedAt: row['amendmentDate-dateModification'],
    deadline: row['tenderClosingDate-appelOffresDateCloture'],
    status: row['tenderStatus-appelOffresStatut-eng'],
    unspsc: row.unspsc,
    sector: row['unspscDescription-eng'],
    procurementCategory: row['procurementCategory-categorieApprovisionnement'],
    noticeType: row['noticeType-avisType-eng'],
    buyer: row['contractingEntityName-nomEntitContractante-eng'],
    noticeUrl: row['noticeURL-URLavis-eng'],
    description: row['tenderDescription-descriptionAppelOffres-eng'],
  })).filter((tender) => isOpenOpportunity(tender, now)).slice(0, MAX_PER_SOURCE);
  return { records, status: sourceStatus('canada-buys', 'ok', records, '', now) };
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function getsField(description, label) {
  const pattern = new RegExp(`${label}:?\\s*(?:<\\/b>)?\\s*<\\/td>\\s*<td[^>]*>([\\s\\S]*?)<\\/td>`, 'i');
  return decodeHtml(String(description || '').match(pattern)?.[1] || '');
}

function asItems(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export async function fetchGets({ now = Date.now(), fetchTextFn = fetchText } = {}) {
  const xml = await fetchTextFn(GETS_FEED_URL);
  const parsed = new XMLParser({ ignoreAttributes: false, processEntities: true }).parse(xml);
  const items = asItems(parsed?.rss?.channel?.item).slice(0, MAX_PER_SOURCE);
  const records = items.map((item) => {
    const description = String(item?.description || '');
    const link = typeof item?.link === 'string' ? item.link : item?.guid;
    const id = getsField(description, 'RFx ID') || String(link || '').match(/[?&]id=(\d+)/)?.[1] || '';
    const deadlineRaw = getsField(description, 'Close date');
    return normalizeGetsNotice({
      id,
      title: item?.title,
      link,
      buyer: item?.['dc:creator'] || getsField(description, 'Organisation'),
      publishedAt: item?.['dc:date'] || item?.pubDate,
      deadline: Number.isFinite(Date.parse(deadlineRaw)) ? new Date(deadlineRaw).toISOString() : '',
      categories: asItems(item?.category),
      description: getsField(description, 'Overview'),
    });
  }).filter((tender) => isOpenOpportunity(tender, now));
  return { records, status: sourceStatus('gets', 'ok', records, '', now) };
}

export async function fetchWorldBank({ now = Date.now(), fetchJsonFn = fetchJson } = {}) {
  const url = new URL('https://search.worldbank.org/api/v2/procnotices');
  url.searchParams.set('format', 'json');
  url.searchParams.set('rows', String(MAX_PER_SOURCE));
  url.searchParams.set('os', '0');
  url.searchParams.set('fl', 'id,url,notice_type,publication_date,project_id,project_name,bid_description,procurement_category,procurement_method,submission_deadline_date,project_ctry_code,project_ctry_name,sector,borrower,implementing_agency');
  url.searchParams.set('srt', 'submission_deadline_date');
  url.searchParams.set('order', 'asc');
  url.searchParams.set('apilang', 'en');
  url.searchParams.set('srce', 'both');
  url.searchParams.set('notice_type_exact', 'Invitation for Bids^Invitation for Prequalification^Request for Expression of Interest');
  url.searchParams.set('deadline_strdate', new Date(now).toISOString().slice(0, 10));
  const payload = await fetchJsonFn(url);
  const rawNotices = payload?.procnotices;
  if (!rawNotices || (typeof rawNotices !== 'object' && !Array.isArray(rawNotices))) {
    throw new Error('World Bank response is missing procnotices');
  }
  const notices = Array.isArray(rawNotices) ? rawNotices : Object.values(rawNotices || {});
  const records = notices.map(normalizeWorldBankNotice).filter((tender) => isOpenOpportunity(tender, now));
  return { records, status: sourceStatus('world-bank', 'ok', records, '', now) };
}

// An Australian `austender` adapter is BLOCKED on the provider (#5286): no
// permitted machine-readable AusTender interface publishes the closing date
// that isOpenOpportunity requires. As of 2026-07-13 (checked against a
// same-day capture of the feed, corroborated by its independent consumers):
// the official current-ATM RSS (https://www.tenders.gov.au/public_data/rss/rss.xml,
// registered on data.gov.au) carries only title/link/description/pubDate —
// no close date, buyer, or category; the official OCDS API
// (api.tenders.gov.au/ocds/*) exposes awarded contract notices, not open
// ATMs; data.gov.au's machine-readable open-ATM exports ended June 2014.
// Closing dates exist only on per-notice HTML pages, and scraping them is an
// explicit non-goal. Do not substitute GETS (NZ) for Australian coverage.
const SOURCE_ADAPTERS = [
  ['sam', fetchSam],
  ['ted', fetchTed],
  ['contracts-finder', fetchContractsFinder],
  ['canada-buys', fetchCanadaBuys],
  ['gets', fetchGets],
  ['world-bank', fetchWorldBank],
];

export async function fetchGlobalTenders({ previousSnapshot = null, adapters = SOURCE_ADAPTERS, now = Date.now() } = {}) {
  const attemptedAt = new Date(now).toISOString();
  const settled = await Promise.allSettled(adapters.map(([, fetchSource]) => fetchSource({ now })));
  return mergeTenderSourceResults({
    settled,
    sourceNames: adapters.map(([source]) => source),
    previousSnapshot,
    attemptedAt,
  });
}

function validate(snapshot) {
  return snapshot?.dataAvailable === true && Array.isArray(snapshot?.tenders) && Array.isArray(snapshot?.sourceStatuses);
}

function contentMeta(snapshot) {
  const dates = snapshot.tenders.map((tender) => Date.parse(tender.publishedAt || tender.updatedAt)).filter(Number.isFinite);
  return dates.length ? { newestItemAt: Math.max(...dates), oldestItemAt: Math.min(...dates) } : null;
}

export function declareRecords(snapshot) {
  return Array.isArray(snapshot?.tenders) ? snapshot.tenders.length : 0;
}

async function recordUnavailableSourceHealth(snapshot) {
  if (snapshot?.dataAvailable === true) return;
  await Promise.all((snapshot?.sourceStatuses || []).map(writeSourceStatus));
}

async function writeSourceStatus(status) {
  const key = `economic:global-tenders:v1:source:${status.source}`;
  const metaKey = `seed-meta:economic:global-tenders:${status.source}`;
  const successfulAt = Date.parse(status.lastSuccessfulAt || status.fetchedAt || '');
  const failed = status.state !== 'ok';
  await writeExtraKey(key, status, SOURCE_STATUS_TTL_SECONDS);
  await writeExtraKey(metaKey, {
    fetchedAt: Number.isFinite(successfulAt) ? successfulAt : 0,
    recordCount: status.recordCount || 0,
    sourceState: status.state,
    stale: Boolean(status.stale || failed),
  }, SOURCE_STATUS_TTL_SECONDS);
}

async function main() {
  loadEnvFile(import.meta.url);
  await runSeed('economic', 'global-tenders', GLOBAL_TENDER_KEY, async () => {
    const snapshot = await fetchGlobalTenders({
      previousSnapshot: await readCanonicalValue(GLOBAL_TENDER_KEY).catch(() => null),
    });
    // A fully unavailable initial run fails canonical validation by design, but
    // operators still need the per-source failure states written to health.
    await recordUnavailableSourceHealth(snapshot);
    return snapshot;
  }, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL_SECONDS,
    declareRecords,
    sourceVersion: 'sam-ted-contractsfinder-canadabuys-gets-worldbank-v2',
    schemaVersion: 1,
    maxStaleMin: 180,
    zeroIsValid: true,
    contentMeta,
    maxContentAgeMin: 14 * 24 * 60,
    afterPublish: async (snapshot) => {
      await Promise.all(snapshot.sourceStatuses.map(writeSourceStatus));
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('FATAL:', error?.message || error);
    process.exit(1);
  });
}
