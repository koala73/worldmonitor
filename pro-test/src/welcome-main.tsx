import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import WelcomeApp from './WelcomeApp.tsx';
import { currentLanguageBase, initI18n } from './i18n';
import { initSentry } from './sentry';
import './index.css';

const WELCOME_HYDRATION_IDLE_TIMEOUT_MS = 2500;

function scheduleWelcomeHydration(hydrate: () => void) {
  const idleWindow = window as Window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  };

  if (typeof idleWindow.requestIdleCallback === 'function') {
    idleWindow.requestIdleCallback(hydrate, { timeout: WELCOME_HYDRATION_IDLE_TIMEOUT_MS });
    return;
  }

  window.setTimeout(hydrate, 1200);
}

initSentry();

initI18n({ metaPrefix: 'welcome.meta' }).then(() => {
  const rootElement = document.getElementById('root')!;
  const app = (
    <StrictMode>
      <WelcomeApp />
    </StrictMode>
  );
  if (
    rootElement.dataset.wmPrerendered === 'welcome' &&
    rootElement.dataset.wmPrerenderLang === currentLanguageBase()
  ) {
    scheduleWelcomeHydration(() => hydrateRoot(rootElement, app));
    return;
  }
  rootElement.replaceChildren();
  createRoot(rootElement).render(app);
});
