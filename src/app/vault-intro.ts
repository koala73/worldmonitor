// Single-window biometric vault door.
// Calls the Tauri biometric plugin directly — no secondary overlay, one fingerprint prompt.
// Door surface rendered via Canvas 2D for photorealistic brushed steel.
// Opening sequence: full 3D vault scene choreography with concrete room environment.

import { hasTauriInvokeBridge, invokeTauri } from '../services/tauri-bridge';

const CMD = 'plugin:biometry|authenticate';
const REASON = 'Unlock World Monitor';
const BRIDGE_TIMEOUT_MS = 2500;
const POLL_MS = 50;
const NS = 'http://www.w3.org/2000/svg';

// ── Helpers ────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function svgEl<T extends SVGElement>(tag: string): T {
  return document.createElementNS(NS, tag) as T;
}

function attr(el: SVGElement, attrs: Record<string, string | number>): void {
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
}

async function waitForBridge(): Promise<boolean> {
  if (hasTauriInvokeBridge()) return true;
  const deadline = Date.now() + BRIDGE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    if (hasTauriInvokeBridge()) return true;
  }
  return false;
}

// Seeded LCG — deterministic grain every render
function lcg(seed: number): () => number {
  let s = (seed | 0) >>> 0;
  return () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 4294967296; };
}

// ── Audio ──────────────────────────────────────────────────────────────────────

function newCtx(): AudioContext | null {
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
  const motorF = ctx.createBiquadFilter();
  motorF.type = 'lowpass'; motorF.frequency.value = 380;
  const motorG = ctx.createGain();
  motorG.gain.setValueAtTime(0, t0);
  motorG.gain.linearRampToValueAtTime(0.18, t0 + 0.14);
  motorG.gain.setValueAtTime(0.18, t0 + 0.95);
  motorG.gain.linearRampToValueAtTime(0, t0 + dur);
  motor.connect(motorF).connect(motorG).connect(ctx.destination);
  motor.start(t0); motor.stop(t0 + dur + 0.05);

  const gear = ctx.createOscillator();
  gear.type = 'sawtooth';
  gear.frequency.setValueAtTime(720, t0 + 0.08);
  gear.frequency.exponentialRampToValueAtTime(1150, t0 + 0.58);
  gear.frequency.exponentialRampToValueAtTime(860, t0 + 0.95);
  gear.frequency.exponentialRampToValueAtTime(380, t0 + dur);
  const gearF = ctx.createBiquadFilter();
  gearF.type = 'bandpass'; gearF.frequency.value = 950; gearF.Q.value = 2.2;
  const gearG = ctx.createGain();
  gearG.gain.setValueAtTime(0, t0 + 0.08);
  gearG.gain.linearRampToValueAtTime(0.065, t0 + 0.32);
  gearG.gain.setValueAtTime(0.065, t0 + 0.95);
  gearG.gain.linearRampToValueAtTime(0, t0 + dur);
  gear.connect(gearF).connect(gearG).connect(ctx.destination);
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
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const hpf = ctx.createBiquadFilter();
    hpf.type = 'highpass'; hpf.frequency.value = 3500;
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
  const hSrc = ctx.createBufferSource();
  hSrc.buffer = hBuf;
  const hF = ctx.createBiquadFilter();
  hF.type = 'bandpass';
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

  const rOsc = ctx.createOscillator();
  rOsc.type = 'sawtooth';
  rOsc.frequency.setValueAtTime(42, t0 + 0.3);
  rOsc.frequency.linearRampToValueAtTime(52, t0 + 1.5);
  const rF = ctx.createBiquadFilter();
  rF.type = 'lowpass'; rF.frequency.value = 160;
  const rG = ctx.createGain();
  rG.gain.setValueAtTime(0, t0 + 0.3);
  rG.gain.linearRampToValueAtTime(0.2, t0 + 0.5);
  rG.gain.setValueAtTime(0.2, t0 + 1.4);
  rG.gain.linearRampToValueAtTime(0, t0 + 2.1);
  rOsc.connect(rF).connect(rG).connect(ctx.destination);
  rOsc.start(t0 + 0.3); rOsc.stop(t0 + 2.2);

  const wBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 1.6), ctx.sampleRate);
  const wd = wBuf.getChannelData(0);
  for (let i = 0; i < wd.length; i++) wd[i] = Math.random() * 2 - 1;
  const wSrc = ctx.createBufferSource();
  wSrc.buffer = wBuf;
  const wF = ctx.createBiquadFilter();
  wF.type = 'bandpass';
  wF.frequency.setValueAtTime(440, t0 + 0.55);
  wF.frequency.exponentialRampToValueAtTime(3200, t0 + 1.1);
  wF.frequency.exponentialRampToValueAtTime(180, t0 + 2.1);
  wF.Q.value = 0.55;
  const wG = ctx.createGain();
  wG.gain.setValueAtTime(0, t0 + 0.55);
  wG.gain.linearRampToValueAtTime(0.25, t0 + 0.85);
  wG.gain.linearRampToValueAtTime(0, t0 + 2.1);
  wSrc.connect(wF).connect(wG).connect(ctx.destination);
  wSrc.start(t0 + 0.55);
}

// ── CSS ────────────────────────────────────────────────────────────────────────

