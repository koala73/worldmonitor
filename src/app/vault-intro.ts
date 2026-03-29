// Biometric vault intro — Three.js 3D + bloom post-processing.
// Door splits left/right on ACCESS GRANTED, camera flies through.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { GTAOPass }    from 'three/addons/postprocessing/GTAOPass.js';
import { SMAAPass }    from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass }  from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass }  from 'three/addons/postprocessing/ShaderPass.js';
import { hasTauriInvokeBridge, invokeTauri } from '../services/tauri-bridge';

const CMD            = 'plugin:biometry|authenticate';
const REASON         = 'Unlock World Monitor';
const BRIDGE_TIMEOUT = 2500;
const POLL_MS        = 50;

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForBridge(): Promise<boolean> {
  if (hasTauriInvokeBridge()) return true;
  const t = Date.now() + BRIDGE_TIMEOUT;
  while (Date.now() < t) {
    await sleep(POLL_MS);
    if (hasTauriInvokeBridge()) return true;
  }
  return false;
}

function newACtx(): AudioContext | null {
  try { return new AudioContext(); } catch { return null; }
}

// ── Audio ─────────────────────────────────────────────────────────────────────

// Space vault power-up: deep electrical hum charging up, then a rising
// electronic tone as the locking system energises.
function playMotorWhine(ctx: AudioContext): void {
  const t0 = ctx.currentTime;

  // Sub-bass capacitor charge hum (55 → 82 Hz)
  const hum = ctx.createOscillator(); hum.type = 'sine';
  hum.frequency.setValueAtTime(55, t0);
  hum.frequency.exponentialRampToValueAtTime(82, t0 + 1.4);
  const humG = ctx.createGain();
  humG.gain.setValueAtTime(0, t0);
  humG.gain.linearRampToValueAtTime(0.24, t0 + 0.22);
  humG.gain.setValueAtTime(0.24, t0 + 1.1);
  humG.gain.linearRampToValueAtTime(0, t0 + 1.9);
  hum.connect(humG).connect(ctx.destination);
  hum.start(t0); hum.stop(t0 + 2);

  // Mid electrical buzz (sawtooth, filtered to ~200 Hz band)
  const buzz = ctx.createOscillator(); buzz.type = 'sawtooth';
  buzz.frequency.setValueAtTime(105, t0 + 0.08);
  buzz.frequency.exponentialRampToValueAtTime(190, t0 + 1);
  const buzzF = ctx.createBiquadFilter(); buzzF.type = 'lowpass'; buzzF.frequency.value = 550;
  const buzzG = ctx.createGain();
  buzzG.gain.setValueAtTime(0, t0 + 0.08);
  buzzG.gain.linearRampToValueAtTime(0.08, t0 + 0.35);
  buzzG.gain.setValueAtTime(0.08, t0 + 1);
  buzzG.gain.linearRampToValueAtTime(0, t0 + 1.6);
  buzz.connect(buzzF).connect(buzzG).connect(ctx.destination);
  buzz.start(t0 + 0.08); buzz.stop(t0 + 1.7);

  // High electronic power-up sweep (sci-fi "charging" tone)
  const sweep = ctx.createOscillator(); sweep.type = 'sine';
  sweep.frequency.setValueAtTime(320, t0 + 0.5);
  sweep.frequency.exponentialRampToValueAtTime(1440, t0 + 1.6);
  const sweepG = ctx.createGain();
  sweepG.gain.setValueAtTime(0, t0 + 0.5);
  sweepG.gain.linearRampToValueAtTime(0.052, t0 + 0.7);
  sweepG.gain.setValueAtTime(0.052, t0 + 1.4);
  sweepG.gain.linearRampToValueAtTime(0, t0 + 1.7);
  sweep.connect(sweepG).connect(ctx.destination);
  sweep.start(t0 + 0.5); sweep.stop(t0 + 1.8);
}

// Two heavy magnetic bolts releasing — deep THOOM + metallic ring + hydraulic hiss.
function playBoltRetracts(ctx: AudioContext): void {
  const t0 = ctx.currentTime;

  for (let i = 0; i < 2; i++) {
    const t = t0 + i * 0.38;

    // Sub-bass impact thud (60 → 22 Hz decay)
    const thud = ctx.createOscillator(); thud.type = 'sine';
    thud.frequency.setValueAtTime(60, t);
    thud.frequency.exponentialRampToValueAtTime(22, t + 0.2);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.9, t);
    tg.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
    thud.connect(tg).connect(ctx.destination);
    thud.start(t); thud.stop(t + 0.26);

    // Metallic resonance ring (decaying bell-like tone)
    const ring = ctx.createOscillator(); ring.type = 'sine';
    ring.frequency.setValueAtTime(380, t + 0.01);
    ring.frequency.exponentialRampToValueAtTime(240, t + 0.5);
    const rg = ctx.createGain();
    rg.gain.setValueAtTime(0.2, t + 0.01);
    rg.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
    ring.connect(rg).connect(ctx.destination);
    ring.start(t + 0.01); ring.stop(t + 0.58);

    // Hydraulic/pneumatic hiss as bolt slides back
    const hisBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.18), ctx.sampleRate);
    const hd = hisBuf.getChannelData(0);
    for (let j = 0; j < hd.length; j++) hd[j] = Math.random() * 2 - 1;
    const hSrc = ctx.createBufferSource(); hSrc.buffer = hisBuf;
    const hbp = ctx.createBiquadFilter(); hbp.type = 'bandpass'; hbp.frequency.value = 1600; hbp.Q.value = 0.7;
    const hg = ctx.createGain();
    hg.gain.setValueAtTime(0.14, t + 0.06);
    hg.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    hSrc.connect(hbp).connect(hg).connect(ctx.destination);
    hSrc.start(t + 0.06);
  }
}

// Space vault door splitting open:
// 1. Massive pressure-seal release (sub-bass whomp + air rush)
// 2. Deep rumble of huge door panels sliding on magnetic rails
// 3. High-frequency electromagnetic servo whine
// 4. Resonant low tone — the vault's structural mass vibrating
// 5. Breathable-air whoosh as atmospheres equalise
function playDoorOpen(ctx: AudioContext): void {
  const t0 = ctx.currentTime + 0.04;

  // ── 1. Pressure seal RELEASE — sub-bass punch + low-pass noise whomp ──
  const wpOsc = ctx.createOscillator(); wpOsc.type = 'sine';
  wpOsc.frequency.setValueAtTime(52, t0);
  wpOsc.frequency.exponentialRampToValueAtTime(24, t0 + 0.28);
  const wpG = ctx.createGain();
  wpG.gain.setValueAtTime(0.95, t0);
  wpG.gain.exponentialRampToValueAtTime(0.001, t0 + 0.3);
  wpOsc.connect(wpG).connect(ctx.destination);
  wpOsc.start(t0); wpOsc.stop(t0 + 0.32);

  // Fast burst of filtered noise for the pressure pop
  const popBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.22), ctx.sampleRate);
  const popD = popBuf.getChannelData(0);
  for (let i = 0; i < popD.length; i++) popD[i] = Math.random() * 2 - 1;
  const popSrc = ctx.createBufferSource(); popSrc.buffer = popBuf;
  const popF = ctx.createBiquadFilter(); popF.type = 'lowpass'; popF.frequency.value = 140;
  const popG = ctx.createGain();
  popG.gain.setValueAtTime(0.7, t0);
  popG.gain.exponentialRampToValueAtTime(0.001, t0 + 0.22);
  popSrc.connect(popF).connect(popG).connect(ctx.destination);
  popSrc.start(t0);

  // ── 2. Door-panel movement rumble — very deep, long sustained ──
  const rumbBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 2.6), ctx.sampleRate);
  const rD = rumbBuf.getChannelData(0);
  for (let i = 0; i < rD.length; i++) rD[i] = Math.random() * 2 - 1;
  const rSrc = ctx.createBufferSource(); rSrc.buffer = rumbBuf;
  const rF1 = ctx.createBiquadFilter(); rF1.type = 'lowpass'; rF1.frequency.value = 48;
  const rF2 = ctx.createBiquadFilter(); rF2.type = 'highpass'; rF2.frequency.value = 18;
  const rG = ctx.createGain();
  rG.gain.setValueAtTime(0, t0 + 0.05);
  rG.gain.linearRampToValueAtTime(0.58, t0 + 0.3);
  rG.gain.setValueAtTime(0.58, t0 + 1.3);
  rG.gain.linearRampToValueAtTime(0, t0 + 2.6);
  rSrc.connect(rF1).connect(rF2).connect(rG).connect(ctx.destination);
  rSrc.start(t0 + 0.05);

  // ── 3. Electromagnetic servo motors — high sci-fi whine ──
  const srvOsc = ctx.createOscillator(); srvOsc.type = 'sawtooth';
  srvOsc.frequency.setValueAtTime(1800, t0 + 0.02);
  srvOsc.frequency.exponentialRampToValueAtTime(3200, t0 + 0.25);
  srvOsc.frequency.exponentialRampToValueAtTime(950, t0 + 1.9);
  const srvF = ctx.createBiquadFilter(); srvF.type = 'bandpass'; srvF.frequency.value = 2200; srvF.Q.value = 3.5;
  const srvG = ctx.createGain();
  srvG.gain.setValueAtTime(0, t0 + 0.02);
  srvG.gain.linearRampToValueAtTime(0.065, t0 + 0.18);
  srvG.gain.setValueAtTime(0.065, t0 + 1.5);
  srvG.gain.linearRampToValueAtTime(0, t0 + 2.1);
  srvOsc.connect(srvF).connect(srvG).connect(ctx.destination);
  srvOsc.start(t0 + 0.02); srvOsc.stop(t0 + 2.15);

  // ── 4. Structural resonance — low bell of the vault's mass ──
  const bellOsc = ctx.createOscillator(); bellOsc.type = 'sine';
  bellOsc.frequency.setValueAtTime(88, t0 + 0.08);
  bellOsc.frequency.exponentialRampToValueAtTime(62, t0 + 1.4);
  const bellG = ctx.createGain();
  bellG.gain.setValueAtTime(0.32, t0 + 0.08);
  bellG.gain.exponentialRampToValueAtTime(0.001, t0 + 2.2);
  bellOsc.connect(bellG).connect(ctx.destination);
  bellOsc.start(t0 + 0.08); bellOsc.stop(t0 + 2.25);

  // ── 5. Atmosphere equalisation — mid-frequency air rush ──
  const airBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 1.4), ctx.sampleRate);
  const aD = airBuf.getChannelData(0);
  for (let i = 0; i < aD.length; i++) aD[i] = Math.random() * 2 - 1;
  const airSrc = ctx.createBufferSource(); airSrc.buffer = airBuf;
  const airF = ctx.createBiquadFilter(); airF.type = 'bandpass'; airF.frequency.value = 2800; airF.Q.value = 0.45;
  const airG = ctx.createGain();
  airG.gain.setValueAtTime(0, t0 + 0.18);
  airG.gain.linearRampToValueAtTime(0.22, t0 + 0.5);
  airG.gain.setValueAtTime(0.22, t0 + 0.85);
  airG.gain.linearRampToValueAtTime(0, t0 + 1.45);
  airSrc.connect(airF).connect(airG).connect(ctx.destination);
  airSrc.start(t0 + 0.18);
}

