/**
 * Raw redistribution policy for the indicator drill-down API.
 *
 * This policy is intentionally separate from IndicatorSpec.license. That
 * registry field describes a broad source category; it is not a legal grant
 * to republish an observed value. Raw values are allowed only when every
 * provider used for the exact observation matches a reviewed source below.
 */

export type RawRedistributionPolicyStatus =
  | 'allow'
  | 'restricted'
  | 'audit-incomplete'
  | 'conditional';

export type IndicatorObservationState =
  | 'observed'
  | 'imputed'
  | 'fallback'
  | 'missing'
  | 'inactive'
  | 'retired'
  | 'not-applicable'
  | 'source-failure';

export type RawRedistributionDecisionStatus =
  | 'allow'
  | 'restricted'
  | 'audit-incomplete'
  | 'conditional'
  | 'ineligible-observation'
  | 'unknown-indicator';

export type RawRedistributionDecisionReason =
  | 'audited-observed-source'
  | 'observation-not-observed'
  | 'provider-provenance-required'
  | 'required-provider-provenance-missing'
  | 'provider-not-audited-for-redistribution'
  | 'redistribution-restricted'
  | 'source-audit-incomplete'
  | 'unknown-indicator';

export interface AuditedRawSource {
  providerName: string;
  sourceUrl: string;
  licenseLabel: string;
  licenseUrl: string;
  attribution: string;
  attributionUrl?: string;
  providerAliases: readonly string[];
  sourceUrlPrefixes: readonly string[];
  sourcePathSuffixes?: readonly string[];
}

export interface IndicatorSourcePolicy {
  status: RawRedistributionPolicyStatus;
  providerName: string;
  sourceUrl: string | null;
  licenseLabel: string;
  licenseUrl: string | null;
  attribution: string;
  attributionUrl: string | null;
  allowedRawSources: readonly AuditedRawSource[];
  requiredRawSources: readonly AuditedRawSource[];
  note: string;
}

export interface IndicatorObservedSourceHint {
  providerName?: string | null;
  sourceUrl?: string | null;
}

export interface IndicatorRawRedistributionInput {
  indicatorId: string;
  observationState: IndicatorObservationState;
  /** Every provider that contributed to this exact observation. */
  sources?: readonly IndicatorObservedSourceHint[];
}

export interface IndicatorRawRedistributionDecision {
  expose: boolean;
  status: RawRedistributionDecisionStatus;
  policyStatus: RawRedistributionPolicyStatus | 'unknown';
  reason: RawRedistributionDecisionReason;
  providerName: string;
  sourceUrl: string | null;
  licenseLabel: string;
  licenseUrl: string | null;
  attribution: string;
}

export interface IndicatorSourceDisplayMetadata {
  providerName: string;
  attribution: string;
  licenseLabel: string;
  licenseUrl: string | null;
  attributionUrl: string | null;
  sourceUrl: string | null;
}

const WORLD_BANK_SOURCE: AuditedRawSource = {
  providerName: 'World Bank Open Data',
  sourceUrl: 'https://api.worldbank.org/v2/',
  licenseLabel: 'CC BY 4.0',
  licenseUrl: 'https://www.worldbank.org/en/about/legal/terms-of-use-for-datasets',
  attribution: 'World Bank Open Data; include the indicator source URL and extraction date.',
  providerAliases: [
    'world bank',
    'world bank open data',
    'world development indicators',
    'worldwide governance indicators',
    'wdi',
    'wgi',
  ],
  sourceUrlPrefixes: ['https://api.worldbank.org/v2/'],
};

function worldBankSource(indicatorId: string): AuditedRawSource {
  return {
    ...WORLD_BANK_SOURCE,
    sourceUrl: `https://api.worldbank.org/v2/country/all/indicator/${indicatorId}`,
    sourcePathSuffixes: [`/indicator/${indicatorId}`],
  };
}

function worldBankPolicy(
  indicatorIds: readonly string[],
  note = 'Raw redistribution was reviewed for these exact World Bank indicator paths.',
): IndicatorSourcePolicy {
  const sources = indicatorIds.map(worldBankSource);
  return {
    status: 'allow',
    providerName: WORLD_BANK_SOURCE.providerName,
    sourceUrl: sources.length === 1 ? sources[0]!.sourceUrl : null,
    licenseLabel: WORLD_BANK_SOURCE.licenseLabel,
    licenseUrl: WORLD_BANK_SOURCE.licenseUrl,
    attribution: WORLD_BANK_SOURCE.attribution,
    attributionUrl: WORLD_BANK_SOURCE.attributionUrl ?? null,
    allowedRawSources: sources,
    requiredRawSources: sources,
    note,
  };
}

