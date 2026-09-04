import type { UnrestEvent } from '../../../../src/generated/server/worldmonitor/unrest/v1/service_server';

// ========================================================================
// Deduplication (ported from src/services/protests.ts lines 226-258)
// ========================================================================

const MAX_SOURCE_URLS = 5;

export function mergeSourceUrls(...groups: Array<string[] | undefined>): string[] {
  return [
    ...new Set(groups.flatMap((group) => group ?? []).filter((url): url is string => typeof url === 'string' && url.length > 0)),
  ].slice(0, MAX_SOURCE_URLS);
}

export function deduplicateEvents(events: UnrestEvent[]): UnrestEvent[] {
  const unique = new Map<string, UnrestEvent>();

  for (const event of events) {
    const lat = event.location?.latitude ?? 0;
    const lon = event.location?.longitude ?? 0;
    const latKey = Math.round(lat * 10) / 10;
    const lonKey = Math.round(lon * 10) / 10;
    const dateKey = new Date(event.occurredAt).toISOString().split('T')[0];
    const key = `${latKey}:${lonKey}:${dateKey}`;

    const existing = unique.get(key);
    if (!existing) {
      event.sourceUrls = mergeSourceUrls(event.sourceUrls);
      unique.set(key, event);
    } else {
      // Merge: prefer ACLED (higher confidence), combine sources
      if (
        event.sourceType === 'UNREST_SOURCE_TYPE_ACLED' &&
        existing.sourceType !== 'UNREST_SOURCE_TYPE_ACLED'
      ) {
        event.sources = [...new Set([...event.sources, ...existing.sources])];
        event.sourceUrls = mergeSourceUrls(event.sourceUrls, existing.sourceUrls);
        unique.set(key, event);
      } else if (existing.sourceType === 'UNREST_SOURCE_TYPE_ACLED') {
        existing.sources = [...new Set([...existing.sources, ...event.sources])];
        existing.sourceUrls = mergeSourceUrls(existing.sourceUrls, event.sourceUrls);
      } else {
        // Both GDELT: combine sources, upgrade confidence if 2+ sources
        existing.sources = [...new Set([...existing.sources, ...event.sources])];
        existing.sourceUrls = mergeSourceUrls(existing.sourceUrls, event.sourceUrls);
        if (existing.sources.length >= 2) {
          existing.confidence = 'CONFIDENCE_LEVEL_HIGH';
        }
      }
    }
  }

  return Array.from(unique.values());
}

// ========================================================================
// Sort (ported from src/services/protests.ts lines 262-273)
// ========================================================================

export function sortBySeverityAndRecency(events: UnrestEvent[]): UnrestEvent[] {
  const severityOrder: Record<string, number> = {
    SEVERITY_LEVEL_HIGH: 0,
    SEVERITY_LEVEL_MEDIUM: 1,
    SEVERITY_LEVEL_LOW: 2,
    SEVERITY_LEVEL_UNSPECIFIED: 3,
  };

  return events.sort((a, b) => {
    const sevDiff =
      (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3);
    if (sevDiff !== 0) return sevDiff;
    return b.occurredAt - a.occurredAt;
  });
}
