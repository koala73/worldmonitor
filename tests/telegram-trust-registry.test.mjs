/**
 * Telegram public trust registry (#6600).
 *
 * Operational `tier` in data/telegram-channels.json never reached the public
 * registries. Unlisted names default to editorial tier 4 via getSourceTier(),
 * while the relay alert gate only drops sources *explicitly* listed as 4.
 *
 * This suite:
 *   - registers every enabled Telegram channel in both public registries
 *   - records the display-label policy for a future Telegram alert path
 *   - keeps honestly-tier-4 aggregators explicit in the merged tier registry
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TELEGRAM_CHANNEL_TRUST,
  TELEGRAM_HANDLE_TO_PUBLIC_NAME,
  TELEGRAM_SOURCE_TIERS,
  resolveTelegramSourceName,
} from '../shared/telegram-channel-trust.ts';
import {
  SOURCE_PROPAGANDA_RISK,
  SOURCE_TYPES,
  getSourcePropagandaRisk,
  getSourceTierBadgeTitle,
  getSourceType,
  describePropagandaBadge,
} from '../shared/source-provenance.ts';
import { SOURCE_TIERS, getSourceTier } from '../server/_shared/source-tiers.ts';
import { SOURCE_TOOLS } from '../api/mcp/registry/source-tools.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const require = createRequire(import.meta.url);
const sourceTierPolicyPath = join(repoRoot, 'shared/source-tier-policy.cjs');
const {
  createExplicitTierFourSourceSet,
  isExplicitTierFourSource,
  shouldDropRelaySourceForTier,
} = require(sourceTierPolicyPath);

const telegramChannels = JSON.parse(
  readFileSync(join(repoRoot, 'data/telegram-channels.json'), 'utf8'),
);
const sourceTiers = JSON.parse(
  readFileSync(join(repoRoot, 'shared/source-tiers.json'), 'utf8'),
);
const aisRelaySrc = readFileSync(join(repoRoot, 'scripts/ais-relay.cjs'), 'utf8');

function enabledTelegramChannels() {
  return Object.values(telegramChannels.channels)
    .flat()
    .filter((channel) => channel?.enabled && channel?.handle);
}

/** Mirrors src/services/breaking-news-alerts.ts keyword-only skip. */
function clientWouldDropKeywordAlert(sourceName, tiers) {
  const tier = tiers[sourceName] ?? 4;
  return tier >= 3;
}

const getSources = SOURCE_TOOLS.find((tool) => tool.name === 'get_sources');

describe('Telegram trust registry (#6600)', () => {
  it('matches every enabled channel handle and display label exactly', () => {
    const enabled = enabledTelegramChannels();
    assert.ok(enabled.length >= 64, `expected 64 enabled channels, got ${enabled.length}`);
    const configuredPairs = enabled
      .map((channel) => `${channel.handle}\0${channel.label}`)
      .sort();
    const overlayPairs = TELEGRAM_CHANNEL_TRUST
      .map((entry) => `${entry.handle}\0${entry.name}`)
      .sort();

    assert.deepEqual(overlayPairs, configuredPairs);
    assert.equal(new Set(enabled.map((channel) => channel.handle)).size, enabled.length);
    assert.equal(new Set(enabled.map((channel) => channel.label)).size, enabled.length);
    assert.equal(new Set(TELEGRAM_CHANNEL_TRUST.map((entry) => entry.handle)).size, TELEGRAM_CHANNEL_TRUST.length);
    assert.equal(new Set(TELEGRAM_CHANNEL_TRUST.map((entry) => entry.name)).size, TELEGRAM_CHANNEL_TRUST.length);
    assert.equal(
      new Set(TELEGRAM_CHANNEL_TRUST.map((entry) => entry.handle.replace(/^@/, '').toLowerCase())).size,
      TELEGRAM_CHANNEL_TRUST.length,
    );
  });

  it('registers each channel in both public registries under the display label', () => {
    for (const entry of TELEGRAM_CHANNEL_TRUST) {
      assert.equal(TELEGRAM_HANDLE_TO_PUBLIC_NAME[entry.handle], entry.name);
      assert.equal(getSourceTier(entry.name), entry.tier, `${entry.name} getSourceTier`);
      assert.equal(getSourceType(entry.name), entry.type, `${entry.name} SOURCE_TYPES`);
      assert.equal(getSourcePropagandaRisk(entry.name).risk, entry.risk, `${entry.name} propaganda risk`);
      assert.equal(SOURCE_TYPES[entry.name], entry.type);
      if (!entry.reuseExisting) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(SOURCE_PROPAGANDA_RISK, entry.name),
          `${entry.name} missing SOURCE_PROPAGANDA_RISK`,
        );
        assert.ok(
          Object.prototype.hasOwnProperty.call(TELEGRAM_SOURCE_TIERS, entry.name),
          `${entry.name} should be in the additive Telegram tier map`,
        );
      }
    }
  });

  it('keeps additive Telegram tiers out of the canonical RSS tier JSON', () => {
    const additiveEntries = TELEGRAM_CHANNEL_TRUST.filter((entry) => !entry.reuseExisting);
    assert.deepEqual(
      Object.keys(TELEGRAM_SOURCE_TIERS).sort(),
      additiveEntries.map((entry) => entry.name).sort(),
    );
    for (const entry of additiveEntries) {
      assert.equal(sourceTiers[entry.name], undefined, `${entry.name} must come from the Telegram overlay`);
      assert.equal(TELEGRAM_SOURCE_TIERS[entry.name], entry.tier);
    }
  });

  it('does not overwrite the existing Bellingcat RSS masthead', () => {
    const bellingcat = TELEGRAM_CHANNEL_TRUST.find((entry) => entry.handle === 'bellingcat');
    assert.equal(bellingcat?.reuseExisting, true);
    assert.equal(sourceTiers.Bellingcat, 3);
    assert.equal(getSourceType('Bellingcat'), 'intel');
    assert.equal(getSourcePropagandaRisk('Bellingcat').risk, 'low');
  });

  it('keeps wire/gov publishers and anonymous aggregators in different classes', () => {
    assert.equal(getSourceType('IDF Official'), 'gov');
    assert.equal(getSourceTier('IDF Official'), 1);
    assert.equal(getSourceType('Clash Report'), 'intel');
    assert.equal(getSourceTier('Clash Report'), 3);
    assert.equal(getSourceType('DD Geopolitics'), 'intel');
    assert.equal(getSourceTier('DD Geopolitics'), 4);
  });
});

