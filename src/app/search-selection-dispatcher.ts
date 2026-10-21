import type { AppContext } from '@/app/app-context';
import type { SearchResult } from '@/components/search-types';
import type { SearchMatch } from '@/components/search-types';
import type { MapView, TimeRange } from '@/components/MapContainer';
import type { Command } from '@/config/commands';
import { LAYER_KEY_MAP, LAYER_PRESETS } from '@/config/commands';
import { STORAGE_KEYS } from '@/config';
import {
  getAllowedLayerKeys,
  isLayerCommandAllowed,
  isLayerEntitled,
  isLayerExecutable,
  type MapVariant,
  type RendererKind,
} from '@/config/map-layer-definitions';
import { TIER1_COUNTRIES } from '@/services/country-instability';
import { throwIfWebMcpAborted } from '@/services/webmcp';
import { CURATED_COUNTRIES } from '@/config/countries';
import { getCountryMapFocus } from '@/app/country-map-focus';
import { INTEL_HOTSPOTS, CONFLICT_ZONES } from '@/config/geo';
import type { NewsItem, MapLayers, MilitaryBase } from '@/types';
import { UNDERSEA_CABLES, NUCLEAR_FACILITIES } from '@/config/geo-map';
import { PIPELINES } from '@/config/pipelines';
import { AI_DATA_CENTERS } from '@/config/ai-datacenters';
import { GAMMA_IRRADIATORS } from '@/config/irradiators';
import { TECH_COMPANIES } from '@/config/tech-companies';
import { AI_RESEARCH_LABS } from '@/config/ai-research-labs';
import { STARTUP_ECOSYSTEMS } from '@/config/startup-ecosystems';
import { TECH_HQS, ACCELERATORS } from '@/config/tech-geo';
import { STOCK_EXCHANGES, FINANCIAL_CENTERS, CENTRAL_BANKS, COMMODITY_HUBS } from '@/config/finance-geo';

export interface SearchSelectionDispatcherBindings {
  ctx: AppContext;
  getVariant(): string;
  hasPremiumAccess(): boolean;
  openCountryBriefByCode(
    code: string,
    country: string,
    options?: { trackDetailedAnalytics?: boolean; signal?: AbortSignal },
  ): boolean | Promise<boolean>;
  enablePanel(panelId: string, options?: { trackDetailedAnalytics?: boolean }): boolean;
  trackSearchResultSelected(type: string, options?: { includeAttribution?: boolean }): void;
  trackCountrySelected(code: string, name: string, source: string): void;
  runWithAgentAnalyticsSuppressed<T>(callback: () => T): T;
  suppressNextAgentPanelView(panelId: string): void;
  resolveExecutableNewsPanel(
    link: string,
  ): [string, AppContext['newsPanels'][string]] | null;
  saveToStorage(key: string, value: unknown): void;
  setTheme(theme: 'dark' | 'light'): void;
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

interface SelectionOptions {
  trackDetailedAnalytics?: boolean;
  programmaticEpoch?: number;
  signal?: AbortSignal;
  cancelPanelWaitOnNextHumanSelection?: boolean;
}

/** Applies shared CMD+K and WebMCP selections to visible dashboard surfaces. */
export class SearchSelectionDispatcher {
  // One deadline bounds a deferred-panel acknowledgement without trying to
  // mirror PanelLayoutManager's load/retry timing. The MutationObserver below
  // resolves as soon as the real (non-shell) panel is connected, including
  // when an individual dynamic import takes several seconds before retrying.
  // Thirty seconds covers PanelLayout's full retry budget even when each of
  // its four dynamic-import attempts takes several seconds to settle, while
  // still preventing a permanently stuck import from hanging the tool call.
  private static readonly DEFERRED_PANEL_PRESENTATION_TIMEOUT_MS = 30_000;
  private highlightTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
  private programmaticEpoch = 0;
  private activeProgrammaticAbort: AbortController | null = null;
  private readonly programmaticTimers = new Map<ReturnType<typeof setTimeout>, () => void>();
  private readonly programmaticMatchResolvers = new Map<number, () => SearchMatch | undefined>();
  private readonly activePanelWaitCancels = new Set<() => void>();
  private activeHumanPanelWaitAbort: AbortController | null = null;

