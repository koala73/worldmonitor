// Biometric vault intro — Three.js 3D rendering.
// WebGL scene with PBR materials, real-time lighting, and animated 3D geometry.
// Scanner ring is an actual Three.js torus with physical lighting, not a Canvas stroke.

import * as THREE from 'three';
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
  const dur = 2.8;

  // Heavy pneumatic release — air rushing
  const aBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.6), ctx.sampleRate);
  const ad = aBuf.getChannelData(0);
  for (let i = 0; i < ad.length; i++) ad[i] = Math.random() * 2 - 1;
  const aSrc = ctx.createBufferSource(); aSrc.buffer = aBuf;
  const aF = ctx.createBiquadFilter(); aF.type = 'bandpass';
  aF.frequency.value = 2800; aF.Q.value = 0.5;
  const aG = ctx.createGain();
  aG.gain.setValueAtTime(0, t0);
  aG.gain.linearRampToValueAtTime(0.55, t0 + 0.04);
  aG.gain.exponentialRampToValueAtTime(0.001, t0 + 0.55);
  aSrc.connect(aF).connect(aG).connect(ctx.destination);
  aSrc.start(t0);

  // Deep hydraulic rumble
  const hBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
  const hd = hBuf.getChannelData(0);
  for (let i = 0; i < hd.length; i++) hd[i] = Math.random() * 2 - 1;
  const hSrc = ctx.createBufferSource(); hSrc.buffer = hBuf;
  const hF = ctx.createBiquadFilter(); hF.type = 'lowpass';
  hF.frequency.setValueAtTime(120, t0 + 0.1);
  hF.frequency.exponentialRampToValueAtTime(60, t0 + dur * 0.6);
  const hG = ctx.createGain();
  hG.gain.setValueAtTime(0, t0 + 0.1);
  hG.gain.linearRampToValueAtTime(0.35, t0 + 0.3);
  hG.gain.setValueAtTime(0.35, t0 + dur * 0.5);
  hG.gain.linearRampToValueAtTime(0, t0 + dur);
  hSrc.connect(hF).connect(hG).connect(ctx.destination);
  hSrc.start(t0 + 0.1);

  // Metallic groan — door panels sliding
  const gOsc = ctx.createOscillator(); gOsc.type = 'sawtooth';
  gOsc.frequency.setValueAtTime(38, t0 + 0.2);
  gOsc.frequency.linearRampToValueAtTime(48, t0 + 1.6);
  gOsc.frequency.linearRampToValueAtTime(32, t0 + dur);
  const gF = ctx.createBiquadFilter(); gF.type = 'lowpass'; gF.frequency.value = 200;
  const gG = ctx.createGain();
  gG.gain.setValueAtTime(0, t0 + 0.2);
  gG.gain.linearRampToValueAtTime(0.22, t0 + 0.5);
  gG.gain.setValueAtTime(0.22, t0 + 1.5);
  gG.gain.linearRampToValueAtTime(0, t0 + 2.4);
  gOsc.connect(gF).connect(gG).connect(ctx.destination);
  gOsc.start(t0 + 0.2); gOsc.stop(t0 + 2.5);

  // High-frequency mechanical whirr — motors running
  const mOsc = ctx.createOscillator(); mOsc.type = 'sawtooth';
  mOsc.frequency.setValueAtTime(340, t0);
  mOsc.frequency.exponentialRampToValueAtTime(680, t0 + 0.4);
  mOsc.frequency.exponentialRampToValueAtTime(240, t0 + 1.8);
  const mF = ctx.createBiquadFilter(); mF.type = 'bandpass'; mF.frequency.value = 480; mF.Q.value = 3;
  const mG = ctx.createGain();
  mG.gain.setValueAtTime(0, t0);
  mG.gain.linearRampToValueAtTime(0.09, t0 + 0.15);
  mG.gain.setValueAtTime(0.09, t0 + 1.4);
  mG.gain.linearRampToValueAtTime(0, t0 + 2.0);
  mOsc.connect(mF).connect(mG).connect(ctx.destination);
  mOsc.start(t0); mOsc.stop(t0 + 2.1);
}

