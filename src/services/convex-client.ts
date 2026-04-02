/**
 * Shared ConvexClient singleton for frontend services.
 *
 * Both the entitlement subscription and the checkout service need a
 * ConvexClient instance. This module provides a single lazy-loaded
 * client to avoid duplicate WebSocket connections.
 *
 * The client and API reference are loaded via dynamic import so they
 * don't impact the initial bundle size.
 */

import type { ConvexClient } from 'convex/browser';
import { getClerkToken, clearClerkTokenCache } from './clerk';

// Use typeof to get the exact generated API type without importing statically
type ConvexApi = typeof import('../../convex/_generated/api').api;

let client: ConvexClient | null = null;
let apiRef: ConvexApi | null = null;

/**
 * Returns the shared ConvexClient instance, creating it on first call.
 * Returns null if VITE_CONVEX_URL is not configured.
 */
export async function getConvexClient(): Promise<ConvexClient | null> {
  if (client) return client;

  const convexUrl = import.meta.env.VITE_CONVEX_URL;
  if (!convexUrl) return null;

  const { ConvexClient: CC } = await import('convex/browser');
  client = new CC(convexUrl);
  client.setAuth(async ({ forceRefreshToken }: { forceRefreshToken?: boolean } = {}) => {
    if (forceRefreshToken) {
      clearClerkTokenCache();
    }
    return getClerkToken();
  });
  return client;
}

/**
 * Returns the generated Convex API reference, loading it on first call.
 * Returns null if the import fails.
 */
export async function getConvexApi(): Promise<ConvexApi | null> {
  if (apiRef) return apiRef;

  const { api } = await import('../../convex/_generated/api');
  apiRef = api;
  return apiRef;
}
