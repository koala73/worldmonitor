import * as Sentry from '@sentry/react';
import { getSentryBuildMetadata, isolateNonProductionSentryEvent } from '../../shared/sentry-build-metadata';
import { scrubSentryCredentials } from '../../shared/sensitive-url-params';

import { SENTRY_ALLOW_URLS } from './sentry-allow-urls';
import {
  MARKETING_IGNORE_ERRORS,
  marketingBeforeSend,
  sanitizeMarketingRequestUrl,
} from './sentry-filter-policy';
import { currentLanguageBase } from './i18n';
import { collectRemoveChildEvidence, decorateRemoveChildEvent } from './services/clerk-dom-safety';

/**
 * Shared Sentry bootstrap for both marketing entries (/pro and root welcome).
 * Must be imported before the React render in every entry's main file.
 *
 * The filtering policy lives in `./sentry-filter-policy.ts` (dependency-free so
 * the guard can import the real values); read that file for why it is a small
 * vetted set rather than a copy of the dashboard's array.
 */
export function initSentry(): void {
  const sentryDsn = import.meta.env.VITE_SENTRY_DSN?.trim();
  const servedLanguage = document.documentElement.getAttribute('lang') ?? 'en';
  const environment = (location.hostname === 'worldmonitor.app' || location.hostname.endsWith('.worldmonitor.app')) ? 'production'
    : location.hostname.includes('vercel.app') ? 'preview'
    : 'development';

  Sentry.init({
    dsn: sentryDsn || undefined,
    ...getSentryBuildMetadata(__APP_VERSION__, __BUILD_HASH__, environment),
    environment,
    enabled: Boolean(sentryDsn) && !location.hostname.startsWith('localhost'),
    allowUrls: SENTRY_ALLOW_URLS,
    tracesSampleRate: 0.1,
    ignoreErrors: MARKETING_IGNORE_ERRORS,
    beforeBreadcrumb: scrubSentryCredentials,
    beforeSendTransaction: scrubSentryCredentials,
    beforeSendSpan: scrubSentryCredentials,
    beforeSend: (event) => {
      const filteredEvent = marketingBeforeSend(event);
      if (!filteredEvent) return null;
      isolateNonProductionSentryEvent(filteredEvent, environment);
      if (filteredEvent.request?.url) {
        const safeRequestUrl = sanitizeMarketingRequestUrl(filteredEvent.request.url);
        filteredEvent.request.url = safeRequestUrl;
      }
      return scrubSentryCredentials(decorateRemoveChildEvent(filteredEvent, collectRemoveChildEvidence({
        document,
        location,
        servedLanguage,
        applicationLanguage: currentLanguageBase(),
        browserLanguage: navigator.language,
        browserLanguages: [...navigator.languages],
      })));
    },
  });
}
