import { isDesktopRuntime } from '../services/runtime';
import { invokeTauri } from '../services/tauri-bridge';
import { t } from '../services/i18n';
import { type DomChild, h, replaceChildren, safeHtml as sanitizeHtmlFragment, setTrustedHtml, trustedHtml, type TrustedHtml } from '../utils/dom-utils';
import { safeHtmlToString, type SafeHtml } from '@/utils/sanitize';
import { trackPanelResized } from '@/services/analytics';
import { getAiFlowSettings } from '@/services/ai-flow-settings';
import { getSecretState } from '@/services/runtime-config';
import { PanelGateReason } from '@/services/panel-gating';
import { openExternalUrl } from '@/services/external-navigation';
import { lockSvg, upgradeSvg } from '@/components/gate-icons';
import { createCheckoutConsentElement } from '@/utils/legal-links';
import { WEB_APP_ORIGIN } from '@/config/web-origin';
import { dataFreshness, type PanelFreshnessSummary } from '@/services/data-freshness';
import { formatPanelFreshnessDisplay } from '@/services/panel-freshness-display';
import {
  clearPanelColSpan,
  clearPanelSpan,
  loadPanelCollapsed,
  loadPanelColSpans,
  loadPanelSpans,
  savePanelCollapsed,
  savePanelColSpan,
  savePanelSpan,
} from '@/utils/panel-storage';
import {
  clampColSpan,
  clearColSpanClass,
  getExplicitColSpanClass,
  getMaxColSpan,
  isPanelGridColumnCountReady,
  setColSpanClass,
} from '@/utils/panel-grid';

export type PanelSeverity = 'critical' | 'high' | 'medium' | 'low' | 'none';

export interface PanelOptions {
  id: string;
  title: string;
  showCount?: boolean;
  className?: string;
  trackActivity?: boolean;
  infoTooltip?: string;
  premium?: 'locked' | 'enhanced';
  closable?: boolean;
  collapsible?: boolean;
  defaultRowSpan?: number;
}

const ROW_RESIZE_STEP_PX = 80;
const COL_RESIZE_STEP_PX = 80;
const FRESHNESS_BADGE_REFRESH_MS = 60_000;

function getDefaultColSpan(element: HTMLElement): number {
  return element.classList.contains('panel-wide') ? 2 : 1;
}

function getColSpan(element: HTMLElement): number {
  return getExplicitColSpanClass(element) ?? getDefaultColSpan(element);
}

function persistPanelColSpan(panelId: string, element: HTMLElement): void {
  const maxSpan = getMaxColSpan(element);
  const naturalSpan = clampColSpan(getDefaultColSpan(element), maxSpan);
  const currentSpan = clampColSpan(getColSpan(element), maxSpan);
  if (currentSpan === naturalSpan) {
    element.classList.remove('col-span-1', 'col-span-2', 'col-span-3');
    clearPanelColSpan(panelId);
    return;
  }
  setColSpanClass(element, currentSpan);
  savePanelColSpan(panelId, currentSpan);
}

function deltaToColSpan(startSpan: number, deltaX: number, maxSpan = 3): number {
  const spanDelta = deltaX > 0
    ? Math.floor(deltaX / COL_RESIZE_STEP_PX)
    : Math.ceil(deltaX / COL_RESIZE_STEP_PX);
  return clampColSpan(startSpan + spanDelta, maxSpan);
}

function getRowSpan(element: HTMLElement): number {
  if (element.classList.contains('span-4')) return 4;
  if (element.classList.contains('span-3')) return 3;
  if (element.classList.contains('span-2')) return 2;
  if (element.classList.contains('span-1')) return 1;
  // A natural wide panel already occupies two dashboard rows even when it
  // has no explicit span-N class. Treat that footprint as the resize baseline
  // so the first vertical drag changes the visible height instead of being a
  // no-op against the existing grid-row: span 2 rule.
  return element.classList.contains('panel-wide') ? 2 : 1;
}

function deltaToRowSpan(startSpan: number, deltaY: number): number {
  const spanDelta = deltaY > 0
    ? Math.floor(deltaY / ROW_RESIZE_STEP_PX)
    : Math.ceil(deltaY / ROW_RESIZE_STEP_PX);
  return Math.max(1, Math.min(4, startSpan + spanDelta));
}

function setSpanClass(element: HTMLElement, span: number): void {
  element.classList.remove('span-1', 'span-2', 'span-3', 'span-4');
  element.classList.add(`span-${span}`);
  element.classList.add('resized');
}

export class Panel {
  protected element: HTMLElement;
  protected content: HTMLElement;
  protected header: HTMLElement;
  protected countEl: HTMLElement | null = null;
  protected statusBadgeEl: HTMLElement | null = null;
  protected newBadgeEl: HTMLElement | null = null;
  private freshnessBadgeEl: HTMLElement | null = null;
  private freshnessUnsubscribe: (() => void) | null = null;
  private freshnessRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private severityDotEl: HTMLElement | null = null;
  private currentSeverity: PanelSeverity = 'none';
  protected panelId: string;
  private abortController: AbortController = new AbortController();
  private tooltipCloseHandler: (() => void) | null = null;
  private resizeHandle: HTMLElement | null = null;
  private isResizing = false;
  private startY = 0;
  private startRowSpan = 1;
  private onTouchMove: ((e: TouchEvent) => void) | null = null;
  private onTouchEnd: (() => void) | null = null;
  private onTouchCancel: (() => void) | null = null;
  private onDocMouseUp: (() => void) | null = null;
  private onRowMouseMove: ((e: MouseEvent) => void) | null = null;
  private onRowMouseUp: (() => void) | null = null;
  private onRowWindowBlur: (() => void) | null = null;
  private colResizeHandle: HTMLElement | null = null;
  private isColResizing = false;
  private startX = 0;
  private startColSpan = 1;
  private onColMouseMove: ((e: MouseEvent) => void) | null = null;
  private onColMouseUp: (() => void) | null = null;
  private onColWindowBlur: (() => void) | null = null;
  private onColTouchMove: ((e: TouchEvent) => void) | null = null;
  private onColTouchEnd: (() => void) | null = null;
  private onColTouchCancel: (() => void) | null = null;
  private colSpanReconcileRaf: number | null = null;
  private readonly contentDebounceMs = 150;
  private pendingContentHtml: string | null = null;
  /**
   * The exact string last written by `setContentImmediate`, or `null` when the
   * content was replaced by any other path (loading/error/locked states, clear,
   * saved-content restore) and is therefore no longer a known string.
   *
   * Exists to keep the two content dirty-checks off `this.content.innerHTML`:
   * reading that getter serializes the whole panel subtree to a string, and it
   * was read twice per update — once to decide whether to schedule the write and
   * again to decide whether to perform it. Panels re-render on every data tick,
   * so that serialization was pure overhead on the render path. `null` compares
   * unequal to any candidate, so an unknown state always falls through to a
   * write — the safe direction.
   */
  private lastCommittedHtml: string | null = null;
  private contentDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingContentCallback: (() => void) | null = null;
  private retryCallback: (() => void) | null = null;
  private retryCountdownTimer: ReturnType<typeof setInterval> | null = null;
  private retryAttempt = 0;
  private _fetching = false;
  private _locked = false;
  // Lock-awareness for subclasses that write positionally (insertBefore /
  // appendChild into this.content) instead of through the setContent* helpers.
  // #6678's GdeltIntelPanel previously proxied this via
  // element.classList.contains('panel-is-locked') — a string-keyed mirror of
  // private state that belongs once on the base class (#6714).
  protected get isLocked(): boolean {
    return this._locked;
  }
  // Last reason rendered by showGatedCta, so repeat gating passes with an
  // unchanged verdict skip the DOM teardown/rebuild (#4771 re-runs gating on
  // every subscription-row change, including fields irrelevant to gating).
  private _lastGateReason: PanelGateReason | null = null;
  // Snapshot of this.content's children at the moment showLocked /
  // showGatedCta replaces them with a lock CTA. unlockPanel re-attaches
  // these nodes so subclasses whose UI is constructed once (typically in
  // the ctor — chips, input rows, static chrome) don't end up with a
  // permanently empty body after a FREE→PRO auth-state cycle. The cache
  // holds the actual DOM nodes; reattaching preserves any listeners and
  // any subclass references like `this.inputEl`.
  private _savedContent: ChildNode[] | null = null;
  private _collapsed = false;
  private _collapseBtn: HTMLButtonElement | null = null;
  private viewportObserver: IntersectionObserver | null = null;
  private viewportObserverRegistered = false;
  private connectedCallbacks: Array<() => void> = [];
  private connectedFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(options: PanelOptions) {
    this.panelId = options.id;
    this.element = document.createElement('div');
    this.element.className = `panel ${options.className || ''}`;
    this.element.dataset.panel = options.id;

    this.header = document.createElement('div');
    this.header.className = 'panel-header';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'panel-header-left';

    const title = document.createElement('span');
    title.className = 'panel-title';
    title.textContent = options.title;
    // Panels are the dashboard's sections, but a real <h2> would drag along
    // element styles; role/aria-level gives the outline with zero visual change.
    title.setAttribute('role', 'heading');
    title.setAttribute('aria-level', '2');
    headerLeft.appendChild(title);

    this.severityDotEl = document.createElement('span');
    this.severityDotEl.className = 'panel-severity-dot';
    this.severityDotEl.setAttribute('aria-hidden', 'true');
    headerLeft.appendChild(this.severityDotEl);

    const initialFreshness = dataFreshness.getPanelFreshness(this.panelId);
    if (initialFreshness) {
      this.freshnessBadgeEl = document.createElement('span');
      this.freshnessBadgeEl.className = 'panel-freshness-badge';
      headerLeft.appendChild(this.freshnessBadgeEl);
      this.updateFreshnessBadge(initialFreshness);
      this.freshnessUnsubscribe = dataFreshness.subscribe(() => this.updateFreshnessBadge());
      this.freshnessRefreshTimer = setInterval(
        () => this.updateFreshnessBadge(),
        FRESHNESS_BADGE_REFRESH_MS,
      );
    }

    if (options.infoTooltip) {
      const infoBtn = h('button', { className: 'panel-info-btn', 'aria-label': t('components.panel.showMethodologyInfo') }, '?');

      const tooltip = h('div', { className: 'panel-info-tooltip' });
      tooltip.appendChild(sanitizeHtmlFragment(options.infoTooltip));

      infoBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        tooltip.classList.toggle('visible');
      });

