import * as Sentry from '@sentry/react';

import { SENTRY_ALLOW_URLS } from './sentry-allow-urls';

/**
 * Shared Sentry bootstrap for both marketing entries (/pro and root welcome).
 * Must be imported before the React render in every entry's main file.
 */
export function initSentry(): void {
  const sentryDsn = import.meta.env.VITE_SENTRY_DSN?.trim();

  Sentry.init({
    dsn: sentryDsn || undefined,
    environment: (location.hostname === 'worldmonitor.app' || location.hostname.endsWith('.worldmonitor.app')) ? 'production'
      : location.hostname.includes('vercel.app') ? 'preview'
      : 'development',
    enabled: Boolean(sentryDsn) && !location.hostname.startsWith('localhost'),
    allowUrls: SENTRY_ALLOW_URLS,
    tracesSampleRate: 0.1,
    ignoreErrors: [
      /ResizeObserver loop/,
      /^TypeError: Load failed/,
      /^TypeError: Failed to fetch/,
      /^TypeError: NetworkError/,
      /Non-Error promise rejection captured with value:/,
    ],
  });
}
