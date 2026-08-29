/**
 * CesiumGlobeMap — God's Eye View's Cesium globe, behind World Monitor's
 * MapContainer interface.
 *
 * Replaces GlobeMap (globe.gl + three.js). MapContainer talks to whichever
 * map is active through one shape: ~59 members, almost all `setX(data)`
 * push-setters, plus a camera contract and a lifecycle. This class implements
 * that shape and forwards to a `createGevViewer()` handle.
 *
 * ## The async problem
 *
 * `new GlobeMap(container, state)` was synchronous — MapContainer constructs
 * it and immediately starts calling setters. `createGevViewer()` is async
 * (Cesium viewer construction, Google 3D Tiles fetch, layer registration).
 *
 * Rather than make MapContainer async — which would ripple through
 * switchToGlobe/switchToFlat and every caller — this constructor starts the
 * boot and every method is written to work before it finishes:
 *
 *   - Push-setters record their latest value in `pending` and return. They
 *     are last-write-wins by nature, so replaying only the final value on
 *     ready is not an approximation, it is the same result.
 *   - Camera calls record the latest requested view and replay it once.
 *   - Everything else no-ops until the viewer exists.
 *
 * ## The tracker bridge
 *
 * God's Eye View's own layers fetch themselves; World Monitor's are pushed.
 * `applyLayerData()` is where the two meet: it looks the payload up in
 * `BRIDGE_SPECS`, resolves it to markers, and hands them to a Cesium
 * `CustomDataSource` keyed by payload. See src/components/gev-bridge/.
 *
 * Both layer trays stay on screen and neither drives the other. A World
 * Monitor toggle always controls World Monitor's data — turning on "Ship
 * Traffic" must not silently swap in a different vessel feed just because
 * the vendored tree also has one. Where the two overlap, the user chooses
 * which to show, and can show both.
 */

import type {
  MapLayers,
  Hotspot,
  NewsItem,
  InternetOutage,
  AisDisruptionEvent,
  AisDensityZone,
  CableAdvisory,
  RepairShip,
  SocialUnrestEvent,
  MilitaryFlight,
  MilitaryVessel,
  MilitaryFlightCluster,
  MilitaryVesselCluster,
  NaturalEvent,
  UcdpGeoEvent,
  CyberThreat,
  CableHealthRecord,
} from '@/types';
import type { MapContainerState, MapView, TimeRange } from './MapContainer';
import type { CountryClickPayload } from './DeckGLMap';
import type { ScenarioVisualState } from '@/config/scenario-templates';
import { getCountryBbox } from '@/services/country-geometry';
import {
  LAYER_REGISTRY,
  getLayerExplanation,
  getLayersForVariant,
  hasCuratedLayerExplanation,
  resolveLayerLabel,
  bindLayerSearch,
  type MapVariant,
} from '@/config/map-layer-definitions';
import { SITE_VARIANT } from '@/config/variant';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { renderLayerExplanationCard } from '@/utils/layer-explanation-card';
import { showLayerWarning } from '@/utils/layer-warning';
import { getIranEventHexColor } from '@/services/conflict';
import { MapPopup } from './MapPopup';
import type { GetChokepointStatusResponse } from '@/services/supply-chain';
import {
  BRIDGE_SPECS,
  STATIC_LAYER_KEYS,
  createBridgeRenderer,
  resolveMarkers,
  setIranEventColorResolver,
  staticMarkersFor,
  type BridgeMarker,
  type BridgeRenderer,
} from './gev-bridge';

// The vendored tree is untyped JavaScript; its boundary is declared in
// src/types/gev.d.ts so a breaking re-vendor surfaces as a compile error
// rather than a runtime one.
import type { GevHandle } from '@/gev/src/main.js';

/** Camera stops for World Monitor's region views, ported from GlobeMap's
 *  VIEW_POVS. `height` is metres above the ellipsoid; the globe.gl originals
 *  were in Earth radii, converted at 6,371 km. */
const VIEW_CAMERAS: Record<MapView, { lat: number; lon: number; height: number }> = {
  global:  { lat:  20, lon:    0, height: 11_468_000 },
  america: { lat:  20, lon:  -90, height:  9_557_000 },
  mena:    { lat:  25, lon:   40, height:  7_645_000 },
  eu:      { lat:  50, lon:   10, height:  7_645_000 },
  asia:    { lat:  35, lon:  105, height:  9_557_000 },
  latam:   { lat: -15, lon:  -60, height:  9_557_000 },
  africa:  { lat:   5, lon:   20, height:  9_557_000 },
  oceania: { lat: -25, lon:  140, height:  9_557_000 },
};

const EARTH_RADIUS_M = 6_371_000;

/**
 * World Monitor's deck.gl-style zoom → camera height.
 *
 * Same breakpoints GlobeMap used (it expressed them as globe.gl altitudes in
 * Earth radii); converting rather than inventing keeps "zoom to 6" framing
 * the same shot it framed on the old globe, which matters because callers
 * like `openCountryStory` were tuned against it.
 */
