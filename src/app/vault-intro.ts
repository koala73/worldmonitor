// Hermetic vault door intro — biometric auth with procedural audio and SVG animation.
// Wraps ensureBiometricUnlock() with a full-screen bunker door sequence.

type VaultRefs = {
  overlay: HTMLDivElement;
  svgEl: SVGSVGElement;
  scannerRing: SVGCircleElement;
  scannerFill: SVGCircleElement;
  scannerPaths: SVGPathElement[];
  bolts: SVGGElement[];
  statusText: HTMLDivElement;
  leds: HTMLDivElement[];
};

// ── CSS ────────────────────────────────────────────────────────────────────────

function injectStyles(): void {
  if (document.getElementById('vault-intro-styles')) return;
  const style = document.createElement('style');
  style.id = 'vault-intro-styles';
  style.textContent = `
    @keyframes vault-fade-in {
      from { opacity: 0; } to { opacity: 1; }
    }
    @keyframes vault-scanner-pulse {
      0%, 100% { opacity: 0.4; stroke-width: 1.5px; }
      50%       { opacity: 1.0; stroke-width: 2px; }
    }
    @keyframes vault-led-blink {
      0%, 100% { opacity: 1; } 50% { opacity: 0.25; }
    }
    @keyframes vault-bolt-retract {
      0%   { transform: translateY(0);    opacity: 1; }
      100% { transform: translateY(18px); opacity: 0; }
    }
  `;
  document.head.appendChild(style);
}

// ── Audio ──────────────────────────────────────────────────────────────────────

function newAudioCtx(): AudioContext | null {
  try { return new AudioContext(); } catch { return null; }
}

function playBoltRetracts(ctx: AudioContext): void {
  const t0 = ctx.currentTime;
  for (let i = 0; i < 4; i++) {
    const t = t0 + i * 0.11;

    // Low thud
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(88, t);
    osc.frequency.exponentialRampToValueAtTime(18, t + 0.24);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.55, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
    osc.connect(og).connect(ctx.destination);
    osc.start(t); osc.stop(t + 0.25);

    // Metallic click
    const bufSz = Math.floor(ctx.sampleRate * 0.045);
    const buf = ctx.createBuffer(1, bufSz, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let j = 0; j < bufSz; j++) d[j] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const hpf = ctx.createBiquadFilter();
    hpf.type = 'highpass'; hpf.frequency.value = 3200;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.28, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.045);
    src.connect(hpf).connect(ng).connect(ctx.destination);
    src.start(t);
  }
}

function playPressureRelease(ctx: AudioContext): void {
  const t0 = ctx.currentTime + 0.1;
  const dur = 2.2;

  // Air pressure hiss (filtered white noise, sweeping down)
  const hissLen = Math.floor(ctx.sampleRate * dur);
  const hissBuf = ctx.createBuffer(1, hissLen, ctx.sampleRate);
  const hd = hissBuf.getChannelData(0);
  for (let i = 0; i < hissLen; i++) hd[i] = Math.random() * 2 - 1;
  const hissSrc = ctx.createBufferSource();
  hissSrc.buffer = hissBuf;
  const hissF = ctx.createBiquadFilter();
  hissF.type = 'bandpass';
  hissF.frequency.setValueAtTime(1800, t0);
  hissF.frequency.exponentialRampToValueAtTime(320, t0 + dur * 0.7);
  hissF.Q.value = 1.1;
  const hissG = ctx.createGain();
  hissG.gain.setValueAtTime(0, t0);
  hissG.gain.linearRampToValueAtTime(0.4, t0 + 0.09);
  hissG.gain.setValueAtTime(0.4, t0 + dur * 0.45);
  hissG.gain.linearRampToValueAtTime(0, t0 + dur);
  hissSrc.connect(hissF).connect(hissG).connect(ctx.destination);
  hissSrc.start(t0);

  // Mechanism rumble (low sawtooth with lowpass)
  const rumble = ctx.createOscillator();
  rumble.type = 'sawtooth';
  rumble.frequency.setValueAtTime(44, t0 + 0.25);
  rumble.frequency.linearRampToValueAtTime(54, t0 + 1.4);
  const rumbleF = ctx.createBiquadFilter();
  rumbleF.type = 'lowpass'; rumbleF.frequency.value = 170;
  const rumbleG = ctx.createGain();
  rumbleG.gain.setValueAtTime(0, t0 + 0.25);
  rumbleG.gain.linearRampToValueAtTime(0.18, t0 + 0.45);
  rumbleG.gain.setValueAtTime(0.18, t0 + 1.3);
  rumbleG.gain.linearRampToValueAtTime(0, t0 + 1.9);
  rumble.connect(rumbleF).connect(rumbleG).connect(ctx.destination);
  rumble.start(t0 + 0.25); rumble.stop(t0 + 2.0);

  // Door-swing whoosh (noise sweep up then down)
  const wLen = Math.floor(ctx.sampleRate * 1.5);
  const wBuf = ctx.createBuffer(1, wLen, ctx.sampleRate);
  const wd = wBuf.getChannelData(0);
  for (let i = 0; i < wLen; i++) wd[i] = Math.random() * 2 - 1;
  const wSrc = ctx.createBufferSource();
  wSrc.buffer = wBuf;
  const wF = ctx.createBiquadFilter();
  wF.type = 'bandpass';
  wF.frequency.setValueAtTime(480, t0 + 0.5);
  wF.frequency.exponentialRampToValueAtTime(3000, t0 + 1.0);
  wF.frequency.exponentialRampToValueAtTime(190, t0 + 2.0);
  wF.Q.value = 0.6;
  const wG = ctx.createGain();
  wG.gain.setValueAtTime(0, t0 + 0.5);
  wG.gain.linearRampToValueAtTime(0.22, t0 + 0.8);
  wG.gain.linearRampToValueAtTime(0, t0 + 2.0);
  wSrc.connect(wF).connect(wG).connect(ctx.destination);
  wSrc.start(t0 + 0.5);
}

