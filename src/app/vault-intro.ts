// Single-window biometric vault door.
// Calls the Tauri biometric plugin directly — no secondary overlay, one fingerprint prompt.
// Door surface rendered via Canvas 2D for photorealistic brushed steel.

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
    @keyframes vi-scan     { 0%,100%{opacity:.35;stroke-width:1.5px} 50%{opacity:.9;stroke-width:2px} }
    @keyframes vi-warmup   { 0%,100%{opacity:.6;stroke-width:1.8px} 50%{opacity:1;stroke-width:2.5px} }
    @keyframes vi-glow     { 0%,100%{opacity:0} 50%{opacity:.55} }
    @keyframes vi-glowwarm { 0%,100%{opacity:.3} 50%{opacity:.85} }
    @keyframes vi-scanerr  { 0%,100%{opacity:.5;stroke-width:1.5px} 50%{opacity:1;stroke-width:2px} }
    @keyframes vi-shake    { 0%,100%{transform:translateX(0)} 20%{transform:translateX(-4px)} 40%{transform:translateX(4px)} 60%{transform:translateX(-3px)} 80%{transform:translateX(3px)} }
    @keyframes vi-bolt     { 0%{transform:translateY(0);opacity:1} 100%{transform:translateY(22px);opacity:0} }
    @keyframes vi-ledblink { 0%,100%{opacity:1} 50%{opacity:.2} }
  `;
  document.head.appendChild(s);
}

// ── Canvas door surface ────────────────────────────────────────────────────────

function drawDoorCanvas(canvas: HTMLCanvasElement): void {
  const L = 500; // logical size
  const SCALE = 2; // render 2× for HiDPI
  canvas.width = L * SCALE;
  canvas.height = L * SCALE;
  canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;display:block;';
  const ctx = canvas.getContext('2d')!;
  ctx.scale(SCALE, SCALE);
  const C = L / 2; // 250

  // Horizontal brushed grain — hundreds of semi-transparent micro-strokes
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

  // Rounded rect path helper
  const rrect = (x: number, y: number, w: number, h: number, r: number) => {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  };

  const rF = lcg(11);  // frame
  const rD = lcg(22);  // door face
  const rSc = lcg(77); // character scratches

  // ── 1. Cast shadow ────────────────────────────────────────────────────────
  ctx.save();
  ctx.filter = 'blur(40px)';
  ctx.fillStyle = 'rgba(0,0,0,0.92)';
  ctx.beginPath(); ctx.ellipse(C, C + 24, 236, 215, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // ── 2. Frame ring ─────────────────────────────────────────────────────────
  ctx.save();
  ctx.beginPath();
  ctx.arc(C, C, 249, 0, Math.PI * 2);
  ctx.arc(C, C, 204, 0, Math.PI * 2, true);
  ctx.clip('evenodd');

  {
    const g = ctx.createRadialGradient(C - 74, C - 64, 0, C + 10, C + 15, 256);
    g.addColorStop(0, '#1a1c22'); g.addColorStop(0.55, '#0f1013'); g.addColorStop(1, '#040506');
    ctx.fillStyle = g; ctx.fillRect(0, 0, L, L);
  }
  grain(220, 0, L, C - 249, C + 249, rF, [30, 32, 38]);

  // Subtle specular on frame — upper-left only
  {
    const g = ctx.createRadialGradient(C - 145, C - 105, 0, C - 145, C - 105, 145);
    g.addColorStop(0, 'rgba(255,255,255,0.030)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, L, L);
  }

  // Inner AO — shadow at door/frame interface
  ctx.save();
  ctx.filter = 'blur(11px)';
  ctx.strokeStyle = 'rgba(0,0,0,1)'; ctx.lineWidth = 22;
  ctx.beginPath(); ctx.arc(C, C + 4, 207, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();

  // Frame bevels
  ctx.strokeStyle = 'rgba(255,255,255,0.090)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(C, C, 248, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.60)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(C + 2, C + 2, 248, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();

  // ── 3. Machined seam ───────────────────────────────────────────────────────
  ctx.strokeStyle = '#020203'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(C, C, 204, 0, Math.PI * 2); ctx.stroke();

  // ── 4. Bolt housings (sockets — pins are SVG overlay) ─────────────────────
  for (let i = 0; i < 8; i++) {
    ctx.save();
    ctx.translate(C, C); ctx.rotate(i * Math.PI / 4); ctx.translate(-C, -C);
    ctx.beginPath(); rrect(C - 10, 4, 20, 48, 5);
    ctx.fillStyle = '#030405'; ctx.fill();
    ctx.strokeStyle = '#0b0c0f'; ctx.lineWidth = 1; ctx.stroke();
    // Deep top shadow — bolt end vanishes into dark
    ctx.save();
    ctx.filter = 'blur(5px)';
    ctx.fillStyle = 'rgba(0,0,0,1)'; ctx.fillRect(C - 9, 4, 18, 18);
    ctx.restore();
    ctx.restore();
  }

  // ── 5. Door face ──────────────────────────────────────────────────────────
  ctx.save();
  ctx.beginPath(); ctx.arc(C, C, 201, 0, Math.PI * 2); ctx.clip();

  // Base: strongly directional gradient — lit upper-left, deep shadow lower-right
  {
    const g = ctx.createRadialGradient(C - 72, C - 60, 0, C + 22, C + 28, 232);
    g.addColorStop(0,    '#575f6c');
    g.addColorStop(0.14, '#404852');
    g.addColorStop(0.40, '#2a2d34');
    g.addColorStop(0.70, '#1e2026');
    g.addColorStop(1,    '#121418');
    ctx.fillStyle = g; ctx.fillRect(0, 0, L, L);
  }

  // Dense brushed steel grain — the core of the realism
  grain(660, 0, L, C - 201, C + 201, rD, [190, 197, 205]);

  // Surface character: longer heavier scratches from manufacturing / use
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

  // Wide soft specular — screen blend gives a natural, non-painted look
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  {
    const g = ctx.createRadialGradient(C - 66, C - 72, 0, C - 32, C - 40, 112);
    g.addColorStop(0, 'rgba(255,255,255,0.072)');
    g.addColorStop(0.42, 'rgba(255,255,255,0.028)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, L, L);
  }
  // Tight hotspot — sharp point light reflection
  {
    const g = ctx.createRadialGradient(C - 82, C - 86, 0, C - 82, C - 86, 40);
    g.addColorStop(0, 'rgba(255,255,255,0.115)');
    g.addColorStop(0.28, 'rgba(255,255,255,0.044)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, L, L);
  }
  ctx.restore();

  // Door edge bevels
  ctx.strokeStyle = 'rgba(255,255,255,0.145)'; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.arc(C, C, 199, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.74)'; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.arc(C + 3, C + 3, 197, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();

  // ── 6. Outer machined groove ──────────────────────────────────────────────
  ctx.save(); ctx.filter = 'blur(8px)';
  ctx.strokeStyle = 'rgba(0,0,0,0.88)'; ctx.lineWidth = 20;
  ctx.beginPath(); ctx.arc(C, C + 4, 172, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
  ctx.strokeStyle = '#030406'; ctx.lineWidth = 9;
  ctx.beginPath(); ctx.arc(C, C, 172, 0, Math.PI * 2); ctx.stroke();
  // Lit inner wall (upper-left) — linear gradient approximates directional lighting
  {
    const g = ctx.createLinearGradient(0, 0, L, L);
    g.addColorStop(0, 'rgba(255,255,255,0.10)'); g.addColorStop(0.5, 'rgba(255,255,255,0.035)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.strokeStyle = g; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(C - 1, C - 1, 177, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.58)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(C + 1, C + 1, 167, 0, Math.PI * 2); ctx.stroke();

  // ── 7. Inner machined groove ──────────────────────────────────────────────
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

  // ── 8. Machined rivets ────────────────────────────────────────────────────
  for (const deg of [22.5, 67.5, 112.5, 157.5, 202.5, 247.5, 292.5, 337.5]) {
    const rad = deg * Math.PI / 180;
    const rx = C + Math.cos(rad) * 149;
    const ry = C + Math.sin(rad) * 149;

    // Contact shadow
    ctx.save(); ctx.filter = 'blur(5px)';
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.beginPath(); ctx.arc(rx, ry, 10, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // Body — dark machined hemisphere
    {
      const g = ctx.createRadialGradient(rx - 2, ry - 2.5, 0, rx, ry, 6.5);
      g.addColorStop(0, '#222429'); g.addColorStop(1, '#090a0e');
      ctx.fillStyle = g;
    }
    ctx.beginPath(); ctx.arc(rx, ry, 6.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#0c0d11'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(rx, ry, 6.5, 0, Math.PI * 2); ctx.stroke();

    // Hemisphere specular highlight — Phong from upper-left
    ctx.save(); ctx.beginPath(); ctx.arc(rx, ry, 6.5, 0, Math.PI * 2); ctx.clip();
    {
      const g = ctx.createRadialGradient(rx - 2.6, ry - 2.9, 0, rx, ry, 7);
      g.addColorStop(0, 'rgba(255,255,255,0.42)');
      g.addColorStop(0.32, 'rgba(255,255,255,0.14)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.fillRect(rx - 7, ry - 7, 14, 14);
    }
    ctx.restore();

    // Center dimple
    ctx.fillStyle = '#0d0e12';
    ctx.beginPath(); ctx.arc(rx, ry, 2, 0, Math.PI * 2); ctx.fill();
  }

  // ── 9. Scanner housing — deeply recessed ──────────────────────────────────
  // Strong AO around the recess
  ctx.save(); ctx.filter = 'blur(14px)';
  ctx.strokeStyle = 'rgba(0,0,0,1)'; ctx.lineWidth = 30;
  ctx.beginPath(); ctx.arc(C, C + 6, 95, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
  // Housing fill
  ctx.fillStyle = '#030405';
  ctx.beginPath(); ctx.arc(C, C, 93, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#090a0c'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(C, C, 93, 0, Math.PI * 2); ctx.stroke();
  // Housing bevel
  ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(C - 1, C - 1, 92, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.62)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(C + 1, C + 1, 92, 0, Math.PI * 2); ctx.stroke();

  // ── 10. Scanner glass pad ─────────────────────────────────────────────────
  ctx.save(); ctx.beginPath(); ctx.arc(C, C, 83, 0, Math.PI * 2); ctx.clip();

  // Near-black hardened glass — very slight blue-tint in the light areas
  {
    const g = ctx.createRadialGradient(C - 22, C - 27, 0, C + 12, C + 15, 90);
    g.addColorStop(0, '#0d1015'); g.addColorStop(0.5, '#07090d'); g.addColorStop(1, '#030508');
    ctx.fillStyle = g; ctx.fillRect(C - 86, C - 86, 172, 172);
  }

  // Wide glass reflection — diffuse bounce of the overhead light
  {
    const g = ctx.createRadialGradient(C - 18, C - 29, 0, C - 18, C - 29, 42);
    g.addColorStop(0, 'rgba(255,255,255,0.115)');
    g.addColorStop(0.48, 'rgba(255,255,255,0.042)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(C - 65, C - 76, 88, 66);
  }
  // Tight sharp specular on glass
  {
    const g = ctx.createRadialGradient(C - 26, C - 37, 0, C - 24, C - 35, 16);
    g.addColorStop(0, 'rgba(255,255,255,0.22)');
    g.addColorStop(0.38, 'rgba(255,255,255,0.08)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(C - 50, C - 62, 54, 42);
  }
  ctx.restore();

  // ── 11. Logo — micro-etched into steel ────────────────────────────────────
  ctx.save();
  ctx.font = '700 9.5px "SF Pro Display", -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(135,145,160,0.18)';
  ctx.fillText('WORLD  MONITOR', C, C - 128);
  ctx.restore();
}

// ── SVG door ───────────────────────────────────────────────────────────────────

type DoorParts = {
  root: HTMLDivElement;    // Container: canvas + SVG overlay
  svg: SVGSVGElement;      // Transparent SVG overlay for animated elements
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

  // Container — canvas + SVG overlay stack
  const root = document.createElement('div');
  root.style.cssText = 'position:relative;width:min(520px,78vmin);height:min(520px,78vmin);flex-shrink:0;';

  // ── Canvas: photorealistic static surface ─────────────────────────────────
  const canvas = document.createElement('canvas');
  drawDoorCanvas(canvas);
  root.appendChild(canvas);

  // ── SVG overlay: animated / interactive elements only ─────────────────────
  const svg = svgEl<SVGSVGElement>('svg');
  attr(svg, { viewBox: `0 0 ${V} ${V}` });
  svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;overflow:visible;pointer-events:none;';

  // Minimal defs: bolt gradient, scanner bloom, pin grain
  const defs = svgEl('defs');

  const bg = svgEl<SVGLinearGradientElement>('linearGradient');
  attr(bg, { id: 'vi-bg', x1: '0%', y1: '0%', x2: '100%', y2: '0%' });
  for (const [off, col] of [
    ['0%','#636970'],['20%','#4c5258'],['55%','#2e3138'],['100%','#1a1b20'],
  ] as const) {
    const s = svgEl<SVGStopElement>('stop'); attr(s, { offset: off, 'stop-color': col }); bg.appendChild(s);
  }

  const gf = svgEl<SVGFilterElement>('filter');
  attr(gf, { id: 'vi-glow', x: '-60%', y: '-60%', width: '220%', height: '220%' });
  const gb = svgEl('feGaussianBlur'); attr(gb, { stdDeviation: '7', result: 'blur' });
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

  // ── Bolt pins (animated on retraction) ───────────────────────────────────
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

  // ── Scanner glow (animated) ───────────────────────────────────────────────
  const scannerGlow = svgEl<SVGCircleElement>('circle');
  attr(scannerGlow, { cx: C, cy: C, r: 85, fill: 'none', stroke: '#1a70f0', 'stroke-width': 14 });
  scannerGlow.style.cssText = 'filter:url(#vi-glow);animation:vi-glow 2.8s ease-in-out infinite;';
  svg.appendChild(scannerGlow);

  const scannerRing = svgEl<SVGCircleElement>('circle');
  attr(scannerRing, { cx: C, cy: C, r: 84, fill: 'none', stroke: '#2a82f8', 'stroke-width': 1.5 });
  scannerRing.style.animation = 'vi-scan 2.8s ease-in-out infinite';
  svg.appendChild(scannerRing);

  // ── Scanner pad fill — transparent by default, canvas glass shows through ──
  const padFill = svgEl<SVGCircleElement>('circle');
  attr(padFill, { cx: C, cy: C, r: 83, fill: 'transparent' });
  svg.appendChild(padFill);

  // ── Fingerprint ridges ────────────────────────────────────────────────────
  const fpG = svgEl<SVGGElement>('g');
  fpG.setAttribute('transform', `translate(${C - 24}, ${C - 28})`);
  fpG.setAttribute('opacity', '0.5');
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
    attr(p, { d, stroke: '#2272c0', 'stroke-width': '1.2', fill: 'none', 'stroke-linecap': 'round' });
    fpG.appendChild(p); fpPaths.push(p);
  }
  svg.appendChild(fpG);

  // ── Status text ───────────────────────────────────────────────────────────
  const statusText = svgEl<SVGTextElement>('text');
  attr(statusText, {
    x: C, y: C + 70,
    'text-anchor': 'middle',
    'font-family': '"SF Pro Display", -apple-system, BlinkMacSystemFont, sans-serif',
    'font-size': '10', 'font-weight': '500', 'letter-spacing': '0.2em',
    fill: 'rgba(150,165,185,0.6)',
  });
  statusText.textContent = 'BIOMETRIC SCAN READY';
  svg.appendChild(statusText);

  // ── Status LED ────────────────────────────────────────────────────────────
  const ledGlow = svgEl<SVGCircleElement>('circle');
  attr(ledGlow, { cx: C, cy: C + 160, r: 9, fill: 'rgba(200,28,28,0.16)' });
  svg.appendChild(ledGlow);
  const lockedLed = svgEl<SVGCircleElement>('circle');
  attr(lockedLed, { cx: C, cy: C + 160, r: 3.5, fill: '#cc2020', stroke: '#6a0e0e', 'stroke-width': 1 });
  lockedLed.style.animation = 'vi-ledblink 2.2s ease-in-out infinite';
  svg.appendChild(lockedLed);

  // ── Tap target ────────────────────────────────────────────────────────────
  const scannerBtn = svgEl<SVGCircleElement>('circle');
  attr(scannerBtn, { cx: C, cy: C, r: 93, fill: 'transparent' });
  scannerBtn.style.cssText = 'cursor:pointer;pointer-events:all;';
  svg.appendChild(scannerBtn);

  root.appendChild(svg);
  return { root, svg, scannerRing, scannerGlow, padFill, fpPaths, statusText, boltPins, lockedLed, scannerBtn };
}

// ── Overlay ────────────────────────────────────────────────────────────────────

type OverlayRefs = DoorParts & { overlay: HTMLDivElement };

function buildOverlay(): OverlayRefs {
  injectStyles();

  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position:fixed;inset:0;
    background:radial-gradient(ellipse at 50% 44%, #0f1318 0%, #06080b 65%);
    z-index:9999;
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    font-family:"SF Pro Display",-apple-system,BlinkMacSystemFont,sans-serif;
    overflow:hidden;
    animation:vi-fadein 1.1s cubic-bezier(0.16,1,0.3,1) both;
  `;

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

  const parts = buildDoor();
  overlay.appendChild(parts.root);
  overlay.appendChild(quit);

  return { ...parts, overlay };
}

