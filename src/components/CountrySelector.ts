import { h, replaceChildren, safeHtml } from '@/utils/dom-utils';
import { getCountryNameByCode, isValidCountryCode } from '@/services/country-geometry';
import { toFlagEmoji } from '@/utils/country-flag';
import { t } from '@/services/i18n';

// Curated list of countries for quick access (alphabetically sorted)
const QUICK_SELECT_COUNTRIES = [
  'US', 'CN', 'RU', 'UA', 'IL', 'IR', 'KR', 'JP', 'IN', 'BR',
  'GB', 'FR', 'DE', 'EU', 'MX', 'SA', 'AE', 'SY', 'PK', 'NG',
];

interface CountrySelectorOptions {
  onCountrySelected?: (code: string, name: string) => void;
  onClose?: () => void;
  container?: HTMLElement;
}

/**
 * CountrySelector provides a unified interface for selecting countries:
 * 1. Search box for finding countries by name
 * 2. Quick-select buttons for top countries
 * 3. Full country list dropdown
 */
export class CountrySelector {
  private container: HTMLElement;
  private wrapper: HTMLElement;
  private searchInput: HTMLInputElement;
  private quickSelectContainer: HTMLElement;
  private countryListDropdown: HTMLElement;
  private listItems: Map<string, HTMLElement> = new Map();
  private onCountrySelected?: (code: string, name: string) => void;
  private onClose?: () => void;
  private allCountryCodes: string[] = [];
  private filteredCountryCodes: string[] = [];
  private searchTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(options: CountrySelectorOptions) {
    this.onCountrySelected = options.onCountrySelected;
    this.onClose = options.onClose;
    
    if (options.container) {
      this.container = options.container;
    } else {
      this.container = document.createElement('div');
      document.body.appendChild(this.container);
    }

    this.wrapper = h('div', { className: 'country-selector' });
    this.searchInput = h('input', { className: 'country-selector-search' }) as HTMLInputElement;
    this.quickSelectContainer = h('div', { className: 'country-selector-quick-select' });
    this.countryListDropdown = h('div', { className: 'country-selector-list' });

    this.initializeCountryList();
    this.setupEventListeners();
    this.render();
  }

  private initializeCountryList(): void {
    // Get all valid country codes - using ISO 3166-1 alpha-2 codes
    const allCodes = [
      'AF', 'AL', 'DZ', 'AS', 'AD', 'AO', 'AI', 'AQ', 'AG', 'AR', 'AM', 'AW', 'AU', 'AT', 'AZ',
      'BS', 'BH', 'BD', 'BB', 'BY', 'BE', 'BZ', 'BJ', 'BM', 'BT', 'BO', 'BA', 'BW', 'BV', 'BR',
      'BN', 'BG', 'BF', 'BI', 'KH', 'CM', 'CA', 'CV', 'KY', 'CF', 'TD', 'CL', 'CN', 'CX', 'CC',
      'CO', 'KM', 'CG', 'CD', 'CK', 'CR', 'HR', 'CU', 'CY', 'CZ', 'DK', 'DJ', 'DM', 'DO', 'EC',
      'EG', 'SV', 'GQ', 'ER', 'EE', 'ET', 'FK', 'FO', 'FJ', 'FI', 'FR', 'GF', 'PF', 'TF', 'GA',
      'GM', 'GE', 'DE', 'GH', 'GI', 'GR', 'GL', 'GD', 'GP', 'GU', 'GT', 'GG', 'GN', 'GW', 'GY',
      'HT', 'HM', 'VA', 'HN', 'HK', 'HU', 'IS', 'IN', 'ID', 'IR', 'IQ', 'IE', 'IM', 'IL', 'IT',
      'CI', 'JM', 'JP', 'JE', 'JO', 'KZ', 'KE', 'KI', 'KP', 'KR', 'KW', 'KG', 'LA', 'LV', 'LB',
      'LS', 'LR', 'LY', 'LI', 'LT', 'LU', 'MO', 'MK', 'MG', 'MW', 'MY', 'MV', 'ML', 'MT', 'MH',
      'MQ', 'MR', 'MU', 'YT', 'MX', 'FM', 'MD', 'MC', 'MN', 'ME', 'MA', 'MZ', 'MM', 'NA', 'NR',
      'NP', 'NL', 'AN', 'NC', 'NZ', 'NI', 'NE', 'NG', 'NU', 'NF', 'MP', 'NO', 'OM', 'PK', 'PW',
      'PS', 'PA', 'PG', 'PY', 'PE', 'PH', 'PN', 'PL', 'PT', 'PR', 'QA', 'RE', 'RO', 'RU', 'RW',
      'SH', 'KN', 'LC', 'PM', 'VC', 'WS', 'SM', 'ST', 'SA', 'SN', 'RS', 'SC', 'SL', 'SG', 'SK',
      'SI', 'SB', 'SO', 'ZA', 'SS', 'ES', 'LK', 'SD', 'SR', 'SJ', 'SZ', 'SE', 'CH', 'SY', 'TW',
      'TJ', 'TZ', 'TH', 'TL', 'TG', 'TK', 'TO', 'TT', 'TN', 'TR', 'TM', 'TC', 'TV', 'UG', 'UA',
      'AE', 'GB', 'US', 'UY', 'UZ', 'VU', 'VE', 'VN', 'VG', 'VI', 'WF', 'EH', 'YE', 'ZM', 'ZW',
      'EU', // European Union (for regional analysis)
    ];

    this.allCountryCodes = allCodes.filter(code => isValidCountryCode(code));
    this.filteredCountryCodes = [...this.allCountryCodes];
  }

