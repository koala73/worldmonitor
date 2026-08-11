/**
 * Server-side Massive minute-bar relay.
 *
 * Browsers subscribe to this application's stream endpoint; this module alone
 * authenticates to Massive. The relay validates every aggregate, keys each
 * stored bar by symbol/interval/timestamp, reference-counts subscriptions and
 * emits an honest stale/degraded state on disconnect.
 */

import { setCachedJson } from '../../../_shared/redis';
import WebSocket from 'ws';
import { resolveUsEquityMarketState } from './market-calendar';
import { normalizeStockSymbol } from './stock-data-contract';

const MASSIVE_STOCKS_SOCKET = 'wss://socket.massive.com/stocks';

export type StockStreamProviderStatus =
  | 'PROVIDER_STATUS_REALTIME_LICENSED'
  | 'PROVIDER_STATUS_DELAYED_UNVERIFIED'
  | 'PROVIDER_STATUS_STALE'
  | 'PROVIDER_STATUS_DEGRADED'
  | 'PROVIDER_STATUS_NOT_CONFIGURED'
  | 'PROVIDER_STATUS_MARKET_CLOSED';

export type MarketMinuteBar = {
  symbol: string;
  interval: '1m';
  timestampUtc: number;
  endTimestampUtc: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap: number;
  transactions: number;
};

export type MarketStreamStatus = {
  provider: 'massive';
  providerStatus: StockStreamProviderStatus;
  fetchedAt: number;
  observedAt: number;
  freshnessSeconds: number;
  reason: string;
};

export type MarketStreamEvent =
  | { type: 'bar'; bar: MarketMinuteBar; status: MarketStreamStatus }
  | { type: 'status'; status: MarketStreamStatus };

export type WebSocketLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

export type MarketStreamRelayOptions = {
  apiKey?: string | null;
  realtimeDisplayAndRedistributionConfirmed?: boolean;
  socketFactory?: (url: string) => WebSocketLike;
  now?: () => number;
  unsubscribeDelayMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  ringLimit?: number;
};

type MassiveMinuteAggregate = {
  ev?: string;
  sym?: string;
  v?: number;
  vw?: number;
  o?: number;
  c?: number;
  h?: number;
  l?: number;
  n?: number;
  s?: number;
  e?: number;
};

type Subscriber = (event: MarketStreamEvent) => void;

