/**
 * Arrival Choreography — wavefront rings, corona pulses, global flares
 *
 * Driven by a 2D canvas overlay on top of the map wrapper.
 * Listens to wm:breaking-news, wm:mode-changed, and wm:war-score events.
 * External callers can also invoke triggerWavefront() directly (e.g. from
 * geo-convergence detection).
 */

import type { ModeChangedDetail, WarScoreDetail } from './mode-manager';
import type { BreakingAlert } from './breaking-news-alerts';
import type { Hotspot } from '@/types';

export type ThreatType = 'conflict' | 'cyber' | 'economic' | 'natural' | 'generic';

const THREAT_COLORS: Record<ThreatType, [number, number, number]> = {
  conflict:  [255,  60,  60],
  cyber:     [  0, 220, 255],
  economic:  [255, 200,   0],
  natural:   [255, 130,   0],
  generic:   [160, 100, 255],
};

// Animation objects
interface WavefrontParticle {
  lat: number;
  lon: number;
  color: [number, number, number];
  startMs: number;
  durationMs: number;
  maxRadius: number; // px
}

interface CoronaTarget {
  lat: number;
  lon: number;
  color: [number, number, number];
  phase: number;  // radians, advances each frame
}

interface FlareParticle {
  color: [number, number, number];
  startMs: number;
  peakMs: number;   // time to peak brightness
  durationMs: number;
}

type ProjectFn = (lat: number, lon: number) => { x: number; y: number } | null;

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let canvas: HTMLCanvasElement | null = null;
let ctx2d: CanvasRenderingContext2D | null = null;
let projectFn: ProjectFn | null = null;
let rafId: number | null = null;
let currentCenter: { lat: number; lon: number } = { lat: 20, lon: 0 };

const wavefronts: WavefrontParticle[] = [];
const coronas: CoronaTarget[] = [];
const flares: FlareParticle[] = [];

// ── Canvas setup ────────────────────────────────────────────────────────────

function ensureCanvas(wrapper: HTMLElement): void {
  if (canvas) return;

  canvas = document.createElement('canvas');
  canvas.style.cssText =
    'position:absolute;top:0;left:0;width:100%;height:100%;' +
    'pointer-events:none;z-index:10;';
  wrapper.appendChild(canvas);

  const ro = new ResizeObserver(() => resizeCanvas(wrapper));
  ro.observe(wrapper);
  resizeCanvas(wrapper);

  ctx2d = canvas.getContext('2d');
}

function resizeCanvas(wrapper: HTMLElement): void {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = wrapper.offsetWidth  * dpr;
  canvas.height = wrapper.offsetHeight * dpr;
  if (ctx2d) ctx2d.scale(dpr, dpr);
}

// ── Animation loop ──────────────────────────────────────────────────────────

function startLoop(): void {
  if (rafId !== null) return;
  rafId = requestAnimationFrame(tick);
}

function tick(now: number): void {
  rafId = null;
  if (!canvas || !ctx2d) return;

  const dpr   = window.devicePixelRatio || 1;
  const W     = canvas.width  / dpr;
  const H     = canvas.height / dpr;
  const paused = document.body.classList.contains('animations-paused');

  ctx2d.clearRect(0, 0, W, H);

  if (!paused) {
    drawFlares(now, W, H);
    drawWavefronts(now);
    drawCoronas();
  }

  // Prune expired wavefronts and flares (iterate backwards to allow splice)
  for (let i = wavefronts.length - 1; i >= 0; i--) {
    const w = wavefronts[i] as WavefrontParticle;
    if (now - w.startMs > w.durationMs) wavefronts.splice(i, 1);
  }
  for (let i = flares.length - 1; i >= 0; i--) {
    const f = flares[i] as FlareParticle;
    if (now - f.startMs > f.durationMs) flares.splice(i, 1);
  }

  const hasActive = wavefronts.length > 0 || coronas.length > 0 || flares.length > 0;
  if (hasActive) startLoop();
}

// ── Wavefront drawing ───────────────────────────────────────────────────────

function drawWavefronts(now: number): void {
  if (!ctx2d || !projectFn) return;
  for (const w of wavefronts) {
    const pt = projectFn(w.lat, w.lon);
    if (!pt) continue;

    const t       = Math.min(1, (now - w.startMs) / w.durationMs);
    // ease-out cubic
    const eased   = 1 - (1 - t) ** 3;
    const radius  = eased * w.maxRadius;
    const alpha   = (1 - t) * 0.75;
    if (alpha <= 0) continue;

    const [r, g, b] = w.color;
    ctx2d.save();
    ctx2d.beginPath();
    ctx2d.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
    ctx2d.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
    ctx2d.lineWidth   = 2;
    ctx2d.stroke();

    // Second trailing ring slightly smaller and more transparent
    if (radius > 20) {
      ctx2d.beginPath();
      ctx2d.arc(pt.x, pt.y, radius * 0.65, 0, Math.PI * 2);
      ctx2d.strokeStyle = `rgba(${r},${g},${b},${alpha * 0.4})`;
      ctx2d.lineWidth   = 1;
      ctx2d.stroke();
    }
    ctx2d.restore();
  }
}

// ── Corona drawing ──────────────────────────────────────────────────────────

const CORONA_PHASE_SPEED = 0.04; // rad per frame (~2.4 rad/s at 60fps)

