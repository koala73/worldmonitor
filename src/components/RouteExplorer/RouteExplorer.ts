/**
 * RouteExplorer — full-screen modal for the worldwide Route Explorer.
 *
 * Sprint 3 wires the Current / Alternatives / Land tabs to the
 * `get-route-explorer-lane` RPC, renders results in the left rail and tab
 * panels, and drives map overlays via `MapContainer` primitives.
 */

import { CountryPicker } from './CountryPicker';
import { Hs2Picker } from './Hs2Picker';
import { CargoTypeDropdown } from './CargoTypeDropdown';
import { KeyboardHelp } from './KeyboardHelp';
import { LeftRail } from './components/LeftRail';
import { CurrentRouteTab } from './tabs/CurrentRouteTab';
import { AlternativesTab } from './tabs/AlternativesTab';
import { LandTab } from './tabs/LandTab';
import { CountryImpactTab } from './tabs/CountryImpactTab';
import { inferCargoFromHs2, type ExplorerCargo } from './RouteExplorer.utils';
import COUNTRY_PORT_CLUSTERS from '../../../scripts/shared/country-port-clusters.json';
import {
  parseExplorerUrl,
  serializeExplorerUrl,
  writeExplorerUrl,
  DEFAULT_EXPLORER_STATE,
  type ExplorerUrlState,
  type ExplorerTab,
} from './url-state';
import type { GetRouteExplorerLaneResponse, GetRouteImpactResponse, BypassCorridorOption } from '@/generated/server/worldmonitor/supply_chain/v1/service_server';
import { fetchRouteExplorerLane, fetchRouteImpact } from '@/services/supply-chain';
import { hasPremiumAccess } from '@/services/panel-gating';
import { getAuthState } from '@/services/auth-state';
import { trackGateHit, track, type UmamiEvent } from '@/services/analytics';

import { TRADE_ROUTES } from '@/config/trade-routes';

const TAB_LABELS: Record<ExplorerTab, string> = { 1: 'Current', 2: 'Alternatives', 3: 'Land', 4: 'Impact' };
const FETCH_DEBOUNCE_MS = 250;

const CARGO_TO_ROUTE_CATEGORY: Record<string, string> = {
  container: 'container',
  tanker: 'energy',
  bulk: 'bulk',
  roro: 'container',
};

const ROUTE_CATEGORY_MAP = new Map(TRADE_ROUTES.map((r) => [r.id, r.category]));

