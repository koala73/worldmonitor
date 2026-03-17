import { hasTauriInvokeBridge, invokeTauri } from '../services/tauri-bridge';

const INVOKE_CMD_AUTHENTICATE = 'plugin:biometry|authenticate';
const BRIDGE_READY_TIMEOUT_MS = 2500;
const BRIDGE_READY_POLL_MS = 50;
const BRIDGE_BOOTSTRAP_POLL_MS = 150;
const WINDOW_READY_TIMEOUT_MS = 1200;
const WINDOW_READY_POLL_MS = 100;
const AUTO_PROMPT_DELAY_MS = 80;
const AUTH_REASON = 'Unlock World Monitor';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type FallbackOverlay = {
  container: HTMLDivElement;
  message: HTMLParagraphElement;
  retry: HTMLButtonElement;
  quit: HTMLButtonElement;
  release: () => void;
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
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
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

    const finish = () => {
      if (!isInteractiveWindow()) return;
      cleanup();
      requestAnimationFrame(() => resolve(true));
    };

    const timeoutId = window.setTimeout(() => {
      cleanup();
      resolve(false);
    }, WINDOW_READY_TIMEOUT_MS);

    window.addEventListener('focus', finish);
    document.addEventListener('visibilitychange', finish);
    pollId = window.setInterval(() => {
      if (settled || !isInteractiveWindow()) return;
      finish();
    }, WINDOW_READY_POLL_MS);
    finish();
  });
}

function showFallbackOverlay(initialMessage: string): FallbackOverlay {
  const existing = document.getElementById('biometry-fallback');
  if (existing) existing.remove();

  const appRoot = document.getElementById('app');
  const previousFilter = appRoot?.style.filter ?? '';
  const previousOpacity = appRoot?.style.opacity ?? '';
  const previousPointerEvents = appRoot?.style.pointerEvents ?? '';

  if (appRoot) {
    appRoot.style.filter = 'blur(6px)';
    appRoot.style.opacity = '0.28';
    appRoot.style.pointerEvents = 'none';
  }

  const release = () => {
    const current = document.getElementById('biometry-fallback');
    current?.remove();
    if (!appRoot) return;
    appRoot.style.filter = previousFilter;
    appRoot.style.opacity = previousOpacity;
    appRoot.style.pointerEvents = previousPointerEvents;
  };

  const container = document.createElement('div');
  container.id = 'biometry-fallback';
  Object.assign(container.style, {
    position: 'fixed',
    inset: '0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(7, 9, 12, 0.58)',
    backdropFilter: 'blur(10px)',
    zIndex: '9999',
    fontFamily: '"SF Pro Display", -apple-system, BlinkMacSystemFont, sans-serif',
  } as CSSStyleDeclaration);

  const panel = document.createElement('div');
  Object.assign(panel.style, {
    width: 'min(420px, calc(100vw - 32px))',
    padding: '28px 24px',
    borderRadius: '20px',
    background: 'rgba(20, 24, 29, 0.92)',
    border: '1px solid rgba(255,255,255,0.08)',
    boxShadow: '0 18px 54px rgba(0,0,0,0.34)',
    color: '#f5f7fa',
  } as CSSStyleDeclaration);

  const eyebrow = document.createElement('div');
  eyebrow.textContent = 'WORLD MONITOR';
  Object.assign(eyebrow.style, {
    marginBottom: '10px',
    color: 'rgba(232, 238, 246, 0.62)',
    fontSize: '11px',
    fontWeight: '700',
    letterSpacing: '0.16em',
  } as CSSStyleDeclaration);

  const title = document.createElement('h2');
  title.textContent = 'Authentication Required';
  Object.assign(title.style, {
    margin: '0 0 10px',
    fontSize: '28px',
    lineHeight: '1.1',
    fontWeight: '600',
    letterSpacing: '-0.03em',
  } as CSSStyleDeclaration);

  const message = document.createElement('p');
  message.textContent = initialMessage;
  Object.assign(message.style, {
    margin: '0',
    color: 'rgba(231, 236, 242, 0.88)',
    lineHeight: '1.5',
    fontSize: '15px',
  } as CSSStyleDeclaration);

  const actions = document.createElement('div');
  Object.assign(actions.style, {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '12px',
    marginTop: '20px',
  } as CSSStyleDeclaration);

  const quit = document.createElement('button');
  quit.textContent = 'Quit';
  Object.assign(quit.style, {
    padding: '10px 16px',
    borderRadius: '999px',
    border: '1px solid rgba(255,255,255,0.12)',
    background: 'rgba(255,255,255,0.04)',
    color: '#f4f6f8',
    cursor: 'pointer',
    fontSize: '15px',
  } as CSSStyleDeclaration);

  const retry = document.createElement('button');
  retry.textContent = 'Try Again';
  Object.assign(retry.style, {
    padding: '10px 18px',
    borderRadius: '999px',
    border: '1px solid rgba(255,255,255,0.20)',
    background: '#f3f5f7',
    color: '#14181d',
    cursor: 'pointer',
    fontSize: '15px',
    fontWeight: '600',
  } as CSSStyleDeclaration);

  actions.appendChild(quit);
  actions.appendChild(retry);
  panel.appendChild(eyebrow);
  panel.appendChild(title);
  panel.appendChild(message);
  panel.appendChild(actions);
  container.appendChild(panel);
  document.body.append(container);

  return { container, message, retry, quit, release };
}

