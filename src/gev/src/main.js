import * as Cesium from 'cesium';
import { StyleManager } from './ui.js';
import { flyToAustin } from './camera.js';
import { DataLayerManager } from './data/manager.js';
import flightsLayer from './data/flights.js';
import militaryFlightsLayer from './data/militaryFlights.js';
import earthquakesLayer from './data/earthquakes.js';
import satellitesLayer from './data/satellites.js';
import rocketLaunchesLayer from './data/rocketLaunches.js';
import trafficLayer from './data/traffic.js';
import cctvLayer from './data/cctv.js';
import radioLayer from './data/radio.js';
import bikeshareLayer from './data/bikeshare.js';
import aisLiveVesselsLayer from './data/aisLiveVessels.js';
import militaryInstallationsLayer from './data/militaryInstallations.js';
import militaryAwarenessLayer from './data/militaryAwareness.js';
import localDataLayers from './data/localLayers.js';
import { LAYER_STATE_REGISTRY } from './data/layerState.js';
import { registerDataCredits } from './data/dataCredits.js';
import { SceneDirector } from './scenes/director.js';
import { initGevVoiceCommands } from './voice/gevRealtime.js';
import { MapStackController } from './mapStackController.js';
import { initAnnotations } from './annotations/index.js';
import { initLogoGaze } from './logoGaze.js';
import { initCockpitCloudEffects } from './cockpitCloudEffects.js';
import {
  installRenderGovernor,
  uninstallRenderGovernor,
  getRenderGovernorDiagnostics,
  governorRequestRender,
  holdContinuousRender,
  releaseContinuousRender,
} from './renderGovernor.js';
import { installScopeMask } from './scopeMask.js';
import { initFirstRunExperience } from './firstRunExperience.js';
import { renderGevChrome } from './chrome.js';

/**
 * Extract a human-readable error message from any thrown value.
 * Handles Error objects, strings, and plain objects with message/error fields.
 * @param {*} error — caught exception value
 * @returns {string} best-effort error description
 */
function describeError(error) {
  if (!error) return 'Unknown initialization error';
  if (error instanceof Error) {
    if (error.message && error.message.trim()) return error.message.trim();
    return error.name || 'Initialization error';
  }
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (typeof error === 'object') {
    const maybeMessage = String(error.message || error.error || '').trim();
    if (maybeMessage) return maybeMessage;
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== '{}') return serialized;
    } catch {
      // ignore serialization error
    }
  }
  return String(error);
}

/**
 * GOD'S EYE VIEW — Main Entry Point
 * Initializes CesiumJS with Google Photorealistic 3D Tiles,
 * style system, intelligence HUD, location presets, and share links.
 *
 * AALICE:OpenEYE — this was upstream's `init()`, a page-owning bootstrap that
 * ran on module load and reached into `document` for everything it needed.
 * Embedded in World Monitor it has to be callable, repeatable and scoped, so
 * it now takes the container it should mount into and returns a handle the
 * caller can tear down.
 *
 * @param {HTMLElement} container   host element; gets the `gev-root` class
 * @param {object}      [options]
 * @param {boolean}     [options.exposeGlobal=true]  set `window.__godsEyeView`
 *        (upstream's debugging handle; also what the QA scripts under
 *        scripts/qa-*.mjs drive). Harmless, but a second instance would
 *        clobber the first, so callers mounting more than one should opt out.
 * @param {boolean}     [options.voice=true]  wire the OpenAI realtime voice
 *        control. Needs OPENAI_API_KEY on the server; the panel reports its
 *        own unavailability, so this is only for suppressing it entirely.
 * @param {boolean}     [options.initialCamera=true]  perform the opening
 *        fly-to-Austin. Opt out when the host application owns where the map
 *        opens: `flyToAustin` schedules its flight on a 500 ms timer, so a
 *        camera the host sets the moment this resolves is silently overridden
 *        half a second later. A share link still wins over both.
 * @returns {Promise<object>} the same shape upstream put on window
 */
