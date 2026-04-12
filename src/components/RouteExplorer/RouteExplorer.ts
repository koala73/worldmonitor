/**
 * RouteExplorer — full-screen modal for the worldwide Route Explorer feature.
 *
 * Sprint 2 ships the SHELL only: query bar + tab strip + URL state + keyboard
 * focus trap. No API calls yet — tab panels render placeholder text. Sprint 3
 * wires CurrentRouteTab / AlternativesTab / LandTab to the
 * `get-route-explorer-lane` RPC, and Sprint 4 adds the Impact tab.
 *
 * Keyboard model:
 *   - Esc: close picker, then close modal
 *   - Tab / Shift+Tab: cycle focusable zones (focus-trapped inside modal)
 *   - F / T / P: jump to From / To / Product picker
 *   - S: swap From ↔ To
 *   - 1–4: switch tabs
 *   - ?: show keyboard help overlay
 *   - Cmd+,: copy shareable URL
 *
 * Single-letter bindings are scoped to "modal focused AND no text input
 * focused" so they don't collide with typing into the picker text fields.
 */

import { CountryPicker } from './CountryPicker';
import { Hs2Picker } from './Hs2Picker';
import { CargoTypeDropdown } from './CargoTypeDropdown';
import { KeyboardHelp } from './KeyboardHelp';
import {
  inferCargoFromHs2,
  type ExplorerCargo,
} from './RouteExplorer.utils';
import {
  parseExplorerUrl,
  serializeExplorerUrl,
  writeExplorerUrl,
  DEFAULT_EXPLORER_STATE,
  type ExplorerUrlState,
  type ExplorerTab,
} from './url-state';

const TAB_LABELS: Record<ExplorerTab, string> = {
  1: 'Current',
  2: 'Alternatives',
  3: 'Land',
  4: 'Impact',
};

interface TestHook {
  lastHighlightedRouteIds?: string[];
  lastBypassRoutes?: Array<{ fromPort: [number, number]; toPort: [number, number] }>;
  lastClearHighlight?: number;
  lastClearBypass?: number;
}

declare global {
  interface Window {
    __routeExplorerTestHook?: TestHook;
  }
}

export class RouteExplorer {
  private root: HTMLDivElement | null = null;
  private state: ExplorerUrlState;
  private fromPicker!: CountryPicker;
  private toPicker!: CountryPicker;
  private hs2Picker!: Hs2Picker;
  private cargoDropdown!: CargoTypeDropdown;
  private tabStrip!: HTMLDivElement;
  private contentEl!: HTMLDivElement;
  private leftRailEl!: HTMLElement;
  private cargoManual = false;
  private isOpen = false;
  private previousFocus: HTMLElement | null = null;
  private helpOverlay: KeyboardHelp | null = null;

  constructor() {
    this.state = { ...DEFAULT_EXPLORER_STATE };
    this.installTestHook();
  }

  // ─── Public API ────────────────────────────────────────────────────────

  public open(): void {
    if (this.isOpen) {
      this.fromPicker?.focusInput();
      return;
    }
    this.state = this.readInitialState();
    this.previousFocus = (document.activeElement as HTMLElement) ?? null;
    this.root = this.buildRoot();
    document.body.append(this.root);
    this.isOpen = true;
    document.addEventListener('keydown', this.handleGlobalKeydown, { capture: true });
    this.focusInitial();
  }

  public close(): void {
    if (!this.isOpen || !this.root) return;
    document.removeEventListener('keydown', this.handleGlobalKeydown, { capture: true });
    this.helpOverlay?.element.remove();
    this.helpOverlay = null;
    this.root.remove();
    this.root = null;
    this.isOpen = false;
    if (this.previousFocus && document.body.contains(this.previousFocus)) {
      this.previousFocus.focus();
    }
    this.previousFocus = null;
  }

  public isOpenNow(): boolean {
    return this.isOpen;
  }

  // ─── Initial state from URL ─────────────────────────────────────────────

  private readInitialState(): ExplorerUrlState {
    if (typeof window === 'undefined') return { ...DEFAULT_EXPLORER_STATE };
    return parseExplorerUrl(window.location.search);
  }

  private writeStateToUrl(): void {
    writeExplorerUrl(this.state);
  }

  // ─── DOM construction ──────────────────────────────────────────────────

  private buildRoot(): HTMLDivElement {
    const root = document.createElement('div');
    root.className = 're-modal';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Route Explorer — plan a shipment');

    const backdrop = document.createElement('div');
    backdrop.className = 're-modal__backdrop';
    backdrop.addEventListener('click', () => this.close());

    const surface = document.createElement('div');
    surface.className = 're-modal__surface';

    surface.append(this.buildQueryBar(), this.buildTabStrip(), this.buildBody());

    root.append(backdrop, surface);
    return root;
  }