describe('Telegram alert-tier policy (#6600)', () => {
  it('executes the relay tier gate against its JSON tier map', () => {
    const relayTierFourSources = createExplicitTierFourSourceSet(sourceTiers);

    assert.equal(shouldDropRelaySourceForTier(true, 'AI News', relayTierFourSources), true);
    assert.equal(shouldDropRelaySourceForTier(true, 'telegram', relayTierFourSources), false);
    assert.equal(shouldDropRelaySourceForTier(true, 'Unknown source', relayTierFourSources), false);
    assert.equal(shouldDropRelaySourceForTier(false, 'AI News', relayTierFourSources), false);
    assert.match(aisRelaySrc, /createExplicitTierFourSourceSet\(RELAY_SOURCE_TIERS\)/);
    assert.match(
      aisRelaySrc,
      /shouldDropRelaySourceForTier\(RELAY_GATES_READY, meta\.source, RELAY_TIER4_SOURCES\)/,
    );
    assert.equal(
      readFileSync(join(repoRoot, 'scripts/shared/source-tier-policy.cjs'), 'utf8'),
      readFileSync(sourceTierPolicyPath, 'utf8'),
    );
  });

  it('documents the current relay gate: only explicit tier-4 keys, not the default-4 fallback', () => {
    const relayTierFourSources = createExplicitTierFourSourceSet(sourceTiers);
    assert.match(aisRelaySrc, /return RELAY_SOURCE_TIERS\[sourceName\] \?\? 4/);
    const classifyStart = aisRelaySrc.indexOf('async function seedClassifyForVariant');
    const classifyEnd = aisRelaySrc.indexOf('\nasync function seedClassify()', classifyStart);
    assert.ok(classifyStart >= 0 && classifyEnd > classifyStart);
    const classifyFn = aisRelaySrc.slice(classifyStart, classifyEnd);
    assert.match(classifyFn, /list-feed-digest/);
    assert.doesNotMatch(classifyFn, /telegramState\.items/);

    // BEFORE: generic platform source and unlisted labels default to 4 for
    // scoring/client keyword gating, but they are NOT in the explicit T4 set,
    // so RELAY_GATES_READY does not drop them.
    assert.equal(getSourceTier('telegram'), 4);
    assert.equal(sourceTiers.telegram, undefined);
    assert.equal(isExplicitTierFourSource('telegram', relayTierFourSources), false);
    assert.equal(clientWouldDropKeywordAlert('telegram', SOURCE_TIERS), true);
  });

  it('records display-label tier policy for a future Telegram alert path', () => {
    const shouldAlert = TELEGRAM_CHANNEL_TRUST.filter((entry) => entry.tier < 4);
    const remainDropped = TELEGRAM_CHANNEL_TRUST.filter((entry) => entry.tier === 4);
    const tierFourSources = createExplicitTierFourSourceSet(SOURCE_TIERS);
    assert.ok(shouldAlert.length > 0);
    assert.ok(remainDropped.length > 0, 'honest mapping must keep some aggregators at tier 4');

    for (const entry of shouldAlert) {
      assert.equal(isExplicitTierFourSource(entry.name, tierFourSources), false, entry.name);
      assert.equal(getSourceTier(entry.name) < 4, true, entry.name);
    }
    for (const entry of remainDropped) {
      assert.equal(isExplicitTierFourSource(entry.name, tierFourSources), true, `${entry.name} must remain explicitly tier 4`);
      assert.equal(clientWouldDropKeywordAlert(entry.name, SOURCE_TIERS), true);
    }

    // AFTER: looking up the channel label (not source:"telegram") is what the
    // badge renderer and any future alert path must use.
    assert.equal(resolveTelegramSourceName('IDF Official', 'IDFofficial'), 'IDF Official');
    assert.equal(isExplicitTierFourSource('IDF Official', tierFourSources), false);
    assert.equal(clientWouldDropKeywordAlert('IDF Official', SOURCE_TIERS), false);
    assert.equal(clientWouldDropKeywordAlert('Clash Report', SOURCE_TIERS), true);
  });
});

