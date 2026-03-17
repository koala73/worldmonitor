// Biometric vault intro — canvas-only rendering.
// No SVG overlays. Everything is Canvas 2D for photorealistic quality.
// Scanner ring is a 3D machined torus with LED glow, not a flat stroke.

import { hasTauriInvokeBridge, invokeTauri } from '../services/tauri-bridge';

const CMD             = 'plugin:biometry|authenticate';
const REASON          = 'Unlock World Monitor';
const BRIDGE_TIMEOUT  = 2500;
const POLL_MS         = 50;

// Door canvas logical coordinate space
const V  = 500;   // canvas side length (logical)
const DC = V / 2; // 250 — door center
const SC = 2;     // retina pixel multiplier

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

function lcg(seed: number): () => number {
  let s = (seed | 0) >>> 0;
  return () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 4294967296; };
}

// ── Audio ─────────────────────────────────────────────────────────────────────

function newACtx(): AudioContext | null {
  try { return new AudioContext(); } catch { return null; }
}

function playMotorWhine(ctx: AudioContext): void {
  const t0 = ctx.currentTime;
  const dur = 1.8;
  const motor = ctx.createOscillator();
  motor.type = 'sawtooth';
  motor.frequency.setValueAtTime(62, t0);
  motor.frequency.exponentialRampToValueAtTime(210, t0 + 0.55);
  motor.frequency.exponentialRampToValueAtTime(175, t0 + 0.95);
  motor.frequency.exponentialRampToValueAtTime(75, t0 + dur);
  const mF = ctx.createBiquadFilter(); mF.type = 'lowpass'; mF.frequency.value = 380;
  const mG = ctx.createGain();
  mG.gain.setValueAtTime(0, t0);
  mG.gain.linearRampToValueAtTime(0.18, t0 + 0.14);
  mG.gain.setValueAtTime(0.18, t0 + 0.95);
  mG.gain.linearRampToValueAtTime(0, t0 + dur);
  motor.connect(mF).connect(mG).connect(ctx.destination);
  motor.start(t0); motor.stop(t0 + dur + 0.05);

  const gear = ctx.createOscillator();
  gear.type = 'sawtooth';
  gear.frequency.setValueAtTime(720, t0 + 0.08);
  gear.frequency.exponentialRampToValueAtTime(1150, t0 + 0.58);
  gear.frequency.exponentialRampToValueAtTime(860, t0 + 0.95);
  gear.frequency.exponentialRampToValueAtTime(380, t0 + dur);
  const gF = ctx.createBiquadFilter(); gF.type = 'bandpass'; gF.frequency.value = 950; gF.Q.value = 2.2;
  const gG = ctx.createGain();
  gG.gain.setValueAtTime(0, t0 + 0.08);
  gG.gain.linearRampToValueAtTime(0.065, t0 + 0.32);
  gG.gain.setValueAtTime(0.065, t0 + 0.95);
  gG.gain.linearRampToValueAtTime(0, t0 + dur);
  gear.connect(gF).connect(gG).connect(ctx.destination);
  gear.start(t0 + 0.08); gear.stop(t0 + dur + 0.05);
}

function playBoltRetracts(ctx: AudioContext): void {
  const t0 = ctx.currentTime;
  for (let i = 0; i < 5; i++) {
    const t = t0 + i * 0.09;
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(95, t);
    osc.frequency.exponentialRampToValueAtTime(16, t + 0.2);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.6, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    osc.connect(og).connect(ctx.destination);
    osc.start(t); osc.stop(t + 0.2);
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.04), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let j = 0; j < d.length; j++) d[j] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const hpf = ctx.createBiquadFilter(); hpf.type = 'highpass'; hpf.frequency.value = 3500;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.3, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
    src.connect(hpf).connect(ng).connect(ctx.destination);
    src.start(t);
  }
}

function playDoorOpen(ctx: AudioContext): void {
  const t0 = ctx.currentTime + 0.08;
  const dur = 2.4;
  const hBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
  const hd = hBuf.getChannelData(0);
  for (let i = 0; i < hd.length; i++) hd[i] = Math.random() * 2 - 1;
  const hSrc = ctx.createBufferSource(); hSrc.buffer = hBuf;
  const hF = ctx.createBiquadFilter(); hF.type = 'bandpass';
  hF.frequency.setValueAtTime(1600, t0);
  hF.frequency.exponentialRampToValueAtTime(280, t0 + dur * 0.7);
  hF.Q.value = 1.0;
  const hG = ctx.createGain();
  hG.gain.setValueAtTime(0, t0);
  hG.gain.linearRampToValueAtTime(0.42, t0 + 0.1);
  hG.gain.setValueAtTime(0.42, t0 + dur * 0.42);
  hG.gain.linearRampToValueAtTime(0, t0 + dur);
  hSrc.connect(hF).connect(hG).connect(ctx.destination);
  hSrc.start(t0);
  const rOsc = ctx.createOscillator(); rOsc.type = 'sawtooth';
  rOsc.frequency.setValueAtTime(42, t0 + 0.3);
  rOsc.frequency.linearRampToValueAtTime(52, t0 + 1.5);
  const rF = ctx.createBiquadFilter(); rF.type = 'lowpass'; rF.frequency.value = 160;
  const rG = ctx.createGain();
  rG.gain.setValueAtTime(0, t0 + 0.3);
  rG.gain.linearRampToValueAtTime(0.2, t0 + 0.5);
  rG.gain.setValueAtTime(0.2, t0 + 1.4);
  rG.gain.linearRampToValueAtTime(0, t0 + 2.1);
  rOsc.connect(rF).connect(rG).connect(ctx.destination);
  rOsc.start(t0 + 0.3); rOsc.stop(t0 + 2.2);
}

// ── CSS ───────────────────────────────────────────────────────────────────────

function injectStyles(): void {
  if (document.getElementById('vault-intro-css')) return;
  const s = document.createElement('style');
  s.id = 'vault-intro-css';
  s.textContent = `
    @keyframes vi-fadein {
      from { opacity:0; transform:scale(1.03); }
      to   { opacity:1; transform:scale(1); }
    }
    @keyframes vi-seal-jitter {
      0%  { transform:translateX(0) }
      15% { transform:translateX(-4px) }
      32% { transform:translateX(6px) }
      50% { transform:translateX(-5px) }
      68% { transform:translateX(4px) }
      84% { transform:translateX(-2px) }
      100%{ transform:translateX(0) }
    }
  `;
  document.head.appendChild(s);
}