// Sci-fi access granted: two ascending terminal beeps then a warm chord.
function playAuthConfirmed(ctx: AudioContext): void {
  const t0 = ctx.currentTime;

  // Two crisp electronic beeps (ascending)
  for (const [delay, freq] of [[0, 660], [0.2, 990]] as const) {
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0 + delay);
    g.gain.linearRampToValueAtTime(0.15, t0 + delay + 0.018);
    g.gain.setValueAtTime(0.15, t0 + delay + 0.1);
    g.gain.linearRampToValueAtTime(0, t0 + delay + 0.19);
    o.connect(g).connect(ctx.destination);
    o.start(t0 + delay); o.stop(t0 + delay + 0.22);
  }

  // Warm confirmation chord (minor 3rd + 5th, sustains)
  for (const [freq, del] of [[330, 0.36], [392, 0.38], [494, 0.4]] as const) {
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0 + del);
    g.gain.linearRampToValueAtTime(0.06, t0 + del + 0.04);
    g.gain.setValueAtTime(0.06, t0 + del + 0.28);
    g.gain.linearRampToValueAtTime(0, t0 + del + 0.6);
    o.connect(g).connect(ctx.destination);
    o.start(t0 + del); o.stop(t0 + del + 0.65);
  }
}

function playVoiceAuthenticated(): void {
  if (!('speechSynthesis' in window)) return;
  const utter = new SpeechSynthesisUtterance('Authenticated');
  utter.lang   = 'en-US';
  utter.rate   = 1;
  utter.pitch  = 1;
  utter.volume = 1;
  window.speechSynthesis.speak(utter);
}

// ── Fingerprint ridge drawing ─────────────────────────────────────────────────
// Loop-pattern fingerprint: horizontal ridges that arch upward at center.
// This is the classic fingerprint silhouette — NOT concentric circles.
// Noise is deterministic so pattern is stable across redraws.

function drawFingerprintRidges(
  c: CanvasRenderingContext2D,
  size: number,
  alpha: number,
  lineW: number,
): void {
  const cx = size * 0.5;
  const cy = size * 0.5 + size * 0.016;
  const padW = size * 0.78;
  const padH = size * 0.8;
  const ridgeCount = 28;
  const STEPS = 80;

  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.lineWidth = lineW;

  for (let i = 0; i < ridgeCount; i++) {
    const t = i / (ridgeCount - 1);              // 0 = top, 1 = bottom
    const y0 = cy - padH * 0.5 + t * padH;

    // Arch is tallest at the center, flattens toward top/bottom
    const distFromCenter = Math.abs(t - 0.46) * 2;
    const archH = padH * 0.145 * Math.max(0, 1 - distFromCenter * 0.62);

    c.globalAlpha = alpha * (0.72 + (1 - distFromCenter) * 0.28);
    c.beginPath();

    for (let s = 0; s <= STEPS; s++) {
      const tx = s / STEPS;                       // 0 = left edge, 1 = right edge
      const x  = cx - padW * 0.5 + tx * padW;

      // Primary arch
      const arch = archH * Math.sin(tx * Math.PI);

      // Deterministic organic wobble (3 harmonics, stable per ridge index)
      const noise =
        Math.sin(tx * 9  + i * 2.31) * padH * 0.0042 +
        Math.sin(tx * 17 - i * 1.58) * padH * 0.0021 +
        Math.sin(tx * 31 + i * 3.77) * padH * 0.001;

      const y = y0 - arch + noise;
      if (s === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.stroke();
  }

  // Core delta — small enclosed loop at the apex of the arch pattern
  const loopCy = cy - padH * 0.065;
  c.globalAlpha = alpha * 0.82;
  c.lineWidth = lineW;
  c.beginPath();
  c.ellipse(cx, loopCy, padW * 0.055, padH * 0.048, 0, 0, Math.PI * 2);
  c.stroke();
}

// ── Scanner state ─────────────────────────────────────────────────────────────

type ScannerState = 'idle' | 'warmup' | 'peak' | 'error' | 'success';

interface AnimState {
  scanner:          ScannerState;
  glowPhase:        number;
  boltRetractStart: number | null;
  openStartTime:    number | null;
  statusText:       string;
  statusAlpha:      number;
  fingerAlpha:      number;
}

function initState(): AnimState {
  return {
    scanner:          'idle',
    glowPhase:        0,
    boltRetractStart: null,
    openStartTime:    null,
    statusText:       '',
    statusAlpha:      0,
    fingerAlpha:      0.44,
  };
}

// ── Environment map ───────────────────────────────────────────────────────────

// ── Procedural surface textures ───────────────────────────────────────────────

function createBumpMap(): THREE.CanvasTexture {
  const size = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, size, size);
  const cx = size / 2, cy = size / 2;
  const ringCount = 60;
  for (let i = 1; i <= ringCount; i++) {
    const r = (i / ringCount) * (size / 2 - 2);
    const brightness = i % 2 === 0 ? 195 : 72;
    ctx.strokeStyle = `rgb(${brightness},${brightness},${brightness})`;
    ctx.lineWidth = Math.max(1, (size / 2 / ringCount) * 0.7);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  return new THREE.CanvasTexture(cv);
}

function createTurnedPlateTexture(): THREE.CanvasTexture {
  const size = 1024;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d')!;

  // Mid-grey steel base — material tint handles the darkness; the map adds surface detail
  ctx.fillStyle = '#58606a';
  ctx.fillRect(0, 0, size, size);
  const cx = size / 2, cy = size / 2;

  // Lathe-turned concentric rings — 3-ring groups (bright/mid/dark) for high contrast
  for (let r = 1; r < size * 0.72; r += 1.4) {
    const n    = Math.random();
    const band = Math.floor(r / 2.8) % 3;
    const lum  = band === 0 ? 155 + n * 60 : (band === 1 ? 90 + n * 45 : 38 + n * 30);
    const a    = band === 0 ? 0.45 + n * 0.4 : 0.2 + n * 0.35;
    ctx.strokeStyle = `rgba(${Math.floor(lum)},${Math.floor(lum + 4)},${Math.floor(lum + 8)},${a})`;
    ctx.lineWidth   = 0.6 + Math.random() * 1.1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Radial micro-scratches — handling wear
  for (let i = 0; i < 80; i++) {
    const angle = Math.random() * Math.PI * 2;
    const r1    = 10 + Math.random() * size * 0.32;
    const r2    = r1 + 12 + Math.random() * size * 0.14;
    const lum   = Math.floor(180 + Math.random() * 60);
    ctx.strokeStyle = `rgba(${lum},${lum},${lum + 6},${0.03 + Math.random() * 0.06})`;
    ctx.lineWidth   = 0.4;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * r1, cy + Math.sin(angle) * r1);
    ctx.lineTo(cx + Math.cos(angle) * r2, cy + Math.sin(angle) * r2);
    ctx.stroke();
  }

  // Edge darkening — vignette simulating oxidation/wear at panel edges
  const vig = ctx.createRadialGradient(cx, cy, size * 0.28, cx, cy, size * 0.62);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.52)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, size, size);

  return new THREE.CanvasTexture(cv);
}

