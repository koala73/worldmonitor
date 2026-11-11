import { DASHBOARD_TAB_NAME_MAX_LENGTH, type PanelTab, type TabsState } from '@/services/tab-store';
import { t } from '@/services/i18n';
import { PanelGateReason } from '@/services/panel-gating';
import { lockSvg, upgradeSvg } from '@/components/gate-icons';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { billingAwareGateCopy, type GateCopy } from '@/components/ExportGateControl';

export interface PanelTabBarCallbacks {
  onSelect(tabId: string): void;
  onAdd(): void;
  onRename(tabId: string, name: string): void;
  onDelete(tabId: string): void;
  /** Asked on every render and each time the options open. The bar never reads storage itself. */
  hasNewTabPanels(): boolean;
  onSaveNewTabPanels(): void;
  onClearNewTabPanels(): void;
  /** Team dashboards. The "Team" button shows only while `view()` is non-null. */
  team?: TeamDashboardCallbacks;
}

/** What the team popover lists, computed by the layout manager. */
export interface TeamDashboardsView {
  dashboards: Array<{ id: string; name: string }>;
  /** The team dashboard the active tab was opened from, if it is still shared. */
  active: { id: string; behind: boolean } | null;
  /** A share or stop-sharing call is in flight. */
  busy: boolean;
}

export interface TeamDashboardCallbacks {
  /** Asked on every render. Null hides the button: no team, or not loaded yet. */
  view(): TeamDashboardsView | null;
  /** The menu opened: a cue to ask the server for the current list. */
  onOpenMenu(): void;
  onOpen(dashboardId: string): void;
  onShareTab(): void;
  onUpdateTab(): void;
  onStopSharing(dashboardId: string): void;
}

/** The bar holds one popover at a time; this says which button it belongs to. */
type NoticeKind = 'cap' | 'options' | 'team';

/** Locked state of the "+" control while the dashboard tab cap applies (KTD8). */
export interface TabAddLock {
  /** Copy for the anchored notice — same shape as the export gate's. */
  copy: GateCopy;
  /** Resolved gate action (auth modal, pricing page, billing portal). */
  onAction: () => void;
}

/**
 * Tab-cap copy, shaped exactly like `exportGateCopy` so the two locked
 * surfaces read the same. The billing-aware reasons reuse the shared
 * `components.billingState.*` strings — a customer with paid evidence must
 * never see a fresh upsell. The upgrade CTA stays tier-agnostic ("upgrade for
 * more") because it fires at every rung of the ladder: 3 → Pro, 10 → Pro
 * Business, 25 → Enterprise.
 */
export function tabCapGateCopy(reason: PanelGateReason, cap: number): GateCopy {
  const billing = billingAwareGateCopy(reason);
  if (billing) return billing;
  if (reason === PanelGateReason.ANONYMOUS) {
    return {
      icon: lockSvg,
      desc: t('components.tabCap.signedOutDesc', { cap: String(cap) }),
      cta: t('premium.signIn'),
    };
  }
  return {
    icon: upgradeSvg,
    desc: t('components.tabCap.upgradeDesc', { cap: String(cap) }),
    cta: t('components.tabCap.upgradeCta'),
  };
}

/**
 * Horizontal tab strip for dashboard workspaces. Pure DOM construction
 * (no innerHTML) so user-supplied tab names need no sanitization.
 *
 * Interactions: click switches tabs, double-click renames inline,
 * the per-tab close button deletes (hidden when only one tab remains),
 * the trailing "+" creates a new tab, and the "▾" beside it chooses whether
 * new tabs start with the default panels or with panels the user saved.
 *
 * The "+" can be CAP-LOCKED (KTD8). It stays visually unchanged at rest — a
 * one-glyph button has no room for a lock badge with copy — and only its
 * aria-label changes; clicking it opens an anchored notice with the reason and
 * a CTA. Existing tabs are never touched: the cap blocks creation only.
 */
