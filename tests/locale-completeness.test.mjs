import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { flattenKeys } from '../scripts/_locale-keys.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = join(__dirname, '..', 'src', 'locales');

// The weather layer is US + Canada (NWS, ECCC), so copy has to disclose BOTH countries AND
// the issuing agencies. Asserting only /NWS/i would let a label drop the country — e.g.
// shortening hu to "Időjárási riasztások (NWS)" — which restores a worldwide-sounding label
// over a two-country map. Each token below is the scope marker the locale's own translation
// actually uses; a locale with no entry fails loudly rather than going unasserted.
const US_SCOPE_TOKENS = {
  'ar.json': /الولايات المتحدة/,
  'bg.json': /САЩ/,
  'cs.json': /USA/,
  'de.json': /USA|US-/,
  'el.json': /ΗΠΑ/,
  'en.json': /United States|\bUS\b/,
  'es.json': /EE\. ?UU\./,
  'fa.json': /ایالات متحده/,
  'fr.json': /États-Unis/,
  'hi.json': /अमेरिका/,
  'hr.json': /SAD/,
  'hu.json': /Egyesült [Áá]llamok/,
  'it.json': /Stati Uniti/,
  'ja.json': /米国/,
  'ko.json': /미국/,
  'nl.json': /\bVS\b/,
  'pl.json': /USA/,
  'pt.json': /EUA/,
  'ro.json': /SUA/,
  'ru.json': /США/,
  'sv.json': /USA/,
  'sw.json': /Marekani/,
  'th.json': /สหรัฐ/,
  'tr.json': /ABD/,
  'uk.json': /США/,
  'vi.json': /Hoa Kỳ/,
  'zh-TW.json': /美國/,
  'zh.json': /美国/,
};

const CA_SCOPE_TOKENS = {
  'ar.json': /كندا/,
  'bg.json': /Канад/,
  'cs.json': /Kanad/,
  'de.json': /Kanada/,
  'el.json': /Καναδ/,
  'en.json': /Canada/,
  'es.json': /Canadá/,
  'fa.json': /کانادا/,
  'fr.json': /Canada/,
  'hi.json': /कनाडा/,
  'hr.json': /Kanad/,
  'hu.json': /kanad/i,
  'it.json': /Canada/,
  'ja.json': /カナダ/,
  'ko.json': /캐나다/,
  'nl.json': /Canada/,
  'pl.json': /Kanad/,
  'pt.json': /Canadá/,
  'ro.json': /Canada/,
  'ru.json': /Канад/,
  'sv.json': /Kanada/,
  'sw.json': /Kanada/,
  'th.json': /แคนาดา/,
  'tr.json': /Kanada/,
  'uk.json': /Канад/,
  'vi.json': /Canada/,
  'zh-TW.json': /加拿大/,
  'zh.json': /加拿大/,
};