function playAuthConfirmed(ctx: AudioContext): void {
  const t0 = ctx.currentTime;
  for (const [delay, freq, dur2] of [[0, 880, 0.18], [0.22, 1108, 0.28]] as const) {
    const osc = ctx.createOscillator(); osc.type = 'sine';
    osc.frequency.value = freq;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t0 + delay);
    env.gain.linearRampToValueAtTime(0.16, t0 + delay + 0.04);
    env.gain.setValueAtTime(0.16, t0 + delay + dur2 * 0.6);
    env.gain.linearRampToValueAtTime(0, t0 + delay + dur2);
    osc.connect(env).connect(ctx.destination);
    osc.start(t0 + delay); osc.stop(t0 + delay + dur2 + 0.05);
  }
  const fOsc = ctx.createOscillator(); fOsc.type = 'triangle';
  fOsc.frequency.setValueAtTime(440, t0 + 0.05);
  fOsc.frequency.linearRampToValueAtTime(554, t0 + 0.35);
  const fF = ctx.createBiquadFilter(); fF.type = 'peaking'; fF.frequency.value = 800; fF.gain.value = 8;
  const fG = ctx.createGain();
  fG.gain.setValueAtTime(0, t0 + 0.05);
  fG.gain.linearRampToValueAtTime(0.08, t0 + 0.12);
  fG.gain.linearRampToValueAtTime(0, t0 + 0.42);
  fOsc.connect(fF).connect(fG).connect(ctx.destination);
  fOsc.start(t0 + 0.05); fOsc.stop(t0 + 0.45);
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
  boltRetractStart: number | null;
  statusText:       string;
  statusAlpha:      number;
  fingerAlpha:      number;
}

function initState(): AnimState {
  return {
    scanner:          'idle',
    glowPhase:        0,
    boltRetractStart: null,
    statusText:       '',
    statusAlpha:      0,
    fingerAlpha:      0.44,
  };
}

// ── CSS ───────────────────────────────────────────────────────────────────────

function injectStyles(): void {
  if (document.getElementById('vault-intro-css')) return;
  const s = document.createElement('style');
  s.id = 'vault-intro-css';
  s.textContent = `
    @keyframes vi-fadein {
      from { opacity:0; }
      to   { opacity:1; }
    }
  `;
  document.head.appendChild(s);
}

// ── Three.js vault scene ──────────────────────────────────────────────────────

// Per-bolt config: base world position, slide direction (unit vector)
interface BoltCfg { x: number; y: number; dx: number; dy: number; rz: number; }
const BOLT_CFG: BoltCfg[] = [
  { x:  0,    y:  2.10, dx:  0, dy:  1, rz: 0            },  // N
  { x:  2.10, y:  0,    dx:  1, dy:  0, rz: -Math.PI / 2 },  // E
  { x:  0,    y: -2.10, dx:  0, dy: -1, rz:  Math.PI     },  // S
  { x: -2.10, y:  0,    dx: -1, dy:  0, rz:  Math.PI / 2 },  // W
];

interface VaultScene {
  renderer:      THREE.WebGLRenderer;
  scene:         THREE.Scene;
  camera:        THREE.PerspectiveCamera;
  doorGroup:     THREE.Group;
  boltGroups:    THREE.Group[];
  scannerRing:   THREE.Mesh;
  scanArc:       THREE.Mesh;
  ledMeshes:     THREE.Mesh[];
  ledLight:      THREE.PointLight;
  fpCanvas:      HTMLCanvasElement;
  fpTexture:     THREE.CanvasTexture;
  fpMesh:        THREE.Mesh;
  interiorLight: THREE.PointLight;
  cameraStartZ:  number;
}

