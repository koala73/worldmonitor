import type {
  EconomicServiceClient,
  GetEconomicCalendarResponse,
} from '@/generated/client/worldmonitor/economic/v1/service_client';
import type {
  ListEarningsCalendarResponse,
  MarketServiceClient,
} from '@/generated/client/worldmonitor/market/v1/service_client';
import { Panel } from './Panel';
import { unsafeRawHtml } from '@/utils/sanitize';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { combineAbortSignals, createTimeoutSignal } from '@/services/timeout-signal';
import { NQ_EARNINGS_WINDOW_DAYS, NQ_MACRO_WINDOW_DAYS, NQ_PULSE_DISCLOSURE } from '@/config/nq-context';
import {
  composeNqCatalystsHtml,
  filterNqEarnings,
  filterNqMacroEvents,
} from './nq-catalysts-content';
import { nqCalendarWindow, type NqCalendarWindow } from './nq-calendar-window';

const NQ_REQUEST_TIMEOUT_MS = 15_000;

let economicClient: EconomicServiceClient | null = null;
let marketClient: MarketServiceClient | null = null;

async function getEconomicClient(): Promise<EconomicServiceClient> {
  if (!economicClient) {
    const { EconomicServiceClient } = await import('@/generated/client/worldmonitor/economic/v1/service_client');
    economicClient = new EconomicServiceClient(getRpcBaseUrl(), {
      fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
    });
  }
  return economicClient;
}

async function getMarketClient(): Promise<MarketServiceClient> {
  if (!marketClient) {
    const { MarketServiceClient } = await import('@/generated/client/worldmonitor/market/v1/service_client');
    marketClient = new MarketServiceClient(getRpcBaseUrl(), {
      fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
    });
  }
  return marketClient;
}

export interface NqCatalystsPanelDependencies {
  now: () => Date;
  createTimeoutSignal: (ms: number) => AbortSignal;
  combineAbortSignals: (signals: AbortSignal[]) => AbortSignal;
  fetchMacro: (window: NqCalendarWindow, signal: AbortSignal) => Promise<GetEconomicCalendarResponse>;
  fetchEarnings: (window: NqCalendarWindow, signal: AbortSignal) => Promise<ListEarningsCalendarResponse>;
}

const DEFAULT_DEPENDENCIES: NqCatalystsPanelDependencies = {
  now: () => new Date(),
  createTimeoutSignal,
  combineAbortSignals,
  fetchMacro: async (window, signal) => {
    const client = await getEconomicClient();
    return client.getEconomicCalendar(
      { fromDate: window.from, toDate: window.to },
      { signal },
    );
  },
  fetchEarnings: async (window, signal) => {
    const client = await getMarketClient();
    return client.listEarningsCalendar(
      { fromDate: window.from, toDate: window.to },
      { signal },
    );
  },
};

export class NqCatalystsPanel extends Panel {
  private requestGeneration = 0;

  constructor(private readonly dependencies: NqCatalystsPanelDependencies = DEFAULT_DEPENDENCIES) {
    super({
      id: 'nq-catalysts',
      title: 'NQ Catalysts',
      showCount: false,
      infoTooltip: NQ_PULSE_DISCLOSURE,
    });
  }

  public async fetchData(): Promise<boolean> {
    const generation = ++this.requestGeneration;
    this.showLoading('Loading NQ catalysts...');
    const now = this.dependencies.now();
    const macroWindow = nqCalendarWindow(now, NQ_MACRO_WINDOW_DAYS);
    const earningsWindow = nqCalendarWindow(now, NQ_EARNINGS_WINDOW_DAYS);

    try {
      const macroTimeoutSignal = this.dependencies.createTimeoutSignal(NQ_REQUEST_TIMEOUT_MS);
      const earningsTimeoutSignal = this.dependencies.createTimeoutSignal(NQ_REQUEST_TIMEOUT_MS);
      const macroSignal = this.dependencies.combineAbortSignals([this.signal, macroTimeoutSignal]);
      const earningsSignal = this.dependencies.combineAbortSignals([this.signal, earningsTimeoutSignal]);
      const [macroSettled, earningsSettled] = await Promise.allSettled([
        this.dependencies.fetchMacro(macroWindow, macroSignal),
        this.dependencies.fetchEarnings(earningsWindow, earningsSignal),
      ]);
      if (this.signal.aborted || generation !== this.requestGeneration) return false;

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
      if (this.signal.aborted || generation !== this.requestGeneration || this.isAbortError(error)) return false;
      this.showError(error instanceof Error ? error.message : 'NQ catalysts unavailable.', () => {
        void this.fetchData();
      });
      return false;
    }
  }
}
