#!/usr/bin/env node
// Seed USPTO defense/dual-use granted patents (issue #2047).
// Weekly cron — most recent grants per strategic CPC category.
//
// Source: USPTO Open Data Portal (ODP), api.uspto.gov.
//
// Previously this seeder called PatentsView (search.patentsview.org/api/v1)
// with no credentials. That API has required an `X-Api-Key` header since the
// legacy api.patentsview.org shutdown, so every request returned 403, and each
// category failure was only console.warn'd — the panel silently served
// increasingly stale cache behind the 21-day TTL. No PatentsView key is
// provisioned in this environment (theirs is issued by hand via a service
// desk), so the seeder now uses USPTO's own ODP API, whose key we already
// hold. ODP application metadata carries no abstract; the panel renders none.

import { loadEnvFile, CHROME_UA, runSeed, sleep } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'patents:defense:latest';
const CACHE_TTL = 1_814_400; // 21 days (3× weekly interval)
const ODP_SEARCH_API = 'https://api.uspto.gov/api/v1/patent/applications/search';
const INTER_CATEGORY_DELAY_MS = 3_000;
const MAX_PER_CATEGORY = 20;
const GRANT_WINDOW_MONTHS = 24;
const RETRIES_PER_CATEGORY = 1;

// Key defense/dual-use assignees. ODP indexes the applicant of record, so
// these match `applicationMetaData.firstApplicantName` — "Raytheon Company"
// and "RAYTHEON BBN TECHNOLOGIES CORP." both match "Raytheon".
const DEFENSE_ASSIGNEES = [
  'Raytheon', 'Lockheed', 'Northrop', 'Huawei', 'SMIC', 'TSMC', 'DARPA',
  'Boeing', 'L3Harris', 'General Dynamics', 'BAE Systems', 'Thales',
];

// Strategic CPC classes
const CPC_CATEGORIES = [
  { code: 'H04B', desc: 'Transmission / Communications' },
  { code: 'H01L', desc: 'Semiconductor devices' },
  { code: 'F42B', desc: 'Ammunition / Explosives' },
  { code: 'G06N', desc: 'AI / Neural networks' },
  { code: 'C12N', desc: 'Microorganisms / Biotechnology' },
];

const FIELDS = [
  'applicationNumberText',
  'applicationMetaData.inventionTitle',
  'applicationMetaData.grantDate',
  'applicationMetaData.patentNumber',
  'applicationMetaData.firstApplicantName',
  'applicationMetaData.cpcClassificationBag',
];

/** Auth failures are not retryable and must not read as a quiet week. */
class OdpAuthError extends Error {}

/**
 * Resolve the ODP API key.
 *
 * The vault holds two entries: `USPTO_ODP_API_KEY_1` is a truncated copy of
 * `USPTO_ODP_API_KEY_2` (a bad vault write dropped its first character), so
 * `_2` is preferred and `_1` is only a last resort. `USPTO_ODP_API_KEY` is
 * the plain name a deployment may inject directly.
 */
function odpApiKey() {
  const key = process.env.USPTO_ODP_API_KEY
    || process.env.USPTO_ODP_API_KEY_2
    || process.env.USPTO_ODP_API_KEY_1;
  if (!key) {
    throw new OdpAuthError(
      'No USPTO ODP API key: set USPTO_ODP_API_KEY (or USPTO_ODP_API_KEY_2). '
      + 'Free keys: https://data.uspto.gov/apis',
    );
  }
  return key;
}

function grantWindowStart() {
  const d = new Date();
  d.setMonth(d.getMonth() - GRANT_WINDOW_MONTHS);
  return d.toISOString().slice(0, 10);
}

function buildQuery(cpcCode) {
  const assignees = DEFENSE_ASSIGNEES.map((a) => `"${a}"`).join(' OR ');
  return [
    `applicationMetaData.cpcClassificationBag:${cpcCode}*`,
    `applicationMetaData.firstApplicantName:(${assignees})`,
    `applicationMetaData.grantDate:[${grantWindowStart()} TO 9999-12-31]`,
  ].join(' AND ');
}

async function fetchCategoryPatents(category, apiKey) {
  const resp = await fetch(ODP_SEARCH_API, {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': CHROME_UA,
    },
    body: JSON.stringify({
      q: buildQuery(category.code),
      fields: FIELDS,
      sort: [{ field: 'applicationMetaData.grantDate', order: 'desc' }],
      pagination: { offset: 0, limit: MAX_PER_CATEGORY },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (resp.status === 401 || resp.status === 403) {
    throw new OdpAuthError(`HTTP ${resp.status} — ODP key rejected`);
  }
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();

  return (data.patentFileWrapperDataBag ?? []).map((wrapper) => {
    const meta = wrapper.applicationMetaData ?? {};
    const patentId = String(meta.patentNumber ?? '');
    return {
      patentId,
      title: String(meta.inventionTitle ?? '').slice(0, 300),
      date: String(meta.grantDate ?? ''),
      assignee: String(meta.firstApplicantName ?? '').slice(0, 200),
      cpcCode: category.code,
      cpcDesc: category.desc,
      abstract: '', // not exposed by ODP application metadata
      url: patentId ? `https://patents.google.com/patent/US${patentId}` : '',
    };
  }).filter((p) => p.patentId && p.date);
}

async function fetchAllPatents() {
  const apiKey = odpApiKey(); // throws before any request when unset
  const all = [];
  const failedCategories = [];

  for (let i = 0; i < CPC_CATEGORIES.length; i++) {
    const category = CPC_CATEGORIES[i];
    if (i > 0) await sleep(INTER_CATEGORY_DELAY_MS);
    console.log(`  Fetching ${category.code} (${category.desc})...`);

    for (let attempt = 0; attempt <= RETRIES_PER_CATEGORY; attempt++) {
      try {
        const patents = await fetchCategoryPatents(category, apiKey);
        console.log(`    ${patents.length} patents`);
        all.push(...patents);
        break;
      } catch (err) {
        // A rejected key fails every category identically — stop now rather
        // than burn the retry budget and report it as five separate blips.
        if (err instanceof OdpAuthError) throw err;
        if (attempt < RETRIES_PER_CATEGORY) {
          console.warn(`    ${category.code}: ${err.message} — retrying`);
          await sleep(INTER_CATEGORY_DELAY_MS);
          continue;
        }
        console.warn(`    ${category.code}: failed (${err.message})`);
        failedCategories.push(category.code);
      }
    }
  }

  // Deduplicate by patentId and sort newest first
  const seen = new Set();
  const deduped = all.filter((p) => {
    if (seen.has(p.patentId)) return false;
    seen.add(p.patentId);
    return true;
  }).sort((a, b) => b.date.localeCompare(a.date));

  return {
    patents: deduped,
    total: deduped.length,
    failedCategories,
    fetchedAt: new Date().toISOString(),
  };
}

// A partial sweep is a failure, not a thin week: writing it would overwrite a
// complete cache with one missing whole CPC categories, and the 21-day TTL
// would hide that for three cron cycles. Fail loud, keep the last good set.
function validate(data) {
  if (!Array.isArray(data?.patents) || data.patents.length === 0) return false;
  if (data.failedCategories?.length) {
    console.error(`  categories failed: ${data.failedCategories.join(', ')}`);
    return false;
  }
  return true;
}

export function declareRecords(data) {
  return data?.patents?.length ?? 0;
}

runSeed('military', 'defense-patents', CANONICAL_KEY, fetchAllPatents, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'uspto-odp-v1',
  recordCount: (d) => d?.patents?.length ?? 0,
  declareRecords,
  schemaVersion: 1,
  maxStaleMin: 25200,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
