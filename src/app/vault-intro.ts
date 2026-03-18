// Biometric vault intro — Three.js 3D + bloom post-processing.
// Door splits left/right on ACCESS GRANTED, camera flies through.

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
  for (let i = 0; i < 4; i++) {
    const t = t0 + i * 0.09;
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(95, t);
    osc.frequency.exponentialRampToValueAtTime(16, t + 0.2);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.6, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    osc.connect(og).connect(ctx.destination);
    osc.start(t); osc.stop(t + 0.2);
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.04), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let j = 0; j < d.length; j++) d[j] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const hpf = ctx.createBiquadFilter(); hpf.type = 'highpass'; hpf.frequency.value = 3500;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.3, t); ng.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
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
  const aF = ctx.createBiquadFilter(); aF.type = 'bandpass'; aF.frequency.value = 2800; aF.Q.value = 0.5;
  const aG = ctx.createGain();
  aG.gain.setValueAtTime(0, t0); aG.gain.linearRampToValueAtTime(0.55, t0 + 0.04);
  aG.gain.exponentialRampToValueAtTime(0.001, t0 + 0.55);
  aSrc.connect(aF).connect(aG).connect(ctx.destination); aSrc.start(t0);

  const hBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
  const hd = hBuf.getChannelData(0);
  for (let i = 0; i < hd.length; i++) hd[i] = Math.random() * 2 - 1;
  const hSrc = ctx.createBufferSource(); hSrc.buffer = hBuf;
  const hF = ctx.createBiquadFilter(); hF.type = 'lowpass';
  hF.frequency.setValueAtTime(120, t0 + 0.1); hF.frequency.exponentialRampToValueAtTime(60, t0 + dur * 0.6);
  const hG = ctx.createGain();
  hG.gain.setValueAtTime(0, t0 + 0.1); hG.gain.linearRampToValueAtTime(0.35, t0 + 0.3);
  hG.gain.setValueAtTime(0.35, t0 + dur * 0.5); hG.gain.linearRampToValueAtTime(0, t0 + dur);
  hSrc.connect(hF).connect(hG).connect(ctx.destination); hSrc.start(t0 + 0.1);

  const gOsc = ctx.createOscillator(); gOsc.type = 'sawtooth';
  gOsc.frequency.setValueAtTime(38, t0 + 0.2); gOsc.frequency.linearRampToValueAtTime(48, t0 + 1.6);
  gOsc.frequency.linearRampToValueAtTime(32, t0 + dur);
  const gF = ctx.createBiquadFilter(); gF.type = 'lowpass'; gF.frequency.value = 200;
  const gG = ctx.createGain();
  gG.gain.setValueAtTime(0, t0 + 0.2); gG.gain.linearRampToValueAtTime(0.22, t0 + 0.5);
  gG.gain.setValueAtTime(0.22, t0 + 1.5); gG.gain.linearRampToValueAtTime(0, t0 + 2.4);
  gOsc.connect(gF).connect(gG).connect(ctx.destination); gOsc.start(t0 + 0.2); gOsc.stop(t0 + 2.5);

  const mOsc = ctx.createOscillator(); mOsc.type = 'sawtooth';
  mOsc.frequency.setValueAtTime(340, t0); mOsc.frequency.exponentialRampToValueAtTime(680, t0 + 0.4);
  mOsc.frequency.exponentialRampToValueAtTime(240, t0 + 1.8);
  const mF = ctx.createBiquadFilter(); mF.type = 'bandpass'; mF.frequency.value = 480; mF.Q.value = 3;
  const mG = ctx.createGain();
  mG.gain.setValueAtTime(0, t0); mG.gain.linearRampToValueAtTime(0.09, t0 + 0.15);
  mG.gain.setValueAtTime(0.09, t0 + 1.4); mG.gain.linearRampToValueAtTime(0, t0 + 2.0);
  mOsc.connect(mF).connect(mG).connect(ctx.destination); mOsc.start(t0); mOsc.stop(t0 + 2.1);
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
  fOsc.frequency.setValueAtTime(440, t0 + 0.05); fOsc.frequency.linearRampToValueAtTime(554, t0 + 0.35);
  const fF = ctx.createBiquadFilter(); fF.type = 'peaking'; fF.frequency.value = 800; fF.gain.value = 8;
  const fG = ctx.createGain();
  fG.gain.setValueAtTime(0, t0 + 0.05); fG.gain.linearRampToValueAtTime(0.08, t0 + 0.12);
  fG.gain.linearRampToValueAtTime(0, t0 + 0.42);
  fOsc.connect(fF).connect(fG).connect(ctx.destination); fOsc.start(t0 + 0.05); fOsc.stop(t0 + 0.45);
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
  cv.width = 256; cv.height = 128;
  const c = cv.getContext('2d')!;

  const sky = c.createLinearGradient(0, 0, 0, 128);
  sky.addColorStop(0,    '#8aaccc');
  sky.addColorStop(0.20, '#263850');
  sky.addColorStop(0.50, '#0c1220');
  sky.addColorStop(1,    '#03040a');
  c.fillStyle = sky; c.fillRect(0, 0, 256, 128);

  const key = c.createRadialGradient(80, 8, 0, 80, 8, 60);
  key.addColorStop(0,   'rgba(220,240,255,1.0)');
  key.addColorStop(0.5, 'rgba(100,175,230,0.50)');
  key.addColorStop(1,   'rgba(0,0,0,0)');
  c.fillStyle = key; c.fillRect(0, 0, 256, 128);

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
  s.textContent = `@keyframes vi-fadein { from{opacity:0} to{opacity:1} }`;
  document.head.appendChild(s);
}

