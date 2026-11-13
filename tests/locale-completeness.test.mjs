import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { flattenKeys } from '../scripts/_locale-keys.mjs';
import {
  expectedKeysForLocale,
  findPluralBases,
  flatten,
  getPluralCategories,
} from '../scripts/translate-locales.mjs';
import { syncFromTemplate } from '../scripts/sync-locale-keys.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = join(__dirname, '..', 'src', 'locales');
const STALE_WEATHER_SCOPE_BY_LOCALE = Object.freeze({
  'ar.json': /الولايات المتحدة وكندا/,
  'bg.json': /САЩ и Канада/,
  'cs.json': /USA a Kanad/,
  'de.json': /(?:US- und Kanada|USA und Kanada)/,
  'el.json': /ΗΠΑ και (?:τον )?Καναδά/,
  'es.json': /EE\. UU\. y Canadá/,
  'fa.json': /ایالات متحده و کانادا/,
  'fr.json': /États-Unis et au Canada/,
  'hi.json': /अमेरिका और कनाडा/,
  'hr.json': /SAD(?:-u)? i Kanad/,
  'hu.json': /(?:Egyesült államokbeli és kanadai|Egyesült Államokban és Kanadában)/i,
  'it.json': /Stati Uniti e(?: in)? Canada/,
  'ja.json': /米国とカナダ/,
  'ko.json': /미국(?:·|과 )캐나다/,
  'nl.json': /VS en Canada/,
  'pl.json': /USA i Kanad/,
  'pt.json': /EUA e no Canadá/,
  'ro.json': /SUA și Canada/,
  'ru.json': /США и Канад/,
  'sv.json': /USA och Kanada/,
  'sw.json': /Marekani na Kanada/,
  'th.json': /สหรัฐฯ และแคนาดา/,
  'tr.json': /ABD ve Kanada/,
  'uk.json': /США та Канад/,
  'vi.json': /Hoa Kỳ và Canada/,
  'zh-TW.json': /美國與加拿大/,
  'zh.json': /美国与加拿大/,
});

