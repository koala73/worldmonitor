import { Panel } from './Panel';
import { unsafeRawHtml } from '@/utils/sanitize';
import { fetchMultipleStocks, type MarketFetchResult } from '@/services/market';
import { NQ_PULSE_BASKET, NQ_PULSE_DISCLOSURE } from '@/config/nq-context';
import { combineAbortSignals, createTimeoutSignal } from '@/services/timeout-signal';
import {
  composeNqPulseHtml,
  freshnessLabelForAsOf,
  nqPulseAsOfLabel,
  orderNqPulseRows,
} from './nq-pulse-content';

const NQ_REQUEST_TIMEOUT_MS = 15_000;

export interface NqPulsePanelDependencies {
  fetchStocks: (
    symbols: readonly { symbol: string; name: string; display: string }[],
    options: { signal: AbortSignal },
  ) => Promise<MarketFetchResult>;
  nowMs: () => number;
  createTimeoutSignal: (ms: number) => AbortSignal;
  combineAbortSignals: (signals: AbortSignal[]) => AbortSignal;
}

const DEFAULT_DEPENDENCIES: NqPulsePanelDependencies = {
  fetchStocks: (symbols, options) => fetchMultipleStocks(symbols, options),
  nowMs: () => Date.now(),
  createTimeoutSignal,
  combineAbortSignals,
};

export class NqPulsePanel extends Panel {
  private requestGeneration = 0;

  constructor(private readonly dependencies: NqPulsePanelDependencies = DEFAULT_DEPENDENCIES) {
    super({
      id: 'nq-pulse',
      title: 'NQ Pulse',
      showCount: false,
      infoTooltip: NQ_PULSE_DISCLOSURE,
    });
  }

  public async fetchData(): Promise<boolean> {
    const generation = ++this.requestGeneration;
    this.showLoading('Loading NQ context...');
    try {
      const timeoutSignal = this.dependencies.createTimeoutSignal(NQ_REQUEST_TIMEOUT_MS);
      const requestSignal = this.dependencies.combineAbortSignals([this.signal, timeoutSignal]);
      const result = await this.dependencies.fetchStocks(NQ_PULSE_BASKET, { signal: requestSignal });
      if (this.signal.aborted || generation !== this.requestGeneration) return false;
      const nowMs = this.dependencies.nowMs();
      const freshness = freshnessLabelForAsOf(result.asOf, nowMs);
      const html = composeNqPulseHtml({
        rows: orderNqPulseRows(result.data, NQ_PULSE_BASKET),
        freshness,
        asOfLabel: nqPulseAsOfLabel(result.asOf, freshness),
      });
      this.setSafeContent(unsafeRawHtml(html, 'NQ Pulse rows use escaped instrument labels and formatted quotes'));
      return result.data.length > 0;
    } catch (error) {
      if (this.signal.aborted || generation !== this.requestGeneration || this.isAbortError(error)) return false;
      this.showError(error instanceof Error ? error.message : 'NQ context unavailable.', () => {
        void this.fetchData();
      });
      return false;
    }
  }
}
