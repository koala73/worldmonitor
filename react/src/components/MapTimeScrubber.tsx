'use client';

import { useEffect, useMemo, useRef } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Flash,
  Time,
  ZoomIn,
  ZoomOut,
} from '@carbon/icons-react';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Text } from '@astryxdesign/core/Text';

import { loadTimelineCtor } from '../lib/load-timelinejs';
import {
  AI_FOOTPRINT_ALIASES,
  isAliasActive,
} from '../lib/ai-stack-aliases';
import { getOverlayDef } from '../lib/layers';
import {
  buildScrubberTimelineData,
  formatScrubberLabel,
  landmarksForLayers,
  slideIdToFocusMs,
  timeWindowStartMs,
} from '../lib/time-scrubber';
import type { LayerKey, LayerMap, TimeRange } from '../lib/url-state';

type TimelineInstance = {
  on: (event: string, cb: (data?: unknown) => void) => void;
  goToId: (id: string) => void;
  goToEnd: () => void;
  zoomIn?: () => void;
  zoomOut?: () => void;
  current_id?: string;
};

/** Stable key so Timeline rebuilds when the landmark-driving layer set changes. */
function layersLandmarkKey(layers: LayerMap): string {
  return landmarksForLayers(layers)
    .map((l) => l.id)
    .join('|');
}

/** Ordered playhead stops on the TimeNav (named dots + Live as null). */
function timelineFocusStops(
  timeRange: TimeRange,
  now: number,
  layers: LayerMap,
): Array<number | null> {
  const data = buildScrubberTimelineData(timeRange, now, layers);
  const liveId = data.events[data.events.length - 1]!.unique_id;
  return data.events.map((e) => slideIdToFocusMs(e.unique_id, liveId));
}

function stopIndex(
  stops: Array<number | null>,
  timeFocus: number | null,
): number {
  if (timeFocus == null) return Math.max(0, stops.length - 1);
  const exact = stops.findIndex((s) => s === timeFocus);
  if (exact >= 0) return exact;
  // Between dots (e.g. after a short-window tick): nearest at-or-before
  let best = 0;
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i];
    if (s != null && s <= timeFocus) best = i;
  }
  return best;
}

/**
 * Chrome title = overlay section / layer name (not the scrub-dot headline).
 * Prefer active A–D pillar label; else the AI layer driving the timeline.
 */
function scrubberOverlayTitle(layers: LayerMap): string | null {
  const activeAlias = AI_FOOTPRINT_ALIASES.find((a) => isAliasActive(a, layers));
  if (activeAlias) return activeAlias.label;

  const driving: LayerKey[] = [];
  if (layers.datacenters) driving.push('datacenters');
  if (layers.techHQs || layers.convoHotspots || layers.aiUsage) {
    if (layers.techHQs) driving.push('techHQs');
    if (layers.convoHotspots) driving.push('convoHotspots');
    if (layers.aiUsage) driving.push('aiUsage');
  }
  if (layers.startupHubs || layers.accelerators) {
    if (layers.startupHubs) driving.push('startupHubs');
    if (layers.accelerators) driving.push('accelerators');
  }
  if (layers.aiPolicy) driving.push('aiPolicy');
  if (layers.techEvents) driving.push('techEvents');
  if (layers.cloudRegions && driving.length === 0) driving.push('cloudRegions');

  const unique = [...new Set(driving)];
  if (unique.length === 0) return null;
  return unique.map((k) => getOverlayDef(k).label).join(' · ');
}

/**
 * Map time scrubber — TimelineJS TimeNav + Astryx/Carbon chrome.
 * Named markers come from checked AI overlays only; Live always present.
 * Step arrows move to the previous / next TimeNav dot.
 */
