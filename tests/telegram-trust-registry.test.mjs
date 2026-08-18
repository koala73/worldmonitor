/**
 * Telegram public trust registry (#6600).
 *
 * Operational `tier` in data/telegram-channels.json never reached the public
 * registries. Unlisted names default to editorial tier 4 via getSourceTier(),
 * while the relay alert gate only drops sources *explicitly* listed as 4.
 *
 * This suite:
 *   - registers every enabled Telegram channel in both public registries
 *   - records the before/after alert-drop behaviour
 *   - keeps honestly-tier-4 aggregators dropped
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
import { getSourceTier } from '../server/_shared/source-tiers.ts';
import { SOURCE_TOOLS } from '../api/mcp/registry/source-tools.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

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

function explicitRelayTier4Set(tiers) {
  return new Set(
    Object.entries(tiers).filter(([, tier]) => tier === 4).map(([name]) => name),
  );
}

/** Mirrors scripts/ais-relay.cjs RELAY_GATES_READY source-tier skip. */
function relayWouldDropExplicitTier4(sourceName, tiers) {
  return explicitRelayTier4Set(tiers).has(sourceName ?? '');
}

/** Mirrors src/services/breaking-news-alerts.ts keyword-only skip. */
function clientWouldDropKeywordAlert(sourceName, tiers) {
  const tier = tiers[sourceName] ?? 4;
  return tier >= 3;
}

const getSources = SOURCE_TOOLS.find((tool) => tool.name === 'get_sources');

describe('Telegram trust registry (#6600)', () => {
  it('covers every enabled channel in data/telegram-channels.json', () => {
    const enabled = enabledTelegramChannels();
    assert.ok(enabled.length >= 64, `expected 64 enabled channels, got ${enabled.length}`);
    const overlayHandles = new Set(TELEGRAM_CHANNEL_TRUST.map((entry) => entry.handle));
    const missing = enabled.map((channel) => channel.handle).filter((handle) => !overlayHandles.has(handle));
    assert.deepEqual(missing, [], `overlay missing handles: ${missing.join(', ')}`);
  });

  it('registers each channel in both public registries under the display label', () => {
    for (const entry of TELEGRAM_CHANNEL_TRUST) {
      assert.equal(TELEGRAM_HANDLE_TO_PUBLIC_NAME[entry.handle], entry.name);
      assert.equal(sourceTiers[entry.name], entry.tier, `${entry.name} source-tiers.json`);
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

describe('Telegram alert-drop confirmation (#6600)', () => {
  it('documents the current relay gate: only explicit tier-4 keys, not the default-4 fallback', () => {
    assert.match(aisRelaySrc, /RELAY_TIER4_SOURCES\.has\(meta\.source/);
    assert.match(aisRelaySrc, /return RELAY_SOURCE_TIERS\[sourceName\] \?\? 4/);
    assert.doesNotMatch(
      aisRelaySrc.slice(aisRelaySrc.indexOf('async function seedClassifyForVariant')),
      /telegramState\.items/,
    );

    // BEFORE: generic platform source and unlisted labels default to 4 for
    // scoring/client keyword gating, but they are NOT in the explicit T4 set,
    // so RELAY_GATES_READY does not drop them.
    assert.equal(getSourceTier('telegram'), 4);
    assert.equal(sourceTiers.telegram, undefined);
    assert.equal(relayWouldDropExplicitTier4('telegram', sourceTiers), false);
    assert.equal(clientWouldDropKeywordAlert('telegram', sourceTiers), true);
  });

  it('does not silently drop Telegram items that should alert after registration', () => {
    const shouldAlert = TELEGRAM_CHANNEL_TRUST.filter((entry) => entry.tier < 4);
    const remainDropped = TELEGRAM_CHANNEL_TRUST.filter((entry) => entry.tier === 4);
    assert.ok(shouldAlert.length > 0);
    assert.ok(remainDropped.length > 0, 'honest mapping must keep some aggregators at tier 4');

    for (const entry of shouldAlert) {
      assert.equal(relayWouldDropExplicitTier4(entry.name, sourceTiers), false, entry.name);
      assert.equal(getSourceTier(entry.name) < 4, true, entry.name);
    }
    for (const entry of remainDropped) {
      assert.equal(relayWouldDropExplicitTier4(entry.name, sourceTiers), true, `${entry.name} must remain explicitly tier 4`);
      assert.equal(clientWouldDropKeywordAlert(entry.name, sourceTiers), true);
    }

    // AFTER: looking up the channel label (not source:"telegram") is what the
    // badge renderer and any future alert path must use.
    assert.equal(resolveTelegramSourceName('IDF Official', 'IDFofficial'), 'IDF Official');
    assert.equal(relayWouldDropExplicitTier4('IDF Official', sourceTiers), false);
    assert.equal(clientWouldDropKeywordAlert('IDF Official', sourceTiers), false);
    assert.equal(clientWouldDropKeywordAlert('Clash Report', sourceTiers), true);
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
    assert.equal(dd.risk, 'high');
    assert.match(dd.label, /State Media|Caution/);
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
  });

  it('does not default an unlisted Telegram platform key to a declared outlet', async () => {
    const result = await getSources._execute({ view: 'outlets', query: 'telegram', limit: 50 }, '', {}, undefined);
    assert.equal(result.outlets.some((outlet) => outlet.name === 'telegram'), false);
  });
});
