import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { RUNTIME_FEATURES } from '../src/services/runtime-config.ts';
import {
  tapeClaimForMarketSource,
  tapeClaimLabel,
} from '../src/services/market-tape-claim.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('tapeClaimForMarketSource', () => {
  it('treats Yahoo as delayed even when a key exists', () => {
    assert.equal(
      tapeClaimForMarketSource({ source: 'yahoo', keyConfigured: true }),
      'delayed_unverified',
    );
    assert.notEqual(
      tapeClaimForMarketSource({ source: 'yahoo', keyConfigured: true }),
      'licensed_live',
    );
  });

  it('treats a missing Finnhub key as unconfigured, not a live outage', () => {
    assert.equal(
      tapeClaimForMarketSource({ source: 'finnhub', keyConfigured: false }),
      'unconfigured',
    );
    assert.equal(
      tapeClaimLabel(tapeClaimForMarketSource({ source: 'finnhub', keyConfigured: false })),
      'Data source not configured',
    );
  });

  it('does not promote a configured Finnhub key to licensed-live', () => {
    assert.equal(
      tapeClaimForMarketSource({ source: 'finnhub', keyConfigured: true }),
      'delayed_unverified',
    );
  });

  it('labels seeded quotes historical when the seed path is configured', () => {
    assert.equal(
      tapeClaimForMarketSource({ source: 'seed', keyConfigured: true }),
      'historical',
    );
  });

  it('requires an explicit rebroadcast confirmation for licensed-live', () => {
    assert.equal(
      tapeClaimForMarketSource({
        source: 'finnhub',
        keyConfigured: true,
        realtimeDisplayConfirmed: true,
      }),
      'licensed_live',
    );
    assert.equal(
      tapeClaimForMarketSource({
        source: 'yahoo',
        keyConfigured: true,
        realtimeDisplayConfirmed: true,
      }),
      'delayed_unverified',
    );
  });

  it('never promotes a seeded snapshot to licensed-live', () => {
    // A rebroadcast right is a property of the vendor relationship, not of a
    // cached row. The operator flag must not reclassify seed data.
    assert.equal(
      tapeClaimForMarketSource({
        source: 'seed',
        keyConfigured: true,
        realtimeDisplayConfirmed: true,
      }),
      'historical',
    );
  });

  it('reports a stale claim once a quote outlives its freshness budget', () => {
    const now = 1_700_000_000_000;
    assert.equal(
      tapeClaimForMarketSource({
        source: 'finnhub',
        keyConfigured: true,
        asOfMs: now - 60_000,
        maxFreshMs: 300_000,
        nowMs: now,
      }),
      'delayed_unverified',
    );
    assert.equal(
      tapeClaimForMarketSource({
        source: 'finnhub',
        keyConfigured: true,
        asOfMs: now - 600_000,
        maxFreshMs: 300_000,
        nowMs: now,
      }),
      'stale',
    );
    // Staleness outranks a rebroadcast right: an old row is not a live tape.
    assert.equal(
      tapeClaimForMarketSource({
        source: 'finnhub',
        keyConfigured: true,
        realtimeDisplayConfirmed: true,
        asOfMs: now - 600_000,
        maxFreshMs: 300_000,
        nowMs: now,
      }),
      'stale',
    );
  });
});

describe('Tape Claim copy', () => {
  it('does not describe Finnhub as a live tape in runtime-config', () => {
    const feature = RUNTIME_FEATURES.find((item) => item.id === 'finnhubMarkets');
    assert.ok(feature);
    assert.match(feature.description, /delayed|seeded/i);
    assert.doesNotMatch(feature.description, /real-?time/i);
  });

  // Key-scoped, every-locale sweep. The previous version banned two English
  // sentences by literal match against en.json only, which (a) could not see a
  // stale translation in any of the other 28 locales and (b) matched anywhere
  // in the file rather than at the key under test.
  const QUOTE_COPY_KEYS = [
    'modals.runtimeConfig.help.FINNHUB_API_KEY',
    'components.markets.infoTooltip',
    'components.gulfEconomies.infoTooltip',
  ];

  // "Real-time" and its equivalents in every locale this repo ships.
  const LIVE_TAPE_CLAIM = new RegExp([
    'real[- ]?time', 'echtzeit', 'tiempo real', 'temps réel', 'temps reel',
    'tempo reale', 'tempo real', 'realtid', 'realtime',
    'в реальном времени',
    'у реальному часі',
    'в реално време',
    'czasie rzeczywistym', 'reálném čase', 'realnom vremenu',
    'valós idejű', 'timp real', 'gerçek zamanlı', 'anlık', 'anlik',
    'πραγματικό χρόνο',
    'रियल-टाइम', 'เรียลไทม',
    'thời gian thực', 'リアルタイム', '실시간',
    '实时', '即時', '實時',
    'فوري', 'الوقت الفعلي',
    'wakati halisi',
  ].join('|'), 'i');

  function readLocale(file: string): Record<string, unknown> {
    return JSON.parse(readFileSync(join(root, 'src/locales', file), 'utf8')) as Record<string, unknown>;
  }

  function lookup(source: Record<string, unknown>, path: string): unknown {
    return path.split('.').reduce<unknown>(
      (current, key) => (current && typeof current === 'object'
        ? (current as Record<string, unknown>)[key]
        : undefined),
      source,
    );
  }

  const localeFiles = readdirSync(join(root, 'src/locales')).filter((name) => name.endsWith('.json'));

  function supportedLocaleFiles(): string[] {
    const source = readFileSync(join(root, 'src/services/i18n.ts'), 'utf8');
    const declaration = source.match(/const SUPPORTED_LANGUAGES = \[([^\]]+)\]/);
    assert.ok(declaration, 'SUPPORTED_LANGUAGES declaration must be extractable');
    const supported = [...declaration[1].matchAll(/'([^']+)'/g)].map((match) => `${match[1]}.json`);
    return [...supported, 'en.shell.json'].sort();
  }

  it('ships a locale set to sweep', () => {
    assert.deepEqual(localeFiles.sort(), supportedLocaleFiles(), 'market-copy locale sweep must match SUPPORTED_LANGUAGES exactly');
  });

  it('claims no live tape at any market-quote copy key, in any locale', () => {
    const offenders: string[] = [];
    for (const file of localeFiles) {
      const locale = readLocale(file);
      for (const key of QUOTE_COPY_KEYS) {
        const value = lookup(locale, key);
        if (typeof value !== 'string') continue;
        if (LIVE_TAPE_CLAIM.test(value)) offenders.push(`${file} -> ${key}: ${value.slice(0, 80)}`);
      }
    }
    assert.deepEqual(offenders, [], `live-tape claims survive in:\n${offenders.join('\n')}`);
  });

  it('binds the honest Finnhub wording to its own key, not just to the file', () => {
    const en = readLocale('en.json');
    assert.match(
      String(lookup(en, 'modals.runtimeConfig.help.FINNHUB_API_KEY')),
      /delayed or seeded/i,
    );
  });
});
