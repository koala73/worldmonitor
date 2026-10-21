// Cohort definitions for the resilience-scorer fairness audit.
// Referenced by scripts/compare-resilience-current-vs-proposed.mjs and
// tests/resilience-cohort-config.test.mts. See
// docs/plans/2026-04-22-001-fix-resilience-scorer-structural-bias-plan.md
// §5 (PR 0) and §7 for the role these cohorts play in the acceptance gates.
//
// Membership is curated, not live-derived. Each cohort lists every country
// that clearly falls into the category under widely-accepted definitions
// (IEA + WB for exporters/importers, IAEA for nuclear-heavy, etc.). The
// median-shift gate per cohort (§6 gate 6) is computed from these lists.
//
// Borderline cases are deliberately excluded: if a country only fits a
// cohort in some years, we leave it out so the cohort median stays a
// stable reference across PRs.

export interface ResilienceCohort {
  /** Unique id used in reports and commit messages. */
  id: string;
  /** Human-readable cohort name. */
  label: string;
  /** One-sentence definition citing the objective criterion used. */
  definition: string;
  /** Source or authority that grounds the definition. */
  source: string;
  /** ISO-3166 alpha-2 country codes in the cohort. */
  countryCodes: readonly string[];
}

export const RESILIENCE_COHORTS: readonly ResilienceCohort[] = [
  {
    id: 'net-fuel-exporters',
    label: 'Net fuel exporters',
    definition:
      'Countries whose net petroleum + gas exports exceed domestic consumption on a 5-year rolling average. These countries are the archetype the current scorer under-scores via gas/coal penalties and the net-import-biased fuel-stock metric.',
    source: 'IEA World Energy Balances + UN Comtrade HS27 cross-check. List curated 2026-04-22.',
    countryCodes: [
      'AE', 'SA', 'QA', 'KW', 'OM', 'BH',  // Gulf
      'NO', 'CA',                           // Wealthy democracies
      'RU', 'IR', 'IQ',                     // Major non-aligned
      'KZ', 'AZ', 'TM',                     // Post-Soviet
      'VE', 'CO', 'EC',                     // South America
      'NG', 'DZ', 'LY', 'AO',               // Africa
      'BN',                                 // Southeast Asia
    ],
  },
  {
    id: 'net-energy-importers-oecd',
    label: 'Net energy importers (OECD core)',
    definition:
      'OECD countries with EG.IMP.CONS.ZS > 20% (net energy imports as share of primary energy use). Validates that exporter-aimed fixes do not accidentally uplift these as a side effect.',
    source: 'World Bank WDI EG.IMP.CONS.ZS, 2022 values. Curated 2026-04-22.',
    countryCodes: [
      'DE', 'FR', 'IT', 'ES', 'PT',  // EU core + periphery
      'BE', 'NL', 'AT', 'CH',        // EU continental
      'JP', 'KR',                    // East Asia
      'GB', 'IE',                    // UK + Ireland
      'GR', 'HU', 'CZ', 'SK',        // Southern + Central EU
      'TR',                          // Bridge economy
    ],
  },
  {
    id: 'nuclear-heavy-generation',
    label: 'Nuclear-heavy generation mix',
    definition:
      'Countries where nuclear supplied ≥ 15% of electricity generation in the most recent reporting year. Validates that the new lowCarbonGenerationShare indicator correctly rewards firm low-carbon generation (PR 1 §3.3).',
    source: 'IAEA PRIS (Power Reactor Information System) + OWID nuclear_share_elec. Curated 2026-04-22.',
    countryCodes: [
      'FR', 'SK', 'UA', 'HU', 'BE', 'BG', 'SI',  // Central/Eastern Europe heavy adopters
      'CZ', 'FI', 'SE', 'CH',                     // Western/Northern EU adopters
      'KR', 'US',                                 // North America + East Asia
      'AE',                                       // UAE (Barakah)
      'RU',                                       // Russia
      'AR',                                       // Argentina (small but material share)
    ],
  },
  {
    id: 'coal-heavy-domestic',
    label: 'Coal-heavy domestic producers',
    definition:
      'Countries where coal supplied ≥ 30% of electricity generation AND the coal is predominantly domestic (not imported). Validates that the new importedFossilDependence composite correctly distinguishes domestic from imported coal exposure.',
    source: 'World Bank EG.ELC.COAL.ZS + WITS/Comtrade domestic-vs-imports cross-check. Curated 2026-04-22.',
    countryCodes: [
      'IN', 'CN', 'ID',        // Asia heavyweights
      'ZA', 'BW',              // Southern Africa
      'AU', 'US',              // OECD domestic producers
      'PL', 'RS', 'BA', 'KZ',  // Central/Eastern Europe + post-Soviet
      'MN',                    // Mongolia
    ],
  },
  {
    id: 'small-island-importers',
    label: 'Small-island fuel importers',
    definition:
      'Small-island developing states that import essentially all fossil fuels. Data coverage is thin for this cohort; catches fixes that require data they structurally lack.',
    source: 'UN SIDS list, subset with > 100k population. Curated 2026-04-22.',
    countryCodes: [
      'FJ', 'WS', 'TO', 'VU', 'SB', 'PG', 'KI', 'TV',  // Pacific
      'MV',                                              // Indian Ocean
      'MU', 'SC', 'CV',                                  // Africa-adjacent
      'BB', 'TT', 'JM', 'LC', 'VC', 'GD',                // Caribbean
    ],
  },
  {
    id: 'sanctions-isolated',
    label: 'Sanctions-isolated jurisdictions',
    definition:
      'Jurisdictions subject to a comprehensive or government-wide Western blocking programme, whose banking systems are severed from USD/EUR correspondent clearing as a realized fact rather than a forecast. This is the cohort `docs/methodology/financial-system-exposure.md` § "Sanctions-isolated jurisdiction sanity check" names as the construct activation anchor: every member must score < 20 on `financialSystemExposure`, because maximal realized severance is the worst possible reading of that construct, not the best.',
    source:
      'US OFAC comprehensive/territory-wide and government-wide blocking programmes (31 CFR 500-599 + the EO series) cross-checked against EU Council consolidated restrictive measures. Membership is the eight jurisdictions enumerated in the financial-system-exposure methodology anchor. Curated 2026-08-11.',
    countryCodes: [
      'RU', 'BY',        // Post-2022 coordinated G7/EU financial severance
      'IR', 'KP',        // Long-standing comprehensive programmes (also FATF black)
      'CU', 'VE',        // Western-hemisphere comprehensive / government-wide blocking
      'LY', 'MM',        // Government-wide asset freezes (MM also FATF black)
    ],
  },
  {
    id: 'fragile-states',
    label: 'Fragile states (low-band anchors)',
    definition:
      'Countries consistently in the bottom band of multiple composite indices (Fund for Peace FSI top-10 fragile 2019-2023, UN LDC, UCDP conflict-affected). Release-gate anchors must continue to score these at or below the LOW_BAND_CEILING through every PR.',
    source: 'Intersection of Fund for Peace FSI, UN LDC list, and UCDP conflict-event database. Curated 2026-04-22.',
    countryCodes: [
      'YE', 'SO', 'SD', 'SS',     // Horn + NE Africa
      'CF', 'TD', 'NE', 'ML', 'BF', 'BI',  // Sahel + Great Lakes
      'CD', 'ET',                 // Central/East Africa
      'HT',                       // Caribbean
      'SY', 'IQ', 'AF',           // MENA
      'MM', 'LB',                 // Asia + Levant
    ],
  },
] as const;

export function cohortMembershipFor(countryCode: string): readonly string[] {
  const cc = countryCode.trim().toUpperCase();
  return RESILIENCE_COHORTS
    .filter((cohort) => cohort.countryCodes.includes(cc))
    .map((cohort) => cohort.id);
}

export function unionMembership(): readonly string[] {
  const seen = new Set<string>();
  for (const cohort of RESILIENCE_COHORTS) {
    for (const cc of cohort.countryCodes) seen.add(cc);
  }
  return [...seen];
}