describe('locale completeness', () => {
  const en = JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf8'));
  const enKeys = flattenKeys(en);
  const localeFiles = readdirSync(LOCALES_DIR)
    .filter((name) => name.endsWith('.json') && name !== 'en.json' && name !== 'en.shell.json')
    .sort();

  // Sanity tripwire: en is the source catalog (~2400 keys today). A drop below
  // 2000 means the catalog collapsed (bad parse / mass deletion), which would
  // make the per-locale completeness checks below pass vacuously.
  it('en.json defines at least 2000 translation keys', () => {
    // inventory-contract: locale-key-completeness; classification: floor; promise: the English UI catalog remains a full product surface; reason: a 2000-key floor detects mass deletion before locale parity can pass vacuously
    assert.ok(enKeys.length >= 2000, `expected a large en catalog, got ${enKeys.length}`);
  });

  for (const file of localeFiles) {
    it(`${file} contains every en.json key`, () => {
      const locale = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8'));
      const localeKeySet = new Set(flattenKeys(locale));
      const missing = enKeys.filter((key) => !localeKeySet.has(key));

      // inventory-contract: locale-key-completeness; classification: parity; reason: missing-key parity is an exact completeness contract, not a catalog total
      assert.equal(
        missing.length,
        0,
        `${file} is missing ${missing.length} key(s): ${missing.slice(0, 10).join(', ')}${
          missing.length > 10 ? '…' : ''
        }`,
      );
    });
  }

  for (const file of ['en.json', ...localeFiles]) {
    it(`${file} discloses US+Canada NWS/ECCC coverage for every weather layer label`, () => {
      const locale = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8'));
      const values = [
        locale.components.deckgl.layers.weatherAlerts,
        locale.components.deckgl.layerHelp.descriptions.weatherAlerts,
        locale.components.deckgl.layerHelp.descriptions.weatherAlertsMarket,
      ];

      const scopeToken = US_SCOPE_TOKENS[file];
      assert.ok(
        scopeToken,
        `${file} has no US_SCOPE_TOKENS entry — add the country marker this locale uses so its weather copy is not silently unasserted`,
      );

      const caToken = CA_SCOPE_TOKENS[file];
      assert.ok(
        caToken,
        `${file} has no CA_SCOPE_TOKENS entry — add the Canada marker this locale uses so its weather copy is not silently unasserted`,
      );

      for (const value of values) {
        assert.equal(typeof value, 'string');
        assert.match(value, /NWS/i, `${file} weather coverage copy must identify NWS`);
        assert.match(value, /ECCC/i, `${file} weather coverage copy must identify ECCC`);
        assert.match(
          value,
          scopeToken,
          `${file} weather coverage copy must name United States scope (${scopeToken}), not just the NWS acronym`,
        );
        assert.match(
          value,
          caToken,
          `${file} weather coverage copy must name Canada scope (${caToken})`,
        );
      }
    });
  }

  for (const file of ['en.json', ...localeFiles]) {
    it(`${file} describes the shared Canada roads layer without stale province-only copy`, () => {
      const locale = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8'));
      const values = [
        locale.components.deckgl.layers.canadaRoads,
        locale.components.deckgl.layerHelp.descriptions.canadaRoads,
      ];
      for (const value of values) {
        assert.equal(typeof value, 'string');
        assert.match(value, /Canada|Canadian/i, `${file} canadaRoads copy must identify Canadian scope`);
        assert.doesNotMatch(value, /Ontario and Alberta/i, `${file} canadaRoads copy must not claim only two provinces`);
      }
    });

    it(`${file} discloses the AB + BC + SK scope for the canadaAlerts layer`, () => {
      const locale = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8'));
      const layer = locale.components.deckgl.layers.canadaAlerts;
      const help = locale.components.deckgl.layerHelp.descriptions.canadaAlerts;
      assert.equal(typeof layer, 'string');
      assert.equal(typeof help, 'string');
      assert.match(layer, /AB \+ BC \+ SK/, `${file} canadaAlerts layer label must name SK`);
      assert.match(help, /SaskAlert/i, `${file} canadaAlerts help must name SaskAlert`);
      assert.doesNotMatch(layer, /Alberta Emergency Alert only/i, `${file} canadaAlerts copy must not claim Alberta-only coverage`);
      assert.doesNotMatch(help, /Alberta Emergency Alert only/i, `${file} canadaAlerts copy must not claim Alberta-only coverage`);
    });
  }

  for (const file of ['en.json', ...localeFiles]) {
    it(`${file} describes the shared Canada roads layer without stale province-only copy`, () => {
      const locale = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8'));
      const values = [
        locale.components.deckgl.layers.canadaRoads,
        locale.components.deckgl.layerHelp.descriptions.canadaRoads,
      ];
      for (const value of values) {
        assert.equal(typeof value, 'string');
        assert.match(value, /Canada|Canadian/i, `${file} canadaRoads copy must identify Canadian scope`);
        assert.doesNotMatch(value, /Ontario and Alberta/i, `${file} canadaRoads copy must not claim only two provinces`);
      }
    });

    it(`${file} discloses the AB + BC + SK scope for the canadaAlerts layer`, () => {
      const locale = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8'));
      const layer = locale.components.deckgl.layers.canadaAlerts;
      const help = locale.components.deckgl.layerHelp.descriptions.canadaAlerts;
      assert.equal(typeof layer, 'string');
      assert.equal(typeof help, 'string');
      assert.match(layer, /AB \+ BC \+ SK/, `${file} canadaAlerts layer label must name SK`);
      assert.match(help, /SaskAlert/i, `${file} canadaAlerts help must name SaskAlert`);
      assert.doesNotMatch(layer, /Alberta Emergency Alert only/i, `${file} canadaAlerts copy must not claim Alberta-only coverage`);
      assert.doesNotMatch(help, /Alberta Emergency Alert only/i, `${file} canadaAlerts copy must not claim Alberta-only coverage`);
    });
  }
});