function buildVaultScene(canvas: HTMLCanvasElement): VaultScene {
  const w = window.innerWidth;
  const h = window.innerHeight;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050709);
  scene.fog = new THREE.Fog(0x050709, 8, 18);

  const camera = new THREE.PerspectiveCamera(52, w / h, 0.1, 50);
  const cameraStartZ = 5.0;
  camera.position.set(0, 0.1, cameraStartZ);
  camera.lookAt(0, 0, 0);

  // ── Lighting ─────────────────────────────────────────────────────────────
  scene.add(new THREE.AmbientLight(0x07090e, 0.6));

  // Main overhead-left key light (cold industrial fluorescent)
  const keyLight = new THREE.DirectionalLight(0xb0ccee, 2.4);
  keyLight.position.set(1.5, 5, 4);
  scene.add(keyLight);

  // Left rim fill
  const rimL = new THREE.DirectionalLight(0x3a506a, 0.9);
  rimL.position.set(-5, 2, 2);
  scene.add(rimL);

  // Right counter-light (very subtle)
  const rimR = new THREE.DirectionalLight(0x1e2830, 0.35);
  rimR.position.set(4, -2, 1);
  scene.add(rimR);

  // Dynamic scanner LED glow (intensity driven per-frame)
  const ledLight = new THREE.PointLight(0x4090ff, 0.15, 4.5);
  ledLight.position.set(0, 0, 1.8);
  scene.add(ledLight);

  // Vault interior light (off initially, floods on door open)
  const interiorLight = new THREE.PointLight(0xa0c8ff, 0, 18);
  interiorLight.position.set(0, 0, -5);
  scene.add(interiorLight);

  // ── Room ─────────────────────────────────────────────────────────────────
  buildRoom(scene);

  // ── Shared materials ─────────────────────────────────────────────────────
  const steelMat = new THREE.MeshStandardMaterial({
    color: 0x282e38,
    metalness: 0.82,
    roughness: 0.30,
  });
  const chromeMat = new THREE.MeshStandardMaterial({
    color: 0x58687a,
    metalness: 0.96,
    roughness: 0.07,
  });
  const darkMat = new THREE.MeshStandardMaterial({
    color: 0x040507,
    metalness: 0.62,
    roughness: 0.85,
  });
  const boltMat = new THREE.MeshStandardMaterial({
    color: 0x38424e,
    metalness: 0.84,
    roughness: 0.24,
  });
  const pistonMat = new THREE.MeshStandardMaterial({
    color: 0x526070,
    metalness: 0.90,
    roughness: 0.16,
  });

  // ── Door group ───────────────────────────────────────────────────────────
  const doorGroup = new THREE.Group();
  scene.add(doorGroup);

  // Main circular door disc (thick cylinder, flat face toward camera)
  const doorDisc = new THREE.Mesh(
    new THREE.CylinderGeometry(2.26, 2.26, 0.30, 96, 1, false),
    steelMat,
  );
  doorDisc.rotation.x = Math.PI / 2;
  doorDisc.position.z = -0.15;
  doorGroup.add(doorDisc);

  // Outer machined collar ring (polished chrome)
  const collar = new THREE.Mesh(
    new THREE.TorusGeometry(2.26, 0.10, 20, 96),
    chromeMat,
  );
  collar.position.z = 0.04;
  doorGroup.add(collar);

  // Two concentric decorative groove rings
  for (const [r, rw] of [[1.78, 0.032], [1.38, 0.026]] as const) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(r, rw, 14, 80),
      chromeMat,
    );
    ring.position.z = 0.10;
    doorGroup.add(ring);
  }

  // Scanner housing (dark recessed center)
  const housing = new THREE.Mesh(
    new THREE.CylinderGeometry(1.06, 1.06, 0.22, 64, 1, false),
    darkMat,
  );
  housing.rotation.x = Math.PI / 2;
  housing.position.z = -0.02;
  doorGroup.add(housing);

  // Scanner biometric glass pad (very dark, subtly glossy)
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x060208,
    metalness: 0.30,
    roughness: 0.88,
  });
  const glass = new THREE.Mesh(
    new THREE.CylinderGeometry(0.87, 0.87, 0.04, 64, 1, false),
    glassMat,
  );
  glass.rotation.x = Math.PI / 2;
  glass.position.z = 0.05;
  doorGroup.add(glass);

  // Scanner outer rim ring (bright chrome)
  const scanRim = new THREE.Mesh(
    new THREE.TorusGeometry(1.06, 0.052, 18, 80),
    chromeMat,
  );
  scanRim.position.z = 0.07;
  doorGroup.add(scanRim);

  // Main scanner ring — 3D torus, slightly tilted for depth
  const scannerRingMat = new THREE.MeshStandardMaterial({
    color: 0x141c24,
    metalness: 0.90,
    roughness: 0.15,
    emissive: new THREE.Color(0x1a0408),
    emissiveIntensity: 0.5,
  });
  const scannerRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.91, 0.075, 24, 90),
    scannerRingMat,
  );
  scannerRing.rotation.x = 0.20;
  scannerRing.position.z = 0.09;
  doorGroup.add(scannerRing);

  // Rotating scan arc (partial torus, glows during active scanning)
  const scanArcMat = new THREE.MeshStandardMaterial({
    color: 0x00d4ff,
    emissive: new THREE.Color(0x00d4ff),
    emissiveIntensity: 3.0,
    transparent: true,
    opacity: 0,
  });
  const scanArc = new THREE.Mesh(
    new THREE.TorusGeometry(0.87, 0.013, 10, 80, Math.PI * 1.55),
    scanArcMat,
  );
  scanArc.position.z = 0.14;
  doorGroup.add(scanArc);

  // ── LED panels (12, in ring around scanner) ───────────────────────────────
  const LED_COUNT  = 12;
  const LED_RING_R = 1.22;
  const ledMeshes: THREE.Mesh[] = [];

  for (let i = 0; i < LED_COUNT; i++) {
    const angle = (i / LED_COUNT) * Math.PI * 2 - Math.PI / 2;
    const lx = Math.cos(angle) * LED_RING_R;
    const ly = Math.sin(angle) * LED_RING_R;

    // Dark recessed housing
    const ledHousing = new THREE.Mesh(
      new THREE.BoxGeometry(0.094, 0.094, 0.022),
      darkMat,
    );
    ledHousing.position.set(lx, ly, 0.076);
    doorGroup.add(ledHousing);

    // Emissive LED face (cloned mat per LED so color/intensity is independent)
    const ledMat = new THREE.MeshStandardMaterial({
      color: 0xd0e8ff,
      emissive: new THREE.Color(0xd0e8ff),
      emissiveIntensity: 1.4,
      metalness: 0.05,
      roughness: 0.50,
    });
    const led = new THREE.Mesh(new THREE.BoxGeometry(0.066, 0.066, 0.018), ledMat);
    led.position.set(lx, ly, 0.089);
    doorGroup.add(led);
    ledMeshes.push(led);
  }

  // ── 4 Bolt arm assemblies (N / E / S / W) ────────────────────────────────
  const boltGroups: THREE.Group[] = [];

  for (const cfg of BOLT_CFG) {
    const bg = new THREE.Group();
    bg.position.set(cfg.x, cfg.y, 0.06);
    bg.rotation.z = cfg.rz;

    // Main arm body (tall, narrow, rectangular)
    const arm = new THREE.Mesh(
      new THREE.BoxGeometry(0.42, 0.92, 0.22),
      boltMat,
    );
    bg.add(arm);

    // Machined horizontal slots (detail)
    const slotMat = new THREE.MeshStandardMaterial({
      color: 0x020304,
      metalness: 0.55,
      roughness: 0.90,
    });
    for (let s = 0; s < 3; s++) {
      const slot = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.014, 0.24), slotMat);
      slot.position.y = -0.22 + s * 0.22;
      bg.add(slot);
    }

    // Top face highlight (bright bevel)
    const bevel = new THREE.Mesh(
      new THREE.BoxGeometry(0.42, 0.008, 0.22),
      new THREE.MeshStandardMaterial({ color: 0x7090a8, metalness: 0.95, roughness: 0.08 }),
    );
    bevel.position.y = 0.46;
    bg.add(bevel);

    // Piston tip (darker, at the inner/door-face end)
    const tip = new THREE.Mesh(
      new THREE.BoxGeometry(0.36, 0.06, 0.18),
      pistonMat,
    );
    tip.position.y = -0.49;
    bg.add(tip);

    doorGroup.add(bg);
    boltGroups.push(bg);
  }

  // ── Vertical center piston rod ────────────────────────────────────────────
  const rod = new THREE.Mesh(
    new THREE.CylinderGeometry(0.090, 0.090, 6.0, 24, 1, false),
    pistonMat,
  );
  rod.position.set(0, 0, -0.03);
  doorGroup.add(rod);

  // Piston segment joint rings
  for (let j = -2; j <= 2; j++) {
    const joint = new THREE.Mesh(
      new THREE.TorusGeometry(0.092, 0.020, 10, 24),
      chromeMat,
    );
    joint.rotation.x = Math.PI / 2;
    joint.position.set(0, j * 0.70, -0.01);
    doorGroup.add(joint);
  }

  // ── Ball joints (E / W hinge attachment points) ───────────────────────────
  for (const bx of [-2.26, 2.26]) {
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.17, 24, 24),
      chromeMat,
    );
    ball.position.set(bx, 0, 0.06);
    doorGroup.add(ball);
  }

  // ── Fingerprint texture plane ─────────────────────────────────────────────
  const fpCanvas = document.createElement('canvas');
  fpCanvas.width = fpCanvas.height = 256;
  const fpTexture = new THREE.CanvasTexture(fpCanvas);
  fpTexture.premultiplyAlpha = true;

  const fpMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.96, 0.96),
    new THREE.MeshBasicMaterial({
      map: fpTexture,
      transparent: true,
      depthWrite: false,
    }),
  );
  fpMesh.position.z = 0.12;
  doorGroup.add(fpMesh);

  return {
    renderer,
    scene,
    camera,
    doorGroup,
    boltGroups,
    scannerRing,
    scanArc,
    ledMeshes,
    ledLight,
    fpCanvas,
    fpTexture,
    fpMesh,
    interiorLight,
    cameraStartZ,
  };
}