// Weather alerts merge NWS, ECCC, and WMO SWIC into one official-warning
// pipeline. Copy must name all three agencies so a label cannot quietly shrink
// back to US-only NWS. Each file is still asserted; a locale with no entry
// fails loudly rather than going unasserted.
describe('locale completeness', () => {
  const en = JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf8'));
  const enKeys = flattenKeys(en);
  const enFlat = flatten(en);
  const pluralBases = findPluralBases(enFlat);
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

  it('syncs only the plural keys in a locale CLDR projection', () => {
    const template = {
      cart: {
        items_one: 'one item',
        items_other: 'many items',
      },
      plain: 'Plain copy',
    };
    const locale = { cart: { items_one: 'uno' } };
    const templateFlat = flatten(template);
    const expected = expectedKeysForLocale(
      templateFlat,
      findPluralBases(templateFlat),
      ['zero', 'one', 'two', 'few', 'many', 'other'],
    );

    assert.deepEqual(syncFromTemplate(template, locale, expected), {
      cart: {
        items_one: 'uno',
        items_other: 'many items',
        items_zero: 'many items',
        items_two: 'many items',
        items_few: 'many items',
        items_many: 'many items',
      },
      plain: 'Plain copy',
    });
  });

  it('does not add an English singular variant to an other-only locale', () => {
    // The projection must not import a CLDR category the locale never uses.
    // Writing `_one` into a locale whose plural rules have no `one` is what
    // makes a sync look complete while emitting a key i18next never selects.
    const template = { alerts_one: '{{count}} alert', alerts_other: '{{count}} alerts', title: 'Status' };
    const templateFlat = flatten(template);
    const expected = expectedKeysForLocale(
      templateFlat,
      findPluralBases(templateFlat),
      getPluralCategories('ja'),
    );

    assert.deepEqual(
      syncFromTemplate(template, { alerts_other: '通知' }, expected),
      { alerts_other: '通知', title: 'Status' },
    );
  });

  it('rebuilds missing flattened array paths as arrays', () => {
    const template = { pricing: { features: ['First', 'Second'] } };
    const expected = { 'pricing.features[0]': 'First', 'pricing.features[1]': 'Second' };

    assert.deepEqual(syncFromTemplate(template, {}, expected), template);
    assert.equal(Array.isArray(syncFromTemplate(template, {}, expected).pricing.features), true);
  });

  for (const file of localeFiles) {
    it(`${file} contains every key required by its CLDR plural rules`, () => {
      const locale = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8'));
      const localeKeySet = new Set(flattenKeys(locale));
      const localeCode = file.replace(/\.json$/, '');
      const expected = Object.keys(
        expectedKeysForLocale(enFlat, pluralBases, getPluralCategories(localeCode)),
      );
      const missing = expected.filter((key) => !localeKeySet.has(key));

      // inventory-contract: locale-key-completeness; classification: parity; reason: missing-key parity follows each locale's exact CLDR contract, not English-only plural suffixes or a catalog total
      assert.equal(
        missing.length,
        0,
        `${file} is missing ${missing.length} key(s): ${missing.slice(0, 10).join(', ')}${
          missing.length > 10 ? '…' : ''
        }`,
      );
    });
  }

  // The chokepoint strip shows these names on every dashboard. An English value
  // left in a catalogue renders as English to that locale's readers. Latin-script
  // locales may keep "Suez" or "Panama", but the descriptive names are English
  // phrases, and a non-Latin-script locale has no reason to show Latin text here.
  // flow.mbd is a unit and creditName names an EIA publication.
  const NON_LATIN_SCRIPT = new Set([
    'ar.json', 'bg.json', 'el.json', 'fa.json', 'hi.json', 'ja.json', 'ko.json',
    'ru.json', 'th.json', 'uk.json', 'zh-TW.json', 'zh.json',
  ]);
  const enStrip = flatten(en.components.chokepointStrip);
  for (const file of localeFiles) {
    it(`${file} translates the chokepoint strip names instead of copying English`, () => {
      const locale = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8'));
      const strip = flatten(locale.components.chokepointStrip);
      for (const key of ['shortName.bosphorus', 'shortName.doverStrait']) {
        assert.notEqual(strip[key], enStrip[key], `${file} chokepointStrip.${key} is still English`);
      }
      if (!NON_LATIN_SCRIPT.has(file)) return;
      const copied = Object.keys(enStrip).filter((key) =>
        key !== 'flow.mbd' && key !== 'attribution.creditName' && strip[key] === enStrip[key]);
      assert.deepEqual(copied, [], `${file} chokepointStrip keys still English: ${copied.join(', ')}`);
      for (const [key, value] of Object.entries(strip)) {
        if (key.startsWith('shortName.')) {
          assert.doesNotMatch(value, /[A-Za-z]/, `${file} chokepointStrip.${key} shows Latin text: ${value}`);
        }
      }
    });
  }

  for (const file of ['en.json', ...localeFiles]) {
    it(`${file} names omitted countries in the partial assessment copy toast`, () => {
      const locale = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8'));
      for (const placeholder of ['{{count}}', '{{max}}', '{{omitted}}']) {
        assert.ok(locale.focus.draftCopiedPartial.includes(placeholder), `${file} is missing ${placeholder}`);
      }
    });
  }

  // Confirmed in the #10561 review. These are the sentences whose machine
  // translation changed the meaning or did not parse. #10580 already renamed
  // the button to "Trip assessment"; that label is not pinned here.
  const CONFIRMED_FOCUS_COPY = {
    'sw.json': {
      datesHint: 'Kwa safari au kazi. Dirisha linapoisha, lengo linabaki na upau unasema hivyo.',
      neighboursHint: 'Hatari huvuka mipaka. Jirani huwekwa alama hivyo, na hawahesabiwi kwenye kikomo cha {{max}}.',
      draftAssessmentAria: 'Fungua tathmini ya safari, iliyojazwa mapema kwa lengo hili',
      'filter.emptyHint': 'Mengine yote yamehesabiwa hapo juu.',
      'filter.emptyAdvisories': 'Hakuna maonyo ya kusafiri kwa nchi hizi',
      'filter.emptyConflictPartial': 'Hakuna matukio ya mgogoro kwa nchi hizi kati ya matukio ya hivi karibuni. Orodha kamili haijapakiwa.',
      'filter.emptyAirports': 'Hakuna hata kimoja kati ya viwanja vya ndege unavyofuatilia kilicho katika nchi hizi',
      'filter.emptyFlights': 'Hakuna ndege zinazoingia au zinazotoka nchi hizi kwenye bodi hii',
      'filter.emptyAviationNews': 'Hakuna habari za usafiri wa anga kwa nchi hizi katika saa 24 zilizopita',
      'filter.emptyDisplacement': 'Hakuna data ya uhamishaji kwa nchi hizi',
      'filter.emptyCorrelation': 'Hakuna ishara kwa nchi hizi',
    },
    'nl.json': {
      gateSignedOutDesc: 'Meld u aan om een dashboardtabblad te richten op de landen waar u verslag van doet.',
      neighboursHint: 'Risico\'s stoppen niet bij grenzen. Buren zijn als zodanig gemarkeerd en tellen niet mee voor het maximum van {{max}}.',
      draftAssessmentAria: 'Open de reisbeoordeling, vooraf ingevuld met deze focus',
      'filter.emptyHint': 'Al het overige is hierboven meegeteld.',
      'filter.emptyAviationNews': 'Geen luchtvaartnieuws voor deze landen in de afgelopen 24 uur',
      'filter.emptyRadiation': 'Geen stralingsmetingen voor deze landen',
      'filter.emptyDisplacement': 'Geen gegevens over ontheemding voor deze landen',
    },
    'zh.json': {
      datesHint: '用于行程或任务。时间窗口结束后，聚焦保持不变，聚焦栏会注明窗口已结束。',
      draftAssessmentAria: '打开行程评估，并以此聚焦预先填好',
      'filter.tabNotFiltered': '此标签页未按国家筛选',
    },
    'zh-TW.json': {
      datesHint: '用於行程或任務。時間視窗結束後，聚焦保持不變，聚焦欄會註明視窗已結束。',
      draftAssessmentAria: '開啟行程評估，並以此聚焦預先填好',
      'filter.tabNotFiltered': '此標籤頁未按國家篩選',
    },
  };

  for (const [file, expected] of Object.entries(CONFIRMED_FOCUS_COPY)) {
    it(`${file} keeps the confirmed focus copy`, () => {
      const focus = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8')).focus;
      const flat = flatten(focus);
      for (const [key, value] of Object.entries(expected)) {
        assert.equal(flat[key], value, `${file} focus.${key}`);
      }
    });
  }

  for (const file of ['en.json', ...localeFiles]) {
    it(`${file} discloses NWS, ECCC, and WMO SWIC coverage in the weather layer help, not the short label`, () => {
      const locale = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8'));
      const staleScope = STALE_WEATHER_SCOPE_BY_LOCALE[file];
      const label = locale.components.deckgl.layers.weatherAlerts;
      assert.equal(typeof label, 'string');
      assert.doesNotMatch(label, /[(（]|NWS|SWIC/, `${file} weatherAlerts label must stay short`);
      const values = [
        locale.components.deckgl.layerHelp.descriptions.weatherAlerts,
        locale.components.deckgl.layerHelp.descriptions.weatherAlertsMarket,
      ];

      for (const value of values) {
        assert.equal(typeof value, 'string');
        assert.match(value, /NWS/i, `${file} weather coverage copy must identify NWS`);
        assert.match(value, /ECCC/i, `${file} weather coverage copy must identify ECCC`);
        assert.match(value, /WMO|SWIC/i, `${file} weather coverage copy must identify WMO SWIC`);
        if (staleScope) {
          assert.doesNotMatch(
            value,
            staleScope,
            `${file} weather coverage copy must not retain the former US/Canada-only scope`,
          );
        }
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
        assert.match(value, /Canad|Kanad|Kanaď|Kanadá|كند|Канад|Καναδ|カナダ|캐나다|加拿大|कनाडा|แคนาดา|کانادا/i, `${file} canadaRoads copy must identify Canadian scope`);
        assert.doesNotMatch(value, /(Ontario|Онтарио|Онтаріо|Οντάριο|オンタリオ|온타리오|安大略|ออนแทรีโอ|ओंटारियो|أونتاريو|انتاریو)[\s\S]*(Alberta|Албер|Альбер|Άλμπερτα|アルバータ|앨버타|艾伯塔|亞伯達|อัลเบอร์ตา|अल्बर्टा|ألبرتا|آلبرتا)/i, `${file} canadaRoads copy must not claim only two provinces`);
      }
    });

    it(`${file} discloses the provincial scope for the canadaAlerts layer in its help, not the short label`, () => {
      const locale = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8'));
      const layer = locale.components.deckgl.layers.canadaAlerts;
      const help = locale.components.deckgl.layerHelp.descriptions.canadaAlerts;
      assert.equal(typeof layer, 'string');
      assert.equal(typeof help, 'string');
      assert.doesNotMatch(layer, /[(（]|AB \+ BC/, `${file} canadaAlerts layer label must stay short`);
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
        assert.match(value, /Canad|Kanad|Kanaď|Kanadá|كند|Канад|Καναδ|カナダ|캐나다|加拿大|कनाडा|แคนาดา|کانادا/i, `${file} canadaRoads copy must identify Canadian scope`);
        assert.doesNotMatch(value, /(Ontario|Онтарио|Онтаріо|Οντάριο|オンタリオ|온타리오|安大略|ออนแทรีโอ|ओंटारियो|أونتاريو|انتاریو)[\s\S]*(Alberta|Албер|Альбер|Άλμπερτα|アルバータ|앨버타|艾伯塔|亞伯達|อัลเบอร์ตา|अल्बर्टा|ألبرتا|آلبرتا)/i, `${file} canadaRoads copy must not claim only two provinces`);
      }
    });

    it(`${file} discloses the provincial scope for the canadaAlerts layer in its help, not the short label`, () => {
      const locale = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8'));
      const layer = locale.components.deckgl.layers.canadaAlerts;
      const help = locale.components.deckgl.layerHelp.descriptions.canadaAlerts;
      assert.equal(typeof layer, 'string');
      assert.equal(typeof help, 'string');
      assert.doesNotMatch(layer, /[(（]|AB \+ BC/, `${file} canadaAlerts layer label must stay short`);
      assert.match(help, /SaskAlert/i, `${file} canadaAlerts help must name SaskAlert`);
      assert.doesNotMatch(layer, /Alberta Emergency Alert only/i, `${file} canadaAlerts copy must not claim Alberta-only coverage`);
      assert.doesNotMatch(help, /Alberta Emergency Alert only/i, `${file} canadaAlerts copy must not claim Alberta-only coverage`);
    });
  }
});
