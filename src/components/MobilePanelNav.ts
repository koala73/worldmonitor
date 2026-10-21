import { PANEL_CATEGORY_MAP, getVariantPanelCategories, getProPanelKeys } from '@/config/panels';
import { SITE_VARIANT } from '@/config';
import { t } from '@/services/i18n';
import type { PanelConfig } from '@/types';

// Synthetic chip key — must not collide with PANEL_CATEGORY_MAP keys.
const PRO_CATEGORY = '__pro__';

/**
 * Mobile-only sticky category chip bar mounted above the panels grid.
 * Turns the single-column panel scroll into navigable sections: tapping a
 * category hides every grid panel outside it via `.mobile-cat-hidden`
 * (CSS scoped to the ≤768px media query, so widening the viewport
 * restores the full grid without JS involvement).
 *
 * Visibility interplay: Panel.toggle() uses `.hidden` for settings-driven
 * visibility; this class is additive and never touches `.hidden`, so the
 * two compose — a panel renders only when BOTH say visible.
 */
export class MobilePanelNav {
  private element: HTMLElement;
  private activeCategory = 'all';
  private proPanelKeys: Set<string> = new Set();
  private getPanelSettings: () => Record<string, PanelConfig>;
  // Consumers that navigate to a panel (e.g. breaking-alert tap) dispatch
  // this so an active filter can't swallow their scrollIntoView.
  private boundRevealPanel = (e: Event): void => {
    const key = (e as CustomEvent<{ panelId?: string }>).detail?.panelId;
    if (!key) return;
    const allowed = this.allowedKeysForActiveCategory();
    if (allowed && !allowed.has(key)) this.select('all');
  };

  constructor(getPanelSettings: () => Record<string, PanelConfig>) {
    this.getPanelSettings = getPanelSettings;
    this.element = document.createElement('nav');
    this.element.className = 'mobile-panel-nav';
    this.element.setAttribute('aria-label', t('components.mobileNav.panelCategories'));
    this.element.addEventListener('click', (e) => {
      const chip = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-category]');
      if (chip?.dataset.category) this.select(chip.dataset.category);
    });
    window.addEventListener('wm:reveal-panel', this.boundRevealPanel);
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  /** Rebuild chips from current panel settings, then re-apply the filter. */
  public refresh(): void {
    const settings = this.getPanelSettings();
    this.proPanelKeys = new Set(getProPanelKeys(settings, SITE_VARIANT));
    const categories = [
      { key: 'all', label: t('header.sourceRegionAll') },
      // PRO right after All: one tap surfaces the whole premium suite —
      // each panel renders its own unlock CTA (the mobile conversion path).
      ...(this.proPanelKeys.size > 0
        ? [{ key: PRO_CATEGORY, label: `⚡ ${t('widgets.proBadge')}` }]
        : []),
      ...getVariantPanelCategories(settings, SITE_VARIANT)
        .map(({ key, labelKey }) => ({ key, label: t(labelKey) })),
    ];
    if (!categories.some((c) => c.key === this.activeCategory)) {
      this.activeCategory = 'all';
    }
    this.element.replaceChildren(...categories.map(({ key, label }) => {
      const chip = document.createElement('button');
      chip.className = key === PRO_CATEGORY
        ? 'mobile-panel-nav-chip mobile-panel-nav-chip-pro'
        : 'mobile-panel-nav-chip';
      chip.dataset.category = key;
      chip.textContent = label;
      this.setChipState(chip, key === this.activeCategory);
      return chip;
    }));
    this.applyFilter();
  }

  public destroy(): void {
    window.removeEventListener('wm:reveal-panel', this.boundRevealPanel);
    this.element.remove();
  }

  /** Stamp the active filter onto a panel mounted AFTER refresh() ran —
   *  lazy-loaded panels would otherwise leak into a filtered view. No
   *  resize dispatch: a freshly mounted panel renders at correct width. */
  public applyToNewPanel(el: HTMLElement): void {
    const allowed = this.allowedKeysForActiveCategory();
    const key = el.dataset.panel ?? '';
    el.classList.toggle('mobile-cat-hidden', !!allowed && !allowed.has(key));
  }

  private setChipState(chip: HTMLElement, active: boolean): void {
    chip.classList.toggle('active', active);
    chip.setAttribute('aria-pressed', String(active));
  }

  private select(key: string): void {
    if (key === this.activeCategory) return;
    this.activeCategory = key;
    this.element.querySelectorAll<HTMLElement>('.mobile-panel-nav-chip').forEach((chip) => {
      this.setChipState(chip, chip.dataset.category === key);
    });
    this.applyFilter();
    this.scrollToPanels();
  }

  private allowedKeysForActiveCategory(): Set<string> | null {
    if (this.activeCategory === 'all') return null;
    if (this.activeCategory === PRO_CATEGORY) return this.proPanelKeys;
    const def = PANEL_CATEGORY_MAP[this.activeCategory];
    return def ? new Set(def.panelKeys) : null;
  }

  private applyFilter(): void {
    const grid = document.getElementById('panelsGrid');
    if (!grid) return;
    const allowed = this.allowedKeysForActiveCategory();
    grid.classList.toggle('mobile-cat-filtered', !!allowed);
    grid.querySelectorAll<HTMLElement>('[data-panel]').forEach((el) => {
      const panelKey = el.dataset.panel ?? '';
      el.classList.toggle('mobile-cat-hidden', !!allowed && !allowed.has(panelKey));
    });
    // Charts rendered while display:none come back at zero width — same
    // recalc nudge the mobile map toggle uses.
    window.dispatchEvent(new Event('resize'));
  }

  /** Scroll so the filtered results are in view: bring the bar to the top
   *  of the scrollport when it isn't there yet, and when it's already
   *  stuck (user was deep in the list) bring the first visible panel up
   *  underneath it — otherwise a chip tap can leave the viewport on
   *  filtered-out empty space. */
  private scrollToPanels(): void {
    const scroller = this.element.parentElement;
    if (!scroller) return;
    const navRect = this.element.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const delta = navRect.top - scrollerRect.top;
    if (delta > 0) {
      scroller.scrollTo({ top: scroller.scrollTop + delta });
      return;
    }
    const first = document.querySelector<HTMLElement>(
      '#panelsGrid [data-panel]:not(.mobile-cat-hidden):not(.hidden)',
    );
    if (!first) return;
    const target = scroller.scrollTop + first.getBoundingClientRect().top - scrollerRect.top - navRect.height;
    if (scroller.scrollTop > target) scroller.scrollTo({ top: Math.max(0, target) });
  }
}
