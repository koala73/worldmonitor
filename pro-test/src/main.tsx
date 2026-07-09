import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App, { renderTurnstileWidgets } from './App.tsx';
import { ensureTurnstileScript } from './turnstile';
import { initI18n } from './i18n';
import { initSentry } from './sentry';
import { initDebugBearRum } from './debugbear-rum';
import './index.css';

initSentry();
initDebugBearRum();

initI18n().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

  // Turnstile is only consumed by the enterprise contact form, so the
  // challenge script is injected on demand — when the form approaches the
  // viewport — instead of shipping ~100KB of challenge JS to every visitor.
  const renderWhenReady = () => {
    if (window.turnstile && renderTurnstileWidgets() > 0) return;
    let attempts = 0;
    const retryInterval = window.setInterval(() => {
      if ((window.turnstile && renderTurnstileWidgets() > 0) || ++attempts >= 20) {
        window.clearInterval(retryInterval);
      }
    }, 250);
  };

  const ensureTurnstile = () => {
    void ensureTurnstileScript().then((loaded) => {
      if (loaded) renderWhenReady();
    });
  };

  // The form lives on the enterprise page, which mounts only while the hash
  // starts with #enterprise — on the home page the container doesn't exist,
  // so the trigger is (re-)armed on every enterprise hash entry. The poll
  // covers createRoot().render() not committing synchronously.
  const isEnterpriseHash = () => window.location.hash.startsWith('#enterprise');
  const armViewportTrigger = (findAttempts = 0) => {
    const widget = document.querySelector<HTMLElement>('.cf-turnstile');
    if (!widget) {
      if (findAttempts < 20) window.setTimeout(() => armViewportTrigger(findAttempts + 1), 250);
      return;
    }
    if (widget.dataset.wmObserved) return;
    widget.dataset.wmObserved = 'true';
    if (!('IntersectionObserver' in window)) {
      ensureTurnstile();
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        ensureTurnstile();
      }
    }, { rootMargin: '600px 0px' });
    observer.observe(widget);
  };

  if (isEnterpriseHash()) armViewportTrigger();
  window.addEventListener('hashchange', () => {
    // Ordinary anchors (#pricing, logo resets to '') must not pull in the
    // challenge script — only enterprise entries, where the form mounts.
    if (isEnterpriseHash()) armViewportTrigger();
  });
});
