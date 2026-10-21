/**
 * Reviewed MIIT 2024 cluster → HS mappings.
 * A registry row is not a trade flow. OBSERVED_OFFICIAL only confirms the
 * publisher's cluster/product statement. Numeric trade requires reporter 156
 * plus a reviewed HS mapping.
 */

export const CHINA_COMTRADE_NATIONAL_CAPTION =
  'UN Comtrade reporter 156 is China-level official statistics. It is not a town, corridor, factory, port, or shipment export ledger.';

export const CHINA_FACTORY_EVIDENCE_LEVELS = ['OBSERVED_OFFICIAL', 'UNVERIFIED'] as const;
export type ChinaFactoryEvidenceLevel = (typeof CHINA_FACTORY_EVIDENCE_LEVELS)[number];

export type ChinaFactorySource = Readonly<{
  publisher: string;
  title: string;
  url: string;
  publishedAt: string | null;
}>;

export type ChinaFactoryHsMapping = Readonly<{
  hs2: string;
  label: string;
  evidence: ChinaFactoryEvidenceLevel;
  source: ChinaFactorySource;
}>;

export type ChinaFactoryCluster = Readonly<{
  id: string;
  name: string;
  province: string;
  city: string;
  countyOrDistrict: string;
  productDescription: string;
  clusterEvidence: ChinaFactoryEvidenceLevel;
  source: ChinaFactorySource;
  hsMappings: readonly ChinaFactoryHsMapping[];
  statisticsEligible: boolean;
  statisticsEligibilityReason: string;
}>;

const MIIT_2024: ChinaFactorySource = {
  publisher: 'Ministry of Industry and Information Technology of the PRC',
  title: '2024 characteristic SME industrial cluster list',
  url: 'https://www.miit.gov.cn/',
  publishedAt: '2024-09-20',
};

const HS64: ChinaFactorySource = {
  publisher: 'United Nations Statistics Division',
  title: 'HS 2012 classification detail, code 64: Footwear',
  url: 'https://unstats.un.org/unsd/classifications/Econ/Structure/Detail/EN/32/64',
  publishedAt: null,
};

export const CHINA_FACTORY_CLUSTERS: readonly ChinaFactoryCluster[] = [
  {
    id: 'gd-huidong-footwear',
    name: 'Huidong footwear cluster',
    province: 'Guangdong',
    city: 'Huizhou',
    countyOrDistrict: 'Huidong',
    productDescription: 'Footwear and related parts',
    clusterEvidence: 'OBSERVED_OFFICIAL',
    source: MIIT_2024,
    hsMappings: [{ hs2: '64', label: 'Footwear; gaiters and the like', evidence: 'OBSERVED_OFFICIAL', source: HS64 }],
    statisticsEligible: true,
    statisticsEligibilityReason: 'Reviewed HS 64 mapping exists; Comtrade remains national reporter 156.',
  },
  {
    id: 'zj-yiwu-small-commodities',
    name: 'Yiwu small-commodities reference',
    province: 'Zhejiang',
    city: 'Jinhua',
    countyOrDistrict: 'Yiwu',
    productDescription: 'Mixed small commodities',
    clusterEvidence: 'OBSERVED_OFFICIAL',
    source: MIIT_2024,
    hsMappings: [],
    statisticsEligible: false,
    statisticsEligibilityReason: 'No reviewed HS mapping. Name match must not join national Comtrade.',
  },
];

export function chinaFactoryClusterById(id: string): ChinaFactoryCluster | undefined {
  return CHINA_FACTORY_CLUSTERS.find((cluster) => cluster.id === id);
}

/**
 * A Comtrade row is per-flow and per-partner. `flowCode` and `partnerCode` are
 * required because without them a caller that sums `tradeValueUsd` would add
 * imports to exports and every bilateral partner on top of the world-total row,
 * then present the inflated figure under an OBSERVED_OFFICIAL label.
 */
export type ChinaFactoryTradeRecord = {
  reporterCode: string;
  cmdCode: string;
  year: number;
  tradeValueUsd: number;
  /** Comtrade flow: 'X'/'2' export, 'M'/'1' import. */
  flowCode: string;
  /** Comtrade partner; '0'/'000' is the world aggregate. */
  partnerCode: string;
};

export type ChinaFactoryTradeQuery = {
  year?: number;
  /** Restrict to one direction. Omit to accept either, still world-total only. */
  flowCode?: string;
};

/** Two-digit HS chapter for a Comtrade commodity code, or '' when not derivable. */
function hsChapterOf(cmdCode: string): string {
  const digits = String(cmdCode).replace(/\D/g, '');
  if (!digits) return '';
  // A 1-digit code is an unpadded chapter (Comtrade emits '4' as well as '04').
  return digits.length === 1 ? digits.padStart(2, '0') : digits.slice(0, 2);
}

export function selectObservedChinaFactoryTrade(
  records: readonly ChinaFactoryTradeRecord[],
  cluster: ChinaFactoryCluster,
  query: ChinaFactoryTradeQuery | number = {},
): ChinaFactoryTradeRecord[] {
  if (!cluster.statisticsEligible) return [];
  const { year, flowCode } = typeof query === 'number' ? { year: query, flowCode: undefined } : query;
  const allowed = new Set(cluster.hsMappings.map((item) => item.hs2));
  return records.filter((record) => {
    const reporter = String(record.reporterCode);
    if (reporter !== '156' && reporter !== 'CHN') return false;
    if (!allowed.has(hsChapterOf(record.cmdCode))) return false;
    // World-total rows only: the same rule TradePolicyPanel already applies
    // when deduping Comtrade flows for display.
    const partner = String(record.partnerCode);
    if (partner !== '0' && partner !== '000') return false;
    if (flowCode != null && String(record.flowCode) !== flowCode) return false;
    if (year != null && record.year !== year) return false;
    return Number.isFinite(record.tradeValueUsd);
  });
}
