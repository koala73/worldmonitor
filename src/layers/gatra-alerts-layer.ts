/**
 * GATRA Alerts Map Layer — deck.gl layer factory
 *
 * Plots GATRA alert locations on the World Monitor map using deck.gl:
 *   - Red pulsing markers for critical alerts
 *   - Orange markers for high severity
 *   - Yellow for medium, blue for low
 *
 * Returns an array of Layer instances that DeckGLMap can spread into
 * its layer list.  The pulse ring layer uses a time-based radius scale
 * so critical alerts visually pulse on the map.
 */

import { ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import type { GatraAlert, GatraAlertSeverity } from '@/types';

// ── Color palette ───────────────────────────────────────────────────

type RGBA = [number, number, number, number];

const SEVERITY_FILL: Record<GatraAlertSeverity, RGBA> = {
  critical: [255, 50, 50, 220],
  high: [255, 150, 0, 220],
  medium: [255, 220, 0, 200],
  low: [100, 150, 255, 180],
};

const SEVERITY_RADIUS: Record<GatraAlertSeverity, number> = {
  critical: 18000,
  high: 14000,
  medium: 10000,
  low: 8000,
};

// ── Public factory ──────────────────────────────────────────────────

/**
 * Build the deck.gl layers for GATRA alerts.
 *
 * @param alerts   Current GATRA alert list
 * @param pulseTime  Monotonic timestamp used for pulse animation
 *                   (pass `Date.now()` or the shared pulse clock from DeckGLMap)
 */
export function createGatraAlertsLayers(
  alerts: GatraAlert[],
  pulseTime: number = Date.now(),
): Layer[] {
  if (alerts.length === 0) return [];

  const layers: Layer[] = [];

  // 1. Base scatterplot — all alerts
  layers.push(
    new ScatterplotLayer<GatraAlert>({
      id: 'gatra-alerts-layer',
      data: alerts,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: (d) => SEVERITY_RADIUS[d.severity],
      getFillColor: (d) => SEVERITY_FILL[d.severity],
      radiusMinPixels: 4,
      radiusMaxPixels: 16,
      pickable: true,
      stroked: true,
      getLineColor: [255, 255, 255, 100] as RGBA,
      lineWidthMinPixels: 1,
    }),
  );

  // 2. Pulse ring — critical and high alerts only
  const pulsable = alerts.filter(
    (a) => a.severity === 'critical' || a.severity === 'high',
  );

  if (pulsable.length > 0) {
    const pulseScale = 1.0 + 0.9 * (0.5 + 0.5 * Math.sin(pulseTime / 350));

    layers.push(
      new ScatterplotLayer<GatraAlert>({
        id: 'gatra-alerts-pulse',
        data: pulsable,
        getPosition: (d) => [d.lon, d.lat],
        getRadius: (d) => SEVERITY_RADIUS[d.severity],
        radiusScale: pulseScale,
        radiusMinPixels: 6,
        radiusMaxPixels: 28,
        stroked: true,
        filled: false,
        getLineColor: (d) =>
          d.severity === 'critical'
            ? [255, 50, 50, 120] as RGBA
            : [255, 150, 0, 100] as RGBA,
        lineWidthMinPixels: 1.5,
        pickable: false,
        updateTriggers: { radiusScale: pulseTime },
      }),
    );
  }

  // 3. Severity badge labels at higher zoom
  const critical = alerts.filter((a) => a.severity === 'critical');
  if (critical.length > 0) {
    layers.push(
      new TextLayer<GatraAlert>({
        id: 'gatra-alerts-labels',
        data: critical,
        getText: (d) => d.mitreId,
        getPosition: (d) => [d.lon, d.lat],
        getColor: [255, 255, 255, 255],
        getSize: 11,
        getPixelOffset: [0, -16],
        background: true,
        getBackgroundColor: [220, 38, 38, 200] as RGBA,
        backgroundPadding: [4, 2, 4, 2],
        pickable: false,
        fontFamily: 'system-ui, sans-serif',
        fontWeight: 700,
      }),
    );
  }

  return layers;
}
