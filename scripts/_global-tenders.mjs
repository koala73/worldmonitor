import iso3ToIso2 from './shared/iso3-to-iso2.json' with { type: 'json' };

const TECHNOLOGY_TERMS = [
  ['artificial intelligence', 'AI'], ['machine learning', 'machine learning'], ['cybersecurity', 'cybersecurity'],
  ['cyber security', 'cybersecurity'], ['software', 'software'], ['data platform', 'data platform'],
  ['data management', 'data management'], ['automation', 'automation'], ['cloud', 'cloud'], ['digital', 'digital'],
];

export const GLOBAL_TENDER_KEY = 'economic:global-tenders:v1';
export const GLOBAL_TENDER_META_KEY = 'seed-meta:economic:global-tenders';

const OFFICIAL_SOURCE_HOSTS = {
  sam: ['sam.gov'],
  ted: ['ted.europa.eu'],
  'contracts-finder': ['contractsfinder.service.gov.uk'],
  // CanadaBuys' official open-data feed currently delegates notices to these
  // three named procurement platforms. Keep the list exact and source-scoped.
  'canada-buys': ['canadabuys.canada.ca', 'www.merx.com', 'portal.us.bn.cloud.ariba.com', 'discovery.ariba.com'],
  gets: ['gets.govt.nz'],
  'world-bank': ['worldbank.org'],
};

function string(value) { return typeof value === 'string' ? value.trim() : ''; }
function firstString(...values) { return values.map(string).find(Boolean) || ''; }
function array(value) { return Array.isArray(value) ? value.map(string).filter(Boolean) : string(value) ? [string(value)] : []; }
function strings(value) {
  if (typeof value === 'string') return string(value) ? [string(value)] : [];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (!value || typeof value !== 'object') return [];
  const localized = value.eng ?? value.ENG;
  return [...strings(localized), ...Object.entries(value).filter(([key]) => key !== 'eng' && key !== 'ENG').flatMap(([, nested]) => strings(nested))];
}
function firstText(...values) { return values.flatMap(strings).find(Boolean) || ''; }
function parseDate(value) {
  const raw = string(value);
  if (!raw) return NaN;
  const tedDate = raw.match(/^(\d{4}-\d{2}-\d{2})(Z|[+-]\d{2}:\d{2})$/);
  return Date.parse(tedDate ? `${tedDate[1]}T00:00:00${tedDate[2]}` : raw);
}
function date(value) {
  const parsed = strings(value).map(parseDate).find(Number.isFinite);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}
