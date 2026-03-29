import { hasTauriInvokeBridge, invokeTauri } from '../services/tauri-bridge';

const INVOKE_CMD_AUTHENTICATE = 'plugin:biometry|authenticate';
const AUTH_REASON = 'Unlock World Monitor';
const WINDOW_READY_TIMEOUT_MS = 1200;
const WINDOW_READY_POLL_MS = 80;
const AUTO_PROMPT_DELAY_MS = 80;
const BRIDGE_RETRY_INTERVAL_MS = 500;

interface GateOverlay {
  container: HTMLDivElement;
  message: HTMLParagraphElement;
  primaryButton: HTMLButtonElement;
  quitButton: HTMLButtonElement;
  stage: HTMLDivElement;
}

interface BiometricGate3DController {
  setAuthenticating: (active: boolean) => void;
  setAccessGranted: () => void;
  setDoorOpenProgress: (progress: number) => void;
  destroy: () => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function createOverlay(): GateOverlay {
  const existing = document.getElementById('wm-biometry-gate');
  if (existing) {
    existing.remove();
  }

  const container = document.createElement('div');
  container.id = 'wm-biometry-gate';
  Object.assign(container.style, {
    position: 'fixed',
    inset: '0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(8, 10, 14, 0.78)',
    backdropFilter: 'blur(8px)',
    zIndex: '10000',
    color: '#f6f7f8',
    fontFamily: '"SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  } as CSSStyleDeclaration);

  const panel = document.createElement('div');
  Object.assign(panel.style, {
    width: 'min(460px, calc(100vw - 32px))',
    borderRadius: '16px',
    border: '1px solid rgba(255, 255, 255, 0.22)',
    background: 'linear-gradient(180deg, rgba(34,38,46,0.95), rgba(22,25,31,0.98))',
    boxShadow: '0 22px 52px rgba(0, 0, 0, 0.45)',
    padding: '22px',
    display: 'grid',
    gap: '14px',
  } as CSSStyleDeclaration);

  const title = document.createElement('h2');
  title.textContent = 'Secure Unlock';
  Object.assign(title.style, {
    margin: '0',
    fontSize: '1.05rem',
    fontWeight: '650',
    letterSpacing: '0.01em',
  } as CSSStyleDeclaration);

  const message = document.createElement('p');
  message.textContent = 'Preparing secure unlock...';
  Object.assign(message.style, {
    margin: '0',
    lineHeight: '1.45',
    color: 'rgba(236, 241, 247, 0.92)',
  } as CSSStyleDeclaration);

  const actions = document.createElement('div');
  Object.assign(actions.style, {
    display: 'flex',
    gap: '10px',
    justifyContent: 'flex-end',
    marginTop: '4px',
  } as CSSStyleDeclaration);

  const stage = document.createElement('div');
  Object.assign(stage.style, {
    position: 'relative',
    minHeight: '140px',
    borderRadius: '12px',
    overflow: 'hidden',
    background: 'radial-gradient(circle at 50% 30%, rgba(125, 160, 218, 0.32), rgba(15, 19, 26, 0.85))',
    border: '1px solid rgba(255, 255, 255, 0.14)',
  } as CSSStyleDeclaration);

  const quitButton = document.createElement('button');
  quitButton.type = 'button';
  quitButton.textContent = 'Quit';
  Object.assign(quitButton.style, {
    borderRadius: '10px',
    border: '1px solid rgba(255, 255, 255, 0.25)',
    background: 'transparent',
    color: '#f6f7f8',
    padding: '9px 14px',
    cursor: 'pointer',
  } as CSSStyleDeclaration);

  const primaryButton = document.createElement('button');
  primaryButton.type = 'button';
  primaryButton.textContent = 'Authenticate';
  Object.assign(primaryButton.style, {
    borderRadius: '10px',
    border: '1px solid rgba(255, 255, 255, 0.32)',
    background: 'linear-gradient(180deg, rgba(255,255,255,0.18), rgba(255,255,255,0.08))',
    color: '#f6f7f8',
    padding: '9px 16px',
    cursor: 'pointer',
    fontWeight: '600',
  } as CSSStyleDeclaration);

  actions.append(quitButton, primaryButton);
  panel.append(title, stage, message, actions);
  container.append(panel);
  document.body.append(container);

  return { container, message, primaryButton, quitButton, stage };
}

function setBusy(
  overlay: GateOverlay,
  busy: boolean,
  gate3D: BiometricGate3DController | null,
): void {
  overlay.primaryButton.disabled = busy;
  overlay.primaryButton.textContent = busy ? 'Authenticating…' : 'Try Again';
  gate3D?.setAuthenticating(busy);
}

function showFallbackOverlay(overlay: GateOverlay, message: string): void {
  overlay.message.textContent = message;
  overlay.primaryButton.textContent = 'Try Again';
  overlay.primaryButton.disabled = false;
}

function cleanupOverlay(overlay: GateOverlay): void {
  overlay.container.remove();
}

export async function ensureBiometricUnlock(): Promise<boolean> {
  const overlay = createOverlay();

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let inFlight = false;
    let bridgeRetryTimer: number | null = null;
    let gate3D: BiometricGate3DController | null = null;

    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      if (bridgeRetryTimer !== null) {
        window.clearInterval(bridgeRetryTimer);
        bridgeRetryTimer = null;
      }
      window.removeEventListener('focus', resumeAuthIfReady);
      document.removeEventListener('visibilitychange', resumeAuthIfReady);
      gate3D?.destroy();
      gate3D = null;
      cleanupOverlay(overlay);
      resolve(value);
    };

    const showAutoResumeMessage = () => {
      showFallbackOverlay(
        overlay,
        'Touch ID did not complete. Authentication will start automatically.',
      );
    };

    const startBridgeRetry = () => {
      if (bridgeRetryTimer !== null) return;
      bridgeRetryTimer = window.setInterval(() => {
        if (settled || inFlight) return;
        if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
        if (!hasTauriInvokeBridge()) return;
        void tryAuthenticate(false);
      }, BRIDGE_RETRY_INTERVAL_MS);
    };

    const tryAuthenticate = async (manual: boolean): Promise<boolean> => {
      if (settled || inFlight) return false;
      inFlight = true;
      setBusy(overlay, true, gate3D);
      if (manual) {
        overlay.message.textContent = 'Authenticating with your device security...';
      }

      try {
        await invokeTauri<void>(INVOKE_CMD_AUTHENTICATE, {
          reason: AUTH_REASON,
          options: {
            allowDeviceCredential: true,
          },
        });
        gate3D?.setAccessGranted();
        gate3D?.setDoorOpenProgress(1);
        settle(true);
        return true;
      } catch {
        gate3D?.setDoorOpenProgress(0);
        if (hasTauriInvokeBridge()) {
          showAutoResumeMessage();
        } else {
          showFallbackOverlay(
            overlay,
            'Preparing secure unlock. Authentication will start automatically.',
          );
          startBridgeRetry();
        }
        return false;
      } finally {
        setBusy(overlay, false, gate3D);
        inFlight = false;
      }
    };

    const resumeAuthIfReady = () => {
      if (settled || inFlight) return;
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
      void tryAuthenticate(false);
    };

    overlay.quitButton.addEventListener('click', () => {
      settle(false);
      window.close();
    });

    overlay.primaryButton.addEventListener('click', () => {
      void tryAuthenticate(true);
    });

    window.addEventListener('focus', resumeAuthIfReady);
    document.addEventListener('visibilitychange', resumeAuthIfReady);
    startBridgeRetry();

    void (async () => {
      try {
        const gate3DModule = await import('./biometric-gate-3d');
        const capability = gate3DModule.detectBiometricGate3DCapability();
        if (gate3DModule.shouldEnableBiometricGate3D(capability)) {
          gate3D = await gate3DModule.mountBiometricGate3D(overlay.stage);
          gate3D.setDoorOpenProgress(0);
        }
      } catch {
        gate3D = null;
      }

      overlay.message.textContent = 'Preparing secure unlock...';
      const windowReady = await waitForInteractiveWindow();
      if (!windowReady) {
        showFallbackOverlay(
          overlay,
          'Preparing secure unlock. Authentication will start automatically.',
        );
        return;
      }

      await sleep(AUTO_PROMPT_DELAY_MS);
      await tryAuthenticate(false);
    })();
  });
}
