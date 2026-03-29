import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const MAX_PIXEL_RATIO = 2;

type NavigatorWithMemory = Navigator & { deviceMemory?: number };

export interface BiometricGate3DCapability {
  webgl2: boolean;
  hardwareConcurrency: number;
  deviceMemory: number;
  prefersReducedMotion: boolean;
}

export interface BiometricGate3DController {
  setAuthenticating: (active: boolean) => void;
  setAccessGranted: () => void;
  setDoorOpenProgress: (progress: number) => void;
  destroy: () => void;
}

export function detectBiometricGate3DCapability(target: Window = window): BiometricGate3DCapability {
  const canvas = target.document.createElement('canvas');
  const webgl2 = Boolean(canvas.getContext('webgl2', { alpha: true, antialias: true }));
  const navigator = target.navigator as NavigatorWithMemory;

  return {
    webgl2,
    hardwareConcurrency: target.navigator.hardwareConcurrency ?? 2,
    deviceMemory: typeof navigator.deviceMemory === 'number' ? navigator.deviceMemory : 8,
    prefersReducedMotion: target.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  };
}

export function shouldEnableBiometricGate3D(capability: BiometricGate3DCapability): boolean {
  if (capability.prefersReducedMotion) return false;
  if (!capability.webgl2) return false;
  if (capability.hardwareConcurrency < 4) return false;
  if (capability.deviceMemory < 4) return false;
  return true;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function smoothstep(value: number): number {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

function disposeSceneResources(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    const geometry = mesh.geometry;
    if (geometry) geometry.dispose();

    const withMaterial = mesh as THREE.Mesh & { material?: THREE.Material | THREE.Material[] };
    const material = withMaterial.material;
    if (Array.isArray(material)) {
      material.forEach((entry) => entry.dispose());
    } else {
      material?.dispose();
    }
  });
}

function buildStarfield(starCount: number): THREE.Points {
  const positions = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i += 1) {
    const index = i * 3;
    positions[index] = (Math.random() - 0.5) * 7;
    positions[index + 1] = (Math.random() - 0.5) * 4 + 0.6;
    positions[index + 2] = -Math.random() * 24 - 2;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const material = new THREE.PointsMaterial({
    color: 0xA5_C8_FF,
    size: 0.028,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.55,
  });

  return new THREE.Points(geometry, material);
}

