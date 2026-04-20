/**
 * Detect whether the current document is loaded inside a same-origin iframe —
 * specifically, the /pro marketing page's "live preview" iframe that embeds
 * the full main app at `https://worldmonitor.app?alert=false` for a visual
 * dashboard preview.
 *
 * The iframe is anonymous (no Clerk session carries over the embedding
 * boundary in a reliable way), so every premium RPC call it attempts will
 * 401. Those 401s are not user-visible failures — each panel's circuit
 * breaker falls through to its empty fallback and the preview still renders
 * — but they flood the top-level /pro console and Sentry with expected
 * noise that wastes debugging cycles.
 *
 * Premium fetchers consult this flag at entry and short-circuit, returning
 * the same empty fallback they would have reached via the 401 → breaker
 * catch path, without firing the network request. See pro-test/src/App.tsx
 * (the `<iframe src="https://worldmonitor.app?alert=false" ...>` tag) for
 * the embed site, and `src/services/premium-fetch.ts` for the auth chain
 * this bypasses.
 *
 * Evaluated once at module load. `window.top` and `window` only change on
 * programmatic reparenting (extremely rare); caching the boolean avoids the
 * repeated cross-origin-safe property access on every premium call.
 */
export const IS_EMBEDDED_PREVIEW: boolean = (() => {
  if (typeof window === 'undefined') return false;
  try {
    return window.top !== null && window.top !== window;
  } catch {
    // Accessing window.top can throw in cross-origin iframe contexts.
    // If we can't read it, we're almost certainly inside a sandboxed iframe.
    return true;
  }
})();
