import { Panel } from './Panel';
import { unsafeRawHtml } from '@/utils/sanitize';
import { fetchMultipleStocks } from '@/services/market';
import { NQ_PULSE_BASKET, NQ_PULSE_DISCLOSURE } from '@/config/nq-context';
import {
  composeNqPulseHtml,
  freshnessLabelForAsOf,
  nqPulseAsOfLabel,
  orderNqPulseRows,
} from './nq-pulse-content';

export class NqPulsePanel extends Panel {
  constructor() {
    super({
      id: 'nq-pulse',
      title: 'NQ Pulse',
      showCount: false,
      infoTooltip: NQ_PULSE_DISCLOSURE,
    });
  }

  public async fetchData(): Promise<boolean> {
    this.showLoading('Loading NQ context...');
    try {
      const result = await fetchMultipleStocks(NQ_PULSE_BASKET);
      if (this.signal.aborted) return false;
      const nowMs = Date.now();
      const freshness = freshnessLabelForAsOf(result.asOf, nowMs);
      const html = composeNqPulseHtml({
        rows: orderNqPulseRows(result.data, NQ_PULSE_BASKET),
        freshness,
        asOfLabel: nqPulseAsOfLabel(result.asOf, freshness),
      });
      this.setSafeContent(unsafeRawHtml(html, 'NQ Pulse rows use escaped instrument labels and formatted quotes'));
      return result.data.length > 0;
    } catch (error) {
      if (this.signal.aborted || this.isAbortError(error)) return false;
      this.showError(error instanceof Error ? error.message : 'NQ context unavailable.', () => {
        void this.fetchData();
      });
      return false;
    }
  }
}
