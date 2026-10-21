import type { Page } from '@playwright/test';

/** Terminal events observed during boot. Each registration returns its cleanup. */
export interface BrowserLossEvents {
  onCrash(listener: () => void): () => void;
  onBrowserDisconnected(listener: () => void): () => void;
  onContextClose(listener: () => void): () => void;
}

export function pageBrowserLossEvents(page: Page): BrowserLossEvents {
  return {
    onCrash: (listener) => {
      page.on('crash', listener);
      return () => { page.off('crash', listener); };
    },
    onBrowserDisconnected: (listener) => {
      const browser = page.context().browser();
      browser?.on('disconnected', listener);
      return () => { browser?.off('disconnected', listener); };
    },
    onContextClose: (listener) => {
      const context = page.context();
      context.on('close', listener);
      return () => { context.off('close', listener); };
    },
  };
}

/** Record observed signals, not an inferred cause; correlate with pw:browser. */
export function attachBrowserLossDiagnostics(
  events: BrowserLossEvents,
  label: string,
  log: (line: string) => void = (line) => console.error(line),
  now: () => string = () => new Date().toISOString(),
): { dispose: () => void } {
  type Kind = 'renderer-crash' | 'browser-disconnected' | 'context-closed';
  const reported = new Set<Kind>();
  const report = (kind: Kind) => {
    if (reported.has(kind)) return;
    reported.add(kind);
    log(`[browser-loss] kind=${kind} spec="${label}" at=${now()}`);
  };
  // A browser exit can emit context-close and disconnected on separate turns.
  // Suppressing later signals would discard the evidence of process loss.
  const removeListeners = [
    events.onCrash(() => report('renderer-crash')),
    events.onBrowserDisconnected(() => report('browser-disconnected')),
    events.onContextClose(() => report('context-closed')),
  ];
  return { dispose: () => { for (const remove of removeListeners) remove(); } };
}
