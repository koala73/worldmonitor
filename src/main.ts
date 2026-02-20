import './styles/main.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as Sentry from '@sentry/browser';
import { inject } from '@vercel/analytics';
import { App } from './App';

const sentryDsn = import.meta.env.VITE_SENTRY_DSN?.trim();

// Initialize Sentry error tracking (early as possible)
Sentry.init({
  dsn: sentryDsn || undefined,
  release: `worldmonitor@${__APP_VERSION__}`,
  environment: location.hostname === 'worldmonitor.app' ? 'production'
    : location.hostname.includes('vercel.app') ? 'preview'
    : 'development',
  enabled: Boolean(sentryDsn) && !location.hostname.startsWith('localhost') && !('__TAURI_INTERNALS__' in window),
  sendDefaultPii: true,
  tracesSampleRate: 0.1,
  ignoreErrors: [
    'Invalid WebGL2RenderingContext',
    'WebGL context lost',
    /reading 'imageManager'/,
    /ResizeObserver loop/,
    /NotAllowedError/,
    /InvalidAccessError/,
    /importScripts/,
    /^TypeError: Load failed( \(.*\))?$/,
    /^TypeError: Failed to fetch( \(.*\))?$/,
    /^TypeError: cancelled$/,
    /^TypeError: NetworkError/,
    /runtime\.sendMessage\(\)/,
    /Java object is gone/,
    /^Object captured as promise rejection with keys:/,
    /Unable to load image/,
    /Non-Error promise rejection captured with value:/,
    /Connection to Indexed Database server lost/,
    /webkit\.messageHandlers/,
    /(?:unsafe-eval.*Content Security Policy|Content Security Policy.*unsafe-eval)/,
    /Fullscreen request denied/,
    /requestFullscreen/,
    /webkitEnterFullscreen/,
    /vc_text_indicators_context/,
    /Program failed to link: null/,
    /too much recursion/,
    /zaloJSV2/,
    /Java bridge method invocation error/,
    /Could not compile fragment shader/,
    /can't redefine non-configurable property/,
    /Can.t find variable: (CONFIG|currentInset)/,
    /invalid origin/,
    /\.data\.split is not a function/,
    /signal is aborted without reason/,
    /Failed to fetch dynamically imported module/,
    /Importing a module script failed/,
    /contentWindow\.postMessage/,
    /Could not compile vertex shader/,
    /objectStoreNames/,
    /Unexpected identifier 'https'/,
    /Can't find variable: _0x/,
    /WKWebView was deallocated/,
    /Unexpected end of input/,
    /window\.android\.\w+ is not a function/,
  ],
  beforeSend(event) {
    const msg = event.exception?.values?.[0]?.value ?? '';
    if (msg.length <= 3 && /^[a-zA-Z_$]+$/.test(msg)) return null;
    const frames = event.exception?.values?.[0]?.stacktrace?.frames ?? [];
    // Suppress maplibre internal null-access crashes (light, placement) only when stack is in map chunk
    if (/this\.style\._layers|reading '_layers'|this\.light is null|can't access property "(id|type|setFilter)", \w+ is (null|undefined)|Cannot read properties of null \(reading '(id|type|setFilter|_layers)'\)|null is not an object \(evaluating '(E\.|this\.style)/.test(msg)) {
      if (frames.some(f => /\/map-[A-Za-z0-9]+\.js/.test(f.filename ?? ''))) return null;
    }
    // Suppress any TypeError that happens entirely within maplibre internals (no app code outside the map chunk)
    if (/^TypeError:/.test(msg) && frames.length > 0) {
      const appFrames = frames.filter(f => f.in_app && !/\/sentry-[A-Za-z0-9]+\.js/.test(f.filename ?? ''));
      if (appFrames.length > 0 && appFrames.every(f => /\/map-[A-Za-z0-9]+\.js/.test(f.filename ?? ''))) return null;
    }
    return event;
  },
});
// Suppress NotAllowedError from YouTube IFrame API's internal play() — browser autoplay policy,
// not actionable. The YT IFrame API doesn't expose the play() promise so it leaks as unhandled.
window.addEventListener('unhandledrejection', (e) => {
  if (e.reason?.name === 'NotAllowedError') e.preventDefault();
});

import { debugInjectTestEvents, debugGetCells, getCellCount } from '@/services/geo-convergence';
import { initMetaTags } from '@/services/meta-tags';
import { installRuntimeFetchPatch } from '@/services/runtime';
import { loadDesktopSecrets } from '@/services/runtime-config';
import { applyStoredTheme } from '@/utils/theme-manager';
import { clearChunkReloadGuard, installChunkReloadGuard } from '@/bootstrap/chunk-reload';

// Auto-reload on stale chunk 404s after deployment (Vite fires this for modulepreload failures).
const chunkReloadStorageKey = installChunkReloadGuard(__APP_VERSION__);

// Initialize Vercel Analytics
inject();

// Initialize dynamic meta tags for sharing
initMetaTags();

// In desktop mode, route /api/* calls to the local Tauri sidecar backend.
installRuntimeFetchPatch();
void loadDesktopSecrets();

// Apply stored theme preference before app initialization (safety net for inline script)
applyStoredTheme();

// Remove no-transition class after first paint to enable smooth theme transitions
requestAnimationFrame(() => {
  document.documentElement.classList.remove('no-transition');
});

// Clear stale settings-open flag (survives ungraceful shutdown)
localStorage.removeItem('wm-settings-open');

const app = new App('app');
app
  .init()
  .then(() => {
    // Clear the one-shot guard after a successful boot so future stale-chunk incidents can recover.
    clearChunkReloadGuard(chunkReloadStorageKey);
  })
  .catch(console.error);

// Debug helpers for geo-convergence testing (remove in production)
(window as unknown as Record<string, unknown>).geoDebug = {
  inject: debugInjectTestEvents,
  cells: debugGetCells,
  count: getCellCount,
};

// Beta mode toggle: type `beta=true` / `beta=false` in console
Object.defineProperty(window, 'beta', {
  get() {
    const on = localStorage.getItem('worldmonitor-beta-mode') === 'true';
    console.log(`[Beta] ${on ? 'ON' : 'OFF'}`);
    return on;
  },
  set(v: boolean) {
    if (v) localStorage.setItem('worldmonitor-beta-mode', 'true');
    else localStorage.removeItem('worldmonitor-beta-mode');
    location.reload();
  },
});

// Suppress native WKWebView context menu in Tauri — allows custom JS context menus
if ('__TAURI_INTERNALS__' in window || '__TAURI__' in window) {
  document.addEventListener('contextmenu', (e) => {
    const target = e.target as HTMLElement;
    // Allow native menu on text inputs/textareas for copy/paste
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
    e.preventDefault();
  });
}

if (!('__TAURI_INTERNALS__' in window) && !('__TAURI__' in window)) {
  import('virtual:pwa-register').then(({ registerSW }) => {
    registerSW({
      onRegisteredSW(_swUrl, registration) {
        if (registration) {
          setInterval(async () => {
            if (!navigator.onLine) return;
            try { await registration.update(); } catch {}
          }, 60 * 60 * 1000);
        }
      },
      onOfflineReady() {
        console.log('[PWA] App ready for offline use');
      },
    });
  });
}