// ── SVG door ───────────────────────────────────────────────────────────────────

const NS = 'http://www.w3.org/2000/svg';

function svgEl<T extends SVGElement>(tag: string): T {
  return document.createElementNS(NS, tag) as T;
}

function attr(el: SVGElement, attrs: Record<string, string>): void {
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
}

function buildDoorSVG(SIZE: number): {
  svg: SVGSVGElement;
  scannerRing: SVGCircleElement;
  scannerFill: SVGCircleElement;
  scannerPaths: SVGPathElement[];
  bolts: SVGGElement[];
} {
  const C = SIZE / 2;
  const svg = svgEl<SVGSVGElement>('svg');
  attr(svg, { viewBox: `0 0 ${SIZE} ${SIZE}`, width: String(SIZE), height: String(SIZE) });
  svg.style.overflow = 'visible';

  // Defs: radial gradient for door body
  const defs = svgEl('defs');
  const grad = svgEl<SVGRadialGradientElement>('radialGradient');
  attr(grad, { id: 'vaultDoorGrad', cx: '38%', cy: '34%', r: '62%' });
  for (const [offset, color] of [['0%', '#2e3548'], ['50%', '#1a2030'], ['100%', '#0e1118']] as const) {
    const s = svgEl<SVGStopElement>('stop');
    attr(s, { offset, 'stop-color': color });
    grad.appendChild(s);
  }
  defs.appendChild(grad);
  svg.appendChild(defs);

  // Outer frame ring
  const frame = svgEl<SVGCircleElement>('circle');
  attr(frame, { cx: String(C), cy: String(C), r: String(C - 2), fill: '#0a0d12', stroke: '#1a2030', 'stroke-width': '3' });
  svg.appendChild(frame);

  // Subtle top-left bevel gleam
  const bevel = svgEl<SVGCircleElement>('circle');
  attr(bevel, { cx: String(C), cy: String(C - 4), r: String(C - 12), fill: 'none', stroke: 'rgba(255,255,255,0.03)', 'stroke-width': '7' });
  svg.appendChild(bevel);

  // ── 8 locking bolts ──────────────────────────────────────────────────────────
  const bolts: SVGGElement[] = [];
  for (let i = 0; i < 8; i++) {
    const g = svgEl<SVGGElement>('g');
    g.setAttribute('transform', `rotate(${i * 45} ${C} ${C})`);

    // Housing (static)
    const housing = svgEl<SVGRectElement>('rect');
    attr(housing, {
      x: String(C - 7), y: '5',
      width: '14', height: '34', rx: '4',
      fill: '#12161e', stroke: '#1e2838', 'stroke-width': '1',
    });

    // Pin group (animated on retract)
    const pinG = svgEl<SVGGElement>('g');
    const pin = svgEl<SVGRectElement>('rect');
    attr(pin, {
      x: String(C - 5), y: '8',
      width: '10', height: '24', rx: '3',
      fill: '#38495e', stroke: '#4a5e72', 'stroke-width': '0.5',
    });
    const pinHL = svgEl<SVGRectElement>('rect');
    attr(pinHL, {
      x: String(C - 4), y: '9',
      width: '3', height: '20', rx: '1.5',
      fill: 'rgba(255,255,255,0.1)',
    });
    pinG.appendChild(pin);
    pinG.appendChild(pinHL);
    g.appendChild(housing);
    g.appendChild(pinG);
    svg.appendChild(g);
    bolts.push(pinG);
  }

  // ── Main door body ────────────────────────────────────────────────────────────
  const doorBody = svgEl<SVGCircleElement>('circle');
  attr(doorBody, {
    cx: String(C), cy: String(C), r: String(C - 40),
    fill: 'url(#vaultDoorGrad)', stroke: '#232c3e', 'stroke-width': '2.5',
  });
  svg.appendChild(doorBody);

  // Depth highlight (off-center bright patch)
  const depthHL = svgEl<SVGCircleElement>('circle');
  attr(depthHL, {
    cx: String(C - 18), cy: String(C - 18), r: String(C - 60),
    fill: 'rgba(255,255,255,0.028)',
  });
  svg.appendChild(depthHL);

  // ── Cross-brace reinforcement ribs ────────────────────────────────────────────
  const ribR = C - 42;
  const ribDirs: [number, number][] = [[1, 0], [0, 1], [0.707, 0.707], [-0.707, 0.707]];
  for (const [dx, dy] of ribDirs) {
    const shadow = svgEl<SVGLineElement>('line');
    attr(shadow, {
      x1: String(C - dx * ribR), y1: String(C - dy * ribR + 2),
      x2: String(C + dx * ribR), y2: String(C + dy * ribR + 2),
      stroke: 'rgba(0,0,0,0.5)', 'stroke-width': '12', 'stroke-linecap': 'round',
    });
    svg.appendChild(shadow);

    const rib = svgEl<SVGLineElement>('line');
    attr(rib, {
      x1: String(C - dx * ribR), y1: String(C - dy * ribR),
      x2: String(C + dx * ribR), y2: String(C + dy * ribR),
      stroke: '#121820', 'stroke-width': '12', 'stroke-linecap': 'round',
    });
    svg.appendChild(rib);

    const ribHL = svgEl<SVGLineElement>('line');
    attr(ribHL, {
      x1: String(C - dx * ribR + dy * 2), y1: String(C - dy * ribR - dx * 2),
      x2: String(C + dx * ribR + dy * 2), y2: String(C + dy * ribR - dx * 2),
      stroke: 'rgba(255,255,255,0.055)', 'stroke-width': '3', 'stroke-linecap': 'round',
    });
    svg.appendChild(ribHL);
  }

  // ── Rivets at rib intersections ───────────────────────────────────────────────
  const rivetSpots: [number, number][] = [
    [C, C - ribR * 0.55], [C, C + ribR * 0.55],
    [C - ribR * 0.55, C], [C + ribR * 0.55, C],
    [C - ribR * 0.39, C - ribR * 0.39], [C + ribR * 0.39, C - ribR * 0.39],
    [C - ribR * 0.39, C + ribR * 0.39], [C + ribR * 0.39, C + ribR * 0.39],
  ];
  for (const [rx, ry] of rivetSpots) {
    const rv = svgEl<SVGCircleElement>('circle');
    attr(rv, { cx: String(rx), cy: String(ry), r: '5', fill: '#181f2e', stroke: '#252f42', 'stroke-width': '1' });
    svg.appendChild(rv);
    const rvHL = svgEl<SVGCircleElement>('circle');
    attr(rvHL, { cx: String(rx - 1.2), cy: String(ry - 1.2), r: '1.6', fill: 'rgba(255,255,255,0.14)' });
    svg.appendChild(rvHL);
  }

  // ── Central scanner housing ───────────────────────────────────────────────────
  const scannerHousing = svgEl<SVGCircleElement>('circle');
  attr(scannerHousing, {
    cx: String(C), cy: String(C), r: '60',
    fill: '#0b0e14', stroke: '#1c2438', 'stroke-width': '2',
  });
  svg.appendChild(scannerHousing);

  // Pulsing ring
  const scannerRing = svgEl<SVGCircleElement>('circle');
  attr(scannerRing, {
    cx: String(C), cy: String(C), r: '52',
    fill: 'none', stroke: '#1a4a70', 'stroke-width': '1.5',
  });
  scannerRing.style.animation = 'vault-scanner-pulse 2.6s ease-in-out infinite';
  svg.appendChild(scannerRing);

  // Scanner fill (color state indicator)
  const scannerFill = svgEl<SVGCircleElement>('circle');
  attr(scannerFill, { cx: String(C), cy: String(C), r: '44', fill: 'rgba(8,16,28,0.85)' });
  svg.appendChild(scannerFill);

  // Fingerprint icon (simplified concentric arcs)
  const fpG = svgEl<SVGGElement>('g');
  fpG.setAttribute('transform', `translate(${C - 20}, ${C - 22})`);
  fpG.setAttribute('opacity', '0.52');
  const fpDefs = [
    'M 20 4 C 10 4 4 10 4 20 C 4 30 8 36 14 38',
    'M 20 8 C 12 8 8 14 8 20 C 8 27 12 32 20 32',
    'M 20 12 C 15 12 12 16 12 20 C 12 25 16 28 20 28',
    'M 20 16 C 17 16 16 18 16 20 C 16 22 18 24 20 24 C 22 24 24 22 24 20 C 24 18 22 16 20 16',
    'M 20 4 C 30 4 36 10 36 20 C 36 30 30 36 26 38',
    'M 28 8 C 32 13 32 17 32 20 C 32 26 28 32 20 32',
    'M 30 12 C 32 16 28 24 20 28',
    'M 26 16 C 28 18 26 24 20 24',
  ];
  const scannerPaths: SVGPathElement[] = [];
  for (const d of fpDefs) {
    const p = svgEl<SVGPathElement>('path');
    attr(p, { d, stroke: '#3a80aa', 'stroke-width': '1.4', fill: 'none', 'stroke-linecap': 'round' });
    fpG.appendChild(p);
    scannerPaths.push(p);
  }
  svg.appendChild(fpG);

  // ── Door handle (bar on right side) ──────────────────────────────────────────
  const hx = C + ribR + 4;
  const hBar = svgEl<SVGRectElement>('rect');
  attr(hBar, {
    x: String(hx), y: String(C - 26),
    width: '13', height: '52', rx: '6.5',
    fill: '#141c2a', stroke: '#222e42', 'stroke-width': '1.5',
  });
  svg.appendChild(hBar);
  const hBarHL = svgEl<SVGRectElement>('rect');
  attr(hBarHL, {
    x: String(hx + 2), y: String(C - 20),
    width: '3.5', height: '40', rx: '1.75',
    fill: 'rgba(255,255,255,0.08)',
  });
  svg.appendChild(hBarHL);

  return { svg, scannerRing, scannerFill, scannerPaths, bolts };
}

