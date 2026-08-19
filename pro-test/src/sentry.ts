import * as Sentry from '@sentry/react';

import { SENTRY_ALLOW_URLS } from './sentry-allow-urls';
import { MARKETING_IGNORE_ERRORS, marketingBeforeSend } from './sentry-filter-policy';

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

  Sentry.init({
    dsn: sentryDsn || undefined,
    environment: (location.hostname === 'worldmonitor.app' || location.hostname.endsWith('.worldmonitor.app')) ? 'production'
      : location.hostname.includes('vercel.app') ? 'preview'
      : 'development',
    enabled: Boolean(sentryDsn) && !location.hostname.startsWith('localhost'),
    allowUrls: SENTRY_ALLOW_URLS,
    tracesSampleRate: 0.1,
    ignoreErrors: MARKETING_IGNORE_ERRORS,
    beforeSend: (event) => marketingBeforeSend(event),
  });
}