// ── Computed door size ────────────────────────────────────────────────────────
// The door CSS size at runtime (approximation). Must match buildOverlay() CSS.

function doorCSSPx(): number {
  return Math.min(720, window.innerWidth * 0.90, window.innerHeight * 0.90);
}

// ── Room canvas (full-screen, static) ─────────────────────────────────────────
// Photorealistic concrete anteroom with overhead fluorescent light and a deep
// cylindrical recess where the vault door sits.

function drawRoom(canvas: HTMLCanvasElement): void {
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  const VW  = window.innerWidth;
  const VH  = window.innerHeight;
  canvas.width  = VW * DPR;
  canvas.height = VH * DPR;
  canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;';
  const c = canvas.getContext('2d')!;
  c.scale(DPR, DPR);
  const cx = VW / 2, cy = VH / 2;

  // Base fill
  c.fillStyle = '#050709';
  c.fillRect(0, 0, VW, VH);

  // Concrete micro-grain
  const rW = lcg(3);
  for (let i = 0; i < 900; i++) {
    const y  = rW() * VH;
    const bv = 0.28 + rW() * 1.5;
    const a  = 0.0025 + rW() * 0.013;
    c.strokeStyle = `rgba(${42 * bv | 0},${46 * bv | 0},${52 * bv | 0},${a})`;
    c.lineWidth   = 0.10 + rW() * 0.55;
    c.beginPath(); c.moveTo(0, y); c.lineTo(VW, y); c.stroke();
  }

  // Aggregate spots
  const rA = lcg(7);
  for (let i = 0; i < 160; i++) {
    const ax = rA() * VW, ay = rA() * VH, ar = 1.2 + rA() * 5.5;
    const aa = 0.006 + rA() * 0.018;
    c.fillStyle = `rgba(${38 + (rA() * 28) | 0},${40 + (rA() * 28) | 0},${48 + (rA() * 28) | 0},${aa})`;
    c.beginPath(); c.arc(ax, ay, ar, 0, Math.PI * 2); c.fill();
  }

  // Overhead fluorescent cone
  {
    const g = c.createRadialGradient(cx, -VH * 0.05, 0, cx, VH * 0.38, Math.min(VW, VH) * 0.88);
    g.addColorStop(0, 'rgba(195,210,235,0.21)');
    g.addColorStop(0.20, 'rgba(110,132,165,0.07)');
    g.addColorStop(0.62, 'rgba(0,0,0,0)');
    c.fillStyle = g; c.fillRect(0, 0, VW, VH);
  }
  // Tube fixture
  const tw = VW * 0.09, tx = cx - tw / 2;
  {
    const g = c.createLinearGradient(0, 0, 0, 30);
    g.addColorStop(0, 'rgba(232,244,255,0.90)');
    g.addColorStop(1, 'rgba(232,244,255,0)');
    c.fillStyle = g; c.fillRect(tx - 12, 0, tw + 24, 30);
  }
  c.fillStyle = 'rgba(244,252,255,0.97)';
  c.fillRect(tx, 1, tw, 2.5);
  c.fillStyle = 'rgba(0,0,0,0.52)';
  c.fillRect(tx - 4, 0, tw + 8, 1);

  // Room corner lines converging toward vanishing point
  const vpY = cy * 0.5;
  for (const [ex, ey] of [[0, 0], [VW, 0], [0, VH], [VW, VH]] as [number, number][]) {
    const a = 0.018 + Math.abs(ex - cx) / VW * 0.018;
    c.strokeStyle = `rgba(14,18,24,${a})`;
    c.lineWidth = 1.2;
    c.beginPath(); c.moveTo(cx, vpY); c.lineTo(ex, ey); c.stroke();
  }

  // Floor / wall break
  const floorY = cy + Math.min(VW, VH) * 0.40;
  {
    const g = c.createLinearGradient(0, floorY, 0, VH);
    g.addColorStop(0, 'rgba(8,10,14,0)');
    g.addColorStop(0.04, 'rgba(8,10,14,0.94)');
    g.addColorStop(1, '#050709');
    c.fillStyle = g; c.fillRect(0, floorY, VW, VH - floorY);
  }
  c.save(); c.filter = 'blur(4px)';
  c.fillStyle = 'rgba(0,0,0,0.82)'; c.fillRect(0, floorY - 4, VW, 12);
  c.restore();

  // Floor tile joints
  for (let t = 1; t <= 6; t++) {
    const p  = t / 6;
    const fy = floorY + (VH - floorY) * (1 - Math.pow(1 - p, 2.8));
    c.strokeStyle = `rgba(20,24,30,${0.042 + p * 0.065})`;
    c.lineWidth = 0.7;
    c.beginPath(); c.moveTo(0, fy); c.lineTo(VW, fy); c.stroke();
  }
  for (let v = 0; v <= 9; v++) {
    const px2 = (v / 9) * VW;
    c.strokeStyle = 'rgba(18,22,28,0.038)';
    c.lineWidth = 0.45;
    c.beginPath(); c.moveTo(cx, floorY); c.lineTo(px2, VH); c.stroke();
  }

  // Edge vignettes
  const vigs: [number, number, number, number][] = [
    [0, 0, VW * 0.26, 0], [VW, 0, VW * 0.74, 0],
    [0, 0, 0, VH * 0.20], [0, VH, 0, VH * 0.78],
  ];
  for (const [x0, y0, x1, y1] of vigs) {
    const g = c.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, 'rgba(0,0,0,0.76)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.fillRect(Math.min(x0, x1), Math.min(y0, y1),
      Math.abs(x1 - x0) || VW, Math.abs(y1 - y0) || VH);
  }

  // ── Vault cylindrical recess ─────────────────────────────────────────────────
  // The door sits recessed IN the concrete wall. We simulate the cylindrical hole
  // with graduated AO rings — each band gets darker toward center = depth illusion.

  const doorR   = doorCSSPx() / 2;                   // door radius in CSS px
  const frameRO = doorR + 30;                         // outer frame edge
  const frameRI = doorR + 4;                          // inner frame edge (door seat)

  // Massive ambient occlusion — wide blurred halos around the opening
  for (let pass = 0; pass < 9; pass++) {
    c.save();
    c.filter = `blur(${38 + pass * 38}px)`;
    c.strokeStyle = `rgba(0,0,0,${0.28 + pass * 0.08})`;
    c.lineWidth   = frameRO * (0.09 + pass * 0.015);
    c.beginPath(); c.arc(cx, cy + VH * 0.006, frameRO + pass * 6, 0, Math.PI * 2); c.stroke();
    c.restore();
  }

  // Cylindrical recess depth bands (wall thickness visible at the circular opening)
  // Each band is lit from above — top brighter, bottom darker.
  const bands = [
    { r: frameRO - 1,  w: 16, topA: 0.20, botA: 0.00 },
    { r: frameRO - 16, w: 14, topA: 0.10, botA: 0.00 },
    { r: frameRO - 28, w: 12, topA: 0.05, botA: 0.00 },
    { r: frameRI + 8,  w: 10, topA: 0.02, botA: 0.00 },
  ];
  for (const b of bands) {
    const g = c.createLinearGradient(cx, cy - b.r, cx, cy + b.r);
    g.addColorStop(0, `rgba(255,255,255,${b.topA})`);
    g.addColorStop(0.35, `rgba(255,255,255,${b.topA * 0.3})`);
    g.addColorStop(0.65, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${b.botA + 0.18})`);
    c.strokeStyle = g;
    c.lineWidth = b.w;
    c.beginPath(); c.arc(cx, cy, b.r, 0, Math.PI * 2); c.stroke();
  }

  // Frame collar body — machined dark steel ring
  c.save();
  c.beginPath();
  c.arc(cx, cy, frameRO, 0, Math.PI * 2);
  c.arc(cx, cy, frameRI, 0, Math.PI * 2, true);
  c.clip('evenodd');
  {
    const g = c.createRadialGradient(
      cx - frameRO * 0.30, cy - frameRO * 0.24, 0,
      cx + 9, cy + 11, frameRO * 1.08,
    );
    g.addColorStop(0,    '#20262f');
    g.addColorStop(0.40, '#121620');
    g.addColorStop(1,    '#050608');
    c.fillStyle = g;
    c.fillRect(cx - frameRO - 4, cy - frameRO - 4, (frameRO + 4) * 2, (frameRO + 4) * 2);
  }
  // Brushed grain on frame
  const rFr = lcg(11);
  for (let i = 0; i < 320; i++) {
    const y2 = cy - frameRO + rFr() * frameRO * 2;
    const bv = 0.48 + rFr() * 0.88;
    const a2 = 0.003 + rFr() * 0.013;
    c.strokeStyle = `rgba(${26 * bv | 0},${29 * bv | 0},${36 * bv | 0},${a2})`;
    c.lineWidth   = 0.13 + rFr() * 0.42;
    c.beginPath(); c.moveTo(cx - frameRO - 4, y2); c.lineTo(cx + frameRO + 4, y2); c.stroke();
  }
  c.restore();

  // Frame bevel — upper-left specular catch (overhead light)
  {
    const g = c.createLinearGradient(cx - frameRO * 0.72, cy - frameRO * 0.72, cx, cy);
    g.addColorStop(0, 'rgba(255,255,255,0.11)');
    g.addColorStop(0.38, 'rgba(255,255,255,0.04)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.save();
    c.beginPath();
    c.arc(cx, cy, frameRO, 0, Math.PI * 2);
    c.arc(cx, cy, frameRI, 0, Math.PI * 2, true);
    c.clip('evenodd');
    c.fillStyle = g;
    c.fillRect(cx - frameRO - 4, cy - frameRO - 4, (frameRO + 4) * 2, (frameRO + 4) * 2);
    c.restore();
  }
  // Outer edge: shadow bottom-right, highlight top-left
  c.strokeStyle = 'rgba(0,0,0,0.72)'; c.lineWidth = 2.5;
  c.beginPath(); c.arc(cx + 2.5, cy + 3, frameRO + 1, 0, Math.PI * 2); c.stroke();
  c.strokeStyle = 'rgba(255,255,255,0.085)'; c.lineWidth = 1.5;
  c.beginPath(); c.arc(cx - 1, cy - 1, frameRO + 1, 0, Math.PI * 2); c.stroke();
  // Inner seat edge — nearly black
  c.strokeStyle = '#010203'; c.lineWidth = 6;
  c.beginPath(); c.arc(cx, cy, frameRI + 1, 0, Math.PI * 2); c.stroke();
  c.strokeStyle = 'rgba(255,255,255,0.055)'; c.lineWidth = 1;
  c.beginPath(); c.arc(cx - 0.5, cy - 0.5, frameRI, 0, Math.PI * 2); c.stroke();

  // Black void behind door
  c.fillStyle = '#000';
  c.beginPath(); c.arc(cx, cy, frameRI - 2, 0, Math.PI * 2); c.fill();
}

// ── Door face canvas (static) ─────────────────────────────────────────────────
// Brushed steel door surface. Animated elements (ring, bolts, fingerprint) are
// on the separate scannerCanvas drawn every frame.

function drawDoorFace(canvas: HTMLCanvasElement): void {
  canvas.width  = V * SC;
  canvas.height = V * SC;
  canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;display:block;';
  const c = canvas.getContext('2d')!;
  c.scale(SC, SC);

  const rrect = (x: number, y: number, w: number, h: number, r: number) => {
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y); c.arcTo(x + w, y, x + w, y + r, r);
    c.lineTo(x + w, y + h - r); c.arcTo(x + w, y + h, x + w - r, y + h, r);
    c.lineTo(x + r, y + h); c.arcTo(x, y + h, x, y + h - r, r);
    c.lineTo(x, y + r); c.arcTo(x, y, x + r, y, r);
    c.closePath();
  };

  const rD  = lcg(22);
  const rSc = lcg(77);

  // Cast shadow beneath door
  c.save();
  c.filter = 'blur(42px)';
  c.fillStyle = 'rgba(0,0,0,0.94)';
  c.beginPath(); c.ellipse(DC, DC + 26, 238, 218, 0, 0, Math.PI * 2); c.fill();
  c.restore();

  // Clip to circular door face
  c.save();
  c.beginPath(); c.arc(DC, DC, 236, 0, Math.PI * 2); c.clip();

  // Brushed steel base gradient
  {
    const g = c.createRadialGradient(DC - 82, DC - 68, 0, DC + 26, DC + 30, 270);
    g.addColorStop(0,    '#5d666f');
    g.addColorStop(0.12, '#454d56');
    g.addColorStop(0.40, '#2c2f38');
    g.addColorStop(0.70, '#1e2128');
    g.addColorStop(1,    '#121418');
    c.fillStyle = g; c.fillRect(0, 0, V, V);
  }

  // Brushed horizontal grain
  for (let i = 0; i < 720; i++) {
    const y  = DC - 236 + rD() * 472;
    const bv = 0.44 + rD() * 1.05;
    const a  = 0.004 + rD() * 0.023;
    c.strokeStyle = `rgba(${Math.min(255, 192 * bv) | 0},${Math.min(255, 198 * bv) | 0},${Math.min(255, 207 * bv) | 0},${a})`;
    c.lineWidth = 0.17 + rD() * 0.54;
    c.beginPath(); c.moveTo(DC - 236, y); c.lineTo(DC + 236, y); c.stroke();
  }

  // Highlight streaks (anisotropic)
  for (let j = 0; j < 9; j++) {
    const hy = DC - 180 + rSc() * 360;
    c.strokeStyle = `rgba(218,228,238,${0.017 + rSc() * 0.036})`;
    c.lineWidth = 0.20 + rSc() * 0.40;
    c.beginPath();
    c.moveTo(DC - 190 + rSc() * 40, hy);
    c.lineTo(DC + 150 + rSc() * 40, hy);
    c.stroke();
  }

  // Surface specular
  c.save(); c.globalCompositeOperation = 'screen';
  {
    const g = c.createRadialGradient(DC - 68, DC - 75, 0, DC - 36, DC - 44, 118);
    g.addColorStop(0, 'rgba(255,255,255,0.076)');
    g.addColorStop(0.42, 'rgba(255,255,255,0.025)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, V, V);
  }
  {
    const g = c.createRadialGradient(DC - 88, DC - 92, 0, DC - 88, DC - 92, 40);
    g.addColorStop(0, 'rgba(255,255,255,0.12)');
    g.addColorStop(0.28, 'rgba(255,255,255,0.044)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, V, V);
  }
  c.restore();

  // Outer bevel ring
  c.strokeStyle = 'rgba(255,255,255,0.155)'; c.lineWidth = 5.5;
  c.beginPath(); c.arc(DC, DC, 234, 0, Math.PI * 2); c.stroke();
  c.strokeStyle = 'rgba(0,0,0,0.80)'; c.lineWidth = 5.5;
  c.beginPath(); c.arc(DC + 3.5, DC + 3.5, 232, 0, Math.PI * 2); c.stroke();

  c.restore(); // end circular clip

  // Machined groove rings (two concentric)
  for (const [r, rw] of [[188, 9], [136, 7]] as const) {
    c.save(); c.filter = 'blur(8px)';
    c.strokeStyle = 'rgba(0,0,0,0.88)'; c.lineWidth = rw * 2.2;
    c.beginPath(); c.arc(DC, DC + 5, r, 0, Math.PI * 2); c.stroke();
    c.restore();
    c.strokeStyle = '#020305'; c.lineWidth = rw;
    c.beginPath(); c.arc(DC, DC, r, 0, Math.PI * 2); c.stroke();
    const gg = c.createLinearGradient(0, 0, V, V);
    gg.addColorStop(0, 'rgba(255,255,255,0.10)');
    gg.addColorStop(0.5, 'rgba(255,255,255,0.030)');
    gg.addColorStop(1, 'rgba(255,255,255,0)');
    c.strokeStyle = gg; c.lineWidth = 1.5;
    c.beginPath(); c.arc(DC - 1, DC - 1, r + rw / 2, 0, Math.PI * 2); c.stroke();
    c.strokeStyle = 'rgba(0,0,0,0.55)'; c.lineWidth = 1.5;
    c.beginPath(); c.arc(DC + 1.5, DC + 1.5, r - rw / 2, 0, Math.PI * 2); c.stroke();
  }

  // Bolt housings — dark recesses for the 8 bolt pins
  for (let i = 0; i < 8; i++) {
    c.save();
    c.translate(DC, DC); c.rotate(i * Math.PI / 4); c.translate(-DC, -DC);
    c.beginPath(); rrect(DC - 10, 6, 20, 44, 5);
    c.fillStyle = '#020303'; c.fill();
    c.strokeStyle = '#090a0d'; c.lineWidth = 1; c.stroke();
    c.save(); c.filter = 'blur(5px)';
    c.fillStyle = 'rgba(0,0,0,1)'; c.fillRect(DC - 9, 6, 18, 18);
    c.restore();
    c.restore();
  }

  // Scanner housing — deeply recessed recess in door center
  c.save(); c.filter = 'blur(15px)';
  c.strokeStyle = 'rgba(0,0,0,1)'; c.lineWidth = 34;
  c.beginPath(); c.arc(DC, DC + 7, 102, 0, Math.PI * 2); c.stroke();
  c.restore();
  c.fillStyle = '#020304';
  c.beginPath(); c.arc(DC, DC, 100, 0, Math.PI * 2); c.fill();
  c.strokeStyle = '#060708'; c.lineWidth = 2;
  c.beginPath(); c.arc(DC, DC, 100, 0, Math.PI * 2); c.stroke();
  c.strokeStyle = 'rgba(255,255,255,0.10)'; c.lineWidth = 1.5;
  c.beginPath(); c.arc(DC - 1, DC - 1, 99, 0, Math.PI * 2); c.stroke();
  c.strokeStyle = 'rgba(0,0,0,0.68)'; c.lineWidth = 1.5;
  c.beginPath(); c.arc(DC + 1, DC + 1, 99, 0, Math.PI * 2); c.stroke();

  // Scanner glass pad
  c.save(); c.beginPath(); c.arc(DC, DC, 90, 0, Math.PI * 2); c.clip();
  {
    const g = c.createRadialGradient(DC - 25, DC - 32, 0, DC + 14, DC + 18, 98);
    g.addColorStop(0, '#0e1018'); g.addColorStop(0.5, '#070a0f'); g.addColorStop(1, '#030508');
    c.fillStyle = g; c.fillRect(DC - 94, DC - 94, 188, 188);
  }
  {
    const g = c.createRadialGradient(DC - 22, DC - 34, 0, DC - 22, DC - 34, 48);
    g.addColorStop(0, 'rgba(255,255,255,0.115)');
    g.addColorStop(0.48, 'rgba(255,255,255,0.042)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(DC - 72, DC - 84, 98, 74);
  }
  {
    const g = c.createRadialGradient(DC - 30, DC - 42, 0, DC - 28, DC - 40, 19);
    g.addColorStop(0, 'rgba(255,255,255,0.24)');
    g.addColorStop(0.36, 'rgba(255,255,255,0.09)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(DC - 56, DC - 68, 60, 46);
  }
  c.restore();

  // Machined rivets (8 positions between bolt housings)
  for (const deg of [22.5, 67.5, 112.5, 157.5, 202.5, 247.5, 292.5, 337.5]) {
    const rad = deg * Math.PI / 180;
    const rx = DC + Math.cos(rad) * 164;
    const ry = DC + Math.sin(rad) * 164;
    c.save(); c.filter = 'blur(5px)';
    c.fillStyle = 'rgba(0,0,0,0.78)';
    c.beginPath(); c.arc(rx, ry, 11, 0, Math.PI * 2); c.fill();
    c.restore();
    const rg = c.createRadialGradient(rx - 2.2, ry - 2.8, 0, rx, ry, 7.2);
    rg.addColorStop(0, '#22262a'); rg.addColorStop(1, '#08090d');
    c.fillStyle = rg;
    c.beginPath(); c.arc(rx, ry, 7.2, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#0a0b10'; c.lineWidth = 1;
    c.beginPath(); c.arc(rx, ry, 7.2, 0, Math.PI * 2); c.stroke();
    c.save(); c.beginPath(); c.arc(rx, ry, 7.2, 0, Math.PI * 2); c.clip();
    const rh = c.createRadialGradient(rx - 2.8, ry - 3.2, 0, rx, ry, 7.8);
    rh.addColorStop(0, 'rgba(255,255,255,0.44)');
    rh.addColorStop(0.28, 'rgba(255,255,255,0.15)');
    rh.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = rh; c.fillRect(rx - 8, ry - 8, 16, 16);
    c.restore();
    c.fillStyle = '#0c0d12';
    c.beginPath(); c.arc(rx, ry, 2.2, 0, Math.PI * 2); c.fill();
  }

  // Micro-etched logo
  c.save();
  c.font = '700 9px "SF Pro Display",-apple-system,BlinkMacSystemFont,sans-serif';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillStyle = 'rgba(128,140,156,0.16)';
  c.fillText('WORLD  MONITOR', DC, DC - 146);
  c.restore();
}

// ── Fingerprint paths ─────────────────────────────────────────────────────────

const FP_PATHS = [
  'M 24 3 C 12 3 3 12 3 24 C 3 36 8 44 16 48',
  'M 24 7 C 14 7 7 14 7 24 C 7 34 12 41 22 44',
  'M 24 11 C 17 11 11 17 11 24 C 11 31 15 37 24 39',
  'M 24 15 C 20 15 17 18 17 24 C 17 28 19 32 24 33',
  'M 24 19 C 22 19 21 21 21 24 C 21 26 22 27 24 27 C 26 27 27 26 27 24 C 27 21 26 19 24 19',
  'M 24 3 C 36 3 45 12 45 24 C 45 36 38 44 30 47',
  'M 24 7 C 34 7 41 14 41 24 C 41 34 36 41 26 44',
  'M 24 11 C 31 11 37 17 37 24 C 37 31 33 37 24 39',
  'M 24 15 C 28 15 31 18 31 24 C 31 28 29 32 24 33',
  'M 28 15 C 31 18 31 24 29 28',
];

// ── Scanner state ─────────────────────────────────────────────────────────────

type ScannerState = 'idle' | 'warmup' | 'peak' | 'error' | 'success';

interface AnimState {
  scanner:          ScannerState;
  glowPhase:        number;
  boltRetractStart: number | null;  // performance.now() when retraction began
  statusText:       string;
  statusRGB:        string;         // e.g. '180,50,50'
  statusAlpha:      number;
  fingerAlpha:      number;
}

function initState(): AnimState {
  return {
    scanner:          'idle',
    glowPhase:        0,
    boltRetractStart: null,
    statusText:       'BIOMETRIC SCAN READY',
    statusRGB:        '172,48,48',
    statusAlpha:      0.55,
    fingerAlpha:      0.44,
  };
}

// ── Scanner canvas (animated, transparent) ───────────────────────────────────
// Redrawn every animation frame. Draws: bolt pins, scanner ring, fingerprint,
// status text, LED. Everything on a transparent canvas layered over the door.

function drawScannerFrame(
  canvas: HTMLCanvasElement,
  st: AnimState,
  boltProgress: number[],
): void {
  const c = canvas.getContext('2d')!;
  c.clearRect(0, 0, canvas.width, canvas.height);

  const W  = canvas.width;   // actual pixels
  const H  = canvas.height;
  const cx = W / 2;
  const cy = H / 2;
  const px = SC;             // 1 logical unit in actual pixels

  const isSuccess = st.scanner === 'success';
  const isError   = st.scanner === 'error';
  const isActive  = st.scanner === 'warmup' || st.scanner === 'peak';
  const glow      = (Math.sin(st.glowPhase) + 1) * 0.5; // 0..1

  // ── Bolt pins ───────────────────────────────────────────────────────────────
  for (let i = 0; i < 8; i++) {
    const prog = boltProgress[i] ?? 0;
    if (prog >= 1) continue;

    const alpha   = 1 - Math.max(0, (prog - 0.55) / 0.45);
    const yPull   = prog * 38 * px; // moves UP into housing
    const xShrink = 1 - prog * 0.46;

    c.save();
    c.translate(cx, cy); c.rotate(i * Math.PI / 4); c.translate(-cx, -cy);
    c.globalAlpha = alpha;

    const bpx = (DC - 9) * px;
    const bpy = 7 * px - yPull;
    const bpw = 18 * px;
    const bph = 42 * px;
    const bpr = 5 * px;

    // Compress horizontally around pin center as it retracts
    c.translate(bpx + bpw / 2, cy); c.scale(xShrink, 1); c.translate(-(bpx + bpw / 2), -cy);

    // Pin body — brushed steel gradient
    const pg = c.createLinearGradient(bpx, bpy, bpx + bpw, bpy + bph);
    pg.addColorStop(0,    '#606870');
    pg.addColorStop(0.16, '#484f58');
    pg.addColorStop(0.52, '#2c2f38');
    pg.addColorStop(1,    '#181920');
    c.beginPath();
    c.moveTo(bpx + bpr, bpy); c.lineTo(bpx + bpw - bpr, bpy);
    c.arcTo(bpx + bpw, bpy, bpx + bpw, bpy + bpr, bpr);
    c.lineTo(bpx + bpw, bpy + bph - bpr);
    c.arcTo(bpx + bpw, bpy + bph, bpx + bpw - bpr, bpy + bph, bpr);
    c.lineTo(bpx + bpr, bpy + bph);
    c.arcTo(bpx, bpy + bph, bpx, bpy + bph - bpr, bpr);
    c.lineTo(bpx, bpy + bpr);
    c.arcTo(bpx, bpy, bpx + bpr, bpy, bpr);
    c.closePath();
    c.fillStyle = pg; c.fill();

    // Top highlight
    c.fillStyle = 'rgba(255,255,255,0.40)';
    c.fillRect(bpx + bpr, bpy, bpw - bpr * 2, 4 * px);
    // Left edge highlight
    c.fillStyle = 'rgba(255,255,255,0.20)';
    c.fillRect(bpx + px, bpy + bpr, 2.5 * px, bph - bpr - 5 * px);

    c.restore();
  }

  // ── Scanner ring — 3D machined torus ────────────────────────────────────────
  // A thick, beveled, directionally-lit ring embedded in the scanner glass.
  // Not a line — a solid metallic torus shape with LED channel inside.

  const R  = 91 * px;   // ring center radius in actual pixels
  const rw = 9 * px;    // ring half-width (thick 3D shape)

  // Drop shadow beneath ring (blurred, offset)
  c.save();
  c.filter = `blur(${7 * px}px)`;
  c.strokeStyle = 'rgba(0,0,0,0.90)';
  c.lineWidth = rw * 2 + 6 * px;
  c.beginPath(); c.arc(cx + 2 * px, cy + 3.5 * px, R, 0, Math.PI * 2); c.stroke();
  c.restore();

  // Ring body — machined steel with directional light (upper-left bright, lower-right dark)
  const bg = c.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
  if (isSuccess) {
    bg.addColorStop(0,    '#0e3e1c');
    bg.addColorStop(0.42, '#072011');
    bg.addColorStop(1,    '#030e07');
  } else if (isError) {
    bg.addColorStop(0,    '#3e1c1c');
    bg.addColorStop(0.42, '#200d0d');
    bg.addColorStop(1,    '#100506');
  } else {
    bg.addColorStop(0,    '#2c1212');
    bg.addColorStop(0.42, '#190909');
    bg.addColorStop(1,    '#0d0404');
  }
  c.strokeStyle = bg;
  c.lineWidth = rw * 2;
  c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.stroke();

  // LED glow intensity based on state
  const glowInt = isSuccess ? 0.92
    : isActive              ? (0.55 + glow * 0.45)
    : isError               ? (0.42 + glow * 0.36)
    :                         (0.18 + glow * 0.28);
  const glowRGB = isSuccess ? '32,215,90' : '218,28,28';

  // LED bloom (wide blurred glow behind ring)
  c.save();
  c.filter = `blur(${10 * px}px)`;
  c.strokeStyle = `rgba(${glowRGB},${glowInt * 0.50})`;
  c.lineWidth = rw * 2.2;
  c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.stroke();
  c.restore();

  // Tight inner LED glow (tighter blur, higher alpha)
  c.save();
  c.filter = `blur(${3 * px}px)`;
  c.strokeStyle = `rgba(${glowRGB},${glowInt * 0.72})`;
  c.lineWidth = rw * 0.9;
  c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.stroke();
  c.restore();

  // LED hot line — the actual thin bright ring visible on the torus face
  c.strokeStyle = `rgba(${glowRGB},${0.52 + glowInt * 0.48})`;
  c.lineWidth   = 2.4 * px;
  c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.stroke();

  // ── Torus directional specular (upper-left surface catch) ──────────────────
  // Clip to the ring band and fill with a directional gradient to simulate
  // the curved convex surface of the torus reflecting overhead light.
  c.save();
  c.beginPath();
  c.arc(cx, cy, R + rw + px, 0, Math.PI * 2);
  c.arc(cx, cy, R - rw - px, 0, Math.PI * 2, true);
  c.clip('evenodd');

  const hlg = c.createLinearGradient(cx - R * 0.92, cy - R * 0.92, cx + R * 0.5, cy + R * 0.5);
  hlg.addColorStop(0,    'rgba(255,255,255,0.28)');
  hlg.addColorStop(0.22, 'rgba(255,255,255,0.10)');
  hlg.addColorStop(0.50, 'rgba(255,255,255,0.03)');
  hlg.addColorStop(1,    'rgba(255,255,255,0)');
  c.fillStyle = hlg;
  c.fillRect(cx - R - rw - px, cy - R - rw - px, (R + rw + px) * 2, (R + rw + px) * 2);
  c.restore();

  // ── Chamfer edges (inner + outer edge of torus cross-section) ──────────────
  // Dark shadow on bottom-right edges, faint highlight on top-left edges.
  const chamfers: [number, number, number, string][] = [
    [R + rw,  1.8 * px,  2.2 * px, 'rgba(0,0,0,0.85)'],
    [R + rw, -0.8 * px, -0.9 * px, 'rgba(255,255,255,0.07)'],
    [R - rw,  1.8 * px,  2.2 * px, 'rgba(0,0,0,0.80)'],
    [R - rw, -0.8 * px, -0.9 * px, 'rgba(255,255,255,0.065)'],
  ];
  for (const [ro, xs, ys, col] of chamfers) {
    c.strokeStyle = col;
    c.lineWidth   = 1.2 * px;
    c.beginPath(); c.arc(cx + xs, cy + ys, ro, 0, Math.PI * 2); c.stroke();
  }

  // ── Fingerprint ─────────────────────────────────────────────────────────────
  if (st.fingerAlpha > 0.01) {
    const fpScale = 1.8;                         // scale up from ~48-unit paths
    const fpOX    = cx - 24 * fpScale * px;      // center at cx
    const fpOY    = cy - 24 * fpScale * px;      // center at cy

    c.save();
    c.translate(fpOX, fpOY);
    c.scale(fpScale * px, fpScale * px);
    c.globalAlpha = st.fingerAlpha;
    c.strokeStyle = isSuccess ? 'rgba(48,218,106,1)' : 'rgba(176,40,40,1)';
    c.lineWidth   = 1.1 / fpScale;  // compensate for scale; actual = ~2.2px canvas
    c.lineCap     = 'round';
    for (const d of FP_PATHS) c.stroke(new Path2D(d));
    c.restore();
  }

  // ── Status text ─────────────────────────────────────────────────────────────
  c.save();
  c.font          = `500 ${10 * px}px "SF Pro Display",-apple-system,BlinkMacSystemFont,sans-serif`;
  c.textAlign     = 'center';
  c.textBaseline  = 'middle';
  c.fillStyle     = `rgba(${st.statusRGB},${st.statusAlpha})`;
  c.fillText(st.statusText, cx, cy + 76 * px);
  c.restore();

  // ── Status LED ──────────────────────────────────────────────────────────────
  const ledY    = cy + 166 * px;
  const ledBeat = isSuccess ? 1 : (0.28 + glow * 0.72);

  // Glow halo
  c.save();
  c.filter = `blur(${4.5 * px}px)`;
  c.fillStyle = isSuccess
    ? `rgba(28,158,68,${ledBeat * 0.38})`
    : `rgba(175,18,18,${ledBeat * 0.38})`;
  c.beginPath(); c.arc(cx, ledY, 9 * px, 0, Math.PI * 2); c.fill();
  c.restore();

  // Dot with radial gradient (sphere illusion)
  const ldg = c.createRadialGradient(cx - px, ledY - px, 0, cx, ledY, 4 * px);
  if (isSuccess) {
    ldg.addColorStop(0, `rgba(90,230,130,${ledBeat})`);
    ldg.addColorStop(1, `rgba(22,136,62,${ledBeat})`);
  } else {
    ldg.addColorStop(0, `rgba(230,34,34,${ledBeat})`);
    ldg.addColorStop(1, `rgba(145,12,12,${ledBeat})`);
  }
  c.fillStyle = ldg;
  c.beginPath(); c.arc(cx, ledY, 3.6 * px, 0, Math.PI * 2); c.fill();
  c.strokeStyle = isSuccess ? 'rgba(10,96,40,0.72)' : 'rgba(100,10,10,0.72)';
  c.lineWidth   = px;
  c.beginPath(); c.arc(cx, ledY, 4.2 * px, 0, Math.PI * 2); c.stroke();
}

// ── Overlay DOM ───────────────────────────────────────────────────────────────

type OverlayRefs = {
  overlay:   HTMLDivElement;
  scene:     HTMLDivElement;
  doorRoot:  HTMLDivElement;
  interior:  HTMLDivElement;
  scanCanvas: HTMLCanvasElement;
  scanBtn:   HTMLDivElement;
  quitBtn:   HTMLButtonElement;
  state:     AnimState;
};

function buildOverlay(): OverlayRefs {
  injectStyles();

  const state = initState();

  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:9999;
    background:#050709;
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    font-family:"SF Pro Display",-apple-system,BlinkMacSystemFont,sans-serif;
    overflow:hidden;
    animation:vi-fadein 1.1s cubic-bezier(0.16,1,0.3,1) both;
  `;

  // Full-screen room canvas (static background)
  const roomCanvas = document.createElement('canvas');
  drawRoom(roomCanvas);
  overlay.appendChild(roomCanvas);

  // Scene — 3D perspective container (perspective on direct parent of rotating element)
  const scene = document.createElement('div');
  scene.style.cssText = `
    position:relative;
    width:min(720px,90vmin);
    height:min(720px,90vmin);
    flex-shrink:0;
    perspective:1800px;
    transform-style:preserve-3d;
  `;

  // Interior vault light — warm amber spill revealed as door opens
  const interior = document.createElement('div');
  interior.style.cssText = `
    position:absolute;top:0;left:0;right:0;bottom:0;
    border-radius:50%;
    background:radial-gradient(circle at 40% 36%,
      rgba(255,242,205,1.0) 0%,
      rgba(252,218,150,0.90) 10%,
      rgba(228,178,92,0.68) 24%,
      rgba(172,122,44,0.38) 44%,
      rgba(100,62,16,0.12) 62%,
      rgba(0,0,0,0) 76%
    );
    opacity:0;pointer-events:none;z-index:0;
  `;

  // Door root — the element that CSS-rotates open
  const doorRoot = document.createElement('div');
  doorRoot.style.cssText = `
    position:absolute;top:0;left:0;right:0;bottom:0;
    z-index:1;
  `;

  // Door face canvas (static — drawn once)
  const faceCanvas = document.createElement('canvas');
  drawDoorFace(faceCanvas);
  faceCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;';
  doorRoot.appendChild(faceCanvas);

  // Scanner canvas (animated — redrawn every frame)
  const scanCanvas = document.createElement('canvas');
  scanCanvas.width  = V * SC;
  scanCanvas.height = V * SC;
  scanCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;';
  doorRoot.appendChild(scanCanvas);

  // Hit target for scanner button
  const scanBtn = document.createElement('div');
  scanBtn.style.cssText = `
    position:absolute;
    top:50%;left:50%;
    width:${180 / V * 100}%;height:${180 / V * 100}%;
    transform:translate(-50%,-50%);
    border-radius:50%;
    cursor:pointer;z-index:2;
  `;
  doorRoot.appendChild(scanBtn);

  scene.appendChild(interior);
  scene.appendChild(doorRoot);

  // Quit button
  const quitBtn = document.createElement('button');
  quitBtn.textContent = 'Quit';
  quitBtn.style.cssText = `
    position:absolute;bottom:28px;
    background:none;border:none;
    font-size:12px;font-weight:500;letter-spacing:.08em;
    color:rgba(120,140,160,0.32);cursor:pointer;padding:6px 14px;
    transition:color .2s;
  `;
  quitBtn.addEventListener('mouseenter', () => { quitBtn.style.color = 'rgba(180,200,220,0.62)'; });
  quitBtn.addEventListener('mouseleave', () => { quitBtn.style.color = 'rgba(120,140,160,0.32)'; });

  overlay.appendChild(scene);
  overlay.appendChild(quitBtn);

  return { overlay, scene, doorRoot, interior, scanCanvas, scanBtn, quitBtn, state };
}

