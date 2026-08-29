/**
 * Draws bridge markers as Cesium entities.
 *
 * One `CustomDataSource` per pushed payload — not per layer — because several
 * payloads share a single layer toggle (outages, traffic anomalies and DDoS
 * hits all ride `outages`) and each arrives on its own schedule. Per-payload
 * sources mean a poll on one never has to rebuild the others; visibility is
 * still resolved per layer by the caller, which flips `show` on every source
 * belonging to a toggle.
 *
 * Two primitives cover every tracker:
 *
 *   - `point`, for markers that were CSS circles on the old globe. Native,
 *     no texture, and Cesium batches them.
 *   - `billboard`, for glyph markers, from a canvas rendered once per
 *     (glyph, colour, size) and cached. Fewer than 60 distinct combinations
 *     exist across every tracker, so the cache is bounded by the spec table
 *     rather than by how much data arrives.
 *
 * Markers clamp to the ground unless a spec supplies a height. Ground
 * clamping is what the vendored layers do (see gev/src/data/earthquakes.js),
 * and it is what keeps a marker on the terrain instead of buried under the
 * photorealistic tiles of a hill.
 */

import type { BridgeMarker } from './types';

type Cesium = typeof import('cesium');

/** Cesium's `CustomDataSource`, structurally — the vendored tree is untyped. */
interface DataSourceLike {
  show: boolean;
  entities: {
    add(entity: unknown): { id: string };
    removeAll(): void;
    suspendEvents(): void;
    resumeEvents(): void;
  };
}

export interface BridgeRenderer {
  /** Replace one payload's markers. */
  setMarkers(sourceKey: string, markers: BridgeMarker[]): void;
  /** Show or hide one payload's markers. */
  setSourceVisible(sourceKey: string, visible: boolean): void;
  /** The marker behind a picked entity id, if it is one of ours. */
  markerForEntity(entityId: unknown): BridgeMarker | undefined;
  /** Every source key currently holding entities. */
  sourceKeys(): string[];
  destroy(): void;
}

/**
 * Render one glyph into a canvas Cesium can use as a billboard texture.
 *
 * The double `fillText` is deliberate: the first pass lays down the shadow,
 * the second draws over it, which is how the old CSS `text-shadow: 0 0 4px`
 * glow reads once it is baked into a texture rather than composited live.
 * Colour emoji fonts ignore `fillStyle` — that was true of the CSS `color`
 * on the old globe too, so the glyphs that are emoji look the same and the
 * glow still carries the severity colour.
 */
