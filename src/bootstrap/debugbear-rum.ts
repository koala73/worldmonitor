export const DEBUGBEAR_RUM_SCRIPT_SRC = 'https://cdn.debugbear.com/lpMwA9KpC6pf.js';
export const DEBUGBEAR_RUM_SAMPLE_RATE = 100;
const DEBUGBEAR_RUM_SCRIPT_PATHNAME = new URL(DEBUGBEAR_RUM_SCRIPT_SRC).pathname;
const DEBUGBEAR_RUM_HOSTS = new Set([
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

export function resetDebugBearRumForTesting(): void {
  debugBearRumStarted = false;
}