  public constructor(private readonly bindings: SearchSelectionDispatcherBindings) {}

  public destroy(): void {
    this.cancelPendingProgrammaticSelection();
    this.cancelPendingHumanPanelWait();
    for (const cancel of this.activePanelWaitCancels) cancel();
    this.activePanelWaitCancels.clear();
  }

  public cancelPendingProgrammaticSelection(): void {
    this.activeProgrammaticAbort?.abort();
    this.activeProgrammaticAbort = null;
    this.programmaticEpoch += 1;
    this.programmaticMatchResolvers.clear();
    for (const [timer, cancel] of this.programmaticTimers) {
      this.bindings.clearTimeout(timer);
      cancel();
    }
    this.programmaticTimers.clear();
  }

  public handleSearchResult(result: SearchResult): boolean | Promise<boolean> {
    this.cancelPendingProgrammaticSelection();
    this.cancelPendingHumanPanelWait();
    return this.applySearchResult(result, { cancelPanelWaitOnNextHumanSelection: true });
  }

  public handleCommand(command: Command): boolean | Promise<boolean> {
    this.cancelPendingProgrammaticSelection();
    this.cancelPendingHumanPanelWait();
    return this.applyCommand(command, { cancelPanelWaitOnNextHumanSelection: true });
  }

  public async selectProgrammaticMatch(
    match: SearchMatch,
    resolveCommitMatch: () => SearchMatch | undefined = () => match,
    signal?: AbortSignal,
  ): Promise<boolean> {
    this.cancelPendingProgrammaticSelection();
    throwIfWebMcpAborted(signal);
    const epoch = this.programmaticEpoch;
    const selectionAbort = new AbortController();
    this.activeProgrammaticAbort = selectionAbort;
    this.programmaticMatchResolvers.set(epoch, resolveCommitMatch);
    const handleAbort = (): void => {
      if (epoch !== this.programmaticEpoch) return;
      selectionAbort.abort(signal?.reason);
      this.cancelPendingProgrammaticSelection();
    };
    signal?.addEventListener('abort', handleAbort, { once: true });
    try {
      const selection = this.bindings.runWithAgentAnalyticsSuppressed(() => {
        const options = {
          trackDetailedAnalytics: false,
          programmaticEpoch: epoch,
          signal: selectionAbort.signal,
        };
        return match.kind === 'command'
          ? this.applyCommand(match.command, options)
          : this.applySearchResult(match.result, options);
      });
      const selectionWasAsync = typeof (selection as PromiseLike<boolean>)?.then === 'function';
      const selected = selectionWasAsync ? await selection : selection as boolean;
      throwIfWebMcpAborted(signal);
      if (
        selectionAbort.signal.aborted
        || epoch !== this.programmaticEpoch
      ) return false;
      // Async presentation can outlive its issued target, so revalidate after
      // it settles. A synchronous toggle has already run to completion: its
      // own mutation may intentionally make the command non-executable (for
      // example a free user healing a stale enabled locked layer), and must
      // not retroactively turn that successful outcome into a denial.
      if (
        selectionWasAsync
        && !this.programmaticMatchResolvers.get(epoch)?.()
      ) return false;
      return selected;
    } catch (error) {
      throwIfWebMcpAborted(signal);
      if (selectionAbort.signal.aborted) return false;
      throw error;
    } finally {
      this.programmaticMatchResolvers.delete(epoch);
      if (this.activeProgrammaticAbort === selectionAbort) {
        this.activeProgrammaticAbort = null;
      }
      signal?.removeEventListener('abort', handleAbort);
    }
  }