  private buildQueryBar(): HTMLDivElement {
    const bar = document.createElement('div');
    bar.className = 're-querybar';

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 're-querybar__back';
    back.textContent = '← Back';
    back.setAttribute('aria-label', 'Close Route Explorer');
    back.addEventListener('click', () => this.close());

    this.fromPicker = new CountryPicker({
      placeholder: 'From country',
      initialIso2: this.state.fromIso2,
      onCommit: (iso2) => this.handleFromCommit(iso2),
      onCancel: () => this.blurActiveInput(),
    });

    const arrow = document.createElement('span');
    arrow.className = 're-querybar__arrow';
    arrow.textContent = '→';
    arrow.setAttribute('aria-hidden', 'true');

    this.toPicker = new CountryPicker({
      placeholder: 'To country',
      initialIso2: this.state.toIso2,
      onCommit: (iso2) => this.handleToCommit(iso2),
      onCancel: () => this.blurActiveInput(),
    });

    this.hs2Picker = new Hs2Picker({
      placeholder: 'Pick a product',
      initialHs2: this.state.hs2,
      onCommit: (hs2) => this.handleHs2Commit(hs2),
      onCancel: () => this.blurActiveInput(),
    });

    const initialCargo = this.state.cargo ?? inferCargoFromHs2(this.state.hs2);
    this.cargoManual = this.state.cargo !== null;
    this.cargoDropdown = new CargoTypeDropdown({
      initialCargo,
      initialAutoInferred: !this.cargoManual,
      onChange: (cargo, manual) => this.handleCargoChange(cargo, manual),
    });

    bar.append(
      back,
      this.fromPicker.element,
      arrow,
      this.toPicker.element,
      this.hs2Picker.element,
      this.cargoDropdown.element,
    );
    return bar;
  }

  private buildTabStrip(): HTMLDivElement {
    this.tabStrip = document.createElement('div');
    this.tabStrip.className = 're-tabstrip';
    this.tabStrip.setAttribute('role', 'tablist');
    for (const n of [1, 2, 3, 4] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 're-tabstrip__tab';
      button.dataset.tab = String(n);
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', n === this.state.tab ? 'true' : 'false');
      if (n === this.state.tab) button.classList.add('re-tabstrip__tab--active');
      button.innerHTML = `<span class="re-tabstrip__digit">${n}</span><span class="re-tabstrip__label">${TAB_LABELS[n]}</span>`;
      button.addEventListener('click', () => this.setTab(n));
      this.tabStrip.append(button);
    }
    return this.tabStrip;
  }

  private buildBody(): HTMLDivElement {
    const body = document.createElement('div');
    body.className = 're-body';

    this.leftRailEl = document.createElement('aside');
    this.leftRailEl.className = 're-leftrail';
    this.leftRailEl.setAttribute('aria-label', 'Lane summary');
    this.leftRailEl.innerHTML =
      '<div class="re-leftrail__placeholder">Pick a country pair and product to see the lane summary.</div>';

    this.contentEl = document.createElement('div');
    this.contentEl.className = 're-content';
    this.renderActiveTab();

    body.append(this.leftRailEl, this.contentEl);
    return body;
  }

  // ─── Tab rendering (Sprint 2 placeholders) ──────────────────────────────

  private renderActiveTab(): void {
    if (!this.contentEl) return;
    const tab = this.state.tab;
    const label = TAB_LABELS[tab];
    this.contentEl.innerHTML = `<div class="re-content__placeholder" data-tab="${tab}"><h2>${label}</h2><p>Sprint 3 wires this tab to the route-explorer-lane RPC. Pick a country pair and product to see the data.</p></div>`;
  }

  // ─── Event handlers ────────────────────────────────────────────────────

  private handleFromCommit(iso2: string): void {
    this.state = { ...this.state, fromIso2: iso2 };
    this.writeStateToUrl();
    this.fromPicker.setValue(iso2);
    // Move focus to the next empty slot for keyboard flow.
    if (!this.state.toIso2) this.toPicker.focusInput();
    else if (!this.state.hs2) this.hs2Picker.focusInput();
  }

  private handleToCommit(iso2: string): void {
    this.state = { ...this.state, toIso2: iso2 };
    this.writeStateToUrl();
    this.toPicker.setValue(iso2);
    if (!this.state.fromIso2) this.fromPicker.focusInput();
    else if (!this.state.hs2) this.hs2Picker.focusInput();
  }

  private handleHs2Commit(hs2: string): void {
    this.state = { ...this.state, hs2 };
    this.writeStateToUrl();
    this.hs2Picker.setValue(hs2);
    if (!this.cargoManual) {
      const inferred = inferCargoFromHs2(hs2);
      this.cargoDropdown.setAutoInferred(inferred);
    }
  }

  private handleCargoChange(cargo: ExplorerCargo, manual: boolean): void {
    this.cargoManual = manual;
    this.state = { ...this.state, cargo };
    this.writeStateToUrl();
  }

