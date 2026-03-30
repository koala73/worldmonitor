export type EvidenceVerdict = 'reported' | 'corroborated' | 'actionable';
export type EvidenceFreshness = 'fresh' | 'recent' | 'stale';
export type ActionThreshold = 'monitor' | 'verify' | 'act';
export type EvidenceSourceKind = 'news' | 'market' | 'prediction' | 'system';
export type EvidenceSourceType =
  | 'wire'
  | 'gov'
  | 'intel'
  | 'mainstream'
  | 'market'
  | 'prediction'
  | 'system'
  | 'tech'
  | 'other';

export interface EvidenceSource {
  name: string;
  tier: number;
  url?: string;
  kind: EvidenceSourceKind;
  type: EvidenceSourceType;
}

export interface EvidencePack {
  claim: string;
  verdict: EvidenceVerdict;
  freshness: EvidenceFreshness;
  supportingSources: EvidenceSource[];
  conflictingSources: EvidenceSource[];
  corroborationCount: number;
  trustedSourceCount: number;
  sourceDiversity: number;
  confidenceReason: string;
  actionThreshold: ActionThreshold;
  firstSeen: Date;
  lastUpdated: Date;
}

interface EvidencePackInput {
  claim: string;
  confidence: number;
  timestamp?: Date;
  firstSeen?: Date;
  lastUpdated?: Date;
  supportingSources?: EvidenceSource[];
  conflictingSources?: EvidenceSource[];
  confidenceReason?: string;
  actionThreshold?: ActionThreshold;
}

interface ClusterEvidenceInput {
  primaryTitle: string;
  topSources: { name: string; tier: number; url: string }[];
  firstSeen: Date;
  lastUpdated: Date;
}

interface BreakingAlertEvidenceInput {
  headline: string;
  source: string;
  link?: string;
  threatLevel: 'critical' | 'high';
  timestamp: Date;
  origin: 'rss_alert' | 'keyword_spike' | 'hotspot_escalation' | 'military_surge';
}

const FRESH_WINDOW_MS = 6 * 60 * 60 * 1000;
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

function clampTier(tier: number | undefined): number {
  if (!Number.isFinite(tier)) return 4;
  return Math.min(4, Math.max(1, Math.round(tier as number)));
}

function normalizeSource(source: EvidenceSource): EvidenceSource {
  return {
    ...source,
    tier: clampTier(source.tier),
    kind: source.kind ?? 'news',
    type: source.type ?? 'other',
  };
}

function dedupeSources(sources: EvidenceSource[] = []): EvidenceSource[] {
  const unique = new Map<string, EvidenceSource>();
  for (const source of sources) {
    const normalized = normalizeSource(source);
    const key = `${normalized.kind}:${normalized.name}:${normalized.url ?? ''}`;
    if (!unique.has(key)) {
      unique.set(key, normalized);
    }
  }
  return [...unique.values()];
}

function classifyFreshness(lastUpdated: Date, now = new Date()): EvidenceFreshness {
  const ageMs = now.getTime() - lastUpdated.getTime();
  if (ageMs <= FRESH_WINDOW_MS) return 'fresh';
  if (ageMs <= RECENT_WINDOW_MS) return 'recent';
  return 'stale';
}

function getTrustedSourceCount(sources: EvidenceSource[]): number {
  return sources.filter((source) => source.tier <= 2 || source.kind === 'market' || source.kind === 'prediction').length;
}

function getSourceDiversity(sources: EvidenceSource[]): number {
  return new Set(sources.map((source) => `${source.kind}:${source.type}`)).size;
}

function deriveThreshold(
  confidence: number,
  supportingSources: EvidenceSource[],
  conflictingSources: EvidenceSource[],
  explicitThreshold?: ActionThreshold,
): ActionThreshold {
  if (explicitThreshold) return explicitThreshold;
  if (conflictingSources.length > 0) return 'verify';

  const trustedSourceCount = getTrustedSourceCount(supportingSources);
  if (confidence >= 0.85 && trustedSourceCount >= 1 && supportingSources.length >= 1) return 'act';
  if (confidence >= 0.7 || trustedSourceCount >= 1 || supportingSources.length >= 2) return 'verify';
  return 'monitor';
}