function injectStyles(): void {
  if (document.getElementById('vault-intro-css')) return;
  const s = document.createElement('style');
  s.id = 'vault-intro-css';
  s.textContent = `
    @keyframes vi-fadein   { from{opacity:0;transform:scale(1.04)} to{opacity:1;transform:scale(1)} }
    @keyframes vi-scan     { 0%,100%{opacity:.28;stroke-width:1px}  50%{opacity:.75;stroke-width:1.6px} }
    @keyframes vi-warmup   { 0%,100%{opacity:.5;stroke-width:1.4px} 50%{opacity:.9;stroke-width:2px} }
    @keyframes vi-glow     { 0%,100%{opacity:0} 50%{opacity:.40} }
    @keyframes vi-glowwarm { 0%,100%{opacity:.2} 50%{opacity:.65} }
    @keyframes vi-scanerr  { 0%,100%{opacity:.5;stroke-width:1.5px} 50%{opacity:1;stroke-width:2px} }
    @keyframes vi-shake    { 0%,100%{transform:translateX(0)} 20%{transform:translateX(-4px)} 40%{transform:translateX(4px)} 60%{transform:translateX(-3px)} 80%{transform:translateX(3px)} }
    @keyframes vi-bolt-retract {
      0%   { transform:translateY(0)     scaleX(1);    opacity:1   }
      30%  { transform:translateY(-7px)  scaleX(0.88); opacity:0.9 }
      100% { transform:translateY(-32px) scaleX(0.55); opacity:0   }
    }
    @keyframes vi-seal-jitter {
      0%   { transform:translateX(0)    }
      16%  { transform:translateX(-3px) }
      33%  { transform:translateX(5px)  }
      50%  { transform:translateX(-4px) }
      66%  { transform:translateX(3px)  }
      82%  { transform:translateX(-1px) }
      100% { transform:translateX(0)    }
    }
    @keyframes vi-ledblink { 0%,100%{opacity:1} 50%{opacity:.2} }
  `;
  document.head.appendChild(s);
}

// ── Vault room environment ─────────────────────────────────────────────────────
// Draws a photorealistic concrete vault anteroom with overhead lighting,
// perspective floor, and the static steel door frame/jamb.

