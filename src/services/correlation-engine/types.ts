// Core types for the correlation engine

// boundary-ignore: AppContext is an aggregate type that lives in app/ by design
import type { AppContext } from '@/app/app-context';

export type CorrelationDomain = 'military' | 'escalation' | 'economic' | 'disaster';
export type TrendDirection = 'escalating' | 'stable' | 'de-escalating';

export interface SignalEvidence {
  type: string;
  source: string;
  severity: number;       // 0-100
  lat?: number;
  lon?: number;
  country?: string;       // ISO2
  timestamp: number;
  label: string;
  rawData?: unknown;
}

export interface ConvergenceCard {
  id: string;
  domain: CorrelationDomain;
  title: string;
  score: number;           // 0-100 composite
  signals: SignalEvidence[];
  location?: { lat: number; lon: number; label: string };
  countries: string[];     // ISO2 codes
  trend: TrendDirection;
  timestamp: number;
  assessment?: string;     // LLM narrative (async fill)
}

export type ClusterMode = 'geographic' | 'country' | 'entity';

export interface DomainAdapter {
  domain: CorrelationDomain;
  label: string;
  clusterMode: ClusterMode;
  spatialRadius: number;    // km, 0 = entity-match only
  timeWindow: number;       // hours
  threshold: number;        // minimum score to emit card
  weights: Record<string, number>;
  collectSignals(ctx: AppContext): SignalEvidence[];
  generateTitle(cluster: SignalEvidence[], context?: { entityKey?: string; country?: string }): string;
}

export interface ClusterState {
  key: string;
  centroidLat?: number;
  centroidLon?: number;
  country?: string;
  entityKey?: string;
  score: number;
  timestamp: number;
}
