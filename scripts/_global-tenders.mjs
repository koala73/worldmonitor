const TECHNOLOGY_TERMS = [
  ['artificial intelligence', 'AI'], ['machine learning', 'machine learning'], ['cybersecurity', 'cybersecurity'],
  ['cyber security', 'cybersecurity'], ['software', 'software'], ['data platform', 'data platform'],
  ['data management', 'data management'], ['automation', 'automation'], ['cloud', 'cloud'], ['digital', 'digital'],
];

export const GLOBAL_TENDER_KEY = 'economic:global-tenders:v1';
export const GLOBAL_TENDER_META_KEY = 'seed-meta:economic:global-tenders';

function string(value) { return typeof value === 'string' ? value.trim() : ''; }
function firstString(...values) { return values.map(string).find(Boolean) || ''; }
function array(value) { return Array.isArray(value) ? value.map(string).filter(Boolean) : string(value) ? [string(value)] : []; }
function date(value) { const raw = string(value); return raw && Number.isFinite(Date.parse(raw)) ? new Date(raw).toISOString() : ''; }
function number(value) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function safeOfficialUrl(value) {
  try {
    const url = new URL(string(value));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : '';
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
  if (!id || !string(title) || !safeOfficialUrl(officialUrl)) return null;
  const normalizedCategories = array(categoryCodes);
  const normalizedSectors = array(sectors);
  const amount = number(moneyAmount);
  const normalizedCurrency = string(currency).toUpperCase();
  return {
    id: `${source}:${id}`,
    source,
    sourceNoticeId: id,
    officialUrl: safeOfficialUrl(officialUrl),
    countryCode: string(countryCode).toUpperCase(),
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
    countryCode: firstString(raw?.['organisation-country-buyer'], raw?.['country'], raw?.countryCode), region: 'Europe',
    title: firstString(raw?.['title-lot'], raw?.['notice-title'], raw?.title), description: firstString(raw?.['notice-description'], raw?.description),
    buyer: firstString(raw?.['organisation-name-buyer'], raw?.['buyer-name'], raw?.buyer), publishedAt: firstString(raw?.['publication-date'], raw?.publicationDate),
    updatedAt: firstString(raw?.['last-modification-date'], raw?.updatedAt), deadline: firstString(raw?.['deadline-receipt-tender-date-lot'], raw?.['deadline-date'], raw?.deadline),
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

export function normalizeWorldBankNotice(raw) {
  const id = firstString(raw?.id, raw?.notice_id);
  return normalize({
    source: 'world-bank', sourceNoticeId: id,
    officialUrl: firstString(raw?.url, raw?.notice_url, id && `https://projects.worldbank.org/en/projects-operations/procurement/notices/notice-detail/${encodeURIComponent(id)}`),
    countryCode: firstString(raw?.country_code, raw?.countrycode), region: firstString(raw?.region, 'Multilateral'),
    title: firstString(raw?.bid_description, raw?.title, raw?.project_name), description: firstString(raw?.description, raw?.project_name),
    buyer: firstString(raw?.borrower), publishedAt: firstString(raw?.publication_date, raw?.noticedate), updatedAt: raw?.updated_date,
    deadline: firstString(raw?.deadline_date, raw?.submission_date), status: firstString(raw?.notice_status, raw?.status, 'open'), noticeType: raw?.notice_type,
    moneyAmount: firstString(raw?.amount, raw?.estimated_value), currency: raw?.currency,
    categoryCodes: raw?.procurement_category || raw?.procurement_method_code,
    sectors: Array.isArray(raw?.sector) ? raw.sector.map((sector) => firstString(sector?.sector_code, sector?.sector_description)) : raw?.sector,
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
  const degraded = sourceStatuses.filter((source) => source.state !== 'ok');
  const tenders = dedupeTenders(results);
  return {
    schemaVersion: 1,
    fetchedAt,
    dataAvailable: successes.length > 0,
    availability: successes.length === 0 ? 'unavailable' : degraded.length > 0 ? 'partial' : tenders.length === 0 ? 'empty' : 'available',
    tenders,
    sourceStatuses,
  };
}