const OWID_SOURCE: AuditedRawSource = {
  providerName: 'Our World in Data',
  sourceUrl: 'https://ourworldindata.org/',
  licenseLabel: 'CC BY 4.0 for the dataset unless its dataset page states otherwise',
  licenseUrl: 'https://ourworldindata.org/how-to-use-our-world-in-data',
  attribution: 'Our World in Data; link to the exact dataset page.',
  providerAliases: ['our world in data', 'owid'],
  sourceUrlPrefixes: [
    'https://ourworldindata.org/energy',
    'https://ourworldindata.org/grapher/',
    'https://owid-public.owid.io/',
  ],
};

const UNESCO_VIA_WDI_SOURCE: AuditedRawSource = {
  providerName: 'UNESCO Institute for Statistics via World Bank WDI',
  sourceUrl: 'https://uis.unesco.org/',
  licenseLabel: 'CC BY 4.0 through World Bank WDI, with UNESCO UIS attribution',
  licenseUrl: 'https://www.worldbank.org/en/about/legal/terms-of-use-for-datasets',
  attribution: 'UNESCO Institute for Statistics via World Bank WDI; include the UIS source URL and extraction date.',
  attributionUrl: 'https://uis.unesco.org/',
  providerAliases: [
    'unesco institute for statistics via world bank wdi',
    'unesco uis via world bank wdi',
    'unesco institute for statistics',
    'unesco uis',
  ],
  sourceUrlPrefixes: ['https://api.worldbank.org/v2/'],
  sourcePathSuffixes: ['/indicator/SE.SEC.CUAT.UP.FE.ZS'],
};

const STATCAN_WDS_SOURCE: AuditedRawSource = {
  providerName: 'Statistics Canada',
  sourceUrl: 'https://www150.statcan.gc.ca/t1/wds/rest/getDataFromVectorsAndLatestNPeriods',
  licenseLabel: 'Statistics Canada Open Licence',
  licenseUrl: 'https://www.statcan.gc.ca/en/terms-conditions/open-licence',
  attribution: 'Statistics Canada, Web Data Service.',
  attributionUrl: 'https://www.statcan.gc.ca/en/developers/wds/user-guide',
  providerAliases: ['statistics canada', 'statcan'],
  sourceUrlPrefixes: ['https://www150.statcan.gc.ca/t1/wds/rest/'],
};

const DISPLAY_ONLY_SOURCES = [STATCAN_WDS_SOURCE] as const;

function allowPolicy(
  source: AuditedRawSource,
  note = 'Raw redistribution was reviewed for this provider.',
): IndicatorSourcePolicy {
  return {
    status: 'allow',
    providerName: source.providerName,
    sourceUrl: source.sourceUrl,
    licenseLabel: source.licenseLabel,
    licenseUrl: source.licenseUrl,
    attribution: source.attribution,
    attributionUrl: source.attributionUrl ?? null,
    allowedRawSources: [source],
    requiredRawSources: [source],
    note,
  };
}

function restrictedPolicy(
  providerName: string,
  sourceUrl: string,
  licenseLabel: string,
  licenseUrl: string | null,
  attribution: string,
  note: string,
): IndicatorSourcePolicy {
  return {
    status: 'restricted',
    providerName,
    sourceUrl,
    licenseLabel,
    licenseUrl,
    attribution,
    attributionUrl: null,
    allowedRawSources: [],
    requiredRawSources: [],
    note,
  };
}

function incompletePolicy(
  providerName: string,
  sourceUrl: string | null,
  attribution: string,
  note = 'Current provider terms require a completed redistribution review.',
): IndicatorSourcePolicy {
  return {
    status: 'audit-incomplete',
    providerName,
    sourceUrl,
    licenseLabel: 'Redistribution audit incomplete',
    licenseUrl: null,
    attribution,
    attributionUrl: null,
    allowedRawSources: [],
    requiredRawSources: [],
    note,
  };
}

