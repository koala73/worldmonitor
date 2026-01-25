import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { calculateCII, type CountryScore } from '@/services/country-instability';

export class CIIPanel extends Panel {
  private scores: CountryScore[] = [];
  private focalPointsReady = false;

  constructor() {
    super({
      id: 'cii',
      title: 'Country Instability Index',
      showCount: true,
      trackActivity: true,
      infoTooltip: `<strong>CII Methodology</strong>
        Score (0-100) per country based on:
        <ul>
          <li>40% baseline geopolitical risk</li>
          <li><strong>U</strong>nrest: protests, fatalities, internet outages</li>
          <li><strong>S</strong>ecurity: military flights/vessels over territory</li>
          <li><strong>I</strong>nformation: news velocity and focal point correlation</li>
          <li>Hotspot proximity boost (strategic locations)</li>
        </ul>
        <em>U:S:I values show component scores.</em>
        Focal Point Detection correlates news entities with map signals for accurate scoring.`,
    });
    // Show loading state until focal points ready
    this.content.innerHTML = `
      <div class="cii-awaiting">
        <div class="cii-awaiting-icon">📊</div>
        <div class="cii-awaiting-text">Analyzing intelligence...</div>
        <div class="cii-awaiting-sub">Correlating news with map signals</div>
      </div>
    `;
  }

  private getLevelColor(level: CountryScore['level']): string {
    switch (level) {
      case 'critical': return '#ff4444';
      case 'high': return '#ff8800';
      case 'elevated': return '#ffaa00';
      case 'normal': return '#88aa44';
      case 'low': return '#22aa88';
    }
  }

  private getLevelEmoji(level: CountryScore['level']): string {
    switch (level) {
      case 'critical': return '🔴';
      case 'high': return '🟠';
      case 'elevated': return '🟡';
      case 'normal': return '🟢';
      case 'low': return '⚪';
    }
  }

  private getTrendArrow(trend: CountryScore['trend'], change: number): string {
    if (trend === 'rising') return `<span class="trend-up">↑${change > 0 ? change : ''}</span>`;
    if (trend === 'falling') return `<span class="trend-down">↓${Math.abs(change)}</span>`;
    return '<span class="trend-stable">→</span>';
  }

  private renderCountry(country: CountryScore): string {
    const barWidth = country.score;
    const color = this.getLevelColor(country.level);
    const emoji = this.getLevelEmoji(country.level);
    const trend = this.getTrendArrow(country.trend, country.change24h);

    return `
      <div class="cii-country" data-code="${escapeHtml(country.code)}">
        <div class="cii-header">
          <span class="cii-emoji">${emoji}</span>
          <span class="cii-name">${escapeHtml(country.name)}</span>
          <span class="cii-score">${country.score}</span>
          ${trend}
        </div>
        <div class="cii-bar-container">
          <div class="cii-bar" style="width: ${barWidth}%; background: ${color};"></div>
        </div>
        <div class="cii-components">
          <span title="Unrest">U:${country.components.unrest}</span>
          <span title="Security">S:${country.components.security}</span>
          <span title="Information">I:${country.components.information}</span>
        </div>
      </div>
    `;
  }

  public async refresh(forceLocal = false): Promise<void> {
    // Don't show scores until focal points are ready (avoids misleading preliminary data)
    if (!this.focalPointsReady && !forceLocal) {
      return; // Keep showing "Analyzing intelligence..." state
    }

    if (forceLocal) {
      this.focalPointsReady = true;
      console.log('[CIIPanel] Focal points ready, calculating scores...');
    }

    this.showLoading();

    try {
      // Calculate with focal point data
      const localScores = calculateCII();
      const localWithData = localScores.filter(s => s.score > 0).length;
      this.scores = localScores;
      console.log(`[CIIPanel] Calculated ${localWithData} countries with focal point intelligence`);

      const withData = this.scores.filter(s => s.score > 0);
      this.setCount(withData.length);

      if (withData.length === 0) {
        this.content.innerHTML = '<div class="empty-state">No instability signals detected</div>';
        return;
      }

      const html = withData.map(s => this.renderCountry(s)).join('');
      this.content.innerHTML = `<div class="cii-list">${html}</div>`;
    } catch (error) {
      console.error('[CIIPanel] Refresh error:', error);
      this.showError('Failed to calculate CII');
    }
  }

  public getScores(): CountryScore[] {
    return this.scores;
  }
}
