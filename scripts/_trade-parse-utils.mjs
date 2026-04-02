/**
 * Pure parse helpers for trade-data seed scripts.
 * Extracted so test files can import directly without new Function() hacks.
 */

export const BUDGET_LAB_TARIFFS_URL = 'https://budgetlab.yale.edu/research/tracking-economic-effects-tariffs';

const MONTH_MAP = {
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12',
};

export function htmlToPlainText(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s[^<>]*?)?>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, '\'')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Convert a human-readable date string like "March 2, 2026" to ISO "2026-03-02".
 * Falls back to '' on failure.
 */
export function toIsoDate(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const m = text.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
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

  const updatedAt = toIsoDate(text.match(/\bUpdated:\s*([A-Za-z]+\s+\d{1,2},\s+\d{4})/i)?.[1] ?? '');
  const patterns = [
    /effective tariff rate reaching\s+(\d+(?:\.\d+)?)%\s+in\s+([A-Za-z]+\s+\d{4})/i,
    /average effective (?:u\.s\.\s*)?tariff rate[^.]{0,180}?\bto\s+(\d+(?:\.\d+)?)%[^.]{0,180}?\b(?:in|by)\s+([A-Za-z]+\s+\d{4})/i,
    /average effective (?:u\.s\.\s*)?tariff rate[^.]{0,180}?\bto\s+(\d+(?:\.\d+)?)%/i,
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
