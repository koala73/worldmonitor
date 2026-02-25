import type { AppContext, AppModule } from '@/app/app-context';
import type { SearchResult } from '@/components/SearchModal';
import type { NewsItem, MapLayers } from '@/types';
import type { MapView } from '@/components';
import type { Command } from '@/config/commands';
import { SearchModal } from '@/components';
import { CIIPanel } from '@/components';
import { SITE_VARIANT, STORAGE_KEYS } from '@/config';
import { LAYER_PRESETS, LAYER_KEY_MAP } from '@/config/commands';
import { calculateCII, TIER1_COUNTRIES } from '@/services/country-instability';
import { CURATED_COUNTRIES } from '@/config/countries';
import { INTEL_HOTSPOTS, CONFLICT_ZONES, MILITARY_BASES, UNDERSEA_CABLES, NUCLEAR_FACILITIES } from '@/config/geo';
import { PIPELINES } from '@/config/pipelines';
import { AI_DATA_CENTERS } from '@/config/ai-datacenters';
import { GAMMA_IRRADIATORS } from '@/config/irradiators';
import { TECH_COMPANIES } from '@/config/tech-companies';
import { AI_RESEARCH_LABS } from '@/config/ai-research-labs';
import { STARTUP_ECOSYSTEMS } from '@/config/startup-ecosystems';
import { TECH_HQS, ACCELERATORS } from '@/config/tech-geo';
import { STOCK_EXCHANGES, FINANCIAL_CENTERS, CENTRAL_BANKS, COMMODITY_HUBS } from '@/config/finance-geo';
import { trackSearchResultSelected, trackCountrySelected } from '@/services/analytics';
import { t } from '@/services/i18n';
import { saveToStorage, setTheme } from '@/utils';
import { CountryIntelManager } from '@/app/country-intel';

export interface SearchManagerCallbacks {
  openCountryBriefByCode: (code: string, country: string) => void;
}

export class SearchManager implements AppModule {
  private ctx: AppContext;
  private callbacks: SearchManagerCallbacks;
  private boundKeydownHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(ctx: AppContext, callbacks: SearchManagerCallbacks) {
    this.ctx = ctx;
    this.callbacks = callbacks;
  }

  init(): void {
    this.setupSearchModal();
  }

  destroy(): void {
    if (this.boundKeydownHandler) {
      document.removeEventListener('keydown', this.boundKeydownHandler);
      this.boundKeydownHandler = null;
    }
  }

