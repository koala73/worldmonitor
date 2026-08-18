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
import { CURATED_COUNTRIES } from '@/config/countries';
import { getCountryBbox } from '@/services/country-geometry';
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
    options?: { trackDetailedAnalytics?: boolean },
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
}

/** Applies shared CMD+K and WebMCP selections to visible dashboard surfaces. */
export class SearchSelectionDispatcher {
  private highlightTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
  private programmaticEpoch = 0;
  private readonly programmaticTimers = new Map<ReturnType<typeof setTimeout>, () => void>();

  public constructor(private readonly bindings: SearchSelectionDispatcherBindings) {}

  public destroy(): void {
    this.programmaticEpoch += 1;
    for (const [timer, cancel] of this.programmaticTimers) {
      this.bindings.clearTimeout(timer);
      cancel();
    }
    this.programmaticTimers.clear();
  }

  public handleSearchResult(result: SearchResult): boolean | Promise<boolean> {
    return this.applySearchResult(result);
  }

  public handleCommand(command: Command): boolean | Promise<boolean> {
    return this.applyCommand(command);
  }

  public async selectProgrammaticMatch(match: SearchMatch): Promise<boolean> {
    this.destroy();
    const epoch = this.programmaticEpoch;
    return await this.bindings.runWithAgentAnalyticsSuppressed(() => {
      const options = { trackDetailedAnalytics: false, programmaticEpoch: epoch };
      return match.kind === 'command'
        ? this.applyCommand(match.command, options)
        : this.applySearchResult(match.result, options);
    });
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
        const [targetPanelId, targetPanel] = target;
        this.scrollToPanel(targetPanelId, trackDetailedAnalytics);
        return this.schedule(() => targetPanel.scrollToNewsItem(item.link), 300, epoch);
      }
      case 'hotspot': {
        const hotspot = result.data as typeof INTEL_HOTSPOTS[0];
        return this.schedule(() => {
          ctx.map?.setView('global');
          ctx.map?.triggerHotspotClick(hotspot.id);
        }, 300, epoch);
      }
      case 'conflict': {
        const conflict = result.data as typeof CONFLICT_ZONES[0];
        return this.schedule(() => {
          ctx.map?.setView('global');
          ctx.map?.triggerConflictClick(conflict.id);
        }, 300, epoch);
      }
      case 'market':
        this.scrollToPanel('markets', trackDetailedAnalytics);
        break;
      case 'prediction':
        this.scrollToPanel('polymarket', trackDetailedAnalytics);
        break;
      case 'base': {
        const base = result.data as MilitaryBase;
        return this.schedule(() => {
          ctx.map?.setView('global');
          ctx.map?.triggerBaseClick(base.id);
        }, 300, epoch);
      }
      case 'pipeline': {
        const pipeline = result.data as typeof PIPELINES[0];
        return this.schedule(() => {
          ctx.map?.setView('global');
          ctx.map?.enableLayer('pipelines');
          ctx.mapLayers.pipelines = true;
          ctx.map?.triggerPipelineClick(pipeline.id);
        }, 300, epoch);
      }
      case 'cable': {
        const cable = result.data as typeof UNDERSEA_CABLES[0];
        return this.schedule(() => {
          ctx.map?.setView('global');
          ctx.map?.enableLayer('cables');
          ctx.mapLayers.cables = true;
          ctx.map?.triggerCableClick(cable.id);
        }, 300, epoch);
      }
      case 'datacenter': {
        const dc = result.data as typeof AI_DATA_CENTERS[0];
        return this.schedule(() => {
          ctx.map?.setView('global');
          ctx.map?.enableLayer('datacenters');
          ctx.mapLayers.datacenters = true;
          ctx.map?.triggerDatacenterClick(dc.id);
        }, 300, epoch);
      }
      case 'nuclear': {
        const facility = result.data as typeof NUCLEAR_FACILITIES[0];
        return this.schedule(() => {
          ctx.map?.setView('global');
          ctx.map?.enableLayer('nuclear');
          ctx.mapLayers.nuclear = true;
          ctx.map?.triggerNuclearClick(facility.id);
        }, 300, epoch);
      }
      case 'irradiator': {
        const irradiator = result.data as typeof GAMMA_IRRADIATORS[0];
        return this.schedule(() => {
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
        const company = result.data as typeof TECH_COMPANIES[0];
        return this.schedule(() => {
          ctx.map?.setView('global');
          ctx.map?.enableLayer('techHQs');
          ctx.mapLayers.techHQs = true;
          ctx.map?.setCenter(company.lat, company.lon, 4);
        }, 300, epoch);
      }
      case 'ailab': {
        const lab = result.data as typeof AI_RESEARCH_LABS[0];
        return this.schedule(() => {
          ctx.map?.setView('global');
          ctx.map?.setCenter(lab.lat, lab.lon, 4);
        }, 300, epoch);
      }
      case 'startup': {
        const ecosystem = result.data as typeof STARTUP_ECOSYSTEMS[0];
        return this.schedule(() => {
          ctx.map?.setView('global');
          ctx.map?.enableLayer('startupHubs');
          ctx.mapLayers.startupHubs = true;
          ctx.map?.setCenter(ecosystem.lat, ecosystem.lon, 4);
        }, 300, epoch);
      }
      case 'techevent': {
        const event = result.data as { lat: number; lng: number };
        return this.schedule(() => {
          ctx.map?.setView('global');
          ctx.map?.enableLayer('techEvents');
          ctx.mapLayers.techEvents = true;
          ctx.map?.setCenter(event.lat, event.lng, 5);
        }, 300, epoch);
      }
      case 'techhq': {
        const hq = result.data as typeof TECH_HQS[0];
        return this.schedule(() => {
          ctx.map?.setView('global');
          ctx.map?.enableLayer('techHQs');
          ctx.mapLayers.techHQs = true;
          ctx.map?.setCenter(hq.lat, hq.lon, 4);
        }, 300, epoch);
      }
      case 'accelerator': {
        const accelerator = result.data as typeof ACCELERATORS[0];
        return this.schedule(() => {
          ctx.map?.setView('global');
          ctx.map?.enableLayer('accelerators');
          ctx.mapLayers.accelerators = true;
          ctx.map?.setCenter(accelerator.lat, accelerator.lon, 4);
        }, 300, epoch);
      }
      case 'exchange': {
        const exchange = result.data as typeof STOCK_EXCHANGES[0];
        return this.schedule(() => {
          ctx.map?.setView('global');
          ctx.map?.enableLayer('stockExchanges');
          ctx.mapLayers.stockExchanges = true;
          ctx.map?.setCenter(exchange.lat, exchange.lon, 4);
        }, 300, epoch);
      }
      case 'financialcenter': {
        const center = result.data as typeof FINANCIAL_CENTERS[0];
        return this.schedule(() => {
          ctx.map?.setView('global');
          ctx.map?.enableLayer('financialCenters');
          ctx.mapLayers.financialCenters = true;
          ctx.map?.setCenter(center.lat, center.lon, 4);
        }, 300, epoch);
      }
      case 'centralbank': {
        const bank = result.data as typeof CENTRAL_BANKS[0];
        return this.schedule(() => {
          ctx.map?.setView('global');
          ctx.map?.enableLayer('centralBanks');
          ctx.mapLayers.centralBanks = true;
          ctx.map?.setCenter(bank.lat, bank.lon, 4);
        }, 300, epoch);
      }
      case 'commodityhub': {
        const hub = result.data as typeof COMMODITY_HUBS[0];
        return this.schedule(() => {
          ctx.map?.setView('global');
          ctx.map?.enableLayer('commodityHubs');
          ctx.mapLayers.commodityHubs = true;
          ctx.map?.setCenter(hub.lat, hub.lon, 4);
        }, 300, epoch);
      }
      case 'country': {
        const { code, name } = result.data as { code: string; name: string };
        if (trackDetailedAnalytics) this.bindings.trackCountrySelected(code, name, 'search');
        return this.bindings.openCountryBriefByCode(code, name, { trackDetailedAnalytics });
      }
      case 'flight': {
        const { lat, lon, layer } = result.data as {
          kind: string;
          lat: number;
          lon: number;
          layer: keyof MapLayers;
        };
        return this.schedule(() => {
          ctx.map?.enableLayer(layer);
          ctx.mapLayers[layer] = true;
          ctx.map?.setCenter(lat, lon, 9);
        }, 300, epoch);
      }
    }
    return true;
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
          this.scrollToPanelWhenReady(panelId, 12, trackDetailedAnalytics, epoch);
          if (subTab) this.dispatchPanelTab(panelId, subTab, 12, epoch);
          break;
        }
        this.scrollToPanel(panelId, trackDetailedAnalytics);
        if (subTab) this.dispatchPanelTab(panelId, subTab, 12, epoch);
        break;
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
        return this.bindings.openCountryBriefByCode(action, name, { trackDetailedAnalytics });
      }
      case 'country-map': {
        const bbox = getCountryBbox(action);
        if (bbox) {
          const [minLon, minLat, maxLon, maxLat] = bbox;
          const lat = (minLat + maxLat) / 2;
          const lon = (minLon + maxLon) / 2;
          const span = Math.max(maxLat - minLat, maxLon - minLon);
          const zoom = span > 40 ? 3 : span > 15 ? 4 : span > 5 ? 5 : 6;
          return this.schedule(() => {
            ctx.map?.setView('global');
            ctx.map?.setCenter(lat, lon, zoom);
          }, 300, epoch);
        }
        break;
      }
    }
    return true;
  }

  private scrollToPanelWhenReady(
    panelId: string,
    attemptsLeft = 12,
    trackDetailedAnalytics = true,
    epoch?: number,
  ): void {
    if (!trackDetailedAnalytics) this.bindings.suppressNextAgentPanelView(panelId);
    if (document.querySelector(`[data-panel="${panelId}"]`)) {
      this.scrollToPanel(panelId, trackDetailedAnalytics);
      return;
    }
    if (attemptsLeft <= 0) return;
    this.schedule(
      () => this.scrollToPanelWhenReady(panelId, attemptsLeft - 1, trackDetailedAnalytics, epoch),
      80,
      epoch,
    );
  }

  private dispatchPanelTab(panelId: string, tab: string, attemptsLeft = 12, epoch?: number): void {
    if (panelId !== 'consumer-prices') return;
    if (document.querySelector(`[data-panel="${panelId}"]:not([data-deferred-panel])`)) {
      window.dispatchEvent(new CustomEvent('wm-consumer-prices-open-tab', { detail: { tab } }));
      return;
    }
    if (attemptsLeft <= 0) return;
    this.schedule(() => this.dispatchPanelTab(panelId, tab, attemptsLeft - 1, epoch), 80, epoch);
  }

  private scrollToPanel(panelId: string, trackDetailedAnalytics = true): void {
    if (!trackDetailedAnalytics) this.bindings.suppressNextAgentPanelView(panelId);
    const panel = document.querySelector(`[data-panel="${panelId}"]`);
    if (!panel) return;
    panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    this.applyHighlight(panel);
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

  private schedule(callback: () => void, delay: number, epoch?: number): boolean | Promise<boolean> {
    if (epoch === undefined) {
      this.bindings.setTimeout(callback, delay);
      return true;
    }
    return new Promise<boolean>((resolve, reject) => {
      const timer = this.bindings.setTimeout(() => {
        this.programmaticTimers.delete(timer);
        if (epoch !== this.programmaticEpoch) {
          resolve(false);
          return;
        }
        try {
          callback();
          resolve(true);
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
