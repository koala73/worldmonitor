// Production-shaped fixtures for the `financialSystemExposure` calibration
// gates (issue #6459 Phase A).
//
// Every component value below is a VERBATIM reading of the three production
// seed envelopes on 2026-08-11, pulled read-only from Upstash:
//   economic:wb-external-debt:v1  (119 countries)
//   economic:bis-lbs:v1           (200 countries)
//   economic:fatf-listing:v1      (FATF plenary publication 2026-06-01)
//
// The `nonDrsCountryCodes` cohort is pinned from the World Bank country
// catalog's lendingType=LNX classification. The values are pinned, not
// live-fetched, so the calibration gates are deterministic and run in CI
// without credentials. It includes every LNX country used by this fixture and
// stays above the producer contract's 40-country fail-closed floor.
//
// WHY REAL VALUES MATTER HERE: the failure this file exists to prevent is a
// construct that ranks financially severed states ABOVE financially deep
// ones. A hand-invented fixture can be tuned — accidentally or not — until
// the gate passes on numbers no country actually produces. Pinning the
// production readings means the gate is evaluated on the same inputs the
// live scorer sees, so a green gate is evidence about production and not
// about the fixture.
//
// Note the absences, which are load-bearing:
//   - KP / CU have NO WB IDS row and NO BIS CBS row (FATF-only countries).
//   - MC has a FATF gray listing but NO BIS row in production — the
//     coverage-0.2 shape called out as a landmine on the issue.
//   - LU / SG / CH / US / DE / LY / VE have no WB IDS row because the
//     Debtor Reporting System only covers World Bank borrowers.

import type { ResilienceSeedReader } from '../../server/worldmonitor/resilience/v1/_dimension-scorers.ts';

export const FINSYS_FIXTURE_CAPTURED_AT = '2026-08-11';

export interface FinSysDebtEntry {
  value: number;
  year: number;
}

export interface FinSysBisEntry {
  totalXborderPctGdp: number;
  parentCount: number;
}

/** `economic:wb-external-debt:v1` — short-term external debt as % of GNI. */
export const FINSYS_DEBT_FIXTURE: Readonly<Record<string, FinSysDebtEntry>> = {
  RU: { value: 2.58, year: 2022 },
  IR: { value: 0.63, year: 2024 },
  BY: { value: 10.76, year: 2024 },
  MM: { value: 0.08, year: 2024 },
  SY: { value: 2.69, year: 2022 },
  TD: { value: 0.14, year: 2024 },
  MU: { value: 62.83, year: 2024 },
  // KP, CU, VE, LY, LU, SG, CH, US, MC, DE: no DRS row in production.
};

/** World Bank country-catalog records classified as lendingType=LNX. */
export const FINSYS_NON_DRS_COUNTRY_CODES: ReadonlyArray<string> = [
  'AD', 'AE', 'AT', 'AU', 'BE', 'BH', 'BN', 'BS', 'CA', 'CH', 'CU', 'CY',
  'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GB', 'GR', 'HK', 'HU', 'IE',
  'IL', 'IS', 'IT', 'JP', 'KP', 'KR', 'KW', 'LI', 'LT', 'LU', 'LV', 'MC',
  'MO', 'MT', 'NL', 'NO', 'NZ', 'OM', 'PT', 'QA', 'SA', 'SE', 'SG', 'SI',
  'SK', 'SM', 'US',
];

/** `economic:bis-lbs:v1` — BIS CBS by-parent claims and reporter count. */
export const FINSYS_BIS_FIXTURE: Readonly<Record<string, FinSysBisEntry>> = {
  RU: { totalXborderPctGdp: 1.45, parentCount: 0 },
  IR: { totalXborderPctGdp: 0.01, parentCount: 0 },
  VE: { totalXborderPctGdp: 3.64, parentCount: 2 },
  BY: { totalXborderPctGdp: 0.14, parentCount: 0 },
  LY: { totalXborderPctGdp: 0.3, parentCount: 0 },
  MM: { totalXborderPctGdp: 1.12, parentCount: 1 },
  LU: { totalXborderPctGdp: 1041.64, parentCount: 14 },
  SG: { totalXborderPctGdp: 122, parentCount: 11 },
  CH: { totalXborderPctGdp: 43.67, parentCount: 9 },
  US: { totalXborderPctGdp: 31.62, parentCount: 8 },
  DE: { totalXborderPctGdp: 34.94, parentCount: 9 },
  TD: { totalXborderPctGdp: 1.11, parentCount: 0 },
  MU: { totalXborderPctGdp: 69.33, parentCount: 5 },
  // KP, CU, SY, MC: no BIS CBS counterparty row in production.
};

/**
 * `economic:fatf-listing:v1` — the complete production listings dict, not a
 * subset. `readFatfStatus` treats an EMPTY dict as a parser regression and
 * drops the slot, so a trimmed fixture would change which code path runs.
 * Carrying all 25 entries also keeps compliant-by-absence honest: RU, BY,
 * CU and LY really are absent from both FATF lists.
 */
export const FINSYS_FATF_FIXTURE: Readonly<{
  listings: Readonly<Record<string, 'black' | 'gray' | 'compliant'>>;
  publicationDate: string;
}> = {
  listings: {
    KP: 'black', IR: 'black', MM: 'black',
    AO: 'gray', BO: 'gray', BA: 'gray', BG: 'gray', CM: 'gray', CI: 'gray',
    CD: 'gray', HT: 'gray', IQ: 'gray', KE: 'gray', KW: 'gray', LA: 'gray',
    LB: 'gray', MC: 'gray', NP: 'gray', PG: 'gray', SS: 'gray', SY: 'gray',
    VE: 'gray', VN: 'gray', VG: 'gray', YE: 'gray',
  },
  publicationDate: '2026-06-01',
};

export interface FinSysFixtureOverrides {
  debt?: Record<string, FinSysDebtEntry>;
  bis?: Record<string, FinSysBisEntry>;
  fatf?: { listings: Record<string, 'black' | 'gray' | 'compliant'>; publicationDate: string };
}

/**
 * Stub `ResilienceSeedReader` over the pinned payloads. Seed-meta is
 * reported healthy so the fail-closed preflight passes and the gates
 * exercise the scoring path rather than the configuration path.
 *
 * `nowMs` is injected rather than read from the clock so the preflight's
 * staleness comparison is deterministic (`isSeedMetaPreflightUnhealthy`
 * enforces per-key `maxStaleMin` budgets).
 */
export function createFinSysFixtureReader(
  overrides: FinSysFixtureOverrides = {},
  nowMs: number = Date.now(),
): ResilienceSeedReader {
  const debt = {
    countries: { ...FINSYS_DEBT_FIXTURE, ...(overrides.debt ?? {}) },
    nonDrsCountryCodes: FINSYS_NON_DRS_COUNTRY_CODES,
  };
  const bis = { countries: { ...FINSYS_BIS_FIXTURE, ...(overrides.bis ?? {}) } };
  const fatf = overrides.fatf ?? FINSYS_FATF_FIXTURE;
  return async (key: string) => {
    if (key.startsWith('seed-meta:')) return { status: 'ok', fetchedAt: nowMs };
    if (key === 'economic:wb-external-debt:v1') return debt;
    if (key === 'economic:bis-lbs:v1') return bis;
    if (key === 'economic:fatf-listing:v1') return fatf;
    return null;
  };
}
