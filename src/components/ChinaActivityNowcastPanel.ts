import { Panel } from './Panel';
import { getChinaActivityNowcastData } from '@/services/china-activity-nowcast';
import { unsafeRawHtml } from '@/utils/sanitize';
import type { ChinaActivityNowcastResponse } from '../../shared/china-activity-nowcast';
import { renderChinaActivityNowcastView } from './china-activity-nowcast-view';

export class ChinaActivityNowcastPanel extends Panel {
  private response: ChinaActivityNowcastResponse | null = null;

  constructor() {
    super({
      id: 'china-activity-nowcast',
      title: 'China Activity Nowcast',
      className: 'panel-wide',
      defaultRowSpan: 2,
      infoTooltip: 'A deterministic directional comparison of revision-aware official activity and reviewed proxy families. Missing and stale inputs are excluded; this is not a replacement GDP estimate.',
    });
  }

  public async fetchData(): Promise<boolean> {
    // Re-entered by the scroll-driven loadAllData pass and the 15-min
    // scheduler; the service has no client cache (cacheTtlMs: 0), so the
    // loading radar must not replace a rendered comparison for the whole
    // RPC round-trip on every refresh.
    if (!this.hasData()) this.showLoading();
    const response = await getChinaActivityNowcastData();
    this.setData(response);
    return response.state !== 'insufficient_data';
  }

  public hasData(): boolean {
    return this.response !== null;
  }

  public setData(response: ChinaActivityNowcastResponse): void {
    this.response = response;
    this.render();
  }

  private render(): void {
    if (this.response === null) return;
    this.setSafeContent(unsafeRawHtml(
      renderChinaActivityNowcastView(this.response),
      'China activity nowcast renderer escapes every dynamic value before constructing markup',
    ));
  }
}
