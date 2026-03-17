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

  // Neutral gunmetal door body — single light source upper-left, no blue tint
  const dg = svgEl<SVGRadialGradientElement>('radialGradient');
  attr(dg, { id: 'vi-dg', cx: '32%', cy: '28%', r: '75%' });
  for (const [off, col] of [
    ['0%','#484e58'],['22%','#32363e'],['55%','#1e2026'],['100%','#111316'],
  ] as const) {
    const s = svgEl<SVGStopElement>('stop'); attr(s, { offset: off, 'stop-color': col }); dg.appendChild(s);
  }

  // Frame — darker, separate material
  const fg = svgEl<SVGRadialGradientElement>('radialGradient');
  attr(fg, { id: 'vi-fg', cx: '35%', cy: '30%', r: '70%' });
  for (const [off, col] of [['0%','#1c1e22'],['100%','#09090b']] as const) {
    const s = svgEl<SVGStopElement>('stop'); attr(s, { offset: off, 'stop-color': col }); fg.appendChild(s);
  }

  // Scanner pad — near-black hardened glass
  const sg = svgEl<SVGRadialGradientElement>('radialGradient');
  attr(sg, { id: 'vi-sg', cx: '40%', cy: '35%', r: '65%' });
  for (const [off, col] of [['0%','#0d0f13'],['55%','#080a0d'],['100%','#050608']] as const) {
    const s = svgEl<SVGStopElement>('stop'); attr(s, { offset: off, 'stop-color': col }); sg.appendChild(s);
  }

  // Bolt pin — cylindrical linear gradient, lit from left
  const bg = svgEl<SVGLinearGradientElement>('linearGradient');
  attr(bg, { id: 'vi-bg', x1: '0%', y1: '0%', x2: '100%', y2: '0%' });
  for (const [off, col] of [
    ['0%','#606670'],['20%','#484e58'],['55%','#2c2f36'],['100%','#18191e'],
  ] as const) {
    const s = svgEl<SVGStopElement>('stop'); attr(s, { offset: off, 'stop-color': col }); bg.appendChild(s);
  }

  // Drop shadow
  const shadow = svgEl<SVGFilterElement>('filter');
  attr(shadow, { id: 'vi-shadow', x: '-22%', y: '-22%', width: '144%', height: '144%' });
  const ds = svgEl('feDropShadow');
  attr(ds, { dx: '0', dy: '18', stdDeviation: '36', 'flood-color': '#000', 'flood-opacity': '0.95' });
  shadow.appendChild(ds);

  // Scanner glow bloom
  const gf = svgEl<SVGFilterElement>('filter');
  attr(gf, { id: 'vi-glow', x: '-60%', y: '-60%', width: '220%', height: '220%' });
  const gb = svgEl('feGaussianBlur'); attr(gb, { stdDeviation: '7', result: 'blur' });
  const gm = svgEl('feMerge');
  [{ in: 'blur' }, { in: 'SourceGraphic' }].forEach(a => {
    const n = svgEl('feMergeNode'); attr(n, a); gm.appendChild(n);
  });
  gf.appendChild(gb); gf.appendChild(gm);

  // Brushed metal grain — low Y frequency = horizontal brushed steel look
  const grain = svgEl<SVGFilterElement>('filter');
  attr(grain, { id: 'vi-grain', 'color-interpolation-filters': 'sRGB' });
  const turb = svgEl('feTurbulence');
  attr(turb, { type: 'fractalNoise', baseFrequency: '0.72 0.011', numOctaves: '4', seed: '9', result: 'noise' });
  const desat = svgEl('feColorMatrix');
  attr(desat, { type: 'saturate', values: '0', in: 'noise', result: 'gray' });
  const grainBlend = svgEl('feBlend');
  attr(grainBlend, { in: 'SourceGraphic', in2: 'gray', mode: 'overlay', result: 'blended' });
  const grainComp = svgEl('feComposite');
  attr(grainComp, { in: 'blended', in2: 'SourceGraphic', operator: 'in' });
  grain.appendChild(turb); grain.appendChild(desat); grain.appendChild(grainBlend); grain.appendChild(grainComp);

  // Soft AO blur — applied to dark shapes at recesses
  const ao = svgEl<SVGFilterElement>('filter');
  attr(ao, { id: 'vi-ao', x: '-40%', y: '-40%', width: '180%', height: '180%' });
  const aob = svgEl('feGaussianBlur'); attr(aob, { stdDeviation: '5' });
  ao.appendChild(aob);

  // Glass specular blur
  const specGlow = svgEl<SVGFilterElement>('filter');
  attr(specGlow, { id: 'vi-specglow', x: '-50%', y: '-50%', width: '200%', height: '200%' });
  const sgb = svgEl('feGaussianBlur'); attr(sgb, { stdDeviation: '5' });
  specGlow.appendChild(sgb);

  defs.appendChild(dg); defs.appendChild(fg); defs.appendChild(sg); defs.appendChild(bg);
  defs.appendChild(shadow); defs.appendChild(gf); defs.appendChild(grain);
  defs.appendChild(ao); defs.appendChild(specGlow);
  svg.appendChild(defs);

  // ── Cast shadow ────────────────────────────────────────────────────────────
  const shadowDisk = svgEl<SVGCircleElement>('circle');
  attr(shadowDisk, { cx: C, cy: C + 10, r: 252, fill: '#000', filter: 'url(#vi-shadow)', opacity: '0.8' });
  svg.appendChild(shadowDisk);

  // ── Frame ring ────────────────────────────────────────────────────────────
  const frame = svgEl<SVGCircleElement>('circle');
  attr(frame, { cx: C, cy: C, r: 249, fill: 'url(#vi-fg)' });
  svg.appendChild(frame);

  // Frame grain overlay
  const frameGrain = svgEl<SVGCircleElement>('circle');
  attr(frameGrain, { cx: C, cy: C, r: 249, fill: 'rgba(160,165,175,0.06)', filter: 'url(#vi-grain)' });
  svg.appendChild(frameGrain);

  // Frame outer bevel — lighter upper-left edge
  const frameBevelHL = svgEl<SVGCircleElement>('circle');
  attr(frameBevelHL, { cx: C, cy: C, r: 248, fill: 'none', stroke: 'rgba(255,255,255,0.08)', 'stroke-width': 2 });
  svg.appendChild(frameBevelHL);
  const frameBevelSh = svgEl<SVGCircleElement>('circle');
  attr(frameBevelSh, { cx: C + 2, cy: C + 2, r: 248, fill: 'none', stroke: 'rgba(0,0,0,0.55)', 'stroke-width': 2.5 });
  svg.appendChild(frameBevelSh);

  // Frame inner AO — deep shadow where frame meets door
  const frameInnerAO = svgEl<SVGCircleElement>('circle');
  attr(frameInnerAO, { cx: C, cy: C + 4, r: 207, fill: 'none',
    stroke: 'rgba(0,0,0,1)', 'stroke-width': 16, filter: 'url(#vi-ao)' });
  svg.appendChild(frameInnerAO);

  // Frame/door gap (machined seam)
  const seam = svgEl<SVGCircleElement>('circle');
  attr(seam, { cx: C, cy: C, r: 204, fill: 'none', stroke: '#030304', 'stroke-width': 3 });
  svg.appendChild(seam);

  // ── 8 locking bolt mechanisms ─────────────────────────────────────────────
  const boltPins: SVGGElement[] = [];
  for (let i = 0; i < 8; i++) {
    const g = svgEl<SVGGElement>('g');
    g.setAttribute('transform', `rotate(${i * 45} ${C} ${C})`);

    // Housing socket — deep dark recess
    const housing = svgEl<SVGRectElement>('rect');
    attr(housing, { x: C - 10, y: 4, width: 20, height: 48, rx: 5, fill: '#07080a', stroke: '#0e0f12', 'stroke-width': 1 });
    // Housing AO shadow
    const housingAO = svgEl<SVGRectElement>('rect');
    attr(housingAO, { x: C - 9, y: 5, width: 18, height: 14, rx: 4,
      fill: 'rgba(0,0,0,0.9)', filter: 'url(#vi-ao)' });

    // Bolt pin — cylindrical gradient
    const pinG = svgEl<SVGGElement>('g');
    const pin = svgEl<SVGRectElement>('rect');
    attr(pin, { x: C - 8, y: 8, width: 16, height: 34, rx: 4, fill: 'url(#vi-bg)' });
    // Top face bright rim — catches top light
    const pinTopHL = svgEl<SVGRectElement>('rect');
    attr(pinTopHL, { x: C - 7, y: 8, width: 14, height: 3.5, rx: 1.75, fill: 'rgba(255,255,255,0.4)' });
    // Left edge catchlight
    const pinLeftHL = svgEl<SVGRectElement>('rect');
    attr(pinLeftHL, { x: C - 8, y: 10, width: 2.5, height: 28, rx: 1.25, fill: 'rgba(255,255,255,0.22)' });
    // Grain on pin
    const pinGrain = svgEl<SVGRectElement>('rect');
    attr(pinGrain, { x: C - 8, y: 8, width: 16, height: 34, rx: 4,
      fill: 'rgba(200,205,215,0.07)', filter: 'url(#vi-grain)' });

    pinG.appendChild(pin); pinG.appendChild(pinTopHL);
    pinG.appendChild(pinLeftHL); pinG.appendChild(pinGrain);
    g.appendChild(housing); g.appendChild(housingAO); g.appendChild(pinG);
    svg.appendChild(g);
    boltPins.push(pinG);
  }

  // ── Door body ─────────────────────────────────────────────────────────────
  const door = svgEl<SVGCircleElement>('circle');
  attr(door, { cx: C, cy: C, r: 201, fill: 'url(#vi-dg)' });
  svg.appendChild(door);

  // Beveled door edge — upper-left lighter, lower-right darker
  const doorBevelHL = svgEl<SVGCircleElement>('circle');
  attr(doorBevelHL, { cx: C, cy: C, r: 200, fill: 'none', stroke: 'rgba(255,255,255,0.13)', 'stroke-width': 5 });
  svg.appendChild(doorBevelHL);
  const doorBevelSh = svgEl<SVGCircleElement>('circle');
  attr(doorBevelSh, { cx: C + 3, cy: C + 3, r: 199, fill: 'none', stroke: 'rgba(0,0,0,0.7)', 'stroke-width': 5 });
  svg.appendChild(doorBevelSh);

  // Brushed metal grain — horizontal grain = brushed steel finish
  const doorGrain = svgEl<SVGCircleElement>('circle');
  attr(doorGrain, { cx: C, cy: C, r: 198, fill: 'rgba(190,195,205,0.09)', filter: 'url(#vi-grain)' });
  svg.appendChild(doorGrain);

  // Sharp specular — single light source, tight hotspot upper-left
  const specWide = svgEl<SVGEllipseElement>('ellipse');
  attr(specWide, { cx: C - 60, cy: C - 65, rx: 80, ry: 58, fill: 'rgba(255,255,255,0.042)' });
  svg.appendChild(specWide);
  const specHot = svgEl<SVGEllipseElement>('ellipse');
  attr(specHot, { cx: C - 72, cy: C - 76, rx: 30, ry: 21, fill: 'rgba(255,255,255,0.075)' });
  svg.appendChild(specHot);

  // ── Outer machined groove ─────────────────────────────────────────────────
  const outerGrooveAO = svgEl<SVGCircleElement>('circle');
  attr(outerGrooveAO, { cx: C, cy: C + 3, r: 172, fill: 'none',
    stroke: 'rgba(0,0,0,0.9)', 'stroke-width': 16, filter: 'url(#vi-ao)' });
  svg.appendChild(outerGrooveAO);
  const outerGroove = svgEl<SVGCircleElement>('circle');
  attr(outerGroove, { cx: C, cy: C, r: 172, fill: 'none', stroke: '#060608', 'stroke-width': 9 });
  svg.appendChild(outerGroove);
  const outerGrooveHL = svgEl<SVGCircleElement>('circle');
  attr(outerGrooveHL, { cx: C - 1, cy: C - 1, r: 177, fill: 'none',
    stroke: 'rgba(255,255,255,0.1)', 'stroke-width': 1.5 });
  svg.appendChild(outerGrooveHL);

  // ── Inner machined groove ─────────────────────────────────────────────────
  const innerGrooveAO = svgEl<SVGCircleElement>('circle');
  attr(innerGrooveAO, { cx: C, cy: C + 3, r: 126, fill: 'none',
    stroke: 'rgba(0,0,0,0.85)', 'stroke-width': 14, filter: 'url(#vi-ao)' });
  svg.appendChild(innerGrooveAO);
  const innerGroove = svgEl<SVGCircleElement>('circle');
  attr(innerGroove, { cx: C, cy: C, r: 126, fill: 'none', stroke: '#060608', 'stroke-width': 7 });
  svg.appendChild(innerGroove);
  const innerGrooveHL = svgEl<SVGCircleElement>('circle');
  attr(innerGrooveHL, { cx: C - 1, cy: C - 1, r: 130, fill: 'none',
    stroke: 'rgba(255,255,255,0.08)', 'stroke-width': 1.5 });
  svg.appendChild(innerGrooveHL);

  // ── 8 machined rivets between grooves ────────────────────────────────────
  for (const angle of [22.5, 67.5, 112.5, 157.5, 202.5, 247.5, 292.5, 337.5]) {
    const rad = angle * Math.PI / 180;
    const rx = C + Math.cos(rad) * 149;
    const ry = C + Math.sin(rad) * 149;
    const rvAO = svgEl<SVGCircleElement>('circle');
    attr(rvAO, { cx: rx, cy: ry, r: 9, fill: 'rgba(0,0,0,0.8)', filter: 'url(#vi-ao)' });
    svg.appendChild(rvAO);
    const rv = svgEl<SVGCircleElement>('circle');
    attr(rv, { cx: rx, cy: ry, r: 6.5, fill: 'url(#vi-fg)', stroke: '#0e0f12', 'stroke-width': 1 });
    svg.appendChild(rv);
    const rvHL = svgEl<SVGCircleElement>('circle');
    attr(rvHL, { cx: rx - 2.2, cy: ry - 2.2, r: 2.4, fill: 'rgba(255,255,255,0.32)' });
    svg.appendChild(rvHL);
    const rvCenter = svgEl<SVGCircleElement>('circle');
    attr(rvCenter, { cx: rx, cy: ry, r: 2, fill: '#0e0f12' });
    svg.appendChild(rvCenter);
  }

  // ── Scanner housing — deeply recessed ────────────────────────────────────
  const scanDeepAO = svgEl<SVGCircleElement>('circle');
  attr(scanDeepAO, { cx: C, cy: C + 5, r: 96, fill: 'none',
    stroke: 'rgba(0,0,0,1)', 'stroke-width': 22, filter: 'url(#vi-ao)' });
  svg.appendChild(scanDeepAO);

  const scanHousing = svgEl<SVGCircleElement>('circle');
  attr(scanHousing, { cx: C, cy: C, r: 93, fill: '#050608', stroke: '#0a0b0d', 'stroke-width': 2 });
  svg.appendChild(scanHousing);

  // Housing bevel — lit upper-left edge
  const scanHousingHL = svgEl<SVGCircleElement>('circle');
  attr(scanHousingHL, { cx: C - 1, cy: C - 1, r: 92, fill: 'none',
    stroke: 'rgba(255,255,255,0.14)', 'stroke-width': 1.5 });
  svg.appendChild(scanHousingHL);
  const scanHousingSh = svgEl<SVGCircleElement>('circle');
  attr(scanHousingSh, { cx: C + 1, cy: C + 1, r: 92, fill: 'none',
    stroke: 'rgba(0,0,0,0.6)', 'stroke-width': 1.5 });
  svg.appendChild(scanHousingSh);

  // ── Scanner pad — dark glass ──────────────────────────────────────────────
  const padFill = svgEl<SVGCircleElement>('circle');
  attr(padFill, { cx: C, cy: C, r: 83, fill: 'url(#vi-sg)' });
  svg.appendChild(padFill);

  // Glass reflection — sharp specular off dark glass surface
  const glassSpec = svgEl<SVGEllipseElement>('ellipse');
  attr(glassSpec, { cx: C - 18, cy: C - 28, rx: 34, ry: 22,
    fill: 'rgba(255,255,255,0.12)', filter: 'url(#vi-specglow)' });
  svg.appendChild(glassSpec);
  const glassSpecTight = svgEl<SVGEllipseElement>('ellipse');
  attr(glassSpecTight, { cx: C - 22, cy: C - 33, rx: 14, ry: 8, fill: 'rgba(255,255,255,0.16)' });
  svg.appendChild(glassSpecTight);

  // ── Scanner LED ring ──────────────────────────────────────────────────────
  const scannerGlow = svgEl<SVGCircleElement>('circle');
  attr(scannerGlow, { cx: C, cy: C, r: 85, fill: 'none', stroke: '#1a70f0', 'stroke-width': 14 });
  scannerGlow.style.cssText = 'filter:url(#vi-glow);animation:vi-glow 2.8s ease-in-out infinite;';
  svg.appendChild(scannerGlow);

  const scannerRing = svgEl<SVGCircleElement>('circle');
  attr(scannerRing, { cx: C, cy: C, r: 84, fill: 'none', stroke: '#2a82f8', 'stroke-width': 1.5 });
  scannerRing.style.animation = 'vi-scan 2.8s ease-in-out infinite';
  svg.appendChild(scannerRing);

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

  // ── Status text ────────────────────────────────────────────────────────────
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

  // ── Logo — etched into steel, barely visible ──────────────────────────────
  const logoText = svgEl<SVGTextElement>('text');
  attr(logoText, {
    x: C, y: C - 128,
    'text-anchor': 'middle',
    'font-family': '"SF Pro Display", -apple-system, BlinkMacSystemFont, sans-serif',
    'font-size': '10', 'font-weight': '700', 'letter-spacing': '0.36em',
    fill: 'rgba(155,163,175,0.2)',
  });
  logoText.textContent = 'WORLD  MONITOR';
  svg.appendChild(logoText);

  // ── Status LED ─────────────────────────────────────────────────────────────
  const ledGlow = svgEl<SVGCircleElement>('circle');
  attr(ledGlow, { cx: C, cy: C + 160, r: 9, fill: 'rgba(200,28,28,0.16)', filter: 'url(#vi-ao)' });
  svg.appendChild(ledGlow);
  const lockedLed = svgEl<SVGCircleElement>('circle');
  attr(lockedLed, { cx: C, cy: C + 160, r: 3.5, fill: '#cc2020', stroke: '#6a0e0e', 'stroke-width': 1 });
  lockedLed.style.animation = 'vi-ledblink 2.2s ease-in-out infinite';
  svg.appendChild(lockedLed);

  // ── Tap target ─────────────────────────────────────────────────────────────
  const scannerBtn = svgEl<SVGCircleElement>('circle');
  attr(scannerBtn, { cx: C, cy: C, r: 93, fill: 'transparent' });
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
  p.scannerRing.style.animation = 'vi-scan 2.8s ease-in-out infinite';
  p.scannerGlow.style.animation = 'vi-glow 2.8s ease-in-out infinite';
  p.scannerRing.setAttribute('stroke', '#1e6ab8');
  p.scannerGlow.setAttribute('stroke', '#1a5a9e');
  for (const fp of p.fpPaths) fp.setAttribute('stroke', '#3080b8');
  p.padFill.setAttribute('fill', 'url(#vi-sg)');
  p.statusText.setAttribute('fill', 'rgba(100,148,200,0.7)');
  p.statusText.textContent = 'TAP TO RETRY';
  p.scannerBtn.style.cursor = 'pointer';
  p.scannerBtn.onmouseenter = null;
  p.scannerBtn.onmouseleave = null;
}