// ── rAF render loop ───────────────────────────────────────────────────────────

function startLoop(refs: OverlayRefs): () => void {
  let rafId = 0;

  const loop = (now: number) => {
    refs.state.glowPhase = (refs.state.glowPhase + 0.030) % (Math.PI * 2);

    // Compute bolt retraction progress per bolt (staggered 60ms between bolts)
    const bp: number[] = [];
    for (let i = 0; i < 8; i++) {
      if (refs.state.boltRetractStart === null) {
        bp.push(0);
      } else {
        const delay   = i * 55;                              // ms between bolts
        const elapsed = now - refs.state.boltRetractStart - delay;
        bp.push(Math.max(0, Math.min(1, elapsed / 300)));
      }
    }

    drawScannerFrame(refs.scanCanvas, refs.state, bp);
    rafId = requestAnimationFrame(loop);
  };

  rafId = requestAnimationFrame(loop);
  return () => cancelAnimationFrame(rafId);
}

// ── Scanner state helpers ─────────────────────────────────────────────────────

function setIdle(st: AnimState): void {
  st.scanner     = 'idle';
  st.statusText  = 'TAP TO RETRY';
  st.statusRGB   = '165,55,55';
  st.statusAlpha = 0.58;
  st.fingerAlpha = 0.40;
}

