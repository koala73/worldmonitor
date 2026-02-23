declare const process: { env: Record<string, string | undefined> };

import type {
  UnrestEvent,
  UnrestEventType,
  SeverityLevel,
} from '../../../../src/generated/server/worldmonitor/unrest/v1/service_server';

// ========================================================================
// API URLs
// ========================================================================

export const ACLED_API_URL = 'https://acleddata.com/api/acled/read';
export const GDELT_GEO_URL = 'https://api.gdeltproject.org/api/v2/geo/geo';

// ========================================================================
// ACLED Event Type Mapping (ported from src/services/protests.ts lines 39-46)
// ========================================================================

export function mapAcledEventType(eventType: string, subEventType: string): UnrestEventType {
  const lower = (eventType + ' ' + subEventType).toLowerCase();
  if (lower.includes('riot') || lower.includes('mob violence'))
    return 'UNREST_EVENT_TYPE_RIOT';
  if (lower.includes('strike'))
    return 'UNREST_EVENT_TYPE_STRIKE';
  if (lower.includes('demonstration'))
    return 'UNREST_EVENT_TYPE_DEMONSTRATION';
  if (lower.includes('protest'))
    return 'UNREST_EVENT_TYPE_PROTEST';
  return 'UNREST_EVENT_TYPE_CIVIL_UNREST';
}

// ========================================================================
// Severity Classification (ported from src/services/protests.ts lines 49-53)
// ========================================================================

export function classifySeverity(fatalities: number, eventType: string): SeverityLevel {
  if (fatalities > 0 || eventType.toLowerCase().includes('riot'))
    return 'SEVERITY_LEVEL_HIGH';
  if (eventType.toLowerCase().includes('protest'))
    return 'SEVERITY_LEVEL_MEDIUM';
  return 'SEVERITY_LEVEL_LOW';
}

// ========================================================================
// GDELT Classifiers
// ========================================================================

export function classifyGdeltSeverity(count: number, name: string): SeverityLevel {
  const lowerName = name.toLowerCase();
  if (count > 100 || lowerName.includes('riot') || lowerName.includes('clash'))
    return 'SEVERITY_LEVEL_HIGH';
  if (count < 25)
    return 'SEVERITY_LEVEL_LOW';
  return 'SEVERITY_LEVEL_MEDIUM';
}

export function classifyGdeltEventType(name: string): UnrestEventType {
  const lowerName = name.toLowerCase();
  if (lowerName.includes('riot')) return 'UNREST_EVENT_TYPE_RIOT';
  if (lowerName.includes('strike')) return 'UNREST_EVENT_TYPE_STRIKE';
  if (lowerName.includes('demonstration')) return 'UNREST_EVENT_TYPE_DEMONSTRATION';
  return 'UNREST_EVENT_TYPE_PROTEST';
}

// ========================================================================
// Deduplication (ported from src/services/protests.ts lines 226-258)
// ========================================================================

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
      unique.set(key, event);
    } else {
      // Merge: prefer ACLED (higher confidence), combine sources
      if (
        event.sourceType === 'UNREST_SOURCE_TYPE_ACLED' &&
        existing.sourceType !== 'UNREST_SOURCE_TYPE_ACLED'
      ) {
        event.sources = [...new Set([...event.sources, ...existing.sources])];
        unique.set(key, event);
      } else if (existing.sourceType === 'UNREST_SOURCE_TYPE_ACLED') {
        existing.sources = [...new Set([...existing.sources, ...event.sources])];
      } else {
        // Both GDELT: combine sources, upgrade confidence if 2+ sources
        existing.sources = [...new Set([...existing.sources, ...event.sources])];
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

