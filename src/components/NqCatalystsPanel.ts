import { Panel } from './Panel';
import { localYmd } from '@/utils/local-date';
import { unsafeRawHtml } from '@/utils/sanitize';
import { createLazyClient, getRpcBaseUrl, rpcFetch } from '@/services/rpc-client';
import { EconomicServiceClient, MarketServiceClient } from '@/services/generated-rpc-clients';
import { combineAbortSignals, createTimeoutSignal } from '@/services/timeout-signal';
import { LatestRequestGuard } from '@/utils/latest-request-guard';
import { NQ_EARNINGS_WINDOW_DAYS, NQ_MACRO_WINDOW_DAYS, NQ_PULSE_DISCLOSURE } from '@/config/nq-context';
import {
  composeNqCatalystsHtml,
  filterNqEarnings,
  filterNqMacroEvents,
  nqInclusiveWindowTo,
} from './nq-catalysts-content';

export const NQ_CATALYSTS_REQUEST_TIMEOUT_MS = 15_000;

const getEconomicClient = createLazyClient(() => new EconomicServiceClient(getRpcBaseUrl(), { fetch: rpcFetch }));
const getMarketClient = createLazyClient(() => new MarketServiceClient(getRpcBaseUrl(), { fetch: rpcFetch }));

export class NqCatalystsPanel extends Panel {
  private readonly requestGuard = new LatestRequestGuard();

  constructor() {
    super({
      id: 'nq-catalysts',
      title: 'NQ Catalysts',
      showCount: false,
      infoTooltip: NQ_PULSE_DISCLOSURE,
    });
  }

  public async fetchData(): Promise<boolean> {
    const generation = this.requestGuard.begin();
    this.showLoading('Loading NQ catalysts...');
    const now = new Date();
    const macroFrom = localYmd(now);
    const macroTo = nqInclusiveWindowTo(now, NQ_MACRO_WINDOW_DAYS);
    const earningsFrom = localYmd(now);
    const earningsTo = nqInclusiveWindowTo(now, NQ_EARNINGS_WINDOW_DAYS);
    const macroSignal = combineAbortSignals([
      this.signal,
      createTimeoutSignal(NQ_CATALYSTS_REQUEST_TIMEOUT_MS),
    ]);
    const earningsSignal = combineAbortSignals([
      this.signal,
      createTimeoutSignal(NQ_CATALYSTS_REQUEST_TIMEOUT_MS),
    ]);

    try {
      const [macroSettled, earningsSettled] = await Promise.allSettled([
        getEconomicClient().getEconomicCalendar(
          { fromDate: macroFrom, toDate: macroTo },
          { signal: macroSignal },
        ),
        getMarketClient().listEarningsCalendar(
          { fromDate: earningsFrom, toDate: earningsTo },
          { signal: earningsSignal },
        ),
      ]);
      if (!this.requestGuard.isCurrent(generation) || this.signal.aborted) return false;

      const macroUnavailable = macroSettled.status !== 'fulfilled' || Boolean(macroSettled.value.unavailable);
      const earningsUnavailable = earningsSettled.status !== 'fulfilled' || Boolean(earningsSettled.value.unavailable);
      const macroEvents = macroSettled.status === 'fulfilled' ? macroSettled.value.events ?? [] : [];
      const earnings = earningsSettled.status === 'fulfilled' ? earningsSettled.value.earnings ?? [] : [];

      const html = composeNqCatalystsHtml({
        macro: filterNqMacroEvents(macroEvents, now),
        earnings: filterNqEarnings(earnings, now),
        macroUnavailable,
        earningsUnavailable,
        macroAsOf: macroSettled.status === 'fulfilled' ? macroSettled.value.asOf : undefined,
        earningsAsOf: earningsSettled.status === 'fulfilled' ? earningsSettled.value.asOf : undefined,
      });
      this.setSafeContent(unsafeRawHtml(html, 'NQ Catalysts rows use escaped event labels and source dates'));
      return !macroUnavailable || !earningsUnavailable;
    } catch (error) {
      if (!this.requestGuard.isCurrent(generation) || this.signal.aborted || this.isAbortError(error)) {
        return false;
      }
      this.showError(error instanceof Error ? error.message : 'NQ catalysts unavailable.', () => {
        void this.fetchData();
      });
      return false;
    }
  }
}