function zoomToHeight(zoom: number | undefined): number {
  if (zoom === undefined) return 1.2 * EARTH_RADIUS_M;
  if (zoom >= 7) return 0.08 * EARTH_RADIUS_M;
  if (zoom >= 6) return 0.15 * EARTH_RADIUS_M;
  if (zoom >= 5) return 0.30 * EARTH_RADIUS_M;
  if (zoom >= 4) return 0.50 * EARTH_RADIUS_M;
  if (zoom >= 3) return 0.80 * EARTH_RADIUS_M;
  return 1.5 * EARTH_RADIUS_M;
}

const DEG = 180 / Math.PI;

/** Every push-setter's payload, keyed by the layer it feeds. Phase 4's bridge
 *  consumes this map; until then it is the record of what has arrived. */
type LayerPayloads = Record<string, unknown>;

export class CesiumGlobeMap {
  private readonly container: HTMLElement;
  private gev: GevHandle | null = null;
  private cesium: typeof import('cesium') | null = null;
  private destroyed = false;
  private booted = false;

  /** Latest value pushed for each layer, replayed on ready. */
  private readonly payloads: LayerPayloads = {};

  /** Latest camera request, replayed on ready. */
  private pendingCamera: { lat: number; lon: number; height: number } | null = null;

  /** Bridge: draws World Monitor's pushed trackers as Cesium entities. */
  private renderer: BridgeRenderer | null = null;
  /** Rich click popups, the same component the 2D map uses. */
  private popup: MapPopup | null = null;
  private pickHandler: { destroy(): void } | null = null;
  private tooltipEl: HTMLElement | null = null;
  private layerTogglesEl: HTMLElement | null = null;
  /** Built-in site catalogues already materialised — they never change. */
  private readonly staticLoaded = new Set<string>();
  private layerWarningShown = false;
  private lastActiveLayerCount = 0;

  private currentView: MapView;
  private layers: MapLayers;
  private timeRange: TimeRange;
  private renderPaused = false;
  private resizing = false;

  private onStateChangedCb: ((s: MapContainerState) => void) | null = null;
  private onTimeRangeChangedCb: ((r: TimeRange) => void) | null = null;
  private onLayerChangeCb:
    | ((layer: keyof MapLayers, enabled: boolean, source: 'user' | 'programmatic') => void)
    | null = null;
  private onHotspotClickCb: ((h: Hotspot) => void) | null = null;
  private onCountryClickCb: ((c: CountryClickPayload) => void) | null = null;
  private onMapContextMenuCb: ((p: {
    lat: number; lon: number; screenX: number; screenY: number;
    countryCode?: string; countryName?: string;
  }) => void) | null = null;

