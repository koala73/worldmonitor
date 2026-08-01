import type { AppContext } from '@/app/app-context';
import type { MapView } from '@/components/MapContainer';
import type { AuthLauncher } from '@/components/AuthLauncher';
import { AuthHeaderWidget } from '@/components/AuthHeaderWidget';
import { SITE_VARIANT } from '@/config';
import { getAuthState, subscribeAuthState } from '@/services/auth-state';
import { track, trackMapViewChange, trackThemeChanged } from '@/services/analytics';
import { getCurrentTheme, setTheme, showToast } from '@/utils';
import {
  overlayHistory,
  type OverlayCloseOrigin,
  type OverlayId,
} from '@/utils/overlay-history';

type MobilePrimaryNavCallbacks = {
  openSearch(options: { replaceOverlayId?: OverlayId; historyPending: true }): void;
  navigateToVariant(variant: string, options: { isLocalDev: boolean }): Promise<void>;
  openMission(anchor: HTMLElement): void;
};

export class MobilePrimaryNav {
  private readonly listeners = new AbortController();
  private menuOpenFrame: number | null = null;
  private regionOpenFrame: number | null = null;
  private alertScrollFrame: number | null = null;
  private authWidget: AuthHeaderWidget | null = null;
  private unsubscribeAuth: (() => void) | null = null;
  private unsubscribeHistory: (() => void) | null = null;
  private activeTab = 'today';

  constructor(
    private readonly ctx: AppContext,
    private readonly callbacks: MobilePrimaryNavCallbacks,
  ) {}

  init(): void {
    this.setupTabBar();
    this.setupMenu();
    this.unsubscribeHistory = overlayHistory.subscribe((top) => {
      if (top === 'search' || top === 'search-pending') this.setActive('search');
      else if (top === 'menu' || top === 'region' || top === 'settings' || top === 'settings-pending') this.setActive('more');
      else if (!top && (this.activeTab === 'search' || this.activeTab === 'more')) this.setActive('today');
    });
  }

  setupAuth(modal: AuthLauncher): void {
    const mobileMount = document.getElementById('mobileAuthWidgetMount');
    const fallback = document.getElementById('mobileAuthFallback') as HTMLButtonElement | null;
    const openAuth = () => {
      this.closeMenu();
      modal.open();
    };
    fallback?.addEventListener('click', openAuth, { signal: this.listeners.signal });
    if (!mobileMount) return;

    this.authWidget = new AuthHeaderWidget(openAuth);
    mobileMount.appendChild(this.authWidget.getElement());
    const renderPending = (pending: boolean) => {
      mobileMount.hidden = pending;
      if (fallback) fallback.hidden = !pending;
    };
    renderPending(getAuthState().isPending);
    this.unsubscribeAuth = subscribeAuthState((state) => renderPending(state.isPending));
  }

  updateThemeItem(): void {
    const button = document.getElementById('mobileMenuTheme');
    if (!button) return;
    const isDark = getCurrentTheme() === 'dark';
    const icon = button.querySelector('.mobile-menu-item-icon');
    const label = button.querySelector('.mobile-menu-item-label');
    if (icon) icon.textContent = isDark ? '☀️' : '🌙';
    if (label) label.textContent = isDark ? 'Light Mode' : 'Dark Mode';
  }

  closeMenu(origin: OverlayCloseOrigin = 'control'): void {
    const overlay = document.getElementById('mobileMenuOverlay');
    const menu = document.getElementById('mobileMenu');
    if (!overlay || !menu) return;
    if (this.menuOpenFrame !== null) cancelAnimationFrame(this.menuOpenFrame);
    this.menuOpenFrame = null;
    menu.classList.remove('open');
    overlay.classList.remove('open');
    const sheetOpen = document.getElementById('regionBottomSheet')?.classList.contains('open');
    if (!sheetOpen) document.body.style.overflow = '';
    if (origin === 'control') overlayHistory.close('menu');
  }

  destroy(): void {
    this.listeners.abort();
    this.unsubscribeAuth?.();
    this.unsubscribeAuth = null;
    this.unsubscribeHistory?.();
    this.unsubscribeHistory = null;
    this.authWidget?.destroy();
    this.authWidget = null;
    if (this.menuOpenFrame !== null) cancelAnimationFrame(this.menuOpenFrame);
    if (this.regionOpenFrame !== null) cancelAnimationFrame(this.regionOpenFrame);
    if (this.alertScrollFrame !== null) cancelAnimationFrame(this.alertScrollFrame);
    this.menuOpenFrame = null;
    this.regionOpenFrame = null;
    this.alertScrollFrame = null;
  }