  private applySearchResult(
    result: SearchResult,
    options: SelectionOptions = {},
  ): boolean | Promise<boolean> {
    const trackDetailedAnalytics = options.trackDetailedAnalytics !== false;
    const epoch = options.programmaticEpoch;
    const ctx = this.bindings.ctx;
    this.bindings.trackSearchResultSelected(result.type, {
      includeAttribution: trackDetailedAnalytics,
    });
    switch (result.type) {
      case 'news': {
        const item = result.data as NewsItem;
        const target = this.bindings.resolveExecutableNewsPanel(item.link);
        if (!target) return false;
        const [targetPanelId] = target;
        if (!this.scrollToPanel(targetPanelId, trackDetailedAnalytics)) return false;
        return this.schedule((commitMatch) => {
          const commitItem = this.resolveScheduledResultData<NewsItem>(result, commitMatch);
          if (!commitItem) return false;
          const commitTarget = this.bindings.resolveExecutableNewsPanel(commitItem.link);
          if (!commitTarget) return false;
          commitTarget[1].scrollToNewsItem(commitItem.link);
          return true;
        }, 300, epoch);
      }
      case 'hotspot': {
        return this.schedule((commitMatch) => {
          const hotspot = this.resolveScheduledResultData<typeof INTEL_HOTSPOTS[0]>(
            result,
            commitMatch,
          );
          if (!hotspot) return false;
          ctx.map?.setView('global');
          ctx.map?.triggerHotspotClick(hotspot.id);
        }, 300, epoch);
      }
      case 'conflict': {
        return this.schedule((commitMatch) => {
          const conflict = this.resolveScheduledResultData<typeof CONFLICT_ZONES[0]>(
            result,
            commitMatch,
          );
          if (!conflict) return false;
          ctx.map?.setView('global');
          ctx.map?.triggerConflictClick(conflict.id);
        }, 300, epoch);
      }
      case 'market':
        return epoch === undefined
          ? this.scrollToPanel('markets', trackDetailedAnalytics)
          : this.scrollToPanelWhenReady(
            'markets',
            trackDetailedAnalytics,
            epoch,
            options.signal,
          );
      case 'prediction':
        return epoch === undefined
          ? this.scrollToPanel('polymarket', trackDetailedAnalytics)
          : this.scrollToPanelWhenReady(
            'polymarket',
            trackDetailedAnalytics,
            epoch,
            options.signal,
          );
      case 'base': {
        return this.schedule((commitMatch) => {
          const base = this.resolveScheduledResultData<MilitaryBase>(result, commitMatch);
          if (!base) return false;
          ctx.map?.setView('global');
          ctx.map?.triggerBaseClick(base.id);
        }, 300, epoch);
      }
      case 'pipeline': {
        return this.schedule((commitMatch) => {
          const pipeline = this.resolveScheduledResultData<typeof PIPELINES[0]>(
            result,
            commitMatch,
          );
          if (!pipeline) return false;
          ctx.map?.setView('global');
          ctx.map?.enableLayer('pipelines');
          ctx.mapLayers.pipelines = true;
          ctx.map?.triggerPipelineClick(pipeline.id);
        }, 300, epoch);
      }
      case 'cable': {
        return this.schedule((commitMatch) => {
          const cable = this.resolveScheduledResultData<typeof UNDERSEA_CABLES[0]>(
            result,
            commitMatch,
          );
          if (!cable) return false;
          ctx.map?.setView('global');
          ctx.map?.enableLayer('cables');
          ctx.mapLayers.cables = true;
          ctx.map?.triggerCableClick(cable.id);
        }, 300, epoch);
      }
      case 'datacenter': {
        return this.schedule((commitMatch) => {
          const dc = this.resolveScheduledResultData<typeof AI_DATA_CENTERS[0]>(
            result,
            commitMatch,
          );
          if (!dc) return false;
          ctx.map?.setView('global');
          ctx.map?.enableLayer('datacenters');
          ctx.mapLayers.datacenters = true;
          ctx.map?.triggerDatacenterClick(dc.id);
        }, 300, epoch);
      }
      case 'nuclear': {
        return this.schedule((commitMatch) => {
          const facility = this.resolveScheduledResultData<typeof NUCLEAR_FACILITIES[0]>(
            result,
            commitMatch,
          );
          if (!facility) return false;
          ctx.map?.setView('global');
          ctx.map?.enableLayer('nuclear');
          ctx.mapLayers.nuclear = true;
          ctx.map?.triggerNuclearClick(facility.id);
        }, 300, epoch);
      }
      case 'irradiator': {
        return this.schedule((commitMatch) => {
          const irradiator = this.resolveScheduledResultData<typeof GAMMA_IRRADIATORS[0]>(
            result,
            commitMatch,
          );
          if (!irradiator) return false;
          ctx.map?.setView('global');
          ctx.map?.enableLayer('irradiators');
          ctx.mapLayers.irradiators = true;
          ctx.map?.triggerIrradiatorClick(irradiator.id);
        }, 300, epoch);
      }
      case 'earthquake':
      case 'outage':
        ctx.map?.setView('global');
        break;
      case 'techcompany': {
        return this.schedule((commitMatch) => {
          const company = this.resolveScheduledResultData<typeof TECH_COMPANIES[0]>(
            result,
            commitMatch,
          );
          if (!company) return false;
          ctx.map?.setView('global');
          ctx.map?.enableLayer('techHQs');
          ctx.mapLayers.techHQs = true;
          ctx.map?.setCenter(company.lat, company.lon, 4);
        }, 300, epoch);
      }
      case 'ailab': {
        return this.schedule((commitMatch) => {
          const lab = this.resolveScheduledResultData<typeof AI_RESEARCH_LABS[0]>(
            result,
            commitMatch,
          );
          if (!lab) return false;
          ctx.map?.setView('global');
          ctx.map?.setCenter(lab.lat, lab.lon, 4);
        }, 300, epoch);
      }
      case 'startup': {
        return this.schedule((commitMatch) => {
          const ecosystem = this.resolveScheduledResultData<typeof STARTUP_ECOSYSTEMS[0]>(
            result,
            commitMatch,
          );
          if (!ecosystem) return false;
          ctx.map?.setView('global');
          ctx.map?.enableLayer('startupHubs');
          ctx.mapLayers.startupHubs = true;
          ctx.map?.setCenter(ecosystem.lat, ecosystem.lon, 4);
        }, 300, epoch);
      }
      case 'techevent': {
        return this.schedule((commitMatch) => {
          const event = this.resolveScheduledResultData<{ lat: number; lng: number }>(
            result,
            commitMatch,
          );
          if (!event) return false;
          ctx.map?.setView('global');
          ctx.map?.enableLayer('techEvents');
          ctx.mapLayers.techEvents = true;
          ctx.map?.setCenter(event.lat, event.lng, 5);
        }, 300, epoch);
      }
      case 'techhq': {
        return this.schedule((commitMatch) => {
          const hq = this.resolveScheduledResultData<typeof TECH_HQS[0]>(result, commitMatch);
          if (!hq) return false;
          ctx.map?.setView('global');
          ctx.map?.enableLayer('techHQs');
          ctx.mapLayers.techHQs = true;
          ctx.map?.setCenter(hq.lat, hq.lon, 4);
        }, 300, epoch);
      }
      case 'accelerator': {
        return this.schedule((commitMatch) => {
          const accelerator = this.resolveScheduledResultData<typeof ACCELERATORS[0]>(
            result,
            commitMatch,
          );
          if (!accelerator) return false;
          ctx.map?.setView('global');
          ctx.map?.enableLayer('accelerators');
          ctx.mapLayers.accelerators = true;
          ctx.map?.setCenter(accelerator.lat, accelerator.lon, 4);
        }, 300, epoch);
      }
      case 'exchange': {
        return this.schedule((commitMatch) => {
          const exchange = this.resolveScheduledResultData<typeof STOCK_EXCHANGES[0]>(
            result,
            commitMatch,
          );
          if (!exchange) return false;
          ctx.map?.setView('global');
          ctx.map?.enableLayer('stockExchanges');
          ctx.mapLayers.stockExchanges = true;
          ctx.map?.setCenter(exchange.lat, exchange.lon, 4);
        }, 300, epoch);
      }
      case 'financialcenter': {
        return this.schedule((commitMatch) => {
          const center = this.resolveScheduledResultData<typeof FINANCIAL_CENTERS[0]>(
            result,
            commitMatch,
          );
          if (!center) return false;
          ctx.map?.setView('global');
          ctx.map?.enableLayer('financialCenters');
          ctx.mapLayers.financialCenters = true;
          ctx.map?.setCenter(center.lat, center.lon, 4);
        }, 300, epoch);
      }
      case 'centralbank': {
        return this.schedule((commitMatch) => {
          const bank = this.resolveScheduledResultData<typeof CENTRAL_BANKS[0]>(
            result,
            commitMatch,
          );
          if (!bank) return false;
          ctx.map?.setView('global');
          ctx.map?.enableLayer('centralBanks');
          ctx.mapLayers.centralBanks = true;
          ctx.map?.setCenter(bank.lat, bank.lon, 4);
        }, 300, epoch);
      }
      case 'commodityhub': {
        return this.schedule((commitMatch) => {
          const hub = this.resolveScheduledResultData<typeof COMMODITY_HUBS[0]>(
            result,
            commitMatch,
          );
          if (!hub) return false;
          ctx.map?.setView('global');
          ctx.map?.enableLayer('commodityHubs');
          ctx.mapLayers.commodityHubs = true;
          ctx.map?.setCenter(hub.lat, hub.lon, 4);
        }, 300, epoch);
      }
      case 'country': {
        const { code, name } = result.data as { code: string; name: string };
        if (trackDetailedAnalytics) this.bindings.trackCountrySelected(code, name, 'search');
        return this.bindings.openCountryBriefByCode(code, name, {
          trackDetailedAnalytics,
          ...(options.signal ? { signal: options.signal } : {}),
        });
      }
      case 'flight': {
        return this.schedule((commitMatch) => {
          const flight = this.resolveScheduledResultData<{
            kind: string;
            lat: number;
            lon: number;
            layer: keyof MapLayers;
          }>(result, commitMatch);
          if (!flight) return false;
          const { lat, lon, layer } = flight;
          ctx.map?.enableLayer(layer);
          ctx.mapLayers[layer] = true;
          ctx.map?.setCenter(lat, lon, 9);
        }, 300, epoch);
      }
    }
    return true;
  }