// ── Half-geometry helpers ─────────────────────────────────────────────────────
// Disc faces camera after rotation.x = PI/2.
// In screen space (viewed from +Z), theta increases CLOCKWISE.
// Left half (x<0): theta from PI/2 → 3PI/2 (bottom→left→top arc)
// Right half (x>0): theta from -PI/2 → PI/2 (top→right→bottom arc, same as 3PI/2→PI/2 CW)

function halfDisc(r: number, h: number, side: -1 | 1): THREE.BufferGeometry {
  const tStart = side === -1 ? Math.PI / 2 : -Math.PI / 2;
  return new THREE.CylinderGeometry(r, r, h, 48, 1, false, tStart, Math.PI);
}

// TorusGeometry arc always starts at +X (right). Arc=PI gives top-half.
// Rotate mesh.rotation.z = +PI/2 → left half; -PI/2 → right half.
function halfTorus(r: number, tube: number): THREE.BufferGeometry {
  return new THREE.TorusGeometry(r, tube, 18, 64, Math.PI);
}
function halfTorusMesh(r: number, tube: number, side: -1 | 1, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(halfTorus(r, tube), mat);
  m.rotation.z = side === -1 ? Math.PI / 2 : -Math.PI / 2;
  return m;
}

// ── Three.js vault scene ──────────────────────────────────────────────────────

// W bolt in doorLeft, E bolt in doorRight.  N/S slots null.
interface BoltCfg { x: number; y: number; dx: number; dy: number; rz: number; }
const BOLT_CFG: Array<BoltCfg | null> = [
  null,                                                                      // N — removed
  { x:  2.28, y: 0, dx:  1, dy: 0, rz: -Math.PI / 2 },                    // E (rightDoor)
  null,                                                                      // S — removed
  { x: -2.28, y: 0, dx: -1, dy: 0, rz:  Math.PI / 2 },                    // W (leftDoor)
];