  private setupTabBar(): void {
    const tabBar = document.getElementById('mobileTabBar');
    if (!tabBar) return;
    tabBar.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-mobile-tab]');
      const tab = button?.dataset.mobileTab;
      if (!tab) return;
      if (this.alertScrollFrame !== null) {
        cancelAnimationFrame(this.alertScrollFrame);
        this.alertScrollFrame = null;
      }
      const replaceOverlayId = this.reconcileOverlayForTab(tab);
      if (replaceOverlayId === null) return;

      switch (tab) {
        case 'today':
          this.exitMap();
          this.collapseMap();
          document.getElementById('main')?.scrollTo({ top: 0, behavior: 'smooth' });
          break;
        case 'map': {
          const mapSection = document.getElementById('mapSection');
          if (mapSection && !mapSection.classList.contains('live-news-fullscreen')) {
            document.getElementById('mapFullscreenBtn')?.click();
          }
          break;
        }
        case 'search': {
          this.exitMap();
          track('search-open', { source: 'mobile-tab' });
          this.callbacks.openSearch({
            replaceOverlayId,
            historyPending: true,
          });
          break;
        }
        case 'alerts': {
          this.exitMap();
          this.collapseMap();
          const panel = document.querySelector<HTMLElement>(
            '#panelsGrid [data-panel="strategic-risk"]:not(.hidden), #panelsGrid [data-panel="oref-sirens"]:not(.hidden), #panelsGrid [data-panel="intel"]:not(.hidden)',
          );
          if (panel?.dataset.panel) {
            window.dispatchEvent(new CustomEvent('wm:reveal-panel', { detail: { panelId: panel.dataset.panel } }));
            this.alertScrollFrame = requestAnimationFrame(() => {
              this.alertScrollFrame = null;
              if (this.activeTab === 'alerts') {
                panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
              }
            });
          } else {
            showToast('No active alerts yet');
          }
          break;
        }
        case 'more':
          this.exitMap();
          this.openMenu(replaceOverlayId);
          break;
        default:
          return;
      }
      this.setActive(tab);
    }, { signal: this.listeners.signal });
  }

  private setupMenu(): void {
    const overlay = document.getElementById('mobileMenuOverlay');
    const menu = document.getElementById('mobileMenu');
    const close = document.getElementById('mobileMenuClose');
    const sheet = document.getElementById('regionBottomSheet');
    if (!overlay || !menu || !close) return;
    const options = { signal: this.listeners.signal };

    overlay.addEventListener('click', () => this.closeMenu(), options);
    close.addEventListener('click', () => this.closeMenu(), options);
    const isLocalDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    menu.querySelectorAll<HTMLButtonElement>('.mobile-menu-variant').forEach((button) => {
      button.addEventListener('click', () => {
        const variant = button.dataset.variant;
        if (variant && variant !== SITE_VARIANT) void this.callbacks.navigateToVariant(variant, { isLocalDev });
      }, options);
    });
    document.getElementById('mobileMenuRegion')?.addEventListener('click', () => {
      this.openRegion('menu');
    }, options);
    document.getElementById('mobileMenuSettings')?.addEventListener('click', () => {
      this.ctx.unifiedSettings?.open(undefined, 'menu', true);
    }, options);
    document.getElementById('mobileMenuTheme')?.addEventListener('click', () => {
      this.closeMenu();
      const next = getCurrentTheme() === 'dark' ? 'light' : 'dark';
      setTheme(next);
      trackThemeChanged(next);
    }, options);
    document.getElementById('mobileMenuMission')?.addEventListener('click', (event) => {
      this.closeMenu();
      this.callbacks.openMission(event.currentTarget as HTMLElement);
    }, options);
    document.getElementById('regionSheetBackdrop')?.addEventListener('click', () => this.closeRegion(), options);
    sheet?.querySelectorAll<HTMLButtonElement>('.region-sheet-option').forEach((option) => {
      option.addEventListener('click', () => this.selectRegion(option, sheet), options);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (sheet?.classList.contains('open')) this.closeRegion();
      else if (menu.classList.contains('open')) this.closeMenu();
    }, options);
  }

  private selectRegion(option: HTMLButtonElement, sheet: HTMLElement): void {
    const region = option.dataset.region;
    if (!region) return;
    this.ctx.map?.setView(region as MapView);
    trackMapViewChange(region);
    const select = document.getElementById('regionSelect') as HTMLSelectElement | null;
    if (select) select.value = region;
    sheet.querySelectorAll('.region-sheet-option').forEach((item) => {
      item.classList.toggle('active', item === option);
      const check = item.querySelector('.region-sheet-check');
      if (check) check.textContent = item === option ? '✓' : '';
    });
    const label = document.getElementById('mobileMenuRegion')?.querySelector('.mobile-menu-item-label');
    if (label) label.textContent = option.querySelector('span')?.textContent ?? '';
    this.closeRegion();
  }

  private openMenu(replaceOverlayId?: OverlayId): void {
    const overlay = document.getElementById('mobileMenuOverlay');
    const menu = document.getElementById('mobileMenu');
    if (!overlay || !menu) return;
    overlay.classList.add('open');
    if (this.menuOpenFrame !== null) cancelAnimationFrame(this.menuOpenFrame);
    this.menuOpenFrame = requestAnimationFrame(() => {
      this.menuOpenFrame = null;
      menu.classList.add('open');
    });
    document.body.style.overflow = 'hidden';
    const close = (origin: OverlayCloseOrigin) => this.closeMenu(origin);
    if (replaceOverlayId) overlayHistory.replaceInPlace(replaceOverlayId, 'menu', close);
    else overlayHistory.open('menu', close);
  }

  private openRegion(replaceOverlayId?: OverlayId): void {
    const backdrop = document.getElementById('regionSheetBackdrop');
    const sheet = document.getElementById('regionBottomSheet');
    if (!backdrop || !sheet) return;
    backdrop.classList.add('open');
    if (this.regionOpenFrame !== null) cancelAnimationFrame(this.regionOpenFrame);
    this.regionOpenFrame = requestAnimationFrame(() => {
      this.regionOpenFrame = null;
      sheet.classList.add('open');
    });
    const close = (origin: OverlayCloseOrigin) => this.closeRegion(origin);
    if (replaceOverlayId) overlayHistory.replaceInPlace(replaceOverlayId, 'region', close);
    else overlayHistory.open('region', close);
    // replaceInPlace closes the outgoing menu synchronously. Restore the lock
    // after that callback so the region sheet does not briefly unlock the page
    // before its opening frame runs.
    document.body.style.overflow = 'hidden';
  }

  private closeRegion(origin: OverlayCloseOrigin = 'control'): void {
    const backdrop = document.getElementById('regionSheetBackdrop');
    const sheet = document.getElementById('regionBottomSheet');
    if (!backdrop || !sheet) return;
    if (this.regionOpenFrame !== null) cancelAnimationFrame(this.regionOpenFrame);
    this.regionOpenFrame = null;
    sheet.classList.remove('open');
    backdrop.classList.remove('open');
    document.body.style.overflow = '';
    if (origin === 'control') overlayHistory.close('region');
  }

  private reconcileOverlayForTab(tab: string): OverlayId | undefined | null {
    const top = overlayHistory.top();
    if (!top) return undefined;

    const isSearchOverlay = top === 'search' || top === 'search-pending';
    const isMoreOverlay = top === 'menu'
      || top === 'region'
      || top === 'settings'
      || top === 'settings-pending';
    if (top === 'settings' && this.ctx.unifiedSettings?.hasPendingChanges()) {
      // Do not replace or dismiss a dirty Settings overlay: those paths call
      // close('replacement') and would discard the draft without confirmation.
      this.ctx.unifiedSettings.close();
      this.setActive('more');
      return null;
    }
    if ((tab === 'search' && isSearchOverlay) || (tab === 'more' && isMoreOverlay)) {
      overlayHistory.dismiss(top);
      this.setActive('today');
      return null;
    }

    if (tab === 'search' || tab === 'more') return top;
    overlayHistory.dismiss(top);
    return undefined;
  }

  private exitMap(): void {
    if (document.getElementById('mapSection')?.classList.contains('live-news-fullscreen')) {
      document.getElementById('mapFullscreenBtn')?.click();
    }
  }

  private collapseMap(): void {
    const mapSection = document.getElementById('mapSection');
    if (mapSection && !mapSection.classList.contains('collapsed')) {
      document.querySelector<HTMLButtonElement>('.map-collapse-btn')?.click();
    }
  }

  private setActive(tab: string): void {
    this.activeTab = tab;
    document.getElementById('mobileTabBar')?.querySelectorAll<HTMLButtonElement>('[data-mobile-tab]').forEach((button) => {
      const active = button.dataset.mobileTab === tab;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
  }
}
