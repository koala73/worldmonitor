'use client';

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import type { MapContainer } from '@/components/MapContainer';
import type { MapView, TimeRange } from '@/components/MapContainer';
import type { LayerMap } from '../lib/url-state';
import { toMapLayers } from '../lib/map-layers';
import { loadEnabledLayers, loadLayerData } from '../lib/layer-data-bridge';
import type { MapDimension } from './MapChrome';

export type MonitorMapHandle = {
  zoomIn: () => void;
  zoomOut: () => void;
  resetView: () => void;
};

/**
 * Same map stack as vanilla :3030 — MapContainer → DeckGLMap + MapLibre basemap.
 * React owns chrome; MapContainer chrome is off.
 *
 * Dimension changes remount the renderer (not switchToFlat/Globe) so DeckGL
 * interleaved projection never inherits a stale globe transform.
 */
export const MonitorMap = forwardRef<
  MonitorMapHandle,
  {
    lat: number;
    lon: number;
    zoom: number;
    view: MapView;
    timeRange: TimeRange;
    timeFocus?: number | null;
    layers: LayerMap;
    dimension?: MapDimension;
    onCameraIdle?: (next: { lat: number; lon: number; zoom: number }) => void;
  }
>(function MonitorMap(
  {
    lat,
    lon,
    zoom,
    view,
    timeRange,
    timeFocus = null,
    layers,
    dimension = '2d',
    onCameraIdle,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapContainer | null>(null);
  const readyRef = useRef(false);
  const skipIdleRef = useRef(false);
  const prevLayersRef = useRef<LayerMap>(layers);
  const onCameraIdleRef = useRef(onCameraIdle);
  onCameraIdleRef.current = onCameraIdle;

  useImperativeHandle(ref, () => ({
    zoomIn: () => mapRef.current?.zoomIn(),
    zoomOut: () => mapRef.current?.zoomOut(),
    resetView: () => mapRef.current?.resetView(),
  }));

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let cancelled = false;
    const mapLayers = toMapLayers(layers);
    const preferGlobe = dimension === '3d';

    // Clear any leftover DOM from a prior renderer before remounting.
    el.replaceChildren();
    readyRef.current = false;
    mapRef.current = null;

    void (async () => {
      const { MapContainer: MC } = await import('@/components/MapContainer');
      if (cancelled || !containerRef.current) return;

      const map = new MC(
        containerRef.current,
        {
          zoom,
          pan: { x: 0, y: 0 },
          view,
          layers: mapLayers,
          timeRange,
        },
        preferGlobe,
        // Match vanilla :3030 interleaved stack (deck.gl pinned to 9.2.11).
        { chrome: false, deckInterleaved: true },
      );
      mapRef.current = map;

      try {
        await map.whenRendererReady();
      } catch (err) {
        console.warn('[MonitorMap] renderer failed', err);
        return;
      }
      if (cancelled) {
        map.destroy();
        return;
      }

      readyRef.current = true;
      skipIdleRef.current = true;
      map.setLayers(mapLayers);
      map.setCenter(lat, lon, zoom);
      map.setTimeFocus(timeFocus ?? null);
      map.resize();
      map.ensureScrollZoom();

      map.onStateChanged((state) => {
        if (skipIdleRef.current) {
          skipIdleRef.current = false;
          return;
        }
        const cb = onCameraIdleRef.current;
        if (!cb) return;
        const center = map.getCenter();
        if (!center) return;
        cb({
          lat: center.lat,
          lon: center.lon,
          zoom: state.zoom,
        });
      });

      await loadEnabledLayers(map, mapLayers);
      if (!cancelled) map.resize();
    })();

    return () => {
      cancelled = true;
      readyRef.current = false;
      try {
        mapRef.current?.destroy();
      } catch {
        /* ignore teardown races during dimension remount */
      }
      mapRef.current = null;
      el.replaceChildren();
    };
    // Remount when dimension changes so 2D DeckGL never inherits globe state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dimension]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    skipIdleRef.current = true;
    map.setView(view, zoom);
    map.setCenter(lat, lon, zoom);
  }, [view, lat, lon, zoom]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    map.setTimeRange(timeRange);
    // Keep playhead — do not force Live when range flips to `all` on seek.
    map.setTimeFocus(timeFocus ?? null);
  }, [timeRange]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    map.setTimeFocus(timeFocus ?? null);
  }, [timeFocus]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const next = toMapLayers(layers);
    map.setLayers(next);

    const prev = prevLayersRef.current;
    prevLayersRef.current = layers;
    for (const key of Object.keys(layers) as Array<keyof LayerMap>) {
      if (layers[key] && !prev[key]) {
        void loadLayerData(map, key as keyof import('@/types').MapLayers, true);
      }
    }
  }, [layers]);

  return (
    <div
      className="wm-react-map"
      ref={containerRef}
      role="application"
      aria-label="World Monitor map"
    />
  );
});