function createBrushedSteelTexture(): THREE.CanvasTexture {
  const size = 512;
  const cv = document.createElement('canvas');
  cv.width = size; cv.height = size;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#0c1620';
  ctx.fillRect(0, 0, size, size);
  for (let y = 0; y < size; y++) {
    const n = Math.random();
    if (n > 0.45) {
      const lum = Math.floor(n * 38);
      ctx.strokeStyle = `rgba(${14 + lum},${24 + lum},${34 + lum},${0.25 + n * 0.55})`;
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(size, y + 0.5);
      ctx.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 3);
  return tex;
}

function createEnvMap(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();

  // 2048×1024 — maximum texel count for the sharpest possible chrome highlights.
  // The physics of why chrome looks real: a VERY bright, VERY narrow source
  // surrounded by near-total darkness. Without that contrast, metal looks plastic.
  const W = 2048, H = 1024;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d')!;

  // ── Base: near-total darkness (vault room) ────────────────────────────────
  c.fillStyle = '#020408';
  c.fillRect(0, 0, W, H);

  // ── Upper dome: faint cool ambient (ceiling bounce) ───────────────────────
  const dome = c.createLinearGradient(0, 0, 0, H * 0.22);
  dome.addColorStop(0,   'rgba(38,58,88,1)');
  dome.addColorStop(0.6, 'rgba(14,22,36,1)');
  dome.addColorStop(1,   'rgba(2,4,8,1)');
  c.fillStyle = dome;
  c.fillRect(0, 0, W, H * 0.22);

  // ── TWO ultra-narrow overhead fluorescent tubes ───────────────────────────
  // Tube 1 — primary (4px wide, 70% of width centered)
  const t1 = c.createLinearGradient(0, 0, 0, 6);
  t1.addColorStop(0, 'rgba(255,255,255,1)');
  t1.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = t1;
  c.fillRect(W * 0.15, 0, W * 0.7, 6);

  // Halo around tube 1 (soft fall-off so it bleeds into chrome naturally)
  const t1halo = c.createLinearGradient(0, 0, 0, 28);
  t1halo.addColorStop(0,   'rgba(200,228,255,0.80)');
  t1halo.addColorStop(0.5, 'rgba(100,155,220,0.30)');
  t1halo.addColorStop(1,   'rgba(0,0,0,0)');
  c.fillStyle = t1halo;
  c.fillRect(W * 0.15, 0, W * 0.7, 28);

  // Tube 2 — secondary, slightly offset (two-tube fixture look)
  const t2 = c.createLinearGradient(0, 6, 0, 12);
  t2.addColorStop(0, 'rgba(230,245,255,0.55)');
  t2.addColorStop(1, 'rgba(230,245,255,0)');
  c.fillStyle = t2;
  c.fillRect(W * 0.28, 4, W * 0.44, 8);

  // Full-width very faint ceiling glow (reflects off the door from above)
  const ceilGlow = c.createLinearGradient(0, 0, 0, 18);
  ceilGlow.addColorStop(0,   'rgba(160,210,255,0.22)');
  ceilGlow.addColorStop(1,   'rgba(0,0,0,0)');
  c.fillStyle = ceilGlow;
  c.fillRect(0, 0, W, 18);

  // ── Left rim light (cool blue, simulates off-camera fill) ────────────────
  const leftRim = c.createRadialGradient(W * 0.03, H * 0.28, 0, W * 0.03, H * 0.28, W * 0.22);
  leftRim.addColorStop(0,   'rgba(80,140,210,0.52)');
  leftRim.addColorStop(0.5, 'rgba(35,70,130,0.18)');
  leftRim.addColorStop(1,   'rgba(0,0,0,0)');
  c.fillStyle = leftRim;
  c.fillRect(0, 0, W * 0.38, H);

  // ── Right rim light (slightly cooler, dimmer) ─────────────────────────────
  const rightRim = c.createRadialGradient(W * 0.97, H * 0.22, 0, W * 0.97, H * 0.22, W * 0.2);
  rightRim.addColorStop(0,   'rgba(100,165,230,0.40)');
  rightRim.addColorStop(0.6, 'rgba(45,85,145,0.12)');
  rightRim.addColorStop(1,   'rgba(0,0,0,0)');
  c.fillStyle = rightRim;
  c.fillRect(W * 0.62, 0, W * 0.38, H);

  // ── Equator band: subtle front reflection (vault face seen in chrome) ─────
  // Chrome rings looking straight at the vault door see this band
  const eqBand = c.createLinearGradient(0, H * 0.35, 0, H * 0.65);
  eqBand.addColorStop(0,   'rgba(0,0,0,0)');
  eqBand.addColorStop(0.5, 'rgba(12,18,28,0.55)');
  eqBand.addColorStop(1,   'rgba(0,0,0,0)');
  c.fillStyle = eqBand;
  c.fillRect(W * 0.15, H * 0.35, W * 0.7, H * 0.3);

  // ── Floor bounce: faint warm uptick (concrete floor below door) ───────────
  const floor = c.createLinearGradient(0, H * 0.78, 0, H);
  floor.addColorStop(0,   'rgba(0,0,0,0)');
  floor.addColorStop(1,   'rgba(22,18,14,0.45)');
  c.fillStyle = floor;
  c.fillRect(0, H * 0.78, W, H * 0.22);

  const tex = new THREE.CanvasTexture(cv);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  const envTex = pmrem.fromEquirectangular(tex).texture;
  tex.dispose();
  pmrem.dispose();
  return envTex;
}

// ── CSS ───────────────────────────────────────────────────────────────────────

function injectStyles(): void {
  if (document.getElementById('vault-intro-css')) return;
  const s = document.createElement('style');
  s.id = 'vault-intro-css';
  s.textContent = `
    @keyframes vi-fadein { from{opacity:0} to{opacity:1} }
    .vi-vignette {
      position:fixed; inset:0; pointer-events:none; z-index:10000;
      background: radial-gradient(ellipse 78% 78% at 50% 50%,
        transparent 30%, rgba(0,0,0,0.50) 70%, rgba(0,0,0,0.92) 100%);
    }
    .vi-grain {
      position:fixed; inset:0; pointer-events:none; z-index:10001;
      opacity:0.038; mix-blend-mode:overlay;
    }
  `;
  document.head.append(s);
}

// ── Half-geometry helpers ─────────────────────────────────────────────────────
// Disc faces camera after rotation.x = PI/2.
// In screen space (viewed from +Z), theta increases CLOCKWISE.
// Left half (x<0): theta from PI/2 → 3PI/2 (bottom→left→top arc)
// Right half (x>0): theta from -PI/2 → PI/2 (top→right→bottom arc, same as 3PI/2→PI/2 CW)

function halfDisc(r: number, h: number, side: -1 | 1): THREE.BufferGeometry {
  const tStart = side === -1 ? Math.PI / 2 : -Math.PI / 2;
  return new THREE.CylinderGeometry(r, r, h, 96, 1, false, tStart, Math.PI);
}

// TorusGeometry arc always starts at +X (right). Arc=PI gives top-half.
// Rotate mesh.rotation.z = +PI/2 → left half; -PI/2 → right half.
function halfTorus(r: number, tube: number): THREE.BufferGeometry {
  return new THREE.TorusGeometry(r, tube, 36, 128, Math.PI);
}
function halfTorusMesh(r: number, tube: number, side: -1 | 1, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(halfTorus(r, tube), mat);
  m.rotation.z = side === -1 ? Math.PI / 2 : -Math.PI / 2;
  return m;
}

// ── PBR texture loader ────────────────────────────────────────────────────────

interface VaultTextures {
  diffuse:   THREE.Texture;
  normal:    THREE.Texture;
  roughness: THREE.Texture;
  ao:        THREE.Texture;
}

async function loadVaultTextures(): Promise<VaultTextures | null> {
  const loader = new THREE.TextureLoader();
  const load = (path: string): Promise<THREE.Texture> =>
    new Promise((res, rej) => loader.load(path, res, undefined, rej));
  try {
    const [diffuse, normal, roughness, ao] = await Promise.all([
      load('/vault-tex/metal_plate_diff_1k.jpg'),
      load('/vault-tex/metal_plate_nor_gl_1k.jpg'),
      load('/vault-tex/metal_plate_rough_1k.jpg'),
      load('/vault-tex/metal_plate_ao_1k.jpg'),
    ]);
    for (const t of [diffuse, normal, roughness, ao]) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
    }
    return { diffuse, normal, roughness, ao };
  } catch (error) {
    console.warn('[vault-intro] PBR textures not available, using procedural fallback:', error);
    return null;
  }
}

