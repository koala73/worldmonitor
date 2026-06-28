import type { PanelTab, TabsState } from '@/services/tab-store';
import { t } from '@/services/i18n';

export interface PanelTabBarCallbacks {
  onSelect(tabId: string): void;
  onAdd(): void;
  onRename(tabId: string, name: string): void;
  onDelete(tabId: string): void;
}

/**
 * Horizontal tab strip for dashboard workspaces. Pure DOM construction
 * (no innerHTML) so user-supplied tab names need no sanitization.
 *
 * Interactions: click switches tabs, double-click renames inline,
 * the per-tab close button deletes (hidden when only one tab remains),
 * and the trailing "+" creates a new tab with the default panels.
 */
export class PanelTabBar {
  private element: HTMLElement;
  private tablistEl: HTMLElement;
  private getState: () => TabsState;
  private callbacks: PanelTabBarCallbacks;

  constructor(getState: () => TabsState, callbacks: PanelTabBarCallbacks) {
    this.getState = getState;
    this.callbacks = callbacks;
    this.element = document.createElement('div');
    this.element.className = 'dashboard-tabs-bar';

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
    this.element.remove();
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
    addBtn.title = t('dashboardTabs.addTabTitle');
    addBtn.setAttribute('aria-label', t('dashboardTabs.addTab'));
    addBtn.textContent = '+';
    addBtn.addEventListener('click', () => this.callbacks.onAdd());
    // The tablist owns only tabs; the add button is a sibling in the bar.
    this.element.replaceChildren(this.tablistEl, addBtn);
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
    input.maxLength = 40;
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
