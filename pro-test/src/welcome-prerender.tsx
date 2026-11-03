import { StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import {
  INDEXABLE_LANDING_LOCALES,
  landingById,
  nonDefaultLandingLocales,
  type IndexableLandingLocale,
} from '../../shared/indexable-landing-locales';
import WelcomeApp from './WelcomeApp';
import { localizeWelcomeDocument, type WelcomeLandingCopy } from './welcome-document';
import { initStaticI18n, t } from './i18n';
import depthProofStats from './generated/depth-stats.json';

const WELCOME_FAQ_COUNT = 12;

export { INDEXABLE_LANDING_LOCALES, landingById, localizeWelcomeDocument, nonDefaultLandingLocales };
export type { IndexableLandingLocale, WelcomeLandingCopy };

function welcomeCopy(): WelcomeLandingCopy {
  return {
    title: t('welcome.meta.title'),
    description: t('welcome.meta.description'),
    ogTitle: t('welcome.meta.ogTitle'),
    ogDescription: t('welcome.meta.ogDescription'),
    faqs: Array.from({ length: WELCOME_FAQ_COUNT }, (_, index) => {
      const n = index + 1;
      return {
        q: t(`welcome.faq.q${n}`),
        a: t(`welcome.faq.a${n}`, depthProofStats),
      };
    }),
  };
}

export async function renderWelcomeApp(localeId = 'en'): Promise<{
  html: string;
  copy: WelcomeLandingCopy;
}> {
  await initStaticI18n(localeId);
  return {
    html: renderToString(
      <StrictMode>
        <WelcomeApp />
      </StrictMode>,
    ),
    copy: welcomeCopy(),
  };
}
