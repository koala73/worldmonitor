import { h, replaceChildren, safeHtml } from '@/utils/dom-utils';
import { toFlagEmoji } from '@/utils/country-flag';
import { t } from '@/services/i18n';
import type { AppContext } from '@/app/app-context';

interface CountryProfileViewOptions {
  appContext: AppContext;
  countryCode: string;
  countryName: string;
  onClose?: () => void;
}

/**
 * CountryProfileView renders a modal overlay showing country-focused intelligence.
 * This is the main wrapper that presents the country profile with a shrunken main menu.
 */
export class CountryProfileView {
  private appContext: AppContext;
  private countryCode: string;
  private countryName: string;
  private container: HTMLElement;
  private overlay: HTMLElement;
  private modal: HTMLElement;
  private header: HTMLElement;
  private body: HTMLElement;
  private closeButton: HTMLButtonElement;
  private openButton: HTMLElement | null = null;
  private onClose?: () => void;
  private countryPanels: Map<string, any> = new Map();

  constructor(options: CountryProfileViewOptions) {
    this.appContext = options.appContext;
    this.countryCode = options.countryCode;
    this.countryName = options.countryName;
    this.onClose = options.onClose;

    this.container = document.createElement('div');
    this.overlay = h('div', { className: 'country-profile-overlay' });
    this.modal = h('div', { className: 'country-profile-modal' });
    this.header = h('div', { className: 'country-profile-header' });
    this.body = h('div', { className: 'country-profile-body' });
    this.closeButton = h('button', { className: 'country-profile-close' }) as HTMLButtonElement;

    this.setupEventListeners();
    this.render();
    this.injectStyles();
  }

