import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import WelcomeApp from './WelcomeApp.tsx';
import { initI18n } from './i18n';
import { initSentry } from './sentry';
import './index.css';

initSentry();

initI18n({ metaPrefix: 'welcome.meta' }).then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <WelcomeApp />
    </StrictMode>,
  );
});
