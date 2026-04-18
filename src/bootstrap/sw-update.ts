interface VisibleElementLike {
  checkVisibility?: () => boolean;
  getClientRects?: () => { length: number };
}

interface DocumentLike {
  readonly visibilityState: string;
  querySelector: (sel: string) => Element | null;
  querySelectorAll: (sel: string) => Iterable<Element & VisibleElementLike>;
  createElement: (tag: string) => HTMLElement;
  body: { appendChild: (el: Element) => void; contains: (el: Element | null) => boolean };
  addEventListener: (type: string, cb: () => void) => void;
  removeEventListener: (type: string, cb: () => void) => void;
}

interface ServiceWorkerContainerLike {
  readonly controller: object | null;
  addEventListener: (type: string, cb: () => void) => void;
}

export interface SwUpdateHandlerOptions {
  swContainer?: ServiceWorkerContainerLike;
  document?: DocumentLike;
  reload?: () => void;
  /** Override requestAnimationFrame for testing (defaults to global rAF). */
  raf?: (cb: () => void) => void;
  /** Override setTimeout for testing. */
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** Override clearTimeout for testing. */
  clearTimer?: (id: ReturnType<typeof setTimeout> | null) => void;
  /** Enable debug logging. Defaults to localStorage.getItem('wm-debug-sw') === '1'. */
  debug?: boolean;
  /** App version string included in debug log entries. */
  version?: string;
}

// ---------------------------------------------------------------------------
// Debug logging (opt-in via localStorage.setItem('wm-debug-sw', '1'))
// Persists a rolling 30-entry log in sessionStorage so it survives page reloads.
// Copy with: JSON.parse(sessionStorage.getItem('wm-sw-debug-log'))
// ---------------------------------------------------------------------------

export const SW_DEBUG_LOG_KEY = 'wm-sw-debug-log';
const SW_DEBUG_LOG_MAX = 30;

// Selectors that identify a modal/dialog candidate. Many site modals mount
// at app startup and stay in the DOM (e.g. UnifiedSettings sets
// role="dialog" in its constructor), so a raw selector match alone would
// permanently disable auto-reload. We only treat a match as "open" when
// the element is actually rendered — see isModalOpen() below.
export const OPEN_MODAL_SELECTOR =
  '[aria-modal="true"], [role="dialog"], .cl-modalBackdrop, .modal-overlay, dialog[open]';

/**
 * Any candidate that's actually visible → a real open modal.
 *
 * Preferred: `element.checkVisibility()` (Chrome 105+, Safari 17.4+, FF 125+).
 *
 * Fallback for older engines: `getClientRects().length > 0`. This returns 0
 * when the element has `display: none` (exactly how persistent overlays
 * hide — see main.css `.modal-overlay { display: none }` /
 * `.active { display: flex }`) and non-zero for rendered elements,
 * including `position: fixed` overlays. We cannot use `offsetParent` here:
 * MDN specifies it returns `null` for every `position: fixed` element
 * regardless of visibility, so it would false-negative on the Story overlay
 * (main.css:3442), the active Country Intel overlay (main.css:18415), and
 * `.modal-overlay` itself — all of which are fixed-positioned.
 */
function isModalOpen(doc: DocumentLike): boolean {
  for (const el of doc.querySelectorAll(OPEN_MODAL_SELECTOR)) {
    const checkVisibility = el.checkVisibility;
    if (typeof checkVisibility === 'function') {
      if (checkVisibility.call(el)) return true;
      continue;
    }
    const getClientRects = el.getClientRects;
    if (typeof getClientRects === 'function' && getClientRects.call(el).length > 0) {
      return true;
    }
  }
  return false;
}

function appendDebugLog(entry: Record<string, unknown>): void {
  try {
    const raw = sessionStorage.getItem(SW_DEBUG_LOG_KEY);
    const log = (raw ? JSON.parse(raw) : []) as unknown[];
    log.push(entry);
    if (log.length > SW_DEBUG_LOG_MAX) log.splice(0, log.length - SW_DEBUG_LOG_MAX);
    sessionStorage.setItem(SW_DEBUG_LOG_KEY, JSON.stringify(log));
  } catch {}
}

/**
 * Wires up the SW update toast.
 *
 * On each controllerchange after the first (first = initial claim on a new session),
 * shows a dismissible "Update Available" toast.
 *
 * Auto-reload on tab-hide requires the tab to have been visible for at least
 * VISIBLE_DWELL_MS continuously since the toast appeared. This prevents two failure modes:
 *
 * 1. Background infinite loop: update detected in a hidden tab → onHidden fires
 *    immediately → reload → new page → same → loop forever.
 *
 * 2. Session-restore ghost reload: session-restore briefly marks tabs visible for
 *    one animation frame, which would allow a hidden-tab auto-reload prematurely.
 *
 * Dismissing one version never suppresses toasts for future deploys.
 */
