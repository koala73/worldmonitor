import { hasTauriInvokeBridge, invokeTauri } from '../services/tauri-bridge';

const INVOKE_CMD_AUTHENTICATE = 'plugin:biometry|authenticate';
const BRIDGE_READY_TIMEOUT_MS = 2500;
const BRIDGE_READY_POLL_MS = 50;
const WINDOW_READY_TIMEOUT_MS = 4000;
const WINDOW_READY_POLL_MS = 100;
const AUTO_PROMPT_DELAY_MS = 450;
const MIN_OVERLAY_VISIBLE_MS = 900;
const AUTH_REASON = 'Unlock World Monitor';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type OverlayElements = {
  container: HTMLDivElement;
  stage: HTMLDivElement;
  message: HTMLParagraphElement;
  button: HTMLButtonElement;
  quit: HTMLButtonElement;
  panel: HTMLDivElement;
  title: HTMLHeadingElement;
  statusPill: HTMLDivElement;
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

async function waitForInteractiveWindow(): Promise<boolean> {
  const deadline = Date.now() + WINDOW_READY_TIMEOUT_MS;
  while (document.visibilityState !== 'visible' || !document.hasFocus()) {
    if (Date.now() >= deadline) {
      return false;
    }
    await sleep(WINDOW_READY_POLL_MS);
  }

  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
  return true;
}

function ensureOverlay(): {
  container: HTMLDivElement;
  stage: HTMLDivElement;
  message: HTMLParagraphElement;
  button: HTMLButtonElement;
  quit: HTMLButtonElement;
  panel: HTMLDivElement;
  title: HTMLHeadingElement;
  statusPill: HTMLDivElement;
  leftDoor: HTMLDivElement;
  rightDoor: HTMLDivElement;
  centerBeam: HTMLDivElement;
  visibleAt: number;
  releasePresentation: () => void;
} {
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
    transition: 'transform 900ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 900ms ease',
    background: `
      linear-gradient(180deg, rgba(255,255,255,0.28), rgba(255,255,255,0.06) 10%, rgba(0,0,0,0) 22%),
      linear-gradient(90deg, rgba(255,255,255,0.10), rgba(255,255,255,0) 20%, rgba(255,255,255,0.05) 74%, rgba(0,0,0,0.12)),
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
    transition: 'transform 900ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 900ms ease',
    background: `
      linear-gradient(180deg, rgba(255,255,255,0.28), rgba(255,255,255,0.06) 10%, rgba(0,0,0,0) 22%),
      linear-gradient(270deg, rgba(255,255,255,0.10), rgba(255,255,255,0) 20%, rgba(255,255,255,0.05) 74%, rgba(0,0,0,0.12)),
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
    transition: 'opacity 700ms ease, box-shadow 700ms ease',
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
      linear-gradient(180deg, rgba(164,169,175,0.38), rgba(58,61,66,0.76) 22%, rgba(27,29,33,0.88))
    `,
    border: '1px solid rgba(255,255,255,0.20)',
    boxShadow: `
      0 28px 72px rgba(0,0,0,0.48),
      inset 0 1px 0 rgba(255,255,255,0.26),
      inset 0 -12px 18px rgba(0,0,0,0.16)
    `,
    backdropFilter: 'blur(14px)',
    transition: 'transform 700ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 700ms ease',
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
  title.textContent = 'Authenticate to Enter';
  Object.assign(title.style, {
    margin: '0 0 12px',
    fontSize: '28px',
    fontWeight: '500',
    letterSpacing: '-0.02em',
    color: '#fffefb',
  } as CSSStyleDeclaration);

  const message = document.createElement('p');
  message.textContent = 'Touch ID or your device passcode unlocks the command deck.';
  Object.assign(message.style, {
    margin: '0 0 22px',
    lineHeight: '1.55',
    color: '#e4e1d8',
  } as CSSStyleDeclaration);

  const buttons = document.createElement('div');
  Object.assign(buttons.style, {
    display: 'flex',
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
  stage.appendChild(portalGlow);
  stage.appendChild(starfield);
  stage.appendChild(ambientGrid);
  stage.appendChild(deckReflection);
  stage.appendChild(lightSweep);
  stage.appendChild(lockFrame);
  stage.appendChild(orbitRing);
  stage.appendChild(orbitArc);
  stage.appendChild(frameLabel);
  stage.appendChild(leftDoor);
  stage.appendChild(rightDoor);
  stage.appendChild(centerBeam);
  stage.appendChild(panel);
  container.appendChild(stage);
  document.body.appendChild(container);
  return {
    container,
    stage,
    message,
    button,
    quit,
    panel,
    title,
    statusPill,
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
  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, now);
  master.gain.exponentialRampToValueAtTime(0.32, now + 0.06);
  master.gain.exponentialRampToValueAtTime(0.0001, now + 1.35);
  master.connect(ctx.destination);

  const notes = [
    { freq: 164.81, start: 0.00, duration: 0.22, gain: 0.18 },
    { freq: 246.94, start: 0.12, duration: 0.25, gain: 0.12 },
    { freq: 392.00, start: 0.28, duration: 0.65, gain: 0.08 },
    { freq: 587.33, start: 0.34, duration: 0.52, gain: 0.05 },
  ];

  for (const note of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const start = now + note.start;
    const end = start + note.duration;
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(note.freq, start);
    osc.frequency.exponentialRampToValueAtTime(note.freq * 1.08, end);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(note.gain, start + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(gain);
    gain.connect(master);
    osc.start(start);
    osc.stop(end + 0.03);
  }

  const noiseBuffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.8), ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  }
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer;
  const noiseFilter = ctx.createBiquadFilter();
  noiseFilter.type = 'bandpass';
  noiseFilter.frequency.setValueAtTime(980, now);
  noiseFilter.Q.setValueAtTime(0.5, now);
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0.0001, now);
  noiseGain.gain.exponentialRampToValueAtTime(0.09, now + 0.08);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.8);
  noise.connect(noiseFilter);
  noiseFilter.connect(noiseGain);
  noiseGain.connect(master);
  noise.start(now);
  noise.stop(now + 0.82);

  void sleep(1500).then(() => ctx.close().catch(() => {}));
}

async function playUnlockCelebration(overlay: OverlayElements): Promise<void> {
  const {
    container,
    stage,
    panel,
    title,
    message,
    statusPill,
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
  title.textContent = 'Command Deck Unsealed';
  message.textContent = 'Bulkheads disengaged. Welcome aboard.';
  button.style.opacity = '0';
  quit.style.opacity = '0';
  button.style.pointerEvents = 'none';
  quit.style.pointerEvents = 'none';
  panel.style.transform = 'translate(-50%, -50%) scale(0.94)';
  panel.style.opacity = '0';
  stage.style.boxShadow = `
    0 40px 160px rgba(0,0,0,0.62),
    inset 0 0 90px rgba(255, 244, 220, 0.14)
  `;

  const elapsed = Date.now() - visibleAt;
  if (elapsed < MIN_OVERLAY_VISIBLE_MS) {
    await sleep(MIN_OVERLAY_VISIBLE_MS - elapsed);
  }

  playUnlockSound();

  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      leftDoor.style.transform = 'translateX(-112%) skewY(-2deg)';
      leftDoor.style.opacity = '0.2';
      rightDoor.style.transform = 'translateX(112%) skewY(2deg)';
      rightDoor.style.opacity = '0.2';
      centerBeam.style.opacity = '1';
      centerBeam.style.boxShadow = '0 0 60px rgba(255,248,231,0.68)';
      window.setTimeout(resolve, 980);
    });
  });

  releasePresentation();
  container.remove();
}

export async function ensureBiometricUnlock(): Promise<boolean> {
  const overlay = ensureOverlay();
  const { message, button, quit } = overlay;

  const updateMessage = (text: string) => { message.textContent = text; };
  const setBusy = (busy: boolean) => {
    button.disabled = busy;
    button.textContent = busy ? 'Authenticating…' : 'Authenticate';
  };

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let inFlight: Promise<boolean> | null = null;

    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      overlay.releasePresentation();
      resolve(value);
    };

    const tryAuth = async (manual: boolean): Promise<boolean> => {
      if (settled) return false;
      if (inFlight) return inFlight;

      inFlight = (async () => {
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
          updateMessage(
            err instanceof Error
              ? err.message
              : 'Authentication failed. Click Authenticate to try again.',
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
      updateMessage('Preparing secure airlock...');
      const windowReady = await waitForInteractiveWindow();
      if (!windowReady) {
        updateMessage('Click Authenticate to unlock World Monitor.');
        return;
      }

      await sleep(AUTO_PROMPT_DELAY_MS);
      await tryAuth(false);
    })();
  });
}