interface VaultScene {
  renderer:      THREE.WebGLRenderer;
  composer:      EffectComposer;
  scene:         THREE.Scene;
  camera:        THREE.PerspectiveCamera;
  doorLeft:      THREE.Group;   // slides left on open
  doorRight:     THREE.Group;   // slides right on open
  scannerGroup:  THREE.Group;   // centered — fades then camera flies through
  boltGroups:    Array<THREE.Group | null>;
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
  renderer.toneMappingExposure = 0.90;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x040608);
  scene.fog = new THREE.Fog(0x040608, 10, 24);
  scene.environment = createEnvMap(renderer);
  scene.environmentIntensity = 0.55;

  const camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 60);
  const cameraStartZ = 6.0;
  camera.position.set(0, -0.1, cameraStartZ);
  camera.lookAt(0, 0, 0);

  // Half-resolution bloom for performance
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(Math.round(w / 2), Math.round(h / 2)),
    1.10,   // strength
    0.55,   // radius
    0.35,   // threshold
  );
  composer.addPass(bloom);

  // ── Lighting ─────────────────────────────────────────────────────────────
  scene.add(new THREE.AmbientLight(0x06080e, 0.45));

  const key = new THREE.DirectionalLight(0xb0cce8, 3.8);
  key.position.set(2, 6, 5);
  scene.add(key);

  const rimL = new THREE.DirectionalLight(0x3858a0, 1.6);
  rimL.position.set(-6, 1, 2);
  scene.add(rimL);

  const ledLight = new THREE.PointLight(0x3080ff, 0.2, 5.5);
  ledLight.position.set(0, 0, 2.0);
  scene.add(ledLight);

  const interiorLight = new THREE.PointLight(0xa0c0ff, 0, 22);
  interiorLight.position.set(0, 0, -7);
  scene.add(interiorLight);

  // ── Room ─────────────────────────────────────────────────────────────────
  buildRoom(scene);

  // ── Shared materials ─────────────────────────────────────────────────────
  const steelMat = new THREE.MeshStandardMaterial({ color: 0x252d38, metalness: 0.78, roughness: 0.34 });
  const chromeMat = new THREE.MeshStandardMaterial({ color: 0x5a6878, metalness: 0.93, roughness: 0.09 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x030407, metalness: 0.60, roughness: 0.88 });
  const boltMat = new THREE.MeshStandardMaterial({ color: 0x303a48, metalness: 0.88, roughness: 0.22 });
  const pistonMat = new THREE.MeshStandardMaterial({ color: 0x485a6a, metalness: 0.92, roughness: 0.14 });

  // ── doorLeft & doorRight — half-geometry that slides apart ────────────────
  const doorLeft  = new THREE.Group();
  const doorRight = new THREE.Group();
  scene.add(doorLeft);
  scene.add(doorRight);

  // Half discs (the circular face of the vault door)
  for (const [grp, side] of [[doorLeft, -1], [doorRight, 1]] as [THREE.Group, -1|1][]) {
    const disc = new THREE.Mesh(halfDisc(2.32, 0.28, side), steelMat);
    disc.rotation.x = Math.PI / 2;
    disc.position.z = -0.14;
    grp.add(disc);

    // Outer collar half-ring
    const collar = halfTorusMesh(2.32, 0.12, side, chromeMat);
    collar.position.z = 0.06;
    grp.add(collar);

    // Decorative outer groove ring
    const outerRing = halfTorusMesh(1.92, 0.036, side, chromeMat);
    outerRing.position.z = 0.10;
    grp.add(outerRing);

    // LED groove ring
    const ledGrooveRing = halfTorusMesh(1.56, 0.044, side, darkMat);
    ledGrooveRing.position.z = 0.06;
    grp.add(ledGrooveRing);

    // Inner ring (between LED groove and scanner barrel)
    const innerRing = halfTorusMesh(1.24, 0.034, side, chromeMat);
    innerRing.position.z = 0.09;
    grp.add(innerRing);

    // Wing panel (one per side, simplified)
    buildWingPanel(grp, side, steelMat, chromeMat, darkMat);
  }

  // ── LEDs (12 total, split evenly left/right) ──────────────────────────────
  const LED_COUNT  = 12;
  const LED_RING_R = 1.56;
  const ledMeshes: THREE.Mesh[] = [];

  for (let i = 0; i < LED_COUNT; i++) {
    const angle = (i / LED_COUNT) * Math.PI * 2 - Math.PI / 2;
    const lx = Math.cos(angle) * LED_RING_R;
    const ly = Math.sin(angle) * LED_RING_R;
    // i=0..5 → rightDoor; i=6..11 → leftDoor
    const grp = i < 6 ? doorRight : doorLeft;

    const housing = new THREE.Mesh(new THREE.BoxGeometry(0.096, 0.096, 0.022), darkMat);
    housing.position.set(lx, ly, 0.068);
    grp.add(housing);

    const ledMat = new THREE.MeshStandardMaterial({
      color: 0xb8d8ff,
      emissive: new THREE.Color(0xb8d8ff),
      emissiveIntensity: 2.5,
      metalness: 0.05,
      roughness: 0.5,
    });
    const led = new THREE.Mesh(new THREE.BoxGeometry(0.065, 0.065, 0.019), ledMat);
    led.position.set(lx, ly, 0.080);
    grp.add(led);
    ledMeshes.push(led);
  }

  // ── Bolt arms (W in doorLeft, E in doorRight) ─────────────────────────────
  const boltGroups: Array<THREE.Group | null> = [null, null, null, null];

  // E bolt → rightDoor (index 1)
  boltGroups[1] = buildBoltArm(doorRight, BOLT_CFG[1]!, boltMat, pistonMat, chromeMat);
  // W bolt → doorLeft (index 3)
  boltGroups[3] = buildBoltArm(doorLeft, BOLT_CFG[3]!, boltMat, pistonMat, chromeMat);

  // ── scannerGroup — stays centered, camera flies through it ───────────────
  const scannerGroup = new THREE.Group();
  scene.add(scannerGroup);

  // Multi-ring scanner barrel (3 concentric chrome rings, stepped depth)
  const barrelSteps = [
    { r: 1.18, z: 0.09, rw: 0.050 },
    { r: 0.94, z: -0.02, rw: 0.042 },
    { r: 0.72, z: -0.12, rw: 0.034 },
    { r: 0.54, z: -0.20, rw: 0.026 },
  ];
  for (let si = 0; si < barrelSteps.length; si++) {
    const step = barrelSteps[si]!;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(step.r, step.rw, 16, 64), chromeMat);
    ring.position.z = step.z;
    scannerGroup.add(ring);

    if (si < barrelSteps.length - 1) {
      const next = barrelSteps[si + 1]!;
      const wallH = step.z - next.z;
      const wallR = (step.r + next.r) / 2 - 0.01;
      const wall = new THREE.Mesh(new THREE.CylinderGeometry(wallR, wallR, wallH, 48, 1, true), steelMat);
      wall.rotation.x = Math.PI / 2;
      wall.position.z = (step.z + next.z) / 2;
      scannerGroup.add(wall);
    }
  }

  // Dark scanner glass at deepest recess
  const scanFloor = new THREE.Mesh(
    new THREE.CylinderGeometry(0.50, 0.50, 0.04, 48),
    new THREE.MeshStandardMaterial({ color: 0x030208, metalness: 0.22, roughness: 0.94 }),
  );
  scanFloor.rotation.x = Math.PI / 2;
  scanFloor.position.z = -0.24;
  scannerGroup.add(scanFloor);

  // Main scanner glow ring
  const scannerRingMat = new THREE.MeshStandardMaterial({
    color: 0x100c1c,
    metalness: 0.85,
    roughness: 0.14,
    emissive: new THREE.Color(0x1a0308),
    emissiveIntensity: 0.7,
  });
  const scannerRing = new THREE.Mesh(new THREE.TorusGeometry(0.86, 0.062, 22, 80), scannerRingMat);
  scannerRing.rotation.x = 0.16;
  scannerRing.position.z = 0.10;
  scannerGroup.add(scannerRing);

  // Rotating scan arc
  const scanArcMat = new THREE.MeshStandardMaterial({
    color: 0x00d4ff,
    emissive: new THREE.Color(0x00d4ff),
    emissiveIntensity: 5.0,
    transparent: true,
    opacity: 0,
  });
  const scanArc = new THREE.Mesh(new THREE.TorusGeometry(0.82, 0.010, 10, 72, Math.PI * 1.5), scanArcMat);
  scanArc.position.z = 0.14;
  scannerGroup.add(scanArc);

  // Piston rod (vertical, through center)
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.070, 0.070, 6.0, 18), pistonMat);
  rod.position.set(0, 0, -0.02);
  scannerGroup.add(rod);

  for (let j = -2; j <= 2; j++) {
    const jRing = new THREE.Mesh(new THREE.TorusGeometry(0.072, 0.014, 9, 20), chromeMat);
    jRing.rotation.x = Math.PI / 2;
    jRing.position.set(0, j * 0.72, 0.0);
    scannerGroup.add(jRing);
  }

  // ── Fingerprint plane ─────────────────────────────────────────────────────
  const fpCanvas = document.createElement('canvas');
  fpCanvas.width = fpCanvas.height = 384;
  const fpTexture = new THREE.CanvasTexture(fpCanvas);
  fpTexture.colorSpace = THREE.SRGBColorSpace;

  const fpMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0, 0, 0),
    map: fpTexture,
    emissive: new THREE.Color(1, 1, 1),
    emissiveMap: fpTexture,
    emissiveIntensity: 3.8,
    transparent: true,
    depthWrite: false,
    metalness: 0,
    roughness: 1,
  });
  const fpMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.84, 0.84), fpMat);
  fpMesh.position.z = -0.20;
  scannerGroup.add(fpMesh);

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