// ── Scanner states ─────────────────────────────────────────────────────────────

function setScannerIdle(p: DoorParts): void {
  p.scannerRing.style.animation = 'vi-scan 2.8s ease-in-out infinite';
  p.scannerGlow.style.animation = 'vi-glow 2.8s ease-in-out infinite';
  p.scannerRing.style.transition = '';
  p.scannerGlow.style.transition = '';
  p.scannerRing.style.opacity = '';
  p.scannerRing.style.strokeWidth = '';
  p.scannerRing.setAttribute('stroke', '#1e6ab8');
  p.scannerGlow.setAttribute('stroke', '#1a5a9e');
  for (const fp of p.fpPaths) fp.setAttribute('stroke', '#3080b8');
  p.padFill.setAttribute('fill', 'transparent');
  p.statusText.setAttribute('fill', 'rgba(100,148,200,0.7)');
  p.statusText.textContent = 'TAP TO RETRY';
  p.scannerBtn.style.cursor = 'pointer';
  p.scannerBtn.onmouseenter = null;
  p.scannerBtn.onmouseleave = null;
}

function setScannerWarmup(p: DoorParts): void {
  p.scannerRing.style.animation = 'vi-warmup 0.85s ease-in-out infinite';
  p.scannerGlow.style.animation = 'vi-glowwarm 0.85s ease-in-out infinite';
  p.scannerRing.setAttribute('stroke', '#2a88e0');
  p.scannerGlow.setAttribute('stroke', '#2272c8');
  p.padFill.setAttribute('fill', 'transparent');
  p.statusText.setAttribute('fill', 'rgba(130,175,230,0.85)');
  p.statusText.textContent = 'SCANNING…';
}