  private resolveScheduledResultData<T>(
    issuedResult: SearchResult,
    commitMatch?: SearchMatch,
  ): T | null {
    if (commitMatch === undefined) return issuedResult.data as T;
    if (
      commitMatch.kind !== 'result'
      || commitMatch.result.type !== issuedResult.type
      || commitMatch.result.id !== issuedResult.id
    ) return null;
    return commitMatch.result.data as T;
  }

  private applyCommand(
    command: Command,
    options: SelectionOptions = {},
  ): boolean | Promise<boolean> {
    const trackDetailedAnalytics = options.trackDetailedAnalytics !== false;
    const epoch = options.programmaticEpoch;
    const ctx = this.bindings.ctx;
    const colonIndex = command.id.indexOf(':');
    if (colonIndex === -1) return false;
    const category = command.id.slice(0, colonIndex);
    const action = command.id.slice(colonIndex + 1);

    switch (category) {
      case 'nav': {
        ctx.map?.setView(action as MapView);
        const select = document.getElementById('regionSelect') as HTMLSelectElement;
        if (select) select.value = action;
        break;
      }
      case 'layers': {
        const allowed = getAllowedLayerKeys(this.variant());
        const renderer: RendererKind = ctx.map?.isGlobeMode?.()
          ? 'globe'
          : (ctx.map?.isDeckGLActive?.() ? 'deck' : 'svg');
        const executable = (key: keyof MapLayers): boolean => allowed.has(key)
          && isLayerExecutable(key, renderer)
          && isLayerEntitled(key, this.bindings.hasPremiumAccess());
        if (action === 'all') {
          for (const key of Object.keys(ctx.mapLayers)) {
            ctx.mapLayers[key as keyof MapLayers] = executable(key as keyof MapLayers);
          }
        } else if (action === 'none') {
          for (const key of Object.keys(ctx.mapLayers)) ctx.mapLayers[key as keyof MapLayers] = false;
        } else {
          const preset = LAYER_PRESETS[action];
          if (preset) {
            for (const key of Object.keys(ctx.mapLayers)) ctx.mapLayers[key as keyof MapLayers] = false;
            for (const layer of preset) if (executable(layer)) ctx.mapLayers[layer] = true;
          }
        }
        this.bindings.saveToStorage(STORAGE_KEYS.mapLayers, ctx.mapLayers);
        ctx.map?.setLayers(ctx.mapLayers);
        break;
      }
      case 'layer': {
        const layer = (LAYER_KEY_MAP[action] || action) as keyof MapLayers;
        if (!(layer in ctx.mapLayers) || !getAllowedLayerKeys(this.variant()).has(layer)) return false;
        const renderer: RendererKind = ctx.map?.isGlobeMode?.()
          ? 'globe'
          : (ctx.map?.isDeckGLActive?.() ? 'deck' : 'svg');
        const deckGL = ctx.map?.isDeckGLActive?.() ?? false;
        const current = ctx.mapLayers[layer];
        if (!isLayerCommandAllowed(layer, current, renderer, this.bindings.hasPremiumAccess())) {
          return false;
        }
        let next = !current;
        if (next && layer === 'resilienceScore' && !deckGL) next = false;
        ctx.mapLayers[layer] = next;
        this.bindings.saveToStorage(STORAGE_KEYS.mapLayers, ctx.mapLayers);
        if (next) ctx.map?.enableLayer(layer);
        else ctx.map?.setLayers(ctx.mapLayers);
        break;
      }
      case 'panel': {
        const [panelId, subTab] = action.split('@');
        if (!panelId) return false;
        const config = ctx.panelSettings[panelId];
        if (config && !config.enabled) {
          if (!this.bindings.enablePanel(panelId, { trackDetailedAnalytics })) return false;
          const scrolled = this.scrollToPanelWhenReady(
            panelId,
            trackDetailedAnalytics,
            epoch,
            options.signal,
            options.cancelPanelWaitOnNextHumanSelection,
          );
          if (!subTab) return scrolled;
          return this.dispatchPanelTabAfterPresentation(scrolled, panelId, subTab, epoch);
        }
        const scrolled = epoch === undefined
          ? this.scrollToPanel(panelId, trackDetailedAnalytics)
          : this.scrollToPanelWhenReady(
            panelId,
            trackDetailedAnalytics,
            epoch,
            options.signal,
          );
        if (!subTab) return scrolled;
        return this.dispatchPanelTabAfterPresentation(scrolled, panelId, subTab, epoch);
      }
      case 'view':
        if (action === 'dark' || action === 'light') {
          this.bindings.setTheme(action);
        } else if (action === 'fullscreen') {
          if (document.fullscreenElement) {
            try { void document.exitFullscreen()?.catch(() => {}); } catch {}
          } else {
            const element = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
            if (element.requestFullscreen) {
              try { void element.requestFullscreen()?.catch(() => {}); } catch {}
            } else if (element.webkitRequestFullscreen) {
              try { element.webkitRequestFullscreen(); } catch {}
            }
          }
        } else if (action === 'settings') {
          ctx.unifiedSettings?.open();
        } else if (action === 'refresh') {
          window.location.reload();
        } else if (action === 'resilience') {
          const layer = 'resilienceScore' as keyof MapLayers;
          if (!getAllowedLayerKeys(this.variant()).has(layer)) return false;
          const current = ctx.mapLayers[layer];
          const renderer: RendererKind = ctx.map?.isGlobeMode?.()
            ? 'globe'
            : (ctx.map?.isDeckGLActive?.() ? 'deck' : 'svg');
          const deckGL = ctx.map?.isDeckGLActive?.() ?? false;
          if (!isLayerCommandAllowed(layer, current, renderer, this.bindings.hasPremiumAccess())) {
            return false;
          }
          let next = !current;
          if (next && !deckGL) next = false;
          ctx.mapLayers[layer] = next;
          this.bindings.saveToStorage(STORAGE_KEYS.mapLayers, ctx.mapLayers);
          if (next) ctx.map?.enableLayer(layer);
          else ctx.map?.setLayers(ctx.mapLayers);
        } else if (action === 'route-explorer') {
          void import('@/components/RouteExplorer/RouteExplorer').then((module) => {
            const explorer = module.getRouteExplorer();
            explorer.setMap(ctx.map);
            explorer.open();
          });
        }
        break;
      case 'time':
        ctx.map?.setTimeRange(action as TimeRange);
        break;
      case 'country': {
        const name = TIER1_COUNTRIES[action]
          || CURATED_COUNTRIES[action]?.name
          || new Intl.DisplayNames(['en'], { type: 'region' }).of(action)
          || action;
        if (trackDetailedAnalytics) this.bindings.trackCountrySelected(action, name, 'command');
        return this.bindings.openCountryBriefByCode(action, name, {
          trackDetailedAnalytics,
          ...(options.signal ? { signal: options.signal } : {}),
        });
      }
      case 'country-map': {
        const focus = getCountryMapFocus(action);
        if (focus) {
          return this.schedule(() => {
            ctx.map?.setView('global');
            ctx.map?.setCenter(focus.lat, focus.lon, focus.zoom);
          }, 300, epoch);
        }
        break;
      }
    }
    return true;
  }