function latestDate(value) {
  const parsed = strings(value).map(parseDate).filter(Number.isFinite);
  return parsed.length ? new Date(Math.max(...parsed)).toISOString() : '';
}
function normalizeCountryCode(value) {
  const code = firstText(value).toUpperCase();
  return code.length === 3 ? (iso3ToIso2[code] || code) : code;
}
function isoTimestamp(value) {
  const parsed = typeof value === 'number' ? value : Date.parse(string(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}
function number(value) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function safeOfficialUrl(value, source) {
  try {
    const url = new URL(string(value));
    const allowed = OFFICIAL_SOURCE_HOSTS[source] || [];
    const officialHost = allowed.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
    return url.protocol === 'https:' && officialHost && !url.username && !url.password ? url.toString() : '';
  } catch { return ''; }
}

export function classifyAutomationFit({ title = '', description = '', categories = [] }) {
  const fields = { title: string(title), description: string(description), categories: array(categories).join(' ') };
  const matches = TECHNOLOGY_TERMS.flatMap(([term, label]) => {
    const field = Object.entries(fields).find(([, value]) => value.toLowerCase().includes(term));
    return field ? [[term, label, field[0]]] : [];
  });
  const reasons = [...new Set(matches.map(([, label]) => label))];
  const evidence = matches.slice(0, 3).map(([term, , field]) => `${field}: ${term}`);
  return {
    level: reasons.length >= 3 ? 'high' : reasons.length === 2 ? 'medium' : reasons.length === 1 ? 'low' : 'none',
    score: reasons.length >= 3 ? 90 : reasons.length === 2 ? 60 : reasons.length === 1 ? 30 : 0,
    classificationVersion: 'keyword-v1',
    matchReasons: reasons,
    evidence,
  };
}

function normalize({ source, sourceNoticeId, officialUrl, countryCode = '', region = '', title, description = '', buyer = '', publishedAt = '', updatedAt = '', deadline = '', status = 'open', noticeType = '', moneyAmount, currency = '', categoryCodes = [], sectors = [] }) {
  const id = string(sourceNoticeId);
  const normalizedOfficialUrl = safeOfficialUrl(officialUrl, source);
  if (!id || !string(title) || !normalizedOfficialUrl) return null;
  const normalizedCategories = array(categoryCodes);
  const normalizedSectors = array(sectors);
  const amount = number(moneyAmount);
  const normalizedCurrency = string(currency).toUpperCase();
  return {
    id: `${source}:${id}`,
    source,
    sourceNoticeId: id,
    officialUrl: normalizedOfficialUrl,
    countryCode: normalizeCountryCode(countryCode),
    region: string(region),
    title: string(title),
    description: string(description),
    buyer: string(buyer),
    publishedAt: date(publishedAt),
    updatedAt: date(updatedAt),
    deadline: date(deadline),
    status: string(status).toLowerCase() || 'open',
    noticeType: string(noticeType),
    ...(amount !== undefined || normalizedCurrency ? { money: { ...(amount !== undefined ? { amount } : {}), ...(normalizedCurrency ? { currency: normalizedCurrency } : {}) } } : {}),
    categoryCodes: normalizedCategories,
    sectors: normalizedSectors,
    eligibilityRequirements: [],
    submissionUrls: [],
    participationMode: 'unknown',
    automationFit: classifyAutomationFit({ title, description, categories: [...normalizedCategories, ...normalizedSectors] }),
  };
}

export function normalizeSamOpportunity(raw) {
  const noticeId = firstString(raw?.noticeId, raw?.notice_id, raw?.solicitationNumber);
  return normalize({
    source: 'sam', sourceNoticeId: noticeId, officialUrl: firstString(raw?.uiLink, raw?.link, noticeId && `https://sam.gov/opp/${noticeId}/view`),
    countryCode: 'US', region: 'North America', title: raw?.title, description: firstString(raw?.description, raw?.fullParentPathName),
    buyer: firstString(raw?.fullParentPathName, raw?.office), publishedAt: raw?.postedDate, updatedAt: raw?.modifiedDate,
    deadline: raw?.responseDeadLine, status: raw?.type === 'Award Notice' ? 'awarded' : 'open', noticeType: raw?.type,
    categoryCodes: raw?.naicsCode, sectors: raw?.classificationCode,
  });
}

export function normalizeTedNotice(raw) {
  const noticeId = firstString(raw?.['notice-identifier'], raw?.['publication-number'], raw?.['notice-id'], raw?.noticeId, raw?.id);
  return normalize({
    source: 'ted', sourceNoticeId: noticeId,
    officialUrl: firstString(raw?.['notice-url'], raw?.url, noticeId && `https://ted.europa.eu/en/notice/-/detail/${encodeURIComponent(noticeId)}`),
    countryCode: normalizeCountryCode(raw?.['organisation-country-buyer'] || raw?.['country'] || raw?.countryCode), region: 'Europe',
    title: firstText(raw?.['title-lot'], raw?.['notice-title'], raw?.title), description: firstText(raw?.['notice-description'], raw?.description),
    buyer: firstText(raw?.['organisation-name-buyer'], raw?.['buyer-name'], raw?.buyer), publishedAt: date(raw?.['publication-date'] || raw?.publicationDate),
    updatedAt: date(raw?.['last-modification-date'] || raw?.updatedAt), deadline: latestDate(raw?.['deadline-receipt-tender-date-lot'] || raw?.['deadline-date'] || raw?.deadline),
    status: firstString(raw?.status, 'open'), noticeType: firstString(raw?.['notice-type (form-type)'], raw?.['notice-type'], raw?.noticeType),
    moneyAmount: firstString(raw?.['estimated-value'], raw?.estimatedValue), currency: firstString(raw?.['currency'], raw?.currency),
    categoryCodes: raw?.['main-classification-proc'] || raw?.['cpv-code'] || raw?.cpvCodes, sectors: raw?.['main-nature'],
  });
}

export function normalizeContractsFinderRelease(raw) {
  const tender = raw?.tender || {};
  const buyer = raw?.buyer || {};
  const id = firstString(raw?.id, raw?.ocid);
  return normalize({
    source: 'contracts-finder', sourceNoticeId: id, officialUrl: firstString(raw?.url, id && `https://www.contractsfinder.service.gov.uk/Notice/${encodeURIComponent(id)}`),
    countryCode: 'GB', region: 'Europe', title: tender.title, description: tender.description, buyer: buyer.name,
    publishedAt: raw?.date, updatedAt: raw?.dateModified, deadline: tender?.tenderPeriod?.endDate,
    status: tender.status || 'open', noticeType: raw?.tag?.join(', '), moneyAmount: tender?.value?.amount, currency: tender?.value?.currency,
    categoryCodes: tender?.classification?.id, sectors: tender?.mainProcurementCategory,
  });
}

export function normalizeCanadaBuysNotice(raw) {
  return normalize({
    source: 'canada-buys', sourceNoticeId: raw?.referenceNumber, officialUrl: raw?.noticeUrl,
    countryCode: 'CA', region: 'North America', title: raw?.title, description: raw?.description,
    buyer: raw?.buyer, publishedAt: raw?.publishedAt, updatedAt: raw?.updatedAt,
    deadline: raw?.deadline, status: raw?.status || 'open', noticeType: raw?.noticeType,
    categoryCodes: [raw?.unspsc, raw?.procurementCategory], sectors: raw?.sector,
  });
}

export function normalizeWorldBankNotice(raw) {
  const id = firstString(raw?.id, raw?.notice_id);
  return normalize({
    source: 'world-bank', sourceNoticeId: id,
    officialUrl: firstString(raw?.url, raw?.notice_url, id && `https://projects.worldbank.org/en/projects-operations/procurement-detail/${encodeURIComponent(id)}`),
    countryCode: firstString(raw?.project_ctry_code, raw?.country_code, raw?.countrycode), region: firstString(raw?.region, 'Multilateral'),
    title: firstString(raw?.bid_description, raw?.title, raw?.project_name), description: firstString(raw?.description, raw?.project_name),
    buyer: firstString(raw?.borrower, raw?.implementing_agency), publishedAt: firstString(raw?.publication_date, raw?.noticedate), updatedAt: raw?.updated_date,
    deadline: firstString(raw?.submission_deadline_date, raw?.deadline_date, raw?.submission_date), status: firstString(raw?.notice_status, raw?.status, 'open'), noticeType: raw?.notice_type,
    moneyAmount: firstString(raw?.amount, raw?.estimated_value), currency: raw?.currency,
    categoryCodes: raw?.procurement_category || raw?.procurement_method_code,
    sectors: Array.isArray(raw?.sector) ? raw.sector.map((sector) => firstString(sector?.sector_code, sector?.sector_description)) : raw?.sector,
  });
}

export function normalizeGetsNotice(raw) {
  return normalize({
    source: 'gets', sourceNoticeId: raw?.id, officialUrl: raw?.link,
    countryCode: 'NZ', region: 'Oceania', title: raw?.title, description: raw?.description,
    buyer: raw?.buyer, publishedAt: raw?.publishedAt, updatedAt: raw?.updatedAt,
    deadline: raw?.deadline, status: 'open', noticeType: raw?.noticeType,
    categoryCodes: raw?.categories,
  });
}

export function dedupeTenders(tenders) {
  const byId = new Map();
  for (const tender of tenders.filter(Boolean)) {
    const previous = byId.get(tender.id);
    if (!previous || (tender.updatedAt || tender.publishedAt) > (previous.updatedAt || previous.publishedAt)) byId.set(tender.id, tender);
  }
  return [...byId.values()];
}

// This feed is intentionally for open opportunities. A portal record without a
// future closing date cannot be represented as an active solicitation safely,
// so it is omitted rather than presented as an open tender.
export function isOpenOpportunity(tender, now = Date.now()) {
  const deadline = Date.parse(tender?.deadline || '');
  if (!Number.isFinite(deadline) || deadline <= now) return false;
  return !/(award|cancel|closed|withdraw|expire|complete|draft)/.test(string(tender?.status).toLowerCase());
}

export function buildSnapshot({ results, sourceStatuses, fetchedAt = Date.now() }) {
  const successes = sourceStatuses.filter((source) => source.state === 'ok');
  const staleSources = sourceStatuses.filter((source) => source.state === 'stale');
  const degraded = sourceStatuses.filter((source) => source.state !== 'ok');
  const tenders = dedupeTenders(results);
  const dataAvailable = tenders.length > 0 || successes.length > 0;
  return {
    schemaVersion: 1,
    fetchedAt,
    dataAvailable,
    availability: successes.length === 0
      ? (staleSources.length > 0 && tenders.length > 0 ? 'stale' : 'unavailable')
      : degraded.length > 0 ? 'partial' : tenders.length === 0 ? 'empty' : 'available',
    tenders,
    sourceStatuses,
  };
}

export function mergeTenderSourceResults({ settled, sourceNames, previousSnapshot, attemptedAt = new Date().toISOString() }) {
  const previousTenders = Array.isArray(previousSnapshot?.tenders) ? previousSnapshot.tenders : [];
  const previousStatuses = new Map((previousSnapshot?.sourceStatuses || []).map((status) => [status.source, status]));
  const records = [];
  const sourceStatuses = [];

  for (let index = 0; index < settled.length; index += 1) {
    const source = sourceNames[index];
    const result = settled[index];
    if (result.status === 'fulfilled' && result.value?.status?.state === 'ok') {
      records.push(...result.value.records);
      sourceStatuses.push({
        ...result.value.status,
        fetchedAt: result.value.status.fetchedAt || attemptedAt,
        lastSuccessfulAt: result.value.status.lastSuccessfulAt || result.value.status.fetchedAt || attemptedAt,
        stale: false,
      });
      continue;
    }

    const attemptedAtMs = Date.parse(attemptedAt);
    const priorRecords = previousTenders.filter((tender) => tender.source === source && isOpenOpportunity(tender, attemptedAtMs));
    const priorStatus = previousStatuses.get(source);
    const fulfilledStatus = result.status === 'fulfilled' ? result.value?.status : null;
    const error = string(fulfilledStatus?.error || result.reason?.message || 'upstream request failed').slice(0, 200);
    if (priorRecords.length > 0) {
      const lastSuccessfulAt = firstString(priorStatus?.lastSuccessfulAt, priorStatus?.fetchedAt,
        isoTimestamp(previousSnapshot?.fetchedAt));
      records.push(...priorRecords);
      sourceStatuses.push({
        source, state: 'stale', recordCount: priorRecords.length, fetchedAt: attemptedAt,
        lastSuccessfulAt, stale: true, ...(error ? { error } : {}),
      });
    } else {
      sourceStatuses.push({
        source, state: fulfilledStatus?.state || 'error', recordCount: 0, fetchedAt: attemptedAt,
        lastSuccessfulAt: firstString(priorStatus?.lastSuccessfulAt, priorStatus?.fetchedAt), stale: false,
        ...(error ? { error } : {}),
      });
    }
  }

  const hasCurrentSuccess = sourceStatuses.some((status) => status.state === 'ok');
  const hasStaleData = sourceStatuses.some((status) => status.state === 'stale');
  const previousFetchedAt = typeof previousSnapshot?.fetchedAt === 'number'
    ? previousSnapshot.fetchedAt
    : Date.parse(previousSnapshot?.fetchedAt || '');
  const fetchedAt = !hasCurrentSuccess && hasStaleData && Number.isFinite(previousFetchedAt)
    ? previousFetchedAt
    : Date.parse(attemptedAt);
  return buildSnapshot({ results: records, sourceStatuses, fetchedAt });
}
