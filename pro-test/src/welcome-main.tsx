import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import WelcomeApp from './WelcomeApp.tsx';
import { currentLanguageBase, initI18n } from './i18n';
import { initSentry } from './sentry';
import './index.css';

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
    hydrateRoot(rootElement, app);
    return;
  }
  rootElement.replaceChildren();
  createRoot(rootElement).render(app);
});