// ── Room geometry ─────────────────────────────────────────────────────────────

function buildRoom(scene: THREE.Scene): void {
  const wallMat = new THREE.MeshStandardMaterial({
    color: 0x070910,
    roughness: 0.96,
    metalness: 0.02,
  });
  const floorMat = new THREE.MeshStandardMaterial({
    color: 0x060810,
    roughness: 0.91,
    metalness: 0.05,
  });

  // Back wall (concrete, behind door frame)
  const bwall = new THREE.Mesh(new THREE.PlaneGeometry(28, 16), wallMat);
  bwall.position.z = -3.4;
  scene.add(bwall);

  // Floor
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(28, 11), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -3.1;
  scene.add(floor);

  // Ceiling
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(28, 11), wallMat);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = 3.3;
  scene.add(ceil);

  // Side walls
  for (const [sign, angle] of [[-1, Math.PI / 2], [1, -Math.PI / 2]] as [number, number][]) {
    const w = new THREE.Mesh(new THREE.PlaneGeometry(11, 16), wallMat);
    w.rotation.y = angle;
    w.position.x = sign * 7;
    scene.add(w);
  }

  // Overhead fluorescent fixture
  const fixMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: new THREE.Color(0xd0e8ff),
    emissiveIntensity: 0.85,
  });
  const fixture = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.055, 0.42), fixMat);
  fixture.position.set(0, 3.24, -1.0);
  scene.add(fixture);

  // Overhead point light to simulate the fixture
  const fixLight = new THREE.PointLight(0xb8d8f0, 2.0, 15);
  fixLight.position.set(0, 3.1, -1.0);
  scene.add(fixLight);

  // Vault frame collar (thick machined ring around the door opening in the back wall)
  const recessMat = new THREE.MeshStandardMaterial({
    color: 0x0c1018,
    metalness: 0.82,
    roughness: 0.35,
  });
  const frameCollar = new THREE.Mesh(
    new THREE.TorusGeometry(2.52, 0.42, 20, 96),
    recessMat,
  );
  frameCollar.position.z = -2.2;
  scene.add(frameCollar);

  // Cylindrical recess tunnel (the deep opening behind the door)
  const tunnel = new THREE.Mesh(
    new THREE.CylinderGeometry(2.52, 2.52, 2.4, 64, 1, true),
    recessMat,
  );
  tunnel.rotation.x = Math.PI / 2;
  tunnel.position.z = -1.2;
  scene.add(tunnel);
}