export async function createGevViewer(container, options = {}) {
  const { exposeGlobal = true, voice = true, firstRun = true, initialCamera = true } = options;
  if (!container) throw new Error('createGevViewer: container is required');

  const chrome = renderGevChrome(container);
  // Every lookup below is container-scoped. Upstream used document-wide
  // getElementById, which escapes the namespace and would find the wrong
  // node the moment a second instance mounts.
  const el = (id) => container.querySelector(`#${CSS.escape(id)}`);

  const loadingScreen = el('loading-screen');
  const loaderStatus = loadingScreen.querySelector('.loader-status');

  // The logo gaze effect binds to [data-logo-gaze] nodes, which only exist
  // once the chrome is in the DOM — upstream could call this at module scope
  // because its markup was served with the page.
  initLogoGaze();

  try {
    loaderStatus.textContent = 'Configuring viewer...';

    // Set Cesium Ion token for World Terrain
    const cesiumToken = import.meta.env.CESIUM_ION_TOKEN;
    if (cesiumToken) {
      Cesium.Ion.defaultAccessToken = cesiumToken;
    }

    // Set Google Maps API key for 3D Tiles.
    //
    // Upstream threw here when the key was missing, which is right for a
    // standalone app whose entire point is photorealistic tiles. Embedded,
    // throwing takes a panel of the dashboard down over a missing optional
    // credential — so a keyless boot now degrades to the OSM map stack
    // instead, and says so. `mapStackController` below already models
    // 'osm' as a first-class stack for exactly this case.
    const googleApiKey = import.meta.env.GOOGLE_MAPS_API_KEY;
    if (googleApiKey) {
      Cesium.GoogleMaps.defaultApiKey = googleApiKey;
      // Exposed for geocoding in locations.js and annotationResolver.js.
      window.__GOOGLE_MAPS_API_KEY__ = googleApiKey;
    } else {
      console.warn(
        '[GEV] GOOGLE_MAPS_API_KEY is not set — Google Photorealistic 3D '
        + 'Tiles, place search and geocoding are unavailable. Falling back to '
        + 'the OSM map stack. Set GEV_GOOGLE_API_KEY in .env to enable them.',
      );
    }

    // Create the Cesium viewer with minimal chrome
    const viewer = new Cesium.Viewer(el('cesiumContainer'), {
      timeline: false,
      animation: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      vrButton: false,
      selectionIndicator: false,
      infoBox: false,
      baseLayer: false,
      // Visible attribution container — Google Maps / 3D Tiles credits are
      // required by Google's Terms of Service, so they must be shown (styled
      // subtly via #cesium-credits). The credit line stays visible in
      // clean-view AND recording modes too (ToS requires attribution while the
      // content is displayed — those are the exact modes used to record
      // demos), including the "Data attribution" link that opens the per-layer
      // license popover.
      creditContainer: (() => {
        const credits = document.createElement('div');
        credits.id = 'cesium-credits';
        // Inside the container, not document.body: `.gev-root #cesium-credits`
        // is how the stylesheet targets this, and appending to body would
        // both miss those rules and leak a stray node on teardown.
        container.appendChild(credits);
        return credits;
      })(),
      msaaSamples: 4,
      contextOptions: {
        webgl: {
          preserveDrawingBuffer: true,
        },
      },
    });

    // Cap the default render loop at 60 fps. Cesium's loop otherwise runs at
    // the display's refresh rate — 120 Hz on ProMotion panels — doubling GPU
    // and CPU burn for zero visual benefit in a map app whose animation
    // cadences (poll interpolation, trail fades, style crossfades) are all
    // designed against wall-clock time, not frame count. Measured on the
    // 2026-08-05 perf investigation as a strict halving of idle burn on
    // 120 Hz hardware; a no-op on 60 Hz displays. (perf item 2)
    viewer.targetFrameRate = 60;

    // Register per-layer data attribution into the "Data attribution" popover.
    // Required by each source's license (ODbL, CC BY-NC-SA, NASA FIRMS, etc.);
    // strings are verbatim from DATA_SOURCES.md. Static + always-present in the
    // expandable bottom-left credit lightbox (showOnScreen=false), so they never
    // clutter the on-globe attribution line.
    registerDataCredits(viewer);

    // Hide Cesium's default globe — Google Photorealistic 3D Tiles provide their own
    // globe at all LODs (street level → orbital). The default globe's 2D imagery
    // clips through 3D tile buildings at close range.
    viewer.scene.globe.show = false;

    // Keep a sky behind Google 3D Tiles, but soften Cesium's high-intensity
    // default atmosphere. With the globe hidden its bright limb otherwise
    // reads as a hard cyan seam where distant photoreal tiles meet the sky.
    viewer.scene.skyAtmosphere.show = true;
    viewer.scene.skyAtmosphere.atmosphereLightIntensity = 18;
    viewer.scene.skyAtmosphere.saturationShift = -0.12;
    viewer.scene.skyAtmosphere.brightnessShift = -0.08;

    let tileset = null;
    if (googleApiKey) {
      loaderStatus.textContent = 'Loading Google 3D Tiles...';
      try {
        // Load Google Photorealistic 3D Tiles
        tileset = await Cesium.createGooglePhotorealistic3DTileset({
          onlyUsingWithGoogleGeocoder: true,
        });
        viewer.scene.primitives.add(tileset);
        // NOTE: Cesium World Terrain intentionally disabled — conflicts with Google 3D Tiles at high zoom.
        // Google Photorealistic 3D Tiles provide their own terrain/elevation.
        viewer.scene.globe.show = false;
      } catch (tileError) {
        console.warn('[Init] Google 3D Tiles unavailable, falling back to Cesium globe:', tileError);
        const tileErrorDetail = describeError(tileError);
        loaderStatus.textContent = `Google 3D Tiles unavailable (${tileErrorDetail}). Continuing in fallback mode...`;
        // Keep Cesium globe visible as fallback instead of aborting the app.
        viewer.scene.globe.show = true;
      }
    } else {
      // Keyless boot: Cesium's own globe carries the OSM stack.
      viewer.scene.globe.show = true;
    }

    loaderStatus.textContent = 'Initializing systems...';

    const mapStackController = new MapStackController(viewer, {
      googleTileset: tileset,
      cesiumToken,
      initialStack: tileset ? 'photoreal' : 'osm',
      // Task 5 (height-datum fix): rebroadcast stack changes as a window
      // CustomEvent so data layers (CCTV per-regime ground resolution) can
      // react without coupling MapStackController to layer modules. Fires on
      // 'switching'/'ready'/'error'; listeners derive the surface regime from
      // live scene state, so intermediate emissions are harmless.
      onChange: (state) => {
        window.dispatchEvent(new CustomEvent('gev:map-stack-changed', { detail: state }));
      },
      onError: (message) => console.warn('[MapStack]', message),
    });
    await mapStackController.setStack(tileset ? 'photoreal' : 'osm', { silent: true });

    // Initialize the style manager (post-processing, HUD, locations, share links)
    const styleManager = new StyleManager(viewer, { mapStackController });
    // The previous multi-canvas weather compositor remains disabled. Cockpit
    // clouds use a separate, capped low-resolution GPU pass that never attaches
    // Cesium fog or post-process stages and is fully stopped in map mode.
    const weatherEffects = null;
    const cockpitCloudEffects = initCockpitCloudEffects(viewer);

    // If no share link state, do default fly-to Austin.
    // AALICE:OpenEYE — gated on `initialCamera` so an embedding host can own
    // the opening shot. A share link still takes precedence over both.
    if (styleManager.hasShareState) {
      loaderStatus.textContent = 'Restoring shared view...';
    } else if (initialCamera) {
      loaderStatus.textContent = 'Flying to Austin, TX...';
      flyToAustin(viewer);
    }

    // Initialize data layer manager
    const dataManager = new DataLayerManager(viewer, {
      allowQaRegistration: import.meta.env.DEV,
    });
    dataManager.register(flightsLayer);
    dataManager.register(militaryFlightsLayer);
    dataManager.register(earthquakesLayer);
    dataManager.register(satellitesLayer);
    dataManager.register(rocketLaunchesLayer);
    rocketLaunchesLayer.attachDataManager(dataManager);
    dataManager.register(trafficLayer);
    dataManager.register(cctvLayer);
    dataManager.register(radioLayer);
    dataManager.register(bikeshareLayer);
    dataManager.register(aisLiveVesselsLayer);
    dataManager.register(militaryInstallationsLayer);
    dataManager.register(militaryAwarenessLayer);
    militaryAwarenessLayer.attachDataManager(dataManager);
    for (const layer of localDataLayers) {
      dataManager.register(layer);
    }
    // Restoration starts only after the complete production registry is sealed.
    dataManager.finalizeRegistrations(LAYER_STATE_REGISTRY);
    if (import.meta.env.DEV) {
      window.__gevQaRegisterLayer = (targetManager, layerModule) => {
        if (targetManager !== dataManager) throw new Error('QA layer manager mismatch');
        return dataManager.registerForQa(layerModule);
      };
      window.__gevQaUnregisterLayer = (targetManager, layerId) => {
        if (targetManager !== dataManager) throw new Error('QA layer manager mismatch');
        return dataManager.unregisterForQa(layerId);
      };
    }
    dataManager.buildTogglePanel(el('data-toggles'));
    styleManager.attachDataManager(dataManager);

    // Initialize deterministic scene playback for social clip capture
    const sceneDirector = new SceneDirector(viewer, styleManager, dataManager);

    // Initialize the voice "whiteboard" annotation engine (world-space renderer)
    const annotations = initAnnotations({ viewer, tileset });

    // Keep startup chrome truthful: a share is not restored until camera,
    // visual/map/panel lanes, and every requested layer have terminated.
    void Promise.all([
      styleManager.initialRestorePromise,
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]).finally(() => {
      loadingScreen.classList.add('hidden');
      // Reveal only after the loading cover has yielded. transitionend can be
      // absent under reduced motion, so a bounded fallback makes this reliable.
      //
      // AALICE:OpenEYE — `firstRun` is opt-out because the host application
      // may own onboarding. World Monitor does: it has its own mission
      // picker, and upstream's launcher is a full-viewport takeover that,
      // contained inside a map panel, lands on top of it and is clipped.
      if (!firstRun) return;
      let firstRunRevealed = false;
      const revealFirstRun = () => {
        if (firstRunRevealed) return;
        firstRunRevealed = true;
        // dataManager is passed explicitly: the globe missions enable bundled
        // keyless layers through it, and reaching for styleManager._dataManager
        // would make a private field part of this feature's contract.
        initFirstRunExperience({ styleManager, dataManager });
      };
      loadingScreen.addEventListener('transitionend', revealFirstRun, { once: true });
      setTimeout(revealFirstRun, 900);
    });

    // Expose for debugging
    // Idle render governor: flips the scene into requestRenderMode whenever
    // nothing animates per frame. Installed AFTER every module above has had
    // its chance to register pre-install holds. (perf wave 2)
    installRenderGovernor(viewer);

    // The explicit scope mask replaces the emergent six-pass artifact —
    // see src/scopeMask.js. Installed before the UI so the DISPLAY-rail
    // toggle finds it live.
    installScopeMask(viewer);

    // The follow camera recomputes the tracked target's dead-reckon position
    // every frame — tracking anything is a per-frame animation. (perf wave 2)
    viewer.trackedEntityChanged.addEventListener(() => {
      if (viewer.trackedEntity) holdContinuousRender('tracked-entity');
      else releaseContinuousRender('tracked-entity');
    });

    // Hidden-state suspension (perf wave 2): when the window/tab is hidden,
    // stop the default render loop outright — a hidden canvas repaints for
    // nobody, and browser rAF throttling still lets throttled frames burn
    // GPU. Holder/data state is untouched, so return is seamless: restore
    // the loop, refresh the one DOM surface we gated, render a frame.
    const syncVisibilitySuspension = () => {
      const hidden = document.hidden;
      viewer.useDefaultRenderLoop = !hidden;
      cockpitCloudEffects?.setSuspended?.(hidden);
      if (!hidden) {
        if (dataManager._panelRefreshPendingOnVisible) {
          dataManager._panelRefreshPendingOnVisible = false;
          dataManager._refreshTogglePanel();
        }
        governorRequestRender('visibility-restore');
      }
    };
    document.addEventListener('visibilitychange', syncVisibilitySuspension);
    // Apply the CURRENT state too — bootstrap can complete while the tab is
    // already hidden, and waiting for the next transition would leave the
    // loop burning behind a hidden tab. (perf wave 2 fix)
    syncVisibilitySuspension();

    const handle = {
      container,
      viewer,
      styleManager,
      tileset,
      dataManager,
      sceneDirector,
      mapStackController,
      annotations,
      weatherEffects,
      cockpitCloudEffects,
      getRenderGovernorDiagnostics,
      requestRender: governorRequestRender,
      /**
       * Tear the instance down. Order matters: stop the render loop first so
       * nothing paints against half-destroyed state, then let each subsystem
       * release its own resources, then drop the DOM.
       */
      /**
       * Tear the viewer down.
       *
       * AALICE:OpenEYE — upstream never unmounted, so this path is new, and
       * it is worth being exact about two things it got wrong at first.
       *
       * NAMES. Each collaborator spells teardown differently:
       * StyleManager has `dispose()`, the voice controller has
       * `stop({removeUi})`, the annotation engine has `clear()`, and only
       * DataLayerManager and the cloud effects have a `destroy`-ish name.
       * Calling `x?.destroy?.()` on all of them type-checks, runs, throws
       * nothing, and tears down NOTHING — optional chaining turns a wrong
       * method name into a silent no-op. That left StyleManager's world
       * overlay alive across a remount: its MutationObserver kept firing
       * against a destroyed scene, and its two canvases were never removed,
       * so every 2D→3D→2D cycle leaked a pair of WebGL surfaces.
       *
       * ORDER. `dispose()` is async and reaches `destroyWorldOverlay()` only
       * after an internal await, so it has to be awaited BEFORE
       * `viewer.destroy()` — otherwise the overlay's teardown runs against a
       * scene that is already gone. Hence an async destroy; callers that
       * cannot await it may fire and forget, since nothing here needs the
       * caller's stack.
       */
      async destroy() {
        try { viewer.useDefaultRenderLoop = false; } catch { /* already gone */ }
        document.removeEventListener('visibilitychange', syncVisibilitySuspension);
        // Voice first — it holds a microphone stream and a websocket.
        try { handle.voiceCommands?.stop?.({ removeUi: true }); } catch { /* best effort */ }
        try { cockpitCloudEffects?.destroy?.(); } catch { /* best effort */ }
        try { annotations?.clear?.(); } catch { /* best effort */ }
        try { await dataManager.destroyAll?.(); } catch { /* best effort */ }
        // StyleManager.dispose() does not touch the IntelHUD it constructs
        // (upstream never unmounted, so nothing needed it to). Its four
        // setIntervals outlive the viewer and poll `viewer.scene` forever.
        // Torn down from here rather than by editing ui.js, to keep that
        // file byte-identical for re-vendoring.
        try { styleManager?.hud?.destroy?.(); } catch { /* best effort */ }
        try { await styleManager?.dispose?.(); } catch { /* best effort */ }
        try { viewer.destroy(); } catch { /* best effort */ }
        // Last: the governor is a module singleton, and leaving it pointing
        // at this now-destroyed viewer is what breaks the NEXT mount.
        uninstallRenderGovernor();
        chrome.destroy();
        if (exposeGlobal && window.__godsEyeView === handle) {
          delete window.__godsEyeView;
        }
      },
    };

    handle.voiceCommands = voice
      ? initGevVoiceCommands({ viewer, styleManager, dataManager, sceneDirector, annotations })
      : null;

    // Upstream's debugging handle, and what scripts/qa-*.mjs drive.
    if (exposeGlobal) window.__godsEyeView = handle;

    return handle;
  } catch (error) {
    console.error("God's Eye View initialization failed:", error);
    loaderStatus.textContent = `Error: ${describeError(error)}`;
    loaderStatus.style.color = '#ff4444';
    throw error;
  }
}
