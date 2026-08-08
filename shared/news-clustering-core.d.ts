export type ThreatLevel = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type EventCategory =
  | 'conflict' | 'protest' | 'disaster' | 'diplomatic' | 'economic'
  | 'terrorism' | 'cyber' | 'health' | 'environmental' | 'military'
  | 'crime' | 'infrastructure' | 'tech' | 'general';

export interface ThreatClassification {
  level: ThreatLevel;
  category: EventCategory;
  confidence: number;
  source: 'keyword' | 'ml' | 'llm';
}

export interface NewsItemCore {
  source: string;
  title: string;
  link: string;
  pubDate: Date;
  isAlert: boolean;
  monitorColor?: string;
  tier?: number;
  threat?: ThreatClassification;
  lat?: number;
  lon?: number;
  locationName?: string;
  lang?: string;
  pubDateMissing?: boolean;
}

export type NewsItemWithTier = NewsItemCore & { tier: number };

export interface ClusteredEventCore {
  id: string;
  primaryTitle: string;
  primarySource: string;
  primaryLink: string;
  sourceCount: number;
  topSources: Array<{ name: string; tier: number; url: string }>;
  allItems: NewsItemCore[];
  firstSeen: Date;
  lastUpdated: Date;
  isAlert: boolean;
  monitorColor?: string;
  velocity?: { sourcesPerHour?: number };
  threat?: ThreatClassification;
  lat?: number;
  lon?: number;
  lang?: string;
}

export declare const MAX_CLUSTER_NEWS_ITEMS: number;

export declare const PROTO_TO_THREAT_LEVEL: Record<string, ThreatLevel>;

export declare function protoThreatLevelToLabel(value: string | undefined): ThreatLevel;

export declare function effectivePubDateMs(item: {
  pubDate: Date | string | number;
  pubDateMissing?: boolean;
}): number;

export declare function aggregateThreats(
  items: Array<{ threat?: ThreatClassification; tier?: number }>
): ThreatClassification;

export declare function clusterNewsCore(
  items: NewsItemCore[],
  getSourceTier: (source: string) => number
): ClusteredEventCore[];

export declare function topClusterKeywords(
  cluster: Pick<ClusteredEventCore, 'allItems'>,
  limit?: number
): string[];