function drawVaultRoom(canvas: HTMLCanvasElement): void {
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  const VW  = window.innerWidth;
  const VH  = window.innerHeight;
  canvas.width  = VW * DPR;
  canvas.height = VH * DPR;
  canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;';
  const c = canvas.getContext('2d')!;
  c.scale(DPR, DPR);
  const cx = VW / 2, cy = VH / 2;

  // ── Base: deep near-black concrete ────────────────────────────────────────
  c.fillStyle = '#07090c';
  c.fillRect(0, 0, VW, VH);

  // ── Concrete wall texture — dense horizontal micro-grain ──────────────────
  const rW = lcg(3);
  for (let i = 0; i < 600; i++) {
    const y  = rW() * VH;
    const bv = 0.35 + rW() * 1.3;
    const a  = 0.004 + rW() * 0.016;
    c.strokeStyle = `rgba(${50 * bv | 0},${54 * bv | 0},${60 * bv | 0},${a})`;
    c.lineWidth   = 0.12 + rW() * 0.7;
    c.beginPath(); c.moveTo(0, y); c.lineTo(VW, y); c.stroke();
  }
  // Subtle larger-scale concrete aggregate variation
  const rA = lcg(7);
  for (let i = 0; i < 120; i++) {
    const x  = rA() * VW;
    const y  = rA() * VH;
    const r  = 1.5 + rA() * 5;
    const a  = 0.008 + rA() * 0.018;
    c.fillStyle = `rgba(${40 + (rA() * 25) | 0},${43 + (rA() * 25) | 0},${50 + (rA() * 25) | 0},${a})`;
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  }

  // ── Overhead fluorescent strip — harsh industrial light ────────────────────
  {
    const g = c.createRadialGradient(cx, -VH * 0.08, 0, cx, VH * 0.38, Math.min(VW, VH) * 0.78);
    g.addColorStop(0,    'rgba(185,200,225,0.22)');
    g.addColorStop(0.22, 'rgba(100,120,155,0.08)');
    g.addColorStop(0.65, 'rgba(0,0,0,0)');
    c.fillStyle = g; c.fillRect(0, 0, VW, VH);
  }
  // Fluorescent tube fixture at ceiling
  const tubeW = VW * 0.10;
  const tx = cx - tubeW / 2;
  {
    const g = c.createLinearGradient(0, 0, 0, 32);
    g.addColorStop(0, 'rgba(225,235,255,0.90)');
    g.addColorStop(1, 'rgba(225,235,255,0)');
    c.fillStyle = g; c.fillRect(tx - 12, 0, tubeW + 24, 32);
  }
  c.fillStyle = 'rgba(240,248,255,0.95)';
  c.fillRect(tx, 1, tubeW, 3);
  // Fixture housing shadow
  c.fillStyle = 'rgba(0,0,0,0.45)';
  c.fillRect(tx - 4, 0, tubeW + 8, 1);

  // ── Floor break with perspective concrete tiles ────────────────────────────
  const floorY = cy + Math.min(VW, VH) * 0.37;

  // Floor fill
  {
    const g = c.createLinearGradient(0, floorY, 0, VH);
    g.addColorStop(0,    'rgba(20,23,28,0)');
    g.addColorStop(0.05, 'rgba(14,16,20,0.95)');
    g.addColorStop(1,    '#0b0d11');
    c.fillStyle = g; c.fillRect(0, floorY, VW, VH - floorY);
  }
  // Floor/wall seam — blurred shadow + specular
  c.save();
  c.filter = 'blur(4px)';
  c.fillStyle = 'rgba(0,0,0,0.85)';
  c.fillRect(0, floorY - 5, VW, 14);
  c.restore();
  c.strokeStyle = 'rgba(50,55,65,0.28)';
  c.lineWidth = 0.8;
  c.beginPath(); c.moveTo(0, floorY - 1); c.lineTo(VW, floorY - 1); c.stroke();

  // Tile horizontal joints (perspective foreshortening)
  for (let t = 1; t <= 7; t++) {
    const p  = t / 7;
    const fy = floorY + (VH - floorY) * (1 - Math.pow(1 - p, 2.6));
    c.strokeStyle = `rgba(25,28,35,${0.04 + p * 0.06})`;
    c.lineWidth = 0.7;
    c.beginPath(); c.moveTo(0, fy); c.lineTo(VW, fy); c.stroke();
  }
  // Tile vertical joints (converge to vanishing point)
  for (let v = 0; v <= 9; v++) {
    const px = (v / 9) * VW;
    c.strokeStyle = 'rgba(22,25,32,0.045)';
    c.lineWidth = 0.5;
    c.beginPath(); c.moveTo(cx, floorY); c.lineTo(px, VH); c.stroke();
  }

  // ── Edge vignettes — side walls and ceiling ────────────────────────────────
  const addVignette = (x0: number, y0: number, x1: number, y1: number, c0: string, c1: string) => {
    const g = c.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, c0); g.addColorStop(1, c1);
    c.fillStyle = g;
    c.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
  };
  addVignette(0, 0, VW * 0.22, 0, 'rgba(0,0,0,0.72)', 'rgba(0,0,0,0)');
  addVignette(VW, 0, VW * 0.78, 0, 'rgba(0,0,0,0.72)', 'rgba(0,0,0,0)');
  addVignette(0, 0, 0, VH * 0.15, 'rgba(0,0,0,0.60)', 'rgba(0,0,0,0)');

  // ── Vault recess — deep AO shadow around the circular opening ─────────────
  // Computes from the door CSS logical size
  const doorSize  = Math.min(520, VW * 0.78, VH * 0.78);
  const frameROut = (249 / 500) * doorSize * 0.5;
  const frameRIn  = (204 / 500) * doorSize * 0.5;

  for (let pass = 0; pass < 6; pass++) {
    c.save();
    c.filter    = `blur(${48 + pass * 36}px)`;
    c.strokeStyle = `rgba(0,0,0,${0.26 + pass * 0.10})`;
    c.lineWidth = doorSize * (0.085 + pass * 0.014);
    c.beginPath(); c.arc(cx, cy + VH * 0.007, frameROut + pass * 3, 0, Math.PI * 2); c.stroke();
    c.restore();
  }

  // ── Static vault frame — thick machined steel jamb ─────────────────────────
  // This ring stays perfectly still as the door swings open, giving the door
  // a fixed context: it is mounted in 12-inch thick reinforced concrete.

  // Deep contact shadow behind the frame ring
  c.save();
  c.filter    = 'blur(20px)';
  c.strokeStyle = 'rgba(0,0,0,0.98)';
  c.lineWidth = (frameROut - frameRIn) * 0.7;
  c.beginPath(); c.arc(cx, cy + 8, (frameROut + frameRIn) / 2, 0, Math.PI * 2); c.stroke();
  c.restore();

  // Frame ring body
  c.save();
  c.beginPath();
  c.arc(cx, cy, frameROut + 3, 0, Math.PI * 2);
  c.arc(cx, cy, frameRIn  - 2, 0, Math.PI * 2, true);
  c.clip('evenodd');

  {
    const g = c.createRadialGradient(
      cx - frameROut * 0.30, cy - frameROut * 0.24, 0,
      cx + 6, cy + 8, frameROut * 1.06,
    );
    g.addColorStop(0,    '#1d2028');
    g.addColorStop(0.45, '#0f1115');
    g.addColorStop(1,    '#040507');
    c.fillStyle = g;
    c.fillRect(cx - frameROut - 5, cy - frameROut - 5, (frameROut + 5) * 2, (frameROut + 5) * 2);
  }

  // Frame brushed grain
  const rFr = lcg(11);
  for (let i = 0; i < 240; i++) {
    const y   = cy - frameROut - 4 + rFr() * (frameROut + 4) * 2;
    const bv  = 0.45 + rFr() * 0.9;
    const a   = 0.004 + rFr() * 0.016;
    c.strokeStyle = `rgba(${30 * bv | 0},${32 * bv | 0},${38 * bv | 0},${a})`;
    c.lineWidth   = 0.15 + rFr() * 0.5;
    c.beginPath(); c.moveTo(cx - frameROut - 5, y); c.lineTo(cx + frameROut + 5, y); c.stroke();
  }

  // Frame bevel lines — directional light from upper-left
  c.strokeStyle = 'rgba(255,255,255,0.06)';
  c.lineWidth   = 1.5;
  c.beginPath(); c.arc(cx - 1, cy - 1, frameROut + 1, 0, Math.PI * 2); c.stroke();
  c.strokeStyle = 'rgba(0,0,0,0.50)';
  c.lineWidth   = 2;
  c.beginPath(); c.arc(cx + 1.5, cy + 1.5, frameROut + 1, 0, Math.PI * 2); c.stroke();

  // Inner seam — machined transition to door recess
  c.strokeStyle = '#020304';
  c.lineWidth   = 4;
  c.beginPath(); c.arc(cx, cy, frameRIn - 1, 0, Math.PI * 2); c.stroke();
  c.strokeStyle = 'rgba(255,255,255,0.05)';
  c.lineWidth   = 1;
  c.beginPath(); c.arc(cx - 0.5, cy - 0.5, frameRIn - 2, 0, Math.PI * 2); c.stroke();

  c.restore();

  // Frame upper-left specular catch
  {
    const g = c.createRadialGradient(
      cx - frameROut * 0.58, cy - frameROut * 0.42, 0,
      cx - frameROut * 0.58, cy - frameROut * 0.42, frameROut * 0.52,
    );
    g.addColorStop(0, 'rgba(255,255,255,0.026)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.save();
    c.beginPath();
    c.arc(cx, cy, frameROut + 3, 0, Math.PI * 2);
    c.arc(cx, cy, frameRIn - 2, 0, Math.PI * 2, true);
    c.clip('evenodd');
    c.fillStyle = g;
    c.fillRect(cx - frameROut - 5, cy - frameROut - 5, (frameROut + 5) * 2, (frameROut + 5) * 2);
    c.restore();
  }
}

