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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let apiRef: any = null;

/**
 * Returns the shared ConvexClient instance, creating it on first call.
 * Returns null if VITE_CONVEX_URL is not configured.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getConvexClient(): Promise<any | null> {
  if (client) return client;

  const convexUrl = import.meta.env.VITE_CONVEX_URL;
  if (!convexUrl) return null;

  const { ConvexClient } = await import('convex/browser');
  client = new ConvexClient(convexUrl);
  return client;
}

/**
 * Returns the generated Convex API reference, loading it on first call.
 * Returns null if the import fails.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getConvexApi(): Promise<any | null> {
  if (apiRef) return apiRef;

  const { api } = await import('../../convex/_generated/api');
  apiRef = api;
  return apiRef;
}