export function MapTimeScrubber({
  timeRange,
  timeFocus,
  onTimeFocus,
  layers,
}: {
  timeRange: TimeRange;
  timeFocus: number | null;
  onTimeFocus: (ms: number | null) => void;
  layers: LayerMap;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const timelineRef = useRef<TimelineInstance | null>(null);
  const liveIdRef = useRef<string>('');
  const applyingRef = useRef(false);
  const onFocusRef = useRef(onTimeFocus);
  onFocusRef.current = onTimeFocus;

  const landmarkKey = layersLandmarkKey(layers);
  const now = useMemo(() => Date.now(), [timeRange, landmarkKey]);
  const scrubberStart = timeWindowStartMs(timeRange, now, layers);
  const stops = useMemo(
    () => timelineFocusStops(timeRange, now, layers),
    [timeRange, now, landmarkKey, layers],
  );
  const index = stopIndex(stops, timeFocus);
  const isLive = timeFocus == null;
  const value =
    timeFocus == null
      ? now
      : Math.min(Math.max(timeFocus, scrubberStart), now);
  const overlayTitle = scrubberOverlayTitle(layers);
  const valueLabel = isLive
    ? 'Live'
    : (overlayTitle ?? formatScrubberLabel(value, timeRange));
  const atFirst = index <= 0;
  const atLive = isLive || index >= stops.length - 1;

  // Drop focus if the marker set no longer includes it (layer unchecked).
  useEffect(() => {
    if (timeFocus == null) return;
    const active = landmarksForLayers(layers);
    if (active.some((l) => l.ms === timeFocus)) return;
    // Short-window step ticks are not named landmarks — keep focus.
    if (timeRange !== 'all') return;
    onTimeFocus(null);
  }, [landmarkKey, timeFocus, timeRange, layers, onTimeFocus]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let cancelled = false;

    void (async () => {
      const Timeline = await loadTimelineCtor();
      if (cancelled || !hostRef.current) return;

      host.replaceChildren();
      const mount = document.createElement('div');
      mount.className = 'wm-map-time-scrubber-tl';
      host.appendChild(mount);

      const data = buildScrubberTimelineData(timeRange, now, layers);
      const liveId = data.events[data.events.length - 1]!.unique_id;
      liveIdRef.current = liveId;

      const timeline = new Timeline(mount, data, {
        hash_bookmark: false,
        start_at_end: true,
        timenav_height: 100,
        timenav_height_min: 80,
        marker_height_min: 20,
        marker_padding: 4,
        scale_factor: 1,
        initial_zoom: 2,
        language: 'en',
      }) as TimelineInstance;

      if (cancelled) {
        host.replaceChildren();
        return;
      }

      timelineRef.current = timeline;

      const onChange = (payload?: unknown) => {
        if (applyingRef.current) return;
        const id =
          payload && typeof payload === 'object' && 'unique_id' in payload
            ? String((payload as { unique_id: string }).unique_id)
            : (timeline.current_id ?? liveId);
        onFocusRef.current(slideIdToFocusMs(id, liveId));
      };

      timeline.on('change', onChange);
    })();

    return () => {
      cancelled = true;
      timelineRef.current = null;
      host.replaceChildren();
    };
  }, [timeRange, now, landmarkKey, layers]);

  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) return;
    const liveId = liveIdRef.current;
    applyingRef.current = true;
    try {
      if (timeFocus == null) {
        timeline.goToEnd();
      } else {
        timeline.goToId(`t-${timeFocus}`);
      }
    } catch {
      try {
        timeline.goToId(liveId);
      } catch {
        /* ignore */
      }
    }
    queueMicrotask(() => {
      applyingRef.current = false;
    });
  }, [timeFocus, timeRange, landmarkKey]);

  const goToStop = (nextFocus: number | null) => {
    const timeline = timelineRef.current;
    const liveId = liveIdRef.current;
    onTimeFocus(nextFocus);
    if (!timeline) return;
    applyingRef.current = true;
    try {
      if (nextFocus == null) {
        timeline.goToEnd();
      } else {
        timeline.goToId(`t-${nextFocus}`);
      }
    } catch {
      try {
        timeline.goToId(liveId);
      } catch {
        /* ignore */
      }
    }
    queueMicrotask(() => {
      applyingRef.current = false;
    });
  };

  const goRelative = (dir: -1 | 1) => {
    if (stops.length === 0) return;
    const next = Math.min(Math.max(index + dir, 0), stops.length - 1);
    if (next === index) return;
    goToStop(stops[next] ?? null);
  };

  return (
    <div
      className="wm-map-time-scrubber"
      role="group"
      aria-label="Map time scrubber"
    >
      <div className="wm-map-time-scrubber-chrome">
        <div className="wm-map-time-scrubber-actions">
          <IconButton
            label="Zoom in"
            tooltip="Zoom in timeline"
            size="sm"
            variant="ghost"
            icon={<Icon icon={ZoomIn} size="sm" />}
            onClick={() => timelineRef.current?.zoomIn?.()}
          />
          <IconButton
            label="Zoom out"
            tooltip="Zoom out timeline"
            size="sm"
            variant="ghost"
            icon={<Icon icon={ZoomOut} size="sm" />}
            onClick={() => timelineRef.current?.zoomOut?.()}
          />
          <IconButton
            label="Earlier"
            tooltip="Previous timeline marker"
            size="sm"
            variant="ghost"
            icon={<Icon icon={ChevronLeft} size="sm" />}
            onClick={() => goRelative(-1)}
            isDisabled={atFirst}
          />
          <IconButton
            label="Later"
            tooltip="Next timeline marker"
            size="sm"
            variant="ghost"
            icon={<Icon icon={ChevronRight} size="sm" />}
            onClick={() => goRelative(1)}
            isDisabled={atLive}
          />
          <IconButton
            label="Live"
            tooltip="Jump to live end"
            size="sm"
            variant={isLive ? 'secondary' : 'ghost'}
            icon={
              <Icon
                icon={Flash}
                size="sm"
                color={isLive ? 'accent' : 'inherit'}
              />
            }
            onClick={() => goToStop(null)}
            isDisabled={isLive}
          />
        </div>
        <div className="wm-map-time-scrubber-label">
          <Icon icon={Time} size="sm" color="inherit" />
          <Text type="label" color="inherit">
            {timeRange}
          </Text>
          <Text type="label" color="inherit">{valueLabel}</Text>
        </div>
      </div>
      <div className="wm-map-time-scrubber-nav" ref={hostRef} />
    </div>
  );
}