function defaultSocketFactory(url: string): WebSocketLike {
  const socket = new WebSocket(url);
  const adapter: WebSocketLike = {
    get readyState() { return socket.readyState; },
    send: data => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  socket.on('open', () => adapter.onopen?.({}));
  socket.on('message', data => adapter.onmessage?.({ data: data.toString() }));
  socket.on('close', () => adapter.onclose?.({}));
  socket.on('error', () => adapter.onerror?.({}));
  return adapter;
}

function jsonEvent(event: MarketStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function configuredKey(options: MarketStreamRelayOptions): string | null {
  const raw = options.apiKey === undefined ? process.env.MASSIVE_API_KEY : options.apiKey;
  const key = String(raw ?? '').trim();
  return key || null;
}

function hasRealtimeEntitlement(options: MarketStreamRelayOptions): boolean {
  return options.realtimeDisplayAndRedistributionConfirmed === undefined
    ? process.env.MASSIVE_REALTIME_DISPLAY_AND_REDISTRIBUTION_CONFIRMED === 'true'
    : options.realtimeDisplayAndRedistributionConfirmed;
}

function nowMs(options: MarketStreamRelayOptions): number {
  return options.now?.() ?? Date.now();
}

function validateAggregate(raw: unknown): MarketMinuteBar | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as MassiveMinuteAggregate;
  if (value.ev !== 'AM') return null;
  let symbol: string;
  try {
    symbol = normalizeStockSymbol(value.sym ?? '');
  } catch {
    return null;
  }
  const values = [value.s, value.e, value.o, value.h, value.l, value.c, value.v];
  if (!values.every(Number.isFinite)) return null;
  if ((value.s as number) <= 0 || (value.e as number) < (value.s as number)) return null;
  if ((value.v as number) < 0 || (value.l as number) > (value.o as number) || (value.l as number) > (value.c as number)
    || (value.h as number) < (value.o as number) || (value.h as number) < (value.c as number)) return null;
  return {
    symbol,
    interval: '1m',
    timestampUtc: value.s as number,
    endTimestampUtc: value.e as number,
    open: value.o as number,
    high: value.h as number,
    low: value.l as number,
    close: value.c as number,
    volume: value.v as number,
    vwap: Number.isFinite(value.vw) ? value.vw as number : 0,
    transactions: Number.isFinite(value.n) ? value.n as number : 0,
  };
}

/** Exported so a live fixture can be replayed without an outbound socket. */
export function parseMassiveMinuteAggregate(raw: unknown): MarketMinuteBar | null {
  return validateAggregate(raw);
}

export class MarketStockStreamRelay {
  private readonly subscribersBySymbol = new Map<string, Set<Subscriber>>();
  private readonly unsubscribeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly barsBySymbol = new Map<string, Map<string, MarketMinuteBar>>();
  private socket: WebSocketLike | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private stopped = false;
  private lastObservedAt = 0;
  private lastStatus: MarketStreamStatus;

  constructor(private readonly options: MarketStreamRelayOptions = {}) {
    this.lastStatus = this.statusForCurrentState('relay has not connected');
  }

  get configured(): boolean {
    return configuredKey(this.options) !== null;
  }

  get realtimeEntitled(): boolean {
    return hasRealtimeEntitlement(this.options);
  }

  get status(): MarketStreamStatus {
    return { ...this.lastStatus, fetchedAt: nowMs(this.options), freshnessSeconds: this.freshnessSeconds() };
  }

  subscribe(symbolInput: string, subscriber: Subscriber): () => void {
    const symbol = normalizeStockSymbol(symbolInput);
    const timer = this.unsubscribeTimers.get(symbol);
    if (timer) {
      clearTimeout(timer);
      this.unsubscribeTimers.delete(symbol);
    }
    const subscribers = this.subscribersBySymbol.get(symbol) ?? new Set<Subscriber>();
    const firstSubscriber = subscribers.size === 0;
    subscribers.add(subscriber);
    this.subscribersBySymbol.set(symbol, subscribers);
    subscriber({ type: 'status', status: this.status });
    if (firstSubscriber) this.subscribeUpstream(symbol);
    this.ensureConnected();
    return () => this.release(symbol, subscriber);
  }

  snapshot(symbolInput: string): MarketMinuteBar[] {
    const symbol = normalizeStockSymbol(symbolInput);
    return [...(this.barsBySymbol.get(symbol)?.values() ?? [])]
      .sort((left, right) => left.timestampUtc - right.timestampUtc);
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    for (const timer of this.unsubscribeTimers.values()) clearTimeout(timer);
    this.unsubscribeTimers.clear();
    this.socket?.close(1000, 'relay stopped');
    this.socket = null;
  }

  /** Test and adapter entry point for an already-decoded upstream message. */
  ingest(raw: unknown): boolean {
    const bar = validateAggregate(raw);
    if (!bar || !this.subscribersBySymbol.has(bar.symbol)) return false;
    const bars = this.barsBySymbol.get(bar.symbol) ?? new Map<string, MarketMinuteBar>();
    const storageKey = this.barKey(bar);
    bars.set(storageKey, bar); // upsert: repeated AM updates never append a duplicate bar.
    this.trimRing(bars);
    this.barsBySymbol.set(bar.symbol, bars);
    this.lastObservedAt = Math.max(this.lastObservedAt, bar.endTimestampUtc);
    const state = resolveUsEquityMarketState(new Date(nowMs(this.options)));
    const status: MarketStreamStatus = {
      provider: 'massive',
      providerStatus: state.marketClosed
        ? 'PROVIDER_STATUS_MARKET_CLOSED'
        : this.realtimeEntitled
          ? 'PROVIDER_STATUS_REALTIME_LICENSED'
          : 'PROVIDER_STATUS_DELAYED_UNVERIFIED',
      fetchedAt: nowMs(this.options),
      observedAt: bar.endTimestampUtc,
      freshnessSeconds: this.freshnessSeconds(),
      reason: state.reason,
    };
    this.lastStatus = status;
    void setCachedJson(this.redisKey(bar), bar, 15 * 60);
    this.emit(bar.symbol, { type: 'bar', bar, status });
    return true;
  }

  private ensureConnected(): void {
    if (this.stopped || this.socket || this.subscribersBySymbol.size === 0) return;
    if (!this.configured) {
      this.publishStatus(this.statusForCurrentState('MASSIVE_API_KEY is not configured'));
      return;
    }
    if (!this.realtimeEntitled) {
      this.publishStatus(this.statusForCurrentState('Massive real-time display and redistribution entitlement is not confirmed'));
      return;
    }
    const socket = (this.options.socketFactory ?? defaultSocketFactory)(MASSIVE_STOCKS_SOCKET);
    this.socket = socket;
    socket.onopen = () => {
      const apiKey = configuredKey(this.options);
      if (!apiKey) return;
      socket.send(JSON.stringify({ action: 'auth', params: apiKey }));
      for (const symbol of this.subscribersBySymbol.keys()) this.subscribeUpstream(symbol);
      this.reconnectAttempts = 0;
      this.publishStatus(this.statusForCurrentState('upstream connected'));
    };
    socket.onmessage = event => this.handleMessage(event.data);
    socket.onerror = () => this.publishStatus(this.statusForCurrentState('upstream socket error', 'PROVIDER_STATUS_DEGRADED'));
    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      if (!this.stopped && this.subscribersBySymbol.size > 0) {
        this.publishStatus(this.statusForCurrentState('upstream socket disconnected', 'PROVIDER_STATUS_STALE'));
        this.scheduleReconnect();
      }
    };
  }

  private handleMessage(data: unknown): void {
    let payload: unknown;
    try {
      payload = JSON.parse(String(data));
    } catch {
      this.publishStatus(this.statusForCurrentState('malformed upstream message rejected', 'PROVIDER_STATUS_DEGRADED'));
      return;
    }
    const messages = Array.isArray(payload) ? payload : [payload];
    for (const message of messages) this.ingest(message);
  }

  private release(symbol: string, subscriber: Subscriber): void {
    const subscribers = this.subscribersBySymbol.get(symbol);
    if (!subscribers) return;
    subscribers.delete(subscriber);
    if (subscribers.size > 0) return;
    const delay = this.options.unsubscribeDelayMs ?? 30_000;
    const timer = setTimeout(() => {
      if (this.subscribersBySymbol.get(symbol)?.size) return;
      this.subscribersBySymbol.delete(symbol);
      this.unsubscribeTimers.delete(symbol);
      this.unsubscribeUpstream(symbol);
    }, delay);
    this.unsubscribeTimers.set(symbol, timer);
  }

  private subscribeUpstream(symbol: string): void {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify({ action: 'subscribe', params: `AM.${symbol}` }));
  }

  private unsubscribeUpstream(symbol: string): void {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify({ action: 'unsubscribe', params: `AM.${symbol}` }));
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped || !this.configured || !this.realtimeEntitled) return;
    const base = this.options.reconnectBaseMs ?? 500;
    const maximum = this.options.reconnectMaxMs ?? 30_000;
    const exponential = Math.min(maximum, base * (2 ** this.reconnectAttempts));
    const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(exponential * 0.25)));
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureConnected();
    }, exponential + jitter);
  }

  private barKey(bar: MarketMinuteBar): string {
    return `${bar.symbol}:${bar.interval}:${bar.timestampUtc}`;
  }

  private redisKey(bar: MarketMinuteBar): string {
    return `market:stream-bar:v1:massive:${bar.symbol}:${bar.interval}:${bar.timestampUtc}`;
  }

  private trimRing(bars: Map<string, MarketMinuteBar>): void {
    const limit = this.options.ringLimit ?? 1_000;
    if (bars.size <= limit) return;
    const oldest = [...bars.values()].sort((left, right) => left.timestampUtc - right.timestampUtc)[0];
    if (oldest) bars.delete(this.barKey(oldest));
  }

  private freshnessSeconds(): number {
    if (this.lastObservedAt <= 0) return -1;
    return Math.max(0, Math.floor((nowMs(this.options) - this.lastObservedAt) / 1000));
  }

  private statusForCurrentState(reason: string, forcedStatus?: StockStreamProviderStatus): MarketStreamStatus {
    const state = resolveUsEquityMarketState(new Date(nowMs(this.options)));
    const providerStatus = forcedStatus
      ?? (!this.configured
        ? 'PROVIDER_STATUS_NOT_CONFIGURED'
        : state.marketClosed
          ? 'PROVIDER_STATUS_MARKET_CLOSED'
          : this.realtimeEntitled
            ? 'PROVIDER_STATUS_REALTIME_LICENSED'
            : 'PROVIDER_STATUS_DELAYED_UNVERIFIED');
    return {
      provider: 'massive', providerStatus, fetchedAt: nowMs(this.options), observedAt: this.lastObservedAt,
      freshnessSeconds: this.freshnessSeconds(), reason,
    };
  }

  private publishStatus(status: MarketStreamStatus): void {
    this.lastStatus = status;
    for (const symbol of this.subscribersBySymbol.keys()) this.emit(symbol, { type: 'status', status });
  }

  private emit(symbol: string, event: MarketStreamEvent): void {
    for (const subscriber of this.subscribersBySymbol.get(symbol) ?? []) subscriber(event);
  }
}

let sharedRelay: MarketStockStreamRelay | null = null;

export function getSharedMarketStockStreamRelay(): MarketStockStreamRelay {
  sharedRelay ??= new MarketStockStreamRelay();
  return sharedRelay;
}

/** Encode one internal event for the same-origin browser SSE endpoint. */
export function serializeMarketStreamEvent(event: MarketStreamEvent): string {
  return jsonEvent(event);
}