const WORLD_BANK_EDUCATION = allowPolicy(
  UNESCO_VIA_WDI_SOURCE,
  'The exact observed provider must identify UNESCO UIS via World Bank WDI.',
);
const OWID = allowPolicy(OWID_SOURCE);
const BIS = restrictedPolicy(
  'Bank for International Settlements',
  'https://data.bis.org/',
  'Non-commercial / redistribution restricted',
  'https://www.bis.org/terms_conditions.htm',
  'Bank for International Settlements; link to the relevant BIS statistics page.',
  'Derived normalized scores may be served, but raw BIS observations are not redistributed.',
);
const GPI = restrictedPolicy(
  'Institute for Economics & Peace / Global Peace Index',
  'https://www.visionofhumanity.org/maps/',
  'Non-commercial',
  'https://www.visionofhumanity.org/terms-and-conditions/',
  'Institute for Economics & Peace, Global Peace Index / Vision of Humanity.',
  'The repository classifies GPI as non-commercial; public raw redistribution is denied.',
);
const UCDP = restrictedPolicy(
  'Uppsala Conflict Data Program',
  'https://ucdp.uu.se/downloads/',
  'Runtime deny pending exact-dataset redistribution review',
  'https://ucdp.uu.se/downloads/',
  'Uppsala Conflict Data Program; link to the UCDP dataset page.',
  'The downloads page advertises CC BY 4.0, but the repository has not updated its exact-dataset redistribution decision. The scoring exception is not a redistribution grant.',
);

const IMF = incompletePolicy('International Monetary Fund', 'https://www.imf.org/en/Data', 'International Monetary Fund; link to the exact dataset.');
const WTO = incompletePolicy('World Trade Organization', 'https://data.wto.org/', 'World Trade Organization; link to the exact dataset.');
const FATF = incompletePolicy('Financial Action Task Force', 'https://www.fatf-gafi.org/en/countries/black-and-grey-lists.html', 'Financial Action Task Force; link to the source publication.');
const CYBER_FEEDS = incompletePolicy('Feodo Tracker / URLhaus / C2Intel / OTX / AbuseIPDB', null, 'Credit every contributing threat-intelligence provider.');
const CLOUDFLARE = incompletePolicy('Cloudflare Radar', 'https://radar.cloudflare.com/', 'Cloudflare Radar; link to the source observation.');
const GPSJAM = incompletePolicy('GPSJam / ADS-B Exchange', 'https://gpsjam.org/', 'GPSJam and ADS-B Exchange; link to the source map.');
const YAHOO = incompletePolicy('Yahoo Finance', 'https://finance.yahoo.com/', 'Yahoo Finance; link to the relevant market series.');
const TRANSIT = incompletePolicy('IMF PortWatch / corridor-risk and AIS providers', 'https://portwatch.imf.org/', 'Credit every contributing transit and AIS provider.');
const GIE = incompletePolicy('Gas Infrastructure Europe AGSI', 'https://agsi.gie.eu/', 'Gas Infrastructure Europe AGSI; link to the source series.');
const ENERGY_PRICES = incompletePolicy('FRED and upstream energy-price providers', 'https://fred.stlouisfed.org/', 'Credit the exact upstream energy-price series provider.');
const OWID_LOW_CARBON = incompletePolicy(
  'Our World in Data / Ember / Energy Institute',
  'https://ourworldindata.org/grapher/share-electricity-low-carbon',
  'Our World in Data; also preserve the attribution and terms of the Ember and Energy Institute source dataset.',
  'The OWID chart uses third-party Ember and Energy Institute data. Raw redistribution remains disabled until the exact dataset terms are recorded.',
);
const UNHCR = incompletePolicy('UNHCR', 'https://www.unhcr.org/refugee-statistics/', 'UNHCR Refugee Data Finder; link to the source dataset.');
const UNREST = incompletePolicy('ACLED / GDELT', null, 'Credit the exact ACLED or GDELT source used for the observation.');
const RSF = incompletePolicy('Reporters Without Borders', 'https://rsf.org/en/index', 'Reporters Without Borders, World Press Freedom Index.');
const REDDIT = incompletePolicy('Reddit / ScrapeCreators', 'https://www.reddit.com/', 'Credit Reddit and the exact upstream collection provider.');
const NEWS = incompletePolicy('WorldMonitor derived news signal and upstream publishers', null, 'Credit the contributing publishers and link to source items.');
const WHO = incompletePolicy('World Health Organization Global Health Observatory', 'https://www.who.int/data/gho', 'World Health Organization Global Health Observatory; link to the source indicator.');
const IPC = incompletePolicy('IPC via Humanitarian Data Exchange', 'https://data.humdata.org/', 'Integrated Food Security Phase Classification via HDX; link to the source dataset.');
const WIKIPEDIA_SWF = incompletePolicy('Wikipedia and sovereign-wealth source pages', 'https://www.wikipedia.org/', 'Credit each sovereign-wealth source; retain applicable CC BY-SA attribution.');
const COMTRADE = incompletePolicy('UN Comtrade', 'https://comtradeplus.un.org/', 'United Nations Comtrade; link to the source dataset.');
const FUEL_STOCKS = incompletePolicy('IEA / EIA', null, 'Credit the exact IEA or EIA fuel-stock series.');
const NATIONAL_DEBT = incompletePolicy('IMF / United States Treasury national-debt sources', null, 'Credit the exact national-debt provider used for the observation.');

