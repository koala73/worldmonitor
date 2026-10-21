import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import WelcomeApp from './WelcomeApp.tsx';
import { effectiveWelcomeContentLanguage, initI18n } from './i18n';
import { initSentry } from './sentry';
import { initDebugBearRum } from './debugbear-rum';
import { clearWelcomeRoot, prepareWelcomeRoot } from './welcome-root';
import './index.css';

const WELCOME_HYDRATION_IDLE_TIMEOUT_MS = 2500;
const WELCOME_HYDRATION_FALLBACK_TARGET_MS = 1200;

function scheduleWelcomeHydration(hydrate: () => void) {
  const idleWindow = window as Window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  };

  if (typeof idleWindow.requestIdleCallback === 'function') {
    idleWindow.requestIdleCallback(hydrate, { timeout: WELCOME_HYDRATION_IDLE_TIMEOUT_MS });
    return;
  }

  const elapsedMs = typeof performance !== 'undefined' ? performance.now() : 0;
  const fallbackDelayMs = Math.max(0, WELCOME_HYDRATION_FALLBACK_TARGET_MS - elapsedMs);
  window.setTimeout(hydrate, fallbackDelayMs);
}

initSentry();
initDebugBearRum();

initI18n({ metaPrefix: 'welcome.meta' }).then(() => {
  const mount = prepareWelcomeRoot(
    document.getElementById('root'),
    effectiveWelcomeContentLanguage(),
  );
  if (!mount) {
    return;
  }
  const app = (
    <StrictMode>
      <WelcomeApp />
    </StrictMode>
  );
  if (mount.mode === 'hydrate') {
    scheduleWelcomeHydration(() => hydrateRoot(mount.root, app));
    return;
  }
  clearWelcomeRoot(mount.root);
  createRoot(mount.root).render(app);
});