// Full-stop peak state — animations halt, scanner holds at max brightness.
// Touch ID fires from this still moment so the system dialog doesn't feel like an interruption.
function setScannerPeak(p: DoorParts): void {
  p.scannerRing.style.transition = 'stroke-width 0.25s ease, opacity 0.25s ease';
  p.scannerGlow.style.transition = 'opacity 0.25s ease';
  p.scannerRing.style.animation = 'none';
  p.scannerGlow.style.animation = 'none';
  p.scannerRing.style.opacity = '1';
  p.scannerRing.style.strokeWidth = '2.5px';
  p.scannerGlow.style.opacity = '0.72';
  p.scannerRing.setAttribute('stroke', '#4aa8ff');
  p.scannerGlow.setAttribute('stroke', '#2a88e8');
  for (const fp of p.fpPaths) fp.setAttribute('stroke', '#4aa8d0');
  p.padFill.setAttribute('fill', 'transparent');
  p.statusText.setAttribute('fill', 'rgba(160,200,255,0.95)');
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
  p: DoorParts & { overlay: HTMLDivElement },
  appReady?: Promise<void>,
): Promise<void> {
  setScannerSuccess(p);
  await sleep(500);

  const ctx = newCtx();
  if (ctx) {
    playMotorWhine(ctx);
    playBoltRetracts(ctx);
  }

  p.boltPins.forEach((pin, i) => {
    pin.style.animation = `vi-bolt .34s ease-in ${i * 0.08}s both`;
  });
  await sleep(900);

  // Wait for app panels to be ready (or give up after 3s)
  if (appReady) {
    p.statusText.textContent = 'INITIALIZING…';
    p.statusText.setAttribute('fill', 'rgba(40,200,100,0.55)');
    await Promise.race([appReady, sleep(3000)]);
    p.statusText.textContent = 'READY';
    await sleep(180);
  }

  if (ctx) playDoorOpen(ctx);

  // Door swings open — slow, heavy, deliberate
  Object.assign(p.root.style, {
    transition: 'transform 2.4s cubic-bezier(0.4,0,0.12,1), opacity 2.0s ease 0.3s',
    transformOrigin: 'right center',
    transform: 'perspective(1100px) rotateY(-90deg)',
    opacity: '0',
  });
  await sleep(600);

  p.overlay.style.transition = 'opacity 1.8s ease';
  p.overlay.style.opacity = '0';
  await sleep(2000);
}

// ── Biometric flow ─────────────────────────────────────────────────────────────

async function runBiometricFlow(
  refs: DoorParts & { overlay: HTMLDivElement },
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

    // Peak lock — animations halt so Touch ID dialog appears against a still screen
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
