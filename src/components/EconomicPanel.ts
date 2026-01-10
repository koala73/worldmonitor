import type { FredSeries } from '@/services/fred';
import { getChangeClass, formatChange } from '@/services/fred';

export class EconomicPanel {
  private container: HTMLElement;
  private data: FredSeries[] = [];
  private isLoading = true;
  private lastUpdate: Date | null = null;
  private hasError = false;
  private errorMessage = '';

  constructor(container: HTMLElement) {
    this.container = container;
    this.render();
  }

  public update(data: FredSeries[]): void {
    this.data = data;
    this.isLoading = false;
    this.hasError = false;
    this.lastUpdate = new Date();
    this.render();
  }

  public setLoading(loading: boolean): void {
    this.isLoading = loading;
    this.render();
  }

  public setErrorState(hasError: boolean, message = ''): void {
    this.hasError = hasError;
    this.errorMessage = message;
    this.render();
  }

  private render(): void {
    const headerClass = this.hasError ? 'panel-header panel-header-error' : 'panel-header';
    const headerTitle = this.hasError && this.errorMessage ? ` title="${this.errorMessage}"` : '';

    if (this.isLoading) {
      this.container.innerHTML = `
        <div class="economic-panel">
          <div class="${headerClass}"${headerTitle}>
            <span class="panel-title">ECONOMIC INDICATORS</span>
            <span class="panel-source">FRED</span>
          </div>
          <div class="panel-loading">Loading economic data...</div>
        </div>
      `;
      return;
    }

    if (this.data.length === 0) {
      this.container.innerHTML = `
        <div class="economic-panel">
          <div class="${headerClass}"${headerTitle}>
            <span class="panel-title">ECONOMIC INDICATORS</span>
            <span class="panel-source">FRED</span>
          </div>
          <div class="panel-empty">${this.hasError ? this.errorMessage || 'Failed to load data' : 'No data available'}</div>
        </div>
      `;
      return;
    }

    const indicatorsHtml = this.data.map(series => {
      const changeClass = getChangeClass(series.change);
      const changeStr = formatChange(series.change, series.unit);
      const arrow = series.change !== null
        ? (series.change > 0 ? '▲' : series.change < 0 ? '▼' : '–')
        : '';

      return `
        <div class="economic-indicator" data-series="${series.id}">
          <div class="indicator-header">
            <span class="indicator-name">${series.name}</span>
            <span class="indicator-id">${series.id}</span>
          </div>
          <div class="indicator-value">
            <span class="value">${series.value !== null ? series.value : 'N/A'}${series.unit}</span>
            <span class="change ${changeClass}">${arrow} ${changeStr}</span>
          </div>
          <div class="indicator-date">${series.date}</div>
        </div>
      `;
    }).join('');

    const updateTime = this.lastUpdate
      ? this.lastUpdate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';

    this.container.innerHTML = `
      <div class="economic-panel">
        <div class="${headerClass}"${headerTitle}>
          <span class="panel-title">ECONOMIC INDICATORS</span>
          <span class="panel-source">FRED • ${updateTime}</span>
        </div>
        <div class="economic-indicators">
          ${indicatorsHtml}
        </div>
      </div>
    `;
  }

  public getElement(): HTMLElement {
    return this.container;
  }
}