// ── Overlay DOM ────────────────────────────────────────────────────────────────

function buildOverlay(): VaultRefs {
  injectStyles();

  const overlay = document.createElement('div');
  Object.assign(overlay.style, {
    position: 'fixed',
    inset: '0',
    background: '#06080b',
    zIndex: '1000',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: '"SF Pro Display", -apple-system, BlinkMacSystemFont, sans-serif',
    overflow: 'hidden',
    animation: 'vault-fade-in 0.55s ease both',
    userSelect: 'none',
  } satisfies Partial<CSSStyleDeclaration>);

  // Top classification bar
  const topBar = document.createElement('div');
  Object.assign(topBar.style, {
    position: 'absolute',
    top: '0', left: '0', right: '0', height: '26px',
    background: 'rgba(155,15,15,0.92)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: '10px', fontWeight: '700', letterSpacing: '0.22em',
    color: 'rgba(255,255,255,0.88)',
  } satisfies Partial<CSSStyleDeclaration>);
  topBar.textContent = 'TOP SECRET // WORLD MONITOR SECURE ENCLAVE';

  // Logo
  const logo = document.createElement('div');
  Object.assign(logo.style, {
    position: 'absolute',
    top: '40px',
    fontSize: '12px', fontWeight: '700', letterSpacing: '0.28em',
    color: 'rgba(140,175,210,0.42)',
  } satisfies Partial<CSSStyleDeclaration>);
  logo.textContent = 'WORLD MONITOR';

  // Build SVG door
  const SIZE = 320;
  const { svg, scannerRing, scannerFill, scannerPaths, bolts } = buildDoorSVG(SIZE);
  svg.style.width = 'min(320px, 62vmin)';
  svg.style.height = 'min(320px, 62vmin)';

  // LED row
  const ledRow = document.createElement('div');
  Object.assign(ledRow.style, {
    display: 'flex', gap: '8px', marginTop: '18px', alignItems: 'center',
  } satisfies Partial<CSSStyleDeclaration>);

  const ledDefs = ['#a81c1c', '#2d3748', '#2d3748'] as const;
  const leds = ledDefs.map((color, i) => {
    const led = document.createElement('div');
    Object.assign(led.style, {
      width: '7px', height: '7px', borderRadius: '50%',
      background: color,
      boxShadow: i === 0 ? '0 0 5px 2px rgba(168,28,28,0.6)' : 'none',
      animation: i === 0 ? 'vault-led-blink 2s ease-in-out infinite' : 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    return led;
  });
  leds.forEach(l => ledRow.appendChild(l));

  // Status text
  const statusText = document.createElement('div');
  Object.assign(statusText.style, {
    marginTop: '14px',
    fontSize: '10px', fontWeight: '600', letterSpacing: '0.18em',
    color: 'rgba(90,130,175,0.55)',
  } satisfies Partial<CSSStyleDeclaration>);
  statusText.textContent = 'AWAITING BIOMETRIC AUTHENTICATION';

  // Bottom bar
  const bottomBar = document.createElement('div');
  Object.assign(bottomBar.style, {
    position: 'absolute',
    bottom: '0', left: '0', right: '0', height: '22px',
    background: 'rgba(155,15,15,0.92)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: '9px', fontWeight: '700', letterSpacing: '0.18em',
    color: 'rgba(255,255,255,0.82)',
  } satisfies Partial<CSSStyleDeclaration>);
  bottomBar.textContent = 'UNAUTHORIZED ACCESS PROHIBITED — 18 U.S.C. § 1030';

  // Center column
  const col = document.createElement('div');
  Object.assign(col.style, {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
  } satisfies Partial<CSSStyleDeclaration>);
  col.appendChild(svg);
  col.appendChild(ledRow);
  col.appendChild(statusText);

  overlay.appendChild(topBar);
  overlay.appendChild(logo);
  overlay.appendChild(col);
  overlay.appendChild(bottomBar);

  return { overlay, svgEl: svg, scannerRing, scannerFill, scannerPaths, bolts, statusText, leds };
}

// ── State transitions ──────────────────────────────────────────────────────────

function setAuthenticated(refs: VaultRefs): void {
  refs.scannerRing.style.animation = '';
  refs.scannerRing.setAttribute('stroke', '#1a8a4e');
  refs.scannerRing.style.opacity = '1';
  refs.scannerFill.setAttribute('fill', 'rgba(6,24,14,0.9)');
  for (const p of refs.scannerPaths) p.setAttribute('stroke', '#2dd47a');
  refs.statusText.textContent = 'ACCESS GRANTED';
  refs.statusText.style.color = 'rgba(45,212,122,0.85)';

  // LEDs: red off, two green on
  const [led0, led1, led2] = refs.leds;
  if (led0) Object.assign(led0.style, { background: '#2d3748', boxShadow: 'none', animation: 'none' });
  if (led1) Object.assign(led1.style, { background: '#15803d', boxShadow: '0 0 5px 2px rgba(21,128,61,0.6)' });
  if (led2) Object.assign(led2.style, { background: '#15803d', boxShadow: '0 0 5px 2px rgba(21,128,61,0.45)' });
}

function retractBolts(bolts: SVGGElement[]): void {
  bolts.forEach((bolt, i) => {
    bolt.style.animation = `vault-bolt-retract 0.28s ease-in ${i * 0.065}s both`;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function playOpenSequence(refs: VaultRefs): Promise<void> {
  setAuthenticated(refs);
  await sleep(320);

  const ctx = newAudioCtx();
  if (ctx) {
    playBoltRetracts(ctx);
    setTimeout(() => playPressureRelease(ctx), 400);
  }

  retractBolts(refs.bolts);
  await sleep(520);

  // Door swings open — rotate Y around right edge (hinge side), fade out
  refs.svgEl.style.transition = 'transform 1.75s cubic-bezier(0.42, 0, 0.18, 1), opacity 1.5s ease';
  refs.svgEl.style.transformOrigin = 'right center';
  refs.svgEl.style.transform = 'perspective(900px) rotateY(-88deg)';
  refs.svgEl.style.opacity = '0';

  // Fade background slightly behind the door
  await sleep(380);
  refs.overlay.style.transition = 'opacity 1.4s ease';
  refs.overlay.style.opacity = '0';

  await sleep(1500);
}

// ── Public export ──────────────────────────────────────────────────────────────

export async function runVaultIntro(): Promise<boolean> {
  const refs = buildOverlay();
  document.body.appendChild(refs.overlay);

  const { ensureBiometricUnlock } = await import('./biometric-gate');
  const unlocked = await ensureBiometricUnlock();

  if (unlocked) {
    await playOpenSequence(refs);
  }

  refs.overlay.remove();
  return unlocked;
}
