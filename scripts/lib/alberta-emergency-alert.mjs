/**
 * Alberta Emergency Alert Atom adapter (#6610).
 *
 * NAAD-avoidance path: public Atom at www.alberta.ca, not Pelmorex LMD.
 * Tests import this module — do not import the seeder from tests.
 */

import { decodeHtmlEntities } from '../_html-entities.mjs';

export const AEA_HOST = 'www.alberta.ca';
export const AEA_ATOM_URL = 'https://www.alberta.ca/data/aea/rss/feed-full.atom';
export const AEA_SOURCE = 'alberta-aea';
export const AEA_PROVINCE = 'AB';
/** Geographic centre of Alberta as [lon, lat] (55°N 115°W is the usual citation). */
export const ALBERTA_CENTROID = Object.freeze([-115, 55]);
export const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 15_000;
export const MAX_ALERTS = 100;
export const AEA_MAX_CONTENT_AGE_MIN = 3 * 24 * 60;

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

const CAP_SEVERITY = Object.freeze({
  extreme: 'Extreme',
  severe: 'Severe',
  moderate: 'Moderate',
  minor: 'Minor',
});

const SEVERITY_RANK = Object.freeze({ Extreme: 0, Severe: 1, Moderate: 2, Minor: 3 });

export function isAllowedAeaHost(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      && parsed.hostname.toLowerCase() === AEA_HOST
      && (parsed.port === '' || parsed.port === '443')
      && parsed.username === ''
      && parsed.password === '';
  } catch {
    return false;
  }
}

function extractTag(block, tagName) {
  const re = new RegExp(`<${tagName}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tagName}>`, 'i');
  return (block.match(re) || [])[1]?.trim() || '';
}

function extractAllTags(block, tagName) {
  const re = new RegExp(`<${tagName}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tagName}>`, 'gi');
  const out = [];
  let match;
  while ((match = re.exec(block)) !== null) out.push(match[1].trim());
  return out;
}

