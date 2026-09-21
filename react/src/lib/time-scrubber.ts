/**
 * Map time scrubber window helpers — TimelineJS markers + span for Time presets.
 *
 * Named landmarks on Time · all come only from active overlay checkboxes
 * (see landmarksForLayers). Drawer does not list scrub points.
 */

import { AI_DC_GROWTH_LANDMARKS } from '@/config/ai-dc-growth-landmarks';
import { AI_CONVERSATION_GROWTH_LANDMARKS } from '@/config/ai-conversation-growth-landmarks';
import { AI_PRODUCT_GROWTH_LANDMARKS } from '@/config/ai-product-growth-landmarks';
import { aiTrendsGlobalAtMs } from '@/config/ai-trends-global';
import {
  AI_BOOM_START_MS,
  AI_ERA_LANDMARKS,
  AI_TIMELINE_LANDMARKS,
  formatAiEraLabel,
  type AiEraLandmark,
} from '@/config/ai-era-landmarks';
import type { LayerMap, TimeRange } from './url-state';

export {
  AI_BOOM_START_MS,
  AI_ERA_LANDMARKS,
  AI_TIMELINE_LANDMARKS,
} from '@/config/ai-era-landmarks';
export { AI_DC_GROWTH_LANDMARKS, AI_DC_GROWTH_START_MS } from '@/config/ai-dc-growth-landmarks';
export {
  AI_PRODUCT_GROWTH_LANDMARKS,
  AI_PRODUCT_GROWTH_START_MS,
} from '@/config/ai-product-growth-landmarks';
export {
  AI_CONVERSATION_GROWTH_LANDMARKS,
  AI_CONVERSATION_GROWTH_START_MS,
} from '@/config/ai-conversation-growth-landmarks';

const SPAN_MS: Record<TimeRange, number> = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '48h': 48 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  all: 30 * 24 * 60 * 60 * 1000,
};

const STEP_MS: Record<TimeRange, number> = {
  '1h': 5 * 60 * 1000,
  '6h': 15 * 60 * 1000,
  '24h': 60 * 60 * 1000,
  '48h': 2 * 60 * 60 * 1000,
  '7d': 6 * 60 * 60 * 1000,
  all: 30 * 24 * 60 * 60 * 1000,
};

/**
 * Timeline scrub points for currently checked AI overlays.
 * — datacenters → Epoch DC · year growth markers (Infrastructure)
 * — techHQs → Product / frontier eras (ChatGPT → …); HQs have no open dates (Live-only paint)
 * — convoHotspots → product eras (wiki/news/Trends/social Convo attention windows)
 * — aiUsage → OWID + WildChat usage/conversation waves (cited country shares)
 * — startupHubs / accelerators → open-kind eras
 * — cloudRegions → none (no cited open dates; Live density only)
 * — cyberThreats → (standalone overlay; not Policy pillar)
 * — aiPolicy → Policy countries (catalog; TimeNav policy eras when checked)
 *
 * Convo map density changes on product-era scrubs (when channel data exists).
 * AI Usage density changes on OWID / WildChat wave scrubs / Live.
 */
export function landmarksForLayers(
  layers: LayerMap | null | undefined,
): AiEraLandmark[] {
  if (!layers) return [];
  const out: AiEraLandmark[] = [];
  const seen = new Set<number>();

  const push = (lm: AiEraLandmark) => {
    if (seen.has(lm.ms)) return;
    seen.add(lm.ms);
    out.push(lm);
  };

  if (layers.datacenters) {
    for (const lm of AI_DC_GROWTH_LANDMARKS) push(lm);
  }

  if (layers.techHQs || layers.convoHotspots) {
    for (const lm of AI_PRODUCT_GROWTH_LANDMARKS) push(lm);
  }

  if (layers.aiUsage) {
    for (const lm of AI_CONVERSATION_GROWTH_LANDMARKS) push(lm);
  }

  for (const lm of AI_ERA_LANDMARKS) {
    const show =
      (lm.kind === 'open' && (layers.startupHubs || layers.accelerators)) ||
      (lm.kind === 'policy' && layers.aiPolicy);
    if (show) push(lm);
  }

  return out.sort((a, b) => a.ms - b.ms);
}

