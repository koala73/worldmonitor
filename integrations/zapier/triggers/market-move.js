'use strict';

const { BASE_URL, PATHS, EVENT_REGISTRY } = require('../constants');
const { subscribe, unsubscribe, receive, toNumber, readList, scopeFromInputs } = require('../lib/hooks');

const EVENT = EVENT_REGISTRY.events['market.move'];
const INPUT = EVENT.inputSchema.properties;
const ASSET_CLASS_CHOICES = Object.fromEntries(EVENT.assetClasses.map((assetClass) => [assetClass, assetClass]));
const DIRECTION_CHOICES = Object.fromEntries(INPUT.direction.enum.map((direction) => [direction, direction]));
const SAMPLE_ROWS = 10;

// The relay's quote lists and the labels it publishes moves under.
const QUOTE_SOURCES = {
  equity: { path: PATHS.marketQuotes, source: 'Equity Market', criticalPct: 10 },
  commodity: { path: PATHS.commodityQuotes, source: 'Commodity Market', criticalPct: 10 },
  crypto: { path: PATHS.cryptoQuotes, source: 'Crypto Market', criticalPct: 20 },
};

const readInputs = (bundle) => ({
  assetClasses: readList(bundle.inputData.asset_classes),
  symbols: readList(bundle.inputData.symbols).map((symbol) => symbol.toUpperCase()),
  minAbsPct: toNumber(bundle.inputData.min_abs_pct, INPUT.minAbsPct.default),
  direction: String(bundle.inputData.direction || INPUT.direction.default),
});

const performSubscribe = (z, bundle) => subscribe(z, bundle, {
  eventType: EVENT.key,
  scope: scopeFromInputs(readInputs(bundle)),
});

const performUnsubscribe = (z, bundle) => unsubscribe(z, bundle);

const perform = (z, bundle) => receive(z, bundle, { eventType: EVENT.key });

// Sample rows: the largest current moves among the asset classes in scope,
// shaped like a delivery. The percent floor is not applied to samples (on a
// calm day nothing would clear it); symbols and direction are.
const performList = async (z, bundle) => {
  const { assetClasses, symbols, direction } = readInputs(bundle);
  const classes = assetClasses.length ? assetClasses.filter((c) => QUOTE_SOURCES[c]) : Object.keys(QUOTE_SOURCES);
  const rows = [];
  for (const assetClass of classes) {
    const { path, source, criticalPct } = QUOTE_SOURCES[assetClass];
    const response = await z.request({ url: `${BASE_URL}${path}` });
    const data = response.data || {};
    const asOf = typeof data.asOf === 'string' && data.asOf ? data.asOf : new Date().toISOString();
    for (const quote of Array.isArray(data.quotes) ? data.quotes : []) {
      if (!quote || typeof quote.symbol !== 'string' || !Number.isFinite(quote.change)) continue;
      const symbol = quote.symbol.toUpperCase();
      rows.push({
        id: `sample:${assetClass}:${symbol}:${asOf}`,
        eventType: EVENT.key,
        deliveryId: null,
        subscriberId: 'sample',
        eventId: `sample:${assetClass}:${symbol}`,
        assetClass,
        symbol,
        name: quote.name || symbol,
        price: Number.isFinite(quote.price) ? quote.price : null,
        changePct: quote.change,
        direction: quote.change < 0 ? 'down' : 'up',
        severity: Math.abs(quote.change) >= criticalPct ? 'critical' : 'high',
        source,
        publishedAt: asOf,
        triggeredAt: asOf,
        reason: 'large_move',
      });
    }
  }
  return rows
    .filter((row) => (!symbols.length || symbols.includes(row.symbol)) && (direction === 'any' || row.direction === direction))
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
    .slice(0, SAMPLE_ROWS);
};

module.exports = {
  key: 'market_move',
  noun: EVENT.noun,
  display: {
    label: 'New Large Market Move',
    description: EVENT.description.replace('minAbsPct', 'the Minimum Move'),
  },
  operation: {
    type: 'hook',
    inputFields: [
      {
        key: 'asset_classes',
        label: 'Asset Classes',
        type: 'string',
        required: false,
        list: true,
        choices: ASSET_CLASS_CHOICES,
        helpText: INPUT.assetClasses.description,
      },
      {
        key: 'symbols',
        label: 'Symbols',
        type: 'string',
        required: false,
        list: true,
        helpText: `${INPUT.symbols.description} For example VIX, GC=F or BTC.`,
      },
      {
        key: 'min_abs_pct',
        label: 'Minimum Move (%)',
        type: 'number',
        required: false,
        default: String(INPUT.minAbsPct.default),
        helpText: INPUT.minAbsPct.description,
      },
      {
        key: 'direction',
        label: 'Direction',
        type: 'string',
        required: false,
        choices: DIRECTION_CHOICES,
        default: INPUT.direction.default,
        helpText: `${INPUT.direction.description} A move that holds all day is delivered once; one that escalates into the critical band is delivered again.`,
      },
    ],
    performSubscribe,
    performUnsubscribe,
    perform,
    performList,
    sample: { id: 'whd_9b4d2e7f1a3c5e8d0f2b4a6c8e1d3f50', eventType: EVENT.key, deliveryId: 'whd_9b4d2e7f1a3c5e8d0f2b4a6c8e1d3f50', ...EVENT.sample },
    outputFields: [
      { key: 'id', label: 'Delivery ID' },
      { key: 'eventId', label: 'Move ID' },
      { key: 'assetClass', label: 'Asset Class' },
      { key: 'symbol', label: 'Symbol' },
      { key: 'name', label: 'Name' },
      { key: 'price', label: 'Price', type: 'number' },
      { key: 'changePct', label: 'Day Change (%)', type: 'number' },
      { key: 'direction', label: 'Direction' },
      { key: 'severity', label: 'Severity' },
      { key: 'source', label: 'Market' },
      { key: 'publishedAt', label: 'Published At', type: 'datetime' },
      { key: 'triggeredAt', label: 'Triggered At', type: 'datetime' },
      { key: 'reason', label: 'Reason' },
    ],
  },
};
