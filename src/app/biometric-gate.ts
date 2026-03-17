import { hasTauriInvokeBridge, invokeTauri } from '../services/tauri-bridge';

const INVOKE_CMD_AUTHENTICATE = 'plugin:biometry|authenticate';
const BRIDGE_READY_TIMEOUT_MS = 2500;
const BRIDGE_READY_POLL_MS = 50;
const WINDOW_READY_TIMEOUT_MS = 1200;
const WINDOW_READY_POLL_MS = 100;
const AUTO_PROMPT_DELAY_MS = 80;
const MIN_OVERLAY_VISIBLE_MS = 900;
const UNLOCK_SCAN_SETTLE_MS = 720;
const UNLOCK_PANEL_SETTLE_MS = 420;
const UNLOCK_SEAL_BREAK_MS = 240;
const UNLOCK_PANEL_WITHDRAW_MS = 760;
const UNLOCK_DOOR_OPEN_MS = 1820;
const UNLOCK_EXIT_FADE_MS = 320;
const UNLOCK_SOUND_SEAL_TRANSIENT_MS = 180;
const UNLOCK_SOUND_DOOR_SWELL_MS = 1640;
const AUTH_REASON = 'Unlock World Monitor';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type OverlayElements = {
  container: HTMLDivElement;
  stage: HTMLDivElement;
  portalGlow: HTMLDivElement;
  message: HTMLParagraphElement;
  button: HTMLButtonElement;
  quit: HTMLButtonElement;
  buttons: HTMLDivElement;
  panel: HTMLDivElement;
  title: HTMLHeadingElement;
  statusPill: HTMLDivElement;
  biometricHero: HTMLDivElement;
  biometricCaption: HTMLDivElement;
  scanLine: HTMLDivElement;
  leftDoor: HTMLDivElement;
  rightDoor: HTMLDivElement;
  centerBeam: HTMLDivElement;
  visibleAt: number;
  releasePresentation: () => void;
};

async function waitForInvokeBridge(): Promise<void> {
  const deadline = Date.now() + BRIDGE_READY_TIMEOUT_MS;
  while (!hasTauriInvokeBridge()) {
    if (Date.now() >= deadline) {
      throw new Error('Biometry unavailable: Tauri invoke bridge not ready');
    }
    await sleep(BRIDGE_READY_POLL_MS);
  }
}

async function invokePlugin<T = unknown>(
  cmd: string,
  payload?: Record<string, unknown>,
): Promise<T> {
  await waitForInvokeBridge();
  return invokeTauri<T>(cmd, payload);
}

function isInteractiveWindow(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

async function waitForInteractiveWindow(): Promise<boolean> {
  if (isInteractiveWindow()) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    return true;
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let pollId = 0;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      window.clearInterval(pollId);
      window.removeEventListener('focus', finish);
      document.removeEventListener('visibilitychange', finish);
    };

    const timeoutId = window.setTimeout(() => {
      cleanup();
      resolve(false);
    }, WINDOW_READY_TIMEOUT_MS);

    const finish = () => {
      if (!isInteractiveWindow()) return;
      cleanup();
      requestAnimationFrame(() => resolve(true));
    };

    window.addEventListener('focus', finish);
    document.addEventListener('visibilitychange', finish);
    pollId = window.setInterval(() => {
      if (settled || !isInteractiveWindow()) return;
      finish();
    }, WINDOW_READY_POLL_MS);

    finish();
  });
}

