import { Panel } from './Panel';
import type { GivingSummary } from '@/services/giving';
import { t } from '@/services/i18n';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import {
  availableGivingTabs,
  renderGivingPanelContent,
} from './giving-renderer';
import type { GivingTab } from './giving-renderer';

export class GivingPanel extends Panel {
  private data: GivingSummary | null = null;
  private activeTab: GivingTab = 'platforms';

  constructor() {
    super({
      id: 'giving',
      title: t('components.giving.benchmarkTitle'),
      showCount: true,
      trackActivity: true,
      infoTooltip: t('components.giving.benchmarkInfoTooltip'),
    });
    this.showLoading(t('common.loadingGiving'));
  }

  public setData(data: GivingSummary): void {
    this.data = data;
    this.setCount(data.platforms.length);
    this.renderContent();
  }

  public hasData(): boolean {
    return this.data !== null;
  }

  private renderContent(): void {
    if (!this.data) return;
    const tabs = availableGivingTabs(this.data);
    if (!tabs.includes(this.activeTab)) this.activeTab = 'platforms';

    setTrustedHtml(
      this.content,
      trustedHtml(
        renderGivingPanelContent(this.data, this.activeTab, t),
        'Giving provenance renderer escapes values and validates source links',
      ),
    );

    this.content.querySelectorAll('.panel-tab').forEach((button) => {
      button.addEventListener('click', () => {
        this.activeTab = (button as HTMLElement).dataset.tab as GivingTab;
        this.renderContent();
      });
    });
  }
}
