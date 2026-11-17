// Carousel images for localized briefs: owned font loading, script-aware
// typography, safe headline cuts, and no silent @vercel/og font fallback.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  CarouselFontError,
  buildCarouselTree,
  carouselPageText,
  loadCarouselFonts,
  renderCarouselImageResponse,
} from '../server/_shared/brief-carousel-render.ts';
import { CAROUSEL_FIXTURES } from './fixtures/brief-carousel-fonts/envelopes.mjs';
import { installFontStub } from './fixtures/brief-carousel-fonts/stub.mjs';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const PAGES = ['cover', 'threads', 'story'];
const allText = (env) => PAGES.flatMap((p) => carouselPageText(env, p));
const unique = (env, tag) => ({ ...env, data: { ...env.data, stories: [{ ...env.data.stories[0], headline: `${env.data.stories[0].headline} ${tag}` }] } });

function styles(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.props?.style) out.push(node.props.style);
  const c = node.props?.children;
  (Array.isArray(c) ? c : [c]).forEach((n) => styles(n, out));
  return out;
}

async function assertPng(res, label) {
  assert.equal(res.status, 200, label);
  const buf = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...buf.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], `${label}: PNG magic`);
  assert.ok(buf.byteLength > 5_000 && buf.byteLength < 500_000, `${label}: ${buf.byteLength} B`);
}

describe('carouselPageText', () => {
  it('lists every string each page draws', () => {
    const env = CAROUSEL_FIXTURES.en;
    const cover = carouselPageText(env, 'cover');
    for (const s of ['WORLDMONITOR', 'ISSUE Nº 27.05', '27 May 2026', 'WorldMonitor', 'Brief.', 'Good evening', 'Open for full brief']) assert.ok(cover.includes(s), `cover: ${s}`);
    const threads = carouselPageText(env, 'threads');
    for (const s of ['Energy —', env.data.digest.threads[0].teaser, "Today's Threads"]) assert.ok(threads.includes(s), `threads: ${s}`);
    const story = carouselPageText(env, 'story');
    for (const s of ['Energy', 'IR', 'high', env.data.stories[0].headline, 'Source · Reuters']) assert.ok(story.includes(s), `story: ${s}`);
  });
});

describe('loadCarouselFonts', () => {
  it('English and Latin-1 French request no font at all', async () => {
    // The "open" arrow is drawn as a vector, so the base Latin file covers the whole cover.
    for (const lang of ['en', 'fr']) {
      const log = installFontStub();
      const fonts = await loadCarouselFonts(allText(CAROUSEL_FIXTURES[lang]), lang);
      assert.deepEqual(log.loader, [], `${lang}: no extra font request`);
      assert.deepEqual(fonts, []);
      assert.ok(!allText(CAROUSEL_FIXTURES[lang]).join('').includes('→'), `${lang}: no arrow glyph in the drawn text`);
    }
  });

  it('Russian, Greek, Japanese, Hindi and Thai each request their mapped family once', async () => {
    const expected = { ru: 'Noto+Serif', el: 'Noto+Serif', ja: 'Noto+Sans+JP', hi: 'Noto+Sans+Devanagari', th: 'Noto+Sans+Thai', zh: 'Noto+Sans+SC', ko: 'Noto+Sans+KR' };
    for (const [lang, family] of Object.entries(expected)) {
      const log = installFontStub();
      const fonts = await loadCarouselFonts(allText(unique(CAROUSEL_FIXTURES[lang], `${lang}-once`)), lang);
      assert.equal(log.loader.filter((f) => f === family).length, 1, `${lang}: ${family} once`);
      assert.equal(new Set(log.loader).size, log.loader.length, `${lang}: no family twice`);
      const cjk = fonts.find((f) => f.name === family.replaceAll('+', ''));
      if (lang === 'ja') assert.equal(cjk.lang, 'ja-JP');
      if (lang === 'zh') assert.equal(cjk.lang, 'zh-CN');
    }
  });

  it('a failed or timed-out fetch throws CarouselFontError', async () => {
    installFontStub({ fail: 'Noto+Sans+JP' });
    await assert.rejects(loadCarouselFonts(['日本 fail'], 'ja'), (err) => err instanceof CarouselFontError && err.family === 'Noto+Sans+JP');
    installFontStub({ timeout: 'Noto+Sans+Thai' });
    await assert.rejects(loadCarouselFonts(['ไทย timeout'], 'th'), (err) => err instanceof CarouselFontError && /timed out/.test(err.message));
  });

  it('routes supplementary-plane Han to the language Han family', async () => {
    // U+20BB7 is a Japanese name character above U+FFFF.
    const log = installFontStub();
    await assert.rejects(loadCarouselFonts(['\u{20BB7}野家'], 'ja'), CarouselFontError);
    assert.ok(log.loader.includes('Noto+Sans+JP'), 'requested from the Japanese family');
    assert.ok(!log.loader.includes('Noto+Serif'), 'not from the Latin serif');
  });

  it('a downloaded subset that lacks a requested character throws CarouselFontError', async () => {
    // The fixture JP font is a subset of the fixture text, so U+20BB7 is absent:
    // the same as Google omitting a character the family does not have.
    installFontStub();
    await assert.rejects(
      loadCarouselFonts(['\u{20BB7}野家'], 'ja'),
      (err) => err instanceof CarouselFontError && err.family === 'Noto+Sans+JP' && /U\+20BB7/.test(err.message),
    );
    // Characters the subset has load normally.
    const fonts = await loadCarouselFonts(allText(CAROUSEL_FIXTURES.ja), 'ja');
    assert.ok(fonts.some((f) => f.name === 'NotoSansJP'));
  });
});