  private async scrollToPanelWhenReady(
    panelId: string,
    trackDetailedAnalytics = true,
    epoch?: number,
    signal?: AbortSignal,
    cancelOnNextHumanSelection = false,
  ): Promise<boolean> {
    let panel = this.findConnectedPanel(panelId);
    if (panel?.isConnected) {
      if (!trackDetailedAnalytics) this.bindings.suppressNextAgentPanelView(panelId);
      panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
      this.applyHighlight(panel);
      return true;
    }
    const deferredShell = document.querySelector(
      `[data-panel="${panelId}"][data-deferred-panel]`,
    );
    if (deferredShell?.isConnected) {
      deferredShell.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    const humanPanelWaitAbort = cancelOnNextHumanSelection ? new AbortController() : null;
    if (humanPanelWaitAbort) this.activeHumanPanelWaitAbort = humanPanelWaitAbort;
    try {
      panel = await this.waitForConnectedPanel(
        panelId,
        epoch,
        humanPanelWaitAbort?.signal ?? signal,
      );
    } finally {
      if (this.activeHumanPanelWaitAbort === humanPanelWaitAbort) {
        this.activeHumanPanelWaitAbort = null;
      }
    }
    if (!panel || !this.isProgrammaticSelectionCurrent(epoch)) return false;
    // The initial privacy mark may expire while a slow lazy import exhausts a
    // retry. Re-arm it at the actual presentation boundary so the eventual
    // scroll/view event is still attributed to the agent-safe path.
    if (!trackDetailedAnalytics) this.bindings.suppressNextAgentPanelView(panelId);
    panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    this.applyHighlight(panel);
    return true;
  }

  private cancelPendingHumanPanelWait(): void {
    this.activeHumanPanelWaitAbort?.abort();
    this.activeHumanPanelWaitAbort = null;
  }

  private dispatchPanelTabAfterPresentation(
    presentation: boolean | Promise<boolean>,
    panelId: string,
    tab: string,
    epoch?: number,
  ): boolean | Promise<boolean> {
    if (panelId !== 'consumer-prices') return presentation;
    const dispatch = (): boolean => {
      if (!this.isProgrammaticSelectionCurrent(epoch) || !this.findConnectedPanel(panelId)) {
        return false;
      }
      window.dispatchEvent(new CustomEvent('wm-consumer-prices-open-tab', { detail: { tab } }));
      return true;
    };
    return typeof presentation === 'boolean'
      ? presentation && dispatch()
      : presentation.then((presented) => presented && dispatch());
  }

  private findConnectedPanel(panelId: string): Element | null {
    const panel = document.querySelector(`[data-panel="${panelId}"]:not([data-deferred-panel])`);
    return panel?.isConnected ? panel : null;
  }

  private isProgrammaticSelectionCurrent(epoch?: number): boolean {
    return epoch === undefined
      || (epoch === this.programmaticEpoch && Boolean(this.programmaticMatchResolvers.get(epoch)?.()));
  }

  private waitForConnectedPanel(
    panelId: string,
    epoch?: number,
    signal?: AbortSignal,
  ): Promise<Element | null> {
    const existing = this.findConnectedPanel(panelId);
    if (existing) return Promise.resolve(existing);
    if (
      signal?.aborted
      || !this.isProgrammaticSelectionCurrent(epoch)
    ) {
      return Promise.resolve(null);
    }

    return new Promise<Element | null>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let observer: MutationObserver | null = null;
      let cancelWait = (): void => {};
      const finish = (panel: Element | null): void => {
        if (settled) return;
        settled = true;
        this.activePanelWaitCancels.delete(cancelWait);
        observer?.disconnect();
        signal?.removeEventListener('abort', handleAbort);
        if (timer !== undefined) {
          this.bindings.clearTimeout(timer);
          if (epoch !== undefined) this.programmaticTimers.delete(timer);
        }
        resolve(panel);
      };
      const handleAbort = (): void => finish(null);
      cancelWait = (): void => finish(null);
      this.activePanelWaitCancels.add(cancelWait);
      const observationRoot = document.body ?? document.documentElement;

      if (typeof MutationObserver !== 'undefined' && observationRoot) {
        observer = new MutationObserver(() => {
          const panel = this.findConnectedPanel(panelId);
          if (panel) finish(panel);
        });
      }
      observer?.observe(observationRoot, { childList: true, subtree: true });
      signal?.addEventListener('abort', handleAbort, { once: true });
      timer = this.bindings.setTimeout(
        () => finish(this.findConnectedPanel(panelId)),
        SearchSelectionDispatcher.DEFERRED_PANEL_PRESENTATION_TIMEOUT_MS,
      );
      if (epoch !== undefined) {
        this.programmaticTimers.set(timer, () => finish(null));
      }
      // Close the query/observe race: the panel may have mounted immediately
      // before the observer was attached.
      const mounted = this.findConnectedPanel(panelId);
      if (mounted) finish(mounted);
    });
  }

