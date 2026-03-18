// Biometric vault intro — Three.js 3D + UnrealBloom post-processing.
// PBR materials with env-map reflections, emissive LEDs/scanner/fingerprint that
// bloom through EffectComposer, and a multi-ring camera-barrel scanner housing.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
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

function createEnvMap(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();

  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 256;
  const c = cv.getContext('2d')!;

  // Dark industrial sky: cold overhead → near-black floor
  const sky = c.createLinearGradient(0, 0, 0, 256);
  sky.addColorStop(0,    '#9ab8d8');
  sky.addColorStop(0.18, '#2e4060');
  sky.addColorStop(0.45, '#0d1220');
  sky.addColorStop(0.75, '#070810');
  sky.addColorStop(1,    '#03040a');
  c.fillStyle = sky; c.fillRect(0, 0, 512, 256);

  // Strong overhead key-light hotspot (upper-left)
  const key = c.createRadialGradient(140, 8, 0, 140, 8, 100);
  key.addColorStop(0,   'rgba(230,245,255,1.0)');
  key.addColorStop(0.4, 'rgba(130,195,240,0.65)');
  key.addColorStop(1,   'rgba(0,0,0,0)');
  c.fillStyle = key; c.fillRect(0, 0, 512, 256);

  // Right counter rim
  const rim = c.createRadialGradient(460, 80, 0, 460, 80, 55);
  rim.addColorStop(0, 'rgba(40,70,130,0.75)');
  rim.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = rim; c.fillRect(0, 0, 512, 256);

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
    @keyframes vi-fadein {
      from { opacity:0; }
      to   { opacity:1; }
    }
  `;
  document.head.appendChild(s);
}

// ── Three.js vault scene ──────────────────────────────────────────────────────

interface BoltCfg { x: number; y: number; dx: number; dy: number; rz: number; }
const BOLT_CFG: BoltCfg[] = [
  { x:  0,    y:  2.28, dx:  0, dy:  1, rz: 0            },  // N
  { x:  2.28, y:  0,    dx:  1, dy:  0, rz: -Math.PI / 2 },  // E
  { x:  0,    y: -2.28, dx:  0, dy: -1, rz:  Math.PI     },  // S
  { x: -2.28, y:  0,    dx: -1, dy:  0, rz:  Math.PI / 2 },  // W
];

interface VaultScene {
  renderer:      THREE.WebGLRenderer;
  composer:      EffectComposer;
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
  flashEl:       HTMLDivElement | null;
  overlayEl:     HTMLDivElement | null;
}

function buildVaultScene(canvas: HTMLCanvasElement): VaultScene {
  const w = window.innerWidth;
  const h = window.innerHeight;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x040608);
  scene.fog = new THREE.Fog(0x040608, 10, 22);
  scene.environment = createEnvMap(renderer);
  scene.environmentIntensity = 0.60;

  const camera = new THREE.PerspectiveCamera(48, w / h, 0.1, 60);
  const cameraStartZ = 6.2;
  camera.position.set(0, -0.15, cameraStartZ);
  camera.lookAt(0, 0, 0);

  // ── Bloom post-processing ─────────────────────────────────────────────────
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 1.6, 0.65, 0.32);
  composer.addPass(bloom);

  // ── Lighting ─────────────────────────────────────────────────────────────
  scene.add(new THREE.AmbientLight(0x06080e, 0.5));

  const keyLight = new THREE.DirectionalLight(0xb0ccee, 4.0);
  keyLight.position.set(2, 6, 5);
  scene.add(keyLight);

  const rimL = new THREE.DirectionalLight(0x3858a0, 1.8);
  rimL.position.set(-6, 2, 2);
  scene.add(rimL);

  const rimR = new THREE.DirectionalLight(0x1e2838, 0.7);
  rimR.position.set(5, -2, 1);
  scene.add(rimR);

  // Dynamic scanner LED glow
  const ledLight = new THREE.PointLight(0x3080ff, 0.2, 5.5);
  ledLight.position.set(0, 0, 2.0);
  scene.add(ledLight);

  // Interior flood (off until door opens)
  const interiorLight = new THREE.PointLight(0xa8c8ff, 0, 20);
  interiorLight.position.set(0, 0, -6);
  scene.add(interiorLight);

  // ── Room ─────────────────────────────────────────────────────────────────
  buildRoom(scene);

  // ── Shared materials ─────────────────────────────────────────────────────
  const steelMat = new THREE.MeshStandardMaterial({
    color: 0x28303a,
    metalness: 0.75,
    roughness: 0.32,
  });
  const chromeMat = new THREE.MeshStandardMaterial({
    color: 0x5c6878,
    metalness: 0.92,
    roughness: 0.10,
  });
  const darkMat = new THREE.MeshStandardMaterial({
    color: 0x030407,
    metalness: 0.58,
    roughness: 0.88,
  });
  const boltMat = new THREE.MeshStandardMaterial({
    color: 0x303a46,
    metalness: 0.88,
    roughness: 0.22,
  });
  const pistonMat = new THREE.MeshStandardMaterial({
    color: 0x4a5c6c,
    metalness: 0.92,
    roughness: 0.14,
  });

  // ── Door group ───────────────────────────────────────────────────────────
  const doorGroup = new THREE.Group();
  scene.add(doorGroup);

  // Main circular door disc
  const doorDisc = new THREE.Mesh(
    new THREE.CylinderGeometry(2.32, 2.32, 0.28, 96, 1, false),
    steelMat,
  );
  doorDisc.rotation.x = Math.PI / 2;
  doorDisc.position.z = -0.14;
  doorGroup.add(doorDisc);

  // Outer machined collar (polished chrome)
  const collar = new THREE.Mesh(
    new THREE.TorusGeometry(2.32, 0.13, 20, 96),
    chromeMat,
  );
  collar.position.z = 0.06;
  doorGroup.add(collar);

  // Large decorative ring (between collar and LED groove)
  const outerRing = new THREE.Mesh(
    new THREE.TorusGeometry(1.94, 0.040, 16, 96),
    chromeMat,
  );
  outerRing.position.z = 0.09;
  doorGroup.add(outerRing);

  // LED groove channel (slightly darker, recessed)
  const ledGroove = new THREE.Mesh(
    new THREE.TorusGeometry(1.56, 0.048, 14, 96),
    new THREE.MeshStandardMaterial({ color: 0x090d14, metalness: 0.80, roughness: 0.60 }),
  );
  ledGroove.position.z = 0.055;
  doorGroup.add(ledGroove);

  // Inner ring between LED groove and scanner barrel
  const innerRing = new THREE.Mesh(
    new THREE.TorusGeometry(1.25, 0.038, 14, 96),
    chromeMat,
  );
  innerRing.position.z = 0.085;
  doorGroup.add(innerRing);

  // ── 12 LED panels ────────────────────────────────────────────────────────
  const LED_COUNT  = 12;
  const LED_RING_R = 1.56;
  const ledMeshes: THREE.Mesh[] = [];

  for (let i = 0; i < LED_COUNT; i++) {
    const angle = (i / LED_COUNT) * Math.PI * 2 - Math.PI / 2;
    const lx = Math.cos(angle) * LED_RING_R;
    const ly = Math.sin(angle) * LED_RING_R;

    // Dark housing recess
    const ledHousing = new THREE.Mesh(
      new THREE.BoxGeometry(0.10, 0.10, 0.024),
      darkMat,
    );
    ledHousing.position.set(lx, ly, 0.065);
    doorGroup.add(ledHousing);

    // Emissive LED face (independent material per LED)
    const ledMat = new THREE.MeshStandardMaterial({
      color: 0xc8e4ff,
      emissive: new THREE.Color(0xc8e4ff),
      emissiveIntensity: 3.5,
      metalness: 0.05,
      roughness: 0.45,
    });
    const led = new THREE.Mesh(new THREE.BoxGeometry(0.070, 0.070, 0.020), ledMat);
    led.position.set(lx, ly, 0.078);
    doorGroup.add(led);
    ledMeshes.push(led);
  }

  // ── Scanner barrel (camera-lens barrel, 5 concentric stepped rings) ───────
  // Each step: outer chrome torus + short cylinder wall stepping inward
  const barrelSteps: Array<{ r: number; z: number; rw: number }> = [
    { r: 1.20, z: 0.10,  rw: 0.055 },
    { r: 1.02, z: 0.00,  rw: 0.048 },
    { r: 0.85, z: -0.09, rw: 0.040 },
    { r: 0.70, z: -0.17, rw: 0.034 },
    { r: 0.57, z: -0.24, rw: 0.028 },
  ];

  for (let si = 0; si < barrelSteps.length; si++) {
    const step = barrelSteps[si]!;
    // Chrome ring face
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(step.r, step.rw, 18, 80),
      chromeMat,
    );
    ring.position.z = step.z;
    doorGroup.add(ring);

    // Cylinder wall between this step and next (the "barrel wall")
    if (si < barrelSteps.length - 1) {
      const next = barrelSteps[si + 1]!;
      const wallH = step.z - next.z;
      const wallR = (step.r + next.r) / 2 - 0.01;
      const wall = new THREE.Mesh(
        new THREE.CylinderGeometry(wallR, wallR, wallH, 64, 1, true),
        steelMat,
      );
      wall.rotation.x = Math.PI / 2;
      wall.position.z = (step.z + next.z) / 2;
      doorGroup.add(wall);
    }
  }

  // Scanner floor (dark glass at deepest recess)
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x040208,
    metalness: 0.25,
    roughness: 0.92,
  });
  const scanFloor = new THREE.Mesh(
    new THREE.CylinderGeometry(0.52, 0.52, 0.04, 64),
    glassMat,
  );
  scanFloor.rotation.x = Math.PI / 2;
  scanFloor.position.z = -0.28;
  doorGroup.add(scanFloor);

  // ── Main scanner ring (glowing torus at entrance to barrel) ───────────────
  const scannerRingMat = new THREE.MeshStandardMaterial({
    color: 0x100c1c,
    metalness: 0.88,
    roughness: 0.12,
    emissive: new THREE.Color(0x1a0308),
    emissiveIntensity: 0.8,
  });
  const scannerRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.88, 0.068, 24, 90),
    scannerRingMat,
  );
  scannerRing.rotation.x = 0.18;
  scannerRing.position.z = 0.10;
  doorGroup.add(scannerRing);

  // Rotating scan arc (partial torus, spins during active scanning)
  const scanArcMat = new THREE.MeshStandardMaterial({
    color: 0x00d4ff,
    emissive: new THREE.Color(0x00d4ff),
    emissiveIntensity: 6.0,
    transparent: true,
    opacity: 0,
  });
  const scanArc = new THREE.Mesh(
    new THREE.TorusGeometry(0.84, 0.011, 10, 80, Math.PI * 1.5),
    scanArcMat,
  );
  scanArc.position.z = 0.15;
  doorGroup.add(scanArc);

  // ── 4 Bolt piston assemblies (N / E / S / W) ─────────────────────────────
  const boltGroups: THREE.Group[] = [];

  for (const cfg of BOLT_CFG) {
    const bg = new THREE.Group();
    bg.position.set(cfg.x, cfg.y, 0.02);
    bg.rotation.z = cfg.rz;

    // Piston body (slender cylinder)
    const piston = new THREE.Mesh(
      new THREE.CylinderGeometry(0.14, 0.14, 0.80, 24),
      boltMat,
    );
    piston.position.y = 0.05;
    bg.add(piston);

    // Piston head (wider flange)
    const head = new THREE.Mesh(
      new THREE.CylinderGeometry(0.20, 0.20, 0.08, 24),
      pistonMat,
    );
    head.position.y = -0.36;
    bg.add(head);

    // Polished tip ring
    const tipRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.17, 0.018, 10, 24),
      chromeMat,
    );
    tipRing.rotation.x = Math.PI / 2;
    tipRing.position.y = -0.36;
    bg.add(tipRing);

    doorGroup.add(bg);
    boltGroups.push(bg);
  }

  // ── Vertical piston rod (center) ──────────────────────────────────────────
  const rod = new THREE.Mesh(
    new THREE.CylinderGeometry(0.075, 0.075, 6.2, 20),
    pistonMat,
  );
  rod.position.set(0, 0, -0.02);
  doorGroup.add(rod);

  for (let j = -2; j <= 2; j++) {
    const jRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.077, 0.016, 10, 20),
      chromeMat,
    );
    jRing.rotation.x = Math.PI / 2;
    jRing.position.set(0, j * 0.72, 0.0);
    doorGroup.add(jRing);
  }

  // ── Wing panels (left / right of circular disc) ───────────────────────────
  buildWingPanels(doorGroup, steelMat, chromeMat, darkMat);

  // ── Fingerprint texture plane ─────────────────────────────────────────────
  const fpCanvas = document.createElement('canvas');
  fpCanvas.width = fpCanvas.height = 512;
  const fpTexture = new THREE.CanvasTexture(fpCanvas);
  fpTexture.colorSpace = THREE.SRGBColorSpace;

  // Emissive material: canvas drives both alpha (via map) and bloom (via emissiveMap)
  const fpMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0, 0, 0),
    map: fpTexture,
    emissive: new THREE.Color(1, 1, 1),
    emissiveMap: fpTexture,
    emissiveIntensity: 4.5,
    transparent: true,
    depthWrite: false,
    metalness: 0,
    roughness: 1,
  });

  const fpMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.88, 0.88),
    fpMat,
  );
  fpMesh.position.z = -0.24;
  doorGroup.add(fpMesh);

  return {
    renderer,
    composer,
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
    flashEl:   null,
    overlayEl: null,
  };
}

// ── Wing panels ───────────────────────────────────────────────────────────────

function buildWingPanels(
  doorGroup: THREE.Group,
  steelMat: THREE.MeshStandardMaterial,
  chromeMat: THREE.MeshStandardMaterial,
  darkMat: THREE.MeshStandardMaterial,
): void {
  const wingW = 1.15;
  const wingH = 4.90;
  const wingD = 0.26;
  const wingCX = 2.32 + 0.12 + wingW / 2;  // gap of 0.12 from disc edge

  for (const side of [-1, 1] as const) {
    const wx = side * wingCX;

    // Main wing body
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(wingW, wingH, wingD),
      steelMat,
    );
    body.position.set(wx, 0, -0.12);
    doorGroup.add(body);

    // Outer chrome edge strip
    const edgeStrip = new THREE.Mesh(
      new THREE.BoxGeometry(0.025, wingH, wingD + 0.01),
      chromeMat,
    );
    edgeStrip.position.set(wx + side * (wingW / 2 - 0.013), 0, -0.12);
    doorGroup.add(edgeStrip);

    // Top/bottom chrome caps
    for (const sy of [-1, 1] as const) {
      const cap = new THREE.Mesh(
        new THREE.BoxGeometry(wingW + 0.025, 0.022, wingD + 0.01),
        chromeMat,
      );
      cap.position.set(wx, sy * (wingH / 2 + 0.011), -0.12);
      doorGroup.add(cap);
    }

    // 3 raised machined panels (portrait rectangles)
    const panelW = wingW * 0.72;
    const panelH = wingH / 3 * 0.76;
    const panelSpacing = wingH / 3;
    for (let pi = 0; pi < 3; pi++) {
      const py = (pi - 1) * panelSpacing;

      // Recessed background
      const recess = new THREE.Mesh(
        new THREE.BoxGeometry(panelW, panelH, 0.005),
        darkMat,
      );
      recess.position.set(wx, py, 0.0);
      doorGroup.add(recess);

      // Panel border frame (chrome outline)
      for (const [bw, bh, bz] of [
        [panelW + 0.03, 0.018, 0.002],  // top
        [panelW + 0.03, 0.018, 0.002],  // bottom
        [0.018, panelH + 0.03, 0.002],  // left
        [0.018, panelH + 0.03, 0.002],  // right
      ] as [number, number, number][]) {
        // Use simplified border: just the torus / plane approach is complex — use BoxGeometry border segments
        void bw; void bh; void bz;
      }

      // Simple chrome border (single outer frame box with inner transparent hole approximated by scaling)
      const border = new THREE.Mesh(
        new THREE.BoxGeometry(panelW + 0.04, panelH + 0.04, 0.018),
        chromeMat,
      );
      border.position.set(wx, py, -0.004);
      doorGroup.add(border);

      // Raised inner panel face
      const face = new THREE.Mesh(
        new THREE.BoxGeometry(panelW - 0.02, panelH - 0.02, 0.022),
        steelMat,
      );
      face.position.set(wx, py, 0.006);
      doorGroup.add(face);

      // Horizontal detail grooves on panel
      for (let gi = 0; gi < 3; gi++) {
        const gY = py + (gi - 1) * (panelH / 4);
        const groove = new THREE.Mesh(
          new THREE.BoxGeometry(panelW * 0.80, 0.008, 0.026),
          darkMat,
        );
        groove.position.set(wx, gY, 0.018);
        doorGroup.add(groove);
      }

      // Small indicator LED on each panel (top of panel)
      const indMat = new THREE.MeshStandardMaterial({
        color: 0xc0d8ff,
        emissive: new THREE.Color(0xc0d8ff),
        emissiveIntensity: 2.5,
        metalness: 0,
        roughness: 0.5,
      });
      const ind = new THREE.Mesh(
        new THREE.BoxGeometry(0.045, 0.018, 0.024),
        indMat,
      );
      ind.position.set(wx + side * (panelW / 2 - 0.04), py + panelH / 2 - 0.06, 0.022);
      doorGroup.add(ind);
    }

    // Diagonal connection flange (triangular wedge between wing and disc collar)
    // Approximated as a tapered box at the inner edge
    const flange = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, wingH * 0.85, 0.14),
      steelMat,
    );
    flange.position.set(wx - side * (wingW / 2 + 0.06), 0, -0.10);
    doorGroup.add(flange);
  }
}

// ── Room geometry ─────────────────────────────────────────────────────────────

function buildRoom(scene: THREE.Scene): void {
  const wallMat = new THREE.MeshStandardMaterial({
    color: 0x06080f,
    roughness: 0.94,
    metalness: 0.03,
  });
  const panelMat = new THREE.MeshStandardMaterial({
    color: 0x0a0e18,
    roughness: 0.88,
    metalness: 0.12,
  });

  // Back wall
  const bwall = new THREE.Mesh(new THREE.PlaneGeometry(32, 18), wallMat);
  bwall.position.z = -4.0;
  scene.add(bwall);

  // Floor (slightly reflective metal grating)
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(32, 14), panelMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -3.2;
  scene.add(floor);

  // Ceiling
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(32, 14), wallMat);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = 3.8;
  scene.add(ceil);

  // Side walls with structural rib panels
  for (const [sign, angle] of [[-1, Math.PI / 2], [1, -Math.PI / 2]] as [number, number][]) {
    const w = new THREE.Mesh(new THREE.PlaneGeometry(14, 18), wallMat);
    w.rotation.y = angle;
    w.position.x = sign * 8;
    scene.add(w);

    // Structural ribs on side walls
    for (let ri = -2; ri <= 2; ri++) {
      const rib = new THREE.Mesh(
        new THREE.BoxGeometry(0.08, 6.0, 0.10),
        panelMat,
      );
      rib.position.set(sign * 7.95, 0, ri * 1.2 - 0.5);
      rib.rotation.y = angle;
      scene.add(rib);
    }
  }

  // Overhead fluorescent fixture
  const fixMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: new THREE.Color(0xd8eeff),
    emissiveIntensity: 1.2,
  });
  for (const fz of [-0.8, -2.0]) {
    const fix = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.06, 0.38), fixMat);
    fix.position.set(0, 3.72, fz);
    scene.add(fix);
    const fixLight = new THREE.PointLight(0xc0d8f0, 2.2, 14);
    fixLight.position.set(0, 3.55, fz);
    scene.add(fixLight);
  }

  // Vault frame collar (machined steel ring around door opening)
  const recessMat = new THREE.MeshStandardMaterial({
    color: 0x0a0f18,
    metalness: 0.85,
    roughness: 0.28,
  });
  const frameCollar = new THREE.Mesh(
    new THREE.TorusGeometry(2.60, 0.48, 20, 96),
    recessMat,
  );
  frameCollar.position.z = -2.6;
  scene.add(frameCollar);

  // Cylindrical tunnel behind door
  const tunnel = new THREE.Mesh(
    new THREE.CylinderGeometry(2.60, 2.60, 2.8, 64, 1, true),
    recessMat,
  );
  tunnel.rotation.x = Math.PI / 2;
  tunnel.position.z = -1.4;
  scene.add(tunnel);

  // Chrome accent strip at floor/wall junction
  const floorMolding = new THREE.Mesh(
    new THREE.BoxGeometry(16, 0.03, 0.06),
    new THREE.MeshStandardMaterial({ color: 0x303c48, metalness: 0.92, roughness: 0.10 }),
  );
  floorMolding.position.set(0, -3.185, -1.0);
  scene.add(floorMolding);
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
  const fpRGB = isSuccess ? '0,220,150' : (isActive ? '0,210,240' : '230,40,8');

  const fpScale = 8.2;
  const fpOX = size / 2 - 24 * fpScale;
  const fpOY = size / 2 - 24 * fpScale;

  c.save();
  c.translate(fpOX, fpOY);
  c.scale(fpScale, fpScale);

  // Outermost bloom halo
  c.save(); c.filter = 'blur(18px)';
  c.globalAlpha = st.fingerAlpha * 0.50;
  c.strokeStyle = `rgba(${fpRGB},1)`; c.lineWidth = 2.5; c.lineCap = 'round';
  for (const d of FP_PATHS) c.stroke(new Path2D(d));
  c.restore();

  // Mid bloom
  c.save(); c.filter = 'blur(8px)';
  c.globalAlpha = st.fingerAlpha * 0.75;
  c.strokeStyle = `rgba(${fpRGB},1)`; c.lineWidth = 1.8; c.lineCap = 'round';
  for (const d of FP_PATHS) c.stroke(new Path2D(d));
  c.restore();

  // Tight inner glow
  c.save(); c.filter = 'blur(3px)';
  c.globalAlpha = st.fingerAlpha * 0.92;
  c.strokeStyle = `rgba(${fpRGB},1)`; c.lineWidth = 1.1; c.lineCap = 'round';
  for (const d of FP_PATHS) c.stroke(new Path2D(d));
  c.restore();

  // Crisp bright core line
  c.globalAlpha = st.fingerAlpha;
  c.strokeStyle = `rgba(${fpRGB},1)`; c.lineWidth = 0.58; c.lineCap = 'round';
  for (const d of FP_PATHS) c.stroke(new Path2D(d));
  c.restore();

  fpTexture.needsUpdate = true;
}

// ── Per-frame render ──────────────────────────────────────────────────────────

const OPEN_DURATION = 2200;

function renderVaultFrame(vs: VaultScene, st: AnimState, boltProgress: number[], now: number): void {
  const { boltGroups, scannerRing, scanArc,
          ledMeshes, ledLight, interiorLight } = vs;

  const isSuccess = st.scanner === 'success';
  const isActive  = st.scanner === 'warmup' || st.scanner === 'peak';
  const isError   = st.scanner === 'error';
  const glow      = (Math.sin(st.glowPhase) + 1) * 0.5;
  const pulse     = isSuccess ? 0.25 : (0.55 + Math.sin(st.glowPhase * 1.2) * 0.32);

  updateFingerprintTexture(vs, st);

  // ── LEDs ──
  const ledColor = isSuccess
    ? new THREE.Color(0.04, 0.95, 0.55)
    : isError
    ? new THREE.Color(0.90, 0.18, 0.04)
    : new THREE.Color(0.78, 0.92, 1.00);
  const ledIntensity = 2.5 + pulse * 3.0;

  for (const led of ledMeshes) {
    const m = led.material as THREE.MeshStandardMaterial;
    m.emissive.copy(ledColor);
    m.emissiveIntensity = ledIntensity;
  }
  ledLight.color.copy(
    isSuccess ? new THREE.Color(0, 0.95, 0.52)
    : isError  ? new THREE.Color(0.90, 0.15, 0.04)
    : new THREE.Color(0.22, 0.52, 1.00),
  );
  ledLight.intensity = isActive ? (1.2 + pulse * 1.8) : (isSuccess ? 1.0 : 0.25);

  // ── Scanner ring ──
  const ringMat = scannerRing.material as THREE.MeshStandardMaterial;
  ringMat.emissive.copy(
    isSuccess ? new THREE.Color(0, 0.85, 0.52)
    : isActive ? new THREE.Color(0, 0.75, 1.00)
    : isError  ? new THREE.Color(0.80, 0.12, 0.04)
    : new THREE.Color(0.55, 0.08, 0.08),
  );
  ringMat.emissiveIntensity = isActive
    ? (1.4 + pulse * 2.2)
    : (isSuccess ? 2.0 : (isError ? 1.6 : 0.35));

  scannerRing.rotation.z += 0.0025;

  // ── Scan arc ──
  const arcMat = scanArc.material as THREE.MeshStandardMaterial;
  arcMat.opacity = isActive ? 0.92 : 0;
  if (isActive) {
    arcMat.emissiveIntensity = 4.0 + glow * 2.5;
    scanArc.rotation.z = st.glowPhase * 2.4;
  }

  // ── Bolt retraction ──
  for (let i = 0; i < 4; i++) {
    const prog  = boltProgress[i] ?? 0;
    const cfg   = BOLT_CFG[i]!;
    const slide = prog * 1.0;
    boltGroups[i]!.position.set(cfg.x + cfg.dx * slide, cfg.y + cfg.dy * slide, 0.02);
    boltGroups[i]!.visible = prog < 0.92;
  }

  // ── Door-open animation ──
  if (st.openStartTime !== null) {
    const prog = Math.min(1, (now - st.openStartTime) / OPEN_DURATION);
    const ease = prog < 0.5 ? 2 * prog * prog : 1 - Math.pow(-2 * prog + 2, 2) / 2;
    vs.camera.position.z = vs.cameraStartZ - ease * 3.8;
    interiorLight.intensity = ease * 28;
    if (vs.flashEl && prog > 0.35) {
      const fp = (prog - 0.35) / 0.40;
      vs.flashEl.style.opacity = String(Math.min(1, fp * 3.0));
    }
    if (vs.overlayEl && prog >= 1 && !vs.overlayEl.dataset['fading']) {
      vs.overlayEl.dataset['fading'] = '1';
      vs.overlayEl.style.transition = 'opacity 1.4s ease';
      vs.overlayEl.style.opacity = '0';
    }
  } else {
    vs.camera.position.y = -0.15 + Math.sin(st.glowPhase * 0.5) * 0.006;
  }

  vs.camera.lookAt(0, 0, 0);
  vs.composer.render();
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
    background:#040608;
    overflow:hidden;
    animation:vi-fadein 1.1s cubic-bezier(0.16,1,0.3,1) both;
  `;

  const threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;display:block;';
  overlay.appendChild(threeCanvas);

  const scanBtn = document.createElement('div');
  scanBtn.style.cssText = `
    position:absolute;
    top:50%;left:50%;
    width:220px;height:220px;
    transform:translate(-50%,-50%);
    border-radius:50%;
    cursor:pointer;z-index:2;
  `;
  overlay.appendChild(scanBtn);

  const statusEl = document.createElement('div');
  statusEl.style.cssText = `
    position:absolute;
    top:calc(50% - 24vmin);left:50%;
    transform:translateX(-50%);
    padding:5px 20px;
    background:rgba(0,5,14,0.90);
    border:1px solid rgba(0,210,240,0.55);
    border-radius:3px;
    font-family:"SF Pro Display",-apple-system,BlinkMacSystemFont,monospace;
    font-size:clamp(8px,1.4vmin,11px);font-weight:600;letter-spacing:.16em;
    color:rgba(0,210,240,1);
    pointer-events:none;z-index:3;
    opacity:0;
    transition:opacity 0.28s ease;
  `;
  overlay.appendChild(statusEl);

  const flashEl = document.createElement('div');
  flashEl.style.cssText = `
    position:fixed;inset:0;z-index:10000;
    background:radial-gradient(circle,
      rgba(255,255,255,1.0) 0%,
      rgba(200,235,255,0.98) 18%,
      rgba(100,180,255,0.72) 46%,
      rgba(0,0,0,0) 80%
    );
    opacity:0;pointer-events:none;
  `;
  overlay.appendChild(flashEl);

  const quitBtn = document.createElement('button');
  quitBtn.textContent = 'Quit';
  quitBtn.style.cssText = `
    position:absolute;bottom:28px;left:50%;transform:translateX(-50%);
    background:none;border:none;
    font-size:12px;font-weight:500;letter-spacing:.08em;
    color:rgba(120,140,160,0.30);cursor:pointer;padding:6px 14px;
    transition:color .2s;z-index:4;
  `;
  quitBtn.addEventListener('mouseenter', () => { quitBtn.style.color = 'rgba(180,200,220,0.60)'; });
  quitBtn.addEventListener('mouseleave', () => { quitBtn.style.color = 'rgba(120,140,160,0.30)'; });
  overlay.appendChild(quitBtn);

  const vault = buildVaultScene(threeCanvas);
  vault.flashEl   = flashEl;
  vault.overlayEl = overlay;

  return { overlay, scanBtn, quitBtn, statusEl, flashEl, state, vault };
}