describe('localized carousel renders', () => {
  const RENDER_TIMEOUT = 60_000;

  it('each fixture language renders to a valid PNG and the vendored fallback fetches no font', { timeout: RENDER_TIMEOUT }, async () => {
    const log = installFontStub();
    for (const [lang, env] of Object.entries(CAROUSEL_FIXTURES)) {
      const pages = lang === 'en' || lang === 'ja' ? PAGES : ['story'];
      for (const page of pages) await assertPng(await renderCarouselImageResponse(env, page), `${lang}/${page}`);
    }
    assert.deepEqual(log.vendored, [], 'every drawn character must be covered before Satori asks @vercel/og');
  });

  it('non-Latin scripts drop letter-spacing, uppercase and italic from the element tree', () => {
    for (const lang of ['ja', 'zh', 'ko', 'hi', 'th']) {
      for (const page of PAGES) {
        const all = styles(buildCarouselTree(CAROUSEL_FIXTURES[lang], page));
        assert.ok(all.every((s) => !('letterSpacing' in s) && !('textTransform' in s) && s.fontStyle !== 'italic'), `${lang}/${page}`);
      }
    }
    for (const lang of ['en', 'ru', 'el']) {
      const all = styles(buildCarouselTree(CAROUSEL_FIXTURES[lang], 'cover'));
      assert.ok(all.some((s) => s.textTransform === 'uppercase') && all.some((s) => s.fontStyle === 'italic'), `${lang} keeps Latin typography`);
    }
  });

  it('Thai text carries word-break marks so Satori can wrap it', () => {
    const story = carouselPageText(CAROUSEL_FIXTURES.th, 'story');
    assert.ok(story.some((s) => s.includes('\u200B')));
    assert.ok(!carouselPageText(CAROUSEL_FIXTURES.ja, 'story').some((s) => s.includes('\u200B')));
  });

  it('the story headline is cut with truncateForDisplay and never splits a character', () => {
    const ja = CAROUSEL_FIXTURES.ja;
    const longJa = { ...ja, data: { ...ja.data, stories: [{ ...ja.data.stories[0], headline: ja.data.stories[0].headline.repeat(3) }] } };
    const jaHeadline = carouselPageText(longJa, 'story')[3];
    assert.ok(jaHeadline.endsWith('…'));
    assert.ok([...new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(jaHeadline)].length <= 80);
    const emoji = { ...CAROUSEL_FIXTURES.en, data: { ...CAROUSEL_FIXTURES.en.data, stories: [{ ...CAROUSEL_FIXTURES.en.data.stories[0], headline: '🇮🇷'.repeat(200) }] } };
    const cut = carouselPageText(emoji, 'story')[3];
    assert.ok(cut.endsWith('…'));
    assert.equal(cut.slice(0, -1).length % 4, 0, 'flag emoji are never split');
    assert.equal(carouselPageText(CAROUSEL_FIXTURES.en, 'story')[3], CAROUSEL_FIXTURES.en.data.stories[0].headline);
  });
});