// ── Three.js vault scene ──────────────────────────────────────────────────────

// W bolt in doorLeft, E bolt in doorRight.  N/S slots null.
interface BoltCfg { x: number; y: number; dx: number; dy: number; rz: number; }
const BOLT_CFG: (BoltCfg | null)[] = [
  { x:  0,    y:  2.42, dx:  0, dy:  1, rz:  0           },  // N (rightDoor)
  { x:  1.84, y:  0,    dx:  1, dy:  0, rz: -Math.PI / 2 },  // E (rightDoor)
  { x:  0,    y: -2.42, dx:  0, dy: -1, rz:  Math.PI     },  // S (leftDoor)
  { x: -1.84, y:  0,    dx: -1, dy:  0, rz:  Math.PI / 2 },  // W (leftDoor)
];

interface VaultScene {
  renderer:      THREE.WebGLRenderer;
  composer:      EffectComposer;
  scene:         THREE.Scene;
  camera:        THREE.PerspectiveCamera;
  doorLeft:      THREE.Group;   // slides left on open
  doorRight:     THREE.Group;   // slides right on open
  scannerGroup:  THREE.Group;   // centered — fades then camera flies through
  boltGroups:    (THREE.Group | null)[];
  scannerRing:   THREE.Mesh;
  scanArc:       THREE.Mesh;
  ledMeshes:     THREE.Mesh[];
  ledLight:      THREE.PointLight;
  fpCanvas:      HTMLCanvasElement;
  fpTexture:     THREE.CanvasTexture;
  fpMesh:        THREE.Mesh;
  interiorLight: THREE.PointLight;
  cameraStartZ:  number;
  flashEl:       HTMLDivElement | null;
  overlayEl:     HTMLDivElement | null;
}

