/**
 * Detect whether the current document is the /pro marketing page's
 * "live preview" iframe that embeds the full main app at
 * `https://worldmonitor.app?embed=pro-preview` for a visual dashboard
 * preview. See pro-test/src/App.tsx for the embedding site.
 *
 * This is INTENTIONALLY narrow — not a blanket "inside any iframe" check.
 * The product explicitly markets "Embeddable iframe panels" as an
 * Enterprise feature (pro-test/src/locales/en.json: whiteLabelDesc), so
 * legitimate customer embeds must continue to fire premium RPCs normally.
 * Only the /pro marketing preview, which is known-anonymous and generates
 * expected 401 noise, should short-circuit.
 *
 * Identification marker: `?embed=pro-preview` query parameter. pro-test
 * App.tsx appends it to the iframe src so this module can tell "embedded
 * specifically by /pro's preview section" apart from "embedded by a
 * customer white-label deployment". The `window.top !== window` check is
 * kept as a secondary gate so the marker alone (e.g. accidentally
 * appearing in a top-level URL) doesn't disable premium RPCs for the
 * top-level app.
 *
 * Evaluated once at module load. Caching avoids repeated URL parsing and
 * cross-origin-safe property access on every premium call.
 */
export const IS_EMBEDDED_PREVIEW: boolean = (() => {
  if (typeof window === 'undefined') return false;

  // Gate 1: must be inside a frame at all. A top-level visit to
  // worldmonitor.app?embed=pro-preview (e.g. someone linking with the
  // param by accident) should not disable premium RPCs.
  let insideFrame: boolean;
  try {
    insideFrame = window.top !== null && window.top !== window;
  } catch {
    // window.top can throw in tightly-sandboxed cross-origin contexts;
    // treat that as "inside a frame" since only framed docs see this.
    insideFrame = true;
  }
  if (!insideFrame) return false;

  // Gate 2: must carry the /pro preview's unique marker. This keeps the
  // carve-out scoped to the single known embedder rather than every
  // iframe — enterprise white-label embeds without the marker behave
  // exactly like a top-level visit.
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('embed') === 'pro-preview';
  } catch {
    return false;
  }
})();
