import type { NewsItem, ThreatLevel as ClientThreatLevel } from '@/types';
import type { NewsItem as ProtoNewsItem } from '@/generated/client/worldmonitor/news/v1/service_client';
import { protoThreatLevelToLabel } from '../../shared/news-clustering-core.js';

const PROTO_TO_CLIENT_PHASE: Record<string, import('@/types').StoryPhase> = {
  STORY_PHASE_BREAKING:   'breaking',
  STORY_PHASE_DEVELOPING: 'developing',
  STORY_PHASE_SUSTAINED:  'sustained',
  STORY_PHASE_FADING:     'fading',
};

export function protoItemToNewsItem(p: ProtoNewsItem): NewsItem {
  const level: ClientThreatLevel = protoThreatLevelToLabel(p.threat?.level);
  return {
    source: p.source,
    title: p.title,
    link: p.link,
    pubDate: new Date(p.publishedAt),
    isAlert: p.isAlert,
    importanceScore: p.importanceScore || undefined,
    credibilityScore: Number.isFinite(p.credibilityScore) ? p.credibilityScore : undefined,
    corroborationCount: p.corroborationCount || undefined,
    storyMeta: p.storyMeta && p.storyMeta.phase !== 'STORY_PHASE_UNSPECIFIED' ? {
      firstSeen:    p.storyMeta.firstSeen,
      mentionCount: p.storyMeta.mentionCount,
      sourceCount:  p.storyMeta.sourceCount,
      phase: PROTO_TO_CLIENT_PHASE[p.storyMeta.phase] ?? 'breaking',
    } : undefined,
    threat: p.threat ? {
      level,
      category: p.threat.category as import('@/services/threat-classifier').EventCategory,
      confidence: p.threat.confidence,
      source: (p.threat.source || 'keyword') as 'keyword' | 'ml' | 'llm',
    } : undefined,
    ...(p.locationName && { locationName: p.locationName }),
    ...(p.location && { lat: p.location.latitude, lon: p.location.longitude }),
    ...(p.importanceScore ? { importanceScore: p.importanceScore } : {}),
    ...(Number.isFinite(p.credibilityScore) ? { credibilityScore: p.credibilityScore } : {}),
    ...(p.corroborationCount ? { corroborationCount: p.corroborationCount } : {}),
    // Cleaned RSS description (U3 proto field 12). Only populated when the
    // upstream feed carried a usable <description>/<content:encoded>/<summary>;
    // empty string otherwise. Consumers render the headline and fall back to
    // snippet as a secondary line when non-empty.
    ...(p.snippet ? { snippet: p.snippet } : {}),
    // Ingest-extracted tickers (#4922a, proto field 13). Runtime guard on
    // top of the generated type: persisted last-good digests from before
    // the rollout carry items without the field.
    ...(p.tickers && p.tickers.length ? { tickers: p.tickers } : {}),
  };
}
