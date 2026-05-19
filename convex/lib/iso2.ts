/**
 * Canonical ISO 3166-1 alpha-2 registry — server-side validator for the
 * `followedCountries` watchlist primitive (plan U13).
 *
 * The set MUST stay in lockstep with the keys of `ISO2_TO_ISO3` in
 * `src/utils/country-codes.ts` (the client-side source of truth). Drift
 * is caught by the test
 * `convex/__tests__/followed-countries-mutations.test.ts::iso2 registry
 * parity` (U13). When adding/removing a country, update BOTH files.
 *
 * `isValidIso2` enforces:
 *   - exactly two uppercase ASCII letters (regex `^[A-Z]{2}$`)
 *   - membership in the canonical alpha-2 set
 *
 * This rejects regex-passing-but-non-ISO-2 codes like `XX`, `ZZ`, `EN`, `UK`
 * (the correct code for the United Kingdom is `GB`).
 */

const ISO2_REGISTRY: ReadonlySet<string> = new Set([
  "AD", "AE", "AF", "AG", "AI", "AL", "AM", "AO", "AQ", "AR", "AS", "AT",
  "AU", "AW", "AX", "AZ", "BA", "BB", "BD", "BE", "BF", "BG", "BH", "BI",
  "BJ", "BL", "BM", "BN", "BO", "BR", "BS", "BT", "BW", "BY", "BZ", "CA",
  "CD", "CF", "CG", "CH", "CI", "CK", "CL", "CM", "CN", "CO", "CR", "CU",
  "CV", "CW", "CY", "CZ", "DE", "DJ", "DK", "DM", "DO", "DZ", "EC", "EE",
  "EG", "EH", "ER", "ES", "ET", "FI", "FJ", "FK", "FM", "FO", "FR", "GA",
  "GB", "GD", "GE", "GG", "GH", "GI", "GL", "GM", "GN", "GQ", "GR", "GS",
  "GT", "GU", "GW", "GY", "HK", "HM", "HN", "HR", "HT", "HU", "ID", "IE",
  "IL", "IM", "IN", "IO", "IQ", "IR", "IS", "IT", "JE", "JM", "JO", "JP",
  "KE", "KG", "KH", "KI", "KM", "KN", "KP", "KR", "KW", "KY", "KZ", "LA",
  "LB", "LC", "LI", "LK", "LR", "LS", "LT", "LU", "LV", "LY", "MA", "MC",
  "MD", "ME", "MF", "MG", "MH", "MK", "ML", "MM", "MN", "MO", "MP", "MR",
  "MS", "MT", "MU", "MV", "MW", "MX", "MY", "MZ", "NA", "NC", "NE", "NF",
  "NG", "NI", "NL", "NO", "NP", "NR", "NU", "NZ", "OM", "PA", "PE", "PF",
  "PG", "PH", "PK", "PL", "PM", "PN", "PR", "PS", "PT", "PW", "PY", "QA",
  "RO", "RS", "RU", "RW", "SA", "SB", "SC", "SD", "SE", "SG", "SH", "SI",
  "SK", "SL", "SM", "SN", "SO", "SR", "SS", "ST", "SV", "SX", "SY", "SZ",
  "TC", "TD", "TF", "TG", "TH", "TJ", "TL", "TM", "TN", "TO", "TR", "TT",
  "TV", "TW", "TZ", "UA", "UG", "UM", "US", "UY", "UZ", "VA", "VC", "VE",
  "VG", "VI", "VN", "VU", "WF", "WS", "XK", "YE", "ZA", "ZM", "ZW",
]);

const ISO2_REGEX = /^[A-Z]{2}$/;

export function isValidIso2(code: string): boolean {
  if (typeof code !== "string") return false;
  if (!ISO2_REGEX.test(code)) return false;
  return ISO2_REGISTRY.has(code);
}

/**
 * Internal-only export for the `iso2 registry parity` test in U13. NOT for
 * runtime use; mutations should call `isValidIso2` instead.
 */
export const _ISO2_REGISTRY_FOR_TESTS: ReadonlySet<string> = ISO2_REGISTRY;