// ── Wing panel (simplified — 4 meshes per side) ───────────────────────────────

function buildWingPanel(
  grp: THREE.Group,
  side: -1 | 1,
  steel: THREE.MeshStandardMaterial,
  chrome: THREE.MeshStandardMaterial,
  dark: THREE.MeshStandardMaterial,
): void {
  const cx = side * (2.32 + 0.14 + 0.56);  // center x of wing
  const wingW = 1.12;
  const wingH = 4.80;
  const wingD = 0.24;

  // Body
  const body = new THREE.Mesh(new THREE.BoxGeometry(wingW, wingH, wingD), steel);
  body.position.set(cx, 0, -0.10);
  grp.add(body);

  // Chrome outer edge strip
  const edgeX = cx + side * (wingW / 2 + 0.01);
  const edge = new THREE.Mesh(new THREE.BoxGeometry(0.022, wingH + 0.02, wingD + 0.01), chrome);
  edge.position.set(edgeX, 0, -0.10);
  grp.add(edge);

  // Top and bottom caps
  for (const sy of [-1, 1] as const) {
    const cap = new THREE.Mesh(new THREE.BoxGeometry(wingW + 0.022, 0.020, wingD + 0.01), chrome);
    cap.position.set(cx, sy * (wingH / 2 + 0.010), -0.10);
    grp.add(cap);
  }

  // 3 raised machined panels (portrait, stacked vertically)
  const panelW = wingW * 0.70;
  const panelH = wingH / 3 * 0.72;
  for (let pi = 0; pi < 3; pi++) {
    const py = (pi - 1) * (wingH / 3);

    // Recessed inset
    const recess = new THREE.Mesh(new THREE.BoxGeometry(panelW, panelH, 0.008), dark);
    recess.position.set(cx, py, 0.012);
    grp.add(recess);

    // Chrome border
    const border = new THREE.Mesh(new THREE.BoxGeometry(panelW + 0.036, panelH + 0.036, 0.016), chrome);
    border.position.set(cx, py, 0.003);
    grp.add(border);

    // Raised steel face
    const face = new THREE.Mesh(new THREE.BoxGeometry(panelW - 0.018, panelH - 0.018, 0.024), steel);
    face.position.set(cx, py, 0.014);
    grp.add(face);

    // Small indicator LED
    const indMat = new THREE.MeshStandardMaterial({
      color: 0xb0ccff,
      emissive: new THREE.Color(0xb0ccff),
      emissiveIntensity: 2.0,
      metalness: 0, roughness: 0.5,
    });
    const ind = new THREE.Mesh(new THREE.BoxGeometry(0.040, 0.016, 0.026), indMat);
    ind.position.set(cx + side * (panelW / 2 - 0.04), py + panelH / 2 - 0.05, 0.025);
    grp.add(ind);
  }
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
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x05070f, roughness: 0.95, metalness: 0.04 });
  const panelMat = new THREE.MeshStandardMaterial({ color: 0x090c18, roughness: 0.88, metalness: 0.14 });

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
    color: 0xffffff, emissive: new THREE.Color(0xd4eeff), emissiveIntensity: 1.0,
  });
  for (const fz of [-0.6, -2.2]) {
    const fix = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.055, 0.35), fixMat);
    fix.position.set(0, 3.84, fz); scene.add(fix);
    const fl = new THREE.PointLight(0xc0d8f0, 2.0, 14);
    fl.position.set(0, 3.65, fz); scene.add(fl);
  }

  // Vault frame collar around door opening
  const recessMat = new THREE.MeshStandardMaterial({ color: 0x090e18, metalness: 0.84, roughness: 0.26 });
  const frameCollar = new THREE.Mesh(new THREE.TorusGeometry(2.62, 0.50, 18, 96), recessMat);
  frameCollar.position.z = -2.8; scene.add(frameCollar);

  const tunnel = new THREE.Mesh(new THREE.CylinderGeometry(2.62, 2.62, 3.0, 64, 1, true), recessMat);
  tunnel.rotation.x = Math.PI / 2; tunnel.position.z = -1.6; scene.add(tunnel);
}

