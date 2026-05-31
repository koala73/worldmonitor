import type { AppContext } from '@/app/app-context';
import { CountrySelector } from '@/components/CountrySelector';
import { CountryProfileView } from '@/components/CountryProfileView';

/**
 * CountryProfileManager handles the country selection UI and profile view orchestration.
 * Manages:
 * - Country selector modal (search, map, dropdown)
 * - Country profile overlay with focused panels
 * - Integration with AppContext for data filtering
 */
export class CountryProfileManager {
  private appContext: AppContext;
  private countrySelector: CountrySelector | null = null;
  private countryProfileView: CountryProfileView | null = null;
  private selectedCountryCode: string | null = null;
  private selectedCountryName: string | null = null;
  private selectorContainer: HTMLElement;

  constructor(appContext: AppContext) {
    this.appContext = appContext;
    this.selectorContainer = document.createElement('div');
    this.selectorContainer.id = 'country-selector-container';
  }

  /**
   * Opens the country selector modal for the user to choose a country
   */
  public openCountrySelector(): void {
    if (this.countrySelector) {
      return; // Already open
    }

    this.countrySelector = new CountrySelector({
      container: this.selectorContainer,
      onCountrySelected: (code, name) => this.selectCountry(code, name),
      onClose: () => this.closeCountrySelector(),
    });

    this.countrySelector.updateStyles();
  }

  /**
   * Closes the country selector modal
   */
  public closeCountrySelector(): void {
    if (this.countrySelector) {
      this.countrySelector.destroy();
      this.countrySelector = null;
    }
  }

  /**
   * Handles country selection - opens the country profile view
   */
  public selectCountry(countryCode: string, countryName: string): void {
    this.selectedCountryCode = countryCode;
    this.selectedCountryName = countryName;

    // Close selector if open
    this.closeCountrySelector();

    // Close existing profile if any
    if (this.countryProfileView) {
      this.countryProfileView.destroy();
    }

    // Create and show new profile
    this.countryProfileView = new CountryProfileView({
      appContext: this.appContext,
      countryCode: countryCode,
      countryName: countryName,
      onClose: () => this.closeCountryProfile(),
    });

    // Load country-specific data
    this.loadCountryData(countryCode, countryName);
  }

  /**
   * Loads and displays country-specific data in the profile view
   */
  private loadCountryData(countryCode: string, countryName: string): void {
    if (!this.countryProfileView) return;

    // Update news filtering for this country
    this.filterNewsByCountry(countryCode);

    // Load country-specific panels data
    this.loadCountryPanelData(countryCode, countryName);

    // Load country-specific military intelligence
    this.loadCountryMilitaryData(countryCode);

    // Load country-specific economic data
    this.loadCountryEconomicData(countryCode);

    // Load country-specific energy profile
    this.loadCountryEnergyData(countryCode);

    // Subscribe to real-time updates for this country
    this.subscribeToCountryUpdates(countryCode);
  }

  /**
   * Filters news items by country
   */
  private filterNewsByCountry(countryCode: string): void {
    // Create a filtered view of news relevant to this country
    const countryRelevantNews = this.appContext.allNews.filter(news => {
      // Check if news mentions the country in title or countries field
      const title = (news.title || '').toLowerCase();
      const countries = (news.countries || []).map(c => c.toLowerCase());
      
      return title.includes(countryCode.toLowerCase()) || 
             title.includes(countryCode.toUpperCase()) ||
             countries.includes(countryCode.toLowerCase());
    });

    // Store filtered news for use in panels
    (window as any).__COUNTRY_PROFILE_NEWS = countryRelevantNews;
  }

  /**
   * Loads country-specific panel data (uses CountryDeepDivePanel)
   */
  private loadCountryPanelData(countryCode: string, countryName: string): void {
    if (!this.countryProfileView) return;

    const container = this.countryProfileView.getPanelContainer('CountryDeepDive');
    if (!container) return;

    // Trigger the CountryDeepDivePanel to load this country's data
    const countryDeepDivePanel = this.appContext.panels['CountryDeepDive'];
    if (countryDeepDivePanel && typeof (countryDeepDivePanel as any).loadCountry === 'function') {
      (countryDeepDivePanel as any).loadCountry(countryCode, countryName);
    }
  }

