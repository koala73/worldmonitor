/**
 * DeepLinkHandler — URL state management, deep linking, and clipboard operations.
 *
 * Extracted from App.ts.  Manages initial URL parsing, share-URL generation,
 * URL ↔ map state synchronisation, and clipboard helpers.
 */

import type { AppContext } from './app-context';
import { STORAGE_KEYS } from '@/config';
import { buildMapUrl, debounce, saveToStorage } from '@/utils';
import { dataFreshness } from '@/services/data-freshness';

/* ------------------------------------------------------------------ */
/*  Callback interface for cross-controller actions                    */
/* ------------------------------------------------------------------ */

export interface DeepLinkCallbacks {
  openCountryStory: (code: string, name: string) => void;
  openCountryBriefByCode: (code: string, name: string) => void;
  resolveCountryName: (code: string) => string;
}

/* ------------------------------------------------------------------ */
/*  Controller                                                         */
/* ------------------------------------------------------------------ */

export class DeepLinkHandler {
  private readonly ctx: AppContext;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  /* ---------------------------------------------------------------- */
  /*  Deep-link handling (runs once on startup)                        */
  /* ---------------------------------------------------------------- */

  handleDeepLinks(callbacks: DeepLinkCallbacks): void {
    const url = new URL(window.location.href);
    if (url.pathname === '/story' || url.searchParams.has('c')) {
      const countryCode = url.searchParams.get('c');
      if (countryCode) {
        const countryNames: Record<string, string> = {
          UA: 'Ukraine', RU: 'Russia', CN: 'China', US: 'United States',
          IR: 'Iran', IL: 'Israel', TW: 'Taiwan', KP: 'North Korea',
          SA: 'Saudi Arabia', TR: 'Turkey', PL: 'Poland', DE: 'Germany',
          FR: 'France', GB: 'United Kingdom', IN: 'India', PK: 'Pakistan',
          SY: 'Syria', YE: 'Yemen', MM: 'Myanmar', VE: 'Venezuela',
        };
        const countryName = countryNames[countryCode.toUpperCase()] || countryCode;
        const checkAndOpen = () => {
          if (dataFreshness.hasSufficientData() && this.ctx.latestClusters.length > 0) {
            callbacks.openCountryStory(countryCode.toUpperCase(), countryName);
          } else {
            setTimeout(checkAndOpen, 500);
          }
        };
        setTimeout(checkAndOpen, 2000);
        history.replaceState(null, '', '/');
        return;
      }
    }

    const deepLinkCountry = this.ctx.pendingDeepLinkCountry;
    this.ctx.pendingDeepLinkCountry = null;
    if (deepLinkCountry) {
      const cName = callbacks.resolveCountryName(deepLinkCountry);
      const checkAndOpenBrief = () => {
        if (dataFreshness.hasSufficientData()) {
          callbacks.openCountryBriefByCode(deepLinkCountry, cName);
        } else {
          setTimeout(checkAndOpenBrief, 500);
        }
      };
      setTimeout(checkAndOpenBrief, 2000);
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Apply parsed URL state to the map on first load                  */
  /* ---------------------------------------------------------------- */

  applyInitialUrlState(): void {
    if (!this.ctx.initialUrlState || !this.ctx.map) return;
    const { view, zoom, lat, lon, timeRange, layers } = this.ctx.initialUrlState;

    if (view) {
      this.ctx.map.setView(view);
    }
    if (timeRange) {
      this.ctx.map.setTimeRange(timeRange);
    }
    if (layers) {
      this.ctx.mapLayers = layers;
      saveToStorage(STORAGE_KEYS.mapLayers, this.ctx.mapLayers);
      this.ctx.map.setLayers(layers);
    }
    if (!view) {
      if (zoom !== undefined) {
        this.ctx.map.setZoom(zoom);
      }
      if (lat !== undefined && lon !== undefined && zoom !== undefined && zoom > 2) {
        this.ctx.map.setCenter(lat, lon);
      }
    }

    const regionSelect = document.getElementById('regionSelect') as HTMLSelectElement;
    const currentView = this.ctx.map.getState().view;
    if (regionSelect && currentView) {
      regionSelect.value = currentView;
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Ongoing URL ↔ map state sync                                     */
  /* ---------------------------------------------------------------- */

  setupUrlStateSync(): void {
    if (!this.ctx.map) return;

    const update = debounce(() => {
      const shareUrl = this.getShareUrl();
      if (!shareUrl) return;
      history.replaceState(null, '', shareUrl);
    }, 250);

    this.ctx.map.onStateChanged(() => {
      update();
      const regionSelect = document.getElementById('regionSelect') as HTMLSelectElement;
      if (regionSelect && this.ctx.map) {
        const state = this.ctx.map.getState();
        if (regionSelect.value !== state.view) {
          regionSelect.value = state.view;
        }
      }
    });

    update();
  }

  /* ---------------------------------------------------------------- */
  /*  Share URL generation                                             */
  /* ---------------------------------------------------------------- */

  getShareUrl(): string | null {
    if (!this.ctx.map) return null;
    const state = this.ctx.map.getState();
    const center = this.ctx.map.getCenter();
    const baseUrl = `${window.location.origin}${window.location.pathname}`;
    return buildMapUrl(baseUrl, {
      view: state.view,
      zoom: state.zoom,
      center,
      timeRange: state.timeRange,
      layers: state.layers,
      country: this.ctx.countryBriefPage?.isVisible()
        ? (this.ctx.countryBriefPage.getCode() ?? undefined)
        : undefined,
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Clipboard helpers                                                */
  /* ---------------------------------------------------------------- */

  async copyToClipboard(text: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }

  setCopyLinkFeedback(button: HTMLElement | null, message: string): void {
    if (!button) return;
    const originalText = button.textContent ?? '';
    button.textContent = message;
    button.classList.add('copied');
    window.setTimeout(() => {
      button.textContent = originalText;
      button.classList.remove('copied');
    }, 1500);
  }
}
