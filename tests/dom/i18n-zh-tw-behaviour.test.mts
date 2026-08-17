/**
 * Follow-up 5 from the #6561 review — the behavioural half of the zh-TW work
 * had no test.
 *
 * `tests/i18n-language-tag-resolution.test.mts` covers `resolveLanguageTag`,
 * which is the resolver BENEATH these call sites, not the call sites
 * themselves. Nothing asserted what a Traditional reader actually receives from
 * the places that read the resolved tag: how dates and numbers format
 * (`getLocale`), what a relative timestamp says (`formatTime`), and which entry
 * the language picker marks as selected. Two more callers move onto the same
 * accessor in this PR — `Intl.DisplayNames` country names in the command
 * palette, which also memoises on the tag — so they are covered here too.
 *
 * This needs the Vite pipeline rather than `node --test`: `@/services/i18n`
 * evaluates `import.meta.glob` at load. The switchable Chinese harness lives
 * next to the English one in `tests/dom/helpers/i18n.mts`, since every
 * assertion here is a COMPARISON between the two catalogues.
 *
 * The Simplified rows are the ones that fail if the accessor swap goes too far
 * — every one of these fixes is wrong in the other direction as well.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { getAllCommands } from '@/config/commands';
import { getCurrentLanguage, getCurrentLanguageTag, getLocale } from '@/services/i18n';
import { renderPreferences } from '@/services/preferences-content';
import { formatTime } from '@/utils';
import { getLocalizedNameExpression } from '@/utils/map-locale';

import { useChineseCatalogue as useLanguage } from './helpers/i18n.mts';

beforeAll(async () => {
  await useLanguage('zh-TW');
});

describe('the accessors themselves', () => {
  it('keeps the script in the tag and drops it from the feed language', async () => {
    await useLanguage('zh-TW');
    // Both are correct answers to different questions: a Traditional reader
    // wants Traditional UI, and the same Chinese-language feeds as everyone
    // else. That is why both accessors exist and why each caller has to pick.
    expect(getCurrentLanguageTag()).toBe('zh-TW');
    expect(getCurrentLanguage()).toBe('zh');
  });
});

describe('getLocale — date and number formatting', () => {
  it('returns zh-TW rather than collapsing to the zh-CN default', async () => {
    await useLanguage('zh-TW');
    expect(getLocale()).toBe('zh-TW');

    await useLanguage('zh');
    expect(getLocale()).toBe('zh-CN');
  });

  it('produces Taiwanese conventions where the two locales differ', async () => {
    await useLanguage('zh-TW');
    const traditional = {
      time: new Intl.DateTimeFormat(getLocale(), { timeStyle: 'short', timeZone: 'UTC' })
        .format(new Date('2026-08-14T17:30:00Z')),
      speed: new Intl.NumberFormat(getLocale(), { style: 'unit', unit: 'kilometer-per-hour' }).format(50),
      compact: new Intl.NumberFormat(getLocale(), { notation: 'compact' }).format(12_345_678),
    };

    await useLanguage('zh');
    const simplified = {
      time: new Intl.DateTimeFormat(getLocale(), { timeStyle: 'short', timeZone: 'UTC' })
        .format(new Date('2026-08-14T17:30:00Z')),
      speed: new Intl.NumberFormat(getLocale(), { style: 'unit', unit: 'kilometer-per-hour' }).format(50),
      compact: new Intl.NumberFormat(getLocale(), { notation: 'compact' }).format(12_345_678),
    };

    // 12-hour clock, spelled-out units and the Traditional 萬 — none of which
    // a `zh-CN` locale produces.
    expect(traditional.time).toContain('下午');
    expect(traditional.speed).toBe('50 公里/小時');
    expect(traditional.compact).toContain('萬');

    expect(simplified.time).not.toContain('下午');
    expect(simplified.speed).toBe('50 km/h');
    expect(simplified.compact).toContain('万');
  });
});

describe('formatTime — relative timestamps on every news item', () => {
  const minutesAgo = (n: number): Date => new Date(Date.now() - n * 60_000);

  it('renders Traditional characters for a Traditional reader', async () => {
    await useLanguage('zh-TW');
    expect(formatTime(minutesAgo(3))).toBe('3 分鐘前');
    expect(formatTime(minutesAgo(60 * 2))).toBe('2 小時前');
    expect(formatTime(minutesAgo(60 * 24 * 5))).toBe('5 天前');
  });

  it('leaves Simplified readers on Simplified', async () => {
    await useLanguage('zh');
    expect(formatTime(minutesAgo(3))).toBe('3分钟前');
    expect(formatTime(minutesAgo(60 * 2))).toBe('2小时前');
  });
});

describe('language picker — which entry is marked selected', () => {
  /**
   * The marked options, read as attributes.
   *
   * Not `select.value` / `selectedOptions`: happy-dom does not derive
   * selectedness from the `selected` attribute when the markup arrives through
   * innerHTML — measured here, it reports the SECOND option as selected while
   * the attribute sits on `zh-TW`. The attribute is what a real browser reads,
   * and it is what this renderer actually decides, so assert that directly.
   */
  function markedOptions(): Array<{ value: string; label: string }> {
    document.body.innerHTML = renderPreferences({ isDesktopApp: false }).html;
    const select = document.querySelector<HTMLSelectElement>('#us-language');
    if (!select) throw new Error('language select missing from preferences markup');

    return [...select.querySelectorAll('option[selected]')].map((option) => ({
      value: option.getAttribute('value') ?? '',
      label: option.textContent ?? '',
    }));
  }

  it('marks 繁體中文 for a Traditional reader', async () => {
    await useLanguage('zh-TW');
    const marked = markedOptions();

    expect(marked).toHaveLength(1);
    expect(marked[0]?.value).toBe('zh-TW');
    expect(marked[0]?.label).toContain('繁體中文');
  });

  it('marks 简体中文 for a Simplified reader', async () => {
    await useLanguage('zh');
    const marked = markedOptions();

    expect(marked).toHaveLength(1);
    expect(marked[0]?.value).toBe('zh');
    expect(marked[0]?.label).toContain('简体中文');
  });
});

