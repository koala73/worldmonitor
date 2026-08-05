/**
 * Cluster-canvas WebGL context acquisition for `Map.ts`.
 *
 * `canvas.getContext('webgl')` is specified to return `null` when WebGL is
 * unavailable, and `if (!gl) return` was the whole guard. In production it can
 * also return a TRUTHY object that is not a usable `WebGLRenderingContext`:
 * canvas fingerprint-blocking extensions and hardened browsers hand back a
 * stub/proxy that passes the null check while exposing none of the GL methods.
 *
 * Calling `clearColor` on that stub threw `TypeError: this.clusterGl.clearColor
 * is not a function` out of `clearClusterCanvas()`, which sits on the
 * synchronous render path — the throw propagated through `renderClusterLayer` →
 * `renderDynamicLayers` → `render` and aborted the whole dynamic-layer pass, so
 * the user lost every overlay (earthquakes, alerts, markers), not just a canvas
 * clear that had nothing to draw anyway (WORLDMONITOR-YG/YH).
 *
 * Validating the exact members `clearClusterCanvas()` touches — rather than the
 * mere presence of an object — leaves `clusterGl` null on such a device, which
 * the existing `if (!this.clusterGl) return` already handles as a clean no-op.
 */

/** True only if `gl` exposes every member `Map.clearClusterCanvas()` uses. */
export function isUsableClusterGlContext(gl: unknown): gl is WebGLRenderingContext {
  if (!gl || typeof gl !== 'object') return false;
  const ctx = gl as Partial<WebGLRenderingContext>;
  return typeof ctx.clearColor === 'function'
    && typeof ctx.clear === 'function'
    && typeof ctx.COLOR_BUFFER_BIT === 'number';
}

/**
 * Acquire the cluster canvas' GL context, or null when the browser cannot
 * provide a usable one. Callers must treat null as "skip the GL clear".
 */
export function resolveClusterGlContext(
  canvas: Pick<HTMLCanvasElement, 'getContext'>,
): WebGLRenderingContext | null {
  const gl = canvas.getContext('webgl');
  return isUsableClusterGlContext(gl) ? gl : null;
}
