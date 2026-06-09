import { Panel } from './Panel';
import { h, replaceChildren } from '@/utils/dom-utils';
import { getCurrentLanguage, t } from '@/services/i18n';
import {
  buildPortfolioImpactViewModel,
  fetchPersonalPortfolioExport,
  type PortfolioImpactAction,
  type PortfolioImpactTheme,
  type PortfolioImpactViewModel,
} from '@/services/personal-portfolio';

function actionLabel(level: PortfolioImpactAction['level']): string {
  const ja = getCurrentLanguage() === 'ja';
  switch (level) {
    case 'alert':
      return ja ? '警戒' : 'Alert';
    case 'watch':
      return ja ? '監視' : 'Watch';
    default:
      return ja ? '情報' : 'Info';
  }
}

export class PortfolioImpactPanel extends Panel {
  private static readonly ACTION_LIMIT = 3;
  private static readonly MOBILE_ACTION_LIMIT = 2;
  private static readonly HOLDING_LIMIT = 4;
  private static readonly MOBILE_HOLDING_LIMIT = 3;
  private static readonly THEME_LIMIT = 3;
  private static readonly RULE_LIMIT = 3;
  private loading = true;
  private viewModel: PortfolioImpactViewModel | null = null;
  private lastFingerprint = '';

  constructor() {
    super({
      id: 'portfolio-impact',
      title: t('panels.portfolioImpact') || 'Portfolio Impact',
      showCount: true,
      trackActivity: true,
      defaultRowSpan: 2,
      infoTooltip: 'Translates World Monitor signals into portfolio review priorities using AI_System holdings.',
    });
    this.showLoading();
    void this.refresh();
  }

  private buildUnavailableViewModel(): PortfolioImpactViewModel {
    return {
      generatedAt: new Date().toISOString(),
      summary: {
        holding_count: 0,
        account_count: 0,
        total_gain_pct: null,
        cached_prices: true,
      },
      actions: [],
      topHoldings: [],
      currencies: [],
      themes: [],
      activeRules: [],
    };
  }

  public async refresh(): Promise<boolean> {
    try {
      const payload = await fetchPersonalPortfolioExport('risk', { signal: this.signal });
      if (!this.element?.isConnected) return false;
      const nextView = buildPortfolioImpactViewModel(payload);
      const fingerprint = JSON.stringify({
        generatedAt: nextView.generatedAt,
        actions: nextView.actions,
        topHoldings: nextView.topHoldings.map((holding) => [holding.ticker, holding.weight_pct]),
        activeRules: nextView.activeRules.map((rule) => [rule.rule_id, rule.ok, rule.message]),
      });
      const changed = fingerprint !== this.lastFingerprint;
      this.lastFingerprint = fingerprint;
      this.viewModel = nextView;
      this.loading = false;
      this.setCount(nextView.actions.length);
      this.render();
      return changed;
    } catch (error) {
      if (this.isAbortError(error)) return false;
      if (!this.element?.isConnected) return false;
      this.loading = false;
      this.viewModel = this.buildUnavailableViewModel();
      this.setCount(0);
      console.error('[PortfolioImpactPanel] fetch error:', error);
      this.render();
      return true;
    }
  }

  protected render(): void {
    const ja = this.isJapanese();
    if (this.loading) {
      this.showLoading();
      return;
    }

    if (!this.viewModel) {
      replaceChildren(this.content, h('div', { className: 'portfolio-impact-empty' }, ja ? 'ポートフォリオ文脈はまだありません。' : 'No portfolio context available.'));
      return;
    }

    this.setErrorState(false);
    replaceChildren(
      this.content,
      this.buildQuickRead(this.viewModel),
      this.buildSummary(this.viewModel),
      this.buildActions(this.viewModel.actions),
      this.buildHoldings(this.viewModel),
      this.buildThemes(this.viewModel.themes),
      this.buildRules(this.viewModel),
    );
  }

  private buildQuickRead(viewModel: PortfolioImpactViewModel): HTMLElement {
    const ja = this.isJapanese();
    const primaryAction = viewModel.actions[0] ?? null;
    const topTheme = viewModel.themes[0] ?? null;
    const topHolding = viewModel.topHoldings[0] ?? null;

    return h('div', { className: 'portfolio-impact-section finance-guide-brief' },
      h('div', { className: 'portfolio-impact-section-title' }, ja ? 'クイック確認' : 'Quick Read'),
      h(
        'div',
        { className: 'portfolio-impact-item-body finance-guide-brief-line' },
        primaryAction
          ? `${ja ? '主眼' : 'Primary'} ${primaryAction.title}`
          : ja ? '主眼 直ちに確認すべきポートフォリオ対応はありません。' : 'Primary No immediate portfolio action.',
      ),
      h(
        'div',
        { className: 'portfolio-impact-item-body finance-guide-brief-line' },
        topTheme
          ? `${ja ? 'テーマ' : 'Theme'} ${this.translatePortfolioText(topTheme.title)}`
          : ja ? 'テーマ まだ市場連動の整理はありません。' : 'Theme No market translation yet.',
      ),
      h(
        'div',
        { className: 'portfolio-impact-item-body finance-guide-brief-line' },
        topHolding
          ? `${ja ? '最大保有' : 'Largest'} ${topHolding.ticker} ${topHolding.weight_pct.toFixed(1)}%`
          : ja ? '最大保有 保有スナップショットはまだありません。' : 'Largest No holding snapshot yet.',
      ),
    );
  }