const ENERGY_IMPORT_CONDITIONAL: IndicatorSourcePolicy = {
  ...worldBankPolicy(['EG.IMP.CONS.ZS']),
  status: 'conditional',
  providerName: 'World Bank Open Data or Eurostat',
  note: 'Allow only the exact World Bank EG.IMP.CONS.ZS observation. Eurostat-backed observations remain audit-incomplete.',
};
const IMPORTED_FOSSIL_CONDITIONAL: IndicatorSourcePolicy = {
  ...worldBankPolicy(['EG.ELC.FOSL.ZS', 'EG.IMP.CONS.ZS']),
  status: 'conditional',
  providerName: 'World Bank Open Data, with a possible Eurostat net-import override',
  note: 'Allow only when both exact World Bank indicator paths contributed. An Eurostat constituent denies raw redistribution.',
};
const LIQUID_RESERVE_CONDITIONAL: IndicatorSourcePolicy = {
  ...worldBankPolicy(['FI.RES.TOTL.MO']),
  status: 'conditional',
  providerName: 'World Bank Open Data, optionally adjusted with UN Comtrade',
  note: 'Allow the exact unadjusted World Bank observation only. If a Comtrade re-export adjustment contributed, raw redistribution is audit-incomplete.',
};

const WORLD_BANK_WGI_INDICATORS = [
  'GOV_WGI_VA.EST',
  'GOV_WGI_PV.EST',
  'GOV_WGI_GE.EST',
  'GOV_WGI_RQ.EST',
  'GOV_WGI_RL.EST',
  'GOV_WGI_CC.EST',
] as const;

const EUROSTAT_DISPLAY = incompletePolicy(
  'Eurostat',
  'https://ec.europa.eu/eurostat/',
  'Eurostat; link to the exact source dataset.',
);