function buildVaultScene(canvas: HTMLCanvasElement, pbr: VaultTextures | null): VaultScene {
  const w = window.innerWidth;
  const h = window.innerHeight;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x06_10_1A);
  scene.fog = new THREE.Fog(0x06_10_1A, 10, 24);
  scene.environment = createEnvMap(renderer);
  scene.environmentIntensity = 0.85;

  const camera = new THREE.PerspectiveCamera(42, w / h, 0.1, 60);
  const cameraStartZ = 5.6;
  camera.position.set(0, -0.35, cameraStartZ);
  camera.lookAt(0, 0.2, 0);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  // Ground Truth Ambient Occlusion — adds realistic contact shadows in crevices
  const gtao = new GTAOPass(scene, camera, w, h);
  composer.addPass(gtao);

  // Bloom — stronger so fingerprint/LEDs glow visibly
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(Math.round(w / 2), Math.round(h / 2)),
    0.34,
    0.38,
    0.72,
  );
  composer.addPass(bloom);

  // Chromatic aberration — lens colour fringing at the edges (cinematic)
  const chromaPass = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, amount: { value: 0.0028 } },
    vertexShader: [
      'varying vec2 vUv;',
      'void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    ].join('\n'),
    fragmentShader: [
      'uniform sampler2D tDiffuse;',
      'uniform float amount;',
      'varying vec2 vUv;',
      'void main(){',
      '  vec2 dir=normalize(vUv-0.5);',
      '  float d=length(vUv-0.5);',
      '  vec2 off=dir*d*amount;',
      '  float r=texture2D(tDiffuse,vUv+off).r;',
      '  float g=texture2D(tDiffuse,vUv    ).g;',
      '  float b=texture2D(tDiffuse,vUv-off).b;',
      '  gl_FragColor=vec4(r,g,b,1.0);',
      '}',
    ].join('\n'),
  });
  composer.addPass(chromaPass);

  // SMAA anti-aliasing — eliminates jagged edges on all ring geometry
  composer.addPass(new SMAAPass());

  // OutputPass — correct sRGB conversion at the very end of the chain
  composer.addPass(new OutputPass());

  // ── Lighting ─────────────────────────────────────────────────────────────
  scene.add(new THREE.AmbientLight(0x05_08_10, 0.12));

  // Hard key light from upper-left — creates shadows in door recesses
  const key = new THREE.DirectionalLight(0xD8_EA_FF, 3.8);
  key.position.set(-4, 10, 5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 32;
  key.shadow.camera.left   = -6;
  key.shadow.camera.right  =  6;
  key.shadow.camera.top    =  6;
  key.shadow.camera.bottom = -6;
  key.shadow.bias = -0.0005;
  scene.add(key);

  // Warm fill from lower-right (floor bounce off polished floor)
  const fill = new THREE.DirectionalLight(0x50_30_20, 0.9);
  fill.position.set(5, -3, 3);
  scene.add(fill);

  // Cool rim from behind-left — edge glow on chrome
  const rimL = new THREE.DirectionalLight(0x1A_30_60, 1.6);
  rimL.position.set(-6, 1, -2);
  scene.add(rimL);

  const ledLight = new THREE.PointLight(0x30_70_CC, 0.2, 5.5);
  ledLight.position.set(0, 0, 2);
  scene.add(ledLight);

  const interiorLight = new THREE.PointLight(0xA0_C0_FF, 0, 22);
  interiorLight.position.set(0, 0, -7);
  scene.add(interiorLight);

  // ── Room ─────────────────────────────────────────────────────────────────
  buildRoom(scene);

  // ── Shared materials ─────────────────────────────────────────────────────
  const turnedTex  = createTurnedPlateTexture();
  const brushedTex = createBrushedSteelTexture();

  // doorFaceMat: PBR textures when available, procedural fallback otherwise
  const bumpTex = createBumpMap();
  const doorFaceMat = pbr
    ? new THREE.MeshPhysicalMaterial({
        color:              0xD0_D8_E0,
        map:                pbr.diffuse,
        normalMap:          pbr.normal,
        normalScale:        new THREE.Vector2(1.8, 1.8),
        roughnessMap:       pbr.roughness,
        roughness:          1,
        aoMap:              pbr.ao,
        aoMapIntensity:     1.2,
        metalness:          0.92,
        clearcoat:          0.25,
        clearcoatRoughness: 0.18,
      })
    : new THREE.MeshPhysicalMaterial({
        color: 0xFF_FF_FF, map: turnedTex, bumpMap: bumpTex, bumpScale: 0.005,
        metalness: 0.88, roughness: 0.28, clearcoat: 0.2, clearcoatRoughness: 0.22,
      });
  const steelMat    = new THREE.MeshPhysicalMaterial({ color: 0x1A_25_30, map: brushedTex, metalness: 0.86, roughness: 0.3, clearcoat: 0.15, clearcoatRoughness: 0.25 });
  const chromeMat   = new THREE.MeshPhysicalMaterial({ color: 0x88_99_AA, metalness: 0.99, roughness: 0.02, clearcoat: 1,  clearcoatRoughness: 0.02 });
  const darkMat     = new THREE.MeshPhysicalMaterial({ color: 0x03_05_08, metalness: 0.55, roughness: 0.88, clearcoat: 0,  clearcoatRoughness: 0.5  });
  const boltMat     = new THREE.MeshPhysicalMaterial({ color: 0x28_32_40, metalness: 0.9, roughness: 0.18, clearcoat: 0.3,  clearcoatRoughness: 0.15 });
  const pistonMat   = new THREE.MeshPhysicalMaterial({ color: 0x3A_50_60, metalness: 0.94, roughness: 0.1, clearcoat: 0.6,  clearcoatRoughness: 0.08 });

  // ── doorLeft & doorRight — rectangular steel plate vault door ─────────────
  const doorLeft  = new THREE.Group();
  const doorRight = new THREE.Group();
  scene.add(doorLeft);
  scene.add(doorRight);

  // Door dimensions — each half is 1.54 wide
  const DW = 1.54;   // half-width
  const DH = 4.2;   // full height
  const DD = 0.56;   // thickness (depth)

  // Tile the PBR textures properly for BoxGeometry rectangular UVs
  if (pbr) {
    for (const t of [pbr.diffuse, pbr.normal, pbr.roughness, pbr.ao]) {
      t.repeat.set(1.2, 2.2);
    }
  }

  // Slightly darker chrome for raised bands (more contrast against bright chrome rings)
  const bandMat = new THREE.MeshPhysicalMaterial({
    color: 0x4A_5A_6A, metalness: 0.94, roughness: 0.14, clearcoat: 0.4, clearcoatRoughness: 0.12,
  });

  for (const [grp, side] of [[doorLeft, -1], [doorRight, 1]] as [THREE.Group, -1|1][]) {
    const cx = side * DW * 0.5;

    // ── Main steel plate body (BoxGeometry → rectangular UVs → PBR maps tile correctly) ──
    const body = new THREE.Mesh(new THREE.BoxGeometry(DW, DH, DD), doorFaceMat);
    body.position.set(cx, 0, 0);
    body.castShadow = true;
    body.receiveShadow = true;
    grp.add(body);

    // ── Chrome outer edge (wall-facing side) ──
    const outerEdge = new THREE.Mesh(
      new THREE.BoxGeometry(0.042, DH + 0.04, DD + 0.016), chromeMat,
    );
    outerEdge.position.set(cx + side * (DW * 0.5 + 0.021), 0, 0);
    grp.add(outerEdge);

    // ── Thin chrome seam (center split line) ──
    const seam = new THREE.Mesh(
      new THREE.BoxGeometry(0.012, DH, DD + 0.008), chromeMat,
    );
    seam.position.set(cx - side * (DW * 0.5 - 0.006), 0, 0);
    grp.add(seam);

    // ── Top and bottom chrome caps ──
    for (const sy of [-1, 1] as const) {
      const cap = new THREE.Mesh(
        new THREE.BoxGeometry(DW + 0.042, 0.036, DD + 0.016), chromeMat,
      );
      cap.position.set(cx, sy * (DH * 0.5 + 0.018), 0);
      grp.add(cap);
    }

    // ── Horizontal raised chrome bands (4 per half — mechanical look) ──
    for (const by of [-1.45, -0.48, 0.48, 1.45]) {
      const band = new THREE.Mesh(
        new THREE.BoxGeometry(DW - 0.08, 0.018, DD * 0.065), bandMat,
      );
      band.position.set(cx, by, DD * 0.5 + 0.005);
      grp.add(band);
    }

    // ── 3 locking pin cylinders on the split (inner) edge ──
    for (let pi = 0; pi < 3; pi++) {
      const py = (pi - 1) * (DH * 0.27);
      const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.13, 10), chromeMat);
      pin.rotation.z = Math.PI / 2;
      pin.position.set(cx - side * (DW * 0.5 + 0.045), py, DD * 0.08);
      grp.add(pin);
    }

    // ── Recessed inset panels (between the horizontal bands) ──────────────────
    // Two deep rectangular wells per half — break up the flat steel face,
    // cast natural shadow, and give the door proper physical depth.
    const recessPanelMat = new THREE.MeshPhysicalMaterial({
      color: 0x10_18_22, metalness: 0.85, roughness: 0.55,
    });
    for (const py of [-0.96, 0.96]) {
      // Back face of inset
      const insetBack = new THREE.Mesh(
        new THREE.BoxGeometry(DW - 0.2, 0.8, 0.002), recessPanelMat,
      );
      insetBack.position.set(cx, py, DD * 0.5 - 0.048);
      grp.add(insetBack);

      // Four thin chrome lips framing each inset well
      const lipH = new THREE.BoxGeometry(DW - 0.18, 0.014, 0.048);
      const lipV = new THREE.BoxGeometry(0.014, 0.8, 0.048);
      for (const [gy, gx] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
        const isHoriz = gx === 0;
        const lip = new THREE.Mesh(isHoriz ? lipH : lipV, chromeMat);
        lip.position.set(
          cx + gx * ((DW - 0.18) * 0.5 - 0.002),
          py + gy * (0.8 * 0.5 - 0.002),
          DD * 0.5 - 0.022,
        );
        grp.add(lip);
      }
    }

    // ── Scanner mounting disc — half-circle on door face, split between halves ──
    // Uses halfDisc so the two halves form a complete circle when door is closed.
    const mountMat = new THREE.MeshPhysicalMaterial({
      color: 0x2A_35_40, metalness: 0.92, roughness: 0.1, clearcoat: 0.5, clearcoatRoughness: 0.08,
    });
    const mount = new THREE.Mesh(halfDisc(0.75, 0.036, side), mountMat);
    mount.rotation.x = Math.PI / 2;
    mount.position.z = DD * 0.5 + 0.012;
    grp.add(mount);

    // ── Chrome groove ring around scanner mount ──
    const groove = halfTorusMesh(0.75, 0.018, side, chromeMat);
    groove.position.z = DD * 0.5 + 0.032;
    grp.add(groove);
  }

  // ── Status LEDs — 4 per half, mounted along inner edge ───────────────────
  const ledMeshes: THREE.Mesh[] = [];

  for (const [grp, side] of [[doorLeft, -1], [doorRight, 1]] as [THREE.Group, -1|1][]) {
    const ledX = side * (DW * 0.5 - 0.12);
    for (const ledY of [-1.5, -0.5, 0.5, 1.5]) {
      const housing = new THREE.Mesh(new THREE.BoxGeometry(0.088, 0.088, 0.018), darkMat);
      housing.position.set(ledX, ledY, DD * 0.5 + 0.005);
      grp.add(housing);

      const ledMat = new THREE.MeshStandardMaterial({
        color: 0xB8_D8_FF,
        emissive: new THREE.Color(0xB8_D8_FF),
        emissiveIntensity: 2.5,
        metalness: 0, roughness: 0.5,
      });
      const led = new THREE.Mesh(new THREE.BoxGeometry(0.054, 0.016, 0.02), ledMat);
      led.position.set(ledX, ledY, DD * 0.5 + 0.016);
      grp.add(led);
      ledMeshes.push(led);
    }
  }

  // ── Bolt arms (W in doorLeft, E in doorRight) ─────────────────────────────
  const boltGroups: (THREE.Group | null)[] = [null, null, null, null];

  // N/E bolts → rightDoor; S/W bolts → leftDoor
  boltGroups[0] = buildBoltArm(doorRight, BOLT_CFG[0]!, boltMat, pistonMat, chromeMat);
  boltGroups[1] = buildBoltArm(doorRight, BOLT_CFG[1]!, boltMat, pistonMat, chromeMat);
  boltGroups[2] = buildBoltArm(doorLeft,  BOLT_CFG[2]!, boltMat, pistonMat, chromeMat);
  boltGroups[3] = buildBoltArm(doorLeft,  BOLT_CFG[3]!, boltMat, pistonMat, chromeMat);

  // ── scannerGroup — stays centered, camera flies through it ───────────────
  const scannerGroup = new THREE.Group();
  scene.add(scannerGroup);

  // Multi-ring scanner barrel — scaled to fit embedded-in-door aesthetic
  const barrelSteps = [
    { r: 0.55, z: 0.09, rw: 0.028 },
    { r: 0.43, z: -0.02, rw: 0.022 },
    { r: 0.32, z: -0.1, rw: 0.018 },
    { r: 0.22, z: -0.16, rw: 0.014 },
  ];
  for (let si = 0; si < barrelSteps.length; si++) {
    const step = barrelSteps[si]!;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(step.r, step.rw, 32, 128), chromeMat);
    ring.position.z = step.z;
    scannerGroup.add(ring);

    if (si < barrelSteps.length - 1) {
      const next = barrelSteps[si + 1]!;
      const wallH = step.z - next.z;
      const wallR = (step.r + next.r) / 2 - 0.01;
      const wall = new THREE.Mesh(new THREE.CylinderGeometry(wallR, wallR, wallH, 96, 1, true), steelMat);
      wall.rotation.x = Math.PI / 2;
      wall.position.z = (step.z + next.z) / 2;
      scannerGroup.add(wall);
    }
  }

  // Dark scanner glass at deepest recess
  const scanFloor = new THREE.Mesh(
    new THREE.CylinderGeometry(0.2, 0.2, 0.04, 48),
    new THREE.MeshStandardMaterial({ color: 0x03_02_08, metalness: 0.22, roughness: 0.94 }),
  );
  scanFloor.rotation.x = Math.PI / 2;
  scanFloor.position.z = -0.2;
  scannerGroup.add(scanFloor);

  // Main scanner glow ring
  const scannerRingMat = new THREE.MeshStandardMaterial({
    color: 0x10_0C_1C,
    metalness: 0.85,
    roughness: 0.14,
    emissive: new THREE.Color(0x3A_06_06),
    emissiveIntensity: 1,
  });
  const scannerRing = new THREE.Mesh(new THREE.TorusGeometry(0.46, 0.038, 36, 128), scannerRingMat);
  scannerRing.rotation.x = 0.16;
  scannerRing.position.z = 0.1;
  scannerGroup.add(scannerRing);

  // Rotating scan arc
  const scanArcMat = new THREE.MeshStandardMaterial({
    color: 0xFF_1A_00,
    emissive: new THREE.Color(0xFF_1A_00),
    emissiveIntensity: 5,
    transparent: true,
    opacity: 0,
  });
  const scanArc = new THREE.Mesh(new THREE.TorusGeometry(0.43, 0.008, 10, 72, Math.PI * 1.5), scanArcMat);
  scanArc.position.z = 0.14;
  scannerGroup.add(scanArc);

  // ── Sensor glass face ─────────────────────────────────────────────────────
  const sensorGlassMat = new THREE.MeshPhysicalMaterial({
    color: 0x04_08_10,
    metalness: 0,
    roughness: 0.08,
    transmission: 0.55,
    thickness: 0.04,
    ior: 1.5,
    transparent: true,
    opacity: 0.92,
  });
  const sensorDisc = new THREE.Mesh(
    new THREE.CylinderGeometry(0.2, 0.2, 0.018, 80),
    sensorGlassMat,
  );
  sensorDisc.rotation.x = Math.PI / 2;
  sensorDisc.position.z = 0.02;
  scannerGroup.add(sensorDisc);

  // Thin chrome bezel ring around the sensor
  const sensorBezel = new THREE.Mesh(
    new THREE.TorusGeometry(0.205, 0.01, 16, 96),
    chromeMat,
  );
  sensorBezel.position.z = 0.03;
  scannerGroup.add(sensorBezel);

  // ── Fingerprint plane ─────────────────────────────────────────────────────
  const fpCanvas = document.createElement('canvas');
  fpCanvas.width = fpCanvas.height = 768;
  const fpTexture = new THREE.CanvasTexture(fpCanvas);
  fpTexture.colorSpace = THREE.SRGBColorSpace;

  const fpMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0, 0, 0),
    map: fpTexture,
    emissive: new THREE.Color(1, 1, 1),
    emissiveMap: fpTexture,
    emissiveIntensity: 3,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    metalness: 0,
    roughness: 1,
  });
  const fpMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.42), fpMat);
  fpMesh.position.z = 0.06;
  scannerGroup.add(fpMesh);

  // Enable shadows on all meshes in one pass
  scene.traverse(obj => {
    if (obj instanceof THREE.Mesh) {
      obj.castShadow    = true;
      obj.receiveShadow = true;
    }
  });

  // Pre-compile shaders to eliminate first-frame stutter
  renderer.compile(scene, camera);
  composer.render();

  return {
    renderer, composer, scene, camera,
    doorLeft, doorRight, scannerGroup,
    boltGroups, scannerRing, scanArc,
    ledMeshes, ledLight, fpCanvas, fpTexture, fpMesh,
    interiorLight, cameraStartZ,
    flashEl: null, overlayEl: null,
  };
}