export async function ensureBiometricUnlock(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let inFlight: Promise<boolean> | null = null;
    let autoResumeArmed = false;
    let bridgePollId = 0;
    let fallbackOverlay: FallbackOverlay | null = null;

    const cleanupFallback = () => {
      fallbackOverlay?.release();
      fallbackOverlay = null;
    };

    const disarmAutoResume = () => {
      if (bridgePollId) {
        window.clearInterval(bridgePollId);
        bridgePollId = 0;
      }
      if (!autoResumeArmed) return;
      autoResumeArmed = false;
      window.removeEventListener('focus', resumeAutoAuth);
      document.removeEventListener('visibilitychange', resumeAutoAuth);
    };

    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      disarmAutoResume();
      cleanupFallback();
      resolve(value);
    };

    const ensureFallbackControls = (text: string) => {
      if (!fallbackOverlay) {
        fallbackOverlay = showFallbackOverlay(text);
        fallbackOverlay.quit.onclick = () => {
          settle(false);
          window.close();
        };
        fallbackOverlay.retry.onclick = () => {
          fallbackOverlay?.retry.blur();
          void tryAuth(true);
        };
      }
      fallbackOverlay.message.textContent = text;
      return fallbackOverlay;
    };

    const showRetryState = (text: string) => {
      const overlay = ensureFallbackControls(text);
      overlay.retry.disabled = false;
      overlay.retry.textContent = 'Try Again';
    };

    const showAutoResumeState = (text: string) => {
      const overlay = ensureFallbackControls(text);
      overlay.retry.disabled = true;
      overlay.retry.textContent = 'Authenticating…';
    };

    const resumeAutoAuth = () => {
      if (settled || inFlight || !isInteractiveWindow()) return;
      if (!hasTauriInvokeBridge()) {
        showAutoResumeState('Preparing secure unlock. Authentication will start automatically.');
        return;
      }
      disarmAutoResume();
      if (fallbackOverlay) {
        fallbackOverlay.message.textContent = 'Preparing Touch ID...';
        fallbackOverlay.retry.disabled = true;
        fallbackOverlay.retry.textContent = 'Authenticating…';
      }
      void sleep(AUTO_PROMPT_DELAY_MS).then(() => {
        if (settled || inFlight || !isInteractiveWindow()) return;
        void tryAuth(false);
      });
    };

    const armAutoResume = (waitForBridge = false) => {
      if (!autoResumeArmed) {
        autoResumeArmed = true;
        window.addEventListener('focus', resumeAutoAuth);
        document.addEventListener('visibilitychange', resumeAutoAuth);
      }
      if (waitForBridge && !bridgePollId) {
        bridgePollId = window.setInterval(() => {
          if (settled || inFlight || !hasTauriInvokeBridge() || !isInteractiveWindow()) return;
          resumeAutoAuth();
        }, BRIDGE_BOOTSTRAP_POLL_MS);
      }
    };

    const tryAuth = async (manual: boolean): Promise<boolean> => {
      if (settled) return false;
      if (inFlight) return inFlight;

      inFlight = (async () => {
        disarmAutoResume();
        if (manual && fallbackOverlay) {
          fallbackOverlay.message.textContent = 'Waiting for Touch ID...';
          fallbackOverlay.retry.disabled = true;
          fallbackOverlay.retry.textContent = 'Authenticating…';
        }

        try {
          await invokePlugin<void>(INVOKE_CMD_AUTHENTICATE, {
            reason: AUTH_REASON,
            options: {
              allowDeviceCredential: true,
            },
          });
          settle(true);
          return true;
        } catch (err) {
          const text = err instanceof Error && err.message
            ? err.message
            : 'Touch ID did not complete. Try Again or quit.';
          if (text.includes('Tauri invoke bridge not ready')) {
            showAutoResumeState('Preparing secure unlock. Authentication will start automatically.');
            armAutoResume(true);
            return false;
          }
          showRetryState(text.includes('Touch ID did not complete.') ? text : `Touch ID did not complete. ${text}`);
          armAutoResume();
          return false;
        } finally {
          inFlight = null;
        }
      })();

      return inFlight;
    };

    void (async () => {
      const windowReady = await waitForInteractiveWindow();
      if (!windowReady) {
        showAutoResumeState('Bring World Monitor to the front. Authentication will start automatically.');
        armAutoResume(true);
        return;
      }
      await sleep(AUTO_PROMPT_DELAY_MS);
      await tryAuth(false);
    })();
  });
}
