type StoredMetric = {
  value?: number;
  year?: number;
  previousValue?: number;
  previousYear?: number;
  source?: string;
};

type StoredCountry = {
  expenditurePctGdp?: StoredMetric;
  expenditureUsd?: StoredMetric;
  personnel?: StoredMetric;
  armsExportsTiv?: StoredMetric;
  armsImportsTiv?: StoredMetric;
};

type StoredSupplier = { supplierIso2?: string; tivShare?: number };
type StoredDependency = {
  suppliers?: StoredSupplier[];
  supplierHhi?: number;
  mappingCoverage?: number;
  window?: { startYear?: number; endYear?: number };
  source?: string;
  fetchedAt?: string;
  retained?: boolean;
};

export type StoredIndustrialSnapshot = { countries?: Record<string, StoredCountry>; fetchedAt?: string };
export type StoredSupplierSnapshot = { importers?: Record<string, StoredDependency>; fetchedAt?: string };

export type DefenseIndustrialMetricValue = {
  available: boolean;
  value: number;
  year: number;
  previousValue: number;
  previousYear: number;
  source: string;
};

export type DefenseIndustrialResponseValue = {
  countryCode: string;
  available: boolean;
  expenditurePctGdp: DefenseIndustrialMetricValue;
  expenditureUsd: DefenseIndustrialMetricValue;
  personnel: DefenseIndustrialMetricValue;
  armsExportsTiv: DefenseIndustrialMetricValue;
  armsImportsTiv: DefenseIndustrialMetricValue;
  suppliers: Array<{ supplierIso2: string; tivShare: number }>;
  supplierHhi: number;
  windowStartYear: number;
  windowEndYear: number;
  supplierSource: string;
  fetchedAt: string;
  industrialFetchedAt: string;
  supplierFetchedAt: string;
  supplierRetained: boolean;
  supplierMappingCoverage: number;
};

export function toDefenseIndustrialMetric(metric?: StoredMetric): DefenseIndustrialMetricValue {
  const available = Number.isFinite(metric?.value) && Number.isInteger(metric?.year);
  return {
    available,
    value: available ? Number(metric?.value) : 0,
    year: available ? Number(metric?.year) : 0,
    previousValue: Number.isFinite(metric?.previousValue) ? Number(metric?.previousValue) : 0,
    previousYear: Number.isInteger(metric?.previousYear) ? Number(metric?.previousYear) : 0,
    source: available ? String(metric?.source || '') : '',
  };
}

function emptyResponse(countryCode: string): DefenseIndustrialResponseValue {
  const empty = toDefenseIndustrialMetric();
  return {
    countryCode,
    available: false,
    expenditurePctGdp: empty,
    expenditureUsd: empty,
    personnel: empty,
    armsExportsTiv: empty,
    armsImportsTiv: empty,
    suppliers: [],
    supplierHhi: 0,
    windowStartYear: 0,
    windowEndYear: 0,
    supplierSource: '',
    fetchedAt: '',
    industrialFetchedAt: '',
    supplierFetchedAt: '',
    supplierRetained: false,
    supplierMappingCoverage: 0,
  };
}

function validTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return '';
  return value;
}

function oldestTimestamp(...values: string[]): string {
  return values
    .filter(Boolean)
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0] || '';
}

export function buildDefenseIndustrialResponse(
  countryCode: string,
  industrial: StoredIndustrialSnapshot | null,
  dependencies: StoredSupplierSnapshot | null,
): DefenseIndustrialResponseValue {
  const country = industrial?.countries?.[countryCode];
  const dependency = dependencies?.importers?.[countryCode];
  if (!country && !dependency) return emptyResponse(countryCode);
  const suppliers = (dependency?.suppliers || [])
    .filter((entry) => (
      /^[A-Z]{2}$/.test(String(entry.supplierIso2 || ''))
      && Number.isFinite(entry.tivShare)
      && Number(entry.tivShare) >= 0
      && Number(entry.tivShare) <= 1
    ))
    .map((entry) => ({ supplierIso2: String(entry.supplierIso2), tivShare: Number(entry.tivShare) }));
  const rawHhi = Number(dependency?.supplierHhi);
  const rawMappingCoverage = Number(dependency?.mappingCoverage);
  const industrialFetchedAt = country ? validTimestamp(industrial?.fetchedAt) : '';
  const supplierFetchedAt = dependency
    ? validTimestamp(dependency.fetchedAt) || validTimestamp(dependencies?.fetchedAt)
    : '';
  return {
    countryCode,
    available: true,
    expenditurePctGdp: toDefenseIndustrialMetric(country?.expenditurePctGdp),
    expenditureUsd: toDefenseIndustrialMetric(country?.expenditureUsd),
    personnel: toDefenseIndustrialMetric(country?.personnel),
    armsExportsTiv: toDefenseIndustrialMetric(country?.armsExportsTiv),
    armsImportsTiv: toDefenseIndustrialMetric(country?.armsImportsTiv),
    suppliers,
    supplierHhi: Number.isFinite(rawHhi) ? Math.max(0, Math.min(1, rawHhi)) : 0,
    windowStartYear: Number.isInteger(dependency?.window?.startYear) ? Number(dependency?.window?.startYear) : 0,
    windowEndYear: Number.isInteger(dependency?.window?.endYear) ? Number(dependency?.window?.endYear) : 0,
    supplierSource: String(dependency?.source || ''),
    // Backward-compatible aggregate freshness means "oldest source served".
    // The additive clocks below are the authoritative source-specific values.
    fetchedAt: oldestTimestamp(industrialFetchedAt, supplierFetchedAt),
    industrialFetchedAt,
    supplierFetchedAt,
    supplierRetained: Boolean(dependency?.retained),
    supplierMappingCoverage: Number.isFinite(rawMappingCoverage)
      ? Math.max(0, Math.min(1, rawMappingCoverage))
      : 0,
  };
}
