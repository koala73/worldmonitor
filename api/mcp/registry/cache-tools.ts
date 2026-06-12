import ISO2_TO_ISO3 from '../../../shared/iso2-to-iso3.js';
import { CII_RISK_SCORE_CACHE_KEYS } from '../../_cii-risk-cache-keys.js';
import { DEFAULT_LIST_LIMIT } from '../constants';
import {
  argBool,
  argNum,
  argStr,
  argStrList,
  cacheEnvelope,
  capArrays,
  capNested,
  capNestedMap,
  ciIncludes,
  compact,
  filterMapValues,
  mapNested,
  matchesCode,
  narrowArray,
  narrowNested,
  pickMapKeys,
  pickMapKeysLike,
  pickNestedMap,
  selectDatasets,
} from '../filters';
import type { ToolDef } from '../types';

export const CACHE_TOOLS: ToolDef[] = [
  {
    name: 'get_market_data',
    _outputBudgetBytes: 131072,
    description: 'Real-time equity quotes, commodity prices (including gold futures GC=F), crypto prices, forex FX rates (USD/EUR, USD/JPY etc.), sector performance, ETF flows, and Gulf market quotes from WorldMonitor\'s curated bootstrap cache.',
    inputSchema: {
      type: 'object',
      properties: {
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tickers to keep, e.g. ["AAPL","GC=F","BTC"]. Case-insensitive; matches equity/commodity/crypto/gulf quotes, sector ETFs, and ETF-flow tickers. Omit for the full snapshot.',
        },
        asset_class: {
          type: 'array',
          items: { type: 'string', enum: ['equity', 'commodity', 'crypto', 'sectors', 'etf', 'gulf', 'sentiment'] },
          description: 'Restrict the response to one or more asset classes. Omit for all.',
        },
        limit: { type: 'number', description: 'Cap each per-class quote list (stocks/commodities/crypto/gulf/sectors/ETF flows) to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      'stocks-bootstrap': {
        type: ['object', 'null'],
        properties: {
          quotes: { type: 'array', items: { type: 'object', properties: { symbol: { type: 'string' }, price: { type: 'number' }, changePercent: { type: 'number' } } } },
          finnhubSkipped: { type: 'boolean' },
          skipReason: { type: 'string' },
          rateLimited: { type: 'boolean' },
        },
      },
      'commodities-bootstrap': {
        type: ['object', 'null'],
        properties: {
          quotes: { type: 'array', items: { type: 'object', properties: { symbol: { type: 'string' }, price: { type: 'number' }, changePercent: { type: 'number' } } } },
        },
      },
      crypto: {
        type: ['object', 'null'],
        properties: {
          quotes: { type: 'array', items: { type: 'object', properties: { symbol: { type: 'string' }, price: { type: 'number' }, changePercent: { type: 'number' } } } },
        },
      },
      sectors: {
        type: ['object', 'null'],
        properties: {
          sectors: { type: 'array', items: { type: 'object', properties: { symbol: { type: 'string' }, name: { type: 'string' }, changePercent: { type: 'number' } } } },
          valuations: { type: ['object', 'array', 'null'] },
        },
      },
      'etf-flows': {
        type: ['object', 'null'],
        properties: {
          timestamp: { type: ['string', 'number', 'null'] },
          summary: { type: ['object', 'null'] },
          etfs: { type: 'array', items: { type: 'object', properties: { ticker: { type: 'string' }, flow: { type: 'number' } } } },
          rateLimited: { type: 'boolean' },
        },
      },
      'gulf-quotes': {
        type: ['object', 'null'],
        properties: {
          quotes: { type: 'array', items: { type: 'object', properties: { symbol: { type: 'string' }, price: { type: 'number' }, changePercent: { type: 'number' } } } },
          rateLimited: { type: 'boolean' },
        },
      },
      'fear-greed': {
        type: ['object', 'null'],
        properties: {
          timestamp: { type: ['string', 'number', 'null'] },
          composite: { type: ['object', 'number', 'null'], properties: {
            score: { type: 'number' }, label: { type: 'string' }, previous: { type: ['number', 'null'] },
          } },
          categories: { type: ['object', 'array', 'null'] },
          headerMetrics: { type: ['object', 'array', 'null'] },
          sectorPerformance: { type: ['object', 'array', 'null'] },
          unavailable: { type: 'boolean' },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const symbols = argStrList(params.symbols);
      if (symbols.length > 0) {
        for (const label of ['stocks-bootstrap', 'commodities-bootstrap', 'crypto', 'gulf-quotes']) {
          narrowNested(data, label, 'quotes', (q) => matchesCode(q.symbol, symbols));
        }
        narrowNested(data, 'sectors', 'sectors', (s) => matchesCode(s.symbol, symbols));
        narrowNested(data, 'etf-flows', 'etfs', (e) => matchesCode(e.ticker, symbols));
      }
      const limit = argNum(params.limit) ?? DEFAULT_LIST_LIMIT;
      for (const label of ['stocks-bootstrap', 'commodities-bootstrap', 'crypto', 'gulf-quotes']) {
        capNested(data, label, 'quotes', limit);
      }
      capNested(data, 'sectors', 'sectors', limit);
      capNested(data, 'etf-flows', 'etfs', limit);
      const cls = argStrList(params.asset_class);
      if (cls.length > 0) {
        const map: Record<string, string> = {
          equity: 'stocks-bootstrap', commodity: 'commodities-bootstrap', crypto: 'crypto',
          sectors: 'sectors', etf: 'etf-flows', gulf: 'gulf-quotes', sentiment: 'fear-greed',
        };
        return selectDatasets(data, compact(cls.map((c) => map[c])));
      }
      return data;
    },
    _cacheKeys: [
      'market:stocks-bootstrap:v1',
      'market:commodities-bootstrap:v1',
      'market:crypto:v1',
      'market:sectors:v2',
      'market:etf-flows:v1',
      'market:gulf-quotes:v1',
      'market:fear-greed:v1',
    ],
    _seedMetaKey: 'seed-meta:market:stocks',
    _maxStaleMin: 30,
    // NOTE: `GET /api/market/v1/get-gold-intelligence` is NOT covered here.
    // The audit-time cross-reference matched on the single `market:commodities-bootstrap:v1`
    // key shared between this tool and the gold-intel handler, but the handler also reads 4
    // gold-specific keys (COT, gold-extended, gold-ETF-flows, gold-CB-reserves) that this
    // tool's `_cacheKeys` does NOT expose. Excluded as `deferred-to-future-tool` in
    // tests/mcp-api-parity.test.mjs until a future commodities-expansion tool bundles those.
    _apiPaths: [
      "GET /api/market/v1/get-fear-greed-index",
      "GET /api/market/v1/get-sector-summary",
      "GET /api/market/v1/list-commodity-quotes",
      "GET /api/market/v1/list-crypto-quotes",
      "GET /api/market/v1/list-etf-flows",
      "GET /api/market/v1/list-gulf-quotes",
      "GET /api/market/v1/list-market-quotes",
    ],
  },
  {
    name: 'get_conflict_events',
    _outputBudgetBytes: 131072,
    description: 'Active armed conflict events (UCDP, Iran), unrest events with geo-coordinates, and country risk scores. Covers ongoing conflicts, protests, and instability indices worldwide.',
    inputSchema: {
      type: 'object',
      properties: {
        country: {
          type: 'string',
          description: 'Filter to one country — matches the country name on conflict/unrest events and the ISO 3166-1 alpha-2 region code on risk scores (case-insensitive).',
        },
        min_fatalities: {
          type: 'number',
          description: 'Drop events below this fatality count (UCDP deathsBest / unrest fatalities).',
        },
        limit: { type: 'number', description: 'Cap each event list to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      'ucdp-events': {
        type: ['object', 'null'],
        properties: {
          events: { type: 'array', items: { type: 'object', properties: {
            id: { type: 'string' }, dateStart: { type: ['number', 'string'] }, dateEnd: { type: ['number', 'string'] },
            location: { type: 'object', properties: { latitude: { type: 'number' }, longitude: { type: 'number' } } },
            country: { type: 'string' }, sideA: { type: 'string' }, sideB: { type: 'string' },
            deathsBest: { type: 'number' }, deathsLow: { type: 'number' }, deathsHigh: { type: 'number' },
            violenceType: { type: 'string' }, sourceOriginal: { type: 'string' },
          } } },
          fetchedAt: { type: ['number', 'string'] },
          version: { type: ['string', 'number'] },
          totalRaw: { type: 'number' },
          filteredCount: { type: 'number' },
        },
      },
      'iran-events': {
        type: ['object', 'null'],
        properties: {
          events: { type: 'array', items: { type: 'object', properties: {
            id: { type: 'string' }, country: { type: 'string' },
            location: { type: 'object', properties: { latitude: { type: 'number' }, longitude: { type: 'number' } } },
          } } },
          scrapedAt: { type: ['number', 'string'] },
        },
      },
      events: {
        type: ['object', 'null'],
        properties: {
          events: { type: 'array', items: { type: 'object', properties: {
            country: { type: 'string' }, fatalities: { type: 'number' },
            location: { type: 'object', properties: { latitude: { type: 'number' }, longitude: { type: 'number' } } },
          } } },
          clusters: { type: ['array', 'object', 'null'] },
        },
      },
      scores: {
        type: ['object', 'null'],
        properties: {
          ciiScores: { type: 'array', items: { type: 'object', properties: { region: { type: 'string' }, score: { type: 'number' } } } },
          strategicRisks: { type: ['array', 'object', 'null'] },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const country = argStr(params.country);
      const minFatal = argNum(params.min_fatalities);
      const limit = (argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      if (country) {
        narrowNested(data, 'ucdp-events', 'events', (e) => ciIncludes(e.country, country));
        narrowNested(data, 'events', 'events', (e) => ciIncludes(e.country, country));
        narrowNested(data, 'scores', 'ciiScores', (s) => matchesCode(s.region, [country]));
      }
      if (minFatal != null) {
        narrowNested(data, 'ucdp-events', 'events', (e) => (argNum(e.deathsBest) ?? 0) >= minFatal);
        narrowNested(data, 'events', 'events', (e) => (argNum(e.fatalities) ?? 0) >= minFatal);
      }
      for (const label of ['ucdp-events', 'iran-events', 'events']) capNested(data, label, 'events', limit);
      return data;
    },
    _cacheKeys: [
      'conflict:ucdp-events:v1',
      'conflict:iran-events:v1',
      'unrest:events:v1',
      CII_RISK_SCORE_CACHE_KEYS.stale,
    ],
    _seedMetaKey: 'seed-meta:conflict:ucdp-events',
    _maxStaleMin: 30,
    // NOTE: `GET /api/intelligence/v1/get-risk-scores` is NOT covered here.
    // The audit-time hint matched only this tool's conflict/risk cache keys,
    // but the handler at server/worldmonitor/intelligence/v1/get-risk-scores.ts
    // reads a broader cross-domain set (infra outages, climate anomalies,
    // cyber threats, wildfires, GPS jamming, OREF history, security
    // advisories, displacement, news insights, news threats, aviation,
    // earthquakes, sanctions, temporal anomalies, and military CII). Excluded
    // as `deferred-to-future-tool` -
    // belongs in a future expanded_risk_scores composite tool, not here.
    _apiPaths: [
      "GET /api/conflict/v1/list-iran-events",
      "GET /api/conflict/v1/list-ucdp-events",
      "GET /api/unrest/v1/list-unrest-events",
    ],
  },
  {
    name: 'get_aviation_status',
    _outputBudgetBytes: 131072,
    description: 'Airport delays, NOTAM airspace closures, and tracked military aircraft. Covers FAA delay data and active airspace restrictions.',
    inputSchema: {
      type: 'object',
      properties: {
        disrupted_only: {
          type: 'boolean',
          description: 'Drop airports with severity "normal" — keep only airports actually experiencing delays/closures. The bootstrap lists every monitored airport, so most rows are non-events without this.',
        },
        country: { type: 'string', description: 'Filter to one country by name (case-insensitive substring, e.g. "united states").' },
        iata: { type: 'string', description: 'Filter to a single airport by IATA code (e.g. "JFK").' },
        limit: { type: 'number', description: 'Cap the alert list to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      'delays-bootstrap': {
        type: ['object', 'null'],
        properties: {
          alerts: { type: 'array', items: { type: 'object', properties: {
            iata: { type: 'string' }, country: { type: 'string' },
            severity: { type: 'string' }, name: { type: 'string' },
          } } },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const country = argStr(params.country);
      const iata = argStr(params.iata);
      if (argBool(params.disrupted_only)) {
        narrowNested(data, 'delays-bootstrap', 'alerts', (a) => argStr(a.severity) !== 'normal');
      }
      if (country) narrowNested(data, 'delays-bootstrap', 'alerts', (a) => ciIncludes(a.country, country));
      if (iata) narrowNested(data, 'delays-bootstrap', 'alerts', (a) => argStr(a.iata) === iata);
      capNested(data, 'delays-bootstrap', 'alerts', (argNum(params.limit) ?? DEFAULT_LIST_LIMIT));
      return data;
    },
    _cacheKeys: ['aviation:delays-bootstrap:v2'],
    _seedMetaKey: 'seed-meta:aviation:faa',
    _maxStaleMin: 90,
    _apiPaths: [],
  },
  {
    name: 'get_news_intelligence',
    _outputBudgetBytes: 131072,
    description: 'AI-classified geopolitical threat news summaries, GDELT intelligence signals, cross-source signals, and security advisories from WorldMonitor\'s intelligence layer.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          enum: ['conflict', 'economy', 'cyber', 'nuclear', 'intelligence', 'maritime'],
          description: 'Filter GDELT intelligence to a single topic.',
        },
        category: { type: 'string', description: 'Filter top news stories to one category (e.g. "conflict", "economy"; fallback is "general").' },
        country: { type: 'string', description: 'Filter top stories and travel advisories to one ISO 3166-1 alpha-2 country code (case-insensitive).' },
        alerts_only: { type: 'boolean', description: 'Keep only top stories flagged as alerts.' },
        limit: { type: 'number', description: 'Cap each list (top stories, signals, advisories) to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      insights: {
        type: ['object', 'null'],
        properties: {
          topStories: { type: 'array', items: { type: 'object', properties: {
            title: { type: 'string' }, category: { type: 'string' }, countryCode: { type: 'string' },
            isAlert: { type: 'boolean' }, summary: { type: 'string' },
          } } },
        },
      },
      'gdelt-intel': {
        type: ['object', 'null'],
        properties: {
          topics: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, signals: { type: ['array', 'object'] } } } },
        },
      },
      'cross-source-signals': {
        type: ['object', 'null'],
        properties: { signals: { type: 'array', items: { type: 'object' } } },
      },
      'advisories-bootstrap': {
        type: ['object', 'null'],
        properties: {
          advisories: { type: 'array', items: { type: 'object', properties: { country: { type: 'string' }, level: { type: ['string', 'number'] } } } },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const topic = argStr(params.topic);
      const category = argStr(params.category);
      const countries = argStrList(params.country);
      const limit = (argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      if (topic) narrowNested(data, 'gdelt-intel', 'topics', (t) => argStr(t.id) === topic);
      if (category) narrowNested(data, 'insights', 'topStories', (s) => argStr(s.category) === category);
      if (countries.length > 0) {
        narrowNested(data, 'insights', 'topStories', (s) => matchesCode(s.countryCode, countries));
        narrowNested(data, 'advisories-bootstrap', 'advisories', (a) => matchesCode(a.country, countries));
      }
      if (argBool(params.alerts_only)) narrowNested(data, 'insights', 'topStories', (s) => s.isAlert === true);
      capNested(data, 'insights', 'topStories', limit);
      capNested(data, 'cross-source-signals', 'signals', limit);
      capNested(data, 'advisories-bootstrap', 'advisories', limit);
      return data;
    },
    _cacheKeys: [
      'news:insights:v1',
      'intelligence:gdelt-intel:v1',
      'intelligence:cross-source-signals:v1',
      'intelligence:advisories-bootstrap:v1',
    ],
    _seedMetaKey: 'seed-meta:news:insights',
    _maxStaleMin: 30,
    _apiPaths: [
      "GET /api/intelligence/v1/list-cross-source-signals",
      "GET /api/intelligence/v1/search-gdelt-documents",
    ],
  },
  {
    name: 'get_natural_disasters',
    _outputBudgetBytes: 131072,
    description: 'Recent earthquakes (USGS), active wildfires (NASA FIRMS), and natural hazard events. Includes magnitude, location, and threat severity.',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: {
          type: 'array',
          items: { type: 'string', enum: ['earthquakes', 'wildfires', 'other'] },
          description: 'Restrict to one or more hazard datasets (earthquakes / wildfires / other natural events). Omit for all.',
        },
        min_magnitude: { type: 'number', description: 'Drop earthquakes and natural events below this magnitude.' },
        active_only: { type: 'boolean', description: 'Keep only natural events that are still active (not closed).' },
        limit: { type: 'number', description: 'Cap each hazard list to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      earthquakes: {
        type: ['object', 'null'],
        properties: {
          earthquakes: { type: 'array', items: { type: 'object', properties: {
            magnitude: { type: 'number' }, place: { type: 'string' }, time: { type: ['number', 'string'] },
            latitude: { type: 'number' }, longitude: { type: 'number' }, depth: { type: 'number' },
          } } },
        },
      },
      fires: {
        type: ['object', 'null'],
        properties: {
          fireDetections: { type: 'array', items: { type: 'object', properties: {
            latitude: { type: 'number' }, longitude: { type: 'number' },
            brightness: { type: 'number' }, confidence: { type: ['number', 'string'] },
          } } },
        },
      },
      events: {
        type: ['object', 'null'],
        properties: {
          events: { type: 'array', items: { type: 'object', properties: {
            magnitude: { type: ['number', 'null'] }, closed: { type: 'boolean' },
            country: { type: 'string' }, type: { type: 'string' }, title: { type: 'string' },
          } } },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const minMag = argNum(params.min_magnitude);
      const limit = (argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      if (minMag != null) {
        narrowNested(data, 'earthquakes', 'earthquakes', (q) => (argNum(q.magnitude) ?? 0) >= minMag);
        narrowNested(data, 'events', 'events', (e) => (argNum(e.magnitude) ?? 0) >= minMag);
      }
      if (argBool(params.active_only)) narrowNested(data, 'events', 'events', (e) => e.closed === false);
      capNested(data, 'earthquakes', 'earthquakes', limit);
      capNested(data, 'fires', 'fireDetections', limit);
      capNested(data, 'events', 'events', limit);
      const ds = argStrList(params.dataset);
      if (ds.length > 0) {
        const map: Record<string, string> = { earthquakes: 'earthquakes', wildfires: 'fires', other: 'events' };
        return selectDatasets(data, compact(ds.map((d) => map[d])));
      }
      return data;
    },
    _cacheKeys: [
      'seismology:earthquakes:v1',
      'wildfire:fires:v1',
      'natural:events:v1',
    ],
    _seedMetaKey: 'seed-meta:seismology:earthquakes',
    _maxStaleMin: 30,
    _apiPaths: [
      "GET /api/natural/v1/list-natural-events",
      "GET /api/seismology/v1/list-earthquakes",
      "GET /api/wildfire/v1/list-fire-detections",
    ],
  },
  {
    name: 'get_military_posture',
    _outputBudgetBytes: 131072,
    description: 'Theater posture assessment and military risk scores. Reflects aggregated military positioning and escalation signals across global theaters.',
    inputSchema: {
      type: 'object',
      properties: {
        theater: { type: 'string', description: 'Filter to one theater by id (case-insensitive substring, e.g. "iran", "taiwan", "baltic", "korea").' },
        posture_level: { type: 'string', description: 'Filter to a single posture level.' },
        limit: { type: 'number', description: 'Cap the theaters list to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      theater_posture: {
        type: ['object', 'null'],
        properties: {
          theaters: { type: 'array', items: { type: 'object', properties: {
            theater: { type: 'string' }, postureLevel: { type: 'string' },
            summary: { type: 'string' }, signals: { type: ['array', 'object', 'null'] },
          } } },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const theater = argStr(params.theater);
      const level = argStr(params.posture_level);
      if (theater) narrowNested(data, 'theater_posture', 'theaters', (t) => ciIncludes(t.theater, theater));
      if (level) narrowNested(data, 'theater_posture', 'theaters', (t) => argStr(t.postureLevel) === level);
      capNested(data, 'theater_posture', 'theaters', argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      return data;
    },
    _cacheKeys: ['theater_posture:sebuf:stale:v1'],
    _seedMetaKey: 'seed-meta:intelligence:risk-scores',
    _maxStaleMin: 120,
    // CASCADE-MIRROR EQUIVALENCE: the API handler at
    // server/worldmonitor/military/v1/get-theater-posture.ts:23 reads 3 cascade
    // variants (live + stale + backup) and returns the freshest available.
    // This MCP tool reads only the stale variant; PR #3658's U7 already
    // documents `theater-posture:sebuf:v1` and `theater-posture:sebuf:backup:v1`
    // as `cascade-mirror: covered by get_military_posture` exclusions in the
    // bootstrap-parity test — they share the same payload shape, only freshness
    // differs. Coverage is intentional. The audit script's partial-overlap
    // warning for this op is suppressed via CASCADE_MIRROR_EXEMPT in
    // scripts/audit-mcp-api-coverage.mjs.
    _apiPaths: [
      "GET /api/military/v1/get-theater-posture",
    ],
  },
  {
    name: 'get_cyber_threats',
    _outputBudgetBytes: 131072,
    description: 'Active cyber threat intelligence: malware IOCs (URLhaus, Feodotracker), CISA known exploited vulnerabilities, and active command-and-control infrastructure.',
    inputSchema: {
      type: 'object',
      properties: {
        threat_type: { type: 'string', description: 'Filter to one threat type (case-insensitive substring, e.g. "malware", "vulnerability", "c2").' },
        min_severity: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'critical'],
          description: 'Drop threats below this severity level.',
        },
        country: { type: 'string', description: 'Filter to one ISO 3166-1 alpha-2 country code (many threats have no country and are dropped by this filter).' },
        limit: { type: 'number', description: 'Cap the threat list to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      'threats-bootstrap': {
        type: ['object', 'null'],
        properties: {
          threats: { type: 'array', items: { type: 'object', properties: {
            type: { type: 'string' }, severity: { type: 'string' }, country: { type: 'string' },
            indicator: { type: 'string' }, description: { type: 'string' },
          } } },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const type = argStr(params.threat_type);
      const countries = argStrList(params.country);
      const minSev = argStr(params.min_severity).replace('criticality_level_', '');
      const ranks: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };
      const minRank = ranks[minSev];
      if (type) narrowNested(data, 'threats-bootstrap', 'threats', (t) => ciIncludes(t.type, type));
      if (countries.length > 0) {
        narrowNested(data, 'threats-bootstrap', 'threats', (t) => matchesCode(t.country, countries));
      }
      if (minRank != null) {
        narrowNested(data, 'threats-bootstrap', 'threats', (t) => {
          const tok = argStr(t.severity).replace('criticality_level_', '');
          const r = ranks[tok];
          return r == null || r >= minRank;
        });
      }
      capNested(data, 'threats-bootstrap', 'threats', (argNum(params.limit) ?? DEFAULT_LIST_LIMIT));
      return data;
    },
    _cacheKeys: ['cyber:threats-bootstrap:v2'],
    _seedMetaKey: 'seed-meta:cyber:threats',
    _maxStaleMin: 240,
    _apiPaths: [],
  },
  {
    name: 'get_economic_data',
    _outputBudgetBytes: 131072,
    description: 'Macro economic indicators: Fed Funds rate (FRED), economic calendar events, fuel prices, ECB FX rates, EU yield curve, earnings calendar, COT positioning, energy storage data, BIS household debt service ratio (DSR, quarterly, leading indicator of household financial stress across ~40 advanced economies), and BIS residential + commercial property price indices (real, quarterly).',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['fedfunds', 'econ-calendar', 'fuel-prices', 'ecb-fx-rates', 'yield-curve-eu', 'spending', 'earnings-calendar', 'cot', 'dsr', 'property-residential', 'property-commercial'],
          },
          description: 'Restrict the response to one or more sub-datasets. Omit for the full economic bundle.',
        },
        country: {
          type: 'string',
          description: 'Filter the country-keyed datasets (fuel-prices, BIS DSR/property, economic calendar) to one ISO 3166-1 alpha-2 code.',
        },
        limit: { type: 'number', description: 'Cap each list dataset (calendar, spending, earnings) to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    // FRED key is `economic:fred:v1:FEDFUNDS:0` — the label-walk skips the
    // `0` suffix (NON_LABEL regex matches bare digits) and the `v1` segment,
    // landing on `FEDFUNDS`.
    outputSchema: cacheEnvelope({
      FEDFUNDS: { type: ['object', 'array', 'null'] },
      'econ-calendar': {
        type: ['object', 'null'],
        properties: { events: { type: 'array', items: { type: 'object', properties: {
          country: { type: 'string' }, event: { type: 'string' }, time: { type: ['string', 'number'] },
        } } } },
      },
      'fuel-prices': {
        type: ['object', 'null'],
        properties: { countries: { type: 'array', items: { type: 'object', properties: { code: { type: 'string' }, price: { type: 'number' }, currency: { type: 'string' } } } } },
      },
      'ecb-fx-rates': { type: ['object', 'null'] },
      'yield-curve-eu': { type: ['object', 'null'] },
      spending: {
        type: ['object', 'null'],
        properties: { awards: { type: 'array', items: { type: 'object' } } },
      },
      'earnings-calendar': {
        type: ['object', 'null'],
        properties: { earnings: { type: 'array', items: { type: 'object', properties: { symbol: { type: 'string' }, date: { type: 'string' } } } } },
      },
      cot: { type: ['object', 'null'] },
      dsr: {
        type: ['object', 'null'],
        properties: { entries: { type: 'array', items: { type: 'object', properties: { countryCode: { type: 'string' }, value: { type: 'number' } } } } },
      },
      'property-residential': {
        type: ['object', 'null'],
        properties: { entries: { type: 'array', items: { type: 'object', properties: { countryCode: { type: 'string' }, value: { type: 'number' } } } } },
      },
      'property-commercial': {
        type: ['object', 'null'],
        properties: { entries: { type: 'array', items: { type: 'object', properties: { countryCode: { type: 'string' }, value: { type: 'number' } } } } },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const countries = argStrList(params.country);
      const limit = (argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      if (countries.length > 0) {
        narrowNested(data, 'fuel-prices', 'countries', (c) => matchesCode(c.code, countries));
        narrowNested(data, 'econ-calendar', 'events', (e) => matchesCode(e.country, countries));
        for (const label of ['dsr', 'property-residential', 'property-commercial']) {
          narrowNested(data, label, 'entries', (e) => matchesCode(e.countryCode, countries));
        }
      }
      capNested(data, 'econ-calendar', 'events', limit);
      capNested(data, 'spending', 'awards', limit);
      capNested(data, 'earnings-calendar', 'earnings', limit);
      return selectDatasets(data, argStrList(params.dataset));
    },
    _cacheKeys: [
      'economic:fred:v1:FEDFUNDS:0',
      'economic:econ-calendar:v1',
      'economic:fuel-prices:v1',
      'economic:ecb-fx-rates:v1',
      'economic:yield-curve-eu:v1',
      'economic:spending:v1',
      'market:earnings-calendar:v1',
      'market:cot:v1',
      'economic:bis:dsr:v1',
      'economic:bis:property-residential:v1',
      'economic:bis:property-commercial:v1',
    ],
    _seedMetaKey: 'seed-meta:economic:econ-calendar',
    _maxStaleMin: 1440,
    _freshnessChecks: [
      { key: 'seed-meta:economic:econ-calendar', maxStaleMin: 1440 },
      // Per-dataset BIS seed-meta keys — the aggregate
      // `seed-meta:economic:bis-extended` would report "fresh" even if only
      // one of the three datasets (DSR / SPP / CPP) is current, matching the
      // false-freshness bug already fixed for /api/health and resilience.
      { key: 'seed-meta:economic:bis-dsr', maxStaleMin: 1440 }, // 12h cron × 2
      { key: 'seed-meta:economic:bis-property-residential', maxStaleMin: 1440 },
      { key: 'seed-meta:economic:bis-property-commercial', maxStaleMin: 1440 },
    ],
    _apiPaths: [
      "GET /api/economic/v1/get-ecb-fx-rates",
      "GET /api/economic/v1/get-economic-calendar",
      "GET /api/economic/v1/get-eu-yield-curve",
      "GET /api/economic/v1/list-fuel-prices",
      "GET /api/market/v1/get-cot-positioning",
      "GET /api/market/v1/list-earnings-calendar",
    ],
  },
  {
    name: 'get_country_macro',
    _outputBudgetBytes: 131072,
    description: 'Per-country macroeconomic indicators from IMF WEO (~210 countries, monthly cadence). Bundles fiscal/external balance (inflation, current account, gov revenue/expenditure/primary balance, CPI), growth & per-capita (real GDP growth, GDP/capita USD & PPP, savings & investment rates, savings-investment gap), labor & demographics (unemployment, population), and external trade (current account USD, import/export volume % changes). Latest available year per series. Use for country-level economic screening, peer benchmarking, and stagflation/imbalance flags. NOTE: export/import LEVELS in USD (exportsUsd, importsUsd, tradeBalanceUsd) are returned as null — WEO retracted broad coverage for BX/BM indicators in 2026-04; use currentAccountUsd or volume changes (import/exportVolumePctChg) instead.',
    inputSchema: {
      type: 'object',
      properties: {
        countries: {
          type: 'array',
          items: { type: 'string' },
          description: 'ISO 3166-1 alpha-2 country codes to keep across all four IMF datasets (e.g. ["US","DE","CN"]). Omit for all ~210 countries.',
        },
        limit: { type: 'integer', minimum: 0, description: 'Cap each IMF dataset country map to at most this many entries when no countries filter is supplied (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    // Each IMF label maps to `{ countries: { [iso2]: { ... per-series metrics ... } } }`.
    outputSchema: cacheEnvelope({
      macro: { type: ['object', 'null'], properties: { countries: { type: 'object', additionalProperties: { type: 'object' } } } },
      growth: { type: ['object', 'null'], properties: { countries: { type: 'object', additionalProperties: { type: 'object' } } } },
      labor: { type: ['object', 'null'], properties: { countries: { type: 'object', additionalProperties: { type: 'object' } } } },
      external: { type: ['object', 'null'], properties: { countries: { type: 'object', additionalProperties: { type: 'object' } } } },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const codes = argStrList(params.countries);
      if (codes.length > 0) {
        for (const label of ['macro', 'growth', 'labor', 'external']) pickNestedMap(data, label, 'countries', codes);
        return data;
      }
      const limit = argNum(params.limit) ?? DEFAULT_LIST_LIMIT;
      for (const label of ['macro', 'growth', 'labor', 'external']) capNestedMap(data, label, 'countries', limit);
      return data;
    },
    _cacheKeys: [
      'economic:imf:macro:v2',
      'economic:imf:growth:v1',
      'economic:imf:labor:v1',
      'economic:imf:external:v1',
    ],
    _seedMetaKey: 'seed-meta:economic:imf-macro',
    _maxStaleMin: 100800, // monthly WEO release; 70d = 2× interval (absorbs one missed run)
    _freshnessChecks: [
      { key: 'seed-meta:economic:imf-macro', maxStaleMin: 100800 },
      { key: 'seed-meta:economic:imf-growth', maxStaleMin: 100800 },
      { key: 'seed-meta:economic:imf-labor', maxStaleMin: 100800 },
      { key: 'seed-meta:economic:imf-external', maxStaleMin: 100800 },
    ],
    _apiPaths: [],
  },
  {
    name: 'get_eu_housing_cycle',
    _outputBudgetBytes: 131072,
    description: 'Eurostat annual house price index (prc_hpi_a, base 2015=100) for all 27 EU members plus EA20 and EU27_2020 aggregates. Each country entry includes the latest value, prior value, date, unit, and a 10-year sparkline series. Complements BIS WS_SPP with broader EU coverage for the Housing cycle tile.',
    inputSchema: {
      type: 'object',
      properties: {
        countries: {
          type: 'array',
          items: { type: 'string' },
          description: 'Eurostat geo codes to keep — ISO 3166-1 alpha-2, but "EL" for Greece, plus aggregates "EA20" and "EU27_2020". Omit for all.',
        },
        limit: { type: 'integer', minimum: 0, description: 'Cap the country map to at most this many entries when no countries filter is supplied (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      'house-prices': {
        type: ['object', 'null'],
        properties: { countries: { type: 'object', additionalProperties: { type: 'object', properties: {
          latest: { type: ['number', 'null'] }, prior: { type: ['number', 'null'] },
          date: { type: 'string' }, unit: { type: 'string' }, series: { type: 'array', items: { type: 'object' } },
        } } } },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const codes = argStrList(params.countries);
      if (codes.length > 0) {
        pickNestedMap(data, 'house-prices', 'countries', codes);
        return data;
      }
      capNestedMap(data, 'house-prices', 'countries', argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      return data;
    },
    _cacheKeys: ['economic:eurostat:house-prices:v1'],
    _seedMetaKey: 'seed-meta:economic:eurostat-house-prices',
    _maxStaleMin: 60 * 24 * 50, // weekly cron, annual data
    _apiPaths: [],
  },
  {
    name: 'get_eu_quarterly_gov_debt',
    _outputBudgetBytes: 131072,
    description: 'Eurostat quarterly general government gross debt (gov_10q_ggdebt, %GDP) for all 27 EU members plus EA20 and EU27_2020 aggregates. Each country entry includes latest value, prior value, quarter label, and an 8-quarter sparkline series. Provides fresher debt-trajectory signal than annual IMF GGXWDG_NGDP for EU panels.',
    inputSchema: {
      type: 'object',
      properties: {
        countries: {
          type: 'array',
          items: { type: 'string' },
          description: 'Eurostat geo codes to keep — ISO 3166-1 alpha-2, but "EL" for Greece, plus aggregates "EA20" and "EU27_2020". Omit for all.',
        },
        limit: { type: 'integer', minimum: 0, description: 'Cap the country map to at most this many entries when no countries filter is supplied (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      'gov-debt-q': {
        type: ['object', 'null'],
        properties: { countries: { type: 'object', additionalProperties: { type: 'object', properties: {
          latest: { type: ['number', 'null'] }, prior: { type: ['number', 'null'] },
          quarter: { type: 'string' }, series: { type: 'array', items: { type: 'object' } },
        } } } },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const codes = argStrList(params.countries);
      if (codes.length > 0) {
        pickNestedMap(data, 'gov-debt-q', 'countries', codes);
        return data;
      }
      capNestedMap(data, 'gov-debt-q', 'countries', argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      return data;
    },
    _cacheKeys: ['economic:eurostat:gov-debt-q:v1'],
    _seedMetaKey: 'seed-meta:economic:eurostat-gov-debt-q',
    _maxStaleMin: 60 * 24 * 14, // quarterly data, 2-day cron
    _apiPaths: [],
  },
  {
    name: 'get_eu_industrial_production',
    _outputBudgetBytes: 131072,
    description: 'Eurostat monthly industrial production index (sts_inpr_m, NACE B-D industry excl. construction, SCA, base 2021=100) for all 27 EU members plus EA20 and EU27_2020 aggregates. Each country entry includes latest value, prior value, month label, and a 12-month sparkline series. Leading indicator of real-economy activity used by the "Real economy pulse" sparkline.',
    inputSchema: {
      type: 'object',
      properties: {
        countries: {
          type: 'array',
          items: { type: 'string' },
          description: 'Eurostat geo codes to keep — ISO 3166-1 alpha-2, but "EL" for Greece, plus aggregates "EA20" and "EU27_2020". Omit for all.',
        },
        limit: { type: 'integer', minimum: 0, description: 'Cap the country map to at most this many entries when no countries filter is supplied (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      'industrial-production': {
        type: ['object', 'null'],
        properties: { countries: { type: 'object', additionalProperties: { type: 'object', properties: {
          latest: { type: ['number', 'null'] }, prior: { type: ['number', 'null'] },
          month: { type: 'string' }, series: { type: 'array', items: { type: 'object' } },
        } } } },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const codes = argStrList(params.countries);
      if (codes.length > 0) {
        pickNestedMap(data, 'industrial-production', 'countries', codes);
        return data;
      }
      capNestedMap(data, 'industrial-production', 'countries', argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      return data;
    },
    _cacheKeys: ['economic:eurostat:industrial-production:v1'],
    _seedMetaKey: 'seed-meta:economic:eurostat-industrial-production',
    _maxStaleMin: 60 * 24 * 5, // monthly data, daily cron
    _apiPaths: [],
  },
  {
    name: 'get_prediction_markets',
    _outputBudgetBytes: 131072,
    description: 'Active Polymarket event contracts with current probabilities. Covers geopolitical, economic, and election prediction markets.',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['geopolitical', 'tech', 'finance'],
          description: 'Restrict to one market category bucket. Omit for all three.',
        },
        query: { type: 'string', description: 'Keep only markets whose title contains this text (case-insensitive).' },
        source: { type: 'string', enum: ['kalshi', 'polymarket'], description: 'Filter to one prediction-market source.' },
        limit: { type: 'number', description: 'Cap each category bucket to at most this many markets (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      'markets-bootstrap': {
        type: ['object', 'null'],
        properties: {
          geopolitical: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, source: { type: 'string' }, probability: { type: 'number' } } } },
          tech:         { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, source: { type: 'string' }, probability: { type: 'number' } } } },
          finance:      { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, source: { type: 'string' }, probability: { type: 'number' } } } },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const category = argStr(params.category);
      const query = argStr(params.query);
      const source = argStr(params.source);
      const limit = (argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      const buckets = ['geopolitical', 'tech', 'finance'];
      for (const b of buckets) {
        if (query) narrowNested(data, 'markets-bootstrap', b, (m) => ciIncludes(m.title, query));
        if (source) narrowNested(data, 'markets-bootstrap', b, (m) => argStr(m.source) === source);
        capNested(data, 'markets-bootstrap', b, limit);
      }
      if (category && buckets.includes(category)) {
        const node = data['markets-bootstrap'];
        if (node && typeof node === 'object' && !Array.isArray(node)) {
          const n = node as Record<string, unknown>;
          for (const b of buckets) if (b !== category) n[b] = [];
        }
      }
      return data;
    },
    _cacheKeys: ['prediction:markets-bootstrap:v1'],
    _seedMetaKey: 'seed-meta:prediction:markets',
    _maxStaleMin: 90,
    _apiPaths: [
      "GET /api/prediction/v1/list-prediction-markets",
    ],
  },
  {
    name: 'get_sanctions_data',
    _outputBudgetBytes: 131072,
    description: 'OFAC SDN sanctioned entities list and sanctions pressure scores by country. Useful for compliance screening and geopolitical pressure analysis.',
    inputSchema: {
      type: 'object',
      properties: {
        country: { type: 'string', description: 'Filter sanctioned entities and pressure scores to one ISO 3166-1 alpha-2 country code.' },
        entity_type: { type: 'string', description: 'Filter to one entity type (case-insensitive substring, e.g. "vessel", "aircraft", "person", "entity").' },
        query: { type: 'string', description: 'Keep only sanctioned entities whose name contains this text (case-insensitive).' },
        limit: { type: 'number', description: 'Cap the entity list and recent pressure entries to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    // `_postFilter` calls `narrowArray(data, 'entities', ...)` on the
    // entities slot, so that label's value is itself an array (not an object
    // with a child array). The pressure label is the usual `{entries, countries}` shape.
    outputSchema: cacheEnvelope({
      entities: {
        type: ['array', 'object', 'null'],
        items: { type: 'object', properties: {
          name: { type: 'string' }, cc: { type: 'string' }, et: { type: 'string' },
          addr: { type: 'string' },
        } },
      },
      pressure: {
        type: ['object', 'null'],
        properties: {
          entries: { type: 'array', items: { type: 'object', properties: {
            countryCodes: { type: ['array', 'string'] }, entityType: { type: 'string' },
          } } },
          countries: { type: 'array', items: { type: 'object', properties: {
            countryCode: { type: 'string' }, pressureScore: { type: 'number' },
          } } },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const countries = argStrList(params.country);
      const etype = argStr(params.entity_type);
      const query = argStr(params.query);
      const limit = (argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      if (countries.length > 0) {
        narrowArray(data, 'entities', (e) => matchesCode(e.cc, countries));
        narrowNested(data, 'pressure', 'entries', (e) => matchesCode(e.countryCodes, countries));
        narrowNested(data, 'pressure', 'countries', (c) => matchesCode(c.countryCode, countries));
      }
      if (etype) {
        narrowArray(data, 'entities', (e) => ciIncludes(e.et, etype));
        narrowNested(data, 'pressure', 'entries', (e) => ciIncludes(e.entityType, etype));
      }
      if (query) narrowArray(data, 'entities', (e) => ciIncludes(e.name, query));
      capArrays(data, limit);
      capNested(data, 'pressure', 'entries', limit);
      return data;
    },
    _cacheKeys: ['sanctions:entities:v1', 'sanctions:pressure:v1'],
    _seedMetaKey: 'seed-meta:sanctions:entities',
    _maxStaleMin: 1440,
    _apiPaths: [
      "GET /api/sanctions/v1/list-sanctions-pressure",
      "GET /api/sanctions/v1/lookup-sanction-entity",
    ],
  },
  {
    name: 'get_displacement_data',
    _outputBudgetBytes: 131072,
    description: 'Refugee and IDP counts by country (UNHCR annual data).',
    inputSchema: {
      type: 'object',
      properties: {
        countries: {
          type: 'array',
          items: { type: 'string' },
          description: 'ISO 3166-1 alpha-3 country codes to keep (e.g. ["SYR","UKR","AFG"]). Matches both per-country totals and origin/asylum flows. Omit for all.',
        },
        limit: { type: 'number', description: 'Cap the per-country and top-flow lists to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      summary: {
        type: ['object', 'null'],
        properties: {
          countries: { type: 'array', items: { type: 'object', properties: {
            code: { type: 'string' }, total: { type: ['number', 'null'] }, year: { type: ['number', 'string'] },
          } } },
          topFlows: { type: 'array', items: { type: 'object', properties: {
            originCode: { type: 'string' }, asylumCode: { type: 'string' }, value: { type: ['number', 'null'] },
          } } },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const codes = argStrList(params.countries);
      const limit = (argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      if (codes.length > 0) {
        narrowNested(data, 'summary', 'countries', (c) => matchesCode(c.code, codes));
        narrowNested(data, 'summary', 'topFlows', (f) => matchesCode(f.originCode, codes) || matchesCode(f.asylumCode, codes));
      }
      capNested(data, 'summary', 'countries', limit);
      capNested(data, 'summary', 'topFlows', limit);
      return data;
    },
    // Dynamic-year key resolved once at module evaluation — mirrors the
    // STANDALONE_KEYS pattern in api/health.js:147. The UNHCR seeder publishes
    // a single current-year key; the prior year exists at the same prefix but
    // is intentionally excluded — the executeTool label-walk would strip the
    // year segment from both keys and collide on the same `summary` label,
    // causing the second result to overwrite the first.
    _cacheKeys: [`displacement:summary:v1:${new Date().getUTCFullYear()}`],
    _seedMetaKey: 'seed-meta:displacement:summary',
    _maxStaleMin: 3600,
    // Audit miss: handler uses cachedFetchJson with a year-suffixed key the
    // audit's regex couldn't statically resolve. The op IS covered by this
    // tool — same underlying displacement:summary:v1:<year> cache.
    _apiPaths: [
      'GET /api/displacement/v1/get-displacement-summary',
    ],
  },
  {
    name: 'get_health_signals',
    _outputBudgetBytes: 131072,
    description: 'Active disease outbreaks (WHO/ECDC etc.) and global air-quality station readings (OpenAQ/WAQI PM2.5). For health-risk screening.',
    inputSchema: {
      type: 'object',
      properties: {
        signal_type: {
          type: 'array',
          items: { type: 'string', enum: ['outbreaks', 'air-quality'] },
          description: 'Restrict to disease outbreaks, air-quality stations, or both. Omit for both.',
        },
        country: { type: 'string', description: 'Filter outbreaks and air-quality stations to one ISO 3166-1 alpha-2 country code.' },
        disease: { type: 'string', description: 'Keep only outbreaks whose disease name contains this text (case-insensitive).' },
        min_aqi: { type: 'number', description: 'Drop air-quality stations below this AQI value.' },
        limit: { type: 'number', description: 'Cap the outbreak and station lists to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      'disease-outbreaks': {
        type: ['object', 'null'],
        properties: {
          outbreaks: { type: 'array', items: { type: 'object', properties: {
            disease: { type: 'string' }, country: { type: 'string' }, countryCode: { type: 'string' },
            cases: { type: ['number', 'null'] }, deaths: { type: ['number', 'null'] }, date: { type: 'string' },
          } } },
        },
      },
      'air-quality': {
        type: ['object', 'null'],
        properties: {
          stations: { type: 'array', items: { type: 'object', properties: {
            country_code: { type: 'string' }, city: { type: 'string' }, aqi: { type: ['number', 'null'] },
            pm25: { type: ['number', 'null'] }, latitude: { type: 'number' }, longitude: { type: 'number' },
          } } },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const countries = argStrList(params.country);
      const disease = argStr(params.disease);
      const minAqi = argNum(params.min_aqi);
      const limit = (argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      if (countries.length > 0) {
        narrowNested(data, 'disease-outbreaks', 'outbreaks', (o) => matchesCode(o.countryCode, countries));
        narrowNested(data, 'air-quality', 'stations', (s) => matchesCode(s.country_code, countries));
      }
      if (disease) narrowNested(data, 'disease-outbreaks', 'outbreaks', (o) => ciIncludes(o.disease, disease));
      if (minAqi != null) narrowNested(data, 'air-quality', 'stations', (s) => (argNum(s.aqi) ?? 0) >= minAqi);
      capNested(data, 'disease-outbreaks', 'outbreaks', limit);
      capNested(data, 'air-quality', 'stations', limit);
      const st = argStrList(params.signal_type);
      if (st.length > 0) {
        const map: Record<string, string> = { outbreaks: 'disease-outbreaks', 'air-quality': 'air-quality' };
        return selectDatasets(data, compact(st.map((s) => map[s])));
      }
      return data;
    },
    // Uses the health-domain canonical key health:air-quality:v1 (NOT the
    // climate-domain mirror climate:air-quality:v1, which stays exclusively
    // in get_climate_data). Both are written by the same seeder
    // (scripts/seed-health-air-quality.mjs exports HEALTH_AIR_QUALITY_KEY +
    // CLIMATE_AIR_QUALITY_KEY) so no duplicate seed work.
    _cacheKeys: ['health:disease-outbreaks:v1', 'health:air-quality:v1'],
    _seedMetaKey: 'seed-meta:health:disease-outbreaks',
    _maxStaleMin: 2880,
    _freshnessChecks: [
      { key: 'seed-meta:health:disease-outbreaks', maxStaleMin: 2880 }, // daily cron; 48h budget
      { key: 'seed-meta:health:air-quality', maxStaleMin: 180 },        // hourly cron; 3h budget
    ],
    _apiPaths: [
      "GET /api/health/v1/list-air-quality-alerts",
      "GET /api/health/v1/list-disease-outbreaks",
    ],
  },
  {
    name: 'get_energy_intelligence',
    _outputBudgetBytes: 131072,
    description: 'Energy supply, prices, storage, disruptions, and policy: EIA petroleum stocks, electricity prices (Ember), gas storage (GIE), fuel shortages, fossil & renewable shares, active energy disruptions, government crisis policies.',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['eia-petroleum', 'electricity', 'ember', 'gas-storage', 'fuel-shortages', 'disruptions', 'crisis-policies', 'fossil-share', 'renewable'],
          },
          description: 'Restrict the response to one or more energy sub-datasets. Omit for the full bundle.',
        },
        country: {
          type: 'string',
          description: 'Filter the country-keyed datasets (Ember electricity mix, gas storage, fuel shortages, energy disruptions, fossil-share) to one ISO 3166-1 alpha-2 code.',
        },
        limit: { type: 'number', description: 'Cap each list-bearing energy slice (crisis-policies, electricity regions, gas-storage countries, World Bank renewable history/regions) to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    // Labels derived from each cache key's last informative segment:
    //   energy:eia-petroleum:v1                  -> eia-petroleum
    //   energy:electricity:v1:index              -> index
    //   energy:ember:v1:_all                     -> _all
    //   energy:gas-storage:v1:_countries         -> _countries
    //   energy:fuel-shortages:v1                 -> fuel-shortages
    //   energy:disruptions:v1                    -> disruptions
    //   energy:crisis-policies:v1                -> crisis-policies
    //   resilience:fossil-electricity-share:v1   -> fossil-electricity-share
    //   economic:worldbank-renewable:v1          -> worldbank-renewable
    outputSchema: cacheEnvelope({
      'eia-petroleum': { type: ['object', 'null'] },
      index: { type: ['object', 'null'], properties: { regions: { type: 'array', items: { type: 'object' } } } },
      _all: { type: ['object', 'null'] },
      _countries: { type: ['array', 'object', 'null'] },
      'fuel-shortages': { type: ['object', 'null'], properties: { shortages: { type: ['object', 'array', 'null'] } } },
      disruptions: { type: ['object', 'null'], properties: { events: { type: ['object', 'array', 'null'] } } },
      'crisis-policies': { type: ['object', 'null'], properties: { policies: { type: 'array', items: { type: 'object' } } } },
      'fossil-electricity-share': { type: ['object', 'null'], properties: { countries: { type: 'object', additionalProperties: { type: 'object' } } } },
      'worldbank-renewable': { type: ['object', 'null'], properties: {
        historicalData: { type: 'array', items: { type: 'object' } },
        regions: { type: 'array', items: { type: 'object' } },
      } },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const countries = argStrList(params.country);
      if (countries.length > 0) {
        data._all = pickMapKeys(data._all, countries);
        pickNestedMap(data, 'fossil-electricity-share', 'countries', countries);
        // energy:gas-storage:v1:_countries is a string[] of ISO2 codes — match
        // the entry directly; the `?.iso2` fallback tolerates an object shape.
        narrowArray(data, '_countries', (c) => matchesCode(c, countries) || matchesCode(c?.iso2, countries));
        mapNested(data, 'fuel-shortages', 'shortages', (m) => filterMapValues(m, (s) => matchesCode(s.country, countries)));
        mapNested(data, 'disruptions', 'events', (m) => filterMapValues(m, (e) => matchesCode(e.countries, countries)));
      }
      const limit = argNum(params.limit) ?? DEFAULT_LIST_LIMIT;
      capNested(data, 'crisis-policies', 'policies', limit);
      capNested(data, 'index', 'regions', limit);
      capNested(data, 'worldbank-renewable', 'historicalData', limit);
      capNested(data, 'worldbank-renewable', 'regions', limit);
      // _countries is a top-level string[] — capArrays handles top-level arrays;
      // in the energy bundle it's the only such array, so no collateral damage.
      capArrays(data, limit);
      const ds = argStrList(params.dataset);
      if (ds.length > 0) {
        const map: Record<string, string> = {
          'eia-petroleum': 'eia-petroleum', electricity: 'index', ember: '_all', 'gas-storage': '_countries',
          'fuel-shortages': 'fuel-shortages', disruptions: 'disruptions', 'crisis-policies': 'crisis-policies',
          'fossil-share': 'fossil-electricity-share', renewable: 'worldbank-renewable',
        };
        return selectDatasets(data, compact(ds.map((d) => map[d])));
      }
      return data;
    },
    // Broad 9-key energy bundle mirroring get_economic_data. Cadences span
    // hourly (electricity prices) to annual (World Bank renewable share); use
    // _freshnessChecks with per-key maxStaleMin pulled from
    // api/health.js::SEED_META so a slow-cadence key doesn't drag the
    // aggregate stale flag unnecessarily.
    _cacheKeys: [
      'energy:eia-petroleum:v1',                  // STANDALONE_KEYS::eiaPetroleum
      'energy:electricity:v1:index',              // BOOTSTRAP_KEYS::electricityPrices
      'energy:ember:v1:_all',                     // STANDALONE_KEYS::emberElectricity
      'energy:gas-storage:v1:_countries',         // BOOTSTRAP_KEYS::gasStorageCountries
      'energy:fuel-shortages:v1',                 // STANDALONE_KEYS::fuelShortages
      'energy:disruptions:v1',                    // STANDALONE_KEYS::energyDisruptions
      'energy:crisis-policies:v1',                // STANDALONE_KEYS::energyCrisisPolicies
      'resilience:fossil-electricity-share:v1',   // STANDALONE_KEYS::fossilElectricityShare
      'economic:worldbank-renewable:v1',          // BOOTSTRAP_KEYS::renewableEnergy
    ],
    _seedMetaKey: 'seed-meta:energy:eia-petroleum',
    _maxStaleMin: 4320, // EIA petroleum daily-bundle baseline; per-key budgets via _freshnessChecks below
    _freshnessChecks: [
      { key: 'seed-meta:energy:eia-petroleum',                  maxStaleMin: 4320 },   // daily bundle; 72h = 3× interval
      { key: 'seed-meta:energy:electricity-prices',             maxStaleMin: 2880 },   // daily cron (14:00 UTC); 48h = 2× interval
      { key: 'seed-meta:energy:ember',                          maxStaleMin: 2880 },   // daily cron (08:00 UTC); 48h = 2× interval
      { key: 'seed-meta:energy:gas-storage-countries',          maxStaleMin: 2880 },   // daily cron at 10:30 UTC; 48h = 2× interval
      { key: 'seed-meta:energy:fuel-shortages',                 maxStaleMin: 2880 },   // 2d — daily cron × 2 headroom
      { key: 'seed-meta:energy:disruptions',                    maxStaleMin: 20160 },  // 14d — weekly cron × 2 headroom
      { key: 'seed-meta:energy:crisis-policies',                maxStaleMin: 60 * 24 * 400 }, // ~400d static registry
      { key: 'seed-meta:resilience:fossil-electricity-share',   maxStaleMin: 11520 },  // ~8d (annual WB-style cadence)
      { key: 'seed-meta:economic:worldbank-renewable:v1',       maxStaleMin: 10080 },  // 7d WB weekly-cron annual data
    ],
    _apiPaths: [
      "GET /api/economic/v1/get-energy-crisis-policies",
      "GET /api/supply-chain/v1/get-fuel-shortage-detail",
      "GET /api/supply-chain/v1/list-energy-disruptions",
      "GET /api/supply-chain/v1/list-fuel-shortages",
    ],
  },
  {
    name: 'get_climate_data',
    _outputBudgetBytes: 131072,
    description: 'Climate intelligence: temperature/precipitation anomalies (vs 30-year WMO normals), climate-relevant disaster alerts (ReliefWeb/GDACS/FIRMS), atmospheric CO2 trend (NOAA Mauna Loa), air quality (OpenAQ/WAQI PM2.5 stations), Arctic sea ice extent and ocean heat indicators (NSIDC/NOAA), weather alerts, and climate news.',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['anomalies', 'disasters', 'co2-monitoring', 'air-quality', 'ocean-ice', 'news-intelligence', 'alerts'],
          },
          description: 'Restrict the response to one or more climate sub-datasets. Omit for the full bundle.',
        },
        country: {
          type: 'string',
          description: 'Filter the country-tagged datasets (climate disasters, air-quality stations) to one ISO 3166-1 alpha-2 code.',
        },
        limit: { type: 'number', description: 'Cap each list dataset (anomalies, disasters, stations, news, alerts) to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      anomalies: { type: ['object', 'null'], properties: { anomalies: { type: 'array', items: { type: 'object' } } } },
      disasters: { type: ['object', 'null'], properties: { disasters: { type: 'array', items: { type: 'object', properties: {
        countryCode: { type: 'string' }, type: { type: 'string' }, severity: { type: 'string' },
      } } } } },
      'co2-monitoring': { type: ['object', 'null'] },
      'air-quality': { type: ['object', 'null'], properties: { stations: { type: 'array', items: { type: 'object', properties: {
        country_code: { type: 'string' }, city: { type: 'string' }, aqi: { type: ['number', 'null'] },
      } } } } },
      'ocean-ice': { type: ['object', 'null'] },
      'news-intelligence': { type: ['object', 'null'], properties: { items: { type: 'array', items: { type: 'object' } } } },
      alerts: { type: ['object', 'null'], properties: { alerts: { type: 'array', items: { type: 'object' } } } },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const countries = argStrList(params.country);
      const limit = (argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      if (countries.length > 0) {
        narrowNested(data, 'disasters', 'disasters', (d) => matchesCode(d.countryCode, countries));
        narrowNested(data, 'air-quality', 'stations', (s) => matchesCode(s.country_code, countries));
      }
      capNested(data, 'anomalies', 'anomalies', limit);
      capNested(data, 'disasters', 'disasters', limit);
      capNested(data, 'air-quality', 'stations', limit);
      capNested(data, 'news-intelligence', 'items', limit);
      capNested(data, 'alerts', 'alerts', limit);
      return selectDatasets(data, argStrList(params.dataset));
    },
    _cacheKeys: ['climate:anomalies:v2', 'climate:disasters:v1', 'climate:co2-monitoring:v1', 'climate:air-quality:v1', 'climate:ocean-ice:v1', 'climate:news-intelligence:v1', 'weather:alerts:v1'],
    _seedMetaKey: 'seed-meta:climate:co2-monitoring',
    _maxStaleMin: 2880,
    _freshnessChecks: [
      { key: 'seed-meta:climate:anomalies', maxStaleMin: 120 },
      { key: 'seed-meta:climate:disasters', maxStaleMin: 720 },
      { key: 'seed-meta:climate:co2-monitoring', maxStaleMin: 2880 },
      { key: 'seed-meta:health:air-quality', maxStaleMin: 180 },
      { key: 'seed-meta:climate:ocean-ice', maxStaleMin: 1440 },
      { key: 'seed-meta:climate:news-intelligence', maxStaleMin: 90 },
      { key: 'seed-meta:weather:alerts', maxStaleMin: 45 },
    ],
    _apiPaths: [
      "GET /api/climate/v1/get-co2-monitoring",
      "GET /api/climate/v1/get-ocean-ice-data",
      "GET /api/climate/v1/list-air-quality-data",
      "GET /api/climate/v1/list-climate-anomalies",
      "GET /api/climate/v1/list-climate-disasters",
      "GET /api/climate/v1/list-climate-news",
    ],
  },
  {
    name: 'get_infrastructure_status',
    _outputBudgetBytes: 131072,
    description: 'Internet infrastructure health: Cloudflare Radar outages and service status for major cloud providers and internet services.',
    inputSchema: {
      type: 'object',
      properties: {
        country: { type: 'string', description: 'Filter to one country by name (case-insensitive substring).' },
        severity: { type: 'string', description: 'Filter to one outage severity (case-insensitive substring).' },
        limit: { type: 'number', description: 'Cap the outage list to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      outages: {
        type: ['object', 'null'],
        properties: { outages: { type: 'array', items: { type: 'object', properties: {
          country: { type: 'string' }, severity: { type: 'string' }, asn: { type: ['number', 'string'] },
          startTime: { type: 'string' }, description: { type: 'string' },
        } } } },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const country = argStr(params.country);
      const severity = argStr(params.severity);
      if (country) narrowNested(data, 'outages', 'outages', (o) => ciIncludes(o.country, country));
      if (severity) narrowNested(data, 'outages', 'outages', (o) => ciIncludes(o.severity, severity));
      capNested(data, 'outages', 'outages', (argNum(params.limit) ?? DEFAULT_LIST_LIMIT));
      return data;
    },
    _cacheKeys: ['infra:outages:v1'],
    _seedMetaKey: 'seed-meta:infra:outages',
    _maxStaleMin: 30,
    _apiPaths: [
      "GET /api/infrastructure/v1/list-internet-outages",
    ],
  },
  {
    name: 'get_supply_chain_data',
    _outputBudgetBytes: 131072,
    description: 'Dry bulk shipping stress index, customs revenue flows, and COMTRADE bilateral trade data. Tracks global supply chain pressure and trade disruptions.',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: {
          type: 'array',
          items: { type: 'string', enum: ['shipping_stress', 'customs-revenue', 'flows'] },
          description: 'Restrict the response to one or more sub-datasets (dry-bulk shipping stress / customs revenue / COMTRADE flows). Omit for all.',
        },
        commodity: {
          type: 'string',
          description: 'Filter COMTRADE flows to one commodity — matches the HS code exactly or the commodity description by substring (e.g. "2709" or "crude").',
        },
        limit: { type: 'number', description: 'Cap each list dataset (carriers, months, flows) to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      shipping_stress: {
        type: ['object', 'null'],
        properties: { carriers: { type: 'array', items: { type: 'object', properties: {
          name: { type: 'string' }, stressScore: { type: ['number', 'null'] },
        } } } },
      },
      'customs-revenue': {
        type: ['object', 'null'],
        properties: { months: { type: 'array', items: { type: 'object', properties: {
          month: { type: 'string' }, revenueUsd: { type: ['number', 'null'] },
        } } } },
      },
      flows: {
        type: ['object', 'null'],
        properties: { flows: { type: 'array', items: { type: 'object', properties: {
          cmdCode: { type: 'string' }, cmdDesc: { type: 'string' }, reporter: { type: 'string' },
          partner: { type: 'string' }, value: { type: ['number', 'null'] },
        } } } },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const commodity = argStr(params.commodity);
      const limit = (argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      if (commodity) {
        narrowNested(data, 'flows', 'flows', (f) => argStr(f.cmdCode) === commodity || ciIncludes(f.cmdDesc, commodity));
      }
      capNested(data, 'shipping_stress', 'carriers', limit);
      capNested(data, 'customs-revenue', 'months', limit);
      capNested(data, 'flows', 'flows', limit);
      return selectDatasets(data, argStrList(params.dataset));
    },
    _cacheKeys: [
      'supply_chain:shipping_stress:v1',
      'trade:customs-revenue:v1',
      'comtrade:flows:v1',
    ],
    _seedMetaKey: 'seed-meta:trade:customs-revenue',
    _maxStaleMin: 2880,
    _apiPaths: [
      "GET /api/supply-chain/v1/get-shipping-stress",
      "GET /api/trade/v1/get-customs-revenue",
    ],
  },
  {
    name: 'get_tariff_trends',
    _outputBudgetBytes: 131072,
    description: 'Global trade and pricing indicators: US tariff trends (HTS-coded), BigMac index, FAO Food Price Index, and per-country national debt levels.',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: {
          type: 'array',
          items: { type: 'string', enum: ['tariffs', 'bigmac', 'fao-ffpi', 'national-debt'] },
          description: 'Restrict the response to one or more sub-datasets. Omit for the full bundle.',
        },
        country: {
          type: 'string',
          description: 'Filter the per-country datasets to one ISO 3166-1 alpha-2 country code (e.g. "US"). It is translated to alpha-3 internally for the national-debt dataset; passing an alpha-3 code directly also works.',
        },
        limit: { type: 'number', description: 'Cap each list dataset (tariff datapoints, BigMac countries, debt entries) to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    // First cache key `trade:tariffs:v1:840:all:10` — NON_LABEL drops bare digits
    // (840, 10) and `v1`, lands on `all`.
    outputSchema: cacheEnvelope({
      all: {
        type: ['object', 'null'],
        properties: { datapoints: { type: 'array', items: { type: 'object', properties: {
          hsCode: { type: 'string' }, rate: { type: ['number', 'null'] }, country: { type: 'string' },
        } } } },
      },
      bigmac: {
        type: ['object', 'null'],
        properties: { countries: { type: 'array', items: { type: 'object', properties: {
          code: { type: 'string' }, priceLocal: { type: ['number', 'null'] }, priceUsd: { type: ['number', 'null'] },
        } } } },
      },
      'fao-ffpi': { type: ['object', 'null'] },
      'national-debt': {
        type: ['object', 'null'],
        properties: { entries: { type: 'array', items: { type: 'object', properties: {
          iso3: { type: 'string' }, value: { type: ['number', 'null'] }, year: { type: ['number', 'string'] },
        } } } },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const countries = argStrList(params.country);
      const limit = (argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      if (countries.length > 0) {
        narrowNested(data, 'bigmac', 'countries', (c) => matchesCode(c.code, countries));
        // national-debt entries are keyed by ISO alpha-3 (iso3:"USA"); the
        // country param is alpha-2 like the rest of the tool, so expand it.
        const debtCodes = [
          ...countries,
          ...compact(countries.map((c) => ISO2_TO_ISO3[c.toUpperCase()]?.toLowerCase())),
        ];
        narrowNested(data, 'national-debt', 'entries', (e) => matchesCode(e.iso3, debtCodes));
      }
      capNested(data, 'all', 'datapoints', limit);
      capNested(data, 'bigmac', 'countries', limit);
      capNested(data, 'national-debt', 'entries', limit);
      const ds = argStrList(params.dataset);
      if (ds.length > 0) {
        const map: Record<string, string> = { tariffs: 'all', bigmac: 'bigmac', 'fao-ffpi': 'fao-ffpi', 'national-debt': 'national-debt' };
        return selectDatasets(data, compact(ds.map((d) => map[d])));
      }
      return data;
    },
    // 4-key bundle spanning trade + economic domains. Cadences span hourly-ish
    // (tariffs co-pinned to 8h TARIFF_TTL) to monthly (FAO / national debt).
    // Per-key _freshnessChecks pulled from api/health.js::SEED_META so a slow
    // monthly key doesn't drag the aggregate stale flag and a fast tariff
    // outage isn't masked by a long FAO budget.
    _cacheKeys: [
      'trade:tariffs:v1:840:all:10',   // STANDALONE_KEYS::tariffTrendsUs
      'economic:bigmac:v1',            // BOOTSTRAP_KEYS::bigmac
      'economic:fao-ffpi:v1',          // BOOTSTRAP_KEYS::faoFoodPriceIndex
      'economic:national-debt:v1',     // BOOTSTRAP_KEYS::nationalDebt
    ],
    _seedMetaKey: 'seed-meta:trade:tariffs:v1:840:all:10',
    _maxStaleMin: 540, // tariff cron baseline; per-key budgets via _freshnessChecks below
    _freshnessChecks: [
      { key: 'seed-meta:trade:tariffs:v1:840:all:10', maxStaleMin: 540 },   // TARIFF_TTL 8h + 60min grace
      { key: 'seed-meta:economic:bigmac',             maxStaleMin: 10080 }, // weekly seed; 7d
      { key: 'seed-meta:economic:fao-ffpi',           maxStaleMin: 86400 }, // monthly seed; 60d (2× interval)
      { key: 'seed-meta:economic:national-debt',      maxStaleMin: 86400 }, // monthly seed; 60d (2× interval)
    ],
    _apiPaths: [
      "GET /api/economic/v1/get-fao-food-price-index",
      "GET /api/economic/v1/get-national-debt",
      "GET /api/economic/v1/list-bigmac-prices",
    ],
  },
  {
    name: 'get_chokepoint_status',
    _outputBudgetBytes: 131072,
    description: 'Live maritime chokepoint status: per-chokepoint vessel transit counts (10-min cadence), rolling transit summaries, per-port activity, plus static reference data (chokepoint geometry, canonical 13-chokepoint registry) and flow aggregates. Covers Suez, Hormuz, Malacca, Bab-el-Mandeb, Panama, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        chokepoint: {
          type: 'string',
          description: 'Filter to one chokepoint — matches by case-insensitive substring across the differing identifiers used by each dataset (e.g. "hormuz" matches "hormuz_strait", "Strait of Hormuz").',
        },
        dataset: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['transit-summaries', 'chokepoint_transits', '_countries', 'chokepoint-baselines', 'ref', 'chokepoint-flows'],
          },
          description: 'Restrict the response to one or more sub-datasets. Omit for the full bundle.',
        },
        limit: { type: 'number', description: 'Cap the chokepoint-baselines list and the _countries ISO2 index to at most this many items (default 30, pass 0 for no cap). Keyed-object maps (transit-summaries, chokepoint_transits, ref, chokepoint-flows) are intentionally not capped — use the `chokepoint` filter instead.' },
      },
      required: [],
    },
    // Schema validated against tests/fixtures/jmespath-samples/thin-get-chokepoint-status.response.json.
    outputSchema: cacheEnvelope({
      'transit-summaries': {
        type: ['object', 'null'],
        properties: {
          summaries: { type: 'object', additionalProperties: { type: 'object', properties: {
            todayTotal: { type: ['number', 'null'] }, todayTanker: { type: ['number', 'null'] },
            todayCargo: { type: ['number', 'null'] }, todayOther: { type: ['number', 'null'] },
            wowChangePct: { type: ['number', 'null'] }, riskLevel: { type: 'string' },
            incidentCount7d: { type: ['number', 'null'] }, disruptionPct: { type: ['number', 'null'] },
            riskSummary: { type: 'string' }, riskReportAction: { type: 'string' },
            anomaly: { type: 'object' }, dataAvailable: { type: 'boolean' },
          } } },
          fetchedAt: { type: ['number', 'string'] },
        },
      },
      chokepoint_transits: {
        type: ['object', 'null'],
        properties: {
          transits: { type: 'object', additionalProperties: { type: 'object' } },
          fetchedAt: { type: ['number', 'string'] },
        },
      },
      _countries: {
        type: ['array', 'object', 'null'],
        items: { type: 'string' },
      },
      'chokepoint-baselines': {
        type: ['object', 'null'],
        properties: {
          source: { type: 'string' }, referenceYear: { type: ['number', 'string'] },
          updatedAt: { type: 'string' },
          chokepoints: { type: 'array', items: { type: 'object', properties: {
            id: { type: 'string' }, relayId: { type: 'string' }, name: { type: 'string' },
          } } },
        },
      },
      ref: {
        type: ['object', 'null'],
        additionalProperties: { type: 'object' },
      },
      'chokepoint-flows': {
        type: ['object', 'null'],
        additionalProperties: { type: 'object' },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const cp = argStr(params.chokepoint);
      if (cp) {
        mapNested(data, 'transit-summaries', 'summaries', (m) => pickMapKeysLike(m, cp));
        mapNested(data, 'chokepoint_transits', 'transits', (m) => pickMapKeysLike(m, cp));
        data['chokepoint-flows'] = pickMapKeysLike(data['chokepoint-flows'], cp);
        narrowNested(data, 'chokepoint-baselines', 'chokepoints', (c) => ciIncludes(c.id, cp) || ciIncludes(c.relayId, cp) || ciIncludes(c.name, cp));
      }
      const limit = argNum(params.limit) ?? DEFAULT_LIST_LIMIT;
      capNested(data, 'chokepoint-baselines', 'chokepoints', limit);
      // _countries is the only top-level array in this bundle (string[] of ISO2 codes).
      capArrays(data, limit);
      return selectDatasets(data, argStrList(params.dataset));
    },
    // Maritime chokepoint bundle distinct from get_supply_chain_data (which keeps
    // shipping-stress + customs + comtrade). Cadences span 10-minute relay
    // (transit-summaries, chokepoint_transits) to ~400-day static registries
    // (chokepoint-baselines), so per-key _freshnessChecks pulled from
    // api/health.js::SEED_META — a fast transit outage isn't masked by the
    // slow chokepoint-baselines budget, and the long-cadence portwatch keys
    // don't drag aggregate stale flagging.
    //
    // Payload measurement (PR pre-merge, fun-toad-55127.upstash.io 2026-05-11):
    //   transit-summaries:v1                        — 6.8 KB
    //   chokepoint_transits:v1                      — 1.1 KB
    //   portwatch-ports:v1:_countries               — 0.9 KB
    //   energy:chokepoint-baselines:v1              — 0.6 KB
    //   portwatch:chokepoints:ref:v1                — 7.9 KB
    //   energy:chokepoint-flows:v1                  — 1.2 KB
    //   ────────────────────────────────────────────────────
    //   Total: 18.5 KB (well under the 200KB/single-key and 500KB/aggregate
    //   thresholds that historically tripped handler timeouts —
    //   see tests/transit-summaries.test.mjs:539-545).
    //
    // EXCLUDED on purpose: supply_chain:corridorrisk:v1 is an intermediate
    // key whose data flows through supply_chain:transit-summaries:v1
    // (api/health.js:461). U7 will add corridorrisk to EXCLUDED_FROM_MCP.
    _cacheKeys: [
      'supply_chain:transit-summaries:v1',          // STANDALONE_KEYS::transitSummaries
      'supply_chain:chokepoint_transits:v1',        // STANDALONE_KEYS::chokepointTransits
      'supply_chain:portwatch-ports:v1:_countries', // STANDALONE_KEYS::portwatchPortActivity
      'energy:chokepoint-baselines:v1',             // STANDALONE_KEYS::chokepointBaselines
      'portwatch:chokepoints:ref:v1',               // STANDALONE_KEYS::portwatchChokepointsRef
      'energy:chokepoint-flows:v1',                 // STANDALONE_KEYS::chokepointFlows
    ],
    _seedMetaKey: 'seed-meta:supply_chain:transit-summaries',
    _maxStaleMin: 30, // transit-summaries 10-min relay baseline; per-key budgets via _freshnessChecks below
    _freshnessChecks: [
      { key: 'seed-meta:supply_chain:transit-summaries',   maxStaleMin: 30 },             // 10-min relay; 30min = 3× interval
      { key: 'seed-meta:supply_chain:chokepoint_transits', maxStaleMin: 30 },             // 10-min relay; 30min = 3× interval
      { key: 'seed-meta:supply_chain:portwatch-ports',     maxStaleMin: 2160, minRecordCount: 174 }, // 12h cron; 36h = 3× interval; #3613 requires full country coverage
      { key: 'seed-meta:energy:chokepoint-baselines',      maxStaleMin: 60 * 24 * 400 },  // ~400d static registry
      { key: 'seed-meta:portwatch:chokepoints-ref',        maxStaleMin: 60 * 24 * 14 },   // weekly cron; 14d = 2× interval
      { key: 'seed-meta:energy:chokepoint-flows',          maxStaleMin: 720 },            // 6h cron; 12h = 2× interval
    ],
    _apiPaths: [
      "GET /api/intelligence/v1/get-country-port-activity",
      "GET /api/supply-chain/v1/get-chokepoint-status",
    ],
  },
  {
    name: 'get_positive_events',
    _outputBudgetBytes: 131072,
    description: 'Positive geopolitical events: diplomatic agreements, humanitarian aid, development milestones, and peace initiatives worldwide.',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['science-health', 'nature-wildlife', 'climate-wins', 'innovation-tech', 'humanity-kindness', 'culture-community'],
          description: 'Filter to one positive-event category.',
        },
        limit: { type: 'number', description: 'Cap the event list to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      'geo-bootstrap': {
        type: ['object', 'null'],
        properties: { events: { type: 'array', items: { type: 'object', properties: {
          category: { type: 'string' }, title: { type: 'string' }, summary: { type: 'string' },
          date: { type: 'string' },
        } } } },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const category = argStr(params.category);
      if (category) narrowNested(data, 'geo-bootstrap', 'events', (e) => argStr(e.category) === category);
      capNested(data, 'geo-bootstrap', 'events', (argNum(params.limit) ?? DEFAULT_LIST_LIMIT));
      return data;
    },
    _cacheKeys: ['positive_events:geo-bootstrap:v1'],
    _seedMetaKey: 'seed-meta:positive-events:geo',
    _maxStaleMin: 60,
    _apiPaths: [
      'GET /api/positive-events/v1/list-positive-geo-events',
    ],
  },
  {
    name: 'get_radiation_data',
    _outputBudgetBytes: 131072,
    description: 'Radiation observation levels from global monitoring stations. Flags anomalous readings that may indicate nuclear incidents.',
    inputSchema: {
      type: 'object',
      properties: {
        country: { type: 'string', description: 'Filter to one country by name (case-insensitive substring).' },
        anomalous_only: {
          type: 'boolean',
          description: 'Drop observations with severity "normal" — keep only elevated/spike readings.',
        },
        limit: { type: 'number', description: 'Cap the observation list to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      observations: {
        type: ['object', 'null'],
        properties: { observations: { type: 'array', items: { type: 'object', properties: {
          country: { type: 'string' }, severity: { type: 'string' },
          stationName: { type: 'string' }, value: { type: ['number', 'null'] }, unit: { type: 'string' },
        } } } },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const country = argStr(params.country);
      if (country) narrowNested(data, 'observations', 'observations', (o) => ciIncludes(o.country, country));
      if (argBool(params.anomalous_only)) {
        narrowNested(data, 'observations', 'observations', (o) => !argStr(o.severity).endsWith('normal'));
      }
      capNested(data, 'observations', 'observations', (argNum(params.limit) ?? DEFAULT_LIST_LIMIT));
      return data;
    },
    _cacheKeys: ['radiation:observations:v1'],
    _seedMetaKey: 'seed-meta:radiation:observations',
    _maxStaleMin: 30,
    _apiPaths: [
      "GET /api/radiation/v1/list-radiation-observations",
    ],
  },
  {
    name: 'get_research_signals',
    _outputBudgetBytes: 131072,
    description: 'Tech and research event signals: emerging technology events bootstrap data from curated research feeds.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['conference', 'earnings', 'ipo', 'other'],
          description: 'Filter to one tech-event type.',
        },
        source: { type: 'string', description: 'Filter to one source feed (e.g. "techmeme", "dev.events", "curated").' },
        limit: { type: 'number', description: 'Cap the event list to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      'tech-events-bootstrap': {
        type: ['object', 'null'],
        properties: { events: { type: 'array', items: { type: 'object', properties: {
          type: { type: 'string' }, source: { type: 'string' },
          title: { type: 'string' }, date: { type: 'string' },
        } } } },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const type = argStr(params.type);
      const source = argStr(params.source);
      if (type) narrowNested(data, 'tech-events-bootstrap', 'events', (e) => argStr(e.type) === type);
      if (source) narrowNested(data, 'tech-events-bootstrap', 'events', (e) => argStr(e.source) === source);
      capNested(data, 'tech-events-bootstrap', 'events', (argNum(params.limit) ?? DEFAULT_LIST_LIMIT));
      return data;
    },
    _cacheKeys: ['research:tech-events-bootstrap:v1'],
    _seedMetaKey: 'seed-meta:research:tech-events',
    _maxStaleMin: 480,
    _apiPaths: [
      'GET /api/research/v1/list-tech-events',
    ],
  },
  {
    name: 'get_forecast_predictions',
    _outputBudgetBytes: 131072,
    description: 'AI-generated geopolitical and economic forecasts from WorldMonitor\'s predictive models. Covers upcoming risk events and probability assessments.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Filter to one forecast domain (exact, case-insensitive — e.g. "shipping", "energy", "macro").' },
        region: { type: 'string', description: 'Filter to one region/theater (case-insensitive substring).' },
        limit: { type: 'number', description: 'Cap the forecast list to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      predictions: {
        type: ['object', 'null'],
        properties: { predictions: { type: 'array', items: { type: 'object', properties: {
          domain: { type: 'string' }, region: { type: 'string' },
          probability: { type: ['number', 'null'] }, title: { type: 'string' },
        } } } },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const domain = argStr(params.domain);
      const region = argStr(params.region);
      if (domain) narrowNested(data, 'predictions', 'predictions', (p) => argStr(p.domain) === domain);
      if (region) narrowNested(data, 'predictions', 'predictions', (p) => ciIncludes(p.region, region));
      capNested(data, 'predictions', 'predictions', (argNum(params.limit) ?? DEFAULT_LIST_LIMIT));
      return data;
    },
    _cacheKeys: ['forecast:predictions:v2'],
    _seedMetaKey: 'seed-meta:forecast:predictions',
    _maxStaleMin: 90,
    _apiPaths: [
      "GET /api/forecast/v1/get-forecasts",
    ],
  },

  // -------------------------------------------------------------------------
  // Social velocity — cache read (Reddit signals, seeded by relay)
  // -------------------------------------------------------------------------
  {
    name: 'get_social_velocity',
    _outputBudgetBytes: 131072,
    description: 'Reddit geopolitical social velocity: top posts from worldnews, geopolitics, and related subreddits with engagement scores and trend signals.',
    inputSchema: {
      type: 'object',
      properties: {
        subreddit: { type: 'string', description: 'Filter to one subreddit (e.g. "worldnews", "geopolitics").' },
        limit: { type: 'number', description: 'Cap the post list to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      reddit: {
        type: ['object', 'null'],
        properties: { posts: { type: 'array', items: { type: 'object', properties: {
          subreddit: { type: 'string' }, title: { type: 'string' },
          score: { type: ['number', 'null'] }, url: { type: 'string' }, createdAt: { type: ['string', 'number'] },
        } } } },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const sub = argStr(params.subreddit);
      if (sub) narrowNested(data, 'reddit', 'posts', (p) => argStr(p.subreddit) === sub);
      capNested(data, 'reddit', 'posts', (argNum(params.limit) ?? DEFAULT_LIST_LIMIT));
      return data;
    },
    _cacheKeys: ['intelligence:social:reddit:v1'],
    _seedMetaKey: 'seed-meta:intelligence:social-reddit',
    _maxStaleMin: 30,
    _apiPaths: [
      "GET /api/intelligence/v1/get-social-velocity",
    ],
  },

];
