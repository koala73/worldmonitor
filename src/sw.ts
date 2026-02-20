/// <reference lib="webworker" />

import { clientsClaim } from 'workbox-core';
import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching';
import { registerRoute, NavigationRoute } from 'workbox-routing';
import { CacheFirst, NetworkFirst, StaleWhileRevalidate } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';

declare let self: ServiceWorkerGlobalScope;

self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();

// Build-time manifest injection for hashed JS/CSS and selected static assets.
precacheAndRoute(self.__WB_MANIFEST);

// App-shell navigation fallback for SPA routes.
const navigationHandler = createHandlerBoundToURL('/index.html');
registerRoute(
  new NavigationRoute(navigationHandler, {
    denylist: [/^\/api\//, /^\/settings/],
  }),
);

// Map styles (JSON) + map tiles: stale-while-revalidate for quick repeat visits.
registerRoute(
  ({ url, request }) => {
    if (request.destination === 'image') {
      return /(^|\.)basemaps\.cartocdn\.com$/.test(url.hostname) || url.hostname === 'api.maptiler.com';
    }
    if (request.destination !== 'style' && request.destination !== '') {
      return false;
    }
    const isMapStyleJson =
      (/(^|\.)basemaps\.cartocdn\.com$/.test(url.hostname) && url.pathname.endsWith('/style.json')) ||
      (url.hostname === 'api.maptiler.com' && url.pathname.endsWith('.json'));
    return isMapStyleJson;
  },
  new StaleWhileRevalidate({
    cacheName: 'map-assets-v1',
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 600, maxAgeSeconds: 30 * 24 * 60 * 60 }),
    ],
  }),
);

// API: try fresh first, but fall back to cached responses when offline/slow.
registerRoute(
  ({ url }) => url.pathname.startsWith('/api/'),
  new NetworkFirst({
    cacheName: 'api-responses-v1',
    networkTimeoutSeconds: 4,
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 250, maxAgeSeconds: 24 * 60 * 60 }),
    ],
  }),
);

// Google Fonts: cache first because assets are immutable.
registerRoute(
  ({ url }) => url.hostname === 'fonts.gstatic.com',
  new CacheFirst({
    cacheName: 'google-fonts-webfonts',
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 30, maxAgeSeconds: 365 * 24 * 60 * 60 }),
    ],
  }),
);

registerRoute(
  ({ url }) => url.hostname === 'fonts.googleapis.com',
  new StaleWhileRevalidate({
    cacheName: 'google-fonts-stylesheets',
    plugins: [new ExpirationPlugin({ maxEntries: 10, maxAgeSeconds: 365 * 24 * 60 * 60 })],
  }),
);
