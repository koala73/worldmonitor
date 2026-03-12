import type { ClusteredEvent } from '@/types';
import { inferGeoHubsFromTitle, type GeoHubLocation } from './geo-hub-index';
import { deriveHubActivityLevel, deriveHubTrend, normalizeHubScore } from './hub-activity-scoring';

export interface GeoHubActivity {
  hubId: string;
  name: string;
  region: string;
  country: string;
  lat: number;
  lon: number;
  type: 'capital' | 'conflict' | 'strategic' | 'organization';
  tier: 'critical' | 'major' | 'notable';
  activityLevel: 'high' | 'elevated' | 'low';
  score: number;
  newsCount: number;
  hasBreaking: boolean;
  topStories: Array<{ title: string; link: string }>;
  trend: 'rising' | 'stable' | 'falling';
  matchedKeywords: string[];
}

interface HubAccumulator {
  hub: GeoHubLocation;
  clusters: ClusteredEvent[];
  matchedKeywords: Set<string>;
  totalVelocity: number;
  hasBreaking: boolean;
}

const TIER_BONUS: Record<string, number> = {
  critical: 20,
  major: 10,
  notable: 0,
};

const TYPE_BONUS: Record<string, number> = {
  conflict: 15,
  strategic: 10,
  capital: 5,
  organization: 5,
};

export function aggregateGeoActivity(clusters: ClusteredEvent[]): GeoHubActivity[] {
  const hubAccumulators = new Map<string, HubAccumulator>();

  for (const cluster of clusters) {
    const matches = inferGeoHubsFromTitle(cluster.primaryTitle);

    for (const match of matches) {
      if (match.confidence < 0.5) continue;

      let acc = hubAccumulators.get(match.hubId);
      if (!acc) {
        acc = {
          hub: match.hub,
          clusters: [],
          matchedKeywords: new Set(),
          totalVelocity: 0,
          hasBreaking: false,
        };
        hubAccumulators.set(match.hubId, acc);
      }

      acc.clusters.push(cluster);
      acc.matchedKeywords.add(match.matchedKeyword);

      if (cluster.velocity?.sourcesPerHour) {
        acc.totalVelocity += cluster.velocity.sourcesPerHour;
      }

      if (cluster.isAlert) {
        acc.hasBreaking = true;
      }
    }
  }

  const rawScores: Array<{ hubId: string; acc: HubAccumulator; rawScore: number }> = [];
  let maxRawScore = 0;

  for (const [hubId, acc] of hubAccumulators) {
    const newsCount = acc.clusters.length;
    const tierBonus = TIER_BONUS[acc.hub.tier] || 0;
    const typeBonus = TYPE_BONUS[acc.hub.type] || 0;

    const rawScore =
      newsCount * 10 +
      (acc.hasBreaking ? 25 : 0) +
      acc.totalVelocity * 3 +
      tierBonus +
      typeBonus;

    rawScores.push({ hubId, acc, rawScore });
    maxRawScore = Math.max(maxRawScore, rawScore);
  }

  const activities: GeoHubActivity[] = [];

  for (const { hubId, acc, rawScore } of rawScores) {
    const newsCount = acc.clusters.length;

    const score = normalizeHubScore(rawScore, maxRawScore);
    const activityLevel = deriveHubActivityLevel(score, acc.hasBreaking);

    const topStories = acc.clusters
      .slice(0, 3)
      .map(c => ({ title: c.primaryTitle, link: c.primaryLink }));

    const trend = deriveHubTrend(acc.totalVelocity, newsCount);

    activities.push({
      hubId,
      name: acc.hub.name,
      region: acc.hub.region,
      country: acc.hub.country,
      lat: acc.hub.lat,
      lon: acc.hub.lon,
      type: acc.hub.type,
      tier: acc.hub.tier,
      activityLevel,
      score,
      newsCount,
      hasBreaking: acc.hasBreaking,
      topStories,
      trend,
      matchedKeywords: Array.from(acc.matchedKeywords),
    });
  }

  activities.sort((a, b) => b.score - a.score);

  return activities;
}

export function getTopActiveGeoHubs(clusters: ClusteredEvent[], limit = 10): GeoHubActivity[] {
  return aggregateGeoActivity(clusters).slice(0, limit);
}

export function getGeoHubActivity(hubId: string, clusters: ClusteredEvent[]): GeoHubActivity | undefined {
  const activities = aggregateGeoActivity(clusters);
  return activities.find(a => a.hubId === hubId);
}