  private setupSearchModal(): void {
    const searchOptions = SITE_VARIANT === 'tech'
      ? {
        placeholder: t('modals.search.placeholderTech'),
        hint: t('modals.search.hintTech'),
      }
      : SITE_VARIANT === 'happy'
        ? {
          placeholder: 'Search or type a command...',
          hint: 'Good News • Countries • Navigation • Settings',
        }
        : SITE_VARIANT === 'finance'
          ? {
            placeholder: t('modals.search.placeholderFinance'),
            hint: t('modals.search.hintFinance'),
          }
          : {
            placeholder: t('modals.search.placeholder'),
            hint: t('modals.search.hint'),
          };
    this.ctx.searchModal = new SearchModal(this.ctx.container, searchOptions);

    if (SITE_VARIANT === 'happy') {
      // Happy variant: no geopolitical/military/infrastructure sources
    } else if (SITE_VARIANT === 'tech') {
      this.ctx.searchModal.registerSource('techcompany', TECH_COMPANIES.map(c => ({
        id: c.id,
        title: c.name,
        subtitle: `${c.sector} ${c.city} ${c.keyProducts?.join(' ') || ''}`.trim(),
        data: c,
      })));

      this.ctx.searchModal.registerSource('ailab', AI_RESEARCH_LABS.map(l => ({
        id: l.id,
        title: l.name,
        subtitle: `${l.type} ${l.city} ${l.focusAreas?.join(' ') || ''}`.trim(),
        data: l,
      })));

      this.ctx.searchModal.registerSource('startup', STARTUP_ECOSYSTEMS.map(s => ({
        id: s.id,
        title: s.name,
        subtitle: `${s.ecosystemTier} ${s.topSectors?.join(' ') || ''} ${s.notableStartups?.join(' ') || ''}`.trim(),
        data: s,
      })));

      this.ctx.searchModal.registerSource('datacenter', AI_DATA_CENTERS.map(d => ({
        id: d.id,
        title: d.name,
        subtitle: `${d.owner} ${d.chipType || ''}`.trim(),
        data: d,
      })));

      this.ctx.searchModal.registerSource('cable', UNDERSEA_CABLES.map(c => ({
        id: c.id,
        title: c.name,
        subtitle: c.major ? 'Major internet backbone' : 'Undersea cable',
        data: c,
      })));

      this.ctx.searchModal.registerSource('techhq', TECH_HQS.map(h => ({
        id: h.id,
        title: h.company,
        subtitle: `${h.type === 'faang' ? 'Big Tech' : h.type === 'unicorn' ? 'Unicorn' : 'Public'} • ${h.city}, ${h.country}`,
        data: h,
      })));

      this.ctx.searchModal.registerSource('accelerator', ACCELERATORS.map(a => ({
        id: a.id,
        title: a.name,
        subtitle: `${a.type} • ${a.city}, ${a.country}${a.notable ? ` • ${a.notable.slice(0, 2).join(', ')}` : ''}`,
        data: a,
      })));
    } else {
      this.ctx.searchModal.registerSource('hotspot', INTEL_HOTSPOTS.map(h => ({
        id: h.id,
        title: h.name,
        subtitle: `${h.subtext || ''} ${h.keywords?.join(' ') || ''} ${h.description || ''}`.trim(),
        data: h,
      })));

      this.ctx.searchModal.registerSource('conflict', CONFLICT_ZONES.map(c => ({
        id: c.id,
        title: c.name,
        subtitle: `${c.parties?.join(' ') || ''} ${c.keywords?.join(' ') || ''} ${c.description || ''}`.trim(),
        data: c,
      })));

      this.ctx.searchModal.registerSource('base', MILITARY_BASES.map(b => ({
        id: b.id,
        title: b.name,
        subtitle: `${b.type} ${b.description || ''}`.trim(),
        data: b,
      })));

      this.ctx.searchModal.registerSource('pipeline', PIPELINES.map(p => ({
        id: p.id,
        title: p.name,
        subtitle: `${p.type} ${p.operator || ''} ${p.countries?.join(' ') || ''}`.trim(),
        data: p,
      })));

      this.ctx.searchModal.registerSource('cable', UNDERSEA_CABLES.map(c => ({
        id: c.id,
        title: c.name,
        subtitle: c.major ? 'Major cable' : '',
        data: c,
      })));

      this.ctx.searchModal.registerSource('datacenter', AI_DATA_CENTERS.map(d => ({
        id: d.id,
        title: d.name,
        subtitle: `${d.owner} ${d.chipType || ''}`.trim(),
        data: d,
      })));

      this.ctx.searchModal.registerSource('nuclear', NUCLEAR_FACILITIES.map(n => ({
        id: n.id,
        title: n.name,
        subtitle: `${n.type} ${n.operator || ''}`.trim(),
        data: n,
      })));

      this.ctx.searchModal.registerSource('irradiator', GAMMA_IRRADIATORS.map(g => ({
        id: g.id,
        title: `${g.city}, ${g.country}`,
        subtitle: g.organization || '',
        data: g,
      })));
    }

    if (SITE_VARIANT === 'finance') {
      this.ctx.searchModal.registerSource('exchange', STOCK_EXCHANGES.map(e => ({
        id: e.id,
        title: `${e.shortName} - ${e.name}`,
        subtitle: `${e.tier} • ${e.city}, ${e.country}${e.marketCap ? ` • $${e.marketCap}T` : ''}`,
        data: e,
      })));

      this.ctx.searchModal.registerSource('financialcenter', FINANCIAL_CENTERS.map(f => ({
        id: f.id,
        title: f.name,
        subtitle: `${f.type} financial center${f.gfciRank ? ` • GFCI #${f.gfciRank}` : ''}${f.specialties ? ` • ${f.specialties.slice(0, 3).join(', ')}` : ''}`,
        data: f,
      })));

      this.ctx.searchModal.registerSource('centralbank', CENTRAL_BANKS.map(b => ({
        id: b.id,
        title: `${b.shortName} - ${b.name}`,
        subtitle: `${b.type}${b.currency ? ` • ${b.currency}` : ''} • ${b.city}, ${b.country}`,
        data: b,
      })));

      this.ctx.searchModal.registerSource('commodityhub', COMMODITY_HUBS.map(h => ({
        id: h.id,
        title: h.name,
        subtitle: `${h.type} • ${h.city}, ${h.country}${h.commodities ? ` • ${h.commodities.slice(0, 3).join(', ')}` : ''}`,
        data: h,
      })));
    }

    this.ctx.searchModal.registerSource('country', this.buildCountrySearchItems());

    this.ctx.searchModal.setActivePanels(Object.keys(this.ctx.panels));
    this.ctx.searchModal.setOnSelect((result) => this.handleSearchResult(result));
    this.ctx.searchModal.setOnCommand((cmd) => this.handleCommand(cmd));

    this.boundKeydownHandler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        if (this.ctx.searchModal?.isOpen()) {
          this.ctx.searchModal.close();
        } else {
          this.updateSearchIndex();
          this.ctx.searchModal?.open();
        }
      }
    };
    document.addEventListener('keydown', this.boundKeydownHandler);
  }

  private handleSearchResult(result: SearchResult): void {
    trackSearchResultSelected(result.type);
    switch (result.type) {
      case 'news': {
        const item = result.data as NewsItem;
        this.scrollToPanel('politics');
        this.highlightNewsItem(item.link);
        break;
      }
      case 'hotspot': {
        const hotspot = result.data as typeof INTEL_HOTSPOTS[0];
        this.ctx.map?.setView('global');
        setTimeout(() => { this.ctx.map?.triggerHotspotClick(hotspot.id); }, 300);
        break;
      }
      case 'conflict': {
        const conflict = result.data as typeof CONFLICT_ZONES[0];
        this.ctx.map?.setView('global');
        setTimeout(() => { this.ctx.map?.triggerConflictClick(conflict.id); }, 300);
        break;
      }
      case 'market': {
        this.scrollToPanel('markets');
        break;
      }
      case 'prediction': {
        this.scrollToPanel('polymarket');
        break;
      }
      case 'base': {
        const base = result.data as typeof MILITARY_BASES[0];
        this.ctx.map?.setView('global');
        setTimeout(() => { this.ctx.map?.triggerBaseClick(base.id); }, 300);
        break;
      }
      case 'pipeline': {
        const pipeline = result.data as typeof PIPELINES[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('pipelines');
        this.ctx.mapLayers.pipelines = true;
        setTimeout(() => { this.ctx.map?.triggerPipelineClick(pipeline.id); }, 300);
        break;
      }
      case 'cable': {
        const cable = result.data as typeof UNDERSEA_CABLES[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('cables');
        this.ctx.mapLayers.cables = true;
        setTimeout(() => { this.ctx.map?.triggerCableClick(cable.id); }, 300);
        break;
      }
      case 'datacenter': {
        const dc = result.data as typeof AI_DATA_CENTERS[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('datacenters');
        this.ctx.mapLayers.datacenters = true;
        setTimeout(() => { this.ctx.map?.triggerDatacenterClick(dc.id); }, 300);
        break;
      }
      case 'nuclear': {
        const nuc = result.data as typeof NUCLEAR_FACILITIES[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('nuclear');
        this.ctx.mapLayers.nuclear = true;
        setTimeout(() => { this.ctx.map?.triggerNuclearClick(nuc.id); }, 300);
        break;
      }
      case 'irradiator': {
        const irr = result.data as typeof GAMMA_IRRADIATORS[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('irradiators');
        this.ctx.mapLayers.irradiators = true;
        setTimeout(() => { this.ctx.map?.triggerIrradiatorClick(irr.id); }, 300);
        break;
      }
      case 'earthquake':
      case 'outage':
        this.ctx.map?.setView('global');
        break;
      case 'techcompany': {
        const company = result.data as typeof TECH_COMPANIES[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('techHQs');
        this.ctx.mapLayers.techHQs = true;
        setTimeout(() => { this.ctx.map?.setCenter(company.lat, company.lon, 4); }, 300);
        break;
      }
      case 'ailab': {
        const lab = result.data as typeof AI_RESEARCH_LABS[0];
        this.ctx.map?.setView('global');
        setTimeout(() => { this.ctx.map?.setCenter(lab.lat, lab.lon, 4); }, 300);
        break;
      }
      case 'startup': {
        const ecosystem = result.data as typeof STARTUP_ECOSYSTEMS[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('startupHubs');
        this.ctx.mapLayers.startupHubs = true;
        setTimeout(() => { this.ctx.map?.setCenter(ecosystem.lat, ecosystem.lon, 4); }, 300);
        break;
      }
      case 'techevent':
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('techEvents');
        this.ctx.mapLayers.techEvents = true;
        break;
      case 'techhq': {
        const hq = result.data as typeof TECH_HQS[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('techHQs');
        this.ctx.mapLayers.techHQs = true;
        setTimeout(() => { this.ctx.map?.setCenter(hq.lat, hq.lon, 4); }, 300);
        break;
      }
      case 'accelerator': {
        const acc = result.data as typeof ACCELERATORS[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('accelerators');
        this.ctx.mapLayers.accelerators = true;
        setTimeout(() => { this.ctx.map?.setCenter(acc.lat, acc.lon, 4); }, 300);
        break;
      }
      case 'exchange': {
        const exchange = result.data as typeof STOCK_EXCHANGES[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('stockExchanges');
        this.ctx.mapLayers.stockExchanges = true;
        setTimeout(() => { this.ctx.map?.setCenter(exchange.lat, exchange.lon, 4); }, 300);
        break;
      }
      case 'financialcenter': {
        const fc = result.data as typeof FINANCIAL_CENTERS[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('financialCenters');
        this.ctx.mapLayers.financialCenters = true;
        setTimeout(() => { this.ctx.map?.setCenter(fc.lat, fc.lon, 4); }, 300);
        break;
      }
      case 'centralbank': {
        const bank = result.data as typeof CENTRAL_BANKS[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('centralBanks');
        this.ctx.mapLayers.centralBanks = true;
        setTimeout(() => { this.ctx.map?.setCenter(bank.lat, bank.lon, 4); }, 300);
        break;
      }
      case 'commodityhub': {
        const hub = result.data as typeof COMMODITY_HUBS[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('commodityHubs');
        this.ctx.mapLayers.commodityHubs = true;
        setTimeout(() => { this.ctx.map?.setCenter(hub.lat, hub.lon, 4); }, 300);
        break;
      }
      case 'country': {
        const { code, name } = result.data as { code: string; name: string };
        trackCountrySelected(code, name, 'search');
        this.callbacks.openCountryBriefByCode(code, name);
        break;
      }
    }
  }

  private handleCommand(cmd: Command): void {
    const colonIdx = cmd.id.indexOf(':');
    if (colonIdx === -1) return;
    const category = cmd.id.slice(0, colonIdx);
    const action = cmd.id.slice(colonIdx + 1);

    switch (category) {
      case 'nav':
        this.ctx.map?.setView(action as MapView);
        {
          const sel = document.getElementById('regionSelect') as HTMLSelectElement;
          if (sel) sel.value = action;
        }
        break;

      case 'layers': {
        if (action === 'all') {
          for (const key of Object.keys(this.ctx.mapLayers))
            this.ctx.mapLayers[key as keyof MapLayers] = true;
        } else if (action === 'none') {
          for (const key of Object.keys(this.ctx.mapLayers))
            this.ctx.mapLayers[key as keyof MapLayers] = false;
        } else {
          const preset = LAYER_PRESETS[action];
          if (preset) {
            for (const key of Object.keys(this.ctx.mapLayers))
              this.ctx.mapLayers[key as keyof MapLayers] = false;
            for (const layer of preset)
              this.ctx.mapLayers[layer] = true;
          }
        }
        saveToStorage(STORAGE_KEYS.mapLayers, this.ctx.mapLayers);
        this.ctx.map?.setLayers(this.ctx.mapLayers);
        break;
      }

      case 'layer': {
        const layerKey = (LAYER_KEY_MAP[action] || action) as keyof MapLayers;
        if (!(layerKey in this.ctx.mapLayers)) return;
        this.ctx.mapLayers[layerKey] = !this.ctx.mapLayers[layerKey];
        saveToStorage(STORAGE_KEYS.mapLayers, this.ctx.mapLayers);
        if (this.ctx.mapLayers[layerKey]) {
          this.ctx.map?.enableLayer(layerKey);
        } else {
          this.ctx.map?.setLayers(this.ctx.mapLayers);
        }
        break;
      }

      case 'panel':
        this.scrollToPanel(action);
        break;

      case 'view':
        if (action === 'dark' || action === 'light') {
          setTheme(action);
        } else if (action === 'fullscreen') {
          if (document.fullscreenElement) {
            try { void document.exitFullscreen()?.catch(() => {}); } catch {}
          } else {
            const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
            if (el.requestFullscreen) {
              try { void el.requestFullscreen()?.catch(() => {}); } catch {}
            } else if (el.webkitRequestFullscreen) {
              try { el.webkitRequestFullscreen(); } catch {}
            }
          }
        } else if (action === 'settings') {
          this.ctx.unifiedSettings?.open();
        } else if (action === 'refresh') {
          window.location.reload();
        }
        break;

      case 'time':
        this.ctx.map?.setTimeRange(action as import('@/components').TimeRange);
        break;

      case 'country': {
        const name = TIER1_COUNTRIES[action]
          || CURATED_COUNTRIES[action]?.name
          || new Intl.DisplayNames(['en'], { type: 'region' }).of(action)
          || action;
        trackCountrySelected(action, name, 'command');
        this.callbacks.openCountryBriefByCode(action, name);
        break;
      }
    }
  }

  private scrollToPanel(panelId: string): void {
    const panel = document.querySelector(`[data-panel="${panelId}"]`);
    if (panel) {
      panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
      panel.classList.add('flash-highlight');
      setTimeout(() => panel.classList.remove('flash-highlight'), 1500);
    }
  }

  private highlightNewsItem(itemId: string): void {
    setTimeout(() => {
      const item = document.querySelector(`[data-news-id="${itemId}"]`);
      if (item) {
        item.scrollIntoView({ behavior: 'smooth', block: 'center' });
        item.classList.add('flash-highlight');
        setTimeout(() => item.classList.remove('flash-highlight'), 1500);
      }
    }, 100);
  }

  updateSearchIndex(): void {
    if (!this.ctx.searchModal) return;

    this.ctx.searchModal.registerSource('country', this.buildCountrySearchItems());

    const newsItems = this.ctx.allNews.slice(0, 500).map(n => ({
      id: n.link,
      title: n.title,
      subtitle: n.source,
      data: n,
    }));
    console.log(`[Search] Indexing ${newsItems.length} news items (allNews total: ${this.ctx.allNews.length})`);
    this.ctx.searchModal.registerSource('news', newsItems);

    if (this.ctx.latestPredictions.length > 0) {
      this.ctx.searchModal.registerSource('prediction', this.ctx.latestPredictions.map(p => ({
        id: p.title,
        title: p.title,
        subtitle: `${Math.round(p.yesPrice)}% probability`,
        data: p,
      })));
    }

    if (this.ctx.latestMarkets.length > 0) {
      this.ctx.searchModal.registerSource('market', this.ctx.latestMarkets.map(m => ({
        id: m.symbol,
        title: `${m.symbol} - ${m.name}`,
        subtitle: `$${m.price?.toFixed(2) || 'N/A'}`,
        data: m,
      })));
    }
  }

  private buildCountrySearchItems(): { id: string; title: string; subtitle: string; data: { code: string; name: string } }[] {
    const panelScores = (this.ctx.panels['cii'] as CIIPanel | undefined)?.getScores() ?? [];
    const scores = panelScores.length > 0 ? panelScores : calculateCII();
    const ciiByCode = new Map(scores.map((score) => [score.code, score]));
    return Object.entries(TIER1_COUNTRIES).map(([code, name]) => {
      const score = ciiByCode.get(code);
      return {
        id: code,
        title: `${CountryIntelManager.toFlagEmoji(code)} ${name}`,
        subtitle: score ? `CII: ${score.score}/100 • ${score.level}` : 'Country Brief',
        data: { code, name },
      };
    });
  }
}
