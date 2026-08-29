const MAX_GAZE_SVG_UNITS = 34;
const FULL_GAZE_DISTANCE_PX = 320;
const GAZE_EASING = 0.2;
const GAZE_EPSILON = 0.08;

/**
 * Convert a viewport pointer position into a bounded SVG-space gaze offset.
 * The response ramps up near the logo, then caps so the globe stays in the eye.
 *
 * @param {number} clientX - Pointer x coordinate in CSS pixels.
 * @param {number} clientY - Pointer y coordinate in CSS pixels.
 * @param {{left:number, top:number, width:number, height:number}} rect - Logo bounds.
 * @param {number} [maxOffset=MAX_GAZE_SVG_UNITS] - Maximum SVG-space translation.
 * @returns {{x:number, y:number}}
 */
export function calculateLogoGaze(clientX, clientY, rect, maxOffset = MAX_GAZE_SVG_UNITS) {
  const values = [clientX, clientY, rect?.left, rect?.top, rect?.width, rect?.height, maxOffset];
  if (!values.every(Number.isFinite) || rect.width <= 0 || rect.height <= 0 || maxOffset < 0) {
    return { x: 0, y: 0 };
  }

  const dx = clientX - (rect.left + rect.width / 2);
  const dy = clientY - (rect.top + rect.height / 2);
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return { x: 0, y: 0 };

  const strength = Math.min(distance / FULL_GAZE_DISTANCE_PX, 1);
  const scale = maxOffset * strength / distance;
  return { x: dx * scale, y: dy * scale };
}

/**
 * Make every same-origin logo object marked with `data-logo-gaze` follow the
 * pointer. Only the globe and its latitude/longitude cage move; the eye shell
 * remains fixed. Returns a cleanup callback.
 *
 * @param {Document|Element} [root=document] - DOM root to search.
 * @returns {() => void}
 */
export function initLogoGaze(root = document) {
  if (typeof window === 'undefined' || !root?.querySelectorAll) return () => {};

  const logos = [...root.querySelectorAll('[data-logo-gaze]')];
  if (!logos.length) return () => {};

  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const states = logos.map((element) => ({
    element,
    parts: [],
    currentX: 0,
    currentY: 0,
    targetX: 0,
    targetY: 0,
  }));
  let animationFrame = 0;
  let disposed = false;

  const applyTransform = (state) => {
    const transform = `translate(${state.currentX.toFixed(2)} ${state.currentY.toFixed(2)})`;
    for (const part of state.parts) part.setAttribute('transform', transform);
  };

  const animate = () => {
    animationFrame = 0;
    let keepAnimating = false;

    for (const state of states) {
      const deltaX = state.targetX - state.currentX;
      const deltaY = state.targetY - state.currentY;

      if (Math.abs(deltaX) <= GAZE_EPSILON && Math.abs(deltaY) <= GAZE_EPSILON) {
        state.currentX = state.targetX;
        state.currentY = state.targetY;
      } else {
        state.currentX += deltaX * GAZE_EASING;
        state.currentY += deltaY * GAZE_EASING;
        keepAnimating = true;
      }
      applyTransform(state);
    }

    if (keepAnimating) animationFrame = window.requestAnimationFrame(animate);
  };

  const scheduleAnimation = () => {
    if (!animationFrame) animationFrame = window.requestAnimationFrame(animate);
  };

  const loadInlineLogos = async () => {
    try {
      const source = logos[0].dataset.logoSrc || '/logo.svg';
      const response = await window.fetch(source);
      if (!response.ok) return;
      const markup = await response.text();
      if (disposed) return;

      const svgDocument = new DOMParser().parseFromString(markup, 'image/svg+xml');
      if (svgDocument.querySelector('parsererror')) return;
      const sourceSvg = svgDocument.documentElement;

      for (const state of states) {
        const svg = sourceSvg.cloneNode(true);
        svg.removeAttribute('role');
        svg.removeAttribute('aria-labelledby');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');
        svg.querySelector('title')?.remove();
        state.element.replaceChildren(svg);
        state.parts = [
          svg.querySelector('#globe'),
          svg.querySelector('#globe_cage'),
        ].filter(Boolean);
        applyTransform(state);
      }
    } catch {
      // Keep the already-rendered <img> fallback if the inline asset cannot load.
    }
  };

  if (!reducedMotion) loadInlineLogos();

  const onPointerMove = (event) => {
    if (reducedMotion || event.pointerType === 'touch') return;
    for (const state of states) {
      const gaze = calculateLogoGaze(event.clientX, event.clientY, state.element.getBoundingClientRect());
      state.targetX = gaze.x;
      state.targetY = gaze.y;
    }
    scheduleAnimation();
  };

  const resetGaze = () => {
    for (const state of states) {
      state.targetX = 0;
      state.targetY = 0;
    }
    scheduleAnimation();
  };

  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('blur', resetGaze);
  document.documentElement.addEventListener('pointerleave', resetGaze);

  return () => {
    disposed = true;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('blur', resetGaze);
    document.documentElement.removeEventListener('pointerleave', resetGaze);
    if (animationFrame) window.cancelAnimationFrame(animationFrame);
  };
}