/** Earliest active landmark, else ChatGPT boom (fallback window origin). */
export function timelineStartMsForLayers(
  layers: LayerMap | null | undefined,
): number {
  const marks = landmarksForLayers(layers);
  if (marks.length === 0) return AI_BOOM_START_MS;
  return marks[0]!.ms;
}

export function timeWindowSpanMs(
  range: TimeRange,
  now = Date.now(),
  layers?: LayerMap | null,
): number {
  if (range === 'all') return Math.max(0, now - timelineStartMsForLayers(layers));
  return SPAN_MS[range];
}

export function timeWindowStepMs(range: TimeRange): number {
  return STEP_MS[range];
}

export function timeWindowStartMs(
  range: TimeRange,
  now = Date.now(),
  layers?: LayerMap | null,
): number {
  if (range === 'all') return timelineStartMsForLayers(layers);
  return now - SPAN_MS[range];
}

export function formatScrubberLabel(ms: number, range: TimeRange): string {
  const era = formatAiEraLabel(ms);
  if (era) return era;
  const d = new Date(ms);
  if (range === '1h' || range === '6h') {
    return d.toISOString().slice(11, 16) + 'Z';
  }
  if (range === '24h' || range === '48h') {
    return d.toISOString().slice(5, 16).replace('T', ' ') + 'Z';
  }
  if (range === 'all') {
    return d.toISOString().slice(0, 7);
  }
  return d.toISOString().slice(0, 10);
}

function toTlDate(ms: number) {
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}

export type TlEventSlide = {
  unique_id: string;
  start_date: ReturnType<typeof toTlDate>;
  text: { headline: string };
};

/**
 * Build TimelineJS events for the active overlay set + Live.
 * Named landmarks only when corresponding layer checkboxes are on.
 */
export function buildScrubberTimelineData(
  range: TimeRange,
  now = Date.now(),
  layers?: LayerMap | null,
) {
  const landmarks = landmarksForLayers(layers);
  const start = timeWindowStartMs(range, now, layers);
  const step = STEP_MS[range];
  const events: TlEventSlide[] = [];
  const landmarkIds = new Set<string>();

  for (const lm of landmarks) {
    if (lm.ms > now) continue;
    if (range !== 'all' && lm.ms < start) continue;
    const id = `t-${lm.ms}`;
    landmarkIds.add(id);
    const trends =
      layers?.convoHotspots || layers?.techHQs
        ? aiTrendsGlobalAtMs(lm.ms)
        : null;
    const headline =
      trends != null ? `${lm.headline} · Trends ${trends}` : lm.headline;
    events.push({
      unique_id: id,
      start_date: toTlDate(lm.ms),
      text: { headline },
    });
  }

  // Time · all: active landmarks + Live only.
  // Short ranges keep step ticks so scrubbing still has markers.
  if (range !== 'all') {
    let t = start;
    while (t < now - step / 2) {
      const id = `t-${t}`;
      const nearLandmark = landmarks.some(
        (lm) => Math.abs(t - lm.ms) <= step / 2,
      );
      if (!landmarkIds.has(id) && !nearLandmark) {
        events.push({
          unique_id: id,
          start_date: toTlDate(t),
          text: { headline: formatScrubberLabel(t, range) },
        });
      }
      t += step;
    }
  }

  events.push({
    unique_id: `t-${now}`,
    start_date: toTlDate(now),
    text: { headline: 'Live' },
  });

  events.sort(
    (a, b) =>
      Date.UTC(
        a.start_date.year,
        a.start_date.month - 1,
        a.start_date.day,
        a.start_date.hour,
        a.start_date.minute,
        a.start_date.second,
      ) -
      Date.UTC(
        b.start_date.year,
        b.start_date.month - 1,
        b.start_date.day,
        b.start_date.hour,
        b.start_date.minute,
        b.start_date.second,
      ),
  );

  return {
    title: {
      text: { headline: 'Map time', text: 'Scrub within the active window' },
    },
    events,
  };
}

export function slideIdToFocusMs(uniqueId: string, liveId: string): number | null {
  if (uniqueId === liveId) return null;
  const match = /^t-(\d+)$/.exec(uniqueId);
  if (!match) return null;
  const ms = Number.parseInt(match[1]!, 10);
  return Number.isFinite(ms) ? ms : null;
}