function setWarmup(st: AnimState): void {
  st.scanner     = 'warmup';
  st.statusText  = 'SCANNING…';
  st.statusRGB   = '215,80,80';
  st.statusAlpha = 0.80;
  st.fingerAlpha = 0.50;
}

function setPeak(st: AnimState): void {
  st.scanner     = 'peak';
  st.statusText  = 'PLACE FINGER ON SENSOR';
  st.statusRGB   = '238,120,120';
  st.statusAlpha = 0.92;
  st.fingerAlpha = 0.62;
}

function setError(st: AnimState, msg: string): void {
  st.scanner     = 'error';
  st.statusText  = msg;
  st.statusRGB   = '200,68,68';
  st.statusAlpha = 0.88;
  st.fingerAlpha = 0.35;
}

function setSuccess(st: AnimState): void {
  st.scanner     = 'success';
  st.statusText  = 'ACCESS GRANTED';
  st.statusRGB   = '42,200,96';
  st.statusAlpha = 0.92;
  st.fingerAlpha = 0.72;
}

// ── Opening sequence ──────────────────────────────────────────────────────────

async function playOpenSequence(
  refs: OverlayRefs,
  audioCtx: AudioContext | null,
  appReady?: Promise<void>,
): Promise<void> {
  setSuccess(refs.state);
  await sleep(420);

  // Motor whine + bolt retracts
  if (audioCtx) { playMotorWhine(audioCtx); playBoltRetracts(audioCtx); }

  // Trigger bolt retraction animation (driven by rAF loop via boltRetractStart)
  refs.state.boltRetractStart = performance.now();
  await sleep(820);

  // Wait for app to be ready before opening door
  if (appReady) {
    refs.state.statusText  = 'INITIALIZING…';
    refs.state.statusRGB   = '42,200,96';
    refs.state.statusAlpha = 0.52;
    await Promise.race([appReady, sleep(2600)]);
    refs.state.statusText  = 'READY';
    await sleep(180);
  }

  // Pressure seal releases — micro-jitter before door mass starts moving
  refs.scene.style.animation = 'vi-seal-jitter .36s ease both';
  if (audioCtx) playDoorOpen(audioCtx);
  await sleep(400);
  refs.scene.style.animation = '';
  await sleep(80);

  // Interior vault light floods through opening as door swings
  Object.assign(refs.interior.style, {
    transition: 'opacity 2.4s ease 0.10s',
    opacity:    '1',
  });

  // Door swings on left hinge — right edge rotates away (opens into vault)
  // rotateY positive = right side goes back. Parent perspective gives foreshortening.
  Object.assign(refs.doorRoot.style, {
    transition:      'transform 3.4s cubic-bezier(0.45, 0, 0.22, 1)',
    transformOrigin: 'left center',
    transform:       'rotateY(86deg)',
  });
  await sleep(860);

  // Camera dollies forward + overlay fades
  refs.overlay.style.animation = 'none';
  Object.assign(refs.overlay.style, {
    transition: 'transform 3.2s cubic-bezier(0.18,0,0.38,1), opacity 2.1s ease 0.08s',
    transform:  'scale(1.07)',
    opacity:    '0',
  });
  await sleep(2300);
}