// ── Bolt arm ──────────────────────────────────────────────────────────────────

function buildBoltArm(
  grp: THREE.Group,
  cfg: BoltCfg,
  boltMat: THREE.MeshStandardMaterial,
  pistonMat: THREE.MeshStandardMaterial,
  chromeMat: THREE.MeshStandardMaterial,
): THREE.Group {
  const bg = new THREE.Group();
  bg.position.set(cfg.x, cfg.y, 0.02);
  bg.rotation.z = cfg.rz;

  const piston = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.78, 20), boltMat);
  piston.position.y = 0.05;
  bg.add(piston);

  const head = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.07, 20), pistonMat);
  head.position.y = -0.35;
  bg.add(head);

  const tipRing = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.016, 8, 20), chromeMat);
  tipRing.rotation.x = Math.PI / 2;
  tipRing.position.y = -0.35;
  bg.add(tipRing);

  grp.add(bg);
  return bg;
}

// ── Room geometry ─────────────────────────────────────────────────────────────

function buildRoom(scene: THREE.Scene): void {
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x05_07_0F, roughness: 0.95, metalness: 0.04 });
  const panelMat = new THREE.MeshStandardMaterial({ color: 0x09_0C_18, roughness: 0.88, metalness: 0.14 });

  const bwall = new THREE.Mesh(new THREE.PlaneGeometry(32, 18), wallMat);
  bwall.position.z = -4.5; scene.add(bwall);

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(32, 14), panelMat);
  floor.rotation.x = -Math.PI / 2; floor.position.y = -3.2; scene.add(floor);

  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(32, 14), wallMat);
  ceil.rotation.x = Math.PI / 2; ceil.position.y = 3.9; scene.add(ceil);

  for (const [sign, angle] of [[-1, Math.PI / 2], [1, -Math.PI / 2]] as [number, number][]) {
    const sw = new THREE.Mesh(new THREE.PlaneGeometry(14, 18), wallMat);
    sw.rotation.y = angle; sw.position.x = sign * 8.5; scene.add(sw);
  }

  // Overhead fluorescent fixtures
  const fixMat = new THREE.MeshStandardMaterial({
    color: 0xFF_FF_FF, emissive: new THREE.Color(0xD4_EE_FF), emissiveIntensity: 1,
  });
  for (const fz of [-0.6, -2.2]) {
    const fix = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.055, 0.35), fixMat);
    fix.position.set(0, 3.84, fz); scene.add(fix);
    const fl = new THREE.PointLight(0xC0_D8_F0, 2, 14);
    fl.position.set(0, 3.65, fz); scene.add(fl);
  }

  // Rectangular vault door frame (matches the rectangular door)
  const recessMat = new THREE.MeshStandardMaterial({ color: 0x06_0C_18, metalness: 0.88, roughness: 0.22 });
  const FW = 3.28;  // frame inner width (matches door)
  const FH = 4.28;  // frame inner height
  const FT = 0.52;  // frame thickness
  const FZ = -0.3; // z position

  // Top bar
  const frameTop = new THREE.Mesh(new THREE.BoxGeometry(FW + FT * 2 + 0.1, FT, FT + 0.2), recessMat);
  frameTop.position.set(0, FH / 2 + FT / 2, FZ); scene.add(frameTop);

  // Bottom bar
  const frameBot = new THREE.Mesh(new THREE.BoxGeometry(FW + FT * 2 + 0.1, FT, FT + 0.2), recessMat);
  frameBot.position.set(0, -(FH / 2 + FT / 2), FZ); scene.add(frameBot);

  // Left bar
  const frameL = new THREE.Mesh(new THREE.BoxGeometry(FT, FH + FT * 2 + 0.1, FT + 0.2), recessMat);
  frameL.position.set(-(FW / 2 + FT / 2), 0, FZ); scene.add(frameL);

  // Right bar
  const frameR = new THREE.Mesh(new THREE.BoxGeometry(FT, FH + FT * 2 + 0.1, FT + 0.2), recessMat);
  frameR.position.set(FW / 2 + FT / 2, 0, FZ); scene.add(frameR);

  // Rectangular tunnel extending back from frame
  const tunnelDepth = 3.2;
  for (const [, w, h, ox, oy] of [
    ['top',    FW, FT, 0,               FH / 2 + FT / 2],
    ['bottom', FW, FT, 0,             -(FH / 2 + FT / 2)],
    ['left',   FT, FH, -(FW / 2 + FT / 2), 0],
    ['right',  FT, FH,  FW / 2 + FT / 2,  0],
  ] as [string, number, number, number, number][]) {
    const seg = new THREE.Mesh(new THREE.BoxGeometry(w, h, tunnelDepth), recessMat);
    seg.position.set(ox, oy, -FZ - tunnelDepth / 2); scene.add(seg);
  }
}

// ── Fingerprint texture update ────────────────────────────────────────────────

let _lastFPState = '';