// ── Fingerprint texture update ────────────────────────────────────────────────

function updateFingerprintTexture(vs: VaultScene, st: AnimState): void {
  const { fpCanvas, fpTexture } = vs;
  const size = fpCanvas.width;
  const c = fpCanvas.getContext('2d')!;
  c.clearRect(0, 0, size, size);

  if (st.fingerAlpha < 0.01) { fpTexture.needsUpdate = true; return; }

  const isSuccess = st.scanner === 'success';
  const isActive  = st.scanner === 'warmup' || st.scanner === 'peak';
  const fpRGB = isSuccess ? '0,210,140' : (isActive ? '0,210,240' : '220,40,10');

  const fpScale = 2.8;
  const fpOX = size / 2 - 24 * fpScale;
  const fpOY = size / 2 - 24 * fpScale;

  c.save();
  c.translate(fpOX, fpOY);
  c.scale(fpScale, fpScale);

  // Wide neon bloom
  c.save(); c.filter = 'blur(9px)';
  c.globalAlpha = st.fingerAlpha * 0.68;
  c.strokeStyle = `rgba(${fpRGB},1)`; c.lineWidth = 2.2; c.lineCap = 'round';
  for (const d of FP_PATHS) c.stroke(new Path2D(d));
  c.restore();

  // Tight inner glow
  c.save(); c.filter = 'blur(3.5px)';
  c.globalAlpha = st.fingerAlpha * 0.90;
  c.strokeStyle = `rgba(${fpRGB},1)`; c.lineWidth = 1.3; c.lineCap = 'round';
  for (const d of FP_PATHS) c.stroke(new Path2D(d));
  c.restore();

  // Crisp line
  c.globalAlpha = st.fingerAlpha;
  c.strokeStyle = `rgba(${fpRGB},1)`; c.lineWidth = 0.72; c.lineCap = 'round';
  for (const d of FP_PATHS) c.stroke(new Path2D(d));
  c.restore();

  fpTexture.needsUpdate = true;
}

