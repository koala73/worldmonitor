const OVERLAY_STATE_KEY = '__wmOverlay';

export type OverlayId =
  | 'menu'
  | 'region'
  | 'search'
  | 'search-pending'
  | 'settings'
  | 'settings-pending'
  | 'map-popup'
  | 'deep-dive';

export type OverlayCloseOrigin = 'control' | 'history' | 'replacement';
type OverlayCloseCallback = (origin: OverlayCloseOrigin) => void;

type OverlayMarker = {
  id: OverlayId;
  token: string;
};

type OverlayEntry = OverlayMarker & {
  close: OverlayCloseCallback;
};

export interface OverlayHistoryEnvironment {
  readonly state: unknown;
  pushState(state: unknown): void;
  replaceState(state: unknown): void;
  back(): void;
  addPopStateListener(listener: (event: PopStateEvent) => void): void;
  removePopStateListener(listener: (event: PopStateEvent) => void): void;
}

export interface PendingOverlayGate {
  isCurrent(): boolean;
  cancel(): void;
}

export interface OverlayOpenHandle {
  cancel(): void;
}

function markerFromState(state: unknown): OverlayMarker | null {
  if (!state || typeof state !== 'object') return null;
  const marker = (state as Record<string, unknown>)[OVERLAY_STATE_KEY];
  if (!marker || typeof marker !== 'object') return null;
  const { id, token } = marker as Partial<OverlayMarker>;
  return isOverlayId(id) && typeof token === 'string' ? { id, token } : null;
}

function isOverlayId(value: unknown): value is OverlayId {
  return value === 'menu'
    || value === 'region'
    || value === 'search'
    || value === 'search-pending'
    || value === 'settings'
    || value === 'settings-pending'
    || value === 'map-popup'
    || value === 'deep-dive';
}

function withMarker(state: unknown, marker: OverlayMarker): Record<string, unknown> {
  const base = state && typeof state === 'object' ? state as Record<string, unknown> : {};
  return { ...base, [OVERLAY_STATE_KEY]: marker };
}

function withoutMarker(state: unknown): Record<string, unknown> {
  const base = state && typeof state === 'object' ? state as Record<string, unknown> : {};
  const { [OVERLAY_STATE_KEY]: _discarded, ...rest } = base;
  return rest;
}

/**
 * Gives mobile sheets a single browser-history stack. UI close controls remove
 * their synthetic entry; browser Back closes only the overlay above the state
 * being returned to. The manager deliberately owns no DOM so menu, search,
 * settings, map popup, and deep-dive surfaces all share the same semantics.
 */
export class OverlayHistoryManager {
  private entries: OverlayEntry[] = [];
  private readonly listeners = new Set<(top: OverlayId | null) => void>();
  private readonly pendingOperations: Array<() => void> = [];
  private popPending = false;
  private pendingGeneration = 0;
  private nextToken = 0;
  private readonly handlePopState = (event: PopStateEvent): void => {
    this.popPending = false;
    const destination = markerFromState(event.state);
    const destinationIndex = destination
      ? this.entries.findIndex((entry) => entry.token === destination.token)
      : -1;

    if (destination && destinationIndex === -1) {
      // Forward navigation must not resurrect UI that no longer exists.
      this.environment.replaceState(withoutMarker(event.state));
      this.flushPendingOperations();
      return;
    }

    const closing = this.entries.splice(destinationIndex + 1).reverse();
    for (const entry of closing) entry.close('history');
    this.notify();
    this.flushPendingOperations();
  };

  constructor(private readonly environment: OverlayHistoryEnvironment) {
    // Synthetic overlay markers describe in-memory UI owned by this manager.
    // A reload starts with no matching entries, so retain no orphan marker
    // that would force an extra Back press before leaving the page.
    if (markerFromState(this.environment.state)) {
      this.environment.replaceState(withoutMarker(this.environment.state));
    }
    this.environment.addPopStateListener(this.handlePopState);
  }

  public open(id: OverlayId, close: OverlayCloseCallback): void {
    if (this.deferUntilPop(() => this.open(id, close))) return;
    const existingIndex = this.entries.findIndex((entry) => entry.id === id);
    if (existingIndex >= 0) {
      const existing = this.entries[existingIndex];
      if (existing) existing.close = close;
      return;
    }
    const entry: OverlayEntry = {
      id,
      token: `wm-overlay-${++this.nextToken}`,
      close,
    };
    this.entries.push(entry);
    this.environment.pushState(withMarker(this.environment.state, { id: entry.id, token: entry.token }));
    this.notify();
  }

  /**
   * Open an overlay, allowing callers that can disappear before an async Back
   * traversal settles to cancel a queued registration.
   */
  public openCancelable(id: OverlayId, close: OverlayCloseCallback): OverlayOpenHandle {
    let queued = true;
    let cancelled = false;
    const register = () => {
      if (cancelled) return;
      queued = false;
      this.open(id, close);
    };
    if (this.deferUntilPop(register)) {
      return {
        cancel: () => {
          if (queued) cancelled = true;
        },
      };
    }
    register();
    return { cancel: () => {} };
  }

