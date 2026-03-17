// Single-window biometric vault door.
// Calls the Tauri biometric plugin directly — no secondary overlay, one fingerprint prompt.

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

// ── Audio ──────────────────────────────────────────────────────────────────────

function newCtx(): AudioContext | null {
  try { return new AudioContext(); } catch { return null; }
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

  // Pressure hiss (bandpass noise, sweeping 1600 → 280 Hz)
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

  // Low mechanism rumble
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

  // Whoosh sweep
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
    @keyframes vi-glow     { 0%,100%{opacity:0} 50%{opacity:.55} }
    @keyframes vi-scanerr  { 0%,100%{opacity:.5;stroke-width:1.5px} 50%{opacity:1;stroke-width:2px} }
    @keyframes vi-shake    { 0%,100%{transform:translateX(0)} 20%{transform:translateX(-4px)} 40%{transform:translateX(4px)} 60%{transform:translateX(-3px)} 80%{transform:translateX(3px)} }
    @keyframes vi-bolt     { 0%{transform:translateY(0);opacity:1} 100%{transform:translateY(22px);opacity:0} }
    @keyframes vi-ledblink { 0%,100%{opacity:1} 50%{opacity:.2} }
  `;
  document.head.appendChild(s);
}

// ── SVG door ───────────────────────────────────────────────────────────────────

type DoorParts = {
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

  const svg = svgEl<SVGSVGElement>('svg');
  attr(svg, { viewBox: `0 0 ${V} ${V}`, width: V, height: V });
  svg.style.cssText = 'width:min(520px,78vmin);height:min(520px,78vmin);overflow:visible;display:block;';

  // ── Defs ──────────────────────────────────────────────────────────────────
  const defs = svgEl('defs');

  // Door body gradient — bright upper-left corner, dark lower-right
  const dg = svgEl<SVGRadialGradientElement>('radialGradient');
  attr(dg, { id: 'vi-dg', cx: '34%', cy: '30%', r: '70%' });
  for (const [off, col] of [['0%','#2e3a4e'],['38%','#1a2232'],['75%','#111826'],['100%','#0c1018']] as const) {
    const s = svgEl<SVGStopElement>('stop'); attr(s, { offset: off, 'stop-color': col }); dg.appendChild(s);
  }

  // Frame gradient — darker than door
  const fg = svgEl<SVGRadialGradientElement>('radialGradient');
  attr(fg, { id: 'vi-fg', cx: '38%', cy: '33%', r: '66%' });
  for (const [off, col] of [['0%','#1e2430'],['100%','#080b10']] as const) {
    const s = svgEl<SVGStopElement>('stop'); attr(s, { offset: off, 'stop-color': col }); fg.appendChild(s);
  }

  // Scanner pad gradient — near-black with faint deep-blue center
  const sg = svgEl<SVGRadialGradientElement>('radialGradient');
  attr(sg, { id: 'vi-sg', cx: '42%', cy: '38%', r: '60%' });
  for (const [off, col] of [['0%','#0e1824'],['60%','#080d14'],['100%','#050810']] as const) {
    const s = svgEl<SVGStopElement>('stop'); attr(s, { offset: off, 'stop-color': col }); sg.appendChild(s);
  }

  // Drop shadow for the whole door
  const shadow = svgEl<SVGFilterElement>('filter');
  attr(shadow, { id: 'vi-shadow', x: '-20%', y: '-20%', width: '140%', height: '140%' });
  const ds = svgEl('feDropShadow');
  attr(ds, { dx: '0', dy: '12', stdDeviation: '28', 'flood-color': '#000', 'flood-opacity': '0.85' });
  shadow.appendChild(ds);

  // Scanner glow filter
  const gf = svgEl<SVGFilterElement>('filter');
  attr(gf, { id: 'vi-glow', x: '-60%', y: '-60%', width: '220%', height: '220%' });
  const gb = svgEl('feGaussianBlur');
  attr(gb, { stdDeviation: '5', result: 'blur' });
  const gm = svgEl('feMerge');
  const gm1 = svgEl('feMergeNode'); attr(gm1, { in: 'blur' });
  const gm2 = svgEl('feMergeNode'); attr(gm2, { in: 'SourceGraphic' });
  gm.appendChild(gm1); gm.appendChild(gm2);
  gf.appendChild(gb); gf.appendChild(gm);

  // Clip path for door body
  const cp = svgEl('clipPath'); attr(cp, { id: 'vi-clip' });
  const cpc = svgEl<SVGCircleElement>('circle'); attr(cpc, { cx: C, cy: C, r: 197 }); cp.appendChild(cpc);

  defs.appendChild(dg); defs.appendChild(fg); defs.appendChild(sg);
  defs.appendChild(shadow); defs.appendChild(gf); defs.appendChild(cp);
  svg.appendChild(defs);

  // ── Outer atmosphere (drop shadow ring) ───────────────────────────────────
  const shadowRing = svgEl<SVGCircleElement>('circle');
  attr(shadowRing, { cx: C, cy: C, r: 248, fill: 'url(#vi-fg)', filter: 'url(#vi-shadow)' });
  svg.appendChild(shadowRing);

  // ── Frame ring ────────────────────────────────────────────────────────────
  const frame = svgEl<SVGCircleElement>('circle');
  attr(frame, { cx: C, cy: C, r: 246, fill: 'url(#vi-fg)', stroke: '#0a0d14', 'stroke-width': 3 });
  svg.appendChild(frame);

  // Frame outer edge highlight (upper-left arc)
  const frameHL = svgEl<SVGCircleElement>('circle');
  attr(frameHL, { cx: C, cy: C, r: 244, fill: 'none', stroke: 'rgba(255,255,255,0.04)', 'stroke-width': 2 });
  svg.appendChild(frameHL);

  // Frame inner bevel shadow
  const frameInnerShadow = svgEl<SVGCircleElement>('circle');
  attr(frameInnerShadow, { cx: C, cy: C + 4, r: 202, fill: 'none', stroke: 'rgba(0,0,0,0.7)', 'stroke-width': 8 });
  svg.appendChild(frameInnerShadow);

  // ── 8 locking bolt mechanisms ─────────────────────────────────────────────
  const boltPins: SVGGElement[] = [];
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * 360;
    const g = svgEl<SVGGElement>('g');
    g.setAttribute('transform', `rotate(${angle} ${C} ${C})`);

    // Bolt housing recess
    const housing = svgEl<SVGRectElement>('rect');
    attr(housing, { x: C - 9, y: 6, width: 18, height: 38, rx: 5,
      fill: '#0a0d12', stroke: '#181e2a', 'stroke-width': 1.5 });

    // Bolt pin
    const pinG = svgEl<SVGGElement>('g');
    const pin = svgEl<SVGRectElement>('rect');
    attr(pin, { x: C - 7, y: 9, width: 14, height: 28, rx: 4,
      fill: 'url(#vi-dg)', stroke: '#3a4e62', 'stroke-width': 1 });
    // Pin highlight
    const pinHL = svgEl<SVGRectElement>('rect');
    attr(pinHL, { x: C - 6, y: 10, width: 4, height: 24, rx: 2,
      fill: 'rgba(255,255,255,0.13)' });
    // Pin shadow
    const pinSh = svgEl<SVGRectElement>('rect');
    attr(pinSh, { x: C + 1, y: 10, width: 3, height: 24, rx: 2,
      fill: 'rgba(0,0,0,0.35)' });
    pinG.appendChild(pin); pinG.appendChild(pinHL); pinG.appendChild(pinSh);
    g.appendChild(housing); g.appendChild(pinG);
    svg.appendChild(g);
    boltPins.push(pinG);
  }

  // ── Door body ─────────────────────────────────────────────────────────────
  const door = svgEl<SVGCircleElement>('circle');
  attr(door, { cx: C, cy: C, r: 200, fill: 'url(#vi-dg)', stroke: '#1c2438', 'stroke-width': 3 });
  svg.appendChild(door);

  // Specular highlight — off-center bright patch (upper-left)
  const specHL = svgEl<SVGEllipseElement>('ellipse');
  attr(specHL, { cx: C - 55, cy: C - 60, rx: 90, ry: 70,
    fill: 'rgba(255,255,255,0.028)' });
  svg.appendChild(specHL);

  // Door face: outer panel ring (shallow groove at r≈170)
  const outerPanel = svgEl<SVGCircleElement>('circle');
  attr(outerPanel, { cx: C, cy: C + 1.5, r: 172, fill: 'none',
    stroke: '#0c1018', 'stroke-width': 6 });
  svg.appendChild(outerPanel);
  const outerPanelHL = svgEl<SVGCircleElement>('circle');
  attr(outerPanelHL, { cx: C, cy: C - 1, r: 171, fill: 'none',
    stroke: 'rgba(255,255,255,0.045)', 'stroke-width': 1.5 });
  svg.appendChild(outerPanelHL);

  // Inner panel ring (groove at r≈128)
  const innerPanel = svgEl<SVGCircleElement>('circle');
  attr(innerPanel, { cx: C, cy: C + 1, r: 128, fill: 'none',
    stroke: '#0c1018', 'stroke-width': 5 });
  svg.appendChild(innerPanel);
  const innerPanelHL = svgEl<SVGCircleElement>('circle');
  attr(innerPanelHL, { cx: C, cy: C - 1, r: 127, fill: 'none',
    stroke: 'rgba(255,255,255,0.04)', 'stroke-width': 1.5 });
  svg.appendChild(innerPanelHL);

  // 4 reinforcement rivets at panel groove
  for (const angle of [45, 135, 225, 315]) {
    const rad = angle * Math.PI / 180;
    const rx = C + Math.cos(rad) * 149;
    const ry = C + Math.sin(rad) * 149;
    const rv = svgEl<SVGCircleElement>('circle');
    attr(rv, { cx: rx, cy: ry, r: 5.5, fill: '#141c28', stroke: '#222e40', 'stroke-width': 1 });
    svg.appendChild(rv);
    const rvHL = svgEl<SVGCircleElement>('circle');
    attr(rvHL, { cx: rx - 1.5, cy: ry - 1.5, r: 1.8, fill: 'rgba(255,255,255,0.18)' });
    svg.appendChild(rvHL);
  }

  // ── Scanner housing (recessed) ────────────────────────────────────────────
  const scanHousing = svgEl<SVGCircleElement>('circle');
  attr(scanHousing, { cx: C, cy: C, r: 88, fill: '#070a10', stroke: '#0f1520', 'stroke-width': 3 });
  svg.appendChild(scanHousing);

  // Housing inner bevel shadow (depth illusion)
  const housingBevel = svgEl<SVGCircleElement>('circle');
  attr(housingBevel, { cx: C, cy: C + 3, r: 85, fill: 'none',
    stroke: 'rgba(0,0,0,0.7)', 'stroke-width': 6 });
  svg.appendChild(housingBevel);

  // Scanner pad (dark glass surface)
  const padFill = svgEl<SVGCircleElement>('circle');
  attr(padFill, { cx: C, cy: C, r: 78, fill: 'url(#vi-sg)' });
  svg.appendChild(padFill);

  // Scanner pad gloss — subtle top-arc sheen
  const padGloss = svgEl<SVGEllipseElement>('ellipse');
  attr(padGloss, { cx: C, cy: C - 22, rx: 46, ry: 26,
    fill: 'rgba(255,255,255,0.025)' });
  svg.appendChild(padGloss);

  // Scanner glow halo (behind ring, animated opacity)
  const scannerGlow = svgEl<SVGCircleElement>('circle');
  attr(scannerGlow, { cx: C, cy: C, r: 80, fill: 'none',
    stroke: '#1a5a9e', 'stroke-width': 10 });
  scannerGlow.style.cssText = 'filter:url(#vi-glow);animation:vi-glow 2.8s ease-in-out infinite;';
  svg.appendChild(scannerGlow);

  // Scanner ring (clean crisp ring, animated)
  const scannerRing = svgEl<SVGCircleElement>('circle');
  attr(scannerRing, { cx: C, cy: C, r: 79, fill: 'none',
    stroke: '#1e6ab8', 'stroke-width': 1.5 });
  scannerRing.style.animation = 'vi-scan 2.8s ease-in-out infinite';
  svg.appendChild(scannerRing);

  // ── Fingerprint ridges (detailed) ─────────────────────────────────────────
  const fpG = svgEl<SVGGElement>('g');
  fpG.setAttribute('transform', `translate(${C - 24}, ${C - 28})`);
  fpG.setAttribute('opacity', '0.6');

  const fpDefs: string[] = [
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
    attr(p, { d, stroke: '#3080b8', 'stroke-width': '1.3', fill: 'none', 'stroke-linecap': 'round' });
    fpG.appendChild(p);
    fpPaths.push(p);
  }
  svg.appendChild(fpG);

  // ── Status text (below fingerprint) ──────────────────────────────────────
  const statusText = svgEl<SVGTextElement>('text');
  attr(statusText, {
    x: C, y: C + 68,
    'text-anchor': 'middle',
    'font-family': '"SF Pro Display", -apple-system, BlinkMacSystemFont, sans-serif',
    'font-size': '11', 'font-weight': '500', 'letter-spacing': '0.18em',
    fill: 'rgba(100,148,200,0.7)',
  });
  statusText.textContent = 'TAP TO AUTHENTICATE';
  svg.appendChild(statusText);

  // ── Logo text (etched into door, above scanner) ───────────────────────────
  const logoText = svgEl<SVGTextElement>('text');
  attr(logoText, {
    x: C, y: C - 125,
    'text-anchor': 'middle',
    'font-family': '"SF Pro Display", -apple-system, BlinkMacSystemFont, sans-serif',
    'font-size': '11', 'font-weight': '700', 'letter-spacing': '0.3em',
    fill: 'rgba(180,200,224,0.28)',
  });
  logoText.textContent = 'WORLD  MONITOR';
  svg.appendChild(logoText);

  // ── Status LED (bottom of door face) ─────────────────────────────────────
  const lockedLed = svgEl<SVGCircleElement>('circle');
  attr(lockedLed, { cx: C, cy: C + 155, r: 4,
    fill: '#9e1c1c', stroke: '#5a0e0e', 'stroke-width': 1 });
  lockedLed.style.animation = 'vi-ledblink 2.2s ease-in-out infinite';
  // Glow behind LED
  const ledGlow = svgEl<SVGCircleElement>('circle');
  attr(ledGlow, { cx: C, cy: C + 155, r: 7, fill: 'rgba(158,28,28,0.22)' });
  svg.appendChild(ledGlow);
  svg.appendChild(lockedLed);

  // Transparent hit target over scanner — makes it a tap button
  const scannerBtn = svgEl<SVGCircleElement>('circle');
  attr(scannerBtn, { cx: C, cy: C, r: 90, fill: 'transparent' });
  scannerBtn.style.cursor = 'pointer';
  svg.appendChild(scannerBtn);

  return { svg, scannerRing, scannerGlow, padFill, fpPaths, statusText, boltPins, lockedLed, scannerBtn };
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

  // Quit link — very subtle, bottom of screen
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
  overlay.appendChild(parts.svg);
  overlay.appendChild(quit);

  return { ...parts, overlay };
}

// ── Scanner state ──────────────────────────────────────────────────────────────

function setScannerIdle(p: DoorParts): void {
  const setIdleColors = () => {
    p.scannerRing.setAttribute('stroke', '#1e6ab8');
    p.scannerGlow.setAttribute('stroke', '#1a5a9e');
    for (const fp of p.fpPaths) fp.setAttribute('stroke', '#3080b8');
  };

  p.scannerRing.style.animation = 'vi-scan 2.8s ease-in-out infinite';
  p.scannerGlow.style.animation = 'vi-glow 2.8s ease-in-out infinite';
  setIdleColors();
  p.padFill.setAttribute('fill', 'url(#vi-sg)');
  p.statusText.setAttribute('fill', 'rgba(100,148,200,0.7)');
  p.statusText.textContent = 'TAP TO AUTHENTICATE';
  p.scannerBtn.style.cursor = 'pointer';
  p.scannerBtn.onmouseenter = () => {
    if (p.statusText.textContent !== 'TAP TO AUTHENTICATE') return;
    p.scannerRing.setAttribute('stroke', '#3898e8');
    p.scannerGlow.setAttribute('stroke', '#2878cc');
    for (const fp of p.fpPaths) fp.setAttribute('stroke', '#4a9ad8');
  };
  p.scannerBtn.onmouseleave = () => {
    if (p.statusText.textContent !== 'TAP TO AUTHENTICATE') return;
    setIdleColors();
  };
}

function setScannerScanning(p: DoorParts): void {
  p.scannerRing.style.animation = 'vi-scan 1.2s ease-in-out infinite';
  p.scannerGlow.style.animation = 'vi-glow 1.2s ease-in-out infinite';
  p.statusText.textContent = 'SCANNING…';
}

function setScannerError(p: DoorParts, msg: string): void {
  p.scannerRing.style.animation = 'vi-scanerr 1.6s ease-in-out infinite';
  p.scannerGlow.style.animation = 'vi-scanerr 1.6s ease-in-out infinite';
  p.scannerRing.setAttribute('stroke', '#b83030');
  p.scannerGlow.setAttribute('stroke', '#9e1818');
  p.padFill.setAttribute('fill', '#0a0608');
  for (const fp of p.fpPaths) fp.setAttribute('stroke', '#a83030');
  p.statusText.setAttribute('fill', 'rgba(200,80,80,0.85)');
  p.statusText.textContent = msg;
  // Shake the scanner pad area
  p.padFill.style.animation = 'vi-shake .4s ease both';
  setTimeout(() => { p.padFill.style.animation = ''; }, 400);
}

function setScannerSuccess(p: DoorParts): void {
  p.scannerRing.style.animation = '';
  p.scannerGlow.style.animation = '';
  p.scannerRing.setAttribute('stroke', '#1ea854');
  p.scannerGlow.setAttribute('stroke', '#18903e');
  p.padFill.setAttribute('fill', '#060e0a');
  for (const fp of p.fpPaths) fp.setAttribute('stroke', '#28c860');
  p.statusText.setAttribute('fill', 'rgba(40,200,100,0.9)');
  p.statusText.textContent = 'ACCESS GRANTED';
  p.lockedLed.style.animation = '';
  p.lockedLed.setAttribute('fill', '#1a8a3e');
  p.lockedLed.setAttribute('stroke', '#0e5a24');
}

// ── Open animation ─────────────────────────────────────────────────────────────

async function playOpenSequence(p: DoorParts & { overlay: HTMLDivElement }): Promise<void> {
  setScannerSuccess(p);
  await sleep(500);

  const ctx = newCtx();
  if (ctx) {
    playBoltRetracts(ctx);
    setTimeout(() => playDoorOpen(ctx), 520);
  }

  // Retract bolts — staggered, unhurried
  p.boltPins.forEach((pin, i) => {
    pin.style.animation = `vi-bolt .34s ease-in ${i * 0.08}s both`;
  });
  await sleep(900);

  // Door swings open — slow, heavy, deliberate
  p.svg.style.cssText += `
    transition: transform 2.4s cubic-bezier(0.4,0,0.12,1), opacity 2.0s ease 0.3s;
    transform-origin: right center;
    transform: perspective(1100px) rotateY(-90deg);
    opacity: 0;
  `;
  await sleep(600);

  // Background fades after door starts moving
  p.overlay.style.transition = 'opacity 1.8s ease';
  p.overlay.style.opacity = '0';
  await sleep(2000);
}

// ── Biometric flow ─────────────────────────────────────────────────────────────

async function runBiometricFlow(
  refs: DoorParts & { overlay: HTMLDivElement },
  onQuit: () => void,
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

  const tryAuth = async () => {
    if (settled || inFlight) return;
    inFlight = true;

    const ready = await waitForBridge();
    if (!ready || settled) { inFlight = false; return; }

    setScannerScanning(refs);
    try {
      await invokeTauri<void>(CMD, { reason: REASON, options: { allowDeviceCredential: true } });
      if (settled) return;
      settled = true;
      await playOpenSequence(refs);
      resolveFlow(true);
    } catch (err) {
      if (settled) return;
      inFlight = false;
      const msg = err instanceof Error ? err.message : '';
      const text = msg.toLowerCase().includes('cancel') ? 'CANCELLED — TAP TO TRY AGAIN' : 'TRY AGAIN';
      setScannerError(refs, text);
      // Re-arm the tap handler after the shake settles
      setTimeout(() => { if (!settled) setScannerIdle(refs); }, 1200);
    }
  };

  // Scanner tap triggers Touch ID — user initiates, no auto-popup surprise
  refs.scannerBtn.addEventListener('click', () => void tryAuth());

  return result;
}

// ── Export ─────────────────────────────────────────────────────────────────────

export async function runVaultIntro(): Promise<boolean> {
  const refs = buildOverlay();
  document.body.appendChild(refs.overlay);

  let quitCalled = false;
  const unlocked = await runBiometricFlow(refs, () => { quitCalled = true; });

  refs.overlay.remove();
  if (quitCalled) window.close();
  return unlocked;
}