// ── Per-frame render ──────────────────────────────────────────────────────────

function renderVaultFrame(vs: VaultScene, st: AnimState, boltProgress: number[]): void {
  const { renderer, scene, camera, boltGroups, scannerRing, scanArc,
          ledMeshes, ledLight, interiorLight } = vs;

  const isSuccess = st.scanner === 'success';
  const isActive  = st.scanner === 'warmup' || st.scanner === 'peak';
  const glow      = (Math.sin(st.glowPhase) + 1) * 0.5;
  const pulse     = isSuccess ? 0.30 : (0.60 + Math.sin(st.glowPhase * 1.2) * 0.28);

  updateFingerprintTexture(vs, st);

  // ── LEDs ──
  const ledColor = isSuccess
    ? new THREE.Color(0.04, 0.85, 0.52)
    : new THREE.Color(0.82, 0.93, 1.00);
  const ledIntensity = 0.70 + pulse * 1.70;
  for (const led of ledMeshes) {
    const m = led.material as THREE.MeshStandardMaterial;
    m.emissive.copy(ledColor);
    m.emissiveIntensity = ledIntensity;
  }
  ledLight.color.copy(isSuccess ? new THREE.Color(0, 0.85, 0.50) : new THREE.Color(0.25, 0.55, 1.00));
  ledLight.intensity = isActive ? (0.55 + pulse * 1.0) : (isSuccess ? 0.50 : 0.15);

  // ── Scanner ring ──
  const ringMat = scannerRing.material as THREE.MeshStandardMaterial;
  ringMat.emissive.copy(
    isSuccess ? new THREE.Color(0, 0.80, 0.50)
    : isActive ? new THREE.Color(0, 0.80, 1.00)
    : new THREE.Color(0.60, 0.10, 0.10),
  );
  ringMat.emissiveIntensity = isActive ? (0.40 + pulse * 0.60) : (isSuccess ? 0.55 : 0.20);

  // Slow continuous rotation for a "living" feel
  scannerRing.rotation.z += 0.003;

  // ── Scan arc (only during active scan) ──
  const arcMat = scanArc.material as THREE.MeshStandardMaterial;
  arcMat.opacity = isActive ? 0.88 : 0;
  if (isActive) {
    arcMat.emissiveIntensity = 1.8 + glow * 1.4;
    scanArc.rotation.z = st.glowPhase * 2.2;
  }

  // ── Bolt retraction ──
  for (let i = 0; i < 4; i++) {
    const prog  = boltProgress[i] ?? 0;
    const cfg   = BOLT_CFG[i]!;
    const slide = prog * 1.15;
    boltGroups[i]!.position.set(cfg.x + cfg.dx * slide, cfg.y + cfg.dy * slide, 0.06);
    boltGroups[i]!.visible = prog < 0.95;
  }

  // Subtle camera breathe
  camera.position.y = 0.1 + Math.sin(st.glowPhase * 0.5) * 0.007;
  camera.lookAt(0, 0, 0);

  // Interior vault light off until door open
  interiorLight.intensity = Math.max(0, interiorLight.intensity);

  renderer.render(scene, camera);
}

