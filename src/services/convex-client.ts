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

let client: ConvexClient | null = null;
// The generated API type is complex and not worth importing statically
// since this module's purpose is lazy-loading. Callers use `api.x.y` paths.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let apiRef: Record<string, any> | null = null;

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
  return client;
}

/**
 * Returns the generated Convex API reference, loading it on first call.
 * Returns null if the import fails.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getConvexApi(): Promise<Record<string, any> | null> {
  if (apiRef) return apiRef;

  const { api } = await import('../../convex/_generated/api');
  apiRef = api;
  return apiRef;
}