/** Exhaustive policy table for the 72 entries in INDICATOR_REGISTRY. */
export const INDICATOR_SOURCE_POLICIES = {
  govRevenuePct: IMF,
  debtGrowthRate: NATIONAL_DEBT,
  currentAccountPct: IMF,
  unemploymentPct: IMF,
  householdDebtService: BIS,
  inflationStability: IMF,
  fxReservesAdequacy: worldBankPolicy(['FI.RES.TOTL.MO']),
  fxVolatility: BIS,
  fxDeviation: BIS,
  tradeRestrictions: WTO,
  tradeBarriers: WTO,
  appliedTariffRate: worldBankPolicy(['TM.TAX.MRCH.WM.AR.ZS']),
  shortTermExternalDebtPctGni: worldBankPolicy(['DT.DOD.DSTC.CD', 'NY.GNP.MKTP.CD']),
  bisLbsXborderPctGdp: BIS,
  fatfListingStatus: FATF,
  financialCenterRedundancy: BIS,
  cyberThreats: CYBER_FEEDS,
  internetOutages: CLOUDFLARE,
  gpsJamming: GPSJAM,
  roadsPavedLogistics: worldBankPolicy(['IS.ROD.PAVE.ZS']),
  shippingStress: YAHOO,
  transitDisruption: TRANSIT,
  electricityAccess: worldBankPolicy(['EG.ELC.ACCS.ZS']),
  roadsPavedInfra: worldBankPolicy(['IS.ROD.PAVE.ZS']),
  infraOutages: CLOUDFLARE,
  broadband: worldBankPolicy(['IT.NET.BBND.P2']),
  energyImportDependency: ENERGY_IMPORT_CONDITIONAL,
  gasShare: OWID,
  coalShare: OWID,
  renewShare: OWID,
  euGasStorageStress: GIE,
  energyPriceStress: ENERGY_PRICES,
  electricityConsumption: worldBankPolicy(['EG.USE.ELEC.KH.PC']),
  importedFossilDependence: IMPORTED_FOSSIL_CONDITIONAL,
  lowCarbonGenerationShare: OWID_LOW_CARBON,
  powerLossesPct: worldBankPolicy(['EG.ELC.LOSS.ZS']),
  wgiVoiceAccountability: worldBankPolicy(['GOV_WGI_VA.EST']),
  wgiPoliticalStability: worldBankPolicy(['GOV_WGI_PV.EST']),
  wgiGovernmentEffectiveness: worldBankPolicy(['GOV_WGI_GE.EST']),
  wgiRegulatoryQuality: worldBankPolicy(['GOV_WGI_RQ.EST']),
  wgiRuleOfLaw: worldBankPolicy(['GOV_WGI_RL.EST']),
  wgiControlOfCorruption: worldBankPolicy(['GOV_WGI_CC.EST']),
  gpiScore: GPI,
  displacementTotal: UNHCR,
  unrestEvents: UNREST,
  ucdpConflict: UCDP,
  displacementHosted: UNHCR,
  rsfPressFreedom: RSF,
  socialVelocity: REDDIT,
  newsThreatScore: NEWS,
  femaleUpperSecondaryAttainment: WORLD_BANK_EDUCATION,
  uhcIndex: WHO,
  measlesCoverage: WHO,
  hospitalBeds: WHO,
  physiciansPer1k: WHO,
  healthExpPerCapitaUsd: WHO,
  ipcPeopleInCrisis: IPC,
  ipcPhase: IPC,
  aquastatScore: worldBankPolicy(['ER.H2O.FWST.ZS']),
  recoveryGovRevenue: IMF,
  recoveryFiscalBalance: IMF,
  recoveryDebtToGdp: IMF,
  debtSustainabilityGap: IMF,
  recoveryReserveMonths: worldBankPolicy(['FI.RES.TOTL.MO']),
  recoveryLiquidReserveMonths: LIQUID_RESERVE_CONDITIONAL,
  recoverySovereignWealthEffectiveMonths: WIKIPEDIA_SWF,
  recoveryDebtToReserves: worldBankPolicy(['DT.DOD.DSTC.CD', 'FI.RES.TOTL.CD']),
  recoveryImportHhi: COMTRADE,
  recoveryWgiContinuity: worldBankPolicy(WORLD_BANK_WGI_INDICATORS),
  recoveryConflictPressure: UCDP,
  recoveryDisplacementVelocity: UNHCR,
  recoveryFuelStockDays: FUEL_STOCKS,
} as const satisfies Record<import('./_indicator-registry').ResilienceIndicatorId, IndicatorSourcePolicy>;

export type IndicatorSourcePolicyId = keyof typeof INDICATOR_SOURCE_POLICIES;

export function getIndicatorSourcePolicy(indicatorId: string): IndicatorSourcePolicy | null {
  return Object.prototype.hasOwnProperty.call(INDICATOR_SOURCE_POLICIES, indicatorId)
    ? INDICATOR_SOURCE_POLICIES[indicatorId as IndicatorSourcePolicyId]
    : null;
}