function setScannerWarmup(p: DoorParts): void {
  p.scannerRing.style.animation = 'vi-warmup 0.9s ease-in-out infinite';
  p.scannerGlow.style.animation = 'vi-glowwarm 0.9s ease-in-out infinite';
  p.scannerRing.setAttribute('stroke', '#2a88e0');
  p.scannerGlow.setAttribute('stroke', '#2272c8');
  p.statusText.setAttribute('fill', 'rgba(130,175,230,0.85)');
  p.statusText.textContent = 'SCANNING…';
}

function setScannerScanning(p: DoorParts): void {
  p.scannerRing.style.animation = 'vi-warmup 0.5s ease-in-out infinite';
  p.scannerGlow.style.animation = 'vi-glowwarm 0.5s ease-in-out infinite';
  p.statusText.textContent = 'PLACE FINGER ON SENSOR';
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

  const tryAuth = async (manual: boolean) => {
    if (settled || inFlight) return;
    inFlight = true;

    const ready = await waitForBridge();
    if (!ready || settled) { inFlight = false; return; }

    if (!manual) {
      // Warmup phase — scanner builds intensity before Touch ID fires
      setScannerWarmup(refs);
      await sleep(900);
      if (settled) return;
    }

    setScannerScanning(refs);
    await sleep(300);
    if (settled) return;

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
      const text = msg.toLowerCase().includes('cancel') ? 'CANCELLED — TAP TO RETRY' : 'TAP TO RETRY';
      setScannerError(refs, text);
      setTimeout(() => { if (!settled) setScannerIdle(refs); }, 1400);
    }
  };

  // Auto-trigger after door finishes its entrance
  setTimeout(() => void tryAuth(false), 1200);

  // Tap scanner to retry after failure
  refs.scannerBtn.addEventListener('click', () => void tryAuth(true));

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