function updateFingerprintTexture(vs: VaultScene, st: AnimState): void {
  const { fpCanvas, fpTexture } = vs;
  const isScanning = st.scanner === 'warmup' || st.scanner === 'peak';
  const key = `${st.scanner}:${st.fingerAlpha.toFixed(2)}${isScanning ? ':' + st.glowPhase.toFixed(2) : ''}`;
  if (key === _lastFPState) return;
  _lastFPState = key;

  const size = fpCanvas.width;
  const c = fpCanvas.getContext('2d')!;
  c.clearRect(0, 0, size, size);

  if (st.fingerAlpha < 0.01) { fpTexture.needsUpdate = true; return; }

  const isSuccess = st.scanner === 'success';
  const fpRGB = isSuccess ? '0,220,80' : '220,28,8';

  const cx = size * 0.5;
  const cy = size * 0.5 + size * 0.012;
  const maxR = size * 0.425;

  // ── Glow pass: blurred, lower alpha ──────────────────────────────────────
  c.save();
  // Clip to oval sensor shape so glow doesn't bleed outside
  c.beginPath();
  c.ellipse(cx, cy, maxR * 0.88, maxR, 0, 0, Math.PI * 2);
  c.clip();
  c.filter = 'blur(5px)';
  c.strokeStyle = `rgba(${fpRGB},1)`;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  drawFingerprintRidges(c, size, st.fingerAlpha * 0.4, 7);
  c.restore();

  // ── Crisp core pass ───────────────────────────────────────────────────────
  c.save();
  c.beginPath();
  c.ellipse(cx, cy, maxR * 0.88, maxR, 0, 0, Math.PI * 2);
  c.clip();
  c.filter = 'none';
  c.strokeStyle = `rgba(${fpRGB},1)`;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  drawFingerprintRidges(c, size, st.fingerAlpha, 2.6);
  c.restore();

  // ── Scan-line sweep (drawn outside clip, full width) ─────────────────────
  if (isScanning) {
    const scanY = (Math.sin(st.glowPhase * 1.4) + 1) * 0.5;
    const lineY  = scanY * size;
    const spread = size * 0.1;
    const sg = c.createLinearGradient(0, lineY - spread, 0, lineY + spread);
    sg.addColorStop(0,    'rgba(255,255,255,0)');
    sg.addColorStop(0.45, `rgba(${fpRGB},0.18)`);
    sg.addColorStop(0.5,  `rgba(255,255,255,0.55)`);
    sg.addColorStop(0.55, `rgba(${fpRGB},0.18)`);
    sg.addColorStop(1,    'rgba(255,255,255,0)');
    c.globalAlpha = 1;
    c.fillStyle = sg;
    c.fillRect(0, lineY - spread, size, spread * 2);
  }

  fpTexture.needsUpdate = true;
}

// ── Per-frame render ──────────────────────────────────────────────────────────

const OPEN_DURATION = 1800;  // ms for the split animation

function renderVaultFrame(vs: VaultScene, st: AnimState, boltProgress: number[], now: number): void {
  const { boltGroups, scannerRing, scanArc, ledMeshes, ledLight, interiorLight } = vs;

  const isSuccess = st.scanner === 'success';
  const isActive  = st.scanner === 'warmup' || st.scanner === 'peak';
  const glow      = (Math.sin(st.glowPhase) + 1) * 0.5;
  const pulse     = isSuccess ? 0.2 : (0.5 + Math.sin(st.glowPhase * 1.2) * 0.3);

  updateFingerprintTexture(vs, st);

  // ── LEDs ──
  const ledColor = isSuccess
    ? new THREE.Color(0.04, 0.9, 0.3)
    : new THREE.Color(0.88, 0.16, 0.04);
  const ledIntensity = 0.7 + pulse * 0.4;
  for (const led of ledMeshes) {
    const m = led.material as THREE.MeshStandardMaterial;
    m.emissive.copy(ledColor);
    m.emissiveIntensity = ledIntensity;
  }
  ledLight.color.copy(isSuccess
    ? new THREE.Color(0, 0.9, 0.3)
    : new THREE.Color(0.9, 0.14, 0.04));
  ledLight.intensity = isSuccess ? 1 : (0.5 + pulse * 1);

  // ── Scanner ring ──
  const ringMat = scannerRing.material as THREE.MeshStandardMaterial;
  ringMat.emissive.copy(
    isSuccess ? new THREE.Color(0, 0.82, 0.3)
    : new THREE.Color(0.78, 0.1, 0.04),
  );
  ringMat.emissiveIntensity = isSuccess ? 0.9 : (0.4 + pulse * 0.5);
  scannerRing.rotation.z += 0.0022;

  // ── Scan arc ──
  const arcMat = scanArc.material as THREE.MeshStandardMaterial;
  arcMat.opacity = isActive ? 0.9 : 0;
  if (isActive) {
    arcMat.emissiveIntensity = 3.5 + glow * 2;
    scanArc.rotation.z = st.glowPhase * 2.3;
  }

  // ── Bolt retraction (W and E only) ──
  for (let i = 0; i < 4; i++) {
    const bg = boltGroups[i];
    if (!bg) continue;
    const cfg = BOLT_CFG[i]!;
    const prog = boltProgress[i] ?? 0;
    const slide = prog * 1;
    bg.position.set(cfg.x + cfg.dx * slide, cfg.y + cfg.dy * slide, 0.02);
    bg.visible = prog < 0.92;
  }

  // ── Door split opening animation ──
  if (st.openStartTime === null) {
    vs.camera.position.y = -0.1 + Math.sin(st.glowPhase * 0.5) * 0.005;
  } else {
    const raw  = Math.min(1, (now - st.openStartTime) / OPEN_DURATION);
    // Ease: fast start, smooth end
    const ease = raw < 0.5 ? 2 * raw * raw : 1 - Math.pow(-2 * raw + 2, 2) / 2;

    // Halves slide apart
    vs.doorLeft.position.x  = -ease * 6;
    vs.doorRight.position.x =  ease * 6;

    // Scanner group disappears quickly as halves separate
    vs.scannerGroup.visible = raw < 0.18;

    // Camera pushes forward through the gap
    vs.camera.position.z = vs.cameraStartZ - ease * 5;

    // Interior light floods in
    interiorLight.intensity = ease * 28;

    // White flash bloom
    if (vs.flashEl && raw > 0.28) {
      const fp = (raw - 0.28) / 0.38;
      vs.flashEl.style.opacity = String(Math.min(1, fp * 2.8));
    }

    // Fade overlay when done
    if (vs.overlayEl && raw >= 1 && !vs.overlayEl.dataset.fading) {
      vs.overlayEl.dataset.fading = '1';
      vs.overlayEl.style.transition = 'opacity 1.2s ease';
      vs.overlayEl.style.opacity = '0';
      document.querySelector('.vi-vignette')?.remove();
      document.querySelector('.vi-grain')?.remove();
    }
  }

  vs.camera.lookAt(0, 0, 0);
  vs.composer.render();
}

// ── Overlay ───────────────────────────────────────────────────────────────────

interface OverlayRefs {
  overlay:  HTMLDivElement;
  scanBtn:  HTMLDivElement;
  quitBtn:  HTMLButtonElement;
  statusEl: HTMLDivElement;
  flashEl:  HTMLDivElement;
  state:    AnimState;
  vault:    VaultScene;
}

