/**
 * Pure parse helpers for trade-data seed scripts.
 * Extracted so test files can import directly without new Function() hacks.
 */

import { decodeHtmlEntities } from './_html-entities.mjs';

const STRIPPED_RE = /<script\b[^>]*>[\s\S]*?<\/script(?:[\t\n\f\r ][^>]*|\/[^>]*)?>/gi;
const STRIPPED_RE_2 = /<style\b[^>]*>[\s\S]*?<\/style(?:[\t\n\f\r ][^>]*|\/[^>]*)?>/gi;
const STRIPPED_RE_3 = /<!--[\s\S]*?-->/g;
const STRIPPED_RE_4 = /<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s[^<>]*?)?>/g;
const WHITESPACE_RE = /\s+/g;
const TO_ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;
const TO_ISO_DATE_RE_2 = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/;
const UPDATED_AT_RE = /\bUpdated:\s*([A-Za-z]+\s+\d{1,2},\s+\d{4})/i;
const PATTERNS_RE = /effective tariff rate (?:stood at|was|is)\s+(\d+(?:\.\d+)?)%/i;
const PATTERNS_RE_2 = /effective tariff rate reaching\s+(\d+(?:\.\d+)?)%\s+in\s+([A-Za-z]+\s+\d{4})/i;
const PATTERNS_RE_3 = /average effective (?:u\.s\.\s*)?tariff rate[^.]{0,180}?\bto\s+(\d+(?:\.\d+)?)%[^.]{0,180}?\b(?:in|by)\s+([A-Za-z]+\s+\d{4})/i;
const PATTERNS_RE_4 = /average effective (?:u\.s\.\s*)?tariff rate[^.]{0,180}?\bto\s+(\d+(?:\.\d+)?)%/i;


export const BUDGET_LAB_TARIFFS_URL = 'https://budgetlab.yale.edu/research/tracking-economic-effects-tariffs';

const MONTH_MAP = {
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12',
};

export function htmlToPlainText(html) {
  const stripped = String(html ?? '')
    .replace(STRIPPED_RE, ' ')
    .replace(STRIPPED_RE_2, ' ')
    .replace(STRIPPED_RE_3, ' ')
    .replace(STRIPPED_RE_4, ' ');
  // Single-pass decode: chained &amp;-first replaces would decode two levels
  // (e.g. `&amp;quot;` -> `"`), and out-of-range numeric refs must not throw.
  return decodeHtmlEntities(stripped)
    .replace(WHITESPACE_RE, ' ')
    .trim();
}

/**
 * Convert a human-readable date string like "March 2, 2026" to ISO "2026-03-02".
 * Falls back to '' on failure.
 */
export function toIsoDate(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (TO_ISO_DATE_RE.test(text)) return text.slice(0, 10);
  const m = text.match(TO_ISO_DATE_RE_2);
  if (m) {
    const mm = MONTH_MAP[m[1].toLowerCase()];
    if (mm) return `${m[3]}-${mm}-${m[2].padStart(2, '0')}`;
  }
  return '';
}

/**
 * Parse the Yale Budget Lab tariff-tracking page and extract effective tariff rate.
 *
 * Tries three patterns in priority order:
 *  1. "effective tariff rate reaching X% in [month year]"
 *  2. "average effective [U.S.] tariff rate ... to X% ... in/by [month year]"
 *  3. Same as 2 but no period capture
 *
 * Returns null when no recognisable rate is found.
 */
export function parseBudgetLabEffectiveTariffHtml(html) {
  const text = htmlToPlainText(html);
  if (!text) return null;

  const updatedAt = toIsoDate(text.match(UPDATED_AT_RE)?.[1] ?? '');
  const patterns = [
    PATTERNS_RE,
    PATTERNS_RE_2,
    PATTERNS_RE_3,
    PATTERNS_RE_4,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const tariffRate = parseFloat(match[1]);
    if (!Number.isFinite(tariffRate)) continue;
    return {
      sourceName: 'Yale Budget Lab',
      sourceUrl: BUDGET_LAB_TARIFFS_URL,
      observationPeriod: match[2] ?? '',
      updatedAt,
      tariffRate: Math.round(tariffRate * 100) / 100,
    };
  }

  return null;
}
