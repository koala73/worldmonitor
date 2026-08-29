import { createAnnotationEngine } from './annotationEngine.js';
import { createHybridAnnotationRenderer } from './hybridAnnotationRenderer.js';

/**
 * Initialize the map-annotation engine and expose it for the voice agent and
 * for manual/dev use via `window.__gevAnnotations`.
 *
 * This module is the single swap point between annotation rendering strategies.
 * The HYBRID renderer uses world-space draping for
 * footprints + screen-space SVG for callouts/rings/arrows. The engine, resolver,
 * and voice tool wiring are shared across rendering strategies.
 */
export function initAnnotations({ viewer, tileset = null }) {
  // World-space footprint draping; clamped marks can use the photoreal tiles.
  if (tileset) {
    try { tileset.enableCollision = true; } catch { /* older tileset */ }
  }
  const renderer = createHybridAnnotationRenderer(viewer);
  const engine = createAnnotationEngine({ viewer, renderer });
  window.__gevAnnotations = engine;
  return engine;
}