interface MapRef {
  highlightRoute(routeIds: string[]): void;
  clearHighlightedRoute(): void;
  setBypassRoutes(corridors: Array<{ fromPort: [number, number]; toPort: [number, number] }>): void;
  clearBypassRoutes(): void;
  zoomToRoutes(routeIds: string[]): void;
}

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
  private leftRail!: LeftRail;
  private currentTab!: CurrentRouteTab;
  private alternativesTab!: AlternativesTab;
  private landTab!: LandTab;
  private impactTab!: CountryImpactTab;
  public impactData: GetRouteImpactResponse | null = null;
  private cargoManual = false;
  private isOpen = false;
  private previousFocus: HTMLElement | null = null;
  private helpOverlay: KeyboardHelp | null = null;
  private mapRef: MapRef | null = null;
  private generationId = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private laneData: GetRouteExplorerLaneResponse | null = null;
  public isLoading = false;
  private displayMode: 'idle' | 'loading' | 'data' | 'error' | 'gate' = 'idle';
  private openedAt = 0;
  private queryCount = 0;
  private gateHitTracked = false;

  constructor() {
    this.state = { ...DEFAULT_EXPLORER_STATE };
    this.installTestHook();
  }

  public setMap(map: MapRef | null): void {
    this.mapRef = map;
  }

  public open(source: 'cmdk' | 'url' | 'icon' = 'cmdk'): void {
    if (this.isOpen) {
      this.fromPicker?.focusInput();
      return;
    }
    this.state = this.readInitialState();
    this.laneData = null;
    this.displayMode = 'idle';
    this.previousFocus = (document.activeElement as HTMLElement) ?? null;
    this.root = this.buildRoot();
    const mapSection = document.getElementById('mapSection');
    if (mapSection) {
      mapSection.insertAdjacentElement('beforebegin', this.root);
    } else {
      document.body.append(this.root);
    }
    this.isOpen = true;
    this.openedAt = Date.now();
    this.queryCount = 0;
    if (!this.gateHitTracked && this.tier === 'free') {
      trackGateHit('route-explorer');
      this.gateHitTracked = true;
    }
    this.trackEvent('route-explorer:opened', { source });
    document.addEventListener('keydown', this.handleGlobalKeydown, { capture: true });
    this.focusInitial();
    if (this.isQueryComplete()) this.scheduleFetch();
  }

  public close(): void {
    if (!this.isOpen || !this.root) return;
    this.generationId++;
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    document.removeEventListener('keydown', this.handleGlobalKeydown, { capture: true });
    this.helpOverlay?.element.remove();
    this.helpOverlay = null;
    this.trackEvent('route-explorer:closed', {
      durationSec: Math.round((Date.now() - this.openedAt) / 1000),
      queryCount: this.queryCount,
    });
    this.clearMapState();
    this.root.remove();
    this.root = null;
    this.isOpen = false;
    this.laneData = null;
    if (this.previousFocus && document.body.contains(this.previousFocus)) {
      this.previousFocus.focus();
    }
    this.previousFocus = null;
  }

  public isOpenNow(): boolean {
    return this.isOpen;
  }

  // ─── State helpers ──────────────────────────────────────────────────────

  private readInitialState(): ExplorerUrlState {
    if (typeof window === 'undefined') return { ...DEFAULT_EXPLORER_STATE };
    return parseExplorerUrl(window.location.search);
  }

  private writeStateToUrl(): void {
    writeExplorerUrl(this.state);
  }

  private isQueryComplete(): boolean {
    return Boolean(this.state.fromIso2 && this.state.toIso2 && this.state.hs2);
  }

  private getEffectiveCargo(): string {
    return this.state.cargo ?? inferCargoFromHs2(this.state.hs2);
  }

  // ─── Data fetching ────────────────────────────────────────────────────

  private scheduleFetch(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.queryCount++;
      this.trackEvent('route-explorer:query', {
        from: this.state.fromIso2 ?? '',
        to: this.state.toIso2 ?? '',
        hs2: this.state.hs2 ?? '',
        cargo: this.getEffectiveCargo(),
      });
      void this.fetchLane();
    }, FETCH_DEBOUNCE_MS);
  }

  private resetLaneState(mode?: 'loading' | 'error' | 'gate'): void {
    this.laneData = null;
    this.impactData = null;
    this.clearMapState();
    this.leftRail?.updateLane(null, mode);
    this.leftRail?.updateResilience(null);
    this.currentTab?.update(null);
    this.alternativesTab?.update(null);
    this.landTab?.update(null);
    this.impactTab?.update(null);
  }

  private async fetchLane(): Promise<void> {
    if (!this.isQueryComplete()) return;
    if (!hasPremiumAccess(getAuthState())) {
      this.generationId++;
      this.displayMode = 'gate';
      this.resetLaneState('gate');
      this.renderFreeGate();
      this.applyPublicRouteHighlight();
      return;
    }

    const gen = ++this.generationId;
    this.displayMode = 'loading';
    this.resetLaneState('loading');
    this.isLoading = true;
    this.showLoading();

    try {
      const data = await fetchRouteExplorerLane({
        fromIso2: this.state.fromIso2!,
        toIso2: this.state.toIso2!,
        hs2: this.state.hs2!,
        cargoType: this.getEffectiveCargo(),
      });
      if (gen !== this.generationId) return;
      this.laneData = data;
      this.displayMode = 'data';
      this.applyData(data);
      if (!data.noModeledLane) {
        this.applyMapState(data);
      }
      void this.fetchResilience(data.toIso2);
      void this.fetchImpact(data.fromIso2, data.toIso2, data.hs2);
    } catch {
      if (gen !== this.generationId) return;
      this.displayMode = 'error';
      this.resetLaneState('error');
      this.showError();
    } finally {
      if (gen === this.generationId) this.isLoading = false;
    }
  }

  private async fetchResilience(iso2: string): Promise<void> {
    const gen = this.generationId;
    try {
      const { getResilienceScore } = await import('@/services/resilience');
      const res = await getResilienceScore(iso2);
      if (!this.isOpen || gen !== this.generationId) return;
      this.leftRail.updateResilience(res.overallScore ?? null);
    } catch {
      if (gen !== this.generationId) return;
      this.leftRail.updateResilience(null);
    }
  }

  private async fetchImpact(fromIso2: string, toIso2: string, hs2: string): Promise<void> {
    const gen = this.generationId;
    try {
      const data = await fetchRouteImpact({ fromIso2, toIso2, hs2 });
      if (!this.isOpen || gen !== this.generationId) return;
      this.impactData = data;
      this.impactTab.update(data);
      this.leftRail.updateDependencyFlags(data.dependencyFlags);
      if (data.comtradeSource === 'bilateral-hs4') {
        this.trackEvent('route-explorer:impact-viewed', { toIso2, hs2 });
      }
      if (data.resilienceScore > 0) {
        this.leftRail.updateResilience(data.resilienceScore);
      }
      if (this.state.tab === 4) this.showActiveTab();
    } catch {
      if (gen !== this.generationId) return;
      this.impactTab.update(null);
    }
  }

  // ─── Map integration ──────────────────────────────────────────────────

  private applyMapState(data: GetRouteExplorerLaneResponse): void {
    if (!this.mapRef || data.noModeledLane || !data.primaryRouteId) return;
    this.mapRef.zoomToRoutes([data.primaryRouteId]);
    this.mapRef.highlightRoute([data.primaryRouteId]);
    if (typeof window !== 'undefined' && window.__routeExplorerTestHook) {
      window.__routeExplorerTestHook.lastHighlightedRouteIds = [data.primaryRouteId];
    }
  }

  private handleBypassSelect(option: BypassCorridorOption): void {
    if (!this.mapRef || !option.fromPort || !option.toPort) return;
    this.trackEvent('route-explorer:alternative-selected', { corridorId: option.id });
    const corridors = [{ fromPort: [option.fromPort.lon, option.fromPort.lat] as [number, number], toPort: [option.toPort.lon, option.toPort.lat] as [number, number] }];
    this.mapRef.setBypassRoutes(corridors);
    if (typeof window !== 'undefined' && window.__routeExplorerTestHook) {
      window.__routeExplorerTestHook.lastBypassRoutes = corridors;
    }
  }

  private clearMapState(): void {
    if (!this.mapRef) return;
    this.mapRef.clearHighlightedRoute();
    this.mapRef.clearBypassRoutes();
    if (typeof window !== 'undefined' && window.__routeExplorerTestHook) {
      window.__routeExplorerTestHook.lastClearHighlight = Date.now();
      window.__routeExplorerTestHook.lastClearBypass = Date.now();
    }
  }

  // ─── Rendering ────────────────────────────────────────────────────────

  private applyData(data: GetRouteExplorerLaneResponse): void {
    this.leftRail.element.classList.remove('re-leftrail--blurred');
    this.leftRail.element.removeAttribute('aria-hidden');
    this.leftRail.updateLane(data);
    this.currentTab.update(data);
    this.alternativesTab.update(data);
    this.landTab.update(data);
    this.showActiveTab();
  }

  private showLoading(): void {
    if (this.contentEl) {
      this.contentEl.innerHTML = '<div class="re-content__loading">Loading lane data\u2026</div>';
    }
  }

  private showError(): void {
    if (this.contentEl) {
      this.contentEl.innerHTML = '<div class="re-content__error">Failed to load lane data. Try again.</div>';
    }
  }

  private renderFreeGate(): void {
    this.leftRail?.element.classList.add('re-leftrail--blurred');
    this.leftRail?.element.setAttribute('aria-hidden', 'true');
    if (this.contentEl) {
      this.contentEl.innerHTML =
        '<div class="re-content__gate">' +
        '<h3>Unlock route intelligence</h3>' +
        '<ul><li>Current route with chokepoint risk</li><li>Ranked bypass alternatives</li><li>Overland corridor options</li></ul>' +
        '<button class="re-content__upgrade" type="button">Upgrade to PRO</button>' +
        '</div>';
      const btn = this.contentEl.querySelector<HTMLButtonElement>('.re-content__upgrade');
      btn?.addEventListener('click', () => {
        this.trackEvent('route-explorer:free-cta-click', {
          from: this.state.fromIso2 ?? '',
          to: this.state.toIso2 ?? '',
          hs2: this.state.hs2 ?? '',
        });
        void import('@/services/checkout')
          .then((m) => m.startCheckout('pro_monthly'))
          .catch(() => window.open('https://worldmonitor.app/pro', '_blank'));
      }, { once: true });
    }
  }

  private applyPublicRouteHighlight(): void {
    if (!this.mapRef || !this.state.fromIso2 || !this.state.toIso2) return;
    const clusters = COUNTRY_PORT_CLUSTERS as unknown as Record<string, { nearestRouteIds: string[] }>;
    const fromRoutes = new Set(clusters[this.state.fromIso2]?.nearestRouteIds ?? []);
    const toRoutes = new Set(clusters[this.state.toIso2]?.nearestRouteIds ?? []);
    const shared = [...fromRoutes].filter((r) => toRoutes.has(r));
    if (shared.length === 0) return;
    const cargoCategory = CARGO_TO_ROUTE_CATEGORY[this.getEffectiveCargo()] ?? 'container';
    const ranked = [...shared].sort((a, b) => {
      const catA = ROUTE_CATEGORY_MAP.get(a) ?? '';
      const catB = ROUTE_CATEGORY_MAP.get(b) ?? '';
      return (catA === cargoCategory ? 0 : 1) - (catB === cargoCategory ? 0 : 1);
    });
    const routeId = ranked[0] ?? '';
    if (routeId) {
      this.mapRef.highlightRoute([routeId]);
      this.mapRef.zoomToRoutes([routeId]);
    }
  }

  private showActiveTab(): void {
    if (!this.contentEl) return;
    if (this.displayMode === 'loading' || this.displayMode === 'error' || this.displayMode === 'gate') {
      return;
    }
    this.contentEl.innerHTML = '';
    switch (this.state.tab) {
      case 1: this.contentEl.append(this.currentTab.element); break;
      case 2: this.contentEl.append(this.alternativesTab.element); break;
      case 3: this.contentEl.append(this.landTab.element); break;
      case 4: this.contentEl.append(this.impactTab.element); break;
    }
  }

  // ─── DOM construction ──────────────────────────────────────────────────

  private buildRoot(): HTMLDivElement {
    const root = document.createElement('div');
    root.className = 're-modal';
    root.setAttribute('role', 'complementary');
    root.setAttribute('aria-label', 'Route Explorer \u2014 plan a shipment');

    const surface = document.createElement('div');
    surface.className = 're-modal__surface';
    surface.append(this.buildQueryBar(), this.buildTabStrip(), this.buildBody());

    root.append(surface);
    return root;
  }

  private buildQueryBar(): HTMLDivElement {
    const bar = document.createElement('div');
    bar.className = 're-querybar';

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 're-querybar__back';
    back.textContent = '\u2190 Back';
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
    arrow.textContent = '\u2192';
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

    bar.append(back, this.fromPicker.element, arrow, this.toPicker.element, this.hs2Picker.element, this.cargoDropdown.element);
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

    this.leftRail = new LeftRail();
    this.currentTab = new CurrentRouteTab();
    this.alternativesTab = new AlternativesTab({
      onSelectBypass: (o) => this.handleBypassSelect(o),
    });
    this.landTab = new LandTab({
      onSelectBypass: (o) => this.handleBypassSelect(o),
    });
    this.impactTab = new CountryImpactTab({
      onDrillSideways: (hs2) => this.handleDrillSideways(hs2),
    });

    this.contentEl = document.createElement('div');
    this.contentEl.className = 're-content';
    this.showActiveTab();

    body.append(this.leftRail.element, this.contentEl);
    return body;
  }

  // ─── Event handlers ────────────────────────────────────────────────────

  private handleFromCommit(iso2: string): void {
    this.state = { ...this.state, fromIso2: iso2 };
    this.writeStateToUrl();
    this.fromPicker.setValue(iso2);
    if (!this.state.toIso2) this.toPicker.focusInput();
    else if (!this.state.hs2) this.hs2Picker.focusInput();
    else this.scheduleFetch();
  }

  private handleToCommit(iso2: string): void {
    this.state = { ...this.state, toIso2: iso2 };
    this.writeStateToUrl();
    this.toPicker.setValue(iso2);
    if (!this.state.fromIso2) this.fromPicker.focusInput();
    else if (!this.state.hs2) this.hs2Picker.focusInput();
    else this.scheduleFetch();
  }

  private handleHs2Commit(hs2: string): void {
    this.state = { ...this.state, hs2 };
    this.writeStateToUrl();
    this.hs2Picker.setValue(hs2);
    if (!this.cargoManual) {
      const inferred = inferCargoFromHs2(hs2);
      this.cargoDropdown.setAutoInferred(inferred);
    }
    if (this.isQueryComplete()) this.scheduleFetch();
  }

  private handleCargoChange(cargo: ExplorerCargo, manual: boolean): void {
    this.cargoManual = manual;
    this.state = { ...this.state, cargo };
    this.writeStateToUrl();
    if (this.isQueryComplete()) this.scheduleFetch();
  }

  private setTab(n: ExplorerTab): void {
    if (n === this.state.tab) return;
    this.state = { ...this.state, tab: n };
    this.writeStateToUrl();
    this.trackEvent('route-explorer:tab-switch', { tab: n });
    if (this.tabStrip) {
      const buttons = this.tabStrip.querySelectorAll<HTMLButtonElement>('.re-tabstrip__tab');
      buttons.forEach((b) => {
        const isActive = Number.parseInt(b.dataset.tab ?? '0', 10) === n;
        b.classList.toggle('re-tabstrip__tab--active', isActive);
        b.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
    }
    this.showActiveTab();
  }

  private handleDrillSideways(hs2: string): void {
    this.state = { ...this.state, hs2 };
    this.writeStateToUrl();
    this.hs2Picker.setValue(hs2);
    if (!this.cargoManual) {
      this.cargoDropdown.setAutoInferred(inferCargoFromHs2(hs2));
    }
    this.setTab(1);
    this.scheduleFetch();
  }

  private swapFromTo(): void {
    const newFrom = this.state.toIso2;
    const newTo = this.state.fromIso2;
    this.state = { ...this.state, fromIso2: newFrom, toIso2: newTo };
    this.writeStateToUrl();
    this.fromPicker.setValue(newFrom);
    this.toPicker.setValue(newTo);
    if (this.isQueryComplete()) this.scheduleFetch();
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
    (document.activeElement as HTMLElement | null)?.blur();
  }

  private handleGlobalKeydown = (e: KeyboardEvent): void => {
    if (!this.isOpen || !this.root) return;

    if (e.key === 'Escape') {
      if (this.helpOverlay) {
        e.preventDefault(); e.stopPropagation();
        this.closeHelp();
        return;
      }
      if (this.isFormControlFocused()) return;
      e.preventDefault(); e.stopPropagation();
      this.close();
      return;
    }

    if ((e.metaKey || e.ctrlKey) && e.key === ',') {
      e.preventDefault();
      this.copyShareUrl();
      return;
    }


    if (this.isFormControlFocused()) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    switch (e.key) {
      case '1': case '2': case '3': case '4':
        e.preventDefault();
        this.setTab(Number.parseInt(e.key, 10) as ExplorerTab);
        return;
      case 'F': case 'f': e.preventDefault(); this.fromPicker.focusInput(); return;
      case 'T': case 't': e.preventDefault(); this.toPicker.focusInput(); return;
      case 'P': case 'p': e.preventDefault(); this.hs2Picker.focusInput(); return;
      case 'S': case 's': e.preventDefault(); this.swapFromTo(); return;
      case ' ':
        e.preventDefault();
        if (this.laneData?.primaryRouteId && this.mapRef) {
          this.mapRef.clearHighlightedRoute();
          this.mapRef.highlightRoute([this.laneData.primaryRouteId]);
        }
        return;
      case '?': e.preventDefault(); this.openHelp(); return;
      default: return;
    }
  };


  private focusInitial(): void {
    if (!this.state.fromIso2) this.fromPicker.focusInput();
    else if (!this.state.toIso2) this.toPicker.focusInput();
    else if (!this.state.hs2) this.hs2Picker.focusInput();
    else this.fromPicker.focusInput();
  }

  // ─── Help / Share ─────────────────────────────────────────────────────

  private helpPriorFocus: HTMLElement | null = null;

  private openHelp(): void {
    if (!this.root || this.helpOverlay) return;
    this.helpPriorFocus = (document.activeElement as HTMLElement) ?? null;
    this.helpOverlay = new KeyboardHelp({ onClose: () => this.closeHelp() });
    this.root.append(this.helpOverlay.element);
    const closeBtn = this.helpOverlay.element.querySelector<HTMLButtonElement>('.re-help__close');
    closeBtn?.focus();
  }

  private closeHelp(): void {
    if (!this.helpOverlay) return;
    this.helpOverlay.element.remove();
    this.helpOverlay = null;
    if (this.helpPriorFocus && document.body.contains(this.helpPriorFocus)) {
      this.helpPriorFocus.focus();
    }
    this.helpPriorFocus = null;
  }

  private copyShareUrl(): void {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    const serialized = serializeExplorerUrl(this.state);
    if (serialized) url.searchParams.set('explorer', serialized);
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(url.toString());
      this.trackEvent('route-explorer:share-copied');
    }
  }

  // ─── Analytics ─────────────────────────────────────────────────────────

  private get tier(): 'pro' | 'free' {
    return hasPremiumAccess(getAuthState()) ? 'pro' : 'free';
  }

  private trackEvent(event: UmamiEvent, props?: Record<string, unknown>): void {
    track(event, { tier: this.tier, ...props });
  }

  // ─── Test hook ────────────────────────────────────────────────────────

  private installTestHook(): void {
    if (typeof window === 'undefined') return;
    const isDev = (() => {
      try { return Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV); } catch { return false; }
    })();
    if (!isDev) return;
    if (!window.__routeExplorerTestHook) window.__routeExplorerTestHook = {};
  }
}

let singleton: RouteExplorer | null = null;
export function getRouteExplorer(): RouteExplorer {
  if (!singleton) singleton = new RouteExplorer();
  return singleton;
}