      this.tooltipCloseHandler = () => tooltip.classList.remove('visible');
      document.addEventListener('click', this.tooltipCloseHandler);

      const infoWrapper = document.createElement('div');
      infoWrapper.className = 'panel-info-wrapper';
      infoWrapper.appendChild(infoBtn);
      infoWrapper.appendChild(tooltip);
      headerLeft.appendChild(infoWrapper);
    }

    // Add "new" badge element (hidden by default)
    if (options.trackActivity !== false) {
      this.newBadgeEl = document.createElement('span');
      this.newBadgeEl.className = 'panel-new-badge';
      this.newBadgeEl.style.display = 'none';
      headerLeft.appendChild(this.newBadgeEl);
    }

    if (options.premium && !getSecretState('WORLDMONITOR_API_KEY').present) {
      const proBadge = h('span', { className: 'panel-pro-badge' }, t('premium.pro'));
      headerLeft.appendChild(proBadge);
    }

    this.header.appendChild(headerLeft);

    this.statusBadgeEl = document.createElement('span');
    this.statusBadgeEl.className = 'panel-data-badge';
    this.statusBadgeEl.style.display = 'none';
    this.header.appendChild(this.statusBadgeEl);

    if (options.showCount) {
      this.countEl = document.createElement('span');
      this.countEl.className = 'panel-count';
      this.countEl.textContent = '0';
      this.header.appendChild(this.countEl);
    }

    if (options.collapsible) {
      this.appendCollapseButton();
    }

    if (options.closable !== false) {
      this.appendCloseButton();
    }

    this.content = document.createElement('div');
    this.content.className = 'panel-content';
    this.content.id = `${options.id}Content`;

    this.element.appendChild(this.header);
    this.element.appendChild(this.content);

    if (this._collapseBtn && loadPanelCollapsed()[this.panelId]) {
      this._applyCollapsed(this._collapseBtn, true);
    }

    this.content.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest('[data-panel-retry]');
      if (!target || this._fetching) return;
      this.retryCallback?.();
    });

    // Add resize handle
    this.resizeHandle = document.createElement('div');
    this.resizeHandle.className = 'panel-resize-handle';
    this.resizeHandle.title = t('components.panel.dragToResize');
    this.element.appendChild(this.resizeHandle);
    this.setupResizeHandlers();

    // Right-edge handle for width resizing
    this.colResizeHandle = document.createElement('div');
    this.colResizeHandle.className = 'panel-col-resize-handle';
    this.colResizeHandle.title = t('components.panel.dragToResize');
    this.element.appendChild(this.colResizeHandle);
    this.setupColResizeHandlers();

    // Apply default row span (before restore, so saved preferences win)
    if (options.defaultRowSpan && options.defaultRowSpan > 1) {
      this.element.classList.add(`span-${options.defaultRowSpan}`);
    }

    // Restore saved span (overrides default)
    const savedSpans = loadPanelSpans();
    const savedSpan = savedSpans[this.panelId];
    if (savedSpan !== undefined) {
      setSpanClass(this.element, savedSpan);
    }

    // Restore saved col-span
    this.restoreSavedColSpan();
    this.reconcileColSpanAfterAttach();
    this.setupKeyboardRowResize();
    this.setupKeyboardColResize();

    this.showLoading();
  }

  private restoreSavedColSpan(): void {
    const savedColSpans = loadPanelColSpans();
    const savedColSpan = savedColSpans[this.panelId];
    if (typeof savedColSpan === 'number' && Number.isInteger(savedColSpan) && savedColSpan >= 1) {
      const naturalSpan = getDefaultColSpan(this.element);
      if (savedColSpan === naturalSpan) {
        clearColSpanClass(this.element);
        clearPanelColSpan(this.panelId);
        return;
      }

      const maxSpan = getMaxColSpan(this.element);
      const clampedSavedSpan = clampColSpan(savedColSpan, maxSpan);
      setColSpanClass(this.element, clampedSavedSpan);
    } else if (savedColSpan !== undefined) {
      clearPanelColSpan(this.panelId);
    }
  }

  private reconcileColSpanAfterAttach(attempts = 3): void {
    if (this.colSpanReconcileRaf !== null) {
      cancelAnimationFrame(this.colSpanReconcileRaf);
      this.colSpanReconcileRaf = null;
    }

    const tryReconcile = (remaining: number) => {
      if (!this.element.isConnected || !this.element.parentElement || !isPanelGridColumnCountReady(this.element)) {
        if (remaining <= 0) {
          this.colSpanReconcileRaf = null;
          return;
        }
        this.colSpanReconcileRaf = requestAnimationFrame(() => tryReconcile(remaining - 1));
        return;
      }
      this.colSpanReconcileRaf = null;
      this.restoreSavedColSpan();
      this.syncKeyboardColResizeAria();
    };

    tryReconcile(attempts);
  }

  private addRowTouchDocumentListeners(): void {
    if (this.onTouchMove) {
      document.addEventListener('touchmove', this.onTouchMove, { passive: false });
    }
    if (this.onTouchEnd) {
      document.addEventListener('touchend', this.onTouchEnd);
    }
    if (this.onTouchCancel) {
      document.addEventListener('touchcancel', this.onTouchCancel);
    }
  }

  private removeRowTouchDocumentListeners(): void {
    if (this.onTouchMove) {
      document.removeEventListener('touchmove', this.onTouchMove);
    }
    if (this.onTouchEnd) {
      document.removeEventListener('touchend', this.onTouchEnd);
    }
    if (this.onTouchCancel) {
      document.removeEventListener('touchcancel', this.onTouchCancel);
    }
  }

  /**
   * Keyboard path for the mouse/touch drag handles (WAI-ARIA window-splitter):
   * the handle is a focusable role="separator"; arrow keys step the span one
   * unit and persist through the same code path as a completed drag.
   */
  private setupKeyboardRowResize(): void {
    const handle = this.resizeHandle;
    if (!handle) return;
    handle.tabIndex = 0;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'horizontal');
    handle.setAttribute('aria-label', t('components.panel.dragToResize'));
    handle.setAttribute('aria-valuemin', '1');
    handle.setAttribute('aria-valuemax', '4');
    this.syncKeyboardRowResizeAria();
    handle.addEventListener('keydown', (e: KeyboardEvent) => {
      const current = getRowSpan(this.element);
      let next: number | null = null;
      if (e.key === 'ArrowUp') next = Math.max(1, current - 1);
      else if (e.key === 'ArrowDown') next = Math.min(4, current + 1);
      else if (e.key === 'Home') next = 1;
      else if (e.key === 'End') next = 4;
      if (next === null) return;
      e.preventDefault();
      if (next === current) return;
      setSpanClass(this.element, next);
      savePanelSpan(this.panelId, next);
      trackPanelResized(this.panelId, next);
      this.syncKeyboardRowResizeAria();
    });
  }

  private setupKeyboardColResize(): void {
    const handle = this.colResizeHandle;
    if (!handle) return;
    handle.tabIndex = 0;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', t('components.panel.dragToResize'));
    handle.setAttribute('aria-valuemin', '1');
    this.syncKeyboardColResizeAria();
    handle.addEventListener('keydown', (e: KeyboardEvent) => {
      const maxSpan = getMaxColSpan(this.element);
      const current = clampColSpan(getColSpan(this.element), maxSpan);
      let next: number | null = null;
      if (e.key === 'ArrowLeft') next = Math.max(1, current - 1);
      else if (e.key === 'ArrowRight') next = Math.min(maxSpan, current + 1);
      else if (e.key === 'Home') next = 1;
      else if (e.key === 'End') next = maxSpan;
      if (next === null) return;
      e.preventDefault();
      if (next === current) return;
      setColSpanClass(this.element, next);
      persistPanelColSpan(this.panelId, this.element);
      this.syncKeyboardColResizeAria();
    });
  }

  private syncKeyboardRowResizeAria(): void {
    this.resizeHandle?.setAttribute('aria-valuenow', String(getRowSpan(this.element)));
  }

  private syncKeyboardColResizeAria(): void {
    if (!this.colResizeHandle) return;
    const maxSpan = getMaxColSpan(this.element);
    this.colResizeHandle.setAttribute('aria-valuemax', String(maxSpan));
    this.colResizeHandle.setAttribute(
      'aria-valuenow',
      String(clampColSpan(getColSpan(this.element), maxSpan)),
    );
  }

  private setupResizeHandlers(): void {
    if (!this.resizeHandle) return;

    this.onRowMouseMove = (e: MouseEvent) => {
      if (!this.isResizing) return;
      const deltaY = e.clientY - this.startY;
      setSpanClass(this.element, deltaToRowSpan(this.startRowSpan, deltaY));
    };

    this.onRowMouseUp = () => {
      if (!this.isResizing) return;
      this.isResizing = false;
      this.element.classList.remove('resizing');
      delete this.element.dataset.resizing;
      document.body.classList.remove('panel-resize-active');
      this.resizeHandle?.classList.remove('active');
      if (this.onRowMouseMove) {
        document.removeEventListener('mousemove', this.onRowMouseMove);
      }
      if (this.onRowMouseUp) {
        document.removeEventListener('mouseup', this.onRowMouseUp);
      }
      if (this.onRowWindowBlur) {
        window.removeEventListener('blur', this.onRowWindowBlur);
      }

      const currentSpan = getRowSpan(this.element);
      savePanelSpan(this.panelId, currentSpan);
      trackPanelResized(this.panelId, currentSpan);
      this.syncKeyboardRowResizeAria();
    };

    this.onRowWindowBlur = () => this.onRowMouseUp?.();

    const onMouseDown = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      this.isResizing = true;
      this.startY = e.clientY;
      this.startRowSpan = getRowSpan(this.element);
      this.element.dataset.resizing = 'true';
      this.element.classList.add('resizing');
      document.body.classList.add('panel-resize-active');
      this.resizeHandle?.classList.add('active');
      if (this.onRowMouseMove) {
        document.addEventListener('mousemove', this.onRowMouseMove);
      }
      if (this.onRowMouseUp) {
        document.addEventListener('mouseup', this.onRowMouseUp);
      }
      if (this.onRowWindowBlur) {
        window.addEventListener('blur', this.onRowWindowBlur);
      }
    };

    this.resizeHandle.addEventListener('mousedown', onMouseDown);

    // Double-click to reset
    this.resizeHandle.addEventListener('dblclick', () => {
      this.resetHeight();
    });

    // Touch support
    this.resizeHandle.addEventListener('touchstart', (e: TouchEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const touch = e.touches[0];
      if (!touch) return;
      this.isResizing = true;
      this.startY = touch.clientY;
      this.startRowSpan = getRowSpan(this.element);
      this.element.classList.add('resizing');
      this.element.dataset.resizing = 'true';
      document.body.classList.add('panel-resize-active');
      this.resizeHandle?.classList.add('active');
      this.removeRowTouchDocumentListeners();
      this.addRowTouchDocumentListeners();
    }, { passive: false });

    // Use bound handlers so they can be removed in destroy()
    this.onTouchMove = (e: TouchEvent) => {
      if (!this.isResizing) return;
      const touch = e.touches[0];
      if (!touch) return;
      const deltaY = touch.clientY - this.startY;
      setSpanClass(this.element, deltaToRowSpan(this.startRowSpan, deltaY));
    };

    this.onTouchEnd = () => {
      if (!this.isResizing) {
        this.removeRowTouchDocumentListeners();
        return;
      }
      this.isResizing = false;
      this.element.classList.remove('resizing');
      delete this.element.dataset.resizing;
      document.body.classList.remove('panel-resize-active');
      this.resizeHandle?.classList.remove('active');
      this.removeRowTouchDocumentListeners();
      const currentSpan = getRowSpan(this.element);
      savePanelSpan(this.panelId, currentSpan);
      trackPanelResized(this.panelId, currentSpan);
      this.syncKeyboardRowResizeAria();
    };
    this.onTouchCancel = this.onTouchEnd;

    this.onDocMouseUp = () => {
      if (this.element?.dataset.resizing) {
        delete this.element.dataset.resizing;
      }
      if (!this.isResizing && !this.isColResizing) {
        document.body?.classList.remove('panel-resize-active');
      }
    };

    document.addEventListener('mouseup', this.onDocMouseUp);
  }

  private addColTouchDocumentListeners(): void {
    if (this.onColTouchMove) {
      document.addEventListener('touchmove', this.onColTouchMove, { passive: false });
    }
    if (this.onColTouchEnd) {
      document.addEventListener('touchend', this.onColTouchEnd);
    }
    if (this.onColTouchCancel) {
      document.addEventListener('touchcancel', this.onColTouchCancel);
    }
  }

  private removeColTouchDocumentListeners(): void {
    if (this.onColTouchMove) {
      document.removeEventListener('touchmove', this.onColTouchMove);
    }
    if (this.onColTouchEnd) {
      document.removeEventListener('touchend', this.onColTouchEnd);
    }
    if (this.onColTouchCancel) {
      document.removeEventListener('touchcancel', this.onColTouchCancel);
    }
  }

  private setupColResizeHandlers(): void {
    if (!this.colResizeHandle) return;

    this.onColMouseMove = (e: MouseEvent) => {
      if (!this.isColResizing) return;
      const deltaX = e.clientX - this.startX;
      const maxSpan = getMaxColSpan(this.element);
      setColSpanClass(this.element, deltaToColSpan(this.startColSpan, deltaX, maxSpan));
    };

    this.onColMouseUp = () => {
      if (!this.isColResizing) return;
      this.isColResizing = false;
      this.element.classList.remove('col-resizing');
      delete this.element.dataset.resizing;
      document.body.classList.remove('panel-resize-active');
      this.colResizeHandle?.classList.remove('active');
      if (this.onColMouseMove) {
        document.removeEventListener('mousemove', this.onColMouseMove);
      }
      if (this.onColMouseUp) {
        document.removeEventListener('mouseup', this.onColMouseUp);
      }
      if (this.onColWindowBlur) {
        window.removeEventListener('blur', this.onColWindowBlur);
      }
      const finalSpan = clampColSpan(getColSpan(this.element), getMaxColSpan(this.element));
      if (finalSpan !== this.startColSpan) {
        persistPanelColSpan(this.panelId, this.element);
      }
      this.syncKeyboardColResizeAria();
    };

    this.onColWindowBlur = () => this.onColMouseUp?.();

    const onMouseDown = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      this.isColResizing = true;
      this.startX = e.clientX;
      this.startColSpan = clampColSpan(getColSpan(this.element), getMaxColSpan(this.element));
      this.element.dataset.resizing = 'true';
      this.element.classList.add('col-resizing');
      document.body.classList.add('panel-resize-active');
      this.colResizeHandle?.classList.add('active');
      if (this.onColMouseMove) {
        document.addEventListener('mousemove', this.onColMouseMove);
      }
      if (this.onColMouseUp) {
        document.addEventListener('mouseup', this.onColMouseUp);
      }
      if (this.onColWindowBlur) {
        window.addEventListener('blur', this.onColWindowBlur);
      }
    };

    this.colResizeHandle.addEventListener('mousedown', onMouseDown);

    // Double-click resets width
    this.colResizeHandle.addEventListener('dblclick', () => this.resetWidth());

    // Touch
    this.colResizeHandle.addEventListener('touchstart', (e: TouchEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const touch = e.touches[0];
      if (!touch) return;
      this.isColResizing = true;
      this.startX = touch.clientX;
      this.startColSpan = clampColSpan(getColSpan(this.element), getMaxColSpan(this.element));
      this.element.dataset.resizing = 'true';
      this.element.classList.add('col-resizing');
      document.body.classList.add('panel-resize-active');
      this.colResizeHandle?.classList.add('active');
      this.removeColTouchDocumentListeners();
      this.addColTouchDocumentListeners();
    }, { passive: false });

    this.onColTouchMove = (e: TouchEvent) => {
      if (!this.isColResizing) return;
      const touch = e.touches[0];
      if (!touch) return;
      const deltaX = touch.clientX - this.startX;
      const maxSpan = getMaxColSpan(this.element);
      setColSpanClass(this.element, deltaToColSpan(this.startColSpan, deltaX, maxSpan));
    };

    this.onColTouchEnd = () => {
      if (!this.isColResizing) {
        this.removeColTouchDocumentListeners();
        return;
      }
      this.isColResizing = false;
      this.element.classList.remove('col-resizing');
      delete this.element.dataset.resizing;
      document.body.classList.remove('panel-resize-active');
      this.colResizeHandle?.classList.remove('active');
      this.removeColTouchDocumentListeners();
      const finalSpan = clampColSpan(getColSpan(this.element), getMaxColSpan(this.element));
      if (finalSpan !== this.startColSpan) {
        persistPanelColSpan(this.panelId, this.element);
      }
      this.syncKeyboardColResizeAria();
    };
    this.onColTouchCancel = this.onColTouchEnd;
  }


  /**
   * `detailTitle` explains a `detail` the badge is too small to justify on its
   * own (e.g. a partial source count). Cleared when absent so a stale
   * explanation can't outlive the detail it described.
   */
  protected setDataBadge(
    state: 'live' | 'cached' | 'unavailable',
    detail?: string,
    detailTitle?: string,
  ): void {
    if (!this.statusBadgeEl) return;
    const labels = {
      live: t('common.live'),
      cached: t('common.cached'),
      unavailable: t('common.unavailable'),
    } as const;
    this.statusBadgeEl.textContent = detail ? `${labels[state]} · ${detail}` : labels[state];
    this.statusBadgeEl.className = `panel-data-badge ${state}`;
    if (detailTitle) {
      this.statusBadgeEl.title = detailTitle;
      this.statusBadgeEl.setAttribute('aria-label', detailTitle);
    } else {
      this.statusBadgeEl.removeAttribute('title');
      this.statusBadgeEl.removeAttribute('aria-label');
    }
    this.statusBadgeEl.style.display = 'inline-flex';
  }

  protected clearDataBadge(): void {
    if (!this.statusBadgeEl) return;
    this.statusBadgeEl.style.display = 'none';
  }

  private updateFreshnessBadge(summary: PanelFreshnessSummary | null = dataFreshness.getPanelFreshness(this.panelId)): void {
    if (!this.freshnessBadgeEl) return;
    if (!summary) {
      this.freshnessBadgeEl.style.display = 'none';
      return;
    }
    const display = formatPanelFreshnessDisplay(summary);
    this.freshnessBadgeEl.textContent = display.label;
    this.freshnessBadgeEl.className = `panel-freshness-badge panel-freshness-${summary.status}`;
    this.freshnessBadgeEl.title = display.title;
    this.freshnessBadgeEl.setAttribute('aria-label', display.ariaLabel);
    this.freshnessBadgeEl.style.display = 'inline-flex';
  }

  protected insertLiveCountBadge(count: number): void {
    const headerLeft = this.header.querySelector('.panel-header-left');
    if (!headerLeft) return;
    const badge = document.createElement('span');
    badge.className = 'panel-live-count';
    badge.textContent = `${count}`;
    headerLeft.appendChild(badge);
  }

  private _applyCollapsed(btn: HTMLButtonElement, collapsed: boolean): void {
    this._collapsed = collapsed;
    this.content.style.display = collapsed ? 'none' : '';
    this.element.classList.toggle('panel-collapsed', collapsed);
    btn.textContent = collapsed ? '▸' : '▾';
    const label = collapsed
      ? (t('components.panel.expandPanel') ?? 'Expand')
      : (t('components.panel.collapsePanel') ?? 'Collapse');
    btn.setAttribute('aria-expanded', String(!collapsed));
    btn.setAttribute('aria-label', label);
    btn.title = label;
  }

  /** True when this panel exposes the same collapse control a person uses. */
  public supportsCollapse(): boolean {
    return this._collapseBtn !== null;
  }

  public isCollapsed(): boolean {
    return this._collapsed;
  }

  /**
   * Apply collapse/expand through the visible control path and persist it.
   * Persist first so a quota/private-mode failure leaves the live DOM unchanged.
   */
  public setCollapsed(collapsed: boolean): { ok: boolean; persisted: boolean } {
    if (!this._collapseBtn) return { ok: false, persisted: true };
    if (this._collapsed === collapsed) return { ok: true, persisted: true };
    if (!savePanelCollapsed(this.panelId, collapsed)) {
      return { ok: false, persisted: false };
    }
    this._applyCollapsed(this._collapseBtn, collapsed);
    return { ok: true, persisted: true };
  }

  /** Override in panels that expose a fullscreen control. */
  public supportsFullscreen(): boolean {
    return false;
  }

  public isFullscreenActive(): boolean {
    return false;
  }

  /** Apply fullscreen through the visible control path. Default: unsupported. */
  public setFullscreen(_fullscreen: boolean): boolean {
    return false;
  }

  protected appendCollapseButton(): void {
    const btn = h('button', {
      className: 'icon-btn panel-collapse-btn',
      'aria-label': t('components.panel.collapsePanel') ?? 'Collapse',
      'aria-expanded': 'true',
      title: t('components.panel.collapsePanel') ?? 'Collapse',
    }, '▾') as HTMLButtonElement;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setCollapsed(!this._collapsed);
    });
    this._collapseBtn = btn;
    this.header.appendChild(btn);
  }

  protected appendCloseButton(): void {
    const closeBtn = h('button', {
      className: 'icon-btn panel-close-btn',
      'aria-label': t('components.panel.closePanel'),
      title: t('components.panel.closePanel'),
    }, '\u2715');
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.element.dispatchEvent(new CustomEvent('wm:panel-close', {
        bubbles: true,
        detail: { panelId: this.panelId },
      }));
    });
    this.header.appendChild(closeBtn);
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  /**
   * True when this panel can host live media right now: attached, enabled (not hidden via the
   * disable path), and expanded (not collapsed). The play-all cascade gates on this so a
   * collapsed or disabled panel never creates/queues media work inside a hidden content area.
   */
  public canHostLiveMedia(): boolean {
    return this.element.isConnected
      && !this.element.classList.contains('hidden')
      && !this._collapsed;
  }

  protected runWhenConnected(callback: () => void): boolean {
    if (this.destroyed) return false;
    if (this.element.isConnected) {
      callback();
      return true;
    }

    this.connectedCallbacks.push(callback);
    this.scheduleConnectedFallbackIfNeeded();
    return false;
  }

  public notifyConnected(): void {
    this.flushConnectedCallbacks();
  }

  private scheduleConnectedFallbackIfNeeded(): void {
    // Modern dashboard mounts call notifyConnected() from panel-layout. The timer is
    // only for old/no-MutationObserver environments where that signal may not exist.
    if (this.connectedFallbackTimer !== null || typeof MutationObserver !== 'undefined') return;
    this.connectedFallbackTimer = globalThis.setTimeout(() => {
      this.connectedFallbackTimer = null;
      if (this.destroyed || this.connectedCallbacks.length === 0) return;
      if (this.element.isConnected) {
        this.flushConnectedCallbacks();
        return;
      }
      this.scheduleConnectedFallbackIfNeeded();
    }, 50);
  }

  private flushConnectedCallbacks(): void {
    if (this.destroyed || !this.element.isConnected || this.connectedCallbacks.length === 0) return;
    const callbacks = this.connectedCallbacks.splice(0);
    if (this.connectedFallbackTimer !== null) {
      clearTimeout(this.connectedFallbackTimer);
      this.connectedFallbackTimer = null;
    }

    const errors: unknown[] = [];
    for (const cb of callbacks) {
      try {
        cb();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) {
      globalThis.setTimeout(() => { throw errors[0]; }, 0);
    } else if (errors.length > 1) {
      const error = new Error('Panel connected callbacks failed') as Error & { errors?: unknown[] };
      error.errors = errors;
      globalThis.setTimeout(() => { throw error; }, 0);
    }
  }

  /**
   * Fire `callback` once when this panel's element scrolls within
   * `marginPx` of the viewport. Uses IntersectionObserver where
   * available; falls back to an idle-callback tick when not (Node/SSR
   * or very old browsers). Idempotent — repeat calls are ignored
   * once an observation is registered. Disconnected automatically on
   * destroy() and on first firing (loadAllData is idempotent and the
   * refresh scheduler owns repeat fetches, so re-firing is wasted
   * work). (#3990)
   */
  public observeNearViewport(callback: () => void, marginPx = 200): void {
    if (this.viewportObserverRegistered) return;
    if (typeof IntersectionObserver === 'undefined' || typeof window === 'undefined') {
      this.viewportObserverRegistered = true;
      const tick = (): void => {
        if (this.element.isConnected) callback();
      };
      // typeof window === 'undefined' takes the fallback branch alone (no IO + no
      // window), so the requestIdleCallback lookup must be gated separately —
      // dereferencing `window` here without that guard would ReferenceError in
      // pure Node/SSR. Greptile #4001/P1.
      const ric = typeof window !== 'undefined'
        ? (window as unknown as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback
        : undefined;
      if (typeof ric === 'function') ric(tick);
      else setTimeout(tick, 0);
      return;
    }
    this.viewportObserverRegistered = true;
    this.viewportObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          this.unobserveViewport();
          callback();
          return;
        }
      }
    }, { rootMargin: `${marginPx}px` });
    this.viewportObserver.observe(this.element);
  }

  private unobserveViewport(): void {
    if (this.viewportObserver) {
      this.viewportObserver.disconnect();
      this.viewportObserver = null;
    }
  }

  public isNearViewport(marginPx = 400): boolean {
    if (!this.element.isConnected) return false;
    if (typeof window === 'undefined') return true;

    const style = window.getComputedStyle(this.element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;

    const rect = this.element.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;

    if (rect.width === 0 || rect.height === 0) return false;

    return (
      rect.bottom >= -marginPx &&
      rect.right >= -marginPx &&
      rect.top <= viewportHeight + marginPx &&
      rect.left <= viewportWidth + marginPx
    );
  }

  public showLoading(message = t('common.loading')): void {
    if (this._locked) return;
    this.setErrorState(false);
    this.clearRetryCountdown();
    this.replaceContent(
      h('div', { className: 'panel-loading' },
        h('div', { className: 'panel-loading-radar' },
          h('div', { className: 'panel-radar-sweep' }),
          h('div', { className: 'panel-radar-dot' }),
        ),
        h('div', { className: 'panel-loading-text' }, message),
      ),
    );
  }

  public showError(message?: string, onRetry?: () => void, autoRetrySeconds?: number): void {
    if (this._locked) return;
    this.clearRetryCountdown();
    this.setErrorState(true);
    if (onRetry !== undefined) this.retryCallback = onRetry;

    const radarEl = h('div', { className: 'panel-loading-radar panel-error-radar' },
      h('div', { className: 'panel-radar-sweep' }),
      h('div', { className: 'panel-radar-dot error' }),
    );

    const msgEl = h('div', { className: 'panel-error-msg' }, message || t('common.failedToLoad'));

    const children: (HTMLElement | string)[] = [radarEl, msgEl];

    if (this.retryCallback) {
      const backoffSeconds = autoRetrySeconds ?? Math.min(15 * 2 ** this.retryAttempt, 180);
      this.retryAttempt++;
      let remaining = Math.round(backoffSeconds);
      const countdownEl = h('div', { className: 'panel-error-countdown' },
        `${t('common.retrying')} (${remaining}s)`,
      );
      children.push(countdownEl);
      this.retryCountdownTimer = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
          this.clearRetryCountdown();
          this.retryCallback?.();
          return;
        }
        countdownEl.textContent = `${t('common.retrying')} (${remaining}s)`;
      }, 1000);
    }
    this.replaceContent(h('div', { className: 'panel-error-state' }, ...children));
  }

  public resetRetryBackoff(): void {
    this.retryAttempt = 0;
  }

  /**
   * Run a content write WITHOUT crediting the upstream with a recovery
   * (#6679). The setContent* helpers clear the whole error state — chip,
   * countdown, AND the exponential-backoff rung — because a success render
   * normally proves the upstream recovered. Replaying a cache while the live
   * fetch still fails proves no such thing. Wrapping that write here keeps the
   * visible clears while the still-failing upstream keeps its rung instead of
   * dropping back to the 15s floor. Callers must know from the result's
   * provenance that the write is non-authoritative; an empty payload alone is
   * not enough. Safe to nest; the setContent* clear is synchronous, so the
   * restore cannot race a debounced write.
   */
  protected withRetryBackoffPreserved(write: () => void): void {
    const rung = this.retryAttempt;
    write();
    this.retryAttempt = rung;
  }

  /**
   * Drop the error badge, the pending auto-retry countdown, and the backoff.
   * The single owner of "this panel has recovered": `setContentHtml`,
   * `setContentNodes` and `setTrustedContent` all clear through here, so the
   * three pieces of state can never be cleared apart. Without it, a showError()
   * countdown scheduled before a successful load keeps ticking and fires one
   * redundant refresh after the panel has already recovered.
   *
   * Public because a panel may recover without replacing its content (an
   * in-place row patch); a panel that DOES replace content should use the
   * `setContent*` helpers instead, which clear as part of the write.
   */
  public clearErrorState(): void {
    this.setErrorState(false);
    this.clearRetryCountdown();
    this.retryAttempt = 0;
  }

  public showLocked(features: string[] = []): void {
    this._locked = true;
    this.clearRetryCountdown();
    this._snapshotContentForRestore();

    for (let child = this.header.nextElementSibling; child && child !== this.content; child = child.nextElementSibling) {
      (child as HTMLElement).style.display = 'none';
    }
    this.element.classList.add('panel-is-locked');

    const iconEl = h('div', { className: 'panel-locked-icon' });
    setTrustedHtml(iconEl, trustedHtml(lockSvg, 'legacy direct innerHTML migration'));

    const lockedChildren: (HTMLElement | string)[] = [
      iconEl,
      h('div', { className: 'panel-locked-desc' }, t('premium.lockedDesc')),
    ];

    if (features.length > 0) {
      const featureList = h('ul', { className: 'panel-locked-features' });
      for (const feat of features) {
        featureList.appendChild(h('li', {}, feat));
      }
      lockedChildren.push(featureList);
    }

    // Assent immediately above the CTA (#6976). This button jumps straight to
    // Dodo's hosted checkout, where Dodo (merchant of record) shows its terms
    // and never ours — so ours are presented here, before the jump. The desktop
    // branch below opens the /pro pricing page in the OS browser instead, and
    // that page carries its own assent line above every tier CTA.
    if (!isDesktopRuntime()) lockedChildren.push(createCheckoutConsentElement(WEB_APP_ORIGIN));
    const ctaBtn = h('button', { type: 'button', className: 'panel-locked-cta' }, 'Upgrade to Pro');
    if (isDesktopRuntime()) {
      ctaBtn.addEventListener('click', () => {
        void openExternalUrl('https://worldmonitor.app/pro');
      });
    } else {
      ctaBtn.addEventListener('click', () => {
        import('@/services/checkout').then(m => import('@/config/products').then(p => m.startCheckout(p.DEFAULT_UPGRADE_PRODUCT))).catch(() => {
          window.open('https://worldmonitor.app/pro', '_blank', 'noopener,noreferrer');
        });
      });
    }
    lockedChildren.push(ctaBtn);

    this.replaceContent(h('div', { className: 'panel-locked-state' }, ...lockedChildren));
  }

  /**
   * CTA copy per gate reason, resolved lazily so each call translates only
   * the two strings it renders. #4771 billing-aware states: the user has
   * (or had) paid evidence, so the CTA must never read as a fresh upsell
   * (duplicate-checkout risk). Their keys live under components.billingState
   * (NOT premium.*): premium. is a first-paint shell namespace and these
   * CTAs only render after the Convex entitlement round-trip, well past
   * full-locale load.
   */
  private static gatedCtaEntry(
    reason: PanelGateReason,
  ): { icon: string; desc: string; cta: string } | null {
    switch (reason) {
      case PanelGateReason.ANONYMOUS:
        return {
          icon: lockSvg,
          desc: t('premium.signInToUnlock'),
          cta: t('premium.signIn'),
        };
      case PanelGateReason.FREE_TIER:
        return {
          icon: upgradeSvg,
          desc: t('premium.upgradeDesc'),
          cta: t('premium.upgradeToPro'),
        };
      case PanelGateReason.PAYMENT_ON_HOLD:
        return {
          icon: lockSvg,
          desc: t('components.billingState.onHoldDesc'),
          cta: t('components.billingState.updatePayment'),
        };
      case PanelGateReason.RENEWAL_PENDING:
        return {
          icon: lockSvg,
          desc: t('components.billingState.renewalPendingDesc'),
          cta: t('components.billingState.refreshStatus'),
        };
      case PanelGateReason.RENEWAL_FAILED:
        return {
          icon: lockSvg,
          desc: t('components.billingState.renewalFailedDesc'),
          cta: t('components.billingState.manageBilling'),
        };
      case PanelGateReason.LAPSED:
        return {
          icon: upgradeSvg,
          desc: t('components.billingState.lapsedDesc'),
          cta: t('components.billingState.resubscribe'),
        };
      default:
        return null;
    }
  }

  public showGatedCta(reason: PanelGateReason, onAction: () => void): void {
    const entry = Panel.gatedCtaEntry(reason);
    if (!entry) return; // PanelGateReason.NONE should never reach here

    // Same verdict already rendered — skip the DOM teardown/rebuild.
    // Gating re-runs on every subscription-row change (#4771), including
    // Convex updates to fields irrelevant to the gate verdict.
    if (this._locked && this._lastGateReason === reason) return;
    this._lastGateReason = reason;

    // Bail-out done — now commit to the locked state. Doing this AFTER the
    // guard avoids a half-locked DOM (header siblings hidden, panel-is-locked
    // class set, _savedContent populated) on the acknowledged-impossible
    // NONE-reason path. PR #3814 review (Greptile P2).
    this._locked = true;
    this.clearRetryCountdown();
    this._snapshotContentForRestore();

    // Hide elements between header and content (same as showLocked)
    for (let child = this.header.nextElementSibling; child && child !== this.content; child = child.nextElementSibling) {
      (child as HTMLElement).style.display = 'none';
    }
    this.element.classList.add('panel-is-locked');

    const iconEl = h('div', { className: 'panel-locked-icon' });
    setTrustedHtml(iconEl, trustedHtml(entry.icon, 'legacy direct innerHTML migration'));

    const descEl = h('div', { className: 'panel-locked-desc' }, entry.desc);

    const ctaBtn = h('button', { type: 'button', className: 'panel-locked-cta' }, entry.cta);
    ctaBtn.addEventListener('click', onAction);

    this.replaceContent(h('div', { className: 'panel-locked-state' }, iconEl, descEl, ctaBtn));
  }

  public unlockPanel(): void {
    if (!this._locked) return;
    this._locked = false;
    this._lastGateReason = null;
    this.element.classList.remove('panel-is-locked');
    // Re-show hidden elements
    for (let child = this.header.nextElementSibling; child && child !== this.content; child = child.nextElementSibling) {
      (child as HTMLElement).style.display = '';
    }
    // Restore the pre-lock content if we have it. The saved nodes are the
    // ORIGINAL DOM nodes the subclass built — reattaching preserves event
    // listeners and any references the subclass holds (this.inputEl etc.),
    // and fixes constructor-only subclasses (DeductionPanel,
    // ChatAnalystPanel, …) that would otherwise end up with an empty body.
    // Fall back to the legacy empty-content behaviour if nothing was saved.
    if (this._savedContent !== null) {
      this.replaceContent(...this._savedContent);
      this._savedContent = null;
    } else {
      this.replaceContent();
    }
  }

  /**
   * Remove sensitive panel payloads from both the visible DOM and the
   * pre-lock restoration snapshot. Pro panels call this on sign-out or
   * downgrade so unlockPanel() cannot resurrect data captured before the
   * entitlement changed.
   */
  protected clearSensitiveContent(): void {
    this._savedContent = null;
    this.cancelPendingContentWrite();
    if (!this._locked) this.replaceContent();
  }

  /**
   * Drop a debounced `setContentHtml` write that has not committed yet.
   *
   * Any write that lands the content immediately must call this first: the
   * queued string commits `contentDebounceMs` later regardless, so without it a
   * `setSafeContent(old)` still in flight overwrites the render that just
   * replaced it — 150ms after the panel already looked correct.
   */
  private cancelPendingContentWrite(): void {
    this.pendingContentHtml = null;
    this.pendingContentCallback = null;
    if (this.contentDebounceTimer) {
      clearTimeout(this.contentDebounceTimer);
      this.contentDebounceTimer = null;
    }
  }

  // Capture this.content's current child nodes so unlockPanel can put them
  // back. Only snapshots on the FIRST transition into a lock state — a
  // re-entrant showLocked / showGatedCta must not overwrite the cache with
  // the locked-state CTA. The cache is cleared by unlockPanel on restore.
  private _snapshotContentForRestore(): void {
    if (this._savedContent !== null) return;
    this._savedContent = Array.from(this.content.childNodes);
  }

  public showRetrying(message?: string, countdownSeconds?: number): void {
    if (this._locked) return;
    this.clearRetryCountdown();
    this.setErrorState(true);

    const radarEl = h('div', { className: 'panel-loading-radar panel-error-radar' },
      h('div', { className: 'panel-radar-sweep' }),
      h('div', { className: 'panel-radar-dot error' }),
    );

    const msgEl = h('div', { className: 'panel-error-msg' }, message || t('common.retrying'));
    const children: (HTMLElement | string)[] = [radarEl, msgEl];

    if (countdownSeconds && countdownSeconds > 0) {
      let remaining = countdownSeconds;
      const countdownEl = h('div', { className: 'panel-error-countdown' },
        `${t('common.retrying')} (${remaining}s)`,
      );
      children.push(countdownEl);
      this.retryCountdownTimer = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
          this.clearRetryCountdown();
          countdownEl.textContent = t('common.retrying');
          return;
        }
        countdownEl.textContent = `${t('common.retrying')} (${remaining}s)`;
      }, 1000);
    }

    this.replaceContent(
      h('div', { className: 'panel-error-state' }, ...children),
    );
  }

  private clearRetryCountdown(): void {
    if (this.retryCountdownTimer) {
      clearInterval(this.retryCountdownTimer);
      this.retryCountdownTimer = null;
    }
  }

  protected setRetryCallback(fn: (() => void) | null): void {
    this.retryCallback = fn;
  }

  protected setFetching(v: boolean): void {
    this._fetching = v;
    const btn = this.content.querySelector<HTMLButtonElement>('[data-panel-retry]');
    if (btn) btn.disabled = v;
  }

  protected get isFetching(): boolean {
    return this._fetching;
  }

  public showConfigError(message: string): void {
    const msgEl = h('div', { className: 'config-error-message' }, message);
    if (isDesktopRuntime()) {
      msgEl.appendChild(
        h('button', {
          type: 'button',
          className: 'config-error-settings-btn',
          onClick: () => void invokeTauri<void>('open_settings_window_command').catch(() => { }),
        }, t('components.panel.openSettings')),
      );
    }
    this.replaceContent(msgEl);
  }

  public setCount(count: number): void {
    if (this.countEl) {
      const prev = parseInt(this.countEl.textContent ?? '0', 10);
      this.countEl.textContent = count.toString();
      if (count > prev && getAiFlowSettings().badgeAnimation) {
        this.countEl.classList.remove('bump');
        void this.countEl.offsetWidth;
        this.countEl.classList.add('bump');
      }
    }
  }

  public setErrorState(hasError: boolean, tooltip?: string): void {
    this.header.classList.toggle('panel-header-error', hasError);
    if (tooltip) {
      this.header.title = tooltip;
    } else {
      this.header.removeAttribute('title');
    }
  }

  /**
   * The raw content primitive. It deliberately does NOT touch the error state:
   * `showError` / `showRetrying` set the badge and then paint through here, so
   * a clear inside this method would erase the state its own callers just set.
   *
   * Every such write invalidates `lastCommittedHtml`, so routing them through
   * here makes that invariant structural instead of something each new call site
   * has to remember. Do not call `replaceChildren(this.content, …)` directly —
   * for a SUCCESSFUL render use `setContentNodes` / `setTrustedContent`, which
   * add the error-state clear this method must not do.
   */
  private replaceContent(...children: DomChild[]): void {
    // Structural, for the same reason `invalidateCommittedHtml` is: EVERY
    // immediate write must drop a queued one, and `showError` / `showRetrying` /
    // `showLoading` / `showLocked` / `showGatedCta` / `showConfigError` /
    // `unlockPanel` all land content through here. Without it a `setSafeContent`
    // queued moments earlier commits `contentDebounceMs` later and paints over
    // the render that just replaced it — under a chip nothing then clears, which
    // is #6557 reached from the other direction.
    //
    // This does not self-cancel the debounce: `setContentImmediate` writes via
    // `setTrustedHtml` and never routes through here.
    this.cancelPendingContentWrite();
    replaceChildren(this.content, ...children);
    this.invalidateCommittedHtml();
  }

  /**
   * The content dirty-check is only sound while EVERY writer invalidates it, so
   * it lives in one method rather than being repeated at each write path.
   */
  private invalidateCommittedHtml(): void {
    this.lastCommittedHtml = null;
  }

  /**
   * Commit a render as the panel's authoritative content — the `setSafeContent`
   * of the DOM-node path, and a true twin of it: same lock bail, same
   * error-state clear.
   *
   * `setContentHtml` drops the error badge, the pending auto-retry countdown and
   * the backoff on every such write. A panel that calls
   * `replaceChildren(this.content, …)` itself skips all three, so one transient
   * `showError()` latches the red `Error` chip over correct data for the rest of
   * the session and leaves a countdown ticking toward a redundant refresh
   * (#6557: `cii` and `strategic-risk` in production).
   *
   * "Authoritative content" covers a settled empty/unavailable state as well as
   * a recovery — both mean "this, not an error state". It does NOT cover a
   * loading render: `showLoading` deliberately leaves `retryAttempt` alone, and
   * resetting the backoff on every loading paint would flatten it to its floor.
   */
  protected setContentNodes(...children: DomChild[]): void {
    // #6714: the error-state clear runs BEFORE the lock bail. Clearing the
    // chip and the backoff rung paints nothing, so it cannot reopen the
    // paywall hole the bail exists to close — but bailing first meant a
    // locked panel's success render cleared neither, leaving a red header
    // over the lock CTA and a stale retryAttempt rung after unlock.
    this.clearErrorState();
    if (this._locked) return;
    this.cancelPendingContentWrite();
    this.replaceContent(...children);
  }

  /**
   * Trusted-HTML twin of `setContentNodes`, for panels that build their own
   * markup string and cannot go through the debounced `setSafeContent` path.
   */
  protected setTrustedContent(html: TrustedHtml): void {
    // #6714: clear error state before the lock bail — see setContentNodes.
    this.clearErrorState();
    if (this._locked) return;
    this.cancelPendingContentWrite();
    setTrustedHtml(this.content, html);
    this.invalidateCommittedHtml();
  }

  public setSafeContent(html: SafeHtml, afterUpdate?: () => void): void {
    this.setContentHtml(safeHtmlToString(html), afterUpdate);
  }

  private setContentHtml(html: string, afterUpdate?: () => void): void {
    // #6714: clear error state before the lock bail — see setContentNodes.
    this.clearErrorState();
    if (this._locked) return;
    if (this.pendingContentHtml === html) {
      if (afterUpdate) this.pendingContentCallback = afterUpdate;
      return;
    }
    if (this.lastCommittedHtml === html) {
      // The DOM already shows `html`, but a DIFFERENT write may still be queued
      // behind the debounce — and returning without cancelling it lets that
      // stale write land afterwards, permanently. World Clock reproduces it:
      // open settings, then close within the debounce window, and the settings
      // markup commits after the clock has been asked to come back (which also
      // strands the cached row handles, so the clock stops ticking).
      this.cancelPendingContentWrite();
      afterUpdate?.();
      return;
    }

    this.pendingContentHtml = html;
    this.pendingContentCallback = afterUpdate ?? null;
    if (this.contentDebounceTimer) {
      clearTimeout(this.contentDebounceTimer);
    }

    this.contentDebounceTimer = setTimeout(() => {
      if (this.pendingContentHtml !== null) {
        this.setContentImmediate(this.pendingContentHtml);
      }
    }, this.contentDebounceMs);
  }

  private setContentImmediate(html: string): void {
    // The lock is re-checked HERE, not only at schedule time in `setContentHtml`.
    // A panel locked during the debounce window (showGatedCta / showLocked fire
    // from the async entitlement pass) would otherwise have this timer paint the
    // premium payload over the upgrade CTA, and no later writer repaints it
    // because every other write path bails on `_locked`.
    if (this._locked) {
      this.cancelPendingContentWrite();
      return;
    }
    if (this.contentDebounceTimer) {
      clearTimeout(this.contentDebounceTimer);
      this.contentDebounceTimer = null;
    }

    this.pendingContentHtml = null;
    const afterUpdate = this.pendingContentCallback;
    this.pendingContentCallback = null;
    if (this.lastCommittedHtml !== html) {
      setTrustedHtml(this.content, trustedHtml(html, 'legacy direct innerHTML migration'));
      this.lastCommittedHtml = html;
    }
    afterUpdate?.();
  }

  public show(): void {
    this.element.classList.remove('hidden');
  }

  public hide(): void {
    this.element.classList.add('hidden');
  }

  public toggle(visible: boolean): void {
    if (visible) this.show();
    else this.hide();
  }

  /**
   * Update the "new items" badge
   * @param count Number of new items (0 hides badge)
   * @param pulse Whether to pulse the badge (for important updates)
   */
  public setNewBadge(count: number, pulse = false): void {
    if (!this.newBadgeEl) return;

    if (count <= 0) {
      this.newBadgeEl.style.display = 'none';
      this.newBadgeEl.classList.remove('pulse');
      this.element.classList.remove('has-new');
      return;
    }

    this.newBadgeEl.textContent = count > 99 ? '99+' : `${count} ${t('common.new')}`;
    this.newBadgeEl.style.display = 'inline-flex';
    this.element.classList.add('has-new');

    if (pulse) {
      this.newBadgeEl.classList.add('pulse');
    } else {
      this.newBadgeEl.classList.remove('pulse');
    }
  }

  /**
   * Clear the new items badge
   */
  public clearNewBadge(): void {
    this.setNewBadge(0);
  }

  /**
   * Set the panel's severity level, controlling the header pulse dot speed.
   * critical = 0.6s, high = 1s, medium = 1.8s, low = 2.5s, none = hidden.
   */
  public setSeverity(level: PanelSeverity): void {
    if (level === this.currentSeverity) return;
    this.currentSeverity = level;
    if (!this.severityDotEl) return;
    this.severityDotEl.className = 'panel-severity-dot';
    if (level !== 'none') {
      this.severityDotEl.classList.add(`severity-${level}`);
      // Severity was color+animation only (and aria-hidden), i.e. absent from
      // the accessibility tree entirely; expose it as a named image.
      this.severityDotEl.removeAttribute('aria-hidden');
      this.severityDotEl.setAttribute('role', 'img');
      this.severityDotEl.setAttribute('aria-label', `${level} severity`);
    } else {
      this.severityDotEl.setAttribute('aria-hidden', 'true');
      this.severityDotEl.removeAttribute('role');
      this.severityDotEl.removeAttribute('aria-label');
    }
  }

  /**
   * Get the panel ID
   */
  public getId(): string {
    return this.panelId;
  }

  /**
   * Reset panel height to default
   */
  public resetHeight(): void {
    this.element.classList.remove('resized', 'span-1', 'span-2', 'span-3', 'span-4');
    clearPanelSpan(this.panelId);
    this.syncKeyboardRowResizeAria();
  }

  public resetWidth(): void {
    clearColSpanClass(this.element);
    clearPanelColSpan(this.panelId);
    this.syncKeyboardColResizeAria();
  }

  protected get signal(): AbortSignal {
    return this.abortController.signal;
  }

  protected isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'AbortError';
  }

  public destroy(): void {
    this.destroyed = true;
    this.abortController.abort();
    this.clearRetryCountdown();
    this.unobserveViewport();
    if (this.connectedFallbackTimer !== null) {
      clearTimeout(this.connectedFallbackTimer);
      this.connectedFallbackTimer = null;
    }
    this.connectedCallbacks = [];
    if (this.freshnessUnsubscribe) {
      this.freshnessUnsubscribe();
      this.freshnessUnsubscribe = null;
    }
    if (this.freshnessRefreshTimer) {
      clearInterval(this.freshnessRefreshTimer);
      this.freshnessRefreshTimer = null;
    }
    if (this.colSpanReconcileRaf !== null) {
      cancelAnimationFrame(this.colSpanReconcileRaf);
      this.colSpanReconcileRaf = null;
    }
    if (this.contentDebounceTimer) {
      clearTimeout(this.contentDebounceTimer);
      this.contentDebounceTimer = null;
    }
    this.pendingContentHtml = null;
    this.pendingContentCallback = null;
    // Drop the snapshot of pre-lock children so a panel destroyed while
    // still in the locked state doesn't retain the detached DOM subtree
    // for the lifetime of the Panel instance. PR #3814 review (Greptile P2).
    this._savedContent = null;

    if (this.tooltipCloseHandler) {
      document.removeEventListener('click', this.tooltipCloseHandler);
      this.tooltipCloseHandler = null;
    }
    this.removeRowTouchDocumentListeners();
    if (this.onTouchMove) {
      this.onTouchMove = null;
    }
    if (this.onTouchEnd) {
      this.onTouchEnd = null;
    }
    if (this.onTouchCancel) {
      this.onTouchCancel = null;
    }
    if (this.onDocMouseUp) {
      document.removeEventListener('mouseup', this.onDocMouseUp);
      this.onDocMouseUp = null;
    }
    if (this.onRowMouseMove) {
      document.removeEventListener('mousemove', this.onRowMouseMove);
      this.onRowMouseMove = null;
    }
    if (this.onRowMouseUp) {
      document.removeEventListener('mouseup', this.onRowMouseUp);
      this.onRowMouseUp = null;
    }
    if (this.onRowWindowBlur) {
      window.removeEventListener('blur', this.onRowWindowBlur);
      this.onRowWindowBlur = null;
    }
    if (this.onColMouseMove) {
      document.removeEventListener('mousemove', this.onColMouseMove);
      this.onColMouseMove = null;
    }
    if (this.onColMouseUp) {
      document.removeEventListener('mouseup', this.onColMouseUp);
      this.onColMouseUp = null;
    }
    if (this.onColWindowBlur) {
      window.removeEventListener('blur', this.onColWindowBlur);
      this.onColWindowBlur = null;
    }
    this.removeColTouchDocumentListeners();
    if (this.onColTouchMove) {
      this.onColTouchMove = null;
    }
    if (this.onColTouchEnd) {
      this.onColTouchEnd = null;
    }
    if (this.onColTouchCancel) {
      this.onColTouchCancel = null;
    }
    this.element.classList.remove('resizing', 'col-resizing');
    delete this.element.dataset.resizing;
    document.body.classList.remove('panel-resize-active');
  }
}
