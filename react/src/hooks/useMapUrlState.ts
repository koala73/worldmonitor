import { useCallback, useEffect, useState } from 'react';
import { landmarkForMs } from '@/config/ai-era-landmarks';
import {
  resolveInitialState,
  syncUrl,
  VIEW_PRESETS,
  type LayerKey,
  type LayerMap,
  type MapUrlState,
  type MapView,
  type TimeRange,
  layersFromKeys,
} from '../lib/url-state';

export function useMapUrlState() {
  const [state, setState] = useState<MapUrlState>(() =>
    resolveInitialState(typeof window !== 'undefined' ? window.location.search : ''),
  );

  useEffect(() => {
    syncUrl(state);
  }, [state]);

  const patch = useCallback((partial: Partial<MapUrlState>) => {
    setState((prev) => ({ ...prev, ...partial }));
  }, []);

  const setView = useCallback((view: MapView, zoom?: number) => {
    const preset = VIEW_PRESETS[view];
    setState((prev) => ({
      ...prev,
      view,
      lon: preset.lon,
      lat: preset.lat,
      zoom: zoom ?? preset.zoom,
    }));
  }, []);

  const setTimeRange = useCallback((timeRange: TimeRange) => {
    setState((prev) => ({ ...prev, timeRange, timeFocus: null }));
  }, []);

  const setTimeFocus = useCallback((timeFocus: number | null) => {
    setState((prev) => ({ ...prev, timeFocus }));
  }, []);

  /**
   * Scrubber seek: set focus; switch to Time · all for named landmarks.
   * Does not change overlay checkboxes — markers are driven by layers.
   */
  const seekTimelineFocus = useCallback((timeFocus: number | null) => {
    setState((prev) => {
      if (timeFocus == null) {
        return { ...prev, timeFocus: null };
      }
      const isEra = landmarkForMs(timeFocus) != null;
      return {
        ...prev,
        timeFocus,
        ...(isEra ? { timeRange: 'all' as const } : {}),
      };
    });
  }, []);

  const setLayer = useCallback((key: LayerKey, on: boolean) => {
    setState((prev) => ({
      ...prev,
      layers: { ...prev.layers, [key]: on },
    }));
  }, []);

  const setLayers = useCallback((layers: LayerMap) => {
    setState((prev) => ({ ...prev, layers }));
  }, []);

  const setCamera = useCallback((lat: number, lon: number, zoom: number) => {
    setState((prev) => ({ ...prev, lat, lon, zoom }));
  }, []);

  const applyMission = useCallback(
    (opts: {
      view: MapView;
      zoom?: number;
      timeRange: TimeRange;
      layerKeys: readonly string[];
    }) => {
      const preset = VIEW_PRESETS[opts.view];
      setState((prev) => ({
        ...prev,
        view: opts.view,
        zoom: opts.zoom ?? preset.zoom,
        lat: preset.lat,
        lon: preset.lon,
        timeRange: opts.timeRange,
        timeFocus: null,
        layers: layersFromKeys(opts.layerKeys),
      }));
    },
    [],
  );

  return {
    state,
    patch,
    setView,
    setTimeRange,
    setTimeFocus,
    seekTimelineFocus,
    setLayer,
    setLayers,
    setCamera,
    applyMission,
  };
}

export type MapUrlControls = ReturnType<typeof useMapUrlState>;
