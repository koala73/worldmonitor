

const NORMALIZE_COUNTRY_TOKEN_RE = /\p{Diacritic}/gu;
const NORMALIZE_COUNTRY_TOKEN_RE_2 = /&/g;
const NORMALIZE_COUNTRY_TOKEN_RE_3 = /[''.(),/-]/g;
const WHITESPACE_RE = /\s+/g;
export function normalizeCountryToken(value: unknown): string {
  return String(value || '')
    .normalize('NFKD')
    .replace(NORMALIZE_COUNTRY_TOKEN_RE, '')
    .toLowerCase()
    .replace(NORMALIZE_COUNTRY_TOKEN_RE_2, ' and ')
    .replace(NORMALIZE_COUNTRY_TOKEN_RE_3, ' ')
    .replace(WHITESPACE_RE, ' ')
    .trim();
}