export function installSwUpdateHandler(options: SwUpdateHandlerOptions = {}): void {
  const swContainer = options.swContainer ?? navigator.serviceWorker;
  const doc = options.document ?? (document as unknown as DocumentLike);
  const reload = options.reload ?? (() => window.location.reload());
  const raf = options.raf ?? ((cb: () => void) => requestAnimationFrame(() => requestAnimationFrame(cb)));
  const setTimer = options.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearTimer = options.clearTimer ?? ((id: ReturnType<typeof setTimeout> | null) => { if (id !== null) clearTimeout(id); });

  const debugEnabled = options.debug ?? (() => {
    try { return localStorage.getItem('wm-debug-sw') === '1'; } catch { return false; }
  })();
  const version = options.version;

  function logSw(event: string, extra: Record<string, unknown> = {}): void {
    if (!debugEnabled) return;
    const entry: Record<string, unknown> = {
      event,
      ts: new Date().toISOString(),
      visibility: doc.visibilityState,
      hasController: !!swContainer.controller,
      ...extra,
    };
    if (version !== undefined) entry.version = version;
    console.log('[SWDEBUG]', entry);
    appendDebugLog(entry);
  }

  // Minimum time the tab must remain visible after the toast appears before
  // auto-reload on tab-hide is enabled.
  const VISIBLE_DWELL_MS = 5_000;

  let currentOnHidden: (() => void) | null = null;
  let currentDwellCancel: (() => void) | null = null;

  const showToast = (): void => {
    if (currentOnHidden) {
      doc.removeEventListener('visibilitychange', currentOnHidden);
      currentOnHidden = null;
    }
    // P2: cancel stale dwell timer from the superseded toast so it cannot
    // fire after the toast is gone (prevents debug log pollution).
    if (currentDwellCancel) {
      currentDwellCancel();
      currentDwellCancel = null;
    }
    doc.querySelector('.update-toast')?.remove();

    const toast = doc.createElement('div');
    toast.className = 'update-toast';
    toast.innerHTML = `
      <div class="update-toast-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="23 4 23 10 17 10"/>
          <path d="M20.49 15a9 9 0 1 1-.49-4.9L23 10"/>
        </svg>
      </div>
      <div class="update-toast-body">
        <div class="update-toast-title">Update Available</div>
        <div class="update-toast-detail">A new version is ready.</div>
      </div>
      <button class="update-toast-action" data-action="reload">Reload</button>
      <button class="update-toast-dismiss" data-action="dismiss" aria-label="Dismiss">\u00d7</button>
    `;

    let dismissed = false;
    let autoReloadAllowed = false;
    let dwellTimerId: ReturnType<typeof setTimer> | null = null;

    const startDwellTimer = (): void => {
      if (dwellTimerId !== null || dismissed || autoReloadAllowed) return;
      logSw('dwell-timer-started', { delayMs: VISIBLE_DWELL_MS });
      dwellTimerId = setTimer(() => {
        dwellTimerId = null;
        autoReloadAllowed = true;
        logSw('dwell-timer-expired', { autoReloadAllowed: true });
      }, VISIBLE_DWELL_MS);
    };

    // If already visible when the toast appears, start the dwell timer immediately.
    if (doc.visibilityState === 'visible') startDwellTimer();

    logSw('toast-shown', { wasVisible: doc.visibilityState === 'visible' });

    const onHidden = (): void => {
      if (doc.visibilityState === 'visible') {
        // Tab returned to foreground — start dwell timer if not already running.
        logSw('visibility-visible');
        startDwellTimer();
        return;
      }
      // P1: hidden time must not count toward the dwell window — cancel the
      // in-flight timer so the full VISIBLE_DWELL_MS restarts on next foreground.
      if (!autoReloadAllowed && dwellTimerId !== null) {
        clearTimer(dwellTimerId);
        dwellTimerId = null;
        logSw('dwell-timer-cancelled-on-hide');
      }
      logSw('visibility-hidden', { autoReloadAllowed, dismissed });
      if (!dismissed && autoReloadAllowed && doc.body.contains(toast)) {
        // Don't interrupt an in-flight modal flow (Clerk email-code wait,
        // Settings, ⌘K search, etc.). The reload stays armed — next tab-hide
        // after the modal closes will fire it. User can also click Reload
        // in the toast manually at any time.
        if (isModalOpen(doc)) {
          logSw('auto-reload-suppressed-modal-open');
          return;
        }
        logSw('auto-reload-triggered');
        reload();
      }
    };

    toast.addEventListener('click', (e) => {
      const action = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
      if (action === 'reload') {
        clearTimer(dwellTimerId);
        dwellTimerId = null;
        currentDwellCancel = null;
        logSw('reload-clicked');
        reload();
      } else if (action === 'dismiss') {
        clearTimer(dwellTimerId);
        dwellTimerId = null;
        currentDwellCancel = null;
        dismissed = true;
        logSw('dismiss-clicked');
        doc.removeEventListener('visibilitychange', onHidden);
        currentOnHidden = null;
        toast.classList.remove('visible');
        setTimeout(() => toast.remove(), 300);
      }
    });

    currentOnHidden = onHidden;
    currentDwellCancel = () => { clearTimer(dwellTimerId); dwellTimerId = null; };
    doc.addEventListener('visibilitychange', onHidden);
    doc.body.appendChild(toast);
    raf(() => toast.classList.add('visible'));
  };

  let hadController = !!swContainer.controller;
  logSw('handler-installed', { hadController });
  swContainer.addEventListener('controllerchange', () => {
    logSw('controllerchange', { hadController });
    if (!hadController) {
      hadController = true;
      return;
    }
    showToast();
  });
}