function buildOverlay(pbr: VaultTextures | null): OverlayRefs {
  injectStyles();
  const state = initState();

  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:9999;background:#040608;
    overflow:hidden;animation:vi-fadein 1.0s cubic-bezier(0.16,1,0.3,1) both;
  `;

  const threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;display:block;';
  overlay.append(threeCanvas);

  const scanBtn = document.createElement('div');
  scanBtn.style.cssText = `
    position:absolute;top:50%;left:50%;width:200px;height:200px;
    transform:translate(-50%,-50%);border-radius:50%;cursor:pointer;z-index:2;
  `;
  overlay.append(scanBtn);

  const statusEl = document.createElement('div');
  statusEl.style.cssText = `
    position:absolute;top:calc(50% - 22vmin);left:50%;
    transform:translateX(-50%);padding:5px 20px;
    background:rgba(0,5,14,0.90);border:1px solid rgba(0,210,240,0.50);
    border-radius:3px;
    font-family:"SF Pro Display",-apple-system,BlinkMacSystemFont,monospace;
    font-size:clamp(8px,1.4vmin,11px);font-weight:600;letter-spacing:.16em;
    color:rgba(0,210,240,1);pointer-events:none;z-index:3;
    opacity:0;transition:opacity 0.28s ease;
  `;
  overlay.append(statusEl);

  const flashEl = document.createElement('div');
  flashEl.style.cssText = `
    position:fixed;inset:0;z-index:10000;
    background:radial-gradient(circle,
      rgba(255,255,255,1.0) 0%,rgba(200,235,255,0.98) 18%,
      rgba(90,170,255,0.65) 48%,rgba(0,0,0,0) 80%);
    opacity:0;pointer-events:none;
  `;
  overlay.append(flashEl);

  const quitBtn = document.createElement('button');
  quitBtn.textContent = 'Quit';
  quitBtn.style.cssText = `
    position:absolute;bottom:28px;left:50%;transform:translateX(-50%);
    background:none;border:none;font-size:12px;font-weight:500;letter-spacing:.08em;
    color:rgba(120,140,160,0.28);cursor:pointer;padding:6px 14px;
    transition:color .2s;z-index:4;
  `;
  quitBtn.addEventListener('mouseenter', () => { quitBtn.style.color = 'rgba(180,200,220,0.58)'; });
  quitBtn.addEventListener('mouseleave', () => { quitBtn.style.color = 'rgba(120,140,160,0.28)'; });
  overlay.append(quitBtn);

  const vignette = document.createElement('div');
  vignette.className = 'vi-vignette';
  document.body.append(vignette);

  // Film grain canvas — animates every 2 frames so it looks like real grain
  const grainCanvas = document.createElement('canvas');
  grainCanvas.className = 'vi-grain';
  grainCanvas.width  = 384;
  grainCanvas.height = 216;
  document.body.append(grainCanvas);
  (function tickGrain(frame: number) {
    if (!document.body.contains(grainCanvas)) return;
    if (frame % 2 === 0) {
      const gctx = grainCanvas.getContext('2d')!;
      const id = gctx.createImageData(grainCanvas.width, grainCanvas.height);
      for (let i = 0; i < id.data.length; i += 4) {
        const v = (Math.random() * 255) | 0;
        id.data[i] = id.data[i + 1] = id.data[i + 2] = v;
        id.data[i + 3] = 255;
      }
      gctx.putImageData(id, 0, 0);
    }
    requestAnimationFrame(() => tickGrain(frame + 1));
  })(0);

  const vault = buildVaultScene(threeCanvas, pbr);
  vault.flashEl   = flashEl;
  vault.overlayEl = overlay;

  return { overlay, scanBtn, quitBtn, statusEl, flashEl, state, vault };
}

// ── Render loop ───────────────────────────────────────────────────────────────

function startLoop(refs: OverlayRefs): () => void {
  let rafId = 0;

  const loop = (now: number) => {
    refs.state.glowPhase = (refs.state.glowPhase + 0.024) % (Math.PI * 2);

    const bp: number[] = [];
    for (let i = 0; i < 4; i++) {
      if (refs.state.boltRetractStart === null) {
        bp.push(0);
      } else {
        const delay   = i * 80;
        const elapsed = now - refs.state.boltRetractStart - delay;
        bp.push(Math.max(0, Math.min(1, elapsed / 380)));
      }
    }

    const { state, statusEl } = refs;
    if (state.statusAlpha > 0.01 && state.scanner !== 'idle') {
      statusEl.style.opacity  = String(state.statusAlpha);
      statusEl.textContent    = state.statusText;
      const isSuccess = state.scanner === 'success';
      const isError   = state.scanner === 'error';
      const rgb = isSuccess ? '0,220,155' : (isError ? '238,65,35' : '0,210,240');
      statusEl.style.color       = `rgba(${rgb},1)`;
      statusEl.style.borderColor = `rgba(${rgb},0.50)`;
    } else {
      statusEl.style.opacity = '0';
    }

    try {
      renderVaultFrame(refs.vault, state, bp, now);
    } catch (error) {
      console.error('[vault-intro] render error:', error);
    }
    rafId = requestAnimationFrame(loop);
  };

  rafId = requestAnimationFrame(loop);
  return () => cancelAnimationFrame(rafId);
}

function handleResize(refs: OverlayRefs): void {
  const { vault } = refs;
  const w = window.innerWidth;
  const h = window.innerHeight;
  vault.renderer.setSize(w, h);
  vault.composer.setSize(w, h);
  vault.camera.aspect = w / h;
  vault.camera.updateProjectionMatrix();
}

// ── Scanner state helpers ─────────────────────────────────────────────────────

function setIdle(st: AnimState): void {
  st.scanner = 'idle'; st.statusText = ''; st.statusAlpha = 0; st.fingerAlpha = 0.4;
}
function setWarmup(st: AnimState): void {
  st.scanner = 'warmup'; st.statusText = 'SCANNING…'; st.statusAlpha = 0.84; st.fingerAlpha = 0.56;
}
function setPeak(st: AnimState): void {
  st.scanner = 'peak'; st.statusText = 'PLACE FINGER ON SENSOR'; st.statusAlpha = 0.94; st.fingerAlpha = 0.7;
}
function setError(st: AnimState, msg: string): void {
  st.scanner = 'error'; st.statusText = msg; st.statusAlpha = 0.9; st.fingerAlpha = 0.3;
}
function setSuccess(st: AnimState): void {
  st.scanner = 'success'; st.statusText = 'ACCESS GRANTED'; st.statusAlpha = 0.94; st.fingerAlpha = 0.82;
}

// ── Opening sequence ──────────────────────────────────────────────────────────

async function playOpenSequence(
  refs: OverlayRefs,
  audioCtx: AudioContext | null,
  appReady?: Promise<void>,
): Promise<void> {
  setSuccess(refs.state);
  await sleep(380);

  if (audioCtx) { playAuthConfirmed(audioCtx); playMotorWhine(audioCtx); playBoltRetracts(audioCtx); }
  setTimeout(playVoiceAuthenticated, 50);

  refs.state.boltRetractStart = performance.now();
  await sleep(780);

  if (appReady) await Promise.race([appReady, sleep(8000)]);
  await sleep(50);

  if (audioCtx) playDoorOpen(audioCtx);

  refs.state.openStartTime = performance.now();
  await sleep(OPEN_DURATION + 1400);
}

// ── Biometric flow ────────────────────────────────────────────────────────────

async function runBiometricFlow(
  refs: OverlayRefs,
  onQuit: () => void,
  stopLoop: () => void,
  appReady?: Promise<void>,
): Promise<boolean> {
  let settled = false;
  let inFlight = false;
  let resolveFlow!: (v: boolean) => void;
  const result = new Promise<boolean>(res => { resolveFlow = res; });

  refs.quitBtn.addEventListener('click', () => {
    if (settled) return;
    settled = true;
    stopLoop();
    resolveFlow(false);
    onQuit();
  });

  const tryAuth = async (manual: boolean) => {
    if (settled || inFlight) return;
    inFlight = true;

    const ready = await waitForBridge();
    if (!ready || settled) { inFlight = false; return; }

    if (!manual) {
      setWarmup(refs.state);
      await sleep(680);
      if (settled) return;
    }

    setPeak(refs.state);
    await sleep(560);
    if (settled) return;

    try {
      const audioCtx = newACtx();
      await invokeTauri<void>(CMD, { reason: REASON, options: { allowDeviceCredential: true } });
      if (settled) return;
      settled = true;
      await playOpenSequence(refs, audioCtx, appReady);
      resolveFlow(true);
    } catch (error) {
      if (settled) return;
      inFlight = false;
      const msg  = error instanceof Error ? error.message : '';
      const text = msg.toLowerCase().includes('cancel') ? 'CANCELLED — TAP TO RETRY' : 'TAP TO RETRY';
      setError(refs.state, text);
      setTimeout(() => { if (!settled) setIdle(refs.state); }, 1500);
    }
  };

  setTimeout(() => void tryAuth(false), 900);
  refs.scanBtn.addEventListener('click', () => void tryAuth(true));

  return result;
}

// ── Export ────────────────────────────────────────────────────────────────────

export async function runVaultIntro(appReady?: Promise<void>): Promise<boolean> {
  const pbr      = await loadVaultTextures();
  const refs     = buildOverlay(pbr);
  const stopLoop = startLoop(refs);
  document.body.append(refs.overlay);

  // Pre-load voices list so speech fires instantly on auth
  if ('speechSynthesis' in window) window.speechSynthesis.getVoices();

  const onResize = () => handleResize(refs);
  window.addEventListener('resize', onResize);

  let quitCalled = false;
  const unlocked = await runBiometricFlow(refs, () => { quitCalled = true; }, stopLoop, appReady);

  stopLoop();
  window.removeEventListener('resize', onResize);
  refs.overlay.remove();
  if (quitCalled) window.close();
  return unlocked;
}
