/**
 * Canonical climate-producer zone to Tier-1 CII-country attribution map.
 *
 * The server uses this map when it turns climate anomalies into score inputs;
 * the browser uses it only for country-detail signal context. An edit that
 * changes server/API scores must bump CII_FORMULA_VERSION and update the CII
 * methodology document and public changelog in the same change. The
 * version-keyed CII protocol snapshot tests this map directly.
 */
export const CII_CLIMATE_ZONE_COUNTRIES: Record<string, string[]> = {
  'North America': ['US'],
  'Ukraine': ['UA'],
  'Europe': ['DE', 'FR', 'GB', 'PL', 'TR', 'UA'],
  'East Asia': ['CN', 'TW', 'KP', 'KR', 'JP'],
  'Middle East': ['IR', 'IL', 'SA', 'SY', 'YE', 'AE', 'IQ', 'LB', 'QA'],
  'South Asia': ['IN', 'PK', 'MM', 'AF'],
  'Russia': ['RU'],
  'Myanmar': ['MM'],
  'California': ['US'],
  'Amazon': ['BR'],
  'Latin America': ['VE', 'CU', 'MX', 'BR'],
  'North Africa': ['EG'],
  'Taiwan Strait': ['TW', 'CN'],
  'Caribbean': ['CU', 'MX'],
  'Mediterranean': ['TR', 'IL', 'SY', 'LB', 'EG'],
  'Arctic': ['RU'],
  'Tibetan Plateau': ['CN', 'IN'],
};