// ── Canvas door surface ────────────────────────────────────────────────────────

function drawDoorCanvas(canvas: HTMLCanvasElement): void {
  const L = 500;
  const SCALE = 2;
  canvas.width = L * SCALE;
  canvas.height = L * SCALE;
  canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;display:block;';
  const ctx = canvas.getContext('2d')!;
  ctx.scale(SCALE, SCALE);
  const C = L / 2;

  const grain = (
    count: number, x0: number, x1: number, y0: number, y1: number,
    rng: () => number, base: [number, number, number],
  ) => {
    for (let i = 0; i < count; i++) {
      const y = y0 + rng() * (y1 - y0);
      const bv = 0.48 + rng() * 0.96;
      const alpha = 0.004 + rng() * 0.024;
      ctx.strokeStyle = `rgba(${Math.min(255,base[0]*bv|0)},${Math.min(255,base[1]*bv|0)},${Math.min(255,base[2]*bv|0)},${alpha})`;
      ctx.lineWidth = 0.18 + rng() * 0.58;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    }
  };

  const rrect = (x: number, y: number, w: number, h: number, r: number) => {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  };

  const rD  = lcg(22);
  const rSc = lcg(77);

  // 1. Cast shadow
  ctx.save();
  ctx.filter = 'blur(40px)';
  ctx.fillStyle = 'rgba(0,0,0,0.92)';
  ctx.beginPath(); ctx.ellipse(C, C + 24, 236, 215, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // 2. Frame ring — omitted from door canvas; now drawn as static room element
  // (we still clip/mask to leave the frame area undrawn on the door itself)

  // 3. Machined seam
  ctx.strokeStyle = '#020203'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(C, C, 204, 0, Math.PI * 2); ctx.stroke();

  // 4. Bolt housings
  for (let i = 0; i < 8; i++) {
    ctx.save();
    ctx.translate(C, C); ctx.rotate(i * Math.PI / 4); ctx.translate(-C, -C);
    ctx.beginPath(); rrect(C - 10, 4, 20, 48, 5);
    ctx.fillStyle = '#030405'; ctx.fill();
    ctx.strokeStyle = '#0b0c0f'; ctx.lineWidth = 1; ctx.stroke();
    ctx.save();
    ctx.filter = 'blur(5px)';
    ctx.fillStyle = 'rgba(0,0,0,1)'; ctx.fillRect(C - 9, 4, 18, 18);
    ctx.restore();
    ctx.restore();
  }

  // 5. Door face
  ctx.save();
  ctx.beginPath(); ctx.arc(C, C, 201, 0, Math.PI * 2); ctx.clip();

  {
    const g = ctx.createRadialGradient(C - 72, C - 60, 0, C + 22, C + 28, 232);
    g.addColorStop(0,    '#575f6c');
    g.addColorStop(0.14, '#404852');
    g.addColorStop(0.40, '#2a2d34');
    g.addColorStop(0.70, '#1e2026');
    g.addColorStop(1,    '#121418');
    ctx.fillStyle = g; ctx.fillRect(0, 0, L, L);
  }

  grain(660, 0, L, C - 201, C + 201, rD, [190, 197, 205]);

  for (let j = 0; j < 9; j++) {
    const y = C - 170 + rSc() * 340;
    const alpha = 0.018 + rSc() * 0.038;
    ctx.strokeStyle = `rgba(218,226,236,${alpha})`;
    ctx.lineWidth = 0.22 + rSc() * 0.42;
    ctx.beginPath();
    ctx.moveTo(C - 188 + rSc() * 40, y);
    ctx.lineTo(C + 155 + rSc() * 40, y);
    ctx.stroke();
  }

  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  {
    const g = ctx.createRadialGradient(C - 66, C - 72, 0, C - 32, C - 40, 112);
    g.addColorStop(0, 'rgba(255,255,255,0.072)');
    g.addColorStop(0.42, 'rgba(255,255,255,0.028)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, L, L);
  }
  {
    const g = ctx.createRadialGradient(C - 82, C - 86, 0, C - 82, C - 86, 40);
    g.addColorStop(0, 'rgba(255,255,255,0.115)');
    g.addColorStop(0.28, 'rgba(255,255,255,0.044)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, L, L);
  }
  ctx.restore();

  ctx.strokeStyle = 'rgba(255,255,255,0.145)'; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.arc(C, C, 199, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.74)'; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.arc(C + 3, C + 3, 197, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();

  // 6. Outer machined groove
  ctx.save(); ctx.filter = 'blur(8px)';
  ctx.strokeStyle = 'rgba(0,0,0,0.88)'; ctx.lineWidth = 20;
  ctx.beginPath(); ctx.arc(C, C + 4, 172, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
  ctx.strokeStyle = '#030406'; ctx.lineWidth = 9;
  ctx.beginPath(); ctx.arc(C, C, 172, 0, Math.PI * 2); ctx.stroke();
  {
    const g = ctx.createLinearGradient(0, 0, L, L);
    g.addColorStop(0, 'rgba(255,255,255,0.10)'); g.addColorStop(0.5, 'rgba(255,255,255,0.035)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.strokeStyle = g; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(C - 1, C - 1, 177, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.58)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(C + 1, C + 1, 167, 0, Math.PI * 2); ctx.stroke();

  // 7. Inner machined groove
  ctx.save(); ctx.filter = 'blur(7px)';
  ctx.strokeStyle = 'rgba(0,0,0,0.82)'; ctx.lineWidth = 16;
  ctx.beginPath(); ctx.arc(C, C + 3, 126, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
  ctx.strokeStyle = '#030406'; ctx.lineWidth = 7;
  ctx.beginPath(); ctx.arc(C, C, 126, 0, Math.PI * 2); ctx.stroke();
  {
    const g = ctx.createLinearGradient(0, 0, L, L);
    g.addColorStop(0, 'rgba(255,255,255,0.085)'); g.addColorStop(0.5, 'rgba(255,255,255,0.028)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.strokeStyle = g; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(C - 1, C - 1, 130, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.52)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(C + 1, C + 1, 122, 0, Math.PI * 2); ctx.stroke();

  // 8. Machined rivets
  for (const deg of [22.5, 67.5, 112.5, 157.5, 202.5, 247.5, 292.5, 337.5]) {
    const rad = deg * Math.PI / 180;
    const rx = C + Math.cos(rad) * 149;
    const ry = C + Math.sin(rad) * 149;

    ctx.save(); ctx.filter = 'blur(5px)';
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.beginPath(); ctx.arc(rx, ry, 10, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    {
      const g = ctx.createRadialGradient(rx - 2, ry - 2.5, 0, rx, ry, 6.5);
      g.addColorStop(0, '#222429'); g.addColorStop(1, '#090a0e');
      ctx.fillStyle = g;
    }
    ctx.beginPath(); ctx.arc(rx, ry, 6.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#0c0d11'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(rx, ry, 6.5, 0, Math.PI * 2); ctx.stroke();

    ctx.save(); ctx.beginPath(); ctx.arc(rx, ry, 6.5, 0, Math.PI * 2); ctx.clip();
    {
      const g = ctx.createRadialGradient(rx - 2.6, ry - 2.9, 0, rx, ry, 7);
      g.addColorStop(0, 'rgba(255,255,255,0.42)');
      g.addColorStop(0.32, 'rgba(255,255,255,0.14)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.fillRect(rx - 7, ry - 7, 14, 14);
    }
    ctx.restore();

    ctx.fillStyle = '#0d0e12';
    ctx.beginPath(); ctx.arc(rx, ry, 2, 0, Math.PI * 2); ctx.fill();
  }

  // 9. Scanner housing — deeply recessed
  ctx.save(); ctx.filter = 'blur(14px)';
  ctx.strokeStyle = 'rgba(0,0,0,1)'; ctx.lineWidth = 30;
  ctx.beginPath(); ctx.arc(C, C + 6, 95, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
  ctx.fillStyle = '#030405';
  ctx.beginPath(); ctx.arc(C, C, 93, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#090a0c'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(C, C, 93, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(C - 1, C - 1, 92, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.62)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(C + 1, C + 1, 92, 0, Math.PI * 2); ctx.stroke();

  // 10. Scanner glass pad
  ctx.save(); ctx.beginPath(); ctx.arc(C, C, 83, 0, Math.PI * 2); ctx.clip();
  {
    const g = ctx.createRadialGradient(C - 22, C - 27, 0, C + 12, C + 15, 90);
    g.addColorStop(0, '#0d1015'); g.addColorStop(0.5, '#07090d'); g.addColorStop(1, '#030508');
    ctx.fillStyle = g; ctx.fillRect(C - 86, C - 86, 172, 172);
  }
  {
    const g = ctx.createRadialGradient(C - 18, C - 29, 0, C - 18, C - 29, 42);
    g.addColorStop(0, 'rgba(255,255,255,0.115)');
    g.addColorStop(0.48, 'rgba(255,255,255,0.042)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(C - 65, C - 76, 88, 66);
  }
  {
    const g = ctx.createRadialGradient(C - 26, C - 37, 0, C - 24, C - 35, 16);
    g.addColorStop(0, 'rgba(255,255,255,0.22)');
    g.addColorStop(0.38, 'rgba(255,255,255,0.08)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(C - 50, C - 62, 54, 42);
  }
  ctx.restore();

  // 11. Logo — micro-etched
  ctx.save();
  ctx.font = '700 9.5px "SF Pro Display", -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(135,145,160,0.18)';
  ctx.fillText('WORLD  MONITOR', C, C - 128);
  ctx.restore();
}

// ── SVG door ───────────────────────────────────────────────────────────────────

type DoorParts = {
  root: HTMLDivElement;
  svg: SVGSVGElement;
  scannerRing: SVGCircleElement;
  scannerGlow: SVGCircleElement;
  padFill: SVGCircleElement;
  fpPaths: SVGPathElement[];
  statusText: SVGTextElement;
  boltPins: SVGGElement[];
  lockedLed: SVGCircleElement;
  scannerBtn: SVGCircleElement;
};

function buildDoor(): DoorParts {
  const V = 500;
  const C = 250;

  const root = document.createElement('div');
  root.style.cssText = 'position:relative;width:min(520px,78vmin);height:min(520px,78vmin);flex-shrink:0;';

  const canvas = document.createElement('canvas');
  drawDoorCanvas(canvas);
  root.appendChild(canvas);

  const svg = svgEl<SVGSVGElement>('svg');
  attr(svg, { viewBox: `0 0 ${V} ${V}` });
  svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;overflow:visible;pointer-events:none;';

  const defs = svgEl('defs');

  const bg = svgEl<SVGLinearGradientElement>('linearGradient');
  attr(bg, { id: 'vi-bg', x1: '0%', y1: '0%', x2: '100%', y2: '0%' });
  for (const [off, col] of [
    ['0%','#636970'],['20%','#4c5258'],['55%','#2e3138'],['100%','#1a1b20'],
  ] as const) {
    const s = svgEl<SVGStopElement>('stop'); attr(s, { offset: off, 'stop-color': col }); bg.appendChild(s);
  }

  // Tighter, more realistic glow — not a neon ring
  const gf = svgEl<SVGFilterElement>('filter');
  attr(gf, { id: 'vi-glow', x: '-50%', y: '-50%', width: '200%', height: '200%' });
  const gb = svgEl('feGaussianBlur'); attr(gb, { stdDeviation: '5', result: 'blur' });
  const gm = svgEl('feMerge');
  [{ in: 'blur' }, { in: 'SourceGraphic' }].forEach(a => { const n = svgEl('feMergeNode'); attr(n, a); gm.appendChild(n); });
  gf.appendChild(gb); gf.appendChild(gm);

  const grainF = svgEl<SVGFilterElement>('filter');
  attr(grainF, { id: 'vi-grain', 'color-interpolation-filters': 'sRGB' });
  const turb = svgEl('feTurbulence');
  attr(turb, { type: 'fractalNoise', baseFrequency: '0.72 0.011', numOctaves: '4', seed: '9', result: 'noise' });
  const desat = svgEl('feColorMatrix');
  attr(desat, { type: 'saturate', values: '0', in: 'noise', result: 'gray' });
  const grainBlend = svgEl('feBlend');
  attr(grainBlend, { in: 'SourceGraphic', in2: 'gray', mode: 'overlay', result: 'blended' });
  const grainComp = svgEl('feComposite');
  attr(grainComp, { in: 'blended', in2: 'SourceGraphic', operator: 'in' });
  grainF.appendChild(turb); grainF.appendChild(desat); grainF.appendChild(grainBlend); grainF.appendChild(grainComp);

  defs.appendChild(bg); defs.appendChild(gf); defs.appendChild(grainF);
  svg.appendChild(defs);

  // Bolt pins
  const boltPins: SVGGElement[] = [];
  for (let i = 0; i < 8; i++) {
    const g = svgEl<SVGGElement>('g');
    g.setAttribute('transform', `rotate(${i * 45} ${C} ${C})`);
    const pinG = svgEl<SVGGElement>('g');
    const pin = svgEl<SVGRectElement>('rect');
    attr(pin, { x: C - 8, y: 8, width: 16, height: 34, rx: 4, fill: 'url(#vi-bg)' });
    const pinTopHL = svgEl<SVGRectElement>('rect');
    attr(pinTopHL, { x: C - 7, y: 8, width: 14, height: 3.5, rx: 1.75, fill: 'rgba(255,255,255,0.40)' });
    const pinLeftHL = svgEl<SVGRectElement>('rect');
    attr(pinLeftHL, { x: C - 8, y: 10, width: 2.5, height: 28, rx: 1.25, fill: 'rgba(255,255,255,0.22)' });
    const pinGrain = svgEl<SVGRectElement>('rect');
    attr(pinGrain, { x: C - 8, y: 8, width: 16, height: 34, rx: 4,
      fill: 'rgba(200,205,215,0.07)', filter: 'url(#vi-grain)' });
    pinG.appendChild(pin); pinG.appendChild(pinTopHL);
    pinG.appendChild(pinLeftHL); pinG.appendChild(pinGrain);
    g.appendChild(pinG); svg.appendChild(g);
    boltPins.push(pinG);
  }

  // Scanner indicator — deep crimson infrared ring (locked state)
  // Reduced stroke-width and less aggressive glow for realism
  const scannerGlow = svgEl<SVGCircleElement>('circle');
  attr(scannerGlow, { cx: C, cy: C, r: 85, fill: 'none', stroke: '#6b0e0e', 'stroke-width': 7 });
  scannerGlow.style.cssText = 'filter:url(#vi-glow);animation:vi-glow 2.8s ease-in-out infinite;';
  svg.appendChild(scannerGlow);

  const scannerRing = svgEl<SVGCircleElement>('circle');
  attr(scannerRing, { cx: C, cy: C, r: 84, fill: 'none', stroke: '#9b1c1c', 'stroke-width': 1.2 });
  scannerRing.style.animation = 'vi-scan 2.8s ease-in-out infinite';
  svg.appendChild(scannerRing);

  const padFill = svgEl<SVGCircleElement>('circle');
  attr(padFill, { cx: C, cy: C, r: 83, fill: 'transparent' });
  svg.appendChild(padFill);

  // Fingerprint ridges — dark crimson, locked
  const fpG = svgEl<SVGGElement>('g');
  fpG.setAttribute('transform', `translate(${C - 24}, ${C - 28})`);
  fpG.setAttribute('opacity', '0.45');
  const fpDefs = [
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
  const fpPaths: SVGPathElement[] = [];
  for (const d of fpDefs) {
    const p = svgEl<SVGPathElement>('path');
    attr(p, { d, stroke: '#8b2222', 'stroke-width': '1.2', fill: 'none', 'stroke-linecap': 'round' });
    fpG.appendChild(p); fpPaths.push(p);
  }
  svg.appendChild(fpG);

  const statusText = svgEl<SVGTextElement>('text');
  attr(statusText, {
    x: C, y: C + 70,
    'text-anchor': 'middle',
    'font-family': '"SF Pro Display", -apple-system, BlinkMacSystemFont, sans-serif',
    'font-size': '10', 'font-weight': '500', 'letter-spacing': '0.2em',
    fill: 'rgba(180,80,80,0.6)',
  });
  statusText.textContent = 'BIOMETRIC SCAN READY';
  svg.appendChild(statusText);

  // Status LED — red blinking (locked)
  const ledGlow = svgEl<SVGCircleElement>('circle');
  attr(ledGlow, { cx: C, cy: C + 160, r: 9, fill: 'rgba(200,28,28,0.16)' });
  svg.appendChild(ledGlow);
  const lockedLed = svgEl<SVGCircleElement>('circle');
  attr(lockedLed, { cx: C, cy: C + 160, r: 3.5, fill: '#cc2020', stroke: '#6a0e0e', 'stroke-width': 1 });
  lockedLed.style.animation = 'vi-ledblink 2.2s ease-in-out infinite';
  svg.appendChild(lockedLed);

  const scannerBtn = svgEl<SVGCircleElement>('circle');
  attr(scannerBtn, { cx: C, cy: C, r: 93, fill: 'transparent' });
  scannerBtn.style.cssText = 'cursor:pointer;pointer-events:all;';
  svg.appendChild(scannerBtn);

  root.appendChild(svg);
  return { root, svg, scannerRing, scannerGlow, padFill, fpPaths, statusText, boltPins, lockedLed, scannerBtn };
}

// ── Overlay ────────────────────────────────────────────────────────────────────

type OverlayRefs = DoorParts & {
  overlay: HTMLDivElement;
  scene: HTMLDivElement;
  interior: HTMLDivElement;
};

function buildOverlay(): OverlayRefs {
  injectStyles();

  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position:fixed;inset:0;
    background:#07090c;
    z-index:9999;
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    font-family:"SF Pro Display",-apple-system,BlinkMacSystemFont,sans-serif;
    overflow:hidden;
    animation:vi-fadein 1.1s cubic-bezier(0.16,1,0.3,1) both;
  `;

  // Vault room environment canvas — concrete walls, overhead light, static frame
  const roomCanvas = document.createElement('canvas');
  drawVaultRoom(roomCanvas);
  overlay.appendChild(roomCanvas);

  // Scene container — 3D perspective parent for the rotating door
  const scene = document.createElement('div');
  scene.style.cssText = `
    position:relative;
    width:min(520px,78vmin);
    height:min(520px,78vmin);
    flex-shrink:0;
    perspective:1400px;
  `;

  // Interior vault light — warm amber, revealed as door swings open
  const interior = document.createElement('div');
  interior.style.cssText = `
    position:absolute;
    top:0;left:0;right:0;bottom:0;
    border-radius:50%;
    background:radial-gradient(circle at 42% 38%,
      rgba(255,238,200,1.0) 0%,
      rgba(250,215,148,0.88) 12%,
      rgba(220,172,88,0.66) 28%,
      rgba(168,118,42,0.36) 48%,
      rgba(95,60,15,0.10)   65%,
      rgba(0,0,0,0)         78%
    );
    opacity:0;
    pointer-events:none;
    z-index:0;
  `;

  const parts = buildDoor();
  parts.root.style.cssText = `
    position:absolute;
    top:0;left:0;right:0;bottom:0;
    z-index:1;
  `;

  scene.appendChild(interior);
  scene.appendChild(parts.root);

  const quit = document.createElement('button');
  quit.textContent = 'Quit';
  quit.style.cssText = `
    position:absolute;bottom:28px;
    background:none;border:none;
    font-size:12px;font-weight:500;letter-spacing:.08em;
    color:rgba(120,140,160,0.35);cursor:pointer;padding:6px 14px;
    transition:color .2s;
  `;
  quit.addEventListener('mouseenter', () => { quit.style.color = 'rgba(180,200,220,0.65)'; });
  quit.addEventListener('mouseleave', () => { quit.style.color = 'rgba(120,140,160,0.35)'; });

  overlay.appendChild(scene);
  overlay.appendChild(quit);

  return { ...parts, overlay, scene, interior };
}

// ── Scanner states ─────────────────────────────────────────────────────────────

function setScannerIdle(p: DoorParts): void {
  p.scannerRing.style.animation = 'vi-scan 2.8s ease-in-out infinite';
  p.scannerGlow.style.animation = 'vi-glow 2.8s ease-in-out infinite';
  p.scannerRing.style.transition = '';
  p.scannerGlow.style.transition = '';
  p.scannerRing.style.opacity = '';
  p.scannerRing.style.strokeWidth = '';
  p.scannerRing.setAttribute('stroke', '#8b1818');
  p.scannerGlow.setAttribute('stroke', '#5c0c0c');
  for (const fp of p.fpPaths) fp.setAttribute('stroke', '#7a2020');
  p.padFill.setAttribute('fill', 'transparent');
  p.statusText.setAttribute('fill', 'rgba(170,70,70,0.7)');
  p.statusText.textContent = 'TAP TO RETRY';
  p.scannerBtn.style.cursor = 'pointer';
  p.scannerBtn.onmouseenter = null;
  p.scannerBtn.onmouseleave = null;
}

function setScannerWarmup(p: DoorParts): void {
  p.scannerRing.style.animation = 'vi-warmup 0.85s ease-in-out infinite';
  p.scannerGlow.style.animation = 'vi-glowwarm 0.85s ease-in-out infinite';
  p.scannerRing.setAttribute('stroke', '#c02828');
  p.scannerGlow.setAttribute('stroke', '#8f1515');
  p.padFill.setAttribute('fill', 'transparent');
  p.statusText.setAttribute('fill', 'rgba(210,90,90,0.85)');
  p.statusText.textContent = 'SCANNING…';
}

function setScannerPeak(p: DoorParts): void {
  p.scannerRing.style.transition = 'stroke-width 0.25s ease, opacity 0.25s ease';
  p.scannerGlow.style.transition = 'opacity 0.25s ease';
  p.scannerRing.style.animation = 'none';
  p.scannerGlow.style.animation = 'none';
  p.scannerRing.style.opacity = '1';
  p.scannerRing.style.strokeWidth = '2px';
  p.scannerGlow.style.opacity = '0.60';
  p.scannerRing.setAttribute('stroke', '#e03030');
  p.scannerGlow.setAttribute('stroke', '#b81c1c');
  for (const fp of p.fpPaths) fp.setAttribute('stroke', '#cc4040');
  p.padFill.setAttribute('fill', 'transparent');
  p.statusText.setAttribute('fill', 'rgba(240,130,130,0.95)');
  p.statusText.textContent = 'PLACE FINGER ON SENSOR';
}

function setScannerError(p: DoorParts, msg: string): void {
  p.scannerRing.style.transition = '';
  p.scannerGlow.style.transition = '';
  p.scannerRing.style.opacity = '';
  p.scannerRing.style.strokeWidth = '';
  p.scannerRing.style.animation = 'vi-scanerr 1.6s ease-in-out infinite';
  p.scannerGlow.style.animation = 'vi-scanerr 1.6s ease-in-out infinite';
  p.scannerRing.setAttribute('stroke', '#b83030');
  p.scannerGlow.setAttribute('stroke', '#9e1818');
  p.padFill.setAttribute('fill', 'rgba(160,24,24,0.09)');
  for (const fp of p.fpPaths) fp.setAttribute('stroke', '#a83030');
  p.statusText.setAttribute('fill', 'rgba(200,80,80,0.85)');
  p.statusText.textContent = msg;
  p.padFill.style.animation = 'vi-shake .4s ease both';
  setTimeout(() => { p.padFill.style.animation = ''; }, 400);
}

function setScannerSuccess(p: DoorParts): void {
  p.scannerRing.style.animation = '';
  p.scannerGlow.style.animation = '';
  p.scannerRing.style.transition = '';
  p.scannerGlow.style.transition = '';
  p.scannerRing.style.opacity = '';
  p.scannerRing.style.strokeWidth = '';
  p.scannerRing.setAttribute('stroke', '#1ea854');
  p.scannerGlow.setAttribute('stroke', '#18903e');
  p.padFill.setAttribute('fill', 'rgba(30,180,80,0.10)');
  for (const fp of p.fpPaths) fp.setAttribute('stroke', '#28c860');
  p.statusText.setAttribute('fill', 'rgba(40,200,100,0.9)');
  p.statusText.textContent = 'ACCESS GRANTED';
  p.lockedLed.style.animation = '';
  p.lockedLed.setAttribute('fill', '#1a8a3e');
  p.lockedLed.setAttribute('stroke', '#0e5a24');
}

// ── Open animation ─────────────────────────────────────────────────────────────

async function playOpenSequence(
  p: OverlayRefs,
  appReady?: Promise<void>,
): Promise<void> {
  setScannerSuccess(p);
  await sleep(400);

  const ctx = newCtx();
  if (ctx) {
    playMotorWhine(ctx);
    playBoltRetracts(ctx);
  }

  p.boltPins.forEach((pin, i) => {
    pin.style.animation = `vi-bolt-retract .32s cubic-bezier(0.5,0,1,0.8) ${i * 0.06}s both`;
  });
  await sleep(840);

  if (appReady) {
    p.statusText.textContent = 'INITIALIZING…';
    p.statusText.setAttribute('fill', 'rgba(40,200,100,0.55)');
    await Promise.race([appReady, sleep(2500)]);
    p.statusText.textContent = 'READY';
    await sleep(200);
  }

  // Pressure seal releases — micro-jitter before the door mass starts moving
  p.scene.style.animation = 'vi-seal-jitter .34s ease both';
  if (ctx) playDoorOpen(ctx);
  await sleep(380);
  p.scene.style.animation = '';
  await sleep(80);

  // Interior vault light floods through the opening
  Object.assign(p.interior.style, {
    transition: 'opacity 2.2s ease 0.15s',
    opacity: '1',
  });

  // Door swings on left hinges — right edge comes toward viewer (opens outward)
  // Perspective from scene parent gives correct foreshortening against the static frame
  Object.assign(p.root.style, {
    transition: 'transform 3.2s cubic-bezier(0.45, 0, 0.25, 1)',
    transformOrigin: 'left center',
    transform: 'rotateY(82deg)',
  });
  await sleep(900);

  // Camera dollies forward into the opening while overlay fades
  p.overlay.style.animation = 'none';
  Object.assign(p.overlay.style, {
    transition: 'transform 3.0s cubic-bezier(0.2,0,0.4,1), opacity 2.0s ease 0.1s',
    transform: 'scale(1.06)',
    opacity: '0',
  });
  await sleep(2200);
}

// ── Biometric flow ─────────────────────────────────────────────────────────────

async function runBiometricFlow(
  refs: OverlayRefs,
  onQuit: () => void,
  appReady?: Promise<void>,
): Promise<boolean> {
  const quitBtn = refs.overlay.querySelector('button')!;

  let settled = false;
  let inFlight = false;
  let resolveFlow!: (v: boolean) => void;
  const result = new Promise<boolean>(res => { resolveFlow = res; });

  quitBtn.addEventListener('click', () => {
    if (settled) return;
    settled = true;
    resolveFlow(false);
    onQuit();
  });

  const tryAuth = async (manual: boolean) => {
    if (settled || inFlight) return;
    inFlight = true;

    const ready = await waitForBridge();
    if (!ready || settled) { inFlight = false; return; }

    if (!manual) {
      setScannerWarmup(refs);
      await sleep(700);
      if (settled) return;
    }

    setScannerPeak(refs);
    await sleep(600);
    if (settled) return;

    try {
      await invokeTauri<void>(CMD, { reason: REASON, options: { allowDeviceCredential: true } });
      if (settled) return;
      settled = true;
      await playOpenSequence(refs, appReady);
      resolveFlow(true);
    } catch (err) {
      if (settled) return;
      inFlight = false;
      const msg = err instanceof Error ? err.message : '';
      const text = msg.toLowerCase().includes('cancel') ? 'CANCELLED — TAP TO RETRY' : 'TAP TO RETRY';
      setScannerError(refs, text);
      setTimeout(() => { if (!settled) setScannerIdle(refs); }, 1400);
    }
  };

  setTimeout(() => void tryAuth(false), 1200);
  refs.scannerBtn.addEventListener('click', () => void tryAuth(true));

  return result;
}

// ── Export ─────────────────────────────────────────────────────────────────────

export async function runVaultIntro(appReady?: Promise<void>): Promise<boolean> {
  const refs = buildOverlay();
  document.body.appendChild(refs.overlay);

  let quitCalled = false;
  const unlocked = await runBiometricFlow(refs, () => { quitCalled = true; }, appReady);

  refs.overlay.remove();
  if (quitCalled) window.close();
  return unlocked;
}
