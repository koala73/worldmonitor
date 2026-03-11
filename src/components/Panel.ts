import { isDesktopRuntime } from '../services/runtime';
import { invokeTauri } from '../services/tauri-bridge';
import { t } from '../services/i18n';
import { h, replaceChildren, safeHtml } from '../utils/dom-utils';
import { trackPanelResized } from '@/services/analytics';
import { getAiFlowSettings } from '@/services/ai-flow-settings';
import { getSecretState } from '@/services/runtime-config';

export interface PanelOptions {
  id: string;
  title: string;
  showCount?: boolean;
  className?: string;
  trackActivity?: boolean;
  infoTooltip?: string;
  premium?: 'locked' | 'enhanced';
}

import {
  savePanelSpan,
  loadPanelSpans,
  loadPanelColSpans,
  clearPanelColSpan,
  getDefaultColSpan,
  getColSpan,
  getMaxColSpan,
  clampColSpan,
  persistPanelColSpan,
  setColSpanClass,
  clearColSpanClass,
  getRowSpan,
  setSpanClass,
  PANEL_SPANS_KEY,
} from '../utils/resize-utils';

export class Panel {
  protected element: HTMLElement;
  protected content: HTMLElement;
  protected header: HTMLElement;
  protected countEl: HTMLElement | null = null;
  protected statusBadgeEl: HTMLElement | null = null;
  protected newBadgeEl: HTMLElement | null = null;
  protected panelId: string;
  private abortController: AbortController = new AbortController();
  private tooltipCloseHandler: (() => void) | null = null;
  private resizeHandle: HTMLElement | null = null;
  private colResizeHandle: HTMLElement | null = null;
  private resizeHandler: import('../utils/resize-handler').ResizeHandler | null = null;
  private colResizeHandler: import('../utils/resize-handler').ResizeHandler | null = null;
  private onDocMouseUp: (() => void) | null = null;
  private colSpanReconcileRaf: number | null = null;
  private readonly contentDebounceMs = 150;
  private pendingContentHtml: string | null = null;
  private contentDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryCallback: (() => void) | null = null;
  private retryCountdownTimer: ReturnType<typeof setInterval> | null = null;
  private retryAttempt = 0;
  private _fetching = false;
  private _locked = false;

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
    headerLeft.appendChild(title);

    if (options.infoTooltip) {
      const infoBtn = h('button', { className: 'panel-info-btn', 'aria-label': t('components.panel.showMethodologyInfo') }, '?');

      const tooltip = h('div', { className: 'panel-info-tooltip' });
      tooltip.appendChild(safeHtml(options.infoTooltip));

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

    if (isDesktopRuntime() && options.premium === 'enhanced' && !getSecretState('WORLDMONITOR_API_KEY').present) {
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

    this.content = document.createElement('div');
    this.content.className = 'panel-content';
    this.content.id = `${options.id}Content`;

    this.element.appendChild(this.header);
    this.element.appendChild(this.content);

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

    // Right-edge handle for width resizing
    this.colResizeHandle = document.createElement('div');
    this.colResizeHandle.className = 'panel-col-resize-handle';
    this.colResizeHandle.title = t('components.panel.dragToResize');
    this.element.appendChild(this.colResizeHandle);

    this.setupResizeHandlers();

    // Restore saved span
    const savedSpans = loadPanelSpans();
    const savedSpan = savedSpans[this.panelId];
    if (savedSpan && savedSpan > 1) {
      setSpanClass(this.element, savedSpan);
    }

    // Restore saved col-span
    this.restoreSavedColSpan();
    this.reconcileColSpanAfterAttach();

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
      if (!this.element.isConnected || !this.element.parentElement) {
        if (remaining <= 0) return;
        this.colSpanReconcileRaf = requestAnimationFrame(() => tryReconcile(remaining - 1));
        return;
      }
      this.colSpanReconcileRaf = null;
      this.restoreSavedColSpan();
    };

    tryReconcile(attempts);
  }

  private setupResizeHandlers(): void {
    import('../utils/resize-handler').then(({ ResizeHandler }) => {
      if (this.resizeHandle) {
        this.resizeHandler = new ResizeHandler({
          id: this.panelId,
          element: this.element,
          handle: this.resizeHandle,
          type: 'row',
          getStartSpan: () => getRowSpan(this.element),
          setSpanClass: (span) => setSpanClass(this.element, span),
          onResizeEnd: (span) => {
            savePanelSpan(this.panelId, span);
            trackPanelResized(this.panelId, span);
          }
        });

        // Double-click to reset height
        this.resizeHandle.addEventListener('dblclick', () => this.resetHeight());
      }

      if (this.colResizeHandle) {
        this.colResizeHandler = new ResizeHandler({
          id: this.panelId,
          element: this.element,
          handle: this.colResizeHandle,
          type: 'col',
          getStartSpan: () => clampColSpan(getColSpan(this.element), getMaxColSpan(this.element)),
          setSpanClass: (span) => setColSpanClass(this.element, span),
          maxSpan: 3,
          onResizeEnd: () => {
            persistPanelColSpan(this.panelId, this.element);
          }
        });

        // Double-click to reset width
        this.colResizeHandle.addEventListener('dblclick', () => this.resetWidth());
      }
    });

    this.onDocMouseUp = () => {
      if (this.element?.dataset.resizing) {
        delete this.element.dataset.resizing;
      }
      document.body?.classList.remove('panel-resize-active');
    };
    document.addEventListener('mouseup', this.onDocMouseUp);
  }