describe('command palette country names', () => {
  function countryLabel(code: string): string {
    const command = getAllCommands().find((cmd) => cmd.id === `country:${code}`);
    if (!command) throw new Error(`country command missing for ${code}`);
    return command.label;
  }

  // 美国/美國 is a character difference; 韩国/南韓 is a different word, so a
  // converter run over the catalogue would not have caught it either.
  it('builds Traditional names from the full tag', async () => {
    await useLanguage('zh-TW');
    expect(countryLabel('US')).toBe('美國');
    expect(countryLabel('KR')).toBe('南韓');
  });

  it('rebuilds when the script changes — the memo key moved with the accessor', async () => {
    // Order matters: zh-TW is built first (above), so a memo still keyed on the
    // stripped `zh` would answer this from the Traditional cache.
    await useLanguage('zh');
    expect(countryLabel('US')).toBe('美国');
    expect(countryLabel('KR')).toBe('韩国');

    await useLanguage('zh-TW');
    expect(countryLabel('US')).toBe('美國');
  });
});

describe('map labels', () => {
  it('asks the tile source for the reader’s own script', async () => {
    await useLanguage('zh-TW');
    expect(getLocalizedNameExpression()).toEqual([
      'coalesce',
      ['get', 'name:zh-Hant'],
      ['get', 'name:zh'],
      ['get', 'name:en'],
      ['get', 'name'],
    ]);

    await useLanguage('zh');
    expect(getLocalizedNameExpression()).toEqual([
      'coalesce',
      ['get', 'name:zh-Hans'],
      ['get', 'name:zh'],
      ['get', 'name:en'],
      ['get', 'name'],
    ]);
  });
});