  /**
   * Loads military presence and activity for the country
   */
  private loadCountryMilitaryData(countryCode: string): void {
    if (!this.countryProfileView) return;

    const container = this.countryProfileView.getPanelContainer('CountryMilitaryProfile');
    if (!container) return;

    // Filter military flights and vessels by country proximity/basing
    const militaryFlights = (this.appContext.intelligenceCache.military?.flights || []).filter(
      flight => flight.countryCode === countryCode || flight.originCountry === countryCode
    );

    const militaryVessels = (this.appContext.intelligenceCache.military?.vessels || []).filter(
      vessel => vessel.countryCode === countryCode || vessel.homePort?.includes(countryCode)
    );

    const html = `
      <div style="padding: 12px;">
        <div style="margin-bottom: 12px;">
          <strong>Military Flights:</strong> ${militaryFlights.length}
        </div>
        <div style="margin-bottom: 12px;">
          <strong>Naval Vessels:</strong> ${militaryVessels.length}
        </div>
        <p style="font-size: 12px; color: var(--text-secondary, #999);">
          ${militaryFlights.length + militaryVessels.length > 0 
            ? 'Active military operations detected.' 
            : 'No significant military activity detected.'}
        </p>
      </div>
    `;

    container.innerHTML = html;
  }

  /**
   * Loads economic indicators for the country
   */
  private loadCountryEconomicData(countryCode: string): void {
    if (!this.countryProfileView) return;

    const container = this.countryProfileView.getPanelContainer('CountryEconomyProfile');
    if (!container) return;

    // Fetch economic data from markets and other sources
    const countryMarkets = this.appContext.latestMarkets.filter(market => 
      market.countryCode === countryCode
    );

    const html = `
      <div style="padding: 12px;">
        <div style="margin-bottom: 12px;">
          <strong>Market Indices:</strong> ${countryMarkets.length}
        </div>
        <div style="margin-bottom: 12px;">
          <strong>Data Sources:</strong> IMF, World Bank, Central Banks
        </div>
        <p style="font-size: 12px; color: var(--text-secondary, #999);">
          Economic indicators loading...
        </p>
      </div>
    `;

    container.innerHTML = html;
  }

  /**
   * Loads energy profile and disruption risks for the country
   */
  private loadCountryEnergyData(countryCode: string): void {
    if (!this.countryProfileView) return;

    const container = this.countryProfileView.getPanelContainer('CountryEnergyProfile');
    if (!container) return;

    const html = `
      <div style="padding: 12px;">
        <div style="margin-bottom: 12px;">
          <strong>Energy Status:</strong> Loading...
        </div>
        <div style="margin-bottom: 12px;">
          <strong>Production:</strong> Analyzing...
        </div>
        <p style="font-size: 12px; color: var(--text-secondary, #999);">
          Pipeline and supply status loading...
        </p>
      </div>
    `;

    container.innerHTML = html;
  }

  /**
   * Subscribes to real-time updates for the selected country
   */
  private subscribeToCountryUpdates(countryCode: string): void {
    // This would connect to WebSocket or Server-Sent Events for real-time updates
    // For now, we'll set up polling at the data-loader level to refresh country-specific data
    
    // Store the selected country in window for data-loader to use
    (window as any).__SELECTED_COUNTRY_CODE = countryCode;

    // Trigger a data refresh for country-specific services
    // This could integrate with the existing RefreshScheduler
  }

  /**
   * Closes the country profile view
   */
  public closeCountryProfile(): void {
    if (this.countryProfileView) {
      this.countryProfileView.destroy();
      this.countryProfileView = null;
    }

    this.selectedCountryCode = null;
    this.selectedCountryName = null;

    // Clear country-specific state
    delete (window as any).__SELECTED_COUNTRY_CODE;
    delete (window as any).__COUNTRY_PROFILE_NEWS;
  }

  /**
   * Gets the currently selected country code
   */
  public getSelectedCountryCode(): string | null {
    return this.selectedCountryCode;
  }

  /**
   * Gets the currently selected country name
   */
  public getSelectedCountryName(): string | null {
    return this.selectedCountryName;
  }

  /**
   * Checks if a country profile is currently open
   */
  public isCountryProfileOpen(): boolean {
    return this.countryProfileView !== null;
  }

  /**
   * Updates the country profile view (e.g., after data refresh)
   */
  public updateCountryProfile(): void {
    if (this.countryProfileView && this.selectedCountryCode) {
      this.loadCountryData(this.selectedCountryCode, this.selectedCountryName!);
    }
  }

  /**
   * Cleans up resources
   */
  public destroy(): void {
    this.closeCountrySelector();
    this.closeCountryProfile();
    this.selectorContainer.remove();
  }
}
