import { SITE_VARIANT } from '@/config';
import { t } from '@/services/i18n';
import type { PanelConfig } from '@/types';
import { buildOpenEyeTabs, type OpenEyeTab } from './openeye-tabs-model';

const STORAGE_KEY = 'openeye-active-tab';

// Monitor switcher targets — sets the same localStorage override the Tauri
// build uses, then reloads; variant.ts honors it on any self-hosted hostname.
const MONITORS: Array<{ key: string; label: string }> = [
  { key: 'full', label: 'WORLD' },
  { key: 'tech', label: 'TECH' },
  { key: 'finance', label: 'FINANCE' },
  { key: 'commodity', label: 'COMMODITY' },
  { key: 'energy', label: 'ENERGY' },
  { key: 'happy', label: 'GOOD NEWS' },
  { key: 'usachina', label: 'USA vs CHINA' },
];

/**
 * AALICE:OpenEYE desktop tab bar (fork-side, AMD-003).
 *
 * Desktop counterpart of MobilePanelNav: partitions the dashboard into MAP
 * (the map alone, full-bleed, and where the app opens), LIVE (the moving
 * feeds) and one tab per populated panel category. Out-of-tab grid panels
 * are hidden via `.oe-tab-hidden`; the map section is gated by `data-oe-tab`
 * on `.main-content`. Panels stay mounted, so settings visibility
 * (`.hidden`) and the mobile nav's `.mobile-cat-hidden` compose with this
 * filter instead of fighting it.
 *
 * Switching tabs fires a `resize` event — a panel that laid itself out while
 * display:none comes back at zero width otherwise, and the map needs to
 * re-measure its canvas when it goes from hidden to full-bleed.
 */
export class OpenEyeTabBar {
  private element: HTMLElement;
  private tabRow: HTMLElement;
  private tabs: OpenEyeTab[] = [];
  /**
   * Tabs that no longer exist, mapped to where their content went.
   *
   * `world` was the original single tab (map + core panels); `home` was the
   * reading surface left after the map and the live feeds were split out,
   * and it is gone because what remained was a leftovers drawer rather than
   * a subject. Both resolve to MAP, which is now where the app opens.
   * Migrating rather than dropping means an existing install does not land
   * on a tab it never chose.
   */
  private static readonly RETIRED_TABS: Readonly<Record<string, string>> = {
    world: 'map',
    home: 'map',
  };

  private activeKey: string = (() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return 'map';
    return OpenEyeTabBar.RETIRED_TABS[stored] ?? stored;
  })();
  private getPanelSettings: () => Record<string, PanelConfig>;

  // Search / breaking-alert navigation dispatches wm:reveal-panel; switch to
  // the tab that owns the panel so the scrollIntoView isn't swallowed.
  private boundRevealPanel = (e: Event): void => {
    const key = (e as CustomEvent<{ panelId?: string }>).detail?.panelId;
    if (!key) return;
    const active = this.tabs.find((tab) => tab.key === this.activeKey);
    if (active?.panelKeys.includes(key)) return;
    const owner = this.tabs.find((tab) => tab.panelKeys.includes(key));
    if (owner) this.select(owner.key);
  };

  constructor(getPanelSettings: () => Record<string, PanelConfig>) {
    this.getPanelSettings = getPanelSettings;
    this.element = document.createElement('nav');
    this.element.className = 'openeye-tabs';
    this.element.setAttribute('aria-label', 'OpenEYE sections');

    this.tabRow = document.createElement('div');
    this.tabRow.className = 'openeye-tabs-row';
    this.tabRow.setAttribute('role', 'tablist');
    this.tabRow.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-oe-key]');
      if (btn?.dataset.oeKey) this.select(btn.dataset.oeKey);
    });
    this.element.appendChild(this.tabRow);
    this.element.appendChild(this.buildMonitorSwitcher());

    window.addEventListener('wm:reveal-panel', this.boundRevealPanel);
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  /** Rebuild tabs from current panel settings, then re-apply the filter. */
  public refresh(): void {
    this.tabs = buildOpenEyeTabs(this.getPanelSettings(), SITE_VARIANT);
    // Disabling every panel in a section removes its tab; fall back rather
    // than filtering the grid against a tab that no longer exists.
    if (!this.tabs.some((tab) => tab.key === this.activeKey)) {
      this.activeKey = this.tabs[0]?.key ?? 'map';
    }
    this.tabRow.replaceChildren(...this.tabs.map((tab) => {
      const btn = document.createElement('button');
      btn.className = 'openeye-tab';
      btn.dataset.oeKey = tab.key;
      btn.setAttribute('role', 'tab');
      btn.textContent = tab.labelKey ? t(tab.labelKey) : (tab.label ?? tab.key);
      this.setTabState(btn, tab.key === this.activeKey);
      return btn;
    }));
    this.applyFilter();
  }

  /** Stamp the active filter onto a panel mounted after refresh() ran. */
  public applyToNewPanel(el: HTMLElement): void {
    const allowed = this.allowedKeys();
    const key = el.dataset.panel ?? '';
    el.classList.toggle('oe-tab-hidden', !!allowed && !allowed.has(key));
  }

  public destroy(): void {
    window.removeEventListener('wm:reveal-panel', this.boundRevealPanel);
    document.querySelector<HTMLElement>('.main-content')?.removeAttribute('data-oe-tab');
    this.element.remove();
  }

  private buildMonitorSwitcher(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'openeye-monitors';
    const label = document.createElement('span');
    label.className = 'openeye-monitors-label';
    label.textContent = 'MONITOR';
    const select = document.createElement('select');
    select.className = 'openeye-monitor-select';
    select.setAttribute('aria-label', 'Switch monitor');
    for (const m of MONITORS) {
      const opt = document.createElement('option');
      opt.value = m.key;
      opt.textContent = m.label;
      opt.selected = m.key === SITE_VARIANT;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      if (select.value === SITE_VARIANT) return;
      localStorage.setItem('worldmonitor-variant', select.value);
      localStorage.setItem(STORAGE_KEY, 'map');
      location.reload();
    });
    wrap.append(label, select);
    return wrap;
  }

  private setTabState(btn: HTMLElement, active: boolean): void {
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  }

  private select(key: string): void {
    if (key === this.activeKey) return;
    this.activeKey = key;
    localStorage.setItem(STORAGE_KEY, key);
    this.tabRow.querySelectorAll<HTMLElement>('.openeye-tab').forEach((btn) => {
      this.setTabState(btn, btn.dataset.oeKey === key);
    });
    this.applyFilter();
  }

  private allowedKeys(): Set<string> | null {
    const active = this.tabs.find((tab) => tab.key === this.activeKey);
    return active ? new Set(active.panelKeys) : null;
  }

  private applyFilter(): void {
    const mainContent = document.querySelector<HTMLElement>('.main-content');
    if (mainContent) mainContent.dataset.oeTab = this.activeKey;
    const grid = document.getElementById('panelsGrid');
    if (!grid) return;
    const allowed = this.allowedKeys();
    grid.querySelectorAll<HTMLElement>('[data-panel]').forEach((el) => {
      const panelKey = el.dataset.panel ?? '';
      el.classList.toggle('oe-tab-hidden', !!allowed && !allowed.has(panelKey));
    });
    // Charts rendered while display:none come back at zero width — same
    // recalc nudge MobilePanelNav uses.
    window.dispatchEvent(new Event('resize'));
  }
}
