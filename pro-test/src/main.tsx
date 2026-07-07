import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App, { renderTurnstileWidgets } from './App.tsx';
import { initI18n } from './i18n';
import { initSentry } from './sentry';
import './index.css';

initSentry();

const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

initI18n().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

  // Turnstile is only consumed by the enterprise contact form near the bottom
  // of the page, so the challenge script is injected on demand — when the form
  // approaches the viewport or a hash jump lands on it — instead of shipping
  // ~100KB of challenge JS to every visitor. Injected scripts inherit trust
  // from this bundle under the CSP's 'strict-dynamic'; the nonce covers
  // browsers that predate strict-dynamic support.
  const renderWhenReady = () => {
    if (window.turnstile && renderTurnstileWidgets() > 0) return;
    let attempts = 0;
    const retryInterval = window.setInterval(() => {
      if ((window.turnstile && renderTurnstileWidgets() > 0) || ++attempts >= 20) {
        window.clearInterval(retryInterval);
      }
    }, 250);
  };

  let turnstileInjected = false;
  const ensureTurnstile = () => {
    if (window.turnstile) {
      renderWhenReady();
      return;
    }
    if (turnstileInjected) return;
    turnstileInjected = true;
    const script = document.createElement('script');
    script.src = TURNSTILE_SRC;
    script.async = true;
    script.nonce = 'wm-static-bootstrap';
    script.addEventListener('load', renderWhenReady, { once: true });
    document.head.appendChild(script);
  };

  // createRoot().render() doesn't commit synchronously — poll briefly for the
  // widget container before wiring the viewport trigger.
  let findAttempts = 0;
  const armViewportTrigger = () => {
    const widget = document.querySelector('.cf-turnstile');
    if (!widget) {
      if (++findAttempts <= 20) window.setTimeout(armViewportTrigger, 250);
      return;
    }
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
  armViewportTrigger();

  window.addEventListener('hashchange', ensureTurnstile);
});
