import { whenUrlFreeOfSensitiveParams } from '../../shared/sensitive-url-params';

export const DEBUGBEAR_RUM_SCRIPT_SRC = 'https://cdn.debugbear.com/lpMwA9KpC6pf.js';
// 10% sampling. 100% overran the DebugBear RUM monthly quota (~529k/500k, 2026-07). The R2-origin
// experiment that justified full sampling is a no-go (KTD7 feasibility failure); ongoing web-vitals
// RUM needs only a fraction. Keep in sync with src/bootstrap/debugbear-rum.ts (asserted by the test).
export const DEBUGBEAR_RUM_SAMPLE_RATE = 10;
/** See the dashboard sibling — exported for `tests/sentry-allow-urls.test.mts`. */
export const DEBUGBEAR_RUM_HOSTS = new Set([
  'worldmonitor.app',
  'www.worldmonitor.app',
  'tech.worldmonitor.app',
  'finance.worldmonitor.app',
  'commodity.worldmonitor.app',
  'happy.worldmonitor.app',
  'energy.worldmonitor.app',
]);

type DebugBearRumEvent = ['presampling', number] | ['error' | 'unhandledrejection', Event];

declare global {
  interface Window {
    dbbRum?: DebugBearRumEvent[];
  }
}

let debugBearRumStarted = false;
let removeErrorListeners: (() => void) | undefined;
const MAX_BUFFERED_ERRORS = 50;

export function shouldEnableDebugBearRum(hostname: string): boolean {
  return DEBUGBEAR_RUM_HOSTS.has(hostname.toLowerCase());
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
  script.onerror = abandonDebugBearRum;
  document.head.appendChild(script);
}

/** Drop the pre-script error buffer and listeners when the collector will
 * never run (load failure, or a URL that never sheds its sensitive params). */
function abandonDebugBearRum(): void {
  removeErrorListeners?.();
  const queue = window.dbbRum;
  if (Array.isArray(queue)) {
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i]?.[0] === 'error' || queue[i]?.[0] === 'unhandledrejection') queue.splice(i, 1);
    }
  }
  debugBearRumStarted = false;
}

export function initDebugBearRum(): void {
  if (debugBearRumStarted || typeof window === 'undefined' || typeof document === 'undefined') return;
  if (!shouldEnableDebugBearRum(window.location.hostname)) return;
  if (Math.random() * 100 >= DEBUGBEAR_RUM_SAMPLE_RATE) return;

  debugBearRumStarted = true;
  const queue = window.dbbRum ?? [];
  window.dbbRum = queue;
  queue.push(['presampling', DEBUGBEAR_RUM_SAMPLE_RATE]);

  // The loaded collector replaces the array and still needs these listeners
  // (#8249), so push to whatever window.dbbRum currently is.
  const target = window;
  const onError = (event: Event) => {
    const current = target.dbbRum;
    if (!current) return;
    if (Array.isArray(current)
      && current.filter(([type]) => type === 'error' || type === 'unhandledrejection').length >= MAX_BUFFERED_ERRORS) return;
    current.push([event.type as 'error' | 'unhandledrejection', event]);
  };
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onError);
  removeErrorListeners = () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onError);
    removeErrorListeners = undefined;
  };

  // Hold the collector until referral/invite/checkout/Clerk params are gone
  // from the live URL; see the dashboard sibling.
  whenUrlFreeOfSensitiveParams(() => window.location.href, loadDebugBearRumScript, abandonDebugBearRum);
}

export function resetDebugBearRumForTesting(): void {
  removeErrorListeners?.();
  debugBearRumStarted = false;
}