// ── Biometric flow ────────────────────────────────────────────────────────────

async function runBiometricFlow(
  refs: OverlayRefs,
  onQuit: () => void,
  stopLoop: () => void,
  appReady?: Promise<void>,
): Promise<boolean> {
  let settled  = false;
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
      await sleep(720);
      if (settled) return;
    }

    setPeak(refs.state);
    await sleep(620);
    if (settled) return;

    try {
      const audioCtx = newACtx();
      await invokeTauri<void>(CMD, { reason: REASON, options: { allowDeviceCredential: true } });
      if (settled) return;
      settled = true;
      await playOpenSequence(refs, audioCtx, appReady);
      resolveFlow(true);
    } catch (err) {
      if (settled) return;
      inFlight = false;
      const msg  = err instanceof Error ? err.message : '';
      const text = msg.toLowerCase().includes('cancel') ? 'CANCELLED — TAP TO RETRY' : 'TAP TO RETRY';
      setError(refs.state, text);
      setTimeout(() => { if (!settled) setIdle(refs.state); }, 1500);
    }
  };

  setTimeout(() => void tryAuth(false), 1200);
  refs.scanBtn.addEventListener('click', () => void tryAuth(true));

  return result;
}

// ── Export ────────────────────────────────────────────────────────────────────

export async function runVaultIntro(appReady?: Promise<void>): Promise<boolean> {
  const refs    = buildOverlay();
  const stopLoop = startLoop(refs);
  document.body.appendChild(refs.overlay);

  let quitCalled = false;
  const unlocked = await runBiometricFlow(refs, () => { quitCalled = true; }, stopLoop, appReady);

  stopLoop();
  refs.overlay.remove();
  if (quitCalled) window.close();
  return unlocked;
}
