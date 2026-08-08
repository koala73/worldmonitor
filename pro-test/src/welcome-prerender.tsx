import { StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import WelcomeApp from './WelcomeApp';
import { initStaticI18n } from './i18n';

export async function renderWelcomeApp(): Promise<string> {
  await initStaticI18n();
  return renderToString(
    <StrictMode>
      <WelcomeApp />
    </StrictMode>,
  );
}