describe('Telegram trust badges (#6600)', () => {
  it('uses the existing propaganda/tier descriptors for Telegram labels', () => {
    const idf = describePropagandaBadge(
      getSourcePropagandaRisk('IDF Official'),
      getSourceType('IDF Official'),
    );
    assert.ok(idf);
    assert.equal(idf.label, 'Official Government Source');
    assert.equal(getSourceTier('IDF Official'), 1);
    assert.equal(getSourceTierBadgeTitle('gov'), 'Official Government Source');

    const clash = describePropagandaBadge(
      getSourcePropagandaRisk('Clash Report'),
      getSourceType('Clash Report'),
    );
    assert.ok(clash);
    assert.equal(clash.risk, 'medium');
    assert.equal(getSourceTier('Clash Report'), 3);

    const dd = describePropagandaBadge(
      getSourcePropagandaRisk('DD Geopolitics'),
      getSourceType('DD Geopolitics'),
    );
    assert.ok(dd);
    assert.equal(dd.risk, 'medium');
    assert.equal(dd.label, '! Caution');
    assert.equal(getSourceTier('DD Geopolitics'), 4);

    const bellingcat = describePropagandaBadge(
      getSourcePropagandaRisk('Bellingcat'),
      getSourceType('Bellingcat'),
    );
    assert.equal(bellingcat, null);

    const unlisted = describePropagandaBadge(
      getSourcePropagandaRisk('telegram'),
      getSourceType('telegram'),
    );
    assert.ok(unlisted);
    assert.match(unlisted.label, /Unreviewed/);
  });

  it('uses the same propaganda descriptor as NewsPanel for Iranian state media', () => {
    const badge = describePropagandaBadge(
      getSourcePropagandaRisk('PressTV (Iran State)'),
      getSourceType('PressTV (Iran State)'),
    );
    assert.ok(badge);
    assert.equal(badge.risk, 'high');
    assert.match(badge.label, /State Media/);
  });
});

describe('/sources reflects Telegram provenance (#6600)', () => {
  it('exposes Telegram outlets through get_sources', async () => {
    const result = await getSources._execute({ view: 'outlets', query: 'IDF Official', limit: 10 }, '', {}, undefined);
    const match = result.outlets.find((outlet) => outlet.name === 'IDF Official');
    assert.ok(match, 'IDF Official must appear in the outlets catalog');
    assert.equal(match.tier, 1);
    assert.equal(match.provenance.type, 'gov');
    assert.equal(match.provenance.risk, 'high');
    assert.equal(match.provenance.riskReviewed, true);
    assert.deepEqual(match.platformIdentities, [{ platform: 'telegram', handle: 'IDFofficial' }]);
  });

  it('enumerates every Telegram source through the platform filter', async () => {
    const result = await getSources._execute(
      { view: 'outlets', platform: 'telegram', limit: 100 },
      '',
      {},
      undefined,
    );
    assert.equal(result.matched, TELEGRAM_CHANNEL_TRUST.length);
    assert.deepEqual(
      result.outlets.map((outlet) => outlet.name).sort(),
      TELEGRAM_CHANNEL_TRUST.map((entry) => entry.name).sort(),
    );
    assert.ok(result.outlets.every((outlet) => (
      outlet.platformIdentities?.some((identity) => identity.platform === 'telegram')
    )));
  });

  it('does not default an unlisted Telegram platform key to a declared outlet', async () => {
    const result = await getSources._execute({ view: 'outlets', query: 'telegram', limit: 50 }, '', {}, undefined);
    assert.equal(result.outlets.some((outlet) => outlet.name === 'telegram'), false);
  });
});

describe('Telegram source-name resolution (#6600)', () => {
  it('uses the stable handle identity before mutable display titles', () => {
    assert.equal(resolveTelegramSourceName('IDFofficial', 'IDFofficial'), 'IDF Official');
    assert.equal(resolveTelegramSourceName('Renamed IDF title', '@idfofficial'), 'IDF Official');
    assert.equal(resolveTelegramSourceName('Unknown channel title', 'unknown_handle'), 'Unknown channel title');
  });
});