export class PanelTabBar {
  private element: HTMLElement;
  private tablistEl: HTMLElement;
  private getState: () => TabsState;
  private callbacks: PanelTabBarCallbacks;
  private addBtn: HTMLButtonElement | null = null;
  private addLock: TabAddLock | null = null;
  private notice: HTMLElement | null = null;
  private noticeKind: NoticeKind | null = null;
  // Built once, unlike "+", so an open popover keeps its anchor and a truthful
  // aria-expanded across re-renders.
  private readonly optionsBtn: HTMLButtonElement;
  private readonly teamBtn: HTMLButtonElement;
  private readonly liveRegion: HTMLElement;
  private readonly onNoticeOutsideClick: (event: MouseEvent) => void;
  private readonly onNoticeKeyDown: (event: KeyboardEvent) => void;

  constructor(getState: () => TabsState, callbacks: PanelTabBarCallbacks) {
    this.getState = getState;
    this.callbacks = callbacks;
    this.element = document.createElement('div');
    this.element.className = 'dashboard-tabs-bar';

    // Created up front and empty: an aria-live region only announces content
    // injected AFTER it is in the accessibility tree.
    this.liveRegion = document.createElement('span');
    this.liveRegion.className = 'wm-visually-hidden';
    this.liveRegion.setAttribute('role', 'status');
    this.liveRegion.setAttribute('aria-live', 'polite');

    this.onNoticeOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (this.notice?.contains(target) || this.noticeAnchor()?.contains(target)) return;
      this.closeNotice();
    };
    this.onNoticeKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') this.closeNotice(true);
    };

    this.optionsBtn = document.createElement('button');
    this.optionsBtn.type = 'button';
    this.optionsBtn.className = 'dashboard-tab-options';
    this.optionsBtn.textContent = '▾';
    this.optionsBtn.title = t('dashboardTabs.newTabOptions');
    this.optionsBtn.setAttribute('aria-label', t('dashboardTabs.newTabOptions'));
    this.optionsBtn.setAttribute('aria-expanded', 'false');
    this.optionsBtn.addEventListener('click', () => this.toggleNewTabOptions());

    this.teamBtn = document.createElement('button');
    this.teamBtn.type = 'button';
    this.teamBtn.className = 'dashboard-tab-team';
    this.teamBtn.textContent = t('dashboardTabs.team');
    this.teamBtn.title = t('dashboardTabs.teamDashboards');
    this.teamBtn.setAttribute('aria-label', t('dashboardTabs.teamDashboards'));
    this.teamBtn.setAttribute('aria-expanded', 'false');
    this.teamBtn.addEventListener('click', () => this.toggleTeamDashboards());

    // ARIA: a role="tablist" may only own role="tab"/"presentation" children.
    // The trailing "+" button is an action, not a tab, so the tablist is an
    // inner element holding ONLY the tabs and the add button sits beside it in
    // the bar (see render()). This clears the aria-required-children violation.
    this.tablistEl = document.createElement('div');
    this.tablistEl.className = 'dashboard-tablist';
    this.tablistEl.setAttribute('role', 'tablist');
    this.tablistEl.setAttribute('aria-label', t('dashboardTabs.ariaLabel'));
    this.tablistEl.addEventListener('keydown', (e) => this.handleKeyDown(e));

    // Delegate dblclick at the tablist (attached ONCE, survives re-renders).
    // A per-label listener breaks for inactive tabs: the first click switches
    // tabs → render() → replaceChildren() swaps out the label node, so the two
    // clicks land on different elements and the browser dispatches dblclick on
    // their common ancestor (this container) rather than the new label.
    // Resolving the tab from the DOM here makes rename work on any tab.
    this.tablistEl.addEventListener('dblclick', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.dashboard-tab-close')) return; // don't rename on delete dblclick
      const tabEl = (target.closest('.dashboard-tab') ??
        document.elementFromPoint(e.clientX, e.clientY)?.closest('.dashboard-tab')) as HTMLElement | null;
      if (!tabEl) return;
      const tabId = tabEl.dataset.tabId;
      if (!tabId) return;
      const tab = this.getState().tabs.find((tb) => tb.id === tabId);
      if (tab) this.startRename(tabEl, tab);
    });

    this.render();
  }

  getElement(): HTMLElement {
    return this.element;
  }

  refresh(): void {
    this.render();
  }

  destroy(): void {
    this.closeNotice();
    this.element.remove();
  }

  /**
   * Apply (or clear) the tab cap's locked state. Called on every auth and
   * entitlement emission, so a snapshot that arrives late — or a mid-session
   * upgrade — flips the control without a reload.
   */
  setAddLock(lock: TabAddLock | null): void {
    const wasLocked = this.addLock !== null;
    // Change-detection guard: gating re-fires on every auth/entitlement/
    // subscription emission, most with an unchanged verdict (same pattern as
    // Panel.showGatedCta's repeat-verdict skip).
    if (
      wasLocked === (lock !== null) &&
      lock?.copy.desc === this.addLock?.copy.desc &&
      lock?.copy.cta === this.addLock?.copy.cta
    ) {
      this.addLock = lock;
      return;
    }
    this.addLock = lock;
    this.applyAddLock();
    if (wasLocked && lock === null) {
      if (this.noticeKind === 'cap') this.closeNotice();
      this.liveRegion.textContent = t('components.tabCap.unlockedAnnouncement');
    } else if (this.noticeKind === 'cap') {
      // Locked → locked with different copy (e.g. anonymous → signed-in
      // free): the open notice carries the OLD reason and the OLD onAction
      // closure. Close it; the next "+" click rebuilds from the new lock.
      this.closeNotice();
    }
  }

  /**
   * Open the anchored locked notice (icon + reason + CTA) for a click on a
   * capped "+". No-op when the control is not locked.
   */
  showAddLockNotice(): void {
    const lock = this.addLock;
    if (!lock || !this.addBtn) return;

    const icon = document.createElement('div');
    icon.className = 'tab-cap-notice-icon';
    setTrustedHtml(icon, trustedHtml(lock.copy.icon, 'static inline icon markup'));

    const desc = document.createElement('p');
    desc.className = 'tab-cap-notice-desc';
    desc.id = 'tab-cap-notice-desc';
    desc.textContent = lock.copy.desc;

    const cta = document.createElement('button');
    cta.type = 'button';
    cta.className = 'tab-cap-notice-cta';
    cta.textContent = lock.copy.cta;
    // The reason travels with the focused button, so a screen-reader user who
    // clicks a locked "+" hears why before the CTA name.
    cta.setAttribute('aria-describedby', desc.id);
    cta.addEventListener('click', () => {
      this.closeNotice();
      lock.onAction();
    });

    const notice = document.createElement('div');
    notice.className = 'tab-cap-notice';
    notice.append(icon, desc, cta);

    this.openNotice('cap', notice, cta);
  }

  private toggleNewTabOptions(): void {
    if (this.noticeKind === 'options') {
      this.closeNotice();
      return;
    }
    const saved = this.callbacks.hasNewTabPanels();

    const desc = document.createElement('p');
    desc.className = 'tab-cap-notice-desc';
    desc.id = 'dashboard-tab-options-desc';
    desc.textContent = t(saved ? 'dashboardTabs.newTabStartsSaved' : 'dashboardTabs.newTabStartsDefault');

    const hint = document.createElement('p');
    hint.className = 'tab-cap-notice-desc';
    hint.textContent = t('dashboardTabs.newTabOptionsHint');

    const action = (label: string, run: () => void): HTMLButtonElement => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tab-cap-notice-action';
      btn.textContent = label;
      btn.setAttribute('aria-describedby', desc.id);
      btn.addEventListener('click', () => {
        run();
        // After the callback: it re-renders the bar, which detaches and
        // re-attaches the options button and would drop focus restored earlier.
        this.closeNotice(true);
      });
      return btn;
    };
    const useTab = action(t('dashboardTabs.useThisTabPanels'), () => this.callbacks.onSaveNewTabPanels());

    const popover = document.createElement('div');
    popover.id = 'dashboard-tab-options';
    popover.className = 'tab-cap-notice';
    popover.setAttribute('role', 'group');
    popover.setAttribute('aria-label', t('dashboardTabs.newTabOptions'));
    popover.append(desc, hint, useTab);
    if (saved) {
      popover.append(action(t('dashboardTabs.useDefaultPanels'), () => this.callbacks.onClearNewTabPanels()));
    }

    this.openNotice('options', popover, useTab);
  }

  private toggleTeamDashboards(): void {
    if (this.noticeKind === 'team') {
      this.closeNotice();
      return;
    }
    const popover = document.createElement('div');
    popover.id = 'dashboard-team-dashboards';
    popover.className = 'tab-cap-notice team-dashboards-notice';
    popover.setAttribute('role', 'group');
    popover.setAttribute('aria-label', t('dashboardTabs.teamDashboards'));
    const focus = this.fillTeamDashboards(popover);
    if (!focus) return;
    this.openNotice('team', popover, focus);
    this.callbacks.team?.onOpenMenu();
  }

  /**
   * (Re)build the team popover's contents from the current view. Returns the
   * control to focus, or null when there is no team to show.
   */
  private fillTeamDashboards(popover: HTMLElement): HTMLElement | null {
    const view = this.callbacks.team?.view();
    if (!view) return null;

    const desc = document.createElement('p');
    desc.className = 'tab-cap-notice-desc';
    desc.id = 'dashboard-team-dashboards-desc';
    desc.textContent = t(view.dashboards.length > 0 ? 'teamDashboards.desc' : 'teamDashboards.empty');

    const list = document.createElement('ul');
    list.className = 'team-dashboards-list';
    for (const dashboard of view.dashboards) {
      const isActive = view.active?.id === dashboard.id;
      const item = document.createElement('li');
      item.className = `team-dashboards-item${isActive ? ' active' : ''}`;

      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'team-dashboards-open';
      open.textContent = dashboard.name;
      open.title = t('teamDashboards.open', { name: dashboard.name });
      open.setAttribute('aria-label', t('teamDashboards.open', { name: dashboard.name }));
      if (isActive) open.setAttribute('aria-current', 'true');
      // Close first: opening can run into the tab cap, whose notice must stay.
      open.addEventListener('click', () => {
        this.closeNotice(true);
        this.callbacks.team?.onOpen(dashboard.id);
      });

      const stop = document.createElement('button');
      stop.type = 'button';
      stop.className = 'team-dashboards-stop';
      stop.textContent = '×';
      stop.disabled = view.busy;
      stop.title = t('teamDashboards.stopSharing', { name: dashboard.name });
      stop.setAttribute('aria-label', t('teamDashboards.stopSharing', { name: dashboard.name }));
      stop.addEventListener('click', () => this.callbacks.team?.onStopSharing(dashboard.id));

      item.append(open, stop);
      list.appendChild(item);
    }

    const action = (label: string, run: () => void): HTMLButtonElement => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tab-cap-notice-action';
      btn.textContent = label;
      btn.disabled = view.busy;
      btn.addEventListener('click', run);
      return btn;
    };

    const nodes: HTMLElement[] = [desc];
    if (view.dashboards.length > 0) nodes.push(list);
    if (view.active?.behind) {
      const behind = document.createElement('p');
      behind.className = 'tab-cap-notice-desc';
      behind.textContent = t('teamDashboards.behind');
      nodes.push(behind, action(t('teamDashboards.getLatest'), () => {
        this.closeNotice(true);
        this.callbacks.team?.onUpdateTab();
      }));
    }
    const share = action(
      t(view.active ? 'teamDashboards.shareChanges' : 'teamDashboards.shareTab'),
      () => this.callbacks.team?.onShareTab(),
    );
    nodes.push(share);
    popover.replaceChildren(...nodes);
    return popover.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? share;
  }

  private anchorFor(kind: NoticeKind): HTMLButtonElement | null {
    if (kind === 'options') return this.optionsBtn;
    if (kind === 'team') return this.teamBtn;
    return this.addBtn;
  }

  private noticeAnchor(): HTMLButtonElement | null {
    return this.noticeKind ? this.anchorFor(this.noticeKind) : null;
  }

  private openNotice(kind: NoticeKind, notice: HTMLElement, focus: HTMLElement): void {
    this.closeNotice();
    const anchor = this.anchorFor(kind);
    if (!anchor) return;

    // The bar scrolls horizontally (overflow-x: auto), so an in-flow popover
    // would be clipped by it. The notice is body-anchored and positioned from
    // the button's viewport rect instead.
    document.body.appendChild(notice);
    const rect = anchor.getBoundingClientRect();
    notice.style.top = `${rect.bottom + 6}px`;
    notice.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - notice.offsetWidth - 8))}px`;

    this.notice = notice;
    this.noticeKind = kind;
    if (kind !== 'cap') {
      anchor.setAttribute('aria-expanded', 'true');
      anchor.setAttribute('aria-controls', notice.id);
    }
    document.addEventListener('mousedown', this.onNoticeOutsideClick);
    document.addEventListener('keydown', this.onNoticeKeyDown);
    focus.focus();
  }

  private closeNotice(restoreFocus = false): void {
    if (!this.notice) return;
    const anchor = this.noticeAnchor();
    document.removeEventListener('mousedown', this.onNoticeOutsideClick);
    document.removeEventListener('keydown', this.onNoticeKeyDown);
    this.notice.remove();
    this.notice = null;
    this.noticeKind = null;
    for (const btn of [this.optionsBtn, this.teamBtn]) {
      btn.setAttribute('aria-expanded', 'false');
      btn.removeAttribute('aria-controls');
    }
    if (restoreFocus) anchor?.focus();
  }

  private applyAddLock(): void {
    if (!this.addBtn) return;
    this.addBtn.setAttribute(
      'aria-label',
      this.addLock
        ? t('components.tabCap.lockedAriaLabel', { reason: this.addLock.copy.desc })
        : t('dashboardTabs.addTab'),
    );
  }

  private render(): void {
    this.tablistEl.replaceChildren();
    const { tabs, activeTabId } = this.getState();
    for (const tab of tabs) {
      this.tablistEl.appendChild(this.renderTab(tab, tab.id === activeTabId, tabs.length > 1));
    }
    this.updateControlledPanel(activeTabId);
    const addBtn = document.createElement('button');
    addBtn.className = 'dashboard-tab-add';
    addBtn.title = t(this.callbacks.hasNewTabPanels() ? 'dashboardTabs.addTabTitleSaved' : 'dashboardTabs.addTabTitle');
    addBtn.textContent = '+';
    // The click always reaches the manager: `addTab` is the single enforcement
    // point for the cap, so the button never decides on its own.
    addBtn.addEventListener('click', () => this.callbacks.onAdd());
    this.addBtn = addBtn;
    this.applyAddLock();
    // The tablist owns only tabs; the add, options and team buttons are siblings in the bar.
    const hasTeam = this.callbacks.team?.view() != null;
    const teamBtn = hasTeam ? [this.teamBtn] : [];
    // Re-inserting a focused button blurs it; put keyboard focus back.
    const focused = [this.optionsBtn, this.teamBtn].find((btn) => btn === document.activeElement);
    this.element.replaceChildren(this.tablistEl, addBtn, this.optionsBtn, ...teamBtn, this.liveRegion);
    if (focused?.isConnected) focused.focus();
    // An open team menu follows the list as it loads or changes; it closes if
    // the team goes away (sign-out, seat removed).
    if (this.noticeKind === 'team' && this.notice) {
      const hadFocus = this.notice.contains(document.activeElement);
      const focus = hasTeam ? this.fillTeamDashboards(this.notice) : null;
      if (!focus) this.closeNotice();
      else if (hadFocus && !this.notice.contains(document.activeElement)) focus.focus();
    }
  }

  private renderTab(tab: PanelTab, isActive: boolean, canDelete: boolean): HTMLElement {
    const el = document.createElement('div');
    el.className = `dashboard-tab${isActive ? ' active' : ''}`;
    el.dataset.tabId = tab.id;

    const label = document.createElement('button');
    label.className = 'dashboard-tab-label';
    label.id = this.getTabButtonId(tab.id);
    label.setAttribute('role', 'tab');
    label.setAttribute('aria-selected', String(isActive));
    label.tabIndex = isActive ? 0 : -1;
    // ARIA tab contract: a role="tab" must point at the tabpanel it controls.
    // All tabs drive the same panel grid (only its contents swap on switch).
    label.setAttribute('aria-controls', 'panelsGrid');
    label.textContent = tab.name;
    label.title = t('dashboardTabs.renameHint', { name: tab.name });
    label.addEventListener('click', () => {
      if (!isActive) this.callbacks.onSelect(tab.id);
    });
    // dblclick-to-rename is handled by the container-level delegate in the
    // constructor so it works for inactive tabs too (see note there).
    el.appendChild(label);

    if (canDelete) {
      const close = document.createElement('button');
      close.className = 'dashboard-tab-close';
      close.setAttribute('aria-label', t('dashboardTabs.deleteTabAria', { name: tab.name }));
      close.title = t('dashboardTabs.deleteTab');
      close.textContent = '×';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        this.callbacks.onDelete(tab.id);
      });
      el.appendChild(close);
    }
    return el;
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (!(e.target instanceof HTMLElement)) return;
    if (e.target.classList.contains('dashboard-tab-rename')) return;
    const tabs = this.getTabButtons();
    const currentIndex = tabs.indexOf(e.target.closest('[role="tab"]') as HTMLButtonElement);
    if (currentIndex === -1) return;

    let nextIndex: number | null = null;
    if (e.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') nextIndex = 0;
    else if (e.key === 'End') nextIndex = tabs.length - 1;
    else return;

    e.preventDefault();
    const next = tabs[nextIndex];
    const tabId = next?.closest('.dashboard-tab')?.getAttribute('data-tab-id');
    if (!next || !tabId) return;

    if (tabId !== this.getState().activeTabId) {
      this.callbacks.onSelect(tabId);
      requestAnimationFrame(() => document.getElementById(this.getTabButtonId(tabId))?.focus());
      return;
    }
    next.focus();
  }

  private getTabButtons(): HTMLButtonElement[] {
    return Array.from(this.element.querySelectorAll<HTMLButtonElement>('.dashboard-tab-label[role="tab"]'));
  }

  private getTabButtonId(tabId: string): string {
    return `dashboard-tab-${tabId.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  }

  private updateControlledPanel(activeTabId: string): void {
    const panel = document.getElementById('panelsGrid');
    if (!panel) return;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', this.getTabButtonId(activeTabId));
  }

  private startRename(tabEl: HTMLElement, tab: PanelTab): void {
    const labelBtn = tabEl.querySelector('.dashboard-tab-label');
    if (!labelBtn || tabEl.querySelector('.dashboard-tab-rename')) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'dashboard-tab-rename';
    input.value = tab.name;
    input.maxLength = DASHBOARD_TAB_NAME_MAX_LENGTH;
    input.setAttribute('aria-label', t('dashboardTabs.tabNameAria'));

    // `done` guards the blur that fires when commit/cancel re-renders the bar.
    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (name && name !== tab.name) this.callbacks.onRename(tab.id, name);
      else this.render();
    };
    const cancel = () => {
      if (done) return;
      done = true;
      this.render();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      else if (e.key === 'Escape') cancel();
      e.stopPropagation();
    });
    input.addEventListener('blur', commit);

    labelBtn.replaceWith(input);
    input.focus();
    input.select();
  }
}
