import type { PanelTab, TabsState } from '@/services/tab-store';

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
  private getState: () => TabsState;
  private callbacks: PanelTabBarCallbacks;

  constructor(getState: () => TabsState, callbacks: PanelTabBarCallbacks) {
    this.getState = getState;
    this.callbacks = callbacks;
    this.element = document.createElement('div');
    this.element.className = 'dashboard-tabs-bar';
    this.element.setAttribute('role', 'tablist');
    this.element.setAttribute('aria-label', 'Dashboard tabs');
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
    this.element.replaceChildren();
    const { tabs, activeTabId } = this.getState();
    for (const tab of tabs) {
      this.element.appendChild(this.renderTab(tab, tab.id === activeTabId, tabs.length > 1));
    }
    const addBtn = document.createElement('button');
    addBtn.className = 'dashboard-tab-add';
    addBtn.title = 'New tab (starts with the default panels)';
    addBtn.setAttribute('aria-label', 'Add tab');
    addBtn.textContent = '+';
    addBtn.addEventListener('click', () => this.callbacks.onAdd());
    this.element.appendChild(addBtn);
  }

  private renderTab(tab: PanelTab, isActive: boolean, canDelete: boolean): HTMLElement {
    const el = document.createElement('div');
    el.className = `dashboard-tab${isActive ? ' active' : ''}`;
    el.dataset.tabId = tab.id;

    const label = document.createElement('button');
    label.className = 'dashboard-tab-label';
    label.setAttribute('role', 'tab');
    label.setAttribute('aria-selected', String(isActive));
    label.textContent = tab.name;
    label.title = `${tab.name} — double-click to rename`;
    label.addEventListener('click', () => {
      if (!isActive) this.callbacks.onSelect(tab.id);
    });
    label.addEventListener('dblclick', () => this.startRename(el, tab));
    el.appendChild(label);

    if (canDelete) {
      const close = document.createElement('button');
      close.className = 'dashboard-tab-close';
      close.setAttribute('aria-label', `Delete tab ${tab.name}`);
      close.title = 'Delete tab';
      close.textContent = '×';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        this.callbacks.onDelete(tab.id);
      });
      el.appendChild(close);
    }
    return el;
  }

  private startRename(tabEl: HTMLElement, tab: PanelTab): void {
    const labelBtn = tabEl.querySelector('.dashboard-tab-label');
    if (!labelBtn || tabEl.querySelector('.dashboard-tab-rename')) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'dashboard-tab-rename';
    input.value = tab.name;
    input.maxLength = 40;
    input.setAttribute('aria-label', 'Tab name');

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
