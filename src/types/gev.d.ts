/**
 * Type surface for the vendored God's Eye View tree (src/gev/).
 *
 * Upstream is plain JavaScript and stays that way — adding annotations there
 * would make every re-vendor a merge conflict (see src/gev/UPSTREAM.md). This
 * declares only what World Monitor's TypeScript actually calls into, so the
 * boundary is typed even though the implementation is not.
 *
 * Keep this narrow. A wide `any` here would silently absorb a breaking change
 * on the next re-vendor; a narrow declaration turns it into a compile error,
 * which is the entire point of having it.
 */

declare module '@/gev/src/main.js' {
  /** Minimal Cesium Viewer surface CesiumGlobeMap depends on. */
  export interface GevCesiumViewer {
    camera: {
      flyTo(options: {
        destination: unknown;
        orientation?: unknown;
        duration?: number;
      }): void;
      positionCartographic: { longitude: number; latitude: number; height: number };
      computeViewRectangle():
        | { west: number; south: number; east: number; north: number }
        | undefined;
    };
    scene: {
      requestRender(): void;
      primitives: unknown;
      globe: { show: boolean };
      /** The WebGL canvas — ScreenSpaceEventHandler attaches to it. */
      canvas: HTMLCanvasElement;
      /** Topmost object under a screen point, or undefined. `id` is the
       *  Entity when the hit came from a data source. */
      pick(windowPosition: unknown): { id?: { id?: unknown } } | undefined;
      /** Ellipsoid intersection of a screen ray, for map-surface clicks. */
      pickPosition(windowPosition: unknown): unknown;
    };
    entities: unknown;
    dataSources: {
      add(source: unknown): Promise<unknown>;
      remove(source: unknown, destroy?: boolean): boolean;
    };
    resize(): void;
    useDefaultRenderLoop: boolean;
    isDestroyed(): boolean;
    destroy(): void;
  }

  /** What `createGevViewer` resolves to — upstream's `window.__godsEyeView`
   *  shape, plus the container and teardown this fork added. */
  export interface GevHandle {
    container: HTMLElement;
    viewer: GevCesiumViewer;
    styleManager: unknown;
    tileset: unknown;
    dataManager: {
      register(layerModule: unknown): void;
      toggle(layerId: string, options?: Record<string, unknown>): void;
      isEnabled(layerId: string): boolean;
      getEnabledLayerIds(): string[];
      destroyAll?(): Promise<void>;
    };
    sceneDirector: unknown;
    mapStackController: {
      setStack(id: string, options?: { silent?: boolean }): Promise<unknown>;
    };
    annotations: unknown;
    weatherEffects: unknown;
    cockpitCloudEffects: unknown;
    voiceCommands: unknown;
    requestRender(reason?: string): void;
    getRenderGovernorDiagnostics(): unknown;
    /** Async: StyleManager.dispose() must finish before the viewer goes. */
    destroy(): Promise<void>;
  }

  export interface CreateGevViewerOptions {
    /** Set `window.__godsEyeView`. Default true. */
    exposeGlobal?: boolean;
    /** Wire the OpenAI realtime voice control. Default true. */
    voice?: boolean;
    /** Show upstream's first-run launcher. Default true; World Monitor sets
     *  false because it owns onboarding. */
    firstRun?: boolean;
    /** Perform upstream's opening fly-to-Austin. Default true; World Monitor
     *  sets false because MapContainer's view is the opening shot. */
    initialCamera?: boolean;
  }

  export function createGevViewer(
    container: HTMLElement,
    options?: CreateGevViewerOptions,
  ): Promise<GevHandle>;
}

declare module '@/gev/src/chrome.js' {
  export function renderGevChrome(container: HTMLElement): {
    container: HTMLElement;
    destroy(): void;
  };
  export function gevEl(container: HTMLElement, id: string): HTMLElement | null;
}