  public replace(fromId: OverlayId, id: OverlayId, close: OverlayCloseCallback): void {
    if (this.deferUntilPop(() => this.replace(fromId, id, close))) return;
    const top = this.entries[this.entries.length - 1];
    if (!top || top.id !== fromId) {
      this.open(id, close);
      return;
    }
    const entry: OverlayEntry = {
      id,
      token: `wm-overlay-${++this.nextToken}`,
      close,
    };
    this.entries[this.entries.length - 1] = entry;
    this.environment.replaceState(withMarker(this.environment.state, { id: entry.id, token: entry.token }));
    this.notify();
  }

  public replaceInPlace(fromId: OverlayId, id: OverlayId, close: OverlayCloseCallback): void {
    if (this.deferUntilPop(() => this.replaceInPlace(fromId, id, close))) return;
    const top = this.entries[this.entries.length - 1];
    if (!top || top.id !== fromId) {
      this.open(id, close);
      return;
    }
    const replaced = top.close;
    const entry: OverlayEntry = {
      id,
      token: `wm-overlay-${++this.nextToken}`,
      close,
    };
    this.entries[this.entries.length - 1] = entry;
    this.environment.replaceState(withMarker(this.environment.state, { id: entry.id, token: entry.token }));
    replaced('replacement');
    this.notify();
  }

  public beginPending(
    id: OverlayId,
    replaceOverlayId: OverlayId | undefined,
    onCancel: () => void,
  ): PendingOverlayGate {
    const generation = ++this.pendingGeneration;
    let registered = false;
    const invalidate = () => {
      if (this.pendingGeneration !== generation) return;
      this.pendingGeneration += 1;
      onCancel();
    };
    const register = () => {
      if (this.pendingGeneration !== generation) return;
      registered = true;
      if (replaceOverlayId) this.replaceInPlace(replaceOverlayId, id, invalidate);
      else this.open(id, invalidate);
    };
    if (!this.deferUntilPop(register)) register();
    return {
      isCurrent: () => this.pendingGeneration === generation && (!registered || this.top() === id),
      cancel: () => {
        if (this.pendingGeneration !== generation) return;
        invalidate();
        if (registered && this.top() === id) this.close(id);
      },
    };
  }

  public close(id: OverlayId): void {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry) return;
    if (this.popPending) {
      this.pendingOperations.push(() => this.closeToken(entry.token));
      return;
    }
    this.closeToken(entry.token);
  }

  public dismiss(id: OverlayId): void {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry) return;
    if (this.popPending) {
      this.pendingOperations.push(() => this.dismissToken(entry.token));
      return;
    }
    this.dismissToken(entry.token);
  }

  public top(): OverlayId | null {
    return this.entries[this.entries.length - 1]?.id ?? null;
  }

  public subscribe(listener: (top: OverlayId | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public reset(): void {
    this.entries = [];
    this.pendingOperations.length = 0;
    this.popPending = false;
    this.pendingGeneration += 1;
    if (markerFromState(this.environment.state)) {
      this.environment.replaceState(withoutMarker(this.environment.state));
    }
    this.notify();
  }

  public destroy(): void {
    this.reset();
    this.environment.removePopStateListener(this.handlePopState);
    this.listeners.clear();
  }

  private closeToken(token: string): void {
    const index = this.entries.findIndex((entry) => entry.token === token);
    if (index === -1) return;
    const [entry] = this.entries.splice(index, 1);
    if (!entry) return;
    const current = markerFromState(this.environment.state);
    if (index === this.entries.length && current?.token === entry.token) {
      this.popPending = true;
      this.environment.back();
    }
    this.notify();
  }

  private dismissToken(token: string): void {
    const entry = this.entries.find((candidate) => candidate.token === token);
    if (!entry) return;
    this.closeToken(token);
    entry.close('replacement');
  }

  private deferUntilPop(operation: () => void): boolean {
    if (!this.popPending) return false;
    this.pendingOperations.push(operation);
    return true;
  }

  private flushPendingOperations(): void {
    while (!this.popPending) {
      const operation = this.pendingOperations.shift();
      if (!operation) return;
      operation();
    }
  }

  private notify(): void {
    const top = this.top();
    this.listeners.forEach((listener) => listener(top));
  }
}

function browserEnvironment(): OverlayHistoryEnvironment {
  if (typeof window === 'undefined') {
    return {
      state: null,
      pushState() {},
      replaceState() {},
      back() {},
      addPopStateListener() {},
      removePopStateListener() {},
    };
  }
  return {
    get state() {
      return window.history.state;
    },
    pushState(state) {
      window.history.pushState(state, '', window.location.href);
    },
    replaceState(state) {
      window.history.replaceState(state, '', window.location.href);
    },
    back() {
      window.history.back();
    },
    addPopStateListener(listener) {
      window.addEventListener('popstate', listener);
    },
    removePopStateListener(listener) {
      window.removeEventListener('popstate', listener);
    },
  };
}

export const overlayHistory = new OverlayHistoryManager(browserEnvironment());