  constructor(container: HTMLElement, initialState: MapContainerState) {
    this.container = container;
    this.currentView = initialState.view;
    this.layers = initialState.layers;
    this.timeRange = initialState.timeRange;
    void this.boot(initialState);
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────

  private async boot(initialState: MapContainerState): Promise<void> {
    try {
      // Dynamic import keeps Cesium (~6 MB) and the vendored tree out of the
      // entry bundle — this module is only reached when the globe is chosen.
      const [{ createGevViewer }, cesium] = await Promise.all([
        import('@/gev/src/main.js'),
        import('cesium'),
      ]);

      if (this.destroyed) return;

      this.cesium = cesium;
      this.gev = await createGevViewer(this.container, {
        // World Monitor owns the page; a second instance would fight over
        // window.__godsEyeView, so only the first mount claims it.
        exposeGlobal: true,
        // World Monitor has its own onboarding (the mission picker). Running
        // God's Eye View's launcher too puts two first-run takeovers on
        // screen at once, and upstream's is sized for a full viewport — in a
        // map panel it covers the globe and gets clipped.
        firstRun: false,
        // MapContainer's view is the opening shot. Upstream's own fly-to
        // Austin runs on a 500 ms timer, so leaving it on means the camera
        // this constructor sets is quietly overridden half a second later —
        // the map opens on downtown Austin whatever region was asked for.
        initialCamera: false,
      });

      if (this.destroyed) {
        this.gev.destroy();
        this.gev = null;
        return;
      }

      this.booted = true;

      // The bridge must exist before the replay below, or the first poll of
      // every tracker is silently dropped.
      this.installBridge();
      this.createLayerToggles();

      // Replay everything that arrived while Cesium was starting.
      this.applyCamera(this.pendingCamera ?? {
        ...VIEW_CAMERAS[initialState.view] ?? VIEW_CAMERAS.global,
      }, 0);
      this.pendingCamera = null;
      for (const [layer, data] of Object.entries(this.payloads)) {
        this.applyLayerData(layer, data);
      }
      this.applyLayerVisibility();
      this.applyRenderPaused();
    } catch (err) {
      console.error('[CesiumGlobeMap] God\'s Eye View failed to start:', err);
    }
  }

  /** True once the Cesium viewer exists and has not been torn down. */
  private get live(): boolean {
    return this.booted && !this.destroyed && this.gev !== null
      && !this.gev.viewer.isDestroyed();
  }

  // ─── Data intake ──────────────────────────────────────────────────────────

  /**
   * Record a layer's latest payload and, if the viewer is up, draw it.
   *
   * Recording unconditionally is what lets a synchronous constructor front an
   * asynchronous viewer: push-setters are last-write-wins, so replaying the
   * final value once Cesium is ready gives the same result as having drawn
   * every intermediate one.
   */
  private push(layer: string, data: unknown): void {
    this.payloads[layer] = data;
    if (this.live) this.applyLayerData(layer, data);
  }

  /**
   * Draw one pushed payload.
   *
   * A payload with no spec is held but not drawn — the honest outcome for
   * the country-level choropleths and flow arcs (happiness, bloc alignment,
   * resilience ranking, displacement corridors) that have no marker form.
   * GlobeMap made the same call, with empty setter bodies; keeping the data
   * means adding polygon support later needs no change here.
   */
  private applyLayerData(layer: string, data: unknown): void {
    const spec = BRIDGE_SPECS[layer];
    if (!spec || !this.renderer) return;
    this.renderer.setMarkers(layer, resolveMarkers(spec, data));
    this.renderer.setSourceVisible(layer, this.isLayerVisible(spec.layer));
  }

  private isLayerVisible(layer: keyof MapLayers | null): boolean {
    return layer === null ? true : this.layers[layer] === true;
  }

  /**
   * Reconcile every bridged source with the current layer set.
   *
   * Cheaper than it looks: `setSourceVisible` returns immediately when a
   * source is already in the requested state, so a toggle costs one render
   * request rather than a rebuild.
   */
  private applyLayerVisibility(): void {
    if (!this.renderer) return;
    for (const [key, spec] of Object.entries(BRIDGE_SPECS)) {
      this.renderer.setSourceVisible(key, this.isLayerVisible(spec.layer));
    }
    for (const key of STATIC_LAYER_KEYS) {
      const enabled = this.layers[key] === true;
      // Built-in catalogues are materialised the first time their layer is
      // switched on, never at boot: they are thousands of rows a user may
      // never ask for.
      if (enabled) this.ensureStaticLayer(key);
      this.renderer.setSourceVisible(`static:${key}`, enabled);
    }
  }

  private ensureStaticLayer(layer: keyof MapLayers): void {
    if (!this.renderer || this.staticLoaded.has(layer)) return;
    const markers = staticMarkersFor(layer);
    if (!markers) return;
    this.staticLoaded.add(layer);
    this.renderer.setMarkers(`static:${layer}`, markers);
  }

  // ─── Bridge wiring ────────────────────────────────────────────────────────

  private installBridge(): void {
    const cesium = this.cesium;
    const gev = this.gev;
    if (!cesium || !gev) return;

    this.renderer = createBridgeRenderer(
      cesium,
      gev.viewer,
      // Through God's Eye View's render governor rather than calling
      // scene.requestRender directly. It forwards to the scene either way,
      // but it also records the reason, and `getRenderGovernorDiagnostics()`
      // is how anyone answers "what is keeping this scene awake?" — a
      // bridged layer that repaints too often should be visible there by
      // name rather than anonymous.
      (reason) => gev.requestRender(reason),
    );

    // Iran event colouring lives in a service the spec table must not import
    // (it is tested without a service graph); hand it the real resolver here.
    setIranEventColorResolver((row) => getIranEventHexColor(row));

    this.popup = new MapPopup(this.container);
    this.installPicking(cesium, gev.viewer);
  }

  /** Marker kind → the popup MapPopup already knows how to render for it. */
  private static readonly POPUP_TYPES: Record<string, string> = {
    hotspot: 'hotspot', earthquake: 'earthquake', weather: 'weather',
    natural: 'natEvent', radiation: 'radiation', outage: 'outage',
    cyber: 'cyberThreat', protest: 'protest', tech: 'techEvent',
    iran: 'iranEvent', gpsjam: 'gpsJamming', aisDisruption: 'ais',
    cableAdvisory: 'cable-advisory', repairShip: 'repair-ship',
    flight: 'militaryFlight', vessel: 'militaryVessel',
    cluster: 'militaryVesselCluster',
    milbase: 'base', nuclearSite: 'nuclear', irradiator: 'irradiator',
    spaceport: 'spaceport', economic: 'economic', waterway: 'waterway',
    mineral: 'mineral', datacenter: 'datacenter',
  };

  /**
   * Hover tooltips and click popups for bridged markers.
   *
   * A separate ScreenSpaceEventHandler rather than the viewer's own: this one
   * must not disturb whatever the vendored tree has already bound to the
   * canvas, and Cesium delivers the same input to every handler attached to
   * it. Picks that are not ours fall straight through.
   */
  private installPicking(cesium: typeof import('cesium'), viewer: GevHandle['viewer']): void {
    const handler = new cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

    const markerAt = (position: unknown): BridgeMarker | undefined => {
      try {
        const picked = viewer.scene.pick(position);
        return this.renderer?.markerForEntity(picked?.id?.id);
      } catch {
        return undefined;
      }
    };

    // scene.pick runs a real render pass into the pick buffer. At pointer
    // rate over photorealistic tiles that is the most expensive thing on the
    // frame, so hover is throttled — 60 ms is below the threshold where a
    // tooltip feels laggy and well above per-move.
    let lastHoverPick = 0;
    handler.setInputAction((movement: { endPosition: { x: number; y: number } }) => {
      const now = performance.now();
      if (now - lastHoverPick < 60) return;
      lastHoverPick = now;
      const marker = markerAt(movement.endPosition);
      if (!marker) { this.hideTooltip(); return; }
      this.showTooltip(marker.title, movement.endPosition.x, movement.endPosition.y);
    }, cesium.ScreenSpaceEventType.MOUSE_MOVE);

    handler.setInputAction((click: { position: { x: number; y: number } }) => {
      const marker = markerAt(click.position);
      if (!marker) return;
      this.hideTooltip();
      this.openMarker(marker, click.position.x, click.position.y);
    }, cesium.ScreenSpaceEventType.LEFT_CLICK);

    this.pickHandler = handler as unknown as { destroy(): void };
  }

  private openMarker(marker: BridgeMarker, x: number, y: number): void {
    // Intel hotspots are the one kind the dashboard itself wants to hear
    // about — clicking one drives the hotspot panel, not a map popup.
    if (marker.kind === 'hotspot') {
      this.onHotspotClickCb?.(marker.row as Hotspot);
      return;
    }
    const type = CesiumGlobeMap.POPUP_TYPES[marker.kind];
    if (!type || !this.popup) return;
    try {
      // MapPopup validates its own payload shapes; a tracker whose row does
      // not match the popup it maps to must not take the click handler down.
      this.popup.show({ type, data: marker.row, x, y } as never);
      if (marker.kind === 'flight') {
        const hex = (marker.row as { hexCode?: string }).hexCode;
        if (hex) void this.popup.loadWingbitsLiveFlight(hex);
      }
    } catch (err) {
      if (import.meta.env.DEV) console.warn('[CesiumGlobeMap] popup error', marker.kind, err);
    }
  }

  private showTooltip(text: string, x: number, y: number): void {
    if (!text) { this.hideTooltip(); return; }
    if (!this.tooltipEl) {
      const el = document.createElement('div');
      el.className = 'gev-marker-tooltip';
      this.container.appendChild(el);
      this.tooltipEl = el;
    }
    // textContent, not HTML: every one of these strings is feed data.
    this.tooltipEl.textContent = text;
    this.tooltipEl.style.transform = `translate(${x + 14}px, ${y + 14}px)`;
    this.tooltipEl.style.display = 'block';
  }

  private hideTooltip(): void {
    if (this.tooltipEl) this.tooltipEl.style.display = 'none';
  }

  /**
   * Every tracker payload received so far, drawn or not.
   *
   * The undrawn ones are the point: a country choropleth has no marker form
   * today, but the data is here for whoever adds polygon support, and
   * tests/gev-tracker-bridge.test.mts reads this list to prove no payload is
   * silently going nowhere.
   */
  public getPayloads(): Readonly<LayerPayloads> {
    return this.payloads;
  }

  // ─── Camera ───────────────────────────────────────────────────────────────

  private applyCamera(
    target: { lat: number; lon: number; height: number },
    durationSec = 1.2,
  ): void {
    if (!this.live || !this.cesium) {
      this.pendingCamera = target;
      return;
    }
    const { Cartesian3 } = this.cesium;
    this.gev!.viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(target.lon, target.lat, target.height),
      duration: durationSec,
    });
  }

  public setView(view: MapView, zoom?: number): void {
    this.currentView = view;
    const preset = VIEW_CAMERAS[view] ?? VIEW_CAMERAS.global;
    this.applyCamera({
      lat: preset.lat,
      lon: preset.lon,
      height: zoom !== undefined ? zoomToHeight(zoom) : preset.height,
    });
  }

  public setCenter(lat: number, lon: number, zoom?: number): void {
    this.applyCamera({ lat, lon, height: zoomToHeight(zoom) });
  }

  public setZoom(zoom: number): void {
    const here = this.getCenter();
    const preset = VIEW_CAMERAS[this.currentView] ?? VIEW_CAMERAS.global;
    this.applyCamera({
      lat: here?.lat ?? preset.lat,
      lon: here?.lon ?? preset.lon,
      height: zoomToHeight(zoom),
    });
  }

  public getCenter(): { lat: number; lon: number } | null {
    if (!this.live) {
      return this.pendingCamera
        ? { lat: this.pendingCamera.lat, lon: this.pendingCamera.lon }
        : null;
    }
    const c = this.gev!.viewer.camera.positionCartographic;
    return { lat: c.latitude * DEG, lon: c.longitude * DEG };
  }

  /**
   * Visible bounds as `west,south,east,north`.
   *
   * Cesium computes this exactly when the view is fully on the globe, and
   * returns undefined when the horizon or space is in frame. The fallback is
   * GlobeMap's heuristic (a square window scaled by camera altitude), which
   * is what every consumer of this string was already tuned against.
   */
  public getBbox(): string | null {
    if (!this.live) return null;
    const camera = this.gev!.viewer.camera;
    const rect = camera.computeViewRectangle();
    if (rect) {
      const west = rect.west * DEG;
      const south = rect.south * DEG;
      const east = rect.east * DEG;
      const north = rect.north * DEG;
      return `${west.toFixed(4)},${south.toFixed(4)},${east.toFixed(4)},${north.toFixed(4)}`;
    }
    const c = camera.positionCartographic;
    const lat = c.latitude * DEG;
    const lon = c.longitude * DEG;
    const altitudeRadii = c.height / EARTH_RADIUS_M;
    const r = Math.min(90, Math.max(5, altitudeRadii * 30));
    return [
      Math.max(-180, lon - r).toFixed(4),
      Math.max(-90, lat - r).toFixed(4),
      Math.min(180, lon + r).toFixed(4),
      Math.min(90, lat + r).toFixed(4),
    ].join(',');
  }

  public fitCountry(code: string): void {
    const bbox = getCountryBbox(code);
    if (!bbox) return;
    const [minLon, minLat, maxLon, maxLat] = bbox;
    const span = Math.max(maxLat - minLat, maxLon - minLon);
    // Same span→framing ladder GlobeMap used, in metres.
    const radii = span > 60 ? 1.0 : span > 20 ? 0.7 : span > 8 ? 0.45 : span > 3 ? 0.25 : 0.12;
    this.applyCamera({
      lat: (minLat + maxLat) / 2,
      lon: (minLon + maxLon) / 2,
      height: radii * EARTH_RADIUS_M,
    });
  }

  public flashLocation(lat: number, lon: number, _durationMs = 2000): void {
    // Fly there; the transient marker lands with the bridge in Phase 4.
    this.applyCamera({ lat, lon, height: zoomToHeight(6) });
  }

  public highlightCountry(_code: string): void { /* Phase 4 */ }
  public flashAssets(_type: string, _ids: string[]): void { /* Phase 4 */ }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  public render(): void {
    if (this.live) this.gev!.viewer.scene.requestRender();
  }

  public resize(): void {
    if (this.live) this.gev!.viewer.resize();
  }

  public setIsResizing(isResizing: boolean): void {
    this.resizing = isResizing;
    // A drag-resize repaints the canvas every frame for no benefit — the
    // final size is the only one anyone sees. Pause during, resume after.
    this.applyRenderPaused();
    if (!isResizing) this.resize();
  }

  public setRenderPaused(paused: boolean): void {
    this.renderPaused = paused;
    this.applyRenderPaused();
  }

  private applyRenderPaused(): void {
    if (!this.live) return;
    this.gev!.viewer.useDefaultRenderLoop = !(this.renderPaused || this.resizing);
  }

  public destroy(): void {
    this.destroyed = true;
    this.booted = false;
    // Order matters: our own entities and input handler come off the viewer
    // before the viewer itself goes, or Cesium throws tearing down a handler
    // whose canvas has already been destroyed.
    try { this.pickHandler?.destroy(); } catch { /* canvas already gone */ }
    this.pickHandler = null;
    this.renderer?.destroy();
    this.renderer = null;
    this.popup?.hide();
    this.popup = null;
    this.tooltipEl?.remove();
    this.tooltipEl = null;
    this.layerTogglesEl?.remove();
    this.layerTogglesEl = null;
    this.container.querySelector('.layer-explanation-popup')?.remove();
    this.staticLoaded.clear();
    // Fire and forget: MapContainer destroys maps synchronously, and God's
    // Eye View's teardown has to await StyleManager.dispose() before it can
    // drop the viewer. Nothing here depends on the result, but the rejection
    // still needs a handler or it surfaces as an unhandled rejection.
    void Promise.resolve(this.gev?.destroy())
      .catch((err) => console.warn('[CesiumGlobeMap] teardown error:', err));
    this.gev = null;
    this.cesium = null;
  }

  // ─── State ────────────────────────────────────────────────────────────────

  public getState(): MapContainerState {
    return {
      // The globe has no discrete zoom level; GlobeMap reported 1 and every
      // consumer treats it as "not meaningful in globe mode".
      zoom: 1,
      pan: { x: 0, y: 0 },
      view: this.currentView,
      layers: this.layers,
      timeRange: this.timeRange,
    };
  }

  public setTimeRange(range: TimeRange): void {
    this.timeRange = range;
    this.onTimeRangeChangedCb?.(range);
  }

  public getTimeRange(): TimeRange {
    return this.timeRange;
  }

  // ─── Layers ───────────────────────────────────────────────────────────────

  /**
   * Layers the catalog declares flat-only (`renderers: ['flat']`) — Day/Night
   * being the canonical one. Computed from LAYER_REGISTRY rather than
   * hardcoded, so a layer added as flat-only is suppressed here without
   * anyone having to remember this file exists.
   */
  private static readonly FLAT_ONLY_LAYERS: ReadonlyArray<keyof MapLayers> =
    Object.values(LAYER_REGISTRY)
      .filter((d) => !d.renderers.includes('globe'))
      .map((d) => d.key);

  /**
   * Accept a layer set, forcing off anything the globe cannot draw.
   *
   * GlobeMap did this for Day/Night specifically (it has no day/night
   * terminator overlay, and neither does Cesium under Google 3D Tiles).
   * Without the override a layer restored from stored settings reads as
   * enabled in the UI while nothing appears on the globe — a toggle that
   * lies. The catalog is already the source of truth via `renderers`; this
   * just enforces it at the renderer.
   */
  public setLayers(layers: MapLayers): void {
    let next = layers;
    for (const key of CesiumGlobeMap.FLAT_ONLY_LAYERS) {
      if (next[key]) next = { ...next, [key]: false };
    }
    this.layers = next;
    this.syncLayerToggles();
    this.applyLayerVisibility();
    this.onStateChangedCb?.(this.getState());
  }

  public enableLayer(layer: keyof MapLayers): void {
    if (this.layers[layer]) return;
    this.layers = { ...this.layers, [layer]: true };
    this.syncLayerToggles();
    this.applyLayerVisibility();
    this.onLayerChangeCb?.(layer, true, 'programmatic');
  }

  /** Push `this.layers` back into the tray's checkboxes. */
  private syncLayerToggles(): void {
    const tray = this.layerTogglesEl;
    if (!tray) return;
    for (const input of tray.querySelectorAll<HTMLInputElement>('.layer-toggle input')) {
      const key = input.closest('.layer-toggle')?.getAttribute('data-layer') as keyof MapLayers | null;
      if (key) input.checked = this.layers[key] === true;
    }
    this.enforceLayerLimit();
  }

  public hideLayerToggle(layer: keyof MapLayers): void {
    const row = this.layerTogglesEl?.querySelector(`.layer-toggle-row[data-layer="${layer}"]`);
    (row as HTMLElement | null)?.style.setProperty('display', 'none');
  }

  public setLayerLoading(layer: keyof MapLayers, loading: boolean): void {
    this.layerTogglesEl
      ?.querySelector(`.layer-toggle[data-layer="${layer}"]`)
      ?.classList.toggle('loading', loading);
  }

  public setLayerReady(layer: keyof MapLayers, hasData: boolean): void {
    this.layerTogglesEl
      ?.querySelector(`.layer-toggle[data-layer="${layer}"]`)
      ?.classList.toggle('no-data', !hasData);
  }

  // ─── Layer tray ───────────────────────────────────────────────────────────

  /**
   * World Monitor's layer picker, inside the globe panel.
   *
   * God's Eye View has a tray of its own for its self-fetching layers; this
   * is the one for World Monitor's, and it is the same component the 2D map
   * uses — same markup, same CSS, same search, same explanation cards — so
   * switching projections does not mean relearning the control. Anchored
   * top-right by src/styles/gev-embed.css, clear of the vendored chrome's
   * title bar (top-left) and command dock (bottom-centre).
   *
   * No lock states are rendered. OpenEye removed premium gating outright
   * (see src/services/panel-gating.ts), so a padlock here would be chrome
   * for a restriction that no longer exists.
   */
  private createLayerToggles(): void {
    const layerDefs = getLayersForVariant((SITE_VARIANT || 'full') as MapVariant, 'globe');
    const el = document.createElement('div');
    el.className = 'layer-toggles deckgl-layer-toggles gev-layer-toggles';

    const rows = layerDefs.map((def) => {
      const label = resolveLayerLabel(def, t);
      const explainLabel = escapeHtml(`Explain ${label} layer`);
      const explains = hasCuratedLayerExplanation(def.key) ? ' has-layer-explanation' : '';
      return `
          <div class="layer-toggle-row" data-layer="${def.key}">
            <label class="layer-toggle" data-layer="${def.key}">
              <input type="checkbox" ${this.layers[def.key] ? 'checked' : ''}>
              <span class="toggle-icon">${def.icon}</span>
              <span class="toggle-label">${escapeHtml(label)}</span>
            </label>
            <button type="button" class="layer-explain-btn${explains}" data-layer="${def.key}" aria-label="${explainLabel}" title="${explainLabel}">i</button>
          </div>`;
    }).join('');

    setTrustedHtml(el, trustedHtml(`
      <div class="toggle-header">
        <span>${escapeHtml(t('components.deckgl.layersTitle'))}</span>
        <button class="toggle-collapse">&#9660;</button>
      </div>
      <input type="text" class="layer-search" placeholder="${escapeHtml(t('components.deckgl.layerSearch'))}" autocomplete="off" spellcheck="false" />
      <div class="toggle-list">${rows}</div>`,
      'layer catalog metadata and escaped labels'));

    this.container.appendChild(el);
    this.layerTogglesEl = el;

    for (const input of el.querySelectorAll<HTMLInputElement>('.layer-toggle input')) {
      input.addEventListener('change', () => {
        const key = input.closest('.layer-toggle')?.getAttribute('data-layer') as keyof MapLayers | null;
        if (!key) return;
        this.layers = { ...this.layers, [key]: input.checked };
        this.applyLayerVisibility();
        this.onLayerChangeCb?.(key, input.checked, 'user');
        this.enforceLayerLimit();
      });
    }

    for (const button of el.querySelectorAll<HTMLElement>('.layer-explain-btn')) {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const layer = button.getAttribute('data-layer') as keyof MapLayers | null;
        if (layer) this.showLayerExplanation(layer);
      });
    }

    bindLayerSearch(el);

    const collapseBtn = el.querySelector('.toggle-collapse');
    const list = el.querySelector<HTMLElement>('.toggle-list');
    const searchEl = el.querySelector<HTMLElement>('.layer-search');
    let collapsed = false;
    collapseBtn?.addEventListener('click', () => {
      collapsed = !collapsed;
      if (list) list.style.display = collapsed ? 'none' : '';
      if (searchEl) searchEl.style.display = collapsed ? 'none' : '';
      setTrustedHtml(collapseBtn as HTMLElement,
        trustedHtml(collapsed ? '&#9654;' : '&#9660;', 'static chevron glyph'));
    });

    // Without this the globe swallows the wheel and zooms the camera instead
    // of scrolling a list that is taller than the tray.
    el.addEventListener('wheel', (event) => {
      event.stopPropagation();
      event.preventDefault();
      if (list) list.scrollTop += event.deltaY;
    }, { passive: false });

    this.enforceLayerLimit();
  }

  /**
   * Warn once when the active layer count crosses the point where the map
   * stops being readable. Only on the way up — nagging someone who is
   * already turning layers off helps nobody.
   */
  private enforceLayerLimit(): void {
    if (!this.layerTogglesEl) return;
    const WARN_THRESHOLD = 13;
    const active = [...this.layerTogglesEl.querySelectorAll<HTMLInputElement>('.layer-toggle input')]
      .filter((i) => i.checked).length;
    const increasing = active > this.lastActiveLayerCount;
    this.lastActiveLayerCount = active;
    if (active >= WARN_THRESHOLD && increasing && !this.layerWarningShown) {
      this.layerWarningShown = true;
      showLayerWarning(WARN_THRESHOLD);
    } else if (active < WARN_THRESHOLD) {
      this.layerWarningShown = false;
    }
  }

  /** The "what is this layer?" card, toggled by the tray's `i` buttons. */
  private showLayerExplanation(layer: keyof MapLayers): void {
    const existing = this.container.querySelector<HTMLElement>('.layer-explanation-popup');
    const button = this.container.querySelector(`.layer-explain-btn[data-layer="${layer}"]`);
    if (existing?.dataset.layer === layer) {
      existing.remove();
      button?.classList.remove('active');
      return;
    }
    existing?.remove();
    for (const active of this.container.querySelectorAll('.layer-explain-btn.active')) {
      active.classList.remove('active');
    }

    const def = getLayersForVariant((SITE_VARIANT || 'full') as MapVariant, 'globe')
      .find((item) => item.key === layer);
    const popup = document.createElement('div');
    popup.className = 'layer-explanation-popup';
    popup.dataset.layer = layer;
    setTrustedHtml(popup, trustedHtml(
      renderLayerExplanationCard(def ? resolveLayerLabel(def, t) : String(layer), getLayerExplanation(layer)),
      'static layer explanation metadata',
    ));
    popup.querySelector('.layer-explanation-close')?.addEventListener('click', () => {
      popup.remove();
      button?.classList.remove('active');
    });
    this.container.appendChild(popup);
    button?.classList.add('active');
  }

  // ─── Callbacks ────────────────────────────────────────────────────────────

  public onStateChanged(cb: (s: MapContainerState) => void): void {
    this.onStateChangedCb = cb;
  }

  public onTimeRangeChanged(cb: (r: TimeRange) => void): void {
    this.onTimeRangeChangedCb = cb;
  }

  public setOnLayerChange(
    cb: (layer: keyof MapLayers, enabled: boolean, source: 'user' | 'programmatic') => void,
  ): void {
    this.onLayerChangeCb = cb;
  }

  public setOnHotspotClick(cb: (h: Hotspot) => void): void {
    this.onHotspotClickCb = cb;
  }

  public setOnCountryClick(cb: (c: CountryClickPayload) => void): void {
    this.onCountryClickCb = cb;
  }

  public setOnMapContextMenu(cb: (p: {
    lat: number; lon: number; screenX: number; screenY: number;
    countryCode?: string; countryName?: string;
  }) => void): void {
    this.onMapContextMenuCb = cb;
  }

  /** Exposed so Phase 4's pick handlers can fire the callbacks MapContainer
   *  registered, without reaching into private fields. */
  public emitHotspotClick(h: Hotspot): void { this.onHotspotClickCb?.(h); }
  public emitCountryClick(c: CountryClickPayload): void { this.onCountryClickCb?.(c); }
  public emitMapContextMenu(p: {
    lat: number; lon: number; screenX: number; screenY: number;
    countryCode?: string; countryName?: string;
  }): void { this.onMapContextMenuCb?.(p); }

  // ─── Push-setters ─────────────────────────────────────────────────────────
  //
  // One line each: record, and draw when the bridge lands. The names and
  // signatures mirror GlobeMap exactly — MapContainer's ~59 delegations are
  // unchanged by the swap.

  public setEarthquakes(v: unknown[]): void { this.push('earthquakes', v); }
  public setWeatherAlerts(v: unknown[]): void { this.push('weatherAlerts', v); }
  public setOutages(v: InternetOutage[]): void { this.push('outages', v); }
  public setTrafficAnomalies(v: unknown[]): void { this.push('trafficAnomalies', v); }
  public setDdosLocations(v: unknown[]): void { this.push('ddosLocations', v); }
  public setImageryScenes(v: unknown[]): void { this.push('imageryScenes', v); }
  public setWebcams(v: unknown[]): void { this.push('webcams', v); }
  public setCyberThreats(v: CyberThreat[]): void { this.push('cyberThreats', v); }
  public setProtests(v: SocialUnrestEvent[]): void { this.push('protests', v); }
  public setFlightDelays(v: unknown[]): void { this.push('flightDelays', v); }
  public setNaturalEvents(v: NaturalEvent[]): void { this.push('naturalEvents', v); }
  public setFires(v: unknown[]): void { this.push('fires', v); }
  public setTechEvents(v: unknown[]): void { this.push('techEvents', v); }
  public setUcdpEvents(v: UcdpGeoEvent[]): void { this.push('ucdpEvents', v); }
  public setDisplacementFlows(v: unknown[]): void { this.push('displacementFlows', v); }
  public setClimateAnomalies(v: unknown[]): void { this.push('climateAnomalies', v); }
  public setRadiationObservations(v: unknown[]): void { this.push('radiation', v); }
  public setGpsJamming(v: unknown[]): void { this.push('gpsJamming', v); }
  public setSatellites(v: unknown[]): void { this.push('satellites', v); }
  public setIranEvents(v: unknown[]): void { this.push('iranEvents', v); }
  public setNewsLocations(v: NewsItem[] | unknown[]): void { this.push('newsLocations', v); }
  public setPositiveEvents(v: unknown[]): void { this.push('positiveEvents', v); }
  public setKindnessData(v: unknown[]): void { this.push('kindness', v); }
  public setHappinessScores(v: unknown): void { this.push('happiness', v); }
  public setSpeciesRecoveryZones(v: unknown[]): void { this.push('speciesRecovery', v); }
  public setRenewableInstallations(v: unknown[]): void { this.push('renewables', v); }
  /**
   * Chokepoint status is not a marker set — it is context the waterway popup
   * reads when one is opened. Hand it straight to the popup, as GlobeMap did.
   */
  public setChokepointData(v: unknown): void {
    this.push('chokepoints', v);
    this.popup?.setChokepointData((v ?? null) as GetChokepointStatusResponse | null);
  }
  public setCIIScores(v: Array<{ code: string; score: number; level: string }>): void {
    this.push('ciiScores', v);
  }
  public setScenarioState(v: ScenarioVisualState | null): void { this.push('scenario', v); }
  public setHotspots(v: Hotspot[]): void { this.push('hotspots', v); }

  public setMilitaryFlights(v: MilitaryFlight[], clusters: MilitaryFlightCluster[] = []): void {
    this.push('militaryFlights', { flights: v, clusters });
  }

  public setMilitaryVessels(v: MilitaryVessel[], clusters: MilitaryVesselCluster[] = []): void {
    this.push('militaryVessels', { vessels: v, clusters });
  }

  public setAisData(disruptions: AisDisruptionEvent[], density: AisDensityZone[]): void {
    this.push('ais', { disruptions, density });
  }

  public setCableActivity(advisories: CableAdvisory[], repairShips: RepairShip[]): void {
    this.push('cableActivity', { advisories, repairShips });
  }

  public setCableHealth(v: Record<string, CableHealthRecord>): void {
    this.push('cableHealth', v);
  }

  public setAircraftPositions(v: unknown[]): void { this.push('aircraftPositions', v); }
  public setBlocAlignment(v: unknown[]): void { this.push('blocAlignment', v); }
  public setBypassRoutes(v: unknown): void { this.push('bypassRoutes', v); }
  public setResilienceRanking(v: unknown[]): void { this.push('resilienceRanking', v); }
  public setDiseaseOutbreaks(v: unknown[]): void { this.push('diseaseOutbreaks', v); }
  public setHotspotLevels(v: unknown): void { this.push('hotspotLevels', v); }
}