function ensureOverlay(): OverlayElements {
  const existing = document.getElementById('biometry-gate');
  if (existing) existing.remove();

  const appRoot = document.getElementById('app');
  const previousBodyOverflow = document.body.style.overflow;
  const previousAppFilter = appRoot?.style.filter ?? '';
  const previousAppOpacity = appRoot?.style.opacity ?? '';
  const previousAppTransform = appRoot?.style.transform ?? '';
  const previousAppPointerEvents = appRoot?.style.pointerEvents ?? '';

  document.body.style.overflow = 'hidden';
  if (appRoot) {
    appRoot.style.filter = 'blur(10px) saturate(0.75)';
    appRoot.style.opacity = '0.22';
    appRoot.style.transform = 'scale(1.015)';
    appRoot.style.pointerEvents = 'none';
  }

  const releasePresentation = () => {
    document.body.style.overflow = previousBodyOverflow;
    if (!appRoot) return;
    appRoot.style.filter = previousAppFilter;
    appRoot.style.opacity = previousAppOpacity;
    appRoot.style.transform = previousAppTransform;
    appRoot.style.pointerEvents = previousAppPointerEvents;
  };

  const container = document.createElement('div');
  container.id = 'biometry-gate';
  Object.assign(container.style, {
    position: 'fixed',
    inset: '0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: `
      radial-gradient(circle at 50% 10%, rgba(255,255,255,0.18), transparent 24%),
      linear-gradient(180deg, rgba(246,247,249,0.14), rgba(26,28,32,0.22) 18%, rgba(6,7,9,0.94))
    `,
    backdropFilter: 'blur(8px)',
    zIndex: '9999',
    color: '#f5f4ef',
    fontFamily: '"SF Pro Display", -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif',
    animation: 'wm-biometry-fade-in 240ms ease-out',
  } as CSSStyleDeclaration);

  const overlayStyle = document.createElement('style');
  overlayStyle.textContent = `
    @keyframes wm-biometry-fade-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    @keyframes wm-biometry-float {
      0%, 100% { transform: translate(-50%, -50%) translateY(0); }
      50% { transform: translate(-50%, -50%) translateY(-6px); }
    }

    @keyframes wm-biometry-orbit {
      from { transform: translate(-50%, -50%) rotate(0deg); }
      to { transform: translate(-50%, -50%) rotate(360deg); }
    }

    @keyframes wm-biometry-sweep {
      0% { transform: translateX(-120%) skewX(-18deg); opacity: 0; }
      20% { opacity: 0.22; }
      100% { transform: translateX(220%) skewX(-18deg); opacity: 0; }
    }

    @keyframes wm-biometry-grid {
      from { transform: translate3d(0, 0, 0); }
      to { transform: translate3d(0, 18px, 0); }
    }

    @keyframes wm-biometry-beam {
      0%, 100% { opacity: 0.62; box-shadow: 0 0 24px rgba(255,252,245,0.34); }
      50% { opacity: 0.92; box-shadow: 0 0 42px rgba(255,252,245,0.55); }
    }

    @keyframes wm-biometry-pulse {
      0%, 100% { transform: scale(1); opacity: 0.76; }
      50% { transform: scale(1.035); opacity: 1; }
    }

    @keyframes wm-biometry-scan-line {
      0% { transform: translateY(-120%); opacity: 0; }
      12% { opacity: 0.85; }
      50% { opacity: 0.92; }
      88% { opacity: 0.85; }
      100% { transform: translateY(120%); opacity: 0; }
    }

    @keyframes wm-biometry-fingerprint-verify {
      0% { transform: translateY(-104%) scaleX(0.86); opacity: 0; }
      14% { opacity: 0.96; }
      48% { transform: translateY(-10%) scaleX(1); opacity: 1; }
      72% { transform: translateY(18%) scaleX(1.02); opacity: 0.98; }
      100% { transform: translateY(104%) scaleX(0.92); opacity: 0; }
    }

    @keyframes wm-biometry-success-bloom {
      0% { transform: scale(1); box-shadow: 0 20px 40px rgba(0,0,0,0.18); }
      42% { transform: scale(1.05); box-shadow: 0 30px 58px rgba(0,0,0,0.26); }
      100% { transform: scale(1.02); box-shadow: 0 26px 52px rgba(0,0,0,0.22); }
    }

    @keyframes wm-biometry-seal-break {
      0% { transform: translateX(-50%) scaleY(0.82); opacity: 0.3; box-shadow: 0 0 18px rgba(255,252,245,0.26); }
      40% { transform: translateX(-50%) scaleY(1.06); opacity: 0.96; box-shadow: 0 0 56px rgba(255,248,231,0.74); }
      100% { transform: translateX(-50%) scaleY(1); opacity: 0.9; box-shadow: 0 0 42px rgba(255,248,231,0.42); }
    }
  `;
  container.appendChild(overlayStyle);

  const stage = document.createElement('div');
  Object.assign(stage.style, {
    position: 'relative',
    width: 'min(1040px, 97vw)',
    height: 'min(680px, 94vh)',
    overflow: 'hidden',
    borderRadius: '34px',
    border: '1px solid rgba(255,255,255,0.22)',
    background: `
      radial-gradient(circle at 50% 13%, rgba(255,255,255,0.20), rgba(255,255,255,0) 22%),
      linear-gradient(180deg, rgba(226,229,233,0.22), rgba(116,122,130,0.08) 16%, rgba(0,0,0,0) 30%),
      linear-gradient(180deg, rgba(104,108,114,0.985), rgba(46,48,52,0.99) 28%, rgba(12,13,16,1))
    `,
    boxShadow: `
      0 52px 180px rgba(0,0,0,0.66),
      inset 0 1px 0 rgba(255,255,255,0.28),
      inset 0 -20px 40px rgba(0,0,0,0.34)
    `,
    transform: 'perspective(1800px) rotateX(4deg)',
    transformStyle: 'preserve-3d',
  } as CSSStyleDeclaration);

  const portalGlow = document.createElement('div');
  Object.assign(portalGlow.style, {
    position: 'absolute',
    left: '50%',
    top: '52%',
    width: '54%',
    height: '66%',
    transform: 'translate(-50%, -50%)',
    borderRadius: '50%',
    background: `
      radial-gradient(circle, rgba(255,255,255,0.18), rgba(129, 185, 255, 0.08) 24%, rgba(255,255,255,0.02) 46%, rgba(0,0,0,0) 72%)
    `,
    filter: 'blur(20px)',
    opacity: '0.72',
    transition: 'opacity 900ms ease, filter 1200ms ease, transform 1200ms ease',
    pointerEvents: 'none',
  } as CSSStyleDeclaration);

  const airlockDepth = document.createElement('div');
  airlockDepth.id = 'worldmonitor-airlock-depth';
  Object.assign(airlockDepth.style, {
    position: 'absolute',
    left: '50%',
    top: '52%',
    width: '42%',
    height: '64%',
    transform: 'translate(-50%, -50%)',
    borderRadius: '34px',
    background: `
      radial-gradient(circle at 50% 18%, rgba(255,255,255,0.20), rgba(255,255,255,0) 22%),
      linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.00) 20%, rgba(0,0,0,0.22) 100%),
      linear-gradient(180deg, rgba(28,31,35,0.92), rgba(10,11,14,0.98) 46%, rgba(2,3,4,1))
    `,
    boxShadow: `
      inset 0 24px 64px rgba(255,255,255,0.06),
      inset 0 -40px 72px rgba(0,0,0,0.62),
      0 30px 70px rgba(0,0,0,0.28)
    `,
    overflow: 'hidden',
    pointerEvents: 'none',
  } as CSSStyleDeclaration);

  const airlockDepthGrid = document.createElement('div');
  Object.assign(airlockDepthGrid.style, {
    position: 'absolute',
    inset: '8%',
    borderRadius: '26px',
    background: `
      linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)
    `,
    backgroundSize: '34px 34px, 34px 34px',
    maskImage: 'linear-gradient(180deg, rgba(0,0,0,0.95), rgba(0,0,0,0.26) 82%, transparent)',
    opacity: '0.30',
  } as CSSStyleDeclaration);

  const airlockDepthCore = document.createElement('div');
  Object.assign(airlockDepthCore.style, {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: '58%',
    height: '68%',
    transform: 'translate(-50%, -50%)',
    borderRadius: '28px',
    background: `
      radial-gradient(circle at 50% 28%, rgba(255,255,255,0.14), rgba(255,255,255,0.02) 34%, rgba(0,0,0,0) 66%),
      conic-gradient(from 180deg at 50% 50%, rgba(255,255,255,0.05), rgba(255,255,255,0.01), rgba(255,255,255,0.06), rgba(255,255,255,0.02), rgba(255,255,255,0.05)),
      linear-gradient(180deg, rgba(42,45,50,0.72), rgba(13,14,17,0.94))
    `,
    border: '1px solid rgba(255,255,255,0.08)',
    boxShadow: `
      inset 0 1px 0 rgba(255,255,255,0.08),
      inset 0 -18px 32px rgba(0,0,0,0.54)
    `,
  } as CSSStyleDeclaration);

  airlockDepth.appendChild(airlockDepthGrid);
  airlockDepth.appendChild(airlockDepthCore);

  const apertureRing = document.createElement('div');
  apertureRing.id = 'worldmonitor-aperture-ring';
  Object.assign(apertureRing.style, {
    position: 'absolute',
    left: '50%',
    top: '52%',
    width: '50%',
    height: '72%',
    transform: 'translate(-50%, -50%)',
    borderRadius: '38px',
    background: `
      linear-gradient(180deg, rgba(255,255,255,0.20), rgba(255,255,255,0.00) 16%, rgba(0,0,0,0.24) 100%),
      conic-gradient(from 180deg at 50% 50%, rgba(255,255,255,0.10), rgba(120,126,136,0.04), rgba(255,255,255,0.16), rgba(82,88,96,0.04), rgba(255,255,255,0.10))
    `,
    border: '1px solid rgba(255,255,255,0.14)',
    boxShadow: `
      inset 0 1px 0 rgba(255,255,255,0.24),
      inset 0 0 0 10px rgba(11,12,14,0.54),
      0 20px 56px rgba(0,0,0,0.24)
    `,
    pointerEvents: 'none',
  } as CSSStyleDeclaration);

  const depthShafts = document.createElement('div');
  depthShafts.id = 'worldmonitor-depth-shafts';
  Object.assign(depthShafts.style, {
    position: 'absolute',
    left: '50%',
    top: '52%',
    width: '54%',
    height: '78%',
    transform: 'translate(-50%, -50%)',
    background: `
      linear-gradient(90deg, rgba(255,255,255,0.00) 0%, rgba(255,255,255,0.16) 18%, rgba(255,255,255,0.00) 32%, rgba(255,255,255,0.12) 52%, rgba(255,255,255,0.00) 68%, rgba(255,255,255,0.16) 82%, rgba(255,255,255,0.00) 100%),
      linear-gradient(180deg, rgba(255,255,255,0.18), rgba(255,255,255,0.00) 42%, rgba(0,0,0,0.00) 74%, rgba(0,0,0,0.28) 100%)
    `,
    filter: 'blur(20px)',
    opacity: '0.38',
    mixBlendMode: 'screen',
    maskImage: 'radial-gradient(circle at 50% 44%, rgba(0,0,0,0.98), rgba(0,0,0,0.68) 56%, transparent 86%)',
    pointerEvents: 'none',
  } as CSSStyleDeclaration);

  const airlockCrown = document.createElement('div');
  airlockCrown.id = 'worldmonitor-airlock-crown';
  Object.assign(airlockCrown.style, {
    position: 'absolute',
    left: '50%',
    top: '14%',
    width: '38%',
    height: '76px',
    transform: 'translateX(-50%)',
    borderRadius: '26px 26px 18px 18px',
    background: `
      linear-gradient(180deg, rgba(255,255,255,0.24), rgba(255,255,255,0.04) 28%, rgba(0,0,0,0.12) 100%),
      conic-gradient(from 180deg at 50% 50%, rgba(255,255,255,0.18), rgba(108,113,122,0.06), rgba(255,255,255,0.14), rgba(72,76,82,0.04), rgba(255,255,255,0.18))
    `,
    border: '1px solid rgba(255,255,255,0.14)',
    boxShadow: `
      inset 0 1px 0 rgba(255,255,255,0.24),
      inset 0 -10px 18px rgba(0,0,0,0.22),
      0 16px 36px rgba(0,0,0,0.18)
    `,
    pointerEvents: 'none',
  } as CSSStyleDeclaration);

  const thresholdPlate = document.createElement('div');
  thresholdPlate.id = 'worldmonitor-threshold-plate';
  Object.assign(thresholdPlate.style, {
    position: 'absolute',
    left: '50%',
    bottom: '9%',
    width: '52%',
    height: '68px',
    transform: 'translateX(-50%) perspective(1200px) rotateX(76deg)',
    borderRadius: '18px',
    background: `
      linear-gradient(180deg, rgba(255,255,255,0.18), rgba(255,255,255,0.04) 22%, rgba(0,0,0,0.12) 100%),
      repeating-linear-gradient(
        90deg,
        rgba(255,255,255,0.08) 0 2px,
        rgba(255,255,255,0.01) 2px 16px
      ),
      conic-gradient(from 180deg at 50% 50%, rgba(255,255,255,0.08), rgba(66,71,78,0.02), rgba(255,255,255,0.10), rgba(52,56,63,0.02), rgba(255,255,255,0.08))
    `,
    border: '1px solid rgba(255,255,255,0.12)',
    boxShadow: `
      inset 0 1px 0 rgba(255,255,255,0.20),
      inset 0 -10px 22px rgba(0,0,0,0.26),
      0 18px 48px rgba(0,0,0,0.24)
    `,
    opacity: '0.88',
    pointerEvents: 'none',
  } as CSSStyleDeclaration);

  const leftTrack = document.createElement('div');
  leftTrack.id = 'worldmonitor-door-track-left';
  Object.assign(leftTrack.style, {
    position: 'absolute',
    top: '12%',
    left: 'calc(50% - 44px)',
    width: '24px',
    height: '76%',
    borderRadius: '999px',
    background: `
      linear-gradient(90deg, rgba(255,255,255,0.10), rgba(255,255,255,0.00) 18%, rgba(0,0,0,0.26) 100%),
      conic-gradient(from 180deg at 50% 50%, rgba(255,255,255,0.16), rgba(107,113,121,0.08), rgba(255,255,255,0.14), rgba(72,77,84,0.08), rgba(255,255,255,0.16))
    `,
    border: '1px solid rgba(255,255,255,0.12)',
    boxShadow: `
      inset 0 1px 0 rgba(255,255,255,0.20),
      inset -8px 0 10px rgba(0,0,0,0.22),
      0 0 18px rgba(255,255,255,0.06)
    `,
    pointerEvents: 'none',
  } as CSSStyleDeclaration);

  const rightTrack = document.createElement('div');
  rightTrack.id = 'worldmonitor-door-track-right';
  Object.assign(rightTrack.style, {
    position: 'absolute',
    top: '12%',
    right: 'calc(50% - 44px)',
    width: '24px',
    height: '76%',
    borderRadius: '999px',
    background: `
      linear-gradient(270deg, rgba(255,255,255,0.10), rgba(255,255,255,0.00) 18%, rgba(0,0,0,0.26) 100%),
      conic-gradient(from 180deg at 50% 50%, rgba(255,255,255,0.16), rgba(107,113,121,0.08), rgba(255,255,255,0.14), rgba(72,77,84,0.08), rgba(255,255,255,0.16))
    `,
    border: '1px solid rgba(255,255,255,0.12)',
    boxShadow: `
      inset 0 1px 0 rgba(255,255,255,0.20),
      inset 8px 0 10px rgba(0,0,0,0.22),
      0 0 18px rgba(255,255,255,0.06)
    `,
    pointerEvents: 'none',
  } as CSSStyleDeclaration);

  const deckReflection = document.createElement('div');
  Object.assign(deckReflection.style, {
    position: 'absolute',
    left: '6%',
    right: '6%',
    bottom: '0',
    height: '28%',
    background: `
      linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01) 20%, rgba(0,0,0,0.22) 72%, rgba(0,0,0,0.42)),
      repeating-linear-gradient(
        90deg,
        rgba(255,255,255,0.04) 0 2px,
        rgba(255,255,255,0.008) 2px 28px
      )
    `,
    borderTop: '1px solid rgba(255,255,255,0.08)',
    transform: 'perspective(1400px) rotateX(76deg)',
    transformOrigin: 'center bottom',
    opacity: '0.55',
    pointerEvents: 'none',
  } as CSSStyleDeclaration);

  const starfield = document.createElement('div');
  Object.assign(starfield.style, {
    position: 'absolute',
    inset: '0',
    background: `
      radial-gradient(circle at 50% 40%, rgba(255,255,255,0.14), transparent 16%),
      linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.015) 16%, rgba(0,0,0,0) 26%),
      linear-gradient(135deg, rgba(25, 27, 31, 0.975), rgba(8, 9, 11, 1))
    `,
  } as CSSStyleDeclaration);

  const ambientGrid = document.createElement('div');
  Object.assign(ambientGrid.style, {
    position: 'absolute',
    inset: '0',
    opacity: '0.24',
    backgroundImage: `
      linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px),
      linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0) 10%),
      repeating-linear-gradient(
        90deg,
        rgba(255,255,255,0.026) 0 1px,
        rgba(255,255,255,0.007) 1px 8px,
        rgba(0,0,0,0.016) 8px 16px
      )
    `,
    backgroundSize: '80px 80px, 80px 80px, 100% 100%, 100% 100%',
    backgroundPosition: '0 0, 0 0, 0 0, 0 0',
    maskImage: 'linear-gradient(180deg, rgba(0,0,0,0.8), rgba(0,0,0,0.18) 72%, transparent)',
    animation: 'wm-biometry-grid 9s linear infinite',
    pointerEvents: 'none',
  } as CSSStyleDeclaration);

  const lightSweep = document.createElement('div');
  Object.assign(lightSweep.style, {
    position: 'absolute',
    inset: '-10%',
    background: 'linear-gradient(90deg, rgba(255,255,255,0), rgba(255,255,255,0.22), rgba(255,255,255,0))',
    filter: 'blur(16px)',
    opacity: '0',
    animation: 'wm-biometry-sweep 4.8s ease-in-out infinite',
    pointerEvents: 'none',
  } as CSSStyleDeclaration);

  const lockFrame = document.createElement('div');
  lockFrame.id = 'worldmonitor-lock-frame';
  Object.assign(lockFrame.style, {
    position: 'absolute',
    inset: '16px',
    borderRadius: '26px',
    border: '2px solid rgba(255,255,255,0.16)',
    boxShadow: `
      inset 0 0 0 1px rgba(255,255,255,0.08),
      0 0 0 1px rgba(0,0,0,0.18)
    `,
    pointerEvents: 'none',
  } as CSSStyleDeclaration);

  const orbitRing = document.createElement('div');
  orbitRing.id = 'worldmonitor-orbit-ring';
  Object.assign(orbitRing.style, {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: '540px',
    height: '540px',
    transform: 'translate(-50%, -50%)',
    borderRadius: '50%',
    border: '1px solid rgba(255,255,255,0.10)',
    boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.04)',
    opacity: '0.42',
    animation: 'wm-biometry-orbit 18s linear infinite',
    pointerEvents: 'none',
  } as CSSStyleDeclaration);

  const orbitArc = document.createElement('div');
  Object.assign(orbitArc.style, {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: '540px',
    height: '540px',
    transform: 'translate(-50%, -50%)',
    borderRadius: '50%',
    borderTop: '3px solid rgba(189, 225, 255, 0.55)',
    borderLeft: '2px solid rgba(255,255,255,0.10)',
    borderRight: '2px solid transparent',
    borderBottom: '2px solid transparent',
    filter: 'drop-shadow(0 0 12px rgba(189,225,255,0.22))',
    opacity: '0.7',
    animation: 'wm-biometry-orbit 9s linear infinite reverse',
    pointerEvents: 'none',
  } as CSSStyleDeclaration);

  const frameLabel = document.createElement('div');
  frameLabel.textContent = 'SECURED ENTRY';
  Object.assign(frameLabel.style, {
    position: 'absolute',
    top: '28px',
    left: '32px',
    padding: '7px 12px',
    borderRadius: '999px',
    background: 'rgba(7,8,10,0.42)',
    border: '1px solid rgba(255,255,255,0.14)',
    color: '#f4f1e8',
    letterSpacing: '0.2em',
    fontSize: '10px',
    fontWeight: '600',
    pointerEvents: 'none',
    backdropFilter: 'blur(8px)',
  } as CSSStyleDeclaration);

  const leftDoor = document.createElement('div');
  leftDoor.id = 'worldmonitor-door-left';
  Object.assign(leftDoor.style, {
    position: 'absolute',
    top: '0',
    left: '0',
    width: '50%',
    height: '100%',
    transform: 'translateX(0)',
    transition: `transform ${UNLOCK_DOOR_OPEN_MS}ms cubic-bezier(0.16, 0.84, 0.18, 1), opacity ${UNLOCK_DOOR_OPEN_MS}ms ease`,
    background: `
      linear-gradient(180deg, rgba(255,255,255,0.28), rgba(255,255,255,0.06) 10%, rgba(0,0,0,0) 22%),
      linear-gradient(90deg, rgba(255,255,255,0.10), rgba(255,255,255,0) 20%, rgba(255,255,255,0.05) 74%, rgba(0,0,0,0.12)),
      conic-gradient(from 180deg at 58% 50%, rgba(255,255,255,0.14), rgba(255,255,255,0.02), rgba(255,255,255,0.10), rgba(0,0,0,0.02), rgba(255,255,255,0.14)),
      repeating-linear-gradient(
        90deg,
        rgba(255,255,255,0.032) 0 1px,
        rgba(255,255,255,0.011) 1px 10px,
        rgba(0,0,0,0.016) 10px 18px
      ),
      linear-gradient(180deg, rgba(184,188,193,0.99), rgba(136,141,147,0.99) 24%, rgba(86,90,96,0.994) 54%, rgba(44,46,50,0.997))
    `,
    boxShadow: `
      inset -26px 0 30px rgba(0,0,0,0.20),
      inset 0 0 0 1px rgba(255,255,255,0.14),
      inset 0 1px 0 rgba(255,255,255,0.20)
    `,
  } as CSSStyleDeclaration);

  const rightDoor = document.createElement('div');
  rightDoor.id = 'worldmonitor-door-right';
  Object.assign(rightDoor.style, {
    position: 'absolute',
    top: '0',
    right: '0',
    width: '50%',
    height: '100%',
    transform: 'translateX(0)',
    transition: `transform ${UNLOCK_DOOR_OPEN_MS}ms cubic-bezier(0.16, 0.84, 0.18, 1), opacity ${UNLOCK_DOOR_OPEN_MS}ms ease`,
    background: `
      linear-gradient(180deg, rgba(255,255,255,0.28), rgba(255,255,255,0.06) 10%, rgba(0,0,0,0) 22%),
      linear-gradient(270deg, rgba(255,255,255,0.10), rgba(255,255,255,0) 20%, rgba(255,255,255,0.05) 74%, rgba(0,0,0,0.12)),
      conic-gradient(from 180deg at 42% 50%, rgba(255,255,255,0.14), rgba(255,255,255,0.02), rgba(255,255,255,0.10), rgba(0,0,0,0.02), rgba(255,255,255,0.14)),
      repeating-linear-gradient(
        90deg,
        rgba(255,255,255,0.032) 0 1px,
        rgba(255,255,255,0.011) 1px 10px,
        rgba(0,0,0,0.016) 10px 18px
      ),
      linear-gradient(180deg, rgba(184,188,193,0.99), rgba(136,141,147,0.99) 24%, rgba(86,90,96,0.994) 54%, rgba(44,46,50,0.997))
    `,
    boxShadow: `
      inset 26px 0 30px rgba(0,0,0,0.20),
      inset 0 0 0 1px rgba(255,255,255,0.14),
      inset 0 1px 0 rgba(255,255,255,0.20)
    `,
  } as CSSStyleDeclaration);

  const centerBeam = document.createElement('div');
  Object.assign(centerBeam.style, {
    position: 'absolute',
    top: '0',
    left: '50%',
    width: '5px',
    height: '100%',
    transform: 'translateX(-50%)',
    opacity: '0.8',
    transition: `opacity ${UNLOCK_DOOR_OPEN_MS}ms ease, box-shadow ${UNLOCK_DOOR_OPEN_MS}ms ease`,
    background: 'linear-gradient(180deg, rgba(255,255,255,0), rgba(255,252,245,0.95), rgba(255,255,255,0))',
    boxShadow: '0 0 24px rgba(255,252,245,0.34)',
    animation: 'wm-biometry-beam 3s ease-in-out infinite',
  } as CSSStyleDeclaration);

  const panel = document.createElement('div');
  Object.assign(panel.style, {
    position: 'absolute',
    top: '50%',
    left: '50%',
    width: 'min(480px, calc(100vw - 40px))',
    transform: 'translate(-50%, -50%)',
    padding: '34px 30px',
    borderRadius: '28px',
    background: `
      linear-gradient(180deg, rgba(255,255,255,0.26), rgba(255,255,255,0.06) 10%, rgba(255,255,255,0) 20%),
      conic-gradient(from 180deg at 50% 0%, rgba(255,255,255,0.12), rgba(255,255,255,0.02), rgba(255,255,255,0.10), rgba(255,255,255,0.03), rgba(255,255,255,0.12)),
      linear-gradient(180deg, rgba(164,169,175,0.38), rgba(58,61,66,0.76) 22%, rgba(27,29,33,0.88))
    `,
    border: '1px solid rgba(255,255,255,0.20)',
    boxShadow: `
      0 28px 72px rgba(0,0,0,0.48),
      inset 0 1px 0 rgba(255,255,255,0.26),
      inset 0 -12px 18px rgba(0,0,0,0.16)
    `,
    backdropFilter: 'blur(14px)',
    transition: 'transform 1100ms cubic-bezier(0.18, 0.8, 0.2, 1), opacity 1100ms ease, filter 1100ms ease',
    animation: 'wm-biometry-float 5.8s ease-in-out infinite',
  } as CSSStyleDeclaration);

  const commandLine = document.createElement('div');
  commandLine.textContent = 'WORLD MONITOR // COMMAND ACCESS';
  Object.assign(commandLine.style, {
    marginBottom: '16px',
    color: 'rgba(223,231,240,0.78)',
    letterSpacing: '0.28em',
    fontSize: '10px',
    fontWeight: '700',
  } as CSSStyleDeclaration);

  const biometricHero = document.createElement('div');
  biometricHero.id = 'worldmonitor-biometric-hero';
  Object.assign(biometricHero.style, {
    position: 'relative',
    width: '132px',
    height: '132px',
    margin: '0 auto 20px',
    borderRadius: '50%',
    background: `
      radial-gradient(circle at 50% 30%, rgba(255,255,255,0.18), rgba(255,255,255,0.04) 28%, rgba(0,0,0,0) 62%),
      linear-gradient(180deg, rgba(255,255,255,0.10), rgba(255,255,255,0.02))
    `,
    border: '1px solid rgba(255,255,255,0.10)',
    boxShadow: `
      inset 0 1px 0 rgba(255,255,255,0.18),
      0 20px 40px rgba(0,0,0,0.18)
    `,
    overflow: 'hidden',
    backdropFilter: 'blur(18px)',
  } as CSSStyleDeclaration);
  biometricHero.style.setProperty('-webkit-backdrop-filter', 'blur(18px)');

  const biometricRing = document.createElement('div');
  Object.assign(biometricRing.style, {
    position: 'absolute',
    inset: '10px',
    borderRadius: '50%',
    border: '1px solid rgba(188, 225, 255, 0.22)',
    boxShadow: '0 0 24px rgba(188,225,255,0.12)',
    animation: 'wm-biometry-pulse 2.8s ease-in-out infinite',
  } as CSSStyleDeclaration);

  const fingerprintWrap = document.createElement('div');
  Object.assign(fingerprintWrap.style, {
    position: 'absolute',
    inset: '24px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  } as CSSStyleDeclaration);

  const fingerprintIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  fingerprintIcon.setAttribute('viewBox', '0 0 96 96');
  fingerprintIcon.setAttribute('width', '78');
  fingerprintIcon.setAttribute('height', '78');
  fingerprintIcon.setAttribute('aria-hidden', 'true');
  fingerprintIcon.innerHTML = `
    <defs>
      <linearGradient id="wm-fingerprint-stroke" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="rgba(248,250,252,0.96)" />
        <stop offset="52%" stop-color="rgba(193,226,255,0.94)" />
        <stop offset="100%" stop-color="rgba(255,255,255,0.82)" />
      </linearGradient>
    </defs>
    <g fill="none" stroke="url(#wm-fingerprint-stroke)" stroke-linecap="round" stroke-width="3.2" opacity="0.96">
      <path d="M48 16c-14.2 0-25.7 11.5-25.7 25.7v7.1" />
      <path d="M48 24.2c-9.7 0-17.5 7.8-17.5 17.5v10" />
      <path d="M48 32.1c-5.3 0-9.6 4.3-9.6 9.6v15.5" />
      <path d="M57.8 37.7c-1.4-4.7-5.8-8.1-10.9-8.1-6.3 0-11.5 5.1-11.5 11.5v9.5" />
      <path d="M67.6 43.8v-1.6c0-10.8-8.8-19.6-19.6-19.6S28.4 31.4 28.4 42.2v19.5" />
      <path d="M74.5 47.9v-5.2C74.5 28 62.6 16 48 16S21.5 28 21.5 42.7v19.9" />
      <path d="M51.9 49.2v8.3c0 8.7-3.6 16.8-9.9 22.6" />
      <path d="M59.7 51.8v5.8c0 10.9-4.4 21.1-12.2 28.7" />
      <path d="M67.8 55.1c-.3 12.4-5.4 24-14.2 32.4" />
      <path d="M44 57.8c0 5.8-2 11.5-5.8 16" />
    </g>
  `;
  fingerprintIcon.style.filter = 'drop-shadow(0 0 16px rgba(193,226,255,0.18))';

  const scanLine = document.createElement('div');
  Object.assign(scanLine.style, {
    position: 'absolute',
    left: '20px',
    right: '20px',
    top: '50%',
    height: '14px',
    borderRadius: '999px',
    background: 'linear-gradient(180deg, rgba(255,255,255,0), rgba(194, 232, 255, 0.92), rgba(255,255,255,0))',
    boxShadow: '0 0 18px rgba(194,232,255,0.28)',
    animation: 'wm-biometry-scan-line 2.6s ease-in-out infinite',
    pointerEvents: 'none',
  } as CSSStyleDeclaration);

  const biometricCaption = document.createElement('div');
  biometricCaption.textContent = 'BIOMETRIC SIGNATURE VERIFIED';
  Object.assign(biometricCaption.style, {
    margin: '0 auto 18px',
    textAlign: 'center',
    color: 'rgba(219,231,242,0.74)',
    letterSpacing: '0.22em',
    fontSize: '10px',
    fontWeight: '700',
  } as CSSStyleDeclaration);

  fingerprintWrap.appendChild(fingerprintIcon);
  biometricHero.appendChild(biometricRing);
  biometricHero.appendChild(fingerprintWrap);
  biometricHero.appendChild(scanLine);

  const telemetry = document.createElement('div');
  Object.assign(telemetry.style, {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: '10px',
    margin: '0 0 18px',
  } as CSSStyleDeclaration);

  const telemetryLabels = [
    ['BAY', 'A-12'],
    ['SEAL', 'LOCKED'],
    ['AUTH', 'BIOMETRIC'],
  ] as const;
  telemetryLabels.forEach(([label, value]) => {
    const item = document.createElement('div');
    Object.assign(item.style, {
      padding: '10px 12px',
      borderRadius: '14px',
      background: 'linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02))',
      border: '1px solid rgba(255,255,255,0.08)',
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08)',
    } as CSSStyleDeclaration);

    const k = document.createElement('div');
    k.textContent = label;
    Object.assign(k.style, {
      fontSize: '10px',
      letterSpacing: '0.18em',
      color: 'rgba(235,239,244,0.52)',
      marginBottom: '6px',
    } as CSSStyleDeclaration);

    const v = document.createElement('div');
    v.textContent = value;
    Object.assign(v.style, {
      fontSize: '14px',
      fontWeight: '600',
      color: '#f8f7f2',
    } as CSSStyleDeclaration);

    item.appendChild(k);
    item.appendChild(v);
    telemetry.appendChild(item);
  });

  const statusPill = document.createElement('div');
  statusPill.textContent = 'SECURE AIRLOCK';
  Object.assign(statusPill.style, {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    marginBottom: '18px',
    padding: '7px 12px',
    borderRadius: '999px',
    letterSpacing: '0.18em',
    fontSize: '10px',
    fontWeight: '600',
    color: '#f1eee5',
    background: 'linear-gradient(180deg, rgba(255,255,255,0.10), rgba(255,255,255,0.02))',
    border: '1px solid rgba(255,255,255,0.14)',
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.10)',
  } as CSSStyleDeclaration);

  const title = document.createElement('h2');
  title.textContent = 'Unlocking World Monitor';
  Object.assign(title.style, {
    margin: '0 0 12px',
    fontSize: '28px',
    fontWeight: '500',
    letterSpacing: '-0.02em',
    color: '#fffefb',
  } as CSSStyleDeclaration);

  const message = document.createElement('p');
  message.textContent = 'Use Touch ID or your device passcode in the system prompt.';
  Object.assign(message.style, {
    margin: '0 0 22px',
    lineHeight: '1.55',
    color: '#e4e1d8',
  } as CSSStyleDeclaration);

  const buttons = document.createElement('div');
  Object.assign(buttons.style, {
    display: 'none',
    gap: '12px',
    justifyContent: 'flex-end',
    alignItems: 'center',
    marginTop: '6px',
  } as CSSStyleDeclaration);

  const quit = document.createElement('button');
  quit.textContent = 'Quit';
  Object.assign(quit.style, {
    minWidth: '108px',
    padding: '11px 18px',
    borderRadius: '999px',
    background: `
      linear-gradient(180deg, rgba(255,255,255,0.12), rgba(255,255,255,0.03)),
      rgba(248, 249, 251, 0.04)
    `,
    color: 'rgba(249,247,242,0.94)',
    border: '1px solid rgba(255,255,255,0.12)',
    boxShadow: `
      inset 0 1px 0 rgba(255,255,255,0.16),
      0 8px 18px rgba(0,0,0,0.10)
    `,
    fontSize: '16px',
    fontWeight: '500',
    letterSpacing: '-0.01em',
    backdropFilter: 'blur(16px)',
    cursor: 'pointer',
    transition: 'transform 180ms ease, box-shadow 180ms ease, background 180ms ease',
  } as CSSStyleDeclaration);
  quit.style.setProperty('-webkit-backdrop-filter', 'blur(16px)');
  quit.onclick = () => window.close();

  const button = document.createElement('button');
  button.textContent = 'Authenticate';
  Object.assign(button.style, {
    minWidth: '168px',
    padding: '11px 22px',
    borderRadius: '999px',
    background: `
      linear-gradient(180deg, rgba(255,255,255,0.52), rgba(255,255,255,0.18) 22%, rgba(255,255,255,0.04) 40%),
      linear-gradient(180deg, #f4f6f8, #d8dde2 48%, #c1c7ce 100%)
    `,
    color: '#1b1d21',
    border: '1px solid rgba(255,255,255,0.42)',
    fontSize: '16px',
    fontWeight: '600',
    letterSpacing: '-0.01em',
    boxShadow: `
      inset 0 1px 0 rgba(255,255,255,0.80),
      inset 0 -1px 0 rgba(140,148,160,0.28),
      0 10px 24px rgba(0,0,0,0.16)
    `,
    backdropFilter: 'blur(18px)',
    cursor: 'pointer',
    transition: 'transform 180ms ease, box-shadow 180ms ease, filter 180ms ease',
  } as CSSStyleDeclaration);
  button.style.setProperty('-webkit-backdrop-filter', 'blur(18px)');

  buttons.appendChild(quit);
  buttons.appendChild(button);
  panel.appendChild(commandLine);
  panel.appendChild(biometricHero);
  panel.appendChild(biometricCaption);
  panel.appendChild(statusPill);
  panel.appendChild(title);
  panel.appendChild(message);
  panel.appendChild(telemetry);
  panel.appendChild(buttons);
  stage.appendChild(starfield);
  stage.appendChild(airlockDepth);
  stage.appendChild(portalGlow);
  stage.appendChild(depthShafts);
  stage.appendChild(apertureRing);
  stage.appendChild(airlockCrown);
  stage.appendChild(ambientGrid);
  stage.appendChild(deckReflection);
  stage.appendChild(thresholdPlate);
  stage.appendChild(lightSweep);
  stage.appendChild(lockFrame);
  stage.appendChild(orbitRing);
  stage.appendChild(orbitArc);
  stage.appendChild(frameLabel);
  stage.appendChild(leftDoor);
  stage.appendChild(rightDoor);
  stage.appendChild(leftTrack);
  stage.appendChild(rightTrack);
  stage.appendChild(centerBeam);
  stage.appendChild(panel);
  container.appendChild(stage);
  document.body.appendChild(container);
  return {
    container,
    stage,
    portalGlow,
    message,
    button,
    quit,
    buttons,
    panel,
    title,
    statusPill,
    biometricHero,
    biometricCaption,
    scanLine,
    leftDoor,
    rightDoor,
    centerBeam,
    visibleAt: Date.now(),
    releasePresentation,
  };
}

function playUnlockSound(): void {
  const AudioContextCtor = window.AudioContext
    ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return;

  let ctx: AudioContext;
  try {
    ctx = new AudioContextCtor();
  } catch {
    return;
  }

  const now = ctx.currentTime;
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.setValueAtTime(-22, now);
  compressor.knee.setValueAtTime(18, now);
  compressor.ratio.setValueAtTime(2.6, now);
  compressor.attack.setValueAtTime(0.003, now);
  compressor.release.setValueAtTime(0.18, now);

  const convolver = ctx.createConvolver();
  const impulseSeconds = 1.8;
  const impulse = ctx.createBuffer(2, Math.floor(ctx.sampleRate * impulseSeconds), ctx.sampleRate);
  for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
    const impulseData = impulse.getChannelData(channel);
    for (let i = 0; i < impulseData.length; i += 1) {
      const decay = Math.pow(1 - i / impulseData.length, 2.4);
      impulseData[i] = (Math.random() * 2 - 1) * decay * (channel === 0 ? 0.75 : 0.62);
    }
  }
  convolver.buffer = impulse;

  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, now);
  master.gain.exponentialRampToValueAtTime(0.4, now + 0.06);
  master.gain.exponentialRampToValueAtTime(0.26, now + 0.56);
  master.gain.exponentialRampToValueAtTime(
    0.0001,
    now + (UNLOCK_SOUND_DOOR_SWELL_MS + 520) / 1000,
  );
  const wet = ctx.createGain();
  wet.gain.setValueAtTime(0.16, now);
  const dry = ctx.createGain();
  dry.gain.setValueAtTime(0.92, now);
  master.connect(dry);
  master.connect(convolver);
  convolver.connect(wet);
  dry.connect(compressor);
  wet.connect(compressor);
  compressor.connect(ctx.destination);

  const notes = [
    { freq: 164.81, start: 0.00, duration: 0.28, gain: 0.16, type: 'triangle' },
    { freq: 220.00, start: 0.08, duration: 0.36, gain: 0.11, type: 'triangle' },
    { freq: 329.63, start: 0.22, duration: 0.92, gain: 0.052, type: 'sine' },
    { freq: 493.88, start: 0.38, duration: 0.84, gain: 0.03, type: 'sine' },
  ];

  for (const note of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const notePanner = ctx.createStereoPanner();
    const start = now + note.start;
    const end = start + note.duration;
    osc.type = note.type as OscillatorType;
    osc.frequency.setValueAtTime(note.freq, start);
    osc.frequency.exponentialRampToValueAtTime(note.freq * 1.04, end);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(note.gain, start + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    notePanner.pan.setValueAtTime(note.freq > 300 ? 0.18 : -0.12, start);
    osc.connect(gain);
    gain.connect(notePanner);
    notePanner.connect(master);
    osc.start(start);
    osc.stop(end + 0.03);
  }

  const sealNoiseBuffer = ctx.createBuffer(
    1,
    Math.floor(ctx.sampleRate * (UNLOCK_SOUND_SEAL_TRANSIENT_MS / 1000)),
    ctx.sampleRate,
  );
  const sealData = sealNoiseBuffer.getChannelData(0);
  for (let i = 0; i < sealData.length; i += 1) {
    sealData[i] = (Math.random() * 2 - 1) * (1 - i / sealData.length);
  }
  const sealNoise = ctx.createBufferSource();
  sealNoise.buffer = sealNoiseBuffer;
  const sealNoiseFilter = ctx.createBiquadFilter();
  sealNoiseFilter.type = 'highpass';
  sealNoiseFilter.frequency.setValueAtTime(1400, now);
  sealNoiseFilter.Q.setValueAtTime(0.8, now);
  const sealNoiseGain = ctx.createGain();
  sealNoiseGain.gain.setValueAtTime(0.0001, now);
  sealNoiseGain.gain.exponentialRampToValueAtTime(0.12, now + 0.03);
  sealNoiseGain.gain.exponentialRampToValueAtTime(
    0.0001,
    now + UNLOCK_SOUND_SEAL_TRANSIENT_MS / 1000,
  );
  sealNoise.connect(sealNoiseFilter);
  sealNoiseFilter.connect(sealNoiseGain);
  sealNoiseGain.connect(master);
  sealNoise.start(now);
  sealNoise.stop(now + UNLOCK_SOUND_SEAL_TRANSIENT_MS / 1000);

  const doorNoiseBuffer = ctx.createBuffer(
    1,
    Math.floor(ctx.sampleRate * (UNLOCK_SOUND_DOOR_SWELL_MS / 1000)),
    ctx.sampleRate,
  );
  const doorData = doorNoiseBuffer.getChannelData(0);
  for (let i = 0; i < doorData.length; i += 1) {
    doorData[i] = (Math.random() * 2 - 1) * 0.42;
  }
  const doorNoise = ctx.createBufferSource();
  doorNoise.buffer = doorNoiseBuffer;
  const doorRumbleFilter = ctx.createBiquadFilter();
  doorRumbleFilter.type = 'lowpass';
  doorRumbleFilter.frequency.setValueAtTime(180, now);
  doorRumbleFilter.frequency.linearRampToValueAtTime(
    320,
    now + UNLOCK_SOUND_DOOR_SWELL_MS / 1000,
  );
  doorRumbleFilter.Q.setValueAtTime(0.3, now);
  const doorRumbleGain = ctx.createGain();
  const doorRumblePanner = ctx.createStereoPanner();
  doorRumbleGain.gain.setValueAtTime(0.0001, now + 0.08);
  doorRumbleGain.gain.exponentialRampToValueAtTime(0.09, now + 0.28);
  doorRumbleGain.gain.exponentialRampToValueAtTime(
    0.036,
    now + (UNLOCK_SOUND_DOOR_SWELL_MS - 260) / 1000,
  );
  doorRumbleGain.gain.exponentialRampToValueAtTime(
    0.0001,
    now + UNLOCK_SOUND_DOOR_SWELL_MS / 1000,
  );
  doorNoise.connect(doorRumbleFilter);
  doorRumbleFilter.connect(doorRumbleGain);
  doorRumblePanner.pan.setValueAtTime(-0.08, now + 0.08);
  doorRumblePanner.pan.linearRampToValueAtTime(0.12, now + UNLOCK_SOUND_DOOR_SWELL_MS / 1000);
  doorRumbleGain.connect(doorRumblePanner);
  doorRumblePanner.connect(master);
  doorNoise.start(now + 0.06);
  doorNoise.stop(now + UNLOCK_SOUND_DOOR_SWELL_MS / 1000);

  const hydraulicNoiseBuffer = ctx.createBuffer(
    1,
    Math.floor(ctx.sampleRate * (UNLOCK_SOUND_DOOR_SWELL_MS / 1000)),
    ctx.sampleRate,
  );
  const hydraulicData = hydraulicNoiseBuffer.getChannelData(0);
  for (let i = 0; i < hydraulicData.length; i += 1) {
    hydraulicData[i] = (Math.random() * 2 - 1) * 0.22;
  }
  const hydraulicNoise = ctx.createBufferSource();
  hydraulicNoise.buffer = hydraulicNoiseBuffer;
  const hydraulicNoiseFilter = ctx.createBiquadFilter();
  hydraulicNoiseFilter.type = 'bandpass';
  hydraulicNoiseFilter.frequency.setValueAtTime(520, now + 0.08);
  hydraulicNoiseFilter.frequency.linearRampToValueAtTime(
    420,
    now + UNLOCK_SOUND_DOOR_SWELL_MS / 1000,
  );
  hydraulicNoiseFilter.Q.setValueAtTime(0.7, now);
  const hydraulicTailFilter = ctx.createBiquadFilter();
  hydraulicTailFilter.type = 'highshelf';
  hydraulicTailFilter.frequency.setValueAtTime(2600, now);
  hydraulicTailFilter.gain.setValueAtTime(-6, now);
  const hydraulicNoiseGain = ctx.createGain();
  const hydraulicNoisePanner = ctx.createStereoPanner();
  hydraulicNoiseGain.gain.setValueAtTime(0.0001, now + 0.08);
  hydraulicNoiseGain.gain.exponentialRampToValueAtTime(0.048, now + 0.18);
  hydraulicNoiseGain.gain.exponentialRampToValueAtTime(
    0.028,
    now + (UNLOCK_SOUND_DOOR_SWELL_MS - 180) / 1000,
  );
  hydraulicNoiseGain.gain.exponentialRampToValueAtTime(
    0.0001,
    now + UNLOCK_SOUND_DOOR_SWELL_MS / 1000,
  );
  hydraulicNoise.connect(hydraulicNoiseFilter);
  hydraulicNoiseFilter.connect(hydraulicTailFilter);
  hydraulicTailFilter.connect(hydraulicNoiseGain);
  hydraulicNoisePanner.pan.setValueAtTime(0.16, now + 0.08);
  hydraulicNoisePanner.pan.linearRampToValueAtTime(-0.1, now + UNLOCK_SOUND_DOOR_SWELL_MS / 1000);
  hydraulicNoiseGain.connect(hydraulicNoisePanner);
  hydraulicNoisePanner.connect(master);
  hydraulicNoise.start(now + 0.08);
  hydraulicNoise.stop(now + UNLOCK_SOUND_DOOR_SWELL_MS / 1000);

  const servoOsc = ctx.createOscillator();
  servoOsc.type = 'sawtooth';
  servoOsc.frequency.setValueAtTime(72, now + 0.1);
  servoOsc.frequency.exponentialRampToValueAtTime(
    104,
    now + UNLOCK_SOUND_DOOR_SWELL_MS / 1000,
  );
  const servoGain = ctx.createGain();
  const servoPanner = ctx.createStereoPanner();
  servoGain.gain.setValueAtTime(0.0001, now + 0.1);
  servoGain.gain.exponentialRampToValueAtTime(0.044, now + 0.22);
  servoGain.gain.exponentialRampToValueAtTime(0.0001, now + UNLOCK_SOUND_DOOR_SWELL_MS / 1000);
  servoPanner.pan.setValueAtTime(-0.22, now + 0.1);
  servoPanner.pan.linearRampToValueAtTime(0.2, now + UNLOCK_SOUND_DOOR_SWELL_MS / 1000);
  servoOsc.connect(servoGain);
  servoGain.connect(servoPanner);
  servoPanner.connect(master);
  servoOsc.start(now + 0.1);
  servoOsc.stop(now + UNLOCK_SOUND_DOOR_SWELL_MS / 1000 + 0.04);

  const hydraulicPulseOsc = ctx.createOscillator();
  hydraulicPulseOsc.type = 'triangle';
  hydraulicPulseOsc.frequency.setValueAtTime(26, now + 0.08);
  hydraulicPulseOsc.frequency.exponentialRampToValueAtTime(
    42,
    now + UNLOCK_SOUND_DOOR_SWELL_MS / 1000,
  );
  const hydraulicPulseGain = ctx.createGain();
  const hydraulicPulsePanner = ctx.createStereoPanner();
  hydraulicPulseGain.gain.setValueAtTime(0.0001, now + 0.08);
  hydraulicPulseGain.gain.linearRampToValueAtTime(0.026, now + 0.24);
  hydraulicPulseGain.gain.linearRampToValueAtTime(0.013, now + 0.56);
  hydraulicPulseGain.gain.linearRampToValueAtTime(0.022, now + 0.94);
  hydraulicPulseGain.gain.linearRampToValueAtTime(0.01, now + 1.34);
  hydraulicPulseGain.gain.exponentialRampToValueAtTime(
    0.0001,
    now + UNLOCK_SOUND_DOOR_SWELL_MS / 1000,
  );
  hydraulicPulsePanner.pan.setValueAtTime(0.1, now + 0.08);
  hydraulicPulsePanner.pan.linearRampToValueAtTime(-0.14, now + UNLOCK_SOUND_DOOR_SWELL_MS / 1000);
  hydraulicPulseOsc.connect(hydraulicPulseGain);
  hydraulicPulseGain.connect(hydraulicPulsePanner);
  hydraulicPulsePanner.connect(master);
  hydraulicPulseOsc.start(now + 0.08);
  hydraulicPulseOsc.stop(now + UNLOCK_SOUND_DOOR_SWELL_MS / 1000 + 0.04);

  void sleep(2300).then(() => ctx.close().catch(() => {}));
}

async function playUnlockCelebration(overlay: OverlayElements): Promise<void> {
  const {
    container,
    stage,
    portalGlow,
    panel,
    title,
    message,
    statusPill,
    biometricHero,
    biometricCaption,
    scanLine,
    leftDoor,
    rightDoor,
    centerBeam,
    button,
    quit,
    visibleAt,
    releasePresentation,
  } = overlay;

  statusPill.textContent = 'ACCESS GRANTED';
  statusPill.style.color = '#fff8ea';
  statusPill.style.background = 'linear-gradient(180deg, rgba(244, 226, 181, 0.24), rgba(112, 91, 42, 0.16))';
  statusPill.style.borderColor = 'rgba(255, 240, 208, 0.24)';
  title.textContent = 'Identity Match Confirmed';
  message.textContent = 'Stand by while the inner airlock cycles open.';
  biometricCaption.textContent = 'BIOMETRIC MATCH CONFIRMED';
  biometricCaption.style.color = 'rgba(255, 244, 214, 0.94)';
  button.style.opacity = '0.18';
  quit.style.opacity = '0.18';
  button.style.pointerEvents = 'none';
  quit.style.pointerEvents = 'none';
  biometricHero.style.animation = 'wm-biometry-success-bloom 760ms cubic-bezier(0.22, 0.84, 0.22, 1) forwards';
  biometricHero.style.borderColor = 'rgba(255, 243, 207, 0.34)';
  biometricHero.style.boxShadow = `
    inset 0 1px 0 rgba(255,255,255,0.26),
    0 28px 64px rgba(0,0,0,0.24),
    0 0 72px rgba(255,244,214,0.18)
  `;
  scanLine.style.animation = 'wm-biometry-fingerprint-verify 720ms cubic-bezier(0.2, 0.76, 0.2, 1) 2';
  scanLine.style.height = '18px';
  scanLine.style.left = '16px';
  scanLine.style.right = '16px';
  scanLine.style.background = 'linear-gradient(180deg, rgba(255,255,255,0), rgba(255, 243, 207, 0.98), rgba(255,255,255,0))';
  scanLine.style.boxShadow = '0 0 30px rgba(255,243,207,0.34)';
  stage.style.boxShadow = `
    0 40px 160px rgba(0,0,0,0.62),
    inset 0 0 90px rgba(255, 244, 220, 0.14)
  `;
  portalGlow.style.opacity = '0.92';
  portalGlow.style.filter = 'blur(26px)';
  portalGlow.style.transform = 'translate(-50%, -50%) scale(1.03)';

  const elapsed = Date.now() - visibleAt;
  if (elapsed < MIN_OVERLAY_VISIBLE_MS) {
    await sleep(MIN_OVERLAY_VISIBLE_MS - elapsed);
  }

  playUnlockSound();

  await sleep(UNLOCK_SCAN_SETTLE_MS);
  title.textContent = 'Command Deck Unsealed';
  message.textContent = 'Bulkheads disengaged. Welcome aboard.';
  panel.style.transform = 'translate(-50%, -50%) scale(0.985)';
  stage.style.boxShadow = `
    0 44px 172px rgba(0,0,0,0.62),
    inset 0 0 120px rgba(255, 247, 231, 0.18)
  `;
  portalGlow.style.opacity = '1';
  portalGlow.style.filter = 'blur(34px)';
  portalGlow.style.transform = 'translate(-50%, -50%) scale(1.08)';

  await sleep(UNLOCK_PANEL_SETTLE_MS);

  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      centerBeam.style.animation = `wm-biometry-seal-break ${UNLOCK_SEAL_BREAK_MS}ms cubic-bezier(0.24, 0.84, 0.28, 1) forwards`;
      centerBeam.style.opacity = '1';
      centerBeam.style.boxShadow = '0 0 84px rgba(255,248,231,0.78)';
      portalGlow.style.opacity = '1';
      portalGlow.style.filter = 'blur(42px)';
      portalGlow.style.transform = 'translate(-50%, -50%) scale(1.12)';
      window.setTimeout(() => {
        panel.style.transform = 'translate(-50%, -50%) translateY(-10px) scale(0.96)';
        panel.style.opacity = '0';
        panel.style.filter = 'blur(10px)';
      }, UNLOCK_PANEL_WITHDRAW_MS);
      window.setTimeout(() => {
        leftDoor.style.transform = 'translateX(-108%)';
        leftDoor.style.opacity = '0.34';
        leftDoor.style.boxShadow = `
          inset -38px 0 48px rgba(0,0,0,0.24),
          inset 0 0 0 1px rgba(255,255,255,0.14),
          inset 0 1px 0 rgba(255,255,255,0.20),
          26px 0 42px rgba(255,248,231,0.14)
        `;
        rightDoor.style.transform = 'translateX(108%)';
        rightDoor.style.opacity = '0.34';
        rightDoor.style.boxShadow = `
          inset 38px 0 48px rgba(0,0,0,0.24),
          inset 0 0 0 1px rgba(255,255,255,0.14),
          inset 0 1px 0 rgba(255,255,255,0.20),
          -26px 0 42px rgba(255,248,231,0.14)
        `;
      }, UNLOCK_SEAL_BREAK_MS);
      container.style.transition = `opacity ${UNLOCK_EXIT_FADE_MS}ms ease`;
      window.setTimeout(() => {
        container.style.opacity = '0';
      }, UNLOCK_DOOR_OPEN_MS - UNLOCK_EXIT_FADE_MS);
      window.setTimeout(resolve, UNLOCK_DOOR_OPEN_MS);
    });
  });

  releasePresentation();
  container.remove();
}

export async function ensureBiometricUnlock(): Promise<boolean> {
  const overlay = ensureOverlay();
  const { message, button, quit, buttons, title } = overlay;

  const updateMessage = (text: string) => { message.textContent = text; };
  let fallbackActionsVisible = false;
  const setBusy = (busy: boolean) => {
    button.disabled = busy;
    button.textContent = busy ? 'Authenticating…' : fallbackActionsVisible ? 'Try Again' : 'Authenticate';
  };
  const showFallbackActions = () => {
    fallbackActionsVisible = true;
    buttons.style.display = 'flex';
    title.textContent = 'Authenticate to Continue';
    button.textContent = 'Try Again';
  };

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let inFlight: Promise<boolean> | null = null;
    let autoResumeArmed = false;

    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      disarmAutoResume();
      overlay.releasePresentation();
      resolve(value);
    };

    const disarmAutoResume = () => {
      if (!autoResumeArmed) return;
      autoResumeArmed = false;
      window.removeEventListener('focus', resumeAutoAuth);
      document.removeEventListener('visibilitychange', resumeAutoAuth);
    };

    const resumeAutoAuth = () => {
      if (settled || inFlight || !isInteractiveWindow()) return;
      disarmAutoResume();
      updateMessage('Preparing Touch ID...');
      void sleep(AUTO_PROMPT_DELAY_MS).then(() => {
        void tryAuth(false);
      });
    };

    const armAutoResume = () => {
      if (autoResumeArmed) return;
      autoResumeArmed = true;
      window.addEventListener('focus', resumeAutoAuth);
      document.addEventListener('visibilitychange', resumeAutoAuth);
    };

    const tryAuth = async (manual: boolean): Promise<boolean> => {
      if (settled) return false;
      if (inFlight) return inFlight;

      inFlight = (async () => {
        disarmAutoResume();
        setBusy(true);
        if (manual) {
          updateMessage('Authenticating with the shipboard lock...');
        }

        try {
          await invokePlugin<void>(INVOKE_CMD_AUTHENTICATE, {
            reason: AUTH_REASON,
            options: {
              allowDeviceCredential: true,
            },
          });
          await playUnlockCelebration(overlay);
          settle(true);
          return true;
        } catch (err) {
          showFallbackActions();
          updateMessage(
            err instanceof Error
              ? err.message
              : 'Authentication failed. Try Again to continue.',
          );
          setBusy(false);
          return false;
        } finally {
          inFlight = null;
        }
      })();

      return inFlight;
    };

    quit.onclick = () => {
      settle(false);
      window.close();
    };

    button.onclick = () => {
      void tryAuth(true);
    };

    void (async () => {
      updateMessage('Preparing Touch ID...');
      const windowReady = await waitForInteractiveWindow();
      if (!windowReady) {
        updateMessage('Bring World Monitor to the front. Authentication will start automatically.');
        armAutoResume();
        return;
      }

      resumeAutoAuth();
    })();
  });
}
