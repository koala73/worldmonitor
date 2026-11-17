import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { UI_LANGUAGES } from '../shared/ui-languages.js';
import { BRIEF_STRINGS } from '../shared/brief-strings.data.js';
import {
  BRIEF_STRING_KEYS,
  briefIntlLocale,
  briefPlural,
  briefT,
  formatBriefDate,
  greetingKey,
} from '../shared/brief-strings.js';

const BRANDS = ['WorldMonitor Brief', 'WorldMonitor', 'worldmonitor.app'];

function tokens(s) {
  return new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
}

function forms(value) {
  return typeof value === 'string' ? [value] : Object.values(value);
}

describe('brief string table', () => {
  it('covers all 28 UI languages with every key', () => {
    assert.equal(UI_LANGUAGES.length, 28);
    assert.deepEqual(Object.keys(BRIEF_STRINGS).sort(), [...UI_LANGUAGES].sort());
    for (const lang of UI_LANGUAGES) {
      assert.deepEqual(Object.keys(BRIEF_STRINGS[lang]).sort(), [...BRIEF_STRING_KEYS].sort(), lang);
      for (const key of BRIEF_STRING_KEYS) {
        for (const form of forms(BRIEF_STRINGS[lang][key])) {
          assert.ok(typeof form === 'string' && form.trim().length > 0, `${lang} ${key}`);
        }
      }
    }
  });

  it('plural entries carry exactly the CLDR categories for each language', () => {
    for (const lang of UI_LANGUAGES) {
      const cats = new Intl.PluralRules(briefIntlLocale(lang)).resolvedOptions().pluralCategories;
      for (const key of BRIEF_STRING_KEYS) {
        const en = BRIEF_STRINGS.en[key];
        const value = BRIEF_STRINGS[lang][key];
        assert.equal(typeof value, typeof en, `${lang} ${key} shape`);
        if (typeof value === 'object') {
          assert.deepEqual(Object.keys(value).sort(), [...cats].sort(), `${lang} ${key}`);
        }
      }
    }
  });

  it('keeps the English interpolation tokens', () => {
    for (const lang of UI_LANGUAGES) {
      for (const key of BRIEF_STRING_KEYS) {
        const en = BRIEF_STRINGS.en[key];
        const enOther = tokens(typeof en === 'string' ? en : en.other);
        const allowed = new Set(forms(en).flatMap((f) => [...tokens(f)]));
        const value = BRIEF_STRINGS[lang][key];
        const other = typeof value === 'string' ? value : value.other;
        for (const t of enOther) assert.ok(tokens(other).has(t), `${lang} ${key} lacks {${t}}`);
        for (const f of forms(value)) {
          for (const t of tokens(f)) assert.ok(allowed.has(t), `${lang} ${key} has unknown {${t}}`);
        }
      }
    }
  });

  it('keeps brand names byte-for-byte', () => {
    for (const lang of UI_LANGUAGES) {
      for (const key of BRIEF_STRING_KEYS) {
        const en = forms(BRIEF_STRINGS.en[key]).join(' ');
        const local = forms(BRIEF_STRINGS[lang][key]).join(' ');
        for (const brand of BRANDS) {
          if (en.includes(brand)) assert.ok(local.includes(brand), `${lang} ${key} lost ${brand}`);
        }
      }
    }
  });
});

describe('briefT / briefPlural', () => {
  it('interpolates and falls back to English for unknown languages', () => {
    assert.equal(briefT('en', 'mag.signalWindow', { date: '2026-11-17' }), 'Signal Window · 2026-11-17');
    assert.equal(briefT('fr', 'mag.share'), 'Partager');
    assert.equal(briefT('xx', 'mag.share'), 'Share');
    assert.equal(briefT(undefined, 'mag.share'), 'Share');
    assert.equal(briefT('fr', 'no.such.key'), 'no.such.key');
  });

  it('picks the Intl plural category and reproduces English', () => {
    assert.equal(briefPlural('en', 'mag.coverBlurb', 1), 'One thread that shaped the world today.');
    assert.equal(briefPlural('en', 'mag.coverBlurb', 4), '4 threads that shaped the world today.');
    assert.equal(briefPlural('en', 'teams.stories', 1), '1 story');
    assert.equal(briefPlural('ru', 'teams.stories', 2), '2 новости');
    assert.equal(briefPlural('ru', 'teams.stories', 5), '5 новостей');
    assert.equal(briefPlural('ja', 'teams.stories', 1), '1 件のニュース');
    assert.equal(briefPlural('xx', 'teams.stories', 3), '3 stories');
  });

  it('maps composer greetings to buckets', () => {
    assert.equal(greetingKey('Good morning.'), 'greeting.morning');
    assert.equal(greetingKey('Good afternoon.'), 'greeting.afternoon');
    assert.equal(greetingKey('Good evening.'), 'greeting.evening');
  });
});

describe('formatBriefDate', () => {
  const when = Date.UTC(2026, 10, 17, 9, 30);

  it('reproduces the English formats', () => {
    assert.equal(formatBriefDate('en', when, 'long'), '17 November 2026');
    assert.equal(formatBriefDate('en', when, 'short'), 'Nov 17');
    assert.equal(formatBriefDate('en', when, 'full'), 'November 17, 2026');
  });

  it('formats YYYY-MM-DD as a calendar date without a timezone shift', () => {
    assert.equal(formatBriefDate('en', '2026-11-17', 'long'), '17 November 2026');
    assert.equal(formatBriefDate('en', '2026-11-17', 'long', 'Pacific/Kiritimati'), '17 November 2026');
    assert.equal(formatBriefDate('en', '2026-11-17', 'long', 'Pacific/Pago_Pago'), '17 November 2026');
  });

  it('localizes month names and honours the time zone', () => {
    assert.equal(formatBriefDate('fr', when, 'long'), '17 novembre 2026');
    assert.match(formatBriefDate('zh', when, 'long'), /2026年11月17日/);
    assert.match(formatBriefDate('zh-TW', when, 'long'), /2026年11月17日/);
    assert.equal(formatBriefDate('en', Date.UTC(2026, 10, 17, 23), 'short', 'Asia/Tokyo'), 'Nov 18');
  });
});