function renderGlyph(glyph: string, color: string, size: number, ring: boolean): HTMLCanvasElement {
  const pad = Math.ceil(size * 0.75);
  const dim = Math.ceil(size + pad * 2);
  const canvas = document.createElement('canvas');
  canvas.width = dim;
  canvas.height = dim;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const mid = dim / 2;
  if (ring) {
    ctx.beginPath();
    ctx.arc(mid, mid, size * 0.85, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  ctx.font = `${size}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji","Segoe UI Symbol",sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = size * 0.55;
  ctx.fillText(glyph, mid, mid);
  ctx.fillText(glyph, mid, mid);
  return canvas;
}

export function createBridgeRenderer(
  cesium: Cesium,
  viewer: { dataSources: { add(s: unknown): Promise<unknown>; remove(s: unknown, destroy?: boolean): boolean } },
  requestRender: (reason: string) => void,
): BridgeRenderer {
  const sources = new Map<string, DataSourceLike>();
  const markersByEntity = new Map<string, BridgeMarker>();
  const glyphCache = new Map<string, HTMLCanvasElement>();
  /** Latest visibility asked for, so a source created later starts correct. */
  const visibility = new Map<string, boolean>();
  let destroyed = false;

  function glyphImage(glyph: string, color: string, size: number, ring: boolean): HTMLCanvasElement {
    const key = `${glyph}|${color}|${size}|${ring ? 'r' : ''}`;
    let img = glyphCache.get(key);
    if (!img) {
      img = renderGlyph(glyph, color, size, ring);
      glyphCache.set(key, img);
    }
    return img;
  }

  function ensureSource(sourceKey: string): DataSourceLike | null {
    if (destroyed) return null;
    const existing = sources.get(sourceKey);
    if (existing) return existing;
    const ds = new cesium.CustomDataSource(`wm:${sourceKey}`) as unknown as DataSourceLike;
    ds.show = visibility.get(sourceKey) ?? false;
    sources.set(sourceKey, ds);
    // `add` is async. A teardown between here and its resolution would leave
    // an orphaned source attached to a destroyed viewer, so re-check.
    void viewer.dataSources.add(ds).then(() => {
      if (destroyed) viewer.dataSources.remove(ds, true);
    }).catch(() => { /* viewer torn down mid-add */ });
    return ds;
  }

  function setMarkers(sourceKey: string, markers: BridgeMarker[]): void {
    const ds = ensureSource(sourceKey);
    if (!ds) return;

    // Drop this source's previous pick entries before they are orphaned.
    // Every entity id is namespaced by source key, so the prefix is an exact
    // ownership test rather than a heuristic.
    const prefix = `${sourceKey}::`;
    for (const entityId of markersByEntity.keys()) {
      if (entityId.startsWith(prefix)) markersByEntity.delete(entityId);
    }

    ds.entities.suspendEvents();
    ds.entities.removeAll();

    for (const marker of markers) {
      const entityId = `${sourceKey}::${marker.id}`;
      const { style } = marker;
      const color = cesium.Color.fromCssColorString(style.color);
      const grounded = marker.height === undefined;
      const heightReference = grounded
        ? cesium.HeightReference.CLAMP_TO_GROUND
        : cesium.HeightReference.NONE;

      const graphics = style.glyph
        ? {
            billboard: {
              image: glyphImage(style.glyph, style.color, style.size, style.ring === true),
              heightReference,
              verticalOrigin: cesium.VerticalOrigin.CENTER,
              // Below ~4 px the glyph is unreadable and just adds fill cost;
              // above 1× it goes soft, since the texture is authored at 1×.
              scaleByDistance: new cesium.NearFarScalar(1.0e5, 1.0, 2.0e7, 0.35),
            },
          }
        : {
            point: {
              pixelSize: style.size,
              color: color.withAlpha(0.85),
              // GlobeMap outlined its circles in translucent white; a ring
              // marker trades that for a heavier halo in its own colour.
              outlineColor: style.ring ? color.withAlpha(0.35) : cesium.Color.WHITE.withAlpha(0.6),
              outlineWidth: style.ring ? 4 : 1.5,
              heightReference,
            },
          };

      try {
        ds.entities.add({
          id: entityId,
          position: cesium.Cartesian3.fromDegrees(marker.lon, marker.lat, marker.height ?? 0),
          ...graphics,
        });
        markersByEntity.set(entityId, marker);
      } catch {
        // A duplicate id means the payload carried two rows with the same
        // identity. Skipping the second matches what the old globe did (its
        // marker list was keyed the same way) and is better than throwing
        // away the whole batch.
      }
    }

    ds.entities.resumeEvents();
    requestRender(`wm-bridge:${sourceKey}`);
  }

  function setSourceVisible(sourceKey: string, visible: boolean): void {
    visibility.set(sourceKey, visible);
    const ds = sources.get(sourceKey);
    if (!ds || ds.show === visible) return;
    ds.show = visible;
    requestRender(`wm-bridge-visibility:${sourceKey}`);
  }

  return {
    setMarkers,
    setSourceVisible,
    markerForEntity: (entityId) =>
      typeof entityId === 'string' ? markersByEntity.get(entityId) : undefined,
    sourceKeys: () => [...sources.keys()],
    destroy() {
      destroyed = true;
      for (const ds of sources.values()) {
        try {
          viewer.dataSources.remove(ds, true);
        } catch { /* viewer already gone */ }
      }
      sources.clear();
      markersByEntity.clear();
      glyphCache.clear();
      visibility.clear();
    },
  };
}