function drawCoronas(): void {
  if (!ctx2d || !projectFn) return;
  for (const c of coronas) {
    const pt = projectFn(c.lat, c.lon);
    if (!pt) continue;

    c.phase += CORONA_PHASE_SPEED;
    const pulse  = 0.5 + 0.5 * Math.sin(c.phase); // 0 → 1 → 0
    const radius = 18 + pulse * 12;
    const alpha  = 0.35 + pulse * 0.25;
    const [r, g, b] = c.color;

    ctx2d.save();
    // Glow fill
    const grad = ctx2d.createRadialGradient(pt.x, pt.y, radius * 0.4, pt.x, pt.y, radius);
    grad.addColorStop(0,   `rgba(${r},${g},${b},${(alpha * 0.3).toFixed(3)})`);
    grad.addColorStop(1,   `rgba(${r},${g},${b},0)`);
    ctx2d.fillStyle = grad;
    ctx2d.beginPath();
    ctx2d.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
    ctx2d.fill();

    // Outer stroke
    ctx2d.beginPath();
    ctx2d.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
    ctx2d.strokeStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
    ctx2d.lineWidth   = 1.5;
    ctx2d.stroke();
    ctx2d.restore();
  }
}

// ── Global flare drawing ────────────────────────────────────────────────────

function drawFlares(now: number, W: number, H: number): void {
  if (!ctx2d) return;
  for (const f of flares) {
    const elapsed = now - f.startMs;
    let alpha: number;
    if (elapsed < f.peakMs) {
      alpha = (elapsed / f.peakMs) * 0.16;
    } else {
      const decay = (elapsed - f.peakMs) / (f.durationMs - f.peakMs);
      alpha = (1 - decay) * 0.16;
    }
    if (alpha <= 0) continue;
    const [r, g, b] = f.color;
    ctx2d.save();
    ctx2d.fillStyle = `rgba(${r},${g},${b},${alpha.toFixed(4)})`;
    ctx2d.fillRect(0, 0, W, H);
    ctx2d.restore();
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Update the current map center used as default wavefront origin.
 * Called by DeckGLMap on each state-change.
 */
export function setCurrentCenter(lat: number, lon: number): void {
  currentCenter = { lat, lon };
}

/**
 * Initialise the choreography system, attaching a canvas overlay to the map wrapper.
 * Must be called once after the map DOM is ready.
 */
export function initArrivalChoreography(wrapper: HTMLElement, project: ProjectFn): void {
  projectFn = project;
  ensureCanvas(wrapper);
  wireEvents();
}

/**
 * Trigger an expanding wavefront ring from a geographic point.
 */
export function triggerWavefront(lat: number, lon: number, type: ThreatType = 'generic'): void {
  if (REDUCED_MOTION) return;
  wavefronts.push({
    lat,
    lon,
    color: THREAT_COLORS[type],
    startMs: performance.now(),
    durationMs: 2600,
    maxRadius: 280,
  });
  startLoop();
}

/**
 * Add a persistent looping corona pulse at a location (call updateCoronas to manage).
 */
export function triggerCorona(lat: number, lon: number, type: ThreatType = 'generic'): void {
  if (REDUCED_MOTION) return;
  // Avoid duplicates within 0.5° grid
  const key = `${Math.round(lat * 2)},${Math.round(lon * 2)}`;
  const existing = coronas.find(c =>
    `${Math.round(c.lat * 2)},${Math.round(c.lon * 2)}` === key
  );
  if (existing) { existing.color = THREAT_COLORS[type]; return; }

  coronas.push({ lat, lon, color: THREAT_COLORS[type], phase: Math.random() * Math.PI * 2 });
  startLoop();
}

/**
 * Replace the full set of corona targets (synced to current high-severity hotspots).
 */
export function setCoronaTargets(hotspots: Pick<Hotspot, 'lat' | 'lon' | 'level'>[]): void {
  coronas.length = 0;
  if (REDUCED_MOTION) return;
  for (const h of hotspots) {
    if (h.level === 'high') {
      coronas.push({
        lat: h.lat,
        lon: h.lon,
        color: THREAT_COLORS['conflict'],
        phase: Math.random() * Math.PI * 2,
      });
    }
  }
  if (coronas.length > 0) startLoop();
}

/**
 * Trigger a full-screen dim/flare overlay tied to threat type.
 */
export function triggerGlobalFlare(type: ThreatType = 'generic'): void {
  if (REDUCED_MOTION) return;
  flares.push({
    color: THREAT_COLORS[type],
    startMs: performance.now(),
    peakMs: 250,
    durationMs: 1400,
  });
  startLoop();
}

// ── Event wiring ─────────────────────────────────────────────────────────────

function originToThreatType(origin: BreakingAlert['origin']): ThreatType {
  switch (origin) {
    case 'military_surge':
    case 'hotspot_escalation': return 'conflict';
    default: return 'generic';
  }
}

let eventsWired = false;
function wireEvents(): void {
  if (eventsWired) return;
  eventsWired = true;

  // Breaking news → wavefront from map center + flare on critical
  document.addEventListener('wm:breaking-news', ((e: CustomEvent<BreakingAlert>) => {
    const { threatLevel, origin } = e.detail;
    const type = originToThreatType(origin);
    triggerWavefront(currentCenter.lat, currentCenter.lon, type);
    if (threatLevel === 'critical') triggerGlobalFlare(type);
  }) as EventListener);

  // War score crossing threshold → global flare
  document.addEventListener('wm:war-score', ((e: CustomEvent<WarScoreDetail>) => {
    if (e.detail.score >= e.detail.threshold) triggerGlobalFlare('conflict');
  }) as EventListener);

  // Mode transition → flare
  document.addEventListener('wm:mode-changed', ((e: CustomEvent<ModeChangedDetail>) => {
    const { mode } = e.detail;
    if (mode === 'war')      triggerGlobalFlare('conflict');
    if (mode === 'disaster') triggerGlobalFlare('natural');
    if (mode === 'finance')  triggerGlobalFlare('economic');
  }) as EventListener);
}