// ── Fingerprint texture update ────────────────────────────────────────────────

let _lastFPState = '';
let _lastFPAlpha = -1;

function updateFingerprintTexture(vs: VaultScene, st: AnimState): void {
  const { fpCanvas, fpTexture } = vs;
  // Skip redraw if nothing changed
  const key = `${st.scanner}:${st.fingerAlpha.toFixed(2)}`;
  if (key === _lastFPState && st.fingerAlpha === _lastFPAlpha) return;
  _lastFPState = key;
  _lastFPAlpha = st.fingerAlpha;

  const size = fpCanvas.width;
  const c = fpCanvas.getContext('2d')!;
  c.clearRect(0, 0, size, size);

  if (st.fingerAlpha < 0.01) { fpTexture.needsUpdate = true; return; }

  const isSuccess = st.scanner === 'success';
  const isActive  = st.scanner === 'warmup' || st.scanner === 'peak';
  const fpRGB = isSuccess ? '0,215,145' : (isActive ? '0,210,240' : '225,38,8');

  const fpScale = 6.2;
  const fpOX = size / 2 - 24 * fpScale;
  const fpOY = size / 2 - 24 * fpScale;

  c.save();
  c.translate(fpOX, fpOY);
  c.scale(fpScale, fpScale);

  if (isActive || isSuccess) {
    // Wide bloom halo
    c.save(); c.filter = 'blur(14px)';
    c.globalAlpha = st.fingerAlpha * 0.50;
    c.strokeStyle = `rgba(${fpRGB},1)`; c.lineWidth = 2.2; c.lineCap = 'round';
    for (const d of FP_PATHS) c.stroke(new Path2D(d));
    c.restore();

    // Mid glow
    c.save(); c.filter = 'blur(5px)';
    c.globalAlpha = st.fingerAlpha * 0.80;
    c.strokeStyle = `rgba(${fpRGB},1)`; c.lineWidth = 1.4; c.lineCap = 'round';
    for (const d of FP_PATHS) c.stroke(new Path2D(d));
    c.restore();
  } else {
    // Idle: just one bloom pass for performance
    c.save(); c.filter = 'blur(8px)';
    c.globalAlpha = st.fingerAlpha * 0.60;
    c.strokeStyle = `rgba(${fpRGB},1)`; c.lineWidth = 1.8; c.lineCap = 'round';
    for (const d of FP_PATHS) c.stroke(new Path2D(d));
    c.restore();
  }

  // Crisp core line
  c.globalAlpha = st.fingerAlpha;
  c.strokeStyle = `rgba(${fpRGB},1)`; c.lineWidth = 0.55; c.lineCap = 'round';
  for (const d of FP_PATHS) c.stroke(new Path2D(d));
  c.restore();

  fpTexture.needsUpdate = true;
}