  private scrollToPanel(panelId: string, trackDetailedAnalytics = true): boolean {
    if (!trackDetailedAnalytics) this.bindings.suppressNextAgentPanelView(panelId);
    const panel = document.querySelector(`[data-panel="${panelId}"]`);
    if (!panel) return false;
    panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    this.applyHighlight(panel);
    return true;
  }

  private applyHighlight(element: Element): void {
    const previous = this.highlightTimers.get(element);
    if (previous) this.bindings.clearTimeout(previous);
    element.classList.remove('search-highlight');
    void (element as HTMLElement).offsetWidth;
    element.classList.add('search-highlight');
    this.highlightTimers.set(element, this.bindings.setTimeout(() => {
      element.classList.remove('search-highlight');
      this.highlightTimers.delete(element);
    }, 3100));
  }

  private schedule(
    callback: (match?: SearchMatch) => boolean | void | Promise<boolean | void>,
    delay: number,
    epoch?: number,
  ): boolean | Promise<boolean> {
    if (epoch === undefined) {
      this.bindings.setTimeout(() => { void callback(); }, delay);
      return true;
    }
    return new Promise<boolean>((resolve, reject) => {
      const timer = this.bindings.setTimeout(() => {
        this.programmaticTimers.delete(timer);
        try {
          if (epoch !== this.programmaticEpoch) {
            resolve(false);
            return;
          }
          const commitMatch = this.programmaticMatchResolvers.get(epoch)?.();
          if (!commitMatch) {
            resolve(false);
            return;
          }
          void Promise.resolve(callback(commitMatch)).then(
            (result) => resolve(result !== false),
            reject,
          );
        } catch (error) {
          reject(error);
        }
      }, delay);
      this.programmaticTimers.set(timer, () => resolve(false));
    });
  }

  private variant(): MapVariant {
    return (this.bindings.getVariant() || 'full') as MapVariant;
  }
}