  private setupEventListeners(): void {
    // Search input
    this.searchInput.addEventListener('input', (e) => {
      const query = (e.target as HTMLInputElement).value.toLowerCase().trim();
      this.filterCountries(query);
    });

    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.onClose?.();
      }
    });

    // Outside click to close
    document.addEventListener('click', (e) => {
      if (!this.wrapper.contains(e.target as Node) && e.target !== this.searchInput) {
        this.onClose?.();
      }
    }, true);
  }

  private filterCountries(query: string): void {
    if (this.searchTimeout) clearTimeout(this.searchTimeout);

    this.searchTimeout = setTimeout(() => {
      if (!query) {
        this.filteredCountryCodes = [...this.allCountryCodes];
      } else {
        this.filteredCountryCodes = this.allCountryCodes.filter(code => {
          const name = getCountryNameByCode(code)?.toLowerCase() || code.toLowerCase();
          return name.includes(query) || code.toLowerCase().includes(query);
        });
      }

      this.updateCountryList();
    }, 100);
  }

  private updateCountryList(): void {
    replaceChildren(this.countryListDropdown);
    this.listItems.clear();

    if (this.filteredCountryCodes.length === 0) {
      const noResults = h('div', { className: 'country-selector-no-results' });
      noResults.textContent = t('country_selector.no_results', 'No countries found');
      this.countryListDropdown.appendChild(noResults);
      return;
    }

    const listUl = h('ul', { className: 'country-selector-list-ul' });
    
    for (const code of this.filteredCountryCodes) {
      const name = getCountryNameByCode(code) || code;
      const li = h('li', { className: 'country-selector-list-item' });
      li.innerHTML = safeHtml(`<span class="flag">${toFlagEmoji(code)}</span><span class="name">${name}</span><span class="code">${code}</span>`);
      li.addEventListener('click', () => {
        this.selectCountry(code, name);
      });
      listUl.appendChild(li);
      this.listItems.set(code, li);
    }

    this.countryListDropdown.appendChild(listUl);
  }

  private selectCountry(code: string, name: string): void {
    this.onCountrySelected?.(code, name);
    this.onClose?.();
  }

  private renderQuickSelect(): void {
    replaceChildren(this.quickSelectContainer);

    const label = h('div', { className: 'country-selector-quick-label' });
    label.textContent = t('country_selector.quick_select', 'Quick select:');
    this.quickSelectContainer.appendChild(label);

    const buttonContainer = h('div', { className: 'country-selector-quick-buttons' });

    for (const code of QUICK_SELECT_COUNTRIES) {
      if (!isValidCountryCode(code)) continue;
      
      const name = getCountryNameByCode(code) || code;
      const btn = h('button', { className: 'country-selector-quick-btn' });
      btn.innerHTML = safeHtml(`<span class="flag">${toFlagEmoji(code)}</span><span class="code">${code}</span>`);
      btn.title = name;
      btn.addEventListener('click', () => this.selectCountry(code, name));
      buttonContainer.appendChild(btn);
    }

    this.quickSelectContainer.appendChild(buttonContainer);
  }

  private render(): void {
    this.searchInput.type = 'text';
    this.searchInput.placeholder = t('country_selector.search_placeholder', 'Search countries...');
    this.searchInput.setAttribute('aria-label', 'Search countries');

    this.wrapper.appendChild(this.searchInput);
    this.renderQuickSelect();
    this.wrapper.appendChild(this.quickSelectContainer);
    this.wrapper.appendChild(this.countryListDropdown);

    replaceChildren(this.container);
    this.container.appendChild(this.wrapper);

    // Initialize list with all countries
    this.updateCountryList();

    // Focus search input
    setTimeout(() => this.searchInput.focus(), 100);
  }

  public updateStyles(): void {
    const style = document.createElement('style');
    style.textContent = `
      .country-selector {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        z-index: 9999;
        background: var(--bg-primary, #1a1a1a);
        border: 1px solid var(--border-color, #333);
        border-radius: 8px;
        box-shadow: 0 10px 40px rgba(0,0,0,0.3);
        width: 90%;
        max-width: 500px;
        max-height: 80vh;
        display: flex;
        flex-direction: column;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }

      .country-selector-search {
        padding: 12px 16px;
        border: none;
        border-bottom: 1px solid var(--border-color, #333);
        background: var(--bg-primary, #1a1a1a);
        color: var(--text-primary, #fff);
        font-size: 14px;
        border-radius: 8px 8px 0 0;
      }

      .country-selector-search:focus {
        outline: none;
        box-shadow: inset 0 0 0 2px var(--accent-color, #00aaff);
      }

      .country-selector-quick-label {
        padding: 12px 16px 4px 16px;
        font-size: 12px;
        font-weight: 600;
        color: var(--text-secondary, #999);
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }

      .country-selector-quick-buttons {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(60px, 1fr));
        gap: 8px;
        padding: 0 16px 12px 16px;
      }

      .country-selector-quick-btn {
        padding: 8px;
        background: var(--bg-secondary, #2a2a2a);
        border: 1px solid var(--border-color, #333);
        border-radius: 4px;
        color: var(--text-primary, #fff);
        cursor: pointer;
        font-size: 12px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
        transition: all 0.2s;
      }

      .country-selector-quick-btn:hover {
        background: var(--accent-color, #00aaff);
        border-color: var(--accent-color, #00aaff);
        color: #000;
      }

      .country-selector-quick-btn .flag {
        font-size: 20px;
      }

      .country-selector-list {
        overflow-y: auto;
        flex: 1;
        border-top: 1px solid var(--border-color, #333);
      }

      .country-selector-list-ul {
        list-style: none;
        margin: 0;
        padding: 0;
      }

      .country-selector-list-item {
        padding: 10px 16px;
        display: flex;
        align-items: center;
        gap: 12px;
        cursor: pointer;
        border-bottom: 1px solid var(--border-color, #333);
        transition: background 0.15s;
      }

      .country-selector-list-item:hover {
        background: var(--bg-secondary, #2a2a2a);
      }

      .country-selector-list-item .flag {
        font-size: 20px;
        flex-shrink: 0;
      }

      .country-selector-list-item .name {
        flex: 1;
        color: var(--text-primary, #fff);
        font-size: 13px;
      }

      .country-selector-list-item .code {
        color: var(--text-secondary, #999);
        font-size: 11px;
        font-weight: 600;
        font-family: monospace;
      }

      .country-selector-no-results {
        padding: 32px 16px;
        text-align: center;
        color: var(--text-secondary, #999);
        font-size: 14px;
      }
    `;
    
    if (!document.head.querySelector('style[data-country-selector]')) {
      style.setAttribute('data-country-selector', 'true');
      document.head.appendChild(style);
    }
  }

  public destroy(): void {
    if (this.searchTimeout) clearTimeout(this.searchTimeout);
    this.container.remove();
  }
}