// ── Per-frame render ──────────────────────────────────────────────────────────

const OPEN_DURATION = 1800;  // ms for the split animation

function renderVaultFrame(vs: VaultScene, st: AnimState, boltProgress: number[], now: number): void {
  const { boltGroups, scannerRing, scanArc, ledMeshes, ledLight, interiorLight } = vs;

  const isSuccess = st.scanner === 'success';
  const isActive  = st.scanner === 'warmup' || st.scanner === 'peak';
  const isError   = st.scanner === 'error';
  const glow      = (Math.sin(st.glowPhase) + 1) * 0.5;
  const pulse     = isSuccess ? 0.20 : (0.50 + Math.sin(st.glowPhase * 1.2) * 0.30);

  updateFingerprintTexture(vs, st);

  // ── LEDs ──
  const ledColor = isSuccess
    ? new THREE.Color(0.04, 0.90, 0.50)
    : isError ? new THREE.Color(0.88, 0.16, 0.04)
    : new THREE.Color(0.74, 0.90, 1.00);
  const ledIntensity = 1.8 + pulse * 2.2;
  for (const led of ledMeshes) {
    const m = led.material as THREE.MeshStandardMaterial;
    m.emissive.copy(ledColor);
    m.emissiveIntensity = ledIntensity;
  }
  ledLight.color.copy(isSuccess ? new THREE.Color(0, 0.90, 0.48)
    : isError ? new THREE.Color(0.90, 0.14, 0.04)
    : new THREE.Color(0.22, 0.52, 1.00));
  ledLight.intensity = isActive ? (0.9 + pulse * 1.4) : (isSuccess ? 0.8 : 0.20);

  // ── Scanner ring ──
  const ringMat = scannerRing.material as THREE.MeshStandardMaterial;
  ringMat.emissive.copy(
    isSuccess ? new THREE.Color(0, 0.82, 0.50)
    : isActive ? new THREE.Color(0, 0.72, 1.00)
    : isError  ? new THREE.Color(0.78, 0.10, 0.04)
    : new THREE.Color(0.52, 0.07, 0.07),
  );
  ringMat.emissiveIntensity = isActive
    ? (1.2 + pulse * 1.8)
    : (isSuccess ? 1.8 : (isError ? 1.4 : 0.30));
  scannerRing.rotation.z += 0.0022;

  // ── Scan arc ──
  const arcMat = scanArc.material as THREE.MeshStandardMaterial;
  arcMat.opacity = isActive ? 0.90 : 0;
  if (isActive) {
    arcMat.emissiveIntensity = 3.5 + glow * 2.0;
    scanArc.rotation.z = st.glowPhase * 2.3;
  }

  // ── Bolt retraction (W and E only) ──
  for (let i = 0; i < 4; i++) {
    const bg = boltGroups[i];
    if (!bg) continue;
    const cfg = BOLT_CFG[i]!;
    const prog = boltProgress[i] ?? 0;
    const slide = prog * 1.0;
    bg.position.set(cfg.x + cfg.dx * slide, cfg.y + cfg.dy * slide, 0.02);
    bg.visible = prog < 0.92;
  }

  // ── Door split opening animation ──
  if (st.openStartTime !== null) {
    const raw  = Math.min(1, (now - st.openStartTime) / OPEN_DURATION);
    // Ease: fast start, smooth end
    const ease = raw < 0.5 ? 2 * raw * raw : 1 - Math.pow(-2 * raw + 2, 2) / 2;

    // Halves slide apart
    vs.doorLeft.position.x  = -ease * 6.0;
    vs.doorRight.position.x =  ease * 6.0;

    // Scanner group disappears quickly as halves separate
    vs.scannerGroup.visible = raw < 0.18;

    // Camera pushes forward through the gap
    vs.camera.position.z = vs.cameraStartZ - ease * 5.0;

    // Interior light floods in
    interiorLight.intensity = ease * 28;

    // White flash bloom
    if (vs.flashEl && raw > 0.28) {
      const fp = (raw - 0.28) / 0.38;
      vs.flashEl.style.opacity = String(Math.min(1, fp * 2.8));
    }

    // Fade overlay when done
    if (vs.overlayEl && raw >= 1 && !vs.overlayEl.dataset['fading']) {
      vs.overlayEl.dataset['fading'] = '1';
      vs.overlayEl.style.transition = 'opacity 1.2s ease';
      vs.overlayEl.style.opacity = '0';
    }
  } else {
    vs.camera.position.y = -0.10 + Math.sin(st.glowPhase * 0.5) * 0.005;
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
    position:fixed;inset:0;z-index:9999;background:#040608;
    overflow:hidden;animation:vi-fadein 1.0s cubic-bezier(0.16,1,0.3,1) both;
  `;

  const threeCanvas = document.createElement('canvas');
  threeCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;display:block;';
  overlay.appendChild(threeCanvas);

  const scanBtn = document.createElement('div');
  scanBtn.style.cssText = `
    position:absolute;top:50%;left:50%;width:200px;height:200px;
    transform:translate(-50%,-50%);border-radius:50%;cursor:pointer;z-index:2;
  `;
  overlay.appendChild(scanBtn);

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
  overlay.appendChild(statusEl);

  const flashEl = document.createElement('div');
  flashEl.style.cssText = `
    position:fixed;inset:0;z-index:10000;
    background:radial-gradient(circle,
      rgba(255,255,255,1.0) 0%,rgba(200,235,255,0.98) 18%,
      rgba(90,170,255,0.65) 48%,rgba(0,0,0,0) 80%);
    opacity:0;pointer-events:none;
  `;
  overlay.appendChild(flashEl);

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
      const rgb = isSuccess ? '0,220,155' : isError ? '238,65,35' : '0,210,240';
      statusEl.style.color       = `rgba(${rgb},1)`;
      statusEl.style.borderColor = `rgba(${rgb},0.50)`;
    } else {
      statusEl.style.opacity = '0';
    }

    try {
      renderVaultFrame(refs.vault, state, bp, now);
    } catch (e) {
      console.error('[vault-intro] render error:', e);
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
  st.scanner = 'idle'; st.statusText = ''; st.statusAlpha = 0; st.fingerAlpha = 0.40;
}
function setWarmup(st: AnimState): void {
  st.scanner = 'warmup'; st.statusText = 'SCANNING…'; st.statusAlpha = 0.84; st.fingerAlpha = 0.56;
}
function setPeak(st: AnimState): void {
  st.scanner = 'peak'; st.statusText = 'PLACE FINGER ON SENSOR'; st.statusAlpha = 0.94; st.fingerAlpha = 0.70;
}
function setError(st: AnimState, msg: string): void {
  st.scanner = 'error'; st.statusText = msg; st.statusAlpha = 0.90; st.fingerAlpha = 0.30;
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
    } catch (err) {
      if (settled) return;
      inFlight = false;
      const msg  = err instanceof Error ? err.message : '';
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
