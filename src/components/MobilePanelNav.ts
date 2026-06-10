import { PANEL_CATEGORY_MAP, getVariantPanelCategories } from '@/config/panels';
import { SITE_VARIANT } from '@/config';
import { t } from '@/services/i18n';
import type { PanelConfig } from '@/types';

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
  private getPanelSettings: () => Record<string, PanelConfig>;

  constructor(getPanelSettings: () => Record<string, PanelConfig>) {
    this.getPanelSettings = getPanelSettings;
    this.element = document.createElement('nav');
    this.element.className = 'mobile-panel-nav';
    this.element.addEventListener('click', (e) => {
      const chip = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-category]');
      if (chip?.dataset.category) this.select(chip.dataset.category);
    });
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  /** Rebuild chips from current panel settings, then re-apply the filter. */
  public refresh(): void {
    const categories = [
      { key: 'all', label: t('header.sourceRegionAll') },
      ...getVariantPanelCategories(this.getPanelSettings(), SITE_VARIANT)
        .map(({ key, labelKey }) => ({ key, label: t(labelKey) })),
    ];
    if (!categories.some((c) => c.key === this.activeCategory)) {
      this.activeCategory = 'all';
    }
    this.element.replaceChildren(...categories.map(({ key, label }) => {
      const chip = document.createElement('button');
      chip.className = 'mobile-panel-nav-chip';
      chip.dataset.category = key;
      chip.textContent = label;
      this.setChipState(chip, key === this.activeCategory);
      return chip;
    }));
    this.applyFilter();
  }

  public destroy(): void {
    this.element.remove();
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

  private applyFilter(): void {
    const grid = document.getElementById('panelsGrid');
    if (!grid) return;
    const def = this.activeCategory === 'all' ? undefined : PANEL_CATEGORY_MAP[this.activeCategory];
    const allowed = def ? new Set(def.panelKeys) : null;
    grid.classList.toggle('mobile-cat-filtered', !!allowed);
    grid.querySelectorAll<HTMLElement>('[data-panel]').forEach((el) => {
      const panelKey = el.dataset.panel ?? '';
      el.classList.toggle('mobile-cat-hidden', !!allowed && !allowed.has(panelKey));
    });
    // Charts rendered while display:none come back at zero width — same
    // recalc nudge the mobile map toggle uses.
    window.dispatchEvent(new Event('resize'));
  }

  /** Scroll the bar to the top of the viewport so filtered panels are in view. */
  private scrollToPanels(): void {
    const scroller = this.element.parentElement;
    if (!scroller) return;
    const delta = this.element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    if (delta > 0) scroller.scrollTo({ top: scroller.scrollTop + delta });
  }
}