  private buildSummary(viewModel: PortfolioImpactViewModel): HTMLElement {
    const ja = this.isJapanese();
    const gain = viewModel.summary.total_gain_pct;
    return h('div', { className: 'portfolio-impact-summary service-status-summary' },
      h('div', { className: 'summary-item operational' },
        h('span', { className: 'summary-count' }, String(viewModel.summary.holding_count)),
        h('span', { className: 'summary-label' }, ja ? '保有数' : 'Holdings'),
      ),
      h('div', { className: 'summary-item degraded' },
        h('span', { className: 'summary-count' }, String(viewModel.activeRules.length)),
        h('span', { className: 'summary-label' }, ja ? '発火ルール' : 'Open Rules'),
      ),
      h('div', { className: 'summary-item outage' },
        h('span', { className: 'summary-count' }, gain === null ? 'N/A' : `${gain.toFixed(1)}%`),
        h('span', { className: 'summary-label' }, ja ? '総損益' : 'Total Gain'),
      ),
    );
  }

  private buildActions(actions: PortfolioImpactAction[]): HTMLElement {
    const ja = this.isJapanese();
    const limit = this.isCompactViewport()
      ? PortfolioImpactPanel.MOBILE_ACTION_LIMIT
      : PortfolioImpactPanel.ACTION_LIMIT;

    if (actions.length === 0) {
      return h('div', { className: 'portfolio-impact-section' },
        h('div', { className: 'portfolio-impact-section-title' }, ja ? '本日' : 'Today'),
        h('div', { className: 'portfolio-impact-empty' }, ja ? '直ちに対応すべきポートフォリオアクションはありません。' : 'No immediate portfolio actions.'),
      );
    }

    return h('div', { className: 'portfolio-impact-section' },
      h('div', { className: 'portfolio-impact-section-title' }, ja ? '本日' : 'Today'),
      ...actions.slice(0, limit).map((action) =>
        h('div', { className: `portfolio-impact-item portfolio-impact-${action.level}` },
          h('div', { className: 'portfolio-impact-item-header' },
            h('span', { className: 'portfolio-impact-badge' }, actionLabel(action.level)),
            h('span', { className: 'portfolio-impact-item-title' }, action.title),
          ),
          h('div', { className: 'portfolio-impact-item-body' }, action.body),
        ),
      ),
      ...(actions.length > limit
        ? [h('div', { className: 'portfolio-impact-footnote' }, ja ? `${actions.length}件中 ${limit}件を表示` : `Showing ${limit} of ${actions.length} actions`)]
        : []),
    );
  }

  private buildHoldings(viewModel: PortfolioImpactViewModel): HTMLElement {
    const ja = this.isJapanese();
    const limit = this.isCompactViewport()
      ? PortfolioImpactPanel.MOBILE_HOLDING_LIMIT
      : PortfolioImpactPanel.HOLDING_LIMIT;

    return h('div', { className: 'portfolio-impact-section portfolio-impact-holdings' },
      h('div', { className: 'portfolio-impact-section-title' }, ja ? '主要保有' : 'Top Holdings'),
      ...viewModel.topHoldings.slice(0, limit).map((holding) =>
        h('div', { className: 'portfolio-impact-row' },
          h('div', { className: 'portfolio-impact-row-main' },
            h('span', { className: 'portfolio-impact-ticker' }, holding.ticker),
            h('span', { className: 'portfolio-impact-name' }, holding.name),
          ),
          h('div', { className: 'portfolio-impact-row-side' },
            h('span', { className: 'portfolio-impact-weight' }, `${holding.weight_pct.toFixed(1)}%`),
            h('span', { className: 'portfolio-impact-currency' }, holding.currency),
          ),
        ),
      ),
      h('div', { className: 'portfolio-impact-currency-strip' },
        ...viewModel.currencies.slice(0, 3).map((entry) =>
          h('span', { className: 'portfolio-impact-chip' }, `${entry.currency} ${entry.weight_pct.toFixed(1)}%`),
        ),
      ),
      ...(viewModel.topHoldings.length > limit
        ? [h('div', { className: 'portfolio-impact-footnote' }, ja ? `${viewModel.topHoldings.length}件中 ${limit}件を表示` : `Showing ${limit} of ${viewModel.topHoldings.length} holdings`)]
        : []),
    );
  }