export async function mountBiometricGate3D(stage: HTMLElement): Promise<BiometricGate3DController> {
  const host = document.createElement('div');
  host.id = 'worldmonitor-biometric-gate-3d';
  Object.assign(host.style, {
    position: 'absolute',
    inset: '0',
    pointerEvents: 'none',
    zIndex: '0',
  } as CSSStyleDeclaration);
  stage.insertBefore(host, stage.firstChild);

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.22;
  renderer.setClearAlpha(0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.append(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(43, 1, 0.1, 80);
  camera.position.set(0, 1.06, 6.2);

  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  const env = new RoomEnvironment();
  const envRenderTarget = pmremGenerator.fromScene(env, 0.05);
  scene.environment = envRenderTarget.texture;
  env.dispose();
  pmremGenerator.dispose();

  const rig = new THREE.Group();
  scene.add(rig);

  const wallMaterial = new THREE.MeshStandardMaterial({
    color: 0x67_6D_75,
    metalness: 0.88,
    roughness: 0.26,
    envMapIntensity: 1.25,
  });
  const floorMaterial = new THREE.MeshStandardMaterial({
    color: 0x3B_3F_45,
    metalness: 0.86,
    roughness: 0.22,
    envMapIntensity: 1.4,
  });
  const doorMaterial = new THREE.MeshStandardMaterial({
    color: 0x9D_A4_AF,
    metalness: 0.94,
    roughness: 0.17,
    envMapIntensity: 1.45,
  });
  const frameMaterial = new THREE.MeshStandardMaterial({
    color: 0x56_5D_67,
    metalness: 0.9,
    roughness: 0.23,
    envMapIntensity: 1.2,
  });
  const coreMaterial = new THREE.MeshStandardMaterial({
    color: 0xBF_D7_FF,
    emissive: 0x3F_8B_FF,
    emissiveIntensity: 1.35,
    metalness: 0.2,
    roughness: 0.18,
  });
  const ringMaterial = new THREE.MeshStandardMaterial({
    color: 0xD4_E5_FF,
    emissive: 0x5E_A0_FF,
    emissiveIntensity: 0.8,
    metalness: 0.72,
    roughness: 0.24,
  });

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(9, 34), floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, -1.4, -11);
  floor.receiveShadow = true;
  rig.add(floor);

  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(9, 34), wallMaterial);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(0, 2.15, -11);
  rig.add(ceiling);

  const leftWall = new THREE.Mesh(new THREE.PlaneGeometry(34, 4), wallMaterial);
  leftWall.rotation.y = Math.PI / 2;
  leftWall.position.set(-3.2, 0.35, -11);
  rig.add(leftWall);

  const rightWall = new THREE.Mesh(new THREE.PlaneGeometry(34, 4), wallMaterial);
  rightWall.rotation.y = -Math.PI / 2;
  rightWall.position.set(3.2, 0.35, -11);
  rig.add(rightWall);

  const backWall = new THREE.Mesh(new THREE.PlaneGeometry(6.8, 4), wallMaterial);
  backWall.position.set(0, 0.35, -27.5);
  rig.add(backWall);

  const portalFrame = new THREE.Mesh(new THREE.BoxGeometry(5.2, 3.8, 0.45), frameMaterial);
  portalFrame.position.set(0, 0.35, 1.1);
  portalFrame.castShadow = true;
  portalFrame.receiveShadow = true;
  rig.add(portalFrame);

  const portalCutout = new THREE.Mesh(new THREE.BoxGeometry(3.95, 3.2, 0.6), new THREE.MeshBasicMaterial({ color: 0x0B_0E_12 }));
  portalCutout.position.set(0, 0.35, 1.23);
  rig.add(portalCutout);

  const doorGeometry = new THREE.BoxGeometry(1.92, 3.18, 0.22);
  const leftDoor = new THREE.Mesh(doorGeometry, doorMaterial);
  leftDoor.position.set(-0.98, 0.35, 1.2);
  leftDoor.castShadow = true;
  leftDoor.receiveShadow = true;
  rig.add(leftDoor);

  const rightDoor = new THREE.Mesh(doorGeometry, doorMaterial);
  rightDoor.position.set(0.98, 0.35, 1.2);
  rightDoor.castShadow = true;
  rightDoor.receiveShadow = true;
  rig.add(rightDoor);

  const scanCore = new THREE.Mesh(new THREE.SphereGeometry(0.26, 32, 32), coreMaterial);
  scanCore.position.set(0, 0.35, 1.04);
  rig.add(scanCore);

  const scanRing = new THREE.Mesh(new THREE.TorusGeometry(0.52, 0.03, 24, 128), ringMaterial);
  scanRing.position.set(0, 0.35, 1.03);
  rig.add(scanRing);

  const scanRingB = new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.02, 24, 128), ringMaterial);
  scanRingB.position.set(0, 0.35, 1.01);
  scanRingB.rotation.x = Math.PI * 0.35;
  rig.add(scanRingB);

  const starfield = buildStarfield(240);
  rig.add(starfield);

  const hemisphere = new THREE.HemisphereLight(0xCF_E2_FF, 0x12_16_1D, 0.45);
  rig.add(hemisphere);

  const keyLight = new THREE.DirectionalLight(0xFF_FF_FF, 1.35);
  keyLight.position.set(2.8, 5.8, 5.2);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  keyLight.shadow.bias = -0.0001;
  rig.add(keyLight);

  const sideLightLeft = new THREE.PointLight(0x87_B6_FF, 1.6, 15, 2);
  sideLightLeft.position.set(-2.6, 0.7, 0.8);
  rig.add(sideLightLeft);

  const sideLightRight = new THREE.PointLight(0x87_B6_FF, 1.6, 15, 2);
  sideLightRight.position.set(2.6, 0.7, 0.8);
  rig.add(sideLightRight);

  const coreLight = new THREE.PointLight(0x9E_D0_FF, 2.6, 9, 2);
  coreLight.position.set(0, 0.35, 1.25);
  rig.add(coreLight);

  const backLight = new THREE.PointLight(0x6E_9F_FF, 1.4, 24, 2);
  backLight.position.set(0, 0.2, -14);
  rig.add(backLight);

  const composer = new EffectComposer(renderer);
  const renderPass = new RenderPass(scene, camera);
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.42, 0.62, 0.9);
  composer.addPass(renderPass);
  composer.addPass(bloomPass);

  const resize = () => {
    const width = Math.max(1, Math.floor(stage.clientWidth));
    const height = Math.max(1, Math.floor(stage.clientHeight));
    const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);

    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(width, height, false);
    composer.setPixelRatio(pixelRatio);
    composer.setSize(width, height);
    bloomPass.setSize(width, height);

    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };

  resize();

  let authTarget = 0;
  let authBlend = 0;
  let grantPulse = 0;
  let doorTarget = 0;
  let doorBlend = 0;
  let rafId = 0;
  let destroyed = false;
  let lastFrameMs = performance.now();

  const onContextLost = (event: Event) => {
    event.preventDefault();
  };
  renderer.domElement.addEventListener('webglcontextlost', onContextLost, false);

  const resizeObserver = new ResizeObserver(() => resize());
  resizeObserver.observe(stage);

  const renderFrame = (nowMs: number) => {
    if (destroyed) return;

    const deltaSec = Math.min(0.05, (nowMs - lastFrameMs) / 1000);
    lastFrameMs = nowMs;

    const authLerp = Math.min(1, deltaSec * 7.2);
    const doorLerp = Math.min(1, deltaSec * 9.5);
    authBlend += (authTarget - authBlend) * authLerp;
    doorBlend += (doorTarget - doorBlend) * doorLerp;
    grantPulse = Math.max(0, grantPulse - deltaSec * 0.45);

    const timeSec = nowMs * 0.001;
    const openAmount = smoothstep(doorBlend);

    leftDoor.position.x = -0.98 - openAmount * 3.02;
    rightDoor.position.x = 0.98 + openAmount * 3.02;
    leftDoor.rotation.y = openAmount * 0.1;
    rightDoor.rotation.y = -openAmount * 0.1;

    scanRing.rotation.z += deltaSec * (0.34 + authBlend * 2.05);
    scanRing.rotation.y = Math.sin(timeSec * 0.75) * 0.13;
    scanRingB.rotation.x = Math.PI * 0.35 + Math.sin(timeSec * 1.2) * 0.18;

    const pulseScale = 1 + authBlend * 0.14 + grantPulse * 0.2;
    scanCore.scale.setScalar(pulseScale);

    coreMaterial.emissiveIntensity = 1.35 + authBlend * 2.2 + grantPulse * 2.8;
    ringMaterial.emissiveIntensity = 0.8 + authBlend * 1.4 + grantPulse * 1.7;
    coreLight.intensity = 2.6 + authBlend * 4.2 + grantPulse * 5.5;
    sideLightLeft.intensity = 1.6 + authBlend * 1.25;
    sideLightRight.intensity = 1.6 + authBlend * 1.25;
    backLight.intensity = 1.4 + authBlend * 0.65;

    starfield.rotation.z = Math.sin(timeSec * 0.18) * 0.05;
    starfield.position.z = -openAmount * 1.8;

    const cameraDriftX = Math.sin(timeSec * 0.17) * 0.16;
    const cameraDriftY = Math.sin(timeSec * 0.23) * 0.06;
    camera.position.set(
      cameraDriftX,
      1.06 + cameraDriftY + authBlend * 0.05,
      6.2 - openAmount * 1.12,
    );
    camera.lookAt(0, 0.38 + authBlend * 0.06, -4.7 - openAmount * 4.5);

    bloomPass.strength = 0.42 + authBlend * 0.58 + grantPulse * 0.9;
    bloomPass.radius = 0.62 + authBlend * 0.2;
    renderer.toneMappingExposure = 1.22 + authBlend * 0.2 + grantPulse * 0.25;

    composer.render();
    rafId = window.requestAnimationFrame(renderFrame);
  };

  rafId = window.requestAnimationFrame(renderFrame);

  return {
    setAuthenticating(active: boolean) {
      authTarget = active ? 1 : 0;
    },
    setAccessGranted() {
      grantPulse = 1;
      authTarget = 0.42;
    },
    setDoorOpenProgress(progress: number) {
      doorTarget = clamp01(progress);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;

      window.cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost, false);

      disposeSceneResources(scene);
      envRenderTarget.dispose();
      (composer as unknown as { dispose?: () => void }).dispose?.();
      renderer.dispose();
      host.remove();
    },
  };
}
