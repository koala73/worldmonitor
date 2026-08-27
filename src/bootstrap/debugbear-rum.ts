export const DEBUGBEAR_RUM_SCRIPT_SRC = 'https://cdn.debugbear.com/lpMwA9KpC6pf.js';
// 10% sampling. 100% overran the DebugBear RUM monthly quota (~529k/500k, 2026-07).
// Bootstrap transfer evidence and ongoing web-vitals RUM need only a fraction.
// Keep in sync with pro-test/src/debugbear-rum.ts (asserted by the test).
export const DEBUGBEAR_RUM_SAMPLE_RATE = 10;
const DEBUGBEAR_RUM_SCRIPT_PATHNAME = new URL(DEBUGBEAR_RUM_SCRIPT_SRC).pathname;
/** Every production host the RUM script loads on. Exported so
 * `tests/sentry-allow-urls.test.mts` can assert the Sentry ingest allowlist
 * covers the same population instead of restating it (#6545). */
export const DEBUGBEAR_RUM_HOSTS = new Set([
  'worldmonitor.app',
  'www.worldmonitor.app',
  'tech.worldmonitor.app',
  'finance.worldmonitor.app',
  'commodity.worldmonitor.app',
  'happy.worldmonitor.app',
  'energy.worldmonitor.app',
]);

import type { BootstrapTransferRumSample } from './bootstrap-transfer-rum';

type DebugBearRumEvent =
  | ['presampling', number]
  | ['error' | 'unhandledrejection', Event]
  | ['metric1' | 'metric2' | 'metric3', number]
  | ['tag1' | 'tag2' | 'tag3', string];

declare global {
  interface Window {
    dbbRum?: DebugBearRumEvent[];
  }
}

let debugBearRumStarted = false;

export function shouldEnableDebugBearRum(hostname: string): boolean {
  return DEBUGBEAR_RUM_HOSTS.has(hostname.toLowerCase());
}

/** Identifies a Sentry frame emitted by the configured DebugBear collector. */
export function isDebugBearRumScriptFrame(filename: string): boolean {
  return filename.endsWith(DEBUGBEAR_RUM_SCRIPT_PATHNAME) || /debugbear/i.test(filename);
}

function loadDebugBearRumScript(): void {
  if (typeof document === 'undefined') return;
  if (document.querySelector<HTMLScriptElement>(`script[src="${DEBUGBEAR_RUM_SCRIPT_SRC}"]`)) return;

  const script = document.createElement('script');
  script.async = true;
  script.src = DEBUGBEAR_RUM_SCRIPT_SRC;
  if ('fetchPriority' in script) {
    script.fetchPriority = 'low';
  }
  document.head.appendChild(script);
}

export function initDebugBearRum(): void {
  if (debugBearRumStarted || typeof window === 'undefined' || typeof document === 'undefined') return;
  if (!shouldEnableDebugBearRum(window.location.hostname)) return;
  if (Math.random() * 100 >= DEBUGBEAR_RUM_SAMPLE_RATE) return;

  debugBearRumStarted = true;
  const queue = window.dbbRum ?? [];
  window.dbbRum = queue;
  queue.push(['presampling', DEBUGBEAR_RUM_SAMPLE_RATE]);

  for (const type of ['error', 'unhandledrejection'] as const) {
    window.addEventListener(type, (event) => {
      queue.push([type, event]);
    });
  }

  loadDebugBearRumScript();
}

export function isDebugBearRumActive(): boolean {
  return debugBearRumStarted;
}

/**
 * Page-level bootstrap transfer fields. One tier is selected per page so a
 * later tier cannot overwrite the same DebugBear custom slots. The payload
 * contains only closed tags and numeric measurements; no request or stable ID.
 */
export function reportBootstrapTransferRum(sample: BootstrapTransferRumSample): void {
  if (!debugBearRumStarted || typeof window === 'undefined' || !window.dbbRum) return;
  window.dbbRum.push(
    ['metric1', sample.duration_ms],
    ['metric2', sample.decoded_bytes],
    ['metric3', sample.encoded_bytes],
    ['tag1', sample.tier],
    ['tag2', sample.outcome],
    ['tag3', sample.device_class],
  );
}

export function resetDebugBearRumForTesting(): void {
  debugBearRumStarted = false;
}