// ── Overlay ───────────────────────────────────────────────────────────────────

type OverlayRefs = {
  overlay:  HTMLDivElement;
  scanBtn:  HTMLDivElement;
  quitBtn:  HTMLButtonElement;
  statusEl: HTMLDivElement;
  flashEl:  HTMLDivElement;
  state:    AnimState;
  vault:    VaultScene;
};

function buildOverlay(): OverlayRefs {
  injectStyles();
  const state = initState();

  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:9999;
    background:#050709;
    overflow:hidden;
    animation:vi-fadein 1.1s cubic-bezier(0.16,1,0.3,1) both;
  `;

  // Three.js fills entire overlay
  const threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;display:block;';
  overlay.appendChild(threeCanvas);

  // Scanner hit target (centered circle for click/tap)
  const scanBtn = document.createElement('div');
  scanBtn.style.cssText = `
    position:absolute;
    top:50%;left:50%;
    width:200px;height:200px;
    transform:translate(-50%,-50%);
    border-radius:50%;
    cursor:pointer;z-index:2;
  `;
  overlay.appendChild(scanBtn);

  // Status badge (positioned above scanner ring center)
  const statusEl = document.createElement('div');
  statusEl.style.cssText = `
    position:absolute;
    top:calc(50% - 22vmin);left:50%;
    transform:translateX(-50%);
    padding:5px 18px;
    background:rgba(0,6,16,0.88);
    border:1px solid rgba(0,210,240,0.55);
    border-radius:3px;
    font-family:"SF Pro Display",-apple-system,BlinkMacSystemFont,monospace;
    font-size:clamp(8px,1.5vmin,11px);font-weight:600;letter-spacing:.14em;
    color:rgba(0,210,240,1);
    pointer-events:none;z-index:3;
    opacity:0;
    transition:opacity 0.28s ease;
  `;
  overlay.appendChild(statusEl);

  // White flash overlay (for door-open sequence)
  const flashEl = document.createElement('div');
  flashEl.style.cssText = `
    position:fixed;inset:0;z-index:10000;
    background:radial-gradient(circle,
      rgba(255,255,255,1.0) 0%,
      rgba(210,238,255,0.98) 16%,
      rgba(120,190,255,0.70) 44%,
      rgba(0,0,0,0) 78%
    );
    opacity:0;pointer-events:none;
  `;
  overlay.appendChild(flashEl);

  // Quit button
  const quitBtn = document.createElement('button');
  quitBtn.textContent = 'Quit';
  quitBtn.style.cssText = `
    position:absolute;bottom:28px;left:50%;transform:translateX(-50%);
    background:none;border:none;
    font-size:12px;font-weight:500;letter-spacing:.08em;
    color:rgba(120,140,160,0.32);cursor:pointer;padding:6px 14px;
    transition:color .2s;z-index:4;
  `;
  quitBtn.addEventListener('mouseenter', () => { quitBtn.style.color = 'rgba(180,200,220,0.62)'; });
  quitBtn.addEventListener('mouseleave', () => { quitBtn.style.color = 'rgba(120,140,160,0.32)'; });
  overlay.appendChild(quitBtn);

  // Build Three.js scene (renderer attaches to threeCanvas)
  const vault = buildVaultScene(threeCanvas);

  return { overlay, scanBtn, quitBtn, statusEl, flashEl, state, vault };
}

// ── Render loop ───────────────────────────────────────────────────────────────

function startLoop(refs: OverlayRefs): () => void {
  let rafId = 0;

  const loop = (now: number) => {
    refs.state.glowPhase = (refs.state.glowPhase + 0.028) % (Math.PI * 2);

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

    // Update status badge HTML
    const { state, statusEl } = refs;
    if (state.statusAlpha > 0.01 && state.scanner !== 'idle') {
      statusEl.style.opacity = String(state.statusAlpha);
      statusEl.textContent   = state.statusText;
      const isSuccess = state.scanner === 'success';
      const rgb = isSuccess ? '0,220,170' : '0,210,240';
      statusEl.style.color       = `rgba(${rgb},1)`;
      statusEl.style.borderColor = `rgba(${rgb},0.55)`;
    } else {
      statusEl.style.opacity = '0';
    }

    renderVaultFrame(refs.vault, state, bp);
    rafId = requestAnimationFrame(loop);
  };

  rafId = requestAnimationFrame(loop);
  return () => cancelAnimationFrame(rafId);
}

function handleResize(refs: OverlayRefs): void {
  const { vault } = refs;
  vault.renderer.setSize(window.innerWidth, window.innerHeight);
  vault.camera.aspect = window.innerWidth / window.innerHeight;
  vault.camera.updateProjectionMatrix();
}

// ── Scanner state helpers ─────────────────────────────────────────────────────

function setIdle(st: AnimState): void {
  st.scanner     = 'idle';
  st.statusText  = '';
  st.statusAlpha = 0;
  st.fingerAlpha = 0.38;
}

function setWarmup(st: AnimState): void {
  st.scanner     = 'warmup';
  st.statusText  = 'SCANNING…';
  st.statusAlpha = 0.82;
  st.fingerAlpha = 0.52;
}

function setPeak(st: AnimState): void {
  st.scanner     = 'peak';
  st.statusText  = 'PLACE FINGER ON SENSOR';
  st.statusAlpha = 0.92;
  st.fingerAlpha = 0.65;
}

function setError(st: AnimState, msg: string): void {
  st.scanner     = 'error';
  st.statusText  = msg;
  st.statusAlpha = 0.88;
  st.fingerAlpha = 0.32;
}

function setSuccess(st: AnimState): void {
  st.scanner     = 'success';
  st.statusText  = 'ACCESS GRANTED';
  st.statusAlpha = 0.92;
  st.fingerAlpha = 0.75;
}

// ── Opening sequence ──────────────────────────────────────────────────────────

async function playOpenSequence(
  refs: OverlayRefs,
  audioCtx: AudioContext | null,
  appReady?: Promise<void>,
): Promise<void> {
  setSuccess(refs.state);
  await sleep(420);

  if (audioCtx) { playAuthConfirmed(audioCtx); playMotorWhine(audioCtx); playBoltRetracts(audioCtx); }

  refs.state.boltRetractStart = performance.now();
  await sleep(820);

  if (appReady) await appReady;
  await sleep(60);

  if (audioCtx) playDoorOpen(audioCtx);

  // Animate camera push forward + interior light flood
  const { vault, flashEl, overlay } = refs;
  const startZ    = vault.camera.position.z;
  const duration  = 2200;
  const t0        = performance.now();

  await new Promise<void>(resolve => {
    const animate = (now: number) => {
      const prog = Math.min(1, (now - t0) / duration);
      // Ease in-out quad
      const ease = prog < 0.5 ? 2 * prog * prog : 1 - Math.pow(-2 * prog + 2, 2) / 2;

      vault.camera.position.z = startZ - ease * 3.2;
      vault.camera.lookAt(0, 0, 0);
      vault.interiorLight.intensity = ease * 20;

      // Flash overlay ramps in after 38% progress
      if (prog > 0.38) {
        const fp = (prog - 0.38) / 0.38;
        flashEl.style.opacity = String(Math.min(1, fp * 2.8));
      }

      if (prog < 1) {
        requestAnimationFrame(animate);
      } else {
        resolve();
      }
    };
    requestAnimationFrame(animate);
  });

  // Fade out entire overlay
  overlay.style.transition = 'opacity 1.4s ease';
  overlay.style.opacity    = '0';
  await sleep(1400);
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
  const refs     = buildOverlay();
  const stopLoop = startLoop(refs);
  document.body.appendChild(refs.overlay);

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