  protected setDataBadge(state: 'live' | 'cached' | 'unavailable', detail?: string): void {
    if (!this.statusBadgeEl) return;
    const labels = {
      live: t('common.live'),
      cached: t('common.cached'),
      unavailable: t('common.unavailable'),
    } as const;
    this.statusBadgeEl.textContent = detail ? `${labels[state]} · ${detail}` : labels[state];
    this.statusBadgeEl.className = `panel-data-badge ${state}`;
    this.statusBadgeEl.style.display = 'inline-flex';
  }

  protected clearDataBadge(): void {
    if (!this.statusBadgeEl) return;
    this.statusBadgeEl.style.display = 'none';
  }

  protected insertLiveCountBadge(count: number): void {
    const headerLeft = this.header.querySelector('.panel-header-left');
    if (!headerLeft) return;
    const badge = document.createElement('span');
    badge.className = 'panel-live-count';
    badge.textContent = `${count} live`;
    headerLeft.appendChild(badge);
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public showLoading(message = t('common.loading')): void {
    if (this._locked) return;
    this.setErrorState(false);
    this.clearRetryCountdown();
    replaceChildren(this.content,
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
      const backoffSeconds = autoRetrySeconds ?? Math.min(15 * Math.pow(2, this.retryAttempt), 180);
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
    replaceChildren(this.content, h('div', { className: 'panel-error-state' }, ...children));
  }

  public resetRetryBackoff(): void {
    this.retryAttempt = 0;
  }

  public showLocked(features: string[] = []): void {
    this._locked = true;
    this.clearRetryCountdown();

    for (let child = this.header.nextElementSibling; child && child !== this.content; child = child.nextElementSibling) {
      (child as HTMLElement).style.display = 'none';
    }
    this.element.classList.add('panel-is-locked');

    const lockSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>`;
    const iconEl = h('div', { className: 'panel-locked-icon' });
    iconEl.innerHTML = lockSvg;

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

    const ctaBtn = h('button', { type: 'button', className: 'panel-locked-cta' }, t('premium.joinWaitlist'));
    if (isDesktopRuntime()) {
      ctaBtn.addEventListener('click', () => void invokeTauri<void>('open_settings_window_command').catch(() => {}));
    } else {
      ctaBtn.addEventListener('click', () => window.open('https://worldmonitor.app/pro', '_blank'));
    }
    lockedChildren.push(ctaBtn);

    replaceChildren(this.content, h('div', { className: 'panel-locked-state' }, ...lockedChildren));
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

    replaceChildren(this.content,
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
    replaceChildren(this.content, msgEl);
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

  public setContent(html: string): void {
    if (this._locked) return;
    this.setErrorState(false);
    this.clearRetryCountdown();
    this.retryAttempt = 0;
    if (this.pendingContentHtml === html || this.content.innerHTML === html) {
      return;
    }

    this.pendingContentHtml = html;
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
    if (this.contentDebounceTimer) {
      clearTimeout(this.contentDebounceTimer);
      this.contentDebounceTimer = null;
    }

    this.pendingContentHtml = null;
    if (this.content.innerHTML !== html) {
      this.content.innerHTML = html;
    }
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

  public setEnabled(enabled: boolean): void {
    this.toggle(enabled);
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
    const spans = loadPanelSpans();
    delete spans[this.panelId];
    localStorage.setItem(PANEL_SPANS_KEY, JSON.stringify(spans));
  }

  public resetWidth(): void {
    clearColSpanClass(this.element);
    clearPanelColSpan(this.panelId);
  }

  protected get signal(): AbortSignal {
    return this.abortController.signal;
  }

  protected isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'AbortError';
  }

  public destroy(): void {
    this.abortController.abort();
    this.clearRetryCountdown();
    if (this.colSpanReconcileRaf !== null) {
      cancelAnimationFrame(this.colSpanReconcileRaf);
      this.colSpanReconcileRaf = null;
    }
    if (this.contentDebounceTimer) {
      clearTimeout(this.contentDebounceTimer);
      this.contentDebounceTimer = null;
    }
    this.pendingContentHtml = null;

    if (this.tooltipCloseHandler) {
      document.removeEventListener('click', this.tooltipCloseHandler);
      this.tooltipCloseHandler = null;
    }

    if (this.onDocMouseUp) {
      document.removeEventListener('mouseup', this.onDocMouseUp);
      this.onDocMouseUp = null;
    }

    this.resizeHandler?.destroy();
    this.colResizeHandler?.destroy();

    this.element.classList.remove('resizing', 'col-resizing');
    delete this.element.dataset.resizing;
    document.body.classList.remove('panel-resize-active');
  }
}