  private setupEventListeners(): void {
    // Close button
    this.closeButton.addEventListener('click', () => this.close());

    // Escape key
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.close();
      }
    };
    document.addEventListener('keydown', keyHandler);

    // Click outside modal
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) {
        this.close();
      }
    });
  }

  private renderHeader(): void {
    replaceChildren(this.header);

    const titleSection = h('div', { className: 'country-profile-title-section' });
    const flagEl = h('span', { className: 'country-profile-flag' });
    flagEl.textContent = toFlagEmoji(this.countryCode);

    const titleText = h('div', { className: 'country-profile-title-text' });
    const countryTitle = h('h1', { className: 'country-profile-country-name' });
    countryTitle.textContent = this.countryName;

    const countryCode = h('span', { className: 'country-profile-country-code' });
    countryCode.textContent = this.countryCode;

    titleText.appendChild(countryTitle);
    titleText.appendChild(countryCode);
    titleSection.appendChild(flagEl);
    titleSection.appendChild(titleText);

    const rightSection = h('div', { className: 'country-profile-header-right' });

    // Real-time status badge
    const statusBadge = h('div', { className: 'country-profile-status-badge' });
    statusBadge.innerHTML = safeHtml(
      '<span class="status-dot"></span>' +
      `<span class="status-text">${t('country_profile.realtime', 'Real-time Updates')}</span>`
    );
    rightSection.appendChild(statusBadge);

    this.closeButton.innerHTML = '✕';
    this.closeButton.title = t('common.close', 'Close');
    rightSection.appendChild(this.closeButton);

    this.header.appendChild(titleSection);
    this.header.appendChild(rightSection);
  }

  private renderBody(): void {
    replaceChildren(this.body);

    // Create a grid container for country-focused panels
    const panelGrid = h('div', { className: 'country-profile-panel-grid' });

    // Add the CountryDeepDivePanel if available
    const countryDeepDivePanel = this.appContext.panels['CountryDeepDive'];
    if (countryDeepDivePanel) {
      const panelWrapper = h('div', { className: 'country-profile-panel-wrapper' });
      // The panel will be managed separately, we just create a container for it
      panelWrapper.id = 'country-deep-dive-container';
      panelGrid.appendChild(panelWrapper);
      this.countryPanels.set('CountryDeepDive', panelWrapper);
    }

    // Add mini versions of critical panels filtered by country
    const miniPanels = [
      { id: 'CountryMilitaryProfile', title: 'Military Presence' },
      { id: 'CountryEconomyProfile', title: 'Economic Indicators' },
      { id: 'CountryEnergyProfile', title: 'Energy Profile' },
      { id: 'CountryCyberProfile', title: 'Cyber Threats' },
      { id: 'CountryHealthProfile', title: 'Health & Humanitarian' },
    ];

    for (const panelDef of miniPanels) {
      const miniPanel = h('div', { className: 'country-profile-mini-panel' });
      miniPanel.id = `country-profile-${panelDef.id}`;
      
      const title = h('h3', { className: 'country-profile-mini-panel-title' });
      title.textContent = panelDef.title;
      
      const content = h('div', { className: 'country-profile-mini-panel-content' });
      content.innerHTML = `<p style="color: var(--text-secondary, #999); padding: 16px;">${t('common.loading', 'Loading...')}</p>`;

      miniPanel.appendChild(title);
      miniPanel.appendChild(content);
      panelGrid.appendChild(miniPanel);
      this.countryPanels.set(panelDef.id, content);
    }

    this.body.appendChild(panelGrid);
  }

  private render(): void {
    this.renderHeader();
    this.renderBody();

    this.modal.appendChild(this.header);
    this.modal.appendChild(this.body);
    this.overlay.appendChild(this.modal);

    replaceChildren(this.container);
    this.container.appendChild(this.overlay);

    if (this.appContext.container) {
      this.appContext.container.appendChild(this.container);
    } else {
      document.body.appendChild(this.container);
    }

    // Add a button to the main menu to open this profile
    this.addMainMenuButton();
  }

  private addMainMenuButton(): void {
    // This creates a visual indicator in the main menu that a country is selected
    const mainMenu = document.querySelector('.sidebar, .main-menu, [role="navigation"]');
    if (mainMenu) {
      let countryIndicator = document.querySelector('.country-profile-indicator');
      if (!countryIndicator) {
        countryIndicator = h('div', { className: 'country-profile-indicator' });
        const header = mainMenu.querySelector('[role="banner"], .menu-header');
        if (header) {
          header.parentElement?.insertBefore(countryIndicator, header.nextSibling);
        } else {
          mainMenu.insertBefore(countryIndicator, mainMenu.firstChild);
        }
      }

      countryIndicator.innerHTML = safeHtml(
        `<div class="country-profile-indicator-content">` +
        `<span class="flag">${toFlagEmoji(this.countryCode)}</span>` +
        `<span class="name">${this.countryName}</span>` +
        `<span class="action">${t('country_profile.viewing', 'Viewing Country Profile')}</span>` +
        `</div>`
      );
    }
  }

  private injectStyles(): void {
    if (document.head.querySelector('style[data-country-profile]')) {
      return;
    }

    const style = document.createElement('style');
    style.setAttribute('data-country-profile', 'true');
    style.textContent = `
      .country-profile-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.6);
        z-index: 10000;
        display: flex;
        align-items: center;
        justify-content: center;
        animation: fadeIn 0.2s ease-out;
        backdrop-filter: blur(4px);
      }

      @keyframes fadeIn {
        from {
          opacity: 0;
        }
        to {
          opacity: 1;
        }
      }

      .country-profile-modal {
        background: var(--bg-primary, #1a1a1a);
        border: 1px solid var(--border-color, #333);
        border-radius: 12px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
        width: 95%;
        max-width: 1400px;
        height: 95vh;
        max-height: 95vh;
        display: flex;
        flex-direction: column;
        animation: slideUp 0.3s ease-out;
        overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }

      @keyframes slideUp {
        from {
          opacity: 0;
          transform: translateY(30px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      .country-profile-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 24px;
        border-bottom: 1px solid var(--border-color, #333);
        background: var(--bg-secondary, #242424);
        flex-shrink: 0;
      }

      .country-profile-title-section {
        display: flex;
        align-items: center;
        gap: 16px;
      }

      .country-profile-flag {
        font-size: 48px;
        line-height: 1;
      }

      .country-profile-title-text {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .country-profile-country-name {
        margin: 0;
        font-size: 28px;
        font-weight: 600;
        color: var(--text-primary, #fff);
      }

      .country-profile-country-code {
        font-size: 12px;
        font-weight: 600;
        color: var(--text-secondary, #999);
        text-transform: uppercase;
        letter-spacing: 1px;
        font-family: monospace;
      }

      .country-profile-header-right {
        display: flex;
        align-items: center;
        gap: 16px;
      }

      .country-profile-status-badge {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        background: var(--bg-primary, #1a1a1a);
        border: 1px solid var(--border-color, #333);
        border-radius: 6px;
        font-size: 12px;
        font-weight: 600;
        color: var(--text-secondary, #999);
      }

      .status-dot {
        display: inline-block;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #00ff00;
        animation: pulse 2s infinite;
      }

      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
      }

      .country-profile-close {
        background: transparent;
        border: none;
        font-size: 24px;
        color: var(--text-primary, #fff);
        cursor: pointer;
        padding: 4px 8px;
        transition: color 0.15s;
      }

      .country-profile-close:hover {
        color: var(--accent-color, #00aaff);
      }

      .country-profile-body {
        flex: 1;
        overflow-y: auto;
        padding: 16px;
      }

      .country-profile-panel-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
        gap: 16px;
      }

      .country-profile-panel-wrapper {
        grid-column: 1 / -1;
        min-height: 400px;
        border: 1px solid var(--border-color, #333);
        border-radius: 8px;
        background: var(--bg-secondary, #242424);
        padding: 16px;
      }

      .country-profile-mini-panel {
        border: 1px solid var(--border-color, #333);
        border-radius: 8px;
        background: var(--bg-secondary, #242424);
        overflow: hidden;
      }

      .country-profile-mini-panel-title {
        margin: 0;
        padding: 12px 16px;
        background: var(--bg-primary, #1a1a1a);
        border-bottom: 1px solid var(--border-color, #333);
        font-size: 13px;
        font-weight: 600;
        color: var(--text-primary, #fff);
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }

      .country-profile-mini-panel-content {
        padding: 16px;
        color: var(--text-primary, #fff);
        font-size: 13px;
        line-height: 1.6;
      }

      .country-profile-indicator {
        padding: 12px 16px;
        margin: 12px;
        background: var(--accent-color, #00aaff);
        color: #000;
        border-radius: 6px;
        font-weight: 600;
        font-size: 12px;
      }

      .country-profile-indicator-content {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .country-profile-indicator .flag {
        font-size: 16px;
      }

      .country-profile-indicator .name {
        flex: 1;
      }

      .country-profile-indicator .action {
        opacity: 0.8;
        font-size: 11px;
      }

      @media (max-width: 768px) {
        .country-profile-modal {
          max-width: 100%;
          height: 100%;
          max-height: 100vh;
          border-radius: 0;
        }

        .country-profile-country-name {
          font-size: 20px;
        }

        .country-profile-flag {
          font-size: 32px;
        }

        .country-profile-header-right {
          gap: 8px;
        }

        .country-profile-status-badge {
          display: none;
        }

        .country-profile-panel-grid {
          grid-template-columns: 1fr;
        }
      }
    `;
    document.head.appendChild(style);
  }

  public updateCountry(countryCode: string, countryName: string): void {
    this.countryCode = countryCode;
    this.countryName = countryName;
    this.renderHeader();
  }

  public getCountryCode(): string {
    return this.countryCode;
  }

  public getCountryName(): string {
    return this.countryName;
  }

  public getPanelContainer(panelId: string): HTMLElement | undefined {
    return this.countryPanels.get(panelId);
  }

  public close(): void {
    this.container.remove();
    const indicator = document.querySelector('.country-profile-indicator');
    if (indicator) indicator.remove();
    this.onClose?.();
  }

  public destroy(): void {
    this.close();
  }
}