// ── Render loop ───────────────────────────────────────────────────────────────

function startLoop(refs: OverlayRefs): () => void {
  let rafId = 0;

  const loop = (now: number) => {
    refs.state.glowPhase = (refs.state.glowPhase + 0.026) % (Math.PI * 2);

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
      const rgb = isSuccess ? '0,225,160' : isError ? '240,70,40' : '0,210,240';
      statusEl.style.color       = `rgba(${rgb},1)`;
      statusEl.style.borderColor = `rgba(${rgb},0.52)`;
    } else {
      statusEl.style.opacity = '0';
    }

    try {
      renderVaultFrame(refs.vault, state, bp, now);
    } catch (e) {
      console.error('[vault-intro] renderVaultFrame error:', e);
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
  st.scanner     = 'idle';
  st.statusText  = '';
  st.statusAlpha = 0;
  st.fingerAlpha = 0.40;
}

function setWarmup(st: AnimState): void {
  st.scanner     = 'warmup';
  st.statusText  = 'SCANNING…';
  st.statusAlpha = 0.84;
  st.fingerAlpha = 0.55;
}

function setPeak(st: AnimState): void {
  st.scanner     = 'peak';
  st.statusText  = 'PLACE FINGER ON SENSOR';
  st.statusAlpha = 0.94;
  st.fingerAlpha = 0.68;
}

function setError(st: AnimState, msg: string): void {
  st.scanner     = 'error';
  st.statusText  = msg;
  st.statusAlpha = 0.90;
  st.fingerAlpha = 0.30;
}

function setSuccess(st: AnimState): void {
  st.scanner     = 'success';
  st.statusText  = 'ACCESS GRANTED';
  st.statusAlpha = 0.94;
  st.fingerAlpha = 0.80;
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

  if (appReady) await Promise.race([appReady, sleep(8000)]);
  await sleep(60);

  if (audioCtx) playDoorOpen(audioCtx);

  refs.state.openStartTime = performance.now();
  await sleep(OPEN_DURATION + 1600);
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
