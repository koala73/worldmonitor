/**
 * Shapes the God's Eye View bridge speaks.
 *
 * World Monitor pushes tracker rows at the map (`setEarthquakes`,
 * `setProtests`, …); God's Eye View draws Cesium entities. Nothing in either
 * half knows about the other, so the bridge describes the middle: a small,
 * renderer-independent description of "a marker at a place, looking like
 * this", plus the accessors that get one out of an arbitrary tracker row.
 *
 * Keeping that description declarative is what makes the bridge reviewable.
 * The alternative — a `setX` per tracker, each reaching into Cesium — is what
 * GlobeMap did, and it is why GlobeMap was 3,647 lines.
 */

import type { MapLayers } from '@/types';

/** How one marker is drawn. Ported from GlobeMap's buildMarkerElement. */
export interface MarkerStyle {
  /**
   * Symbol drawn into the billboard texture. Omit for a plain Cesium point,
   * which is cheaper and crisper — use it for markers that were CSS circles
   * on the old globe (earthquakes, UCDP events, news).
   */
  glyph?: string;
  /** CSS hex colour. Drives the glow, the point fill and the outline. */
  color: string;
  /** Glyph font size, or point diameter, in pixels. */
  size: number;
  /**
   * Draw a translucent halo behind the marker. GlobeMap used a CSS pulse
   * animation for these; a static ring is the honest Cesium equivalent —
   * see the note on animation cost in gev/src/data/earthquakes.js.
   */
  ring?: boolean;
}

/**
 * One kind of marker inside a pushed payload.
 *
 * A payload is not always one marker set: `setMilitaryVessels` carries
 * vessels AND fleet clusters, `setFlightDelays` carries delay pins AND NOTAM
 * closure rings. Each is a part, with its own accessors and styling.
 */
export interface MarkerPart<Row = any> {
  /** Marker kind — click routing and tooltips key off this. */
  kind: string;
  /** Pull this part's rows out of the pushed payload. */
  rows(payload: any): Row[];
  lat(row: Row): number | null | undefined;
  lon(row: Row): number | null | undefined;
  id(row: Row, index: number): string;
  /** Hover tooltip text. Plain text — the renderer escapes it. */
  title(row: Row): string;
  style(row: Row): MarkerStyle;
  /** Metres above the ellipsoid. Omit to clamp the marker to the ground. */
  height?(row: Row): number;
  /** Return true to drop a row before it reaches the globe. */
  skip?(row: Row): boolean;
}

/** Everything one push-setter contributes to the globe. */
export interface BridgeSpec {
  /**
   * World Monitor layer that gates this payload, or null for markers that
   * ignore the layer tray. `newsLocations` is the only ungated one — it was
   * ungated on GlobeMap too (flushMarkersImmediate pushes it unconditionally).
   */
  layer: keyof MapLayers | null;
  parts: MarkerPart[];
}

/** A marker resolved from a row, ready for the renderer. */
export interface BridgeMarker {
  id: string;
  kind: string;
  lat: number;
  lon: number;
  height?: number;
  title: string;
  style: MarkerStyle;
  /** The original tracker row, handed back on click. */
  row: unknown;
}
