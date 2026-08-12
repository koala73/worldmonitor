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
  window?: { startYear?: number; endYear?: number };
  source?: string;
};

export type StoredIndustrialSnapshot = { countries?: Record<string, StoredCountry>; fetchedAt?: string };
export type StoredSupplierSnapshot = { importers?: Record<string, StoredDependency>; fetchedAt?: string };

export function hasCompleteDefenseIndustrialHydration(
  industrial: unknown,
  suppliers: unknown,
): boolean {
  return Boolean(
    industrial
    && typeof industrial === 'object'
    && !Array.isArray(industrial)
    && (industrial as StoredIndustrialSnapshot).countries
    && typeof (industrial as StoredIndustrialSnapshot).countries === 'object'
    && suppliers
    && typeof suppliers === 'object'
    && !Array.isArray(suppliers)
    && (suppliers as StoredSupplierSnapshot).importers
    && typeof (suppliers as StoredSupplierSnapshot).importers === 'object',
  );
}

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
  };
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
    fetchedAt: String(dependencies?.fetchedAt || industrial?.fetchedAt || ''),
  };
}
