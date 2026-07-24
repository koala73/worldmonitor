import { Panel } from './Panel';
import {
  GIVING_STALE_CEILING_MS,
  type GivingSummary,
} from '@/services/giving/model';
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
  private expiryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private disposed = false;

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
    if (this.disposed) return;
    if (!this.scheduleExpiry(data.materializedAt)) {
      this.showUnavailable();
      return;
    }

    this.data = data;
    this.setErrorState(false);
    this.setCount(data.platforms.length);
    this.renderContent();
  }

  public showUnavailable(): void {
    if (this.disposed) return;
    this.clearExpiryTimer();
    this.data = null;
    this.setCount(0);
    this.showError();
  }

  public hasData(): boolean {
    return this.data !== null;
  }

  private scheduleExpiry(materializedAtValue: string): boolean {
    if (this.disposed) return false;
    this.clearExpiryTimer();
    const materializedAt = Date.parse(materializedAtValue);
    const expiresInMs = materializedAt + GIVING_STALE_CEILING_MS - Date.now();
    if (!Number.isFinite(materializedAt) || expiresInMs <= 0) return false;

    this.expiryTimer = globalThis.setTimeout(() => {
      this.expiryTimer = null;
      if (this.disposed) return;
      this.showUnavailable();
    }, expiresInMs);
    return true;
  }

  private clearExpiryTimer(): void {
    if (this.expiryTimer === null) return;
    globalThis.clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
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

  public override destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearExpiryTimer();
    super.destroy();
  }
}