function normalizeProvider(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizedSourceUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function matchesAuditedSource(hint: IndicatorObservedSourceHint, source: AuditedRawSource): boolean {
  const provider = typeof hint.providerName === 'string' ? normalizeProvider(hint.providerName) : '';
  const url = typeof hint.sourceUrl === 'string' ? normalizedSourceUrl(hint.sourceUrl) : null;
  const providerMatches = !provider || source.providerAliases.some((alias) => normalizeProvider(alias) === provider);
  const urlMatches = url != null && (
    source.sourceUrlPrefixes.some((prefix) => url.toString().startsWith(prefix))
    && (source.sourcePathSuffixes?.some((suffix) => url.pathname.endsWith(suffix)) ?? true)
  );
  return providerMatches && urlMatches;
}

function metadataFromPolicy(policy: IndicatorSourcePolicy): IndicatorSourceDisplayMetadata {
  return {
    providerName: policy.providerName,
    attribution: policy.attribution,
    licenseLabel: policy.licenseLabel,
    licenseUrl: policy.licenseUrl,
    attributionUrl: policy.attributionUrl,
    sourceUrl: policy.sourceUrl,
  };
}

/** Resolve display metadata for the exact observed provider, never the aggregate policy. */
export function getObservedSourceDisplayMetadata(
  policy: IndicatorSourcePolicy | null,
  hint: IndicatorObservedSourceHint,
): IndicatorSourceDisplayMetadata {
  const audited = policy?.allowedRawSources.find((source) => matchesAuditedSource(hint, source))
    ?? DISPLAY_ONLY_SOURCES.find((source) => matchesAuditedSource(hint, source));
  if (audited) {
    return {
      providerName: audited.providerName,
      attribution: audited.attribution,
      licenseLabel: audited.licenseLabel,
      licenseUrl: audited.licenseUrl,
      attributionUrl: audited.attributionUrl ?? null,
      sourceUrl: audited.sourceUrl,
    };
  }

  const provider = normalizeProvider(hint.providerName ?? '');
  if (provider === 'eurostat') return metadataFromPolicy(EUROSTAT_DISPLAY);
  if (provider === 'united nations comtrade' || provider === 'un comtrade') {
    return metadataFromPolicy(COMTRADE);
  }
  if (policy && normalizeProvider(policy.providerName).includes(provider) && provider.length > 0) {
    return metadataFromPolicy(policy);
  }
  return {
    providerName: hint.providerName?.trim() || 'Unknown observed provider',
    attribution: hint.providerName?.trim()
      ? `${hint.providerName.trim()}; link to the exact source observation.`
      : 'Observed provider metadata unavailable.',
    licenseLabel: 'Redistribution audit incomplete',
    licenseUrl: null,
    attributionUrl: null,
    sourceUrl: hint.sourceUrl ?? null,
  };
}

function deniedDecision(
  policy: IndicatorSourcePolicy,
  status: RawRedistributionDecisionStatus,
  reason: RawRedistributionDecisionReason,
): IndicatorRawRedistributionDecision {
  return {
    expose: false,
    status,
    policyStatus: policy.status,
    reason,
    providerName: policy.providerName,
    sourceUrl: policy.sourceUrl,
    licenseLabel: policy.licenseLabel,
    licenseUrl: policy.licenseUrl,
    attribution: policy.attribution,
  };
}

export function decideIndicatorRawRedistribution(
  input: IndicatorRawRedistributionInput,
): IndicatorRawRedistributionDecision {
  const policy = getIndicatorSourcePolicy(input.indicatorId);
  if (!policy) {
    return {
      expose: false,
      status: 'unknown-indicator',
      policyStatus: 'unknown',
      reason: 'unknown-indicator',
      providerName: '',
      sourceUrl: null,
      licenseLabel: 'No redistribution policy',
      licenseUrl: null,
      attribution: '',
    };
  }

  if (input.observationState !== 'observed') {
    return deniedDecision(policy, 'ineligible-observation', 'observation-not-observed');
  }
  if (policy.status === 'restricted') {
    return deniedDecision(policy, 'restricted', 'redistribution-restricted');
  }
  if (policy.status === 'audit-incomplete') {
    return deniedDecision(policy, 'audit-incomplete', 'source-audit-incomplete');
  }

  const sources = input.sources?.filter((source) => source.providerName || source.sourceUrl) ?? [];
  if (sources.length === 0) {
    return deniedDecision(policy, 'conditional', 'provider-provenance-required');
  }

  const matched = sources.map((hint) => policy.allowedRawSources.find((source) => matchesAuditedSource(hint, source)));
  if (matched.some((source) => source == null)) {
    return deniedDecision(policy, 'conditional', 'provider-not-audited-for-redistribution');
  }

  const auditedSources = [...new Set(matched.filter((source): source is AuditedRawSource => source != null))];
  if (policy.requiredRawSources.some((required) => !auditedSources.includes(required))) {
    return deniedDecision(policy, 'conditional', 'required-provider-provenance-missing');
  }
  return {
    expose: true,
    status: 'allow',
    policyStatus: policy.status,
    reason: 'audited-observed-source',
    providerName: auditedSources.map((source) => source.providerName).join(' + '),
    sourceUrl: auditedSources.length === 1 ? auditedSources[0]!.sourceUrl : policy.sourceUrl,
    licenseLabel: auditedSources.map((source) => source.licenseLabel).join('; '),
    licenseUrl: auditedSources.length === 1 ? auditedSources[0]!.licenseUrl : policy.licenseUrl,
    attribution: policy.attribution,
  };
}