function deriveVerdict(
  threshold: ActionThreshold,
  confidence: number,
  supportingSources: EvidenceSource[],
  conflictingSources: EvidenceSource[],
): EvidenceVerdict {
  const trustedSourceCount = getTrustedSourceCount(supportingSources);
  const corroborated = confidence >= 0.75 || trustedSourceCount >= 1 || supportingSources.length >= 2;

  if (threshold === 'act' && corroborated && conflictingSources.length === 0) return 'actionable';
  if (corroborated) return 'corroborated';
  return 'reported';
}

function buildEvidencePack(input: EvidencePackInput, now = new Date()): EvidencePack {
  const supportingSources = dedupeSources(input.supportingSources);
  const conflictingSources = dedupeSources(input.conflictingSources);
  const lastUpdated = input.lastUpdated ?? input.timestamp ?? now;
  const firstSeen = input.firstSeen ?? lastUpdated;
  const threshold = deriveThreshold(input.confidence, supportingSources, conflictingSources, input.actionThreshold);

  return {
    claim: input.claim,
    verdict: deriveVerdict(threshold, input.confidence, supportingSources, conflictingSources),
    freshness: classifyFreshness(lastUpdated, now),
    supportingSources,
    conflictingSources,
    corroborationCount: supportingSources.length,
    trustedSourceCount: getTrustedSourceCount(supportingSources),
    sourceDiversity: getSourceDiversity(supportingSources),
    confidenceReason: input.confidenceReason ?? 'Confidence derived from supporting evidence and recency.',
    actionThreshold: threshold,
    firstSeen,
    lastUpdated,
  };
}

export function buildClusterEvidencePack(input: ClusterEvidenceInput, now = new Date()): EvidencePack {
  const supportingSources = input.topSources.map((source) => ({
    name: source.name,
    tier: source.tier,
    url: source.url,
    kind: 'news' as const,
    type: 'other' as const,
  }));

  return buildEvidencePack({
    claim: input.primaryTitle,
    confidence: Math.min(0.9, 0.45 + supportingSources.length * 0.12),
    firstSeen: input.firstSeen,
    lastUpdated: input.lastUpdated,
    supportingSources,
    actionThreshold: 'verify',
    confidenceReason: supportingSources.length >= 2
      ? `${supportingSources.length} sources independently reported the same cluster.`
      : 'Single-source report; verification still needed.',
  }, now);
}

export function buildSignalEvidencePack(input: EvidencePackInput, now = new Date()): EvidencePack {
  return buildEvidencePack(input, now);
}

export function buildBreakingAlertEvidencePack(
  alert: BreakingAlertEvidenceInput,
  sourceTier = 4,
  sourceType: EvidenceSourceType = 'other',
  now = new Date(),
): EvidencePack {
  const supportingSources: EvidenceSource[] = [
    {
      name: alert.source,
      tier: sourceTier,
      url: alert.link,
      kind: 'news',
      type: sourceType,
    },
  ];

  const isTrustedSource = clampTier(sourceTier) <= 2;
  const actionThreshold: ActionThreshold = alert.threatLevel === 'critical' && isTrustedSource ? 'act' : 'verify';
  let confidence = 0.7;
  if (alert.threatLevel === 'critical') {
    confidence = isTrustedSource ? 0.92 : 0.78;
  } else if (isTrustedSource) {
    confidence = 0.84;
  }

  return buildEvidencePack({
    claim: alert.headline,
    confidence,
    timestamp: alert.timestamp,
    supportingSources,
    actionThreshold,
    confidenceReason: `${alert.origin.replace(/_/g, ' ')} from ${alert.source}${isTrustedSource ? ' with trusted-source weighting.' : '.'}`,
  }, now);
}
