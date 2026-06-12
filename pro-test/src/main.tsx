import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App, { renderTurnstileWidgets } from './App.tsx';
import { initI18n } from './i18n';
import { initSentry } from './sentry';
import './index.css';

initSentry();

const TURNSTILE_SCRIPT_SELECTOR = 'script[src^="https://challenges.cloudflare.com/turnstile/v0/api.js"]';

initI18n().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

  // Render widgets once React has mounted and the async Turnstile script is ready.
  // Used by the enterprise contact form (/pro/#enterprise) — the only remaining
  // form on this page after the waitlist cutover.
  const initWidgets = () => {
    if (!window.turnstile) return false;
    return renderTurnstileWidgets() > 0;
  };

  const turnstileScript = document.querySelector<HTMLScriptElement>(TURNSTILE_SCRIPT_SELECTOR);
  turnstileScript?.addEventListener('load', () => {
    initWidgets();
  }, { once: true });

  if (!initWidgets()) {
    let attempts = 0;
    const retryInterval = window.setInterval(() => {
      if (initWidgets() || ++attempts >= 20) window.clearInterval(retryInterval);
    }, 500);
  }

  window.addEventListener('hashchange', () => {
    let tries = 0;
    const poll = () => {
      if (initWidgets() || ++tries >= 10) return;
      setTimeout(poll, 200);
    };
    setTimeout(poll, 100);
  });
});