  private buildThemes(themes: PortfolioImpactTheme[]): HTMLElement {
    const ja = this.isJapanese();
    if (themes.length === 0) {
      return h('div', { className: 'portfolio-impact-section' },
        h('div', { className: 'portfolio-impact-section-title' }, ja ? '市場連動' : 'Market Links'),
        h('div', { className: 'portfolio-impact-empty' }, ja ? 'まだポートフォリオ向けの市場連動整理はありません。' : 'No portfolio-specific market translation yet.'),
      );
    }

    return h('div', { className: 'portfolio-impact-section' },
      h('div', { className: 'portfolio-impact-section-title' }, ja ? '市場連動' : 'Market Links'),
      ...themes.slice(0, PortfolioImpactPanel.THEME_LIMIT).map((theme) =>
        h('div', { className: 'portfolio-impact-item' },
          h('div', { className: 'portfolio-impact-item-title' }, this.translatePortfolioText(theme.title)),
          h('div', { className: 'portfolio-impact-item-body' }, this.translatePortfolioText(theme.rationale)),
        ),
      ),
      ...(themes.length > PortfolioImpactPanel.THEME_LIMIT
        ? [h('div', { className: 'portfolio-impact-footnote' }, ja ? `${themes.length}件中 ${PortfolioImpactPanel.THEME_LIMIT}件を表示` : `Showing ${PortfolioImpactPanel.THEME_LIMIT} of ${themes.length} links`)]
        : []),
    );
  }

  private buildRules(viewModel: PortfolioImpactViewModel): HTMLElement {
    const ja = this.isJapanese();
    if (viewModel.activeRules.length === 0) {
      return h('div', { className: 'portfolio-impact-footnote' }, `${ja ? '更新' : 'Updated'} ${this.formatTimestamp(viewModel.generatedAt)}`);
    }

    return h('div', { className: 'portfolio-impact-section' },
      h('div', { className: 'portfolio-impact-section-title' }, ja ? '発火ルール' : 'Triggered Rules'),
      ...viewModel.activeRules.slice(0, PortfolioImpactPanel.RULE_LIMIT).map((rule) =>
        h('div', { className: 'portfolio-impact-row' },
          h('div', { className: 'portfolio-impact-row-main' },
            h('span', { className: 'portfolio-impact-item-title' }, rule.name || rule.rule_id),
            h('span', { className: 'portfolio-impact-item-body' }, rule.message),
          ),
          h('span', { className: 'portfolio-impact-chip' }, (() => {
            if (!ja) return rule.severity;
            const JA_SEVERITY: Record<string, string> = { warn: '注意', alert: '警戒', critical: '重大', watch: '監視', info: '情報', high: '高', medium: '中', low: '低' };
            return JA_SEVERITY[rule.severity] ?? rule.severity;
          })()),
        ),
      ),
      ...(viewModel.activeRules.length > PortfolioImpactPanel.RULE_LIMIT
        ? [h('div', { className: 'portfolio-impact-footnote' }, ja ? `${viewModel.activeRules.length}件中 ${PortfolioImpactPanel.RULE_LIMIT}件を表示` : `Showing ${PortfolioImpactPanel.RULE_LIMIT} of ${viewModel.activeRules.length} rules`)]
        : []),
      h('div', { className: 'portfolio-impact-footnote' }, `${ja ? '更新' : 'Updated'} ${this.formatTimestamp(viewModel.generatedAt)}`),
    );
  }

  private formatTimestamp(value: string): string {
    try {
      return new Date(value).toLocaleString();
    } catch {
      return value;
    }
  }

  private isCompactViewport(): boolean {
    return globalThis.window?.matchMedia?.('(max-width: 768px)').matches ?? false;
  }

  private isJapanese(): boolean {
    return getCurrentLanguage() === 'ja';
  }

  private translatePortfolioText(text: string): string {
    if (!this.isJapanese()) return text;
    return text
      .replace(/Semiconductor sensitivity/g, '半導体感応度')
      .replace(/No immediate portfolio action\./g, '直ちに確認すべきポートフォリオ対応はありません。')
      .replace(/No market translation yet\./g, 'まだ市場連動の整理はありません。')
      .replace(/Largest/g, '最大保有')
      .replace(/Primary/g, '主眼')
      .replace(/Theme/g, 'テーマ');
  }
}