  private setTab(n: ExplorerTab): void {
    if (n === this.state.tab) return;
    this.state = { ...this.state, tab: n };
    this.writeStateToUrl();
    if (this.tabStrip) {
      const buttons = this.tabStrip.querySelectorAll<HTMLButtonElement>('.re-tabstrip__tab');
      buttons.forEach((b) => {
        const isActive = Number.parseInt(b.dataset.tab ?? '0', 10) === n;
        b.classList.toggle('re-tabstrip__tab--active', isActive);
        b.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
    }
    this.renderActiveTab();
  }

  private swapFromTo(): void {
    const newFrom = this.state.toIso2;
    const newTo = this.state.fromIso2;
    this.state = { ...this.state, fromIso2: newFrom, toIso2: newTo };
    this.writeStateToUrl();
    this.fromPicker.setValue(newFrom);
    this.toPicker.setValue(newTo);
  }

  // ─── Keyboard ──────────────────────────────────────────────────────────

  private isFormControlFocused(): boolean {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if ((el as HTMLElement).isContentEditable) return true;
    return false;
  }

  private blurActiveInput(): void {
    const el = document.activeElement as HTMLElement | null;
    el?.blur();
  }

  private handleGlobalKeydown = (e: KeyboardEvent): void => {
    if (!this.isOpen || !this.root) return;

    // Esc: close help if open, else close picker (let pickers handle), else close modal.
    if (e.key === 'Escape') {
      if (this.helpOverlay) {
        e.preventDefault();
        e.stopPropagation();
        this.closeHelp();
        return;
      }
      // If a picker input is focused, let the picker handle Esc first.
      if (this.isFormControlFocused()) return;
      e.preventDefault();
      e.stopPropagation();
      this.close();
      return;
    }

    // Cmd+, / Ctrl+, : copy URL
    if ((e.metaKey || e.ctrlKey) && e.key === ',') {
      e.preventDefault();
      this.copyShareUrl();
      return;
    }

    // Tab focus trap
    if (e.key === 'Tab') {
      this.handleTabKey(e);
      return;
    }

    // Single-letter shortcuts only when no text input is focused
    if (this.isFormControlFocused()) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    switch (e.key) {
      case '1':
      case '2':
      case '3':
      case '4': {
        e.preventDefault();
        this.setTab(Number.parseInt(e.key, 10) as ExplorerTab);
        return;
      }
      case 'F':
      case 'f':
        e.preventDefault();
        this.fromPicker.focusInput();
        return;
      case 'T':
      case 't':
        e.preventDefault();
        this.toPicker.focusInput();
        return;
      case 'P':
      case 'p':
        e.preventDefault();
        this.hs2Picker.focusInput();
        return;
      case 'S':
      case 's':
        e.preventDefault();
        this.swapFromTo();
        return;
      case '?':
        e.preventDefault();
        this.openHelp();
        return;
      default:
        return;
    }
  };

  private handleTabKey(e: KeyboardEvent): void {
    if (!this.root) return;
    const focusable = this.collectFocusable();
    if (focusable.length === 0) return;
    const current = document.activeElement as HTMLElement | null;
    const idx = current ? focusable.indexOf(current) : -1;
    let nextIdx: number;
    if (e.shiftKey) {
      nextIdx = idx <= 0 ? focusable.length - 1 : idx - 1;
    } else {
      nextIdx = idx === -1 || idx >= focusable.length - 1 ? 0 : idx + 1;
    }
    const next = focusable[nextIdx];
    if (!next) return;
    e.preventDefault();
    next.focus();
  }

  private collectFocusable(): HTMLElement[] {
    if (!this.root) return [];
    const sel = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    return Array.from(this.root.querySelectorAll<HTMLElement>(sel)).filter(
      (el) => !el.hasAttribute('disabled') && el.offsetParent !== null,
    );
  }

  private focusInitial(): void {
    if (!this.state.fromIso2) {
      this.fromPicker.focusInput();
    } else if (!this.state.toIso2) {
      this.toPicker.focusInput();
    } else if (!this.state.hs2) {
      this.hs2Picker.focusInput();
    } else {
      this.fromPicker.focusInput();
    }
  }

  // ─── Help overlay ──────────────────────────────────────────────────────

  private openHelp(): void {
    if (!this.root || this.helpOverlay) return;
    this.helpOverlay = new KeyboardHelp({ onClose: () => this.closeHelp() });
    this.root.append(this.helpOverlay.element);
  }

  private closeHelp(): void {
    if (!this.helpOverlay) return;
    this.helpOverlay.element.remove();
    this.helpOverlay = null;
  }

  // ─── Share URL ────────────────────────────────────────────────────────

  private copyShareUrl(): void {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    const serialized = serializeExplorerUrl(this.state);
    if (serialized) url.searchParams.set('explorer', serialized);
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(url.toString());
    }
  }

  // ─── Test hook (DEV builds only) ──────────────────────────────────────

  private installTestHook(): void {
    if (typeof window === 'undefined') return;
    // Only install in dev / test builds; production strips this on init.
    const isDev = (() => {
      try {
        return Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
      } catch {
        return false;
      }
    })();
    if (!isDev) return;
    if (!window.__routeExplorerTestHook) {
      window.__routeExplorerTestHook = {};
    }
  }
}

/** Singleton instance used by the command palette dispatch. */
let singleton: RouteExplorer | null = null;
export function getRouteExplorer(): RouteExplorer {
  if (!singleton) singleton = new RouteExplorer();
  return singleton;
}
