import { PANEL_CATEGORY_MAP } from '@/config/panels';
import { SITE_VARIANT } from '@/config/variant';
import type { PanelConfig } from '@/types';
import { t } from '@/services/i18n';

export interface WidgetPickerCallbacks {
  getPanelSettings: () => Record<string, PanelConfig>;
  togglePanel: (key: string) => void;
  getLocalizedPanelName: (key: string, fallback: string) => string;
}

export class WidgetPicker {
  private wrapper: HTMLElement;
  private dropdown: HTMLElement;
  private button: HTMLElement;
  private filterInput: HTMLInputElement | null = null;
  private callbacks: WidgetPickerCallbacks;
  private open = false;
  private outsideClickHandler: (e: MouseEvent) => void;
  private escHandler: (e: KeyboardEvent) => void;

  constructor(callbacks: WidgetPickerCallbacks) {
    this.callbacks = callbacks;

    this.wrapper = document.createElement('div');
    this.wrapper.className = 'widget-picker-wrapper';

    this.button = document.createElement('button');
    this.button.className = 'widget-picker-btn';
    this.button.title = t('layouts.addWidget');
    this.button.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
    this.button.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });

    this.dropdown = document.createElement('div');
    this.dropdown.className = 'widget-picker-dropdown';

    this.wrapper.appendChild(this.button);
    this.wrapper.appendChild(this.dropdown);

    this.outsideClickHandler = () => this.close();
    this.escHandler = (e) => { if (e.key === 'Escape') this.close(); };
  }

  getElement(): HTMLElement {
    return this.wrapper;
  }

  private toggle(): void {
    if (this.open) this.close();
    else this.show();
  }

  private show(): void {
    this.renderDropdown();
    this.dropdown.classList.add('open');
    this.open = true;
    setTimeout(() => {
      document.addEventListener('click', this.outsideClickHandler);
      document.addEventListener('keydown', this.escHandler);
    }, 0);
    this.filterInput?.focus();
  }

  close(): void {
    this.dropdown.classList.remove('open');
    this.open = false;
    document.removeEventListener('click', this.outsideClickHandler);
    document.removeEventListener('keydown', this.escHandler);
  }

  /** Re-render the toggle states (call after layout switch). */
  refresh(): void {
    if (this.open) this.renderDropdown();
  }

  private renderDropdown(): void {
    const settings = this.callbacks.getPanelSettings();
    const filter = this.filterInput?.value.toLowerCase() || '';

    this.dropdown.innerHTML = '';

    // Header with filter input
    const header = document.createElement('div');
    header.className = 'widget-picker-header';
    header.innerHTML = `<span class="widget-picker-title">${t('layouts.addWidget')}</span>`;
    this.filterInput = document.createElement('input');
    this.filterInput.type = 'text';
    this.filterInput.className = 'widget-picker-filter';
    this.filterInput.placeholder = t('layouts.filterWidgets');
    this.filterInput.value = filter;
    this.filterInput.addEventListener('input', () => this.renderDropdown());
    this.filterInput.addEventListener('click', (e) => e.stopPropagation());
    header.appendChild(this.filterInput);
    this.dropdown.appendChild(header);

    // Scrollable list
    const list = document.createElement('div');
    list.className = 'widget-picker-list';

    const variant = SITE_VARIANT || 'full';
    for (const [, cat] of Object.entries(PANEL_CATEGORY_MAP)) {
      if (cat.variants && !cat.variants.includes(variant)) continue;

      const matchingPanels = cat.panelKeys.filter(key => {
        if (!(key in settings)) return false;
        if (key === 'map') return false; // map is always visible
        if (!filter) return true;
        const name = this.callbacks.getLocalizedPanelName(key, settings[key]?.name || key);
        return name.toLowerCase().includes(filter);
      });

      if (matchingPanels.length === 0) continue;

      const catHeader = document.createElement('div');
      catHeader.className = 'widget-picker-cat';
      catHeader.textContent = t(cat.labelKey);
      list.appendChild(catHeader);

      for (const key of matchingPanels) {
        const config = settings[key];
        if (!config) continue;
        const item = document.createElement('div');
        item.className = `widget-picker-item${config.enabled ? ' active' : ''}`;
        item.dataset.panel = key;
        const name = this.callbacks.getLocalizedPanelName(key, config.name || key);
        item.innerHTML = `<span class="widget-picker-check">${config.enabled ? '✓' : ''}</span><span class="widget-picker-name">${name}</span>`;
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          this.callbacks.togglePanel(key);
          // Re-render to update check marks
          this.renderDropdown();
        });
        list.appendChild(item);
      }
    }

    this.dropdown.appendChild(list);
  }
}
