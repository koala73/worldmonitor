import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import * as Sentry from '@sentry/react';
import App, { renderTurnstileWidgets } from './App.tsx';
import { ProDomErrorBoundary } from './ProDomErrorBoundary.tsx';
import { ensureTurnstileScript } from './turnstile';
import { currentLanguageBase, initI18n } from './i18n';
import { initSentry } from './sentry';
import { initDebugBearRum } from './debugbear-rum';
import {
  collectRemoveChildEvidence,
  installDetachedNodeGuards,
  protectReactRootFromTranslators,
} from './services/clerk-dom-safety';
import { trackContentHandoff } from './services/checkout';
import { captureContentAttributionFromUrl } from '../../shared/content-attribution';
import './index.css';

const capturedContentAttribution = captureContentAttributionFromUrl();
if (capturedContentAttribution) trackContentHandoff();

initSentry();
initDebugBearRum();

const rootElement = document.getElementById('root')!;
const servedLanguage = document.documentElement.getAttribute('lang') ?? 'en';
protectReactRootFromTranslators(rootElement);
let recoveredDetachedNode = false;
installDetachedNodeGuards(undefined, (operation) => {
  if (recoveredDetachedNode) return;
  recoveredDetachedNode = true;
  Sentry.captureMessage('pro.removeChild.recovered', {
    level: 'info',
    tags: { surface: 'pro-marketing', recoveredOperation: operation },
    extra: {
      removeChildDomEvidence: collectRemoveChildEvidence({
        document,
        location,
        servedLanguage,
        applicationLanguage: currentLanguageBase(),
        browserLanguage: navigator.language,
        browserLanguages: [...navigator.languages],
      }),
    },
  });
});

initI18n().then(() => {
  createRoot(rootElement).render(
    <StrictMode>
      <ProDomErrorBoundary>
        <App />
      </ProDomErrorBoundary>
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
