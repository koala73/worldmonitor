import './styles/base-layer.css';
import * as Sentry from '@sentry/browser';
import { inject } from '@vercel/analytics';
import { App } from './App';

const sentryDsn = import.meta.env.VITE_SENTRY_DSN?.trim();

// Initialize Sentry error tracking
Sentry.init({
  dsn: sentryDsn || undefined,
  release: `salesintel@${__APP_VERSION__}`,
  environment: location.hostname === 'salesintel.app' ? 'production'
    : location.hostname.includes('vercel.app') ? 'preview'
    : 'development',
  enabled: Boolean(sentryDsn) && !location.hostname.startsWith('localhost'),
  sendDefaultPii: true,
  tracesSampleRate: 0.1,
  ignoreErrors: [
    /ResizeObserver loop/,
    /NotAllowedError/,
    /^TypeError: Load failed/,
    /^TypeError: Failed to fetch/,
    /^TypeError: NetworkError/,
    /Non-Error promise rejection/,
    /QuotaExceededError/,
    /AbortError/,
    /signal is aborted/,
    /Failed to fetch dynamically imported module/,
  ],
});

// Suppress unhandled promise rejections from browser autoplay policy
window.addEventListener('unhandledrejection', (e) => {
  if (e.reason?.name === 'NotAllowedError') e.preventDefault();
});

import { installRuntimeFetchPatch, installWebApiRedirect } from '@/services/runtime';

// ————— Bootstrap —————

async function boot(): Promise<void> {
  // Install fetch patches for Vercel Edge Functions
  installRuntimeFetchPatch();
  installWebApiRedirect();

  // Inject Vercel Analytics (non-blocking)
  try { inject({ mode: 'auto' }); } catch { /* optional */ }

  // Mount the SalesIntel app
  const app = new App('app');

  // Expose for debugging
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).salesintel = app;
  }

  await app.init();
}

// Handle settings window (if applicable)
const params = new URLSearchParams(window.location.search);
if (params.get('settings') === '1') {
  import('./settings-window').then(m => m.initSettingsWindow());
} else {
  boot().catch(err => {
    console.error('[SalesIntel] Boot failed:', err);
    Sentry.captureException(err);
  });
}

// Declare build-time constants
declare const __APP_VERSION__: string;