function extractLink(block) {
  const direct = extractTag(block, 'link');
  if (direct) return decodeHtmlEntities(direct).trim();
  const href = (block.match(/<link[^>]*\bhref=(["'])(.*?)\1[^>]*\/?>/i) || [])[2] || '';
  return decodeHtmlEntities(href).trim();
}

function extractCategory(block) {
  const tagged = extractTag(block, 'category') || extractTag(block, 'cap:category');
  if (tagged) return decodeHtmlEntities(tagged).trim();
  const term = (block.match(/<category[^>]*\bterm=(["'])(.*?)\1[^>]*\/?>/i) || [])[2] || '';
  return decodeHtmlEntities(term).trim();
}

function cleanText(raw) {
  return decodeHtmlEntities(raw).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function parseDateMs(...raws) {
  for (const raw of raws) {
    if (!raw || typeof raw !== 'string') continue;
    const ms = Date.parse(raw);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  return null;
}

/**
 * Map feed severity. Prefer cap:severity, then category, then cap:urgency,
 * then Alberta colour/level tokens in title/summary. Fail closed (null) when
 * none of those are present — never invent Unknown.
 */
export function mapAlertSeverity({ capSeverity, capUrgency, category, title, summary } = {}) {
  const cap = String(capSeverity || '').trim().toLowerCase();
  if (CAP_SEVERITY[cap]) return CAP_SEVERITY[cap];

  const categoryText = String(category || '').trim().toLowerCase();
  if (CAP_SEVERITY[categoryText]) return CAP_SEVERITY[categoryText];
  if (/\b(red|critical)\b/.test(categoryText)) return 'Extreme';
  if (/\b(orange|warning)\b/.test(categoryText)) return 'Severe';
  if (/\b(yellow|advisory|watch)\b/.test(categoryText)) return 'Moderate';
  if (/\b(blue|green|information|info)\b/.test(categoryText)) return 'Minor';

  const urgency = String(capUrgency || '').trim().toLowerCase();
  if (urgency === 'immediate') return 'Extreme';
  if (urgency === 'expected') return 'Severe';
  if (urgency === 'future') return 'Moderate';

  const blob = `${title || ''} ${summary || ''}`.toLowerCase();
  if (/\btest\b/.test(blob) && !/\b(red|critical|orange|yellow|advisory|watch)\b/.test(blob)) {
    return null;
  }
  if (/\b(red|critical)\b/.test(blob)) return 'Extreme';
  if (/\b(orange)\b/.test(blob)) return 'Severe';
  if (/\b(yellow|advisory|watch)\b/.test(blob)) return 'Moderate';
  if (/\b(blue|green|information)\b/.test(blob)) return 'Minor';
  return null;
}

const ENDED_TOKEN_RE = /\b(ended|cancelled|canceled|all\s*clear|allclear)\b/i;

/**
 * Drop ended / cancelled / AllClear alerts. Title tokens catch the live
 * "yellow watch - tornado - ended" Atom; CAP enclosure fields catch the
 * official AllClear / Past / Cancel even when the title still says yellow.
 */
export function isEndedOrAllClear({ title, summary, capResponseType, capUrgency, capMsgType } = {}) {
  const blob = `${title || ''} ${summary || ''}`;
  if (ENDED_TOKEN_RE.test(blob)) return true;
  const response = String(capResponseType || '').trim().toLowerCase().replace(/[\s_-]/g, '');
  if (response === 'allclear') return true;
  const urgency = String(capUrgency || '').trim().toLowerCase();
  if (urgency === 'past') return true;
  const msgType = String(capMsgType || '').trim().toLowerCase();
  if (msgType === 'cancel') return true;
  return false;
}

export function parseCapStatus(xml) {
  if (typeof xml !== 'string' || !xml) return {};
  return {
    capIsAlert: /<(?:[A-Za-z_][\w.-]*:)?alert\b[^>]*>/i.test(xml),
    capStatus: extractTag(xml, 'status') || extractTag(xml, 'cap:status'),
    capScope: extractTag(xml, 'scope') || extractTag(xml, 'cap:scope'),
    capExpires: extractTag(xml, 'expires') || extractTag(xml, 'cap:expires'),
    capResponseType: extractTag(xml, 'responseType') || extractTag(xml, 'cap:responseType'),
    capUrgency: extractTag(xml, 'urgency') || extractTag(xml, 'cap:urgency'),
    capMsgType: extractTag(xml, 'msgType') || extractTag(xml, 'cap:msgType'),
    capSeverity: extractTag(xml, 'severity') || extractTag(xml, 'cap:severity'),
  };
}

const CAP_STATUS_VALUES = new Set(['actual', 'exercise', 'system', 'test', 'draft']);
const CAP_MSG_TYPE_VALUES = new Set(['alert', 'update', 'cancel', 'ack', 'error']);
const CAP_SCOPE_VALUES = new Set(['public', 'restricted', 'private']);

function classifyCapLifecycle(cap, nowMs) {
  if (!cap?.capIsAlert) return 'invalid';
  if (isEndedOrAllClear(cap)) return 'inactive';
  const status = String(cap.capStatus || '').trim().toLowerCase();
  const msgType = String(cap.capMsgType || '').trim().toLowerCase();
  const scope = String(cap.capScope || '').trim().toLowerCase();
  const expiresMs = parseDateMs(cap.capExpires);
  if (!CAP_STATUS_VALUES.has(status)
    || !CAP_MSG_TYPE_VALUES.has(msgType)
    || !CAP_SCOPE_VALUES.has(scope)
    || expiresMs == null) {
    return 'invalid';
  }
  if (expiresMs <= nowMs) return 'inactive';
  if (status !== 'actual' || !['alert', 'update'].includes(msgType) || scope !== 'public') {
    return 'inactive';
  }
  return 'active';
}

export function isPublishableCapAlert(cap, nowMs = Date.now()) {
  return classifyCapLifecycle(cap, nowMs) === 'active';
}

function extractEnclosureUrl(block) {
  const hrefFirst = (block.match(/<link[^>]*\bhref=(["'])(.*?)\1[^>]*\brel=(["'])enclosure\3/i) || [])[2] || '';
  if (hrefFirst) return decodeHtmlEntities(hrefFirst).trim();
  const relFirst = (block.match(/<link[^>]*\brel=(["'])enclosure\1[^>]*\bhref=(["'])(.*?)\2/i) || [])[3] || '';
  return decodeHtmlEntities(relFirst).trim();
}

/** GeoRSS polygon/point pairs are lat lon (CAP/GeoRSS), returned as [lon, lat]. */
export function parseGeorssCoordinates(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const nums = raw.trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
  const out = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const lat = nums[i];
    const lon = nums[i + 1];
    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) out.push([lon, lat]);
  }
  return out;
}

export function calculateCentroid(coords) {
  if (!Array.isArray(coords) || coords.length === 0) return null;
  const sum = coords.reduce((acc, [lon, lat]) => [acc[0] + lon, acc[1] + lat], [0, 0]);
  return [sum[0] / coords.length, sum[1] / coords.length];
}

function extractCoordinates(block) {
  const coords = [];
  for (const poly of extractAllTags(block, 'georss:polygon')) {
    coords.push(...parseGeorssCoordinates(poly));
  }
  for (const point of extractAllTags(block, 'georss:point')) {
    coords.push(...parseGeorssCoordinates(point));
  }
  return coords;
}

function eventFromTitle(title) {
  const cleaned = String(title || '').replace(/\s+/g, ' ').trim();
  const stripped = cleaned
    .replace(/^(?:red|orange|yellow|blue|green|critical|advisory|watch|warning|information|info|test)\b[\s:-]*/i, '')
    .replace(/\s*-\s*in effect\s*$/i, '')
    .replace(/^[-:\s]+/, '')
    .trim();
  return stripped || cleaned;
}

export function normalizeAeaEntry(block) {
  const title = cleanText(extractTag(block, 'title'));
  const summary = cleanText(extractTag(block, 'summary') || extractTag(block, 'content'));
  const capSeverity = extractTag(block, 'cap:severity');
  const capUrgency = extractTag(block, 'cap:urgency');
  const capResponseType = extractTag(block, 'cap:responseType') || extractTag(block, 'responseType');
  const capMsgType = extractTag(block, 'cap:msgType') || extractTag(block, 'msgType');
  if (isEndedOrAllClear({ title, summary, capResponseType, capUrgency, capMsgType })) {
    return null;
  }
  const category = extractCategory(block);
  const severity = mapAlertSeverity({
    capSeverity,
    capUrgency,
    category,
    title,
    summary,
  });
  if (!severity) return null;

  const updatedRaw = extractTag(block, 'updated');
  const publishedRaw = extractTag(block, 'published');
  const sentRaw = extractTag(block, 'cap:sent');
  const expiresRaw = extractTag(block, 'cap:expires');
  const updatedAt = parseDateMs(updatedRaw, publishedRaw, sentRaw);
  const publishedAt = parseDateMs(publishedRaw, updatedRaw, sentRaw);
  const coords = extractCoordinates(block);
  const centroid = calculateCentroid(coords) || [...ALBERTA_CENTROID];
  const id = extractTag(block, 'cap:identifier') || extractTag(block, 'id') || title;
  const areaMatch = summary.match(/Area:\s*\(([\s\S]*?)\)\s*$/) || summary.match(/Area:\s*([\s\S]+)$/);
  const areaDesc = areaMatch ? areaMatch[1].replace(/\s+/g, ' ').trim() : '';

  return {
    id,
    province: AEA_PROVINCE,
    severity,
    event: eventFromTitle(title),
    headline: title,
    description: summary.slice(0, 800),
    areaDesc,
    onset: updatedRaw || publishedRaw || sentRaw || '',
    expires: expiresRaw || '',
    updatedAt,
    publishedAt,
    lat: centroid[1],
    lon: centroid[0],
    centroid,
    coordinates: coords.slice(0, 64),
    url: extractLink(block),
    capUrl: extractEnclosureUrl(block),
    source: AEA_SOURCE,
  };
}

export function parseAlbertaEmergencyAlertAtom(xml) {
  if (typeof xml !== 'string') {
    throw new Error('alberta-aea: body is not parseable Atom');
  }
  const bounded = xml.length > MAX_PAYLOAD_BYTES ? xml.slice(0, MAX_PAYLOAD_BYTES) : xml;
  if (!/<feed[\s>]/i.test(bounded) && !/<entry[\s>]/i.test(bounded)) {
    throw new Error('alberta-aea: body is not parseable Atom');
  }
  const records = [];
  const seen = new Set();
  const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  let match;
  while ((match = entryRe.exec(bounded)) !== null) {
    const record = normalizeAeaEntry(match[1]);
    if (!record) continue;
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    records.push(record);
    if (records.length >= MAX_ALERTS) break;
  }
  records.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9));
  return records;
}

export function declareAlbertaAeaRecords(data) {
  return Array.isArray(data?.alerts) ? data.alerts.length : 0;
}

export function validateAlbertaAeaEnvelope(data) {
  return data != null && typeof data === 'object' && Array.isArray(data.alerts);
}

export function albertaAeaPublishTransform(data) {
  return { alerts: Array.isArray(data?.alerts) ? data.alerts : [] };
}

export function albertaAeaAfterPublish(data) {
  const failed = Math.min(100, Math.max(0, Number(data?._capVerification?.failed) || 0));
  if (failed > 0) {
    return {
      freshnessMetaPatch: {
        sourceState: 'degraded',
        errorCode: 'CAP_VERIFICATION_FAILED',
        capVerificationFailed: failed,
      },
    };
  }
  return { freshnessMetaPatch: { sourceState: 'ok' } };
}

export function albertaAeaContentMeta(data, nowMs = Date.now()) {
  const alerts = Array.isArray(data?.alerts) ? data.alerts : [];
  let newest = -Infinity;
  let oldest = Infinity;
  let validCount = 0;
  const skewLimit = nowMs + 60 * 60 * 1000;
  for (const alert of alerts) {
    const ts = alert.updatedAt ?? alert.publishedAt;
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) continue;
    if (ts > skewLimit) continue;
    validCount += 1;
    if (ts > newest) newest = ts;
    if (ts < oldest) oldest = ts;
  }
  if (validCount === 0) return null;
  return { newestItemAt: newest, oldestItemAt: oldest };
}

async function readLimitedText(resp, maxBytes) {
  const contentLength = resp.headers?.get?.('content-length');
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error(`alberta-aea: payload exceeds ${maxBytes} bytes`);
  }
  const buffer = Buffer.from(await resp.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new Error(`alberta-aea: payload exceeds ${maxBytes} bytes`);
  }
  return buffer.toString('utf8');
}

/**
 * Fetch and normalise the Alberta Emergency Alert Atom feed.
 *
 * @param {{
 *   fetchFn?: typeof fetch,
 *   userAgent?: string,
 *   timeoutMs?: number,
 *   maxBytes?: number,
 *   url?: string,
 *   nowMs?: number,
 * }} [opts]
 */
export async function fetchAlbertaEmergencyAlerts(opts = {}) {
  const url = opts.url || AEA_ATOM_URL;
  if (!isAllowedAeaHost(url)) {
    throw new Error(`alberta-aea: host is not on the allowlist (${AEA_HOST})`);
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_PAYLOAD_BYTES;
  const userAgent = opts.userAgent || CHROME_UA;
  const fetchFn = opts.fetchFn ?? globalThis.fetch;

  const resp = await fetchFn(url, {
    headers: {
      Accept: 'application/atom+xml, application/xml, text/xml, */*',
      'User-Agent': userAgent,
    },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  });
  if (!resp.ok) {
    throw new Error(`alberta-aea: HTTP ${resp.status}`);
  }
  const xml = await readLimitedText(resp, maxBytes);
  const alerts = parseAlbertaEmergencyAlertAtom(xml);
  const filtered = await applyCapEnclosureFilter(alerts, {
    fetchFn,
    userAgent,
    timeoutMs,
    maxBytes,
    nowMs: opts.nowMs ?? Date.now(),
  });
  return filtered;
}

async function applyCapEnclosureFilter(alerts, { fetchFn, userAgent, timeoutMs, maxBytes, nowMs }) {
  const out = [];
  const verification = { attempted: 0, failed: 0, inactive: 0 };
  for (const alert of alerts) {
    if (isEndedOrAllClear(alert)) continue;
    const capUrl = alert.capUrl;
    if (!capUrl) {
      out.push(alert);
      continue;
    }
    verification.attempted += 1;
    if (!isAllowedAeaHost(capUrl)) {
      verification.failed += 1;
      continue;
    }
    try {
      const resp = await fetchFn(capUrl, {
        headers: {
          Accept: 'application/common-alerting-protocol+xml, application/xml, text/xml, */*',
          'User-Agent': userAgent,
        },
        signal: AbortSignal.timeout(Math.min(timeoutMs, 8_000)),
        redirect: 'error',
      });
      if (!resp.ok) {
        verification.failed += 1;
        continue;
      }
      const capXml = await readLimitedText(resp, maxBytes);
      const cap = parseCapStatus(capXml);
      const lifecycle = classifyCapLifecycle(cap, nowMs);
      if (lifecycle === 'invalid') {
        verification.failed += 1;
        continue;
      }
      if (lifecycle === 'inactive') {
        verification.inactive += 1;
        continue;
      }
      out.push(alert);
    } catch {
      verification.failed += 1;
    }
  }
  return { alerts: out, _capVerification: verification };
}

export { CHROME_UA };
