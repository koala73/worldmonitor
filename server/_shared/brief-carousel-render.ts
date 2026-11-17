/**
 * Brief carousel image renderer (Phase 8).
 *
 * Given a BriefEnvelope and a page index in {0, 1, 2}, builds a
 * Satori layout tree and hands it to @vercel/og's ImageResponse,
 * which rasterises to a 1200×630 PNG and returns a Response ready
 * to ship. The output is the standard OG size that Telegram /
 * Slack / Discord all preview well.
 *
 * Design choices:
 *  - @vercel/og wraps satori + resvg-wasm with Vercel-native
 *    bundling. Runs on Edge runtime. No native Node binding needed,
 *    no manual `includeFiles` trick in vercel.json. (Previous
 *    attempts: direct satori + @resvg/resvg-wasm hit edge-bundler
 *    asset-URL errors; direct satori + @resvg/resvg-js native
 *    binding hit FUNCTION_INVOCATION_FAILED because nft never
 *    traced the platform-conditional peer package. See PR history
 *    on #3174 / #3196 / #3204 / #3206 for the full arc.)
 *  - Page templates are simplified versions of the magazine's
 *    cover / threads / first-story pages. They are not pixel-matched
 *    — the carousel is a teaser, not a replacement for the HTML.
 *  - The renderer owns font loading + ImageResponse construction.
 *    The edge route layer owns HMAC verification + Redis lookup.
 */

import { ImageResponse } from '@vercel/og';
import { BRIEF_LOCALIZED_ENVELOPE_VERSION } from '../../shared/brief-envelope.js';
import { briefPlural, briefT, type BriefStringKey } from '../../shared/brief-strings.js';
import { truncateForDisplay } from '../../shared/brief-text.js';
import { RTL_UI_LANGUAGES, isUiLanguage, scriptClassFor } from '../../shared/ui-languages.js';

// RUNTIME DEPENDENCY on Google Fonts CDN via jsdelivr.
//
// Noto Serif Regular is fetched once per isolate, memoised, and
// passed into ImageResponse's `fonts` option. Satori parses
// ttf/otf/woff — NOT woff2 — so we pull the TTF-backed woff from
// @fontsource via jsdelivr (SIL Open Font License, public domain).
// Same pattern @vercel/og uses internally for its default font.
//
// Consequence: if jsdelivr is unreachable, loadFont() throws,
// renderCarouselImageResponse rethrows, the route returns 503
// no-store, Telegram's sendMediaGroup for that brief drops the
// whole carousel, and the next cron tick re-renders from a fresh
// isolate. Swap this fetch for a bundled base64 TTF if flakiness
// ever becomes a problem.
//
// RUNTIME DEPENDENCY on Google Fonts for text outside that Latin file
// (Latin Extended, Cyrillic, Greek, CJK, Devanagari, Thai, Arabic,
// arrows). loadCarouselFonts() fetches a `text=` subset per script
// family with a 5-second timeout and throws CarouselFontError on any
// failure, so the route returns 503 no-store instead of a PNG with
// missing glyphs. Because every drawn character is covered up front,
// @vercel/og's own dynamic fallback (no timeout, errors swallowed)
// never fetches.
const FONT_URL = 'https://cdn.jsdelivr.net/npm/@fontsource/noto-serif/files/noto-serif-latin-400-normal.woff';
let _fontCache: ArrayBuffer | null = null;

async function loadFont(): Promise<ArrayBuffer> {
  if (_fontCache) return _fontCache;
  try {
    const res = await fetch(FONT_URL, {
      signal: AbortSignal.timeout(5_000),
      headers: { 'User-Agent': 'worldmonitor-carousel/1.0' },
    });
    if (!res.ok) throw new Error(`font fetch ${res.status}`);
    _fontCache = await res.arrayBuffer();
    return _fontCache;
  } catch (err) {
    console.warn('[brief-carousel] font fetch failed:', (err as Error).message);
    throw err;
  }
}

// Code points the base Latin file draws (its cmap).
const BASE_COVERAGE: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x0000], [0x000A, 0x000A], [0x000D, 0x000D], [0x0020, 0x007E], [0x00A0, 0x00FF],
  [0x0131, 0x0131], [0x0152, 0x0153], [0x02BB, 0x02BC], [0x02C6, 0x02C6], [0x02DA, 0x02DA],
  [0x02DC, 0x02DC], [0x0300, 0x0301], [0x0303, 0x0304], [0x0308, 0x0309], [0x0323, 0x0323],
  [0x0329, 0x0329], [0x2002, 0x2002], [0x2009, 0x2009], [0x200B, 0x200B], [0x2013, 0x2014],
  [0x2018, 0x201A], [0x201C, 0x201E], [0x2022, 0x2022], [0x2026, 0x2026], [0x2032, 0x2033],
  [0x2039, 0x203A], [0x2044, 0x2044], [0x20AC, 0x20AC], [0x2122, 0x2122], [0x2212, 0x2212],
  [0xFEFF, 0xFEFF], [0xFFFD, 0xFFFD],
];

function baseCovers(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return BASE_COVERAGE.some(([lo, hi]) => cp >= lo && cp <= hi);
}

type ExtraFamily = { family: string; name: string; lang?: string };

const FAMILIES = {
  serif: { family: 'Noto+Serif', name: 'NotoSerifExt' },
  symbols: { family: 'Noto+Sans+Symbols', name: 'NotoSansSymbols' },
  sc: { family: 'Noto+Sans+SC', name: 'NotoSansSC', lang: 'zh-CN' },
  tc: { family: 'Noto+Sans+TC', name: 'NotoSansTC', lang: 'zh-TW' },
  jp: { family: 'Noto+Sans+JP', name: 'NotoSansJP', lang: 'ja-JP' },
  kr: { family: 'Noto+Sans+KR', name: 'NotoSansKR', lang: 'ko-KR' },
  devanagari: { family: 'Noto+Sans+Devanagari', name: 'NotoSansDevanagari' },
  thai: { family: 'Noto+Sans+Thai', name: 'NotoSansThai', lang: 'th-TH' },
  arabic: { family: 'Noto+Sans+Arabic', name: 'NotoSansArabic' },
} satisfies Record<string, ExtraFamily>;

function hanFamily(lang: string): ExtraFamily {
  if (lang === 'ja') return FAMILIES.jp;
  if (lang === 'ko') return FAMILIES.kr;
  if (lang === 'zh-TW') return FAMILIES.tc;
  return FAMILIES.sc;
}

/** The family that draws one character the base file cannot, or null when the base file covers it. */
function familyForChar(ch: string, lang: string): ExtraFamily | null {
  if (baseCovers(ch)) return null;
  const cp = ch.codePointAt(0)!;
  if ((cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0x3130 && cp <= 0x318f) || (cp >= 0xac00 && cp <= 0xd7af)) return FAMILIES.kr;
  if ((cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0x31f0 && cp <= 0x31ff) || (cp >= 0xff65 && cp <= 0xff9f)) return FAMILIES.jp;
  if ((cp >= 0x2e80 && cp <= 0x303f) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff)
    || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xffef)) return hanFamily(lang);
  if ((cp >= 0x0900 && cp <= 0x097f) || (cp >= 0xa8e0 && cp <= 0xa8ff)) return FAMILIES.devanagari;
  if (cp >= 0x0e00 && cp <= 0x0e7f) return FAMILIES.thai;
  if ((cp >= 0x0600 && cp <= 0x06ff) || (cp >= 0x0750 && cp <= 0x077f) || (cp >= 0x08a0 && cp <= 0x08ff)
    || (cp >= 0xfb50 && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff)) return FAMILIES.arabic;
  if (cp >= 0x2190 && cp <= 0x21ff) return FAMILIES.symbols;
  return FAMILIES.serif;
}

export class CarouselFontError extends Error {
  readonly family: string;
  constructor(family: string, message: string) {
    super(`carousel font ${family}: ${message}`);
    this.name = 'CarouselFontError';
    this.family = family;
  }
}

// Makes Google return TrueType (Satori cannot read WOFF2); same UA as @vercel/og's loader.
const GOOGLE_FONTS_UA = 'Mozilla/5.0 (Macintosh; U; Intel Mac OS X 10_6_8; de-at) AppleWebKit/533.21.1 (KHTML, like Gecko) Version/5.0.5 Safari/533.21.1';
const FONT_REQUEST_HEADERS = { 'User-Agent': GOOGLE_FONTS_UA, 'X-WM-Carousel': '1' };
const EXTRA_FONT_CACHE_MAX = 32;
const _extraFontCache = new Map<string, Promise<ArrayBuffer>>();

async function fetchGoogleSubset(family: string, chars: string): Promise<ArrayBuffer> {
  let css: string;
  try {
    const res = await fetch(`https://fonts.googleapis.com/css2?family=${family}&text=${encodeURIComponent(chars)}`, {
      signal: AbortSignal.timeout(5_000),
      headers: FONT_REQUEST_HEADERS,
    });
    if (!res.ok) throw new CarouselFontError(family, `css ${res.status}`);
    css = await res.text();
  } catch (err) {
    throw err instanceof CarouselFontError ? err : new CarouselFontError(family, (err as Error).message);
  }
  const src = css.match(/src: url\((.+?)\) format\('(?:opentype|truetype)'\)/)?.[1];
  if (!src) throw new CarouselFontError(family, 'no truetype src in css');
  try {
    const res = await fetch(src, { signal: AbortSignal.timeout(5_000), headers: FONT_REQUEST_HEADERS });
    if (!res.ok) throw new CarouselFontError(family, `font ${res.status}`);
    return await res.arrayBuffer();
  } catch (err) {
    throw err instanceof CarouselFontError ? err : new CarouselFontError(family, (err as Error).message);
  }
}

function loadGoogleSubset(family: string, chars: string): Promise<ArrayBuffer> {
  const key = `${family}|${chars}`;
  const hit = _extraFontCache.get(key);
  if (hit) return hit;
  const pending = fetchGoogleSubset(family, chars);
  _extraFontCache.set(key, pending);
  if (_extraFontCache.size > EXTRA_FONT_CACHE_MAX) _extraFontCache.delete(_extraFontCache.keys().next().value!);
  pending.catch(() => _extraFontCache.delete(key));
  return pending;
}

export type CarouselFont = { name: string; data: ArrayBuffer; weight: 400; style: 'normal'; lang?: string };

/** Fetches text-subset fonts for everything in `text` that the base font cannot draw. Throws CarouselFontError. */
export async function loadCarouselFonts(text: string[], lang: string): Promise<CarouselFont[]> {
  const byFamily = new Map<ExtraFamily, Set<string>>();
  for (const s of text) {
    // Layouts uppercase some rows, so the subset needs both cases.
    for (const ch of s + s.toUpperCase()) {
      const fam = familyForChar(ch, lang);
      if (!fam) continue;
      if (!byFamily.has(fam)) byFamily.set(fam, new Set());
      byFamily.get(fam)!.add(ch);
    }
  }
  return Promise.all([...byFamily].map(async ([fam, chars]) => {
    const data = await loadGoogleSubset(fam.family, [...chars].sort().join(''));
    return { name: fam.name, data, weight: 400 as const, style: 'normal' as const, ...(fam.lang ? { lang: fam.lang } : {}) };
  }));
}

// ── Colour palette (must match magazine's aesthetic) ───────────────────────

const COLORS = {
  ink: '#0a0a0a',
  bone: '#f2ede4',
  cream: '#f1e9d8',
  creamInk: '#1a1612',
  sienna: '#8b3a1f',
  paper: '#fafafa',
  paperInk: '#0a0a0a',
} as const;

// ── Layouts ────────────────────────────────────────────────────────────────

type Envelope = {
  version: number;
  lang?: string;
  issuedAt: number;
  data: {
    issue: string;
    dateLong: string;
    user?: { name?: string };
    digest: {
      greeting: string;
      lead: string;
      threads: Array<{ tag: string; teaser: string }>;
    };
    stories: Array<{
      category: string;
      country: string;
      threatLevel: string;
      headline: string;
      source: string;
    }>;
  };
};

/**
 * True when `sibling` is a localized brief the carousel does not draw: a
 * right-to-left language, until right-to-left renders are proven. The route
 * then renders the canonical English envelope. That image is the intended
 * output, so it is cached like any other.
 */
export function carouselKeepsEnglish(sibling: unknown): boolean {
  const lang = (sibling as { lang?: unknown } | null)?.lang;
  return isUiLanguage(lang) && RTL_UI_LANGUAGES.includes(lang as never);
}

/** Chrome language: only a v5 sibling carries `lang`; right-to-left languages stay English. */
function carouselLang(env: Envelope): string {
  if (env.version !== BRIEF_LOCALIZED_ENVELOPE_VERSION || typeof env.lang !== 'string') return 'en';
  return RTL_UI_LANGUAGES.includes(env.lang as never) ? 'en' : env.lang;
}

const HEADLINE_MAX = 160;
// Sized so the story page does not overflow at fontSize 64.
const CJK_HEADLINE_MAX = 80;

export type CarouselPage = 'cover' | 'threads' | 'story';

export function pageFromIndex(i: number): CarouselPage | null {
  if (i === 0) return 'cover';
  if (i === 1) return 'threads';
  if (i === 2) return 'story';
  return null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function buildCover(env: Envelope): any {
  const { data } = env;
  const lang = carouselLang(env);
  return {
    type: 'div',
    props: {
      style: {
        width: 1200, height: 630,
        backgroundColor: COLORS.ink,
        color: COLORS.bone,
        display: 'flex', flexDirection: 'column',
        padding: '60px 72px', fontFamily: 'NotoSerif',
      },
      children: [
        {
          type: 'div',
          props: {
            style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', opacity: 0.75, fontSize: 18, letterSpacing: '0.2em', textTransform: 'uppercase' },
            children: ['WORLDMONITOR', briefT(lang, 'carousel.issue', { issue: data.issue })],
          },
        },
        {
          type: 'div',
          props: {
            style: { flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' },
            children: [
              {
                type: 'div',
                props: {
                  style: { fontSize: 20, letterSpacing: '0.3em', textTransform: 'uppercase', opacity: 0.7, marginBottom: 32 },
                  children: data.dateLong,
                },
              },
              {
                type: 'div',
                props: {
                  style: { fontSize: 140, lineHeight: 0.92, fontWeight: 900, letterSpacing: '-0.02em' },
                  children: 'WorldMonitor',
                },
              },
              {
                type: 'div',
                props: {
                  style: { fontSize: 140, lineHeight: 0.92, fontWeight: 900, letterSpacing: '-0.02em', marginBottom: 36 },
                  children: 'Brief.',
                },
              },
              {
                type: 'div',
                props: {
                  style: { fontSize: 28, fontStyle: 'italic', opacity: 0.8, maxWidth: 900 },
                  children: briefPlural(lang, 'carousel.threadsLine', data.stories.length),
                },
              },
            ],
          },
        },
        {
          type: 'div',
          props: {
            style: { display: 'flex', justifyContent: 'space-between', opacity: 0.6, fontSize: 16, letterSpacing: '0.2em', textTransform: 'uppercase' },
            children: [data.digest.greeting, briefT(lang, 'carousel.openFull')],
          },
        },
      ],
    },
  };
}

function buildThreads(env: Envelope): any {
  const { data } = env;
  const lang = carouselLang(env);
  const threads = data.digest.threads.slice(0, 5);
  return {
    type: 'div',
    props: {
      style: {
        width: 1200, height: 630,
        backgroundColor: COLORS.cream,
        color: COLORS.creamInk,
        display: 'flex', flexDirection: 'column',
        padding: '60px 72px', fontFamily: 'NotoSerif',
      },
      children: [
        {
          type: 'div',
          props: {
            style: { display: 'flex', justifyContent: 'space-between', borderBottom: `1px solid ${COLORS.sienna}40`, paddingBottom: 14, fontSize: 16, letterSpacing: '0.2em', textTransform: 'uppercase', color: COLORS.sienna, fontWeight: 600 },
            children: [`· WorldMonitor Brief · ${data.issue} ·`, briefT(lang, 'carousel.digestOnDesk')],
          },
        },
        {
          type: 'div',
          props: {
            style: { flex: 1, display: 'flex', flexDirection: 'column', paddingTop: 40 },
            children: [
              {
                type: 'div',
                props: {
                  style: { color: COLORS.sienna, fontSize: 20, letterSpacing: '0.3em', textTransform: 'uppercase', marginBottom: 30 },
                  children: briefT(lang, 'carousel.todaysThreads'),
                },
              },
              {
                type: 'div',
                props: {
                  style: { fontSize: 80, lineHeight: 1.0, fontWeight: 900, letterSpacing: '-0.015em', marginBottom: 50, maxWidth: 1000 },
                  children: briefT(lang, 'mag.deskWatching'),
                },
              },
              {
                type: 'div',
                props: {
                  style: { display: 'flex', flexDirection: 'column', gap: 20 },
                  children: threads.map((t) => ({
                    type: 'div',
                    props: {
                      style: { display: 'flex', alignItems: 'baseline', gap: 16, fontSize: 26, lineHeight: 1.3 },
                      children: [
                        {
                          type: 'div',
                          props: {
                            style: { color: COLORS.sienna, fontSize: 18, fontWeight: 600, letterSpacing: '0.2em', textTransform: 'uppercase', flexShrink: 0 },
                            children: `${t.tag} —`,
                          },
                        },
                        {
                          type: 'div',
                          props: { style: { flex: 1 }, children: t.teaser },
                        },
                      ],
                    },
                  })),
                },
              },
            ],
          },
        },
      ],
    },
  };
}

function buildStory(env: Envelope): any {
  const { data } = env;
  const lang = carouselLang(env);
  const story = data.stories[0];
  if (!story) return buildCover(env);
  return {
    type: 'div',
    props: {
      style: {
        width: 1200, height: 630,
        backgroundColor: COLORS.paper,
        color: COLORS.paperInk,
        display: 'flex',
        padding: '60px 72px', fontFamily: 'NotoSerif',
      },
      children: [
        {
          type: 'div',
          props: {
            style: { flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', position: 'relative' },
            children: [
              {
                type: 'div',
                props: {
                  style: { display: 'flex', gap: 14, marginBottom: 36 },
                  children: [
                    {
                      type: 'div',
                      props: {
                        style: { border: `1px solid ${COLORS.paperInk}`, padding: '8px 16px', fontSize: 16, letterSpacing: '0.22em', textTransform: 'uppercase', fontWeight: 600 },
                        children: story.category,
                      },
                    },
                    {
                      type: 'div',
                      props: {
                        style: { border: `1px solid ${COLORS.paperInk}`, padding: '8px 16px', fontSize: 16, letterSpacing: '0.22em', textTransform: 'uppercase', fontWeight: 600 },
                        children: story.country,
                      },
                    },
                    {
                      type: 'div',
                      props: {
                        style: { backgroundColor: COLORS.paperInk, color: COLORS.paper, padding: '8px 16px', fontSize: 16, letterSpacing: '0.22em', textTransform: 'uppercase', fontWeight: 600 },
                        children: lang === 'en' ? story.threatLevel : briefT(lang, `threat.${story.threatLevel}` as BriefStringKey),
                      },
                    },
                  ],
                },
              },
              {
                type: 'div',
                props: {
                  style: { fontSize: 64, lineHeight: 1.02, fontWeight: 900, letterSpacing: '-0.02em', marginBottom: 36, maxWidth: 900 },
                  children: truncateForDisplay(story.headline, scriptClassFor(lang) === 'cjk' ? CJK_HEADLINE_MAX : HEADLINE_MAX, lang),
                },
              },
              {
                type: 'div',
                props: {
                  style: { fontSize: 20, letterSpacing: '0.2em', textTransform: 'uppercase', opacity: 0.6 },
                  children: `${briefT(lang, 'mag.source')} · ${story.source}`,
                },
              },
            ],
          },
        },
      ],
    },
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Render a single page of the carousel into an ImageResponse.
 * Throws on structurally unusable envelope OR font-fetch failure —
 * callers (the edge route) should catch + return 503 no-store so
 * Vercel's CDN + Telegram's media fetcher don't pin a bad render.
 */
/** The Satori element tree for one carousel page. Exported for tests. */
export function buildCarouselTree(envelope: Envelope, page: CarouselPage): any {
  const tree = page === 'cover' ? buildCover(envelope) : page === 'threads' ? buildThreads(envelope) : buildStory(envelope);
  // Tracking, forced uppercase and italic suit Latin, Cyrillic and Greek only.
  const lang = carouselLang(envelope);
  if (!SPACED_SCRIPTS.has(scriptClassFor(lang))) stripLatinTypography(tree);
  if (scriptClassFor(lang) === 'thai') mapText(tree, (t) => markWordBreaks(t, lang));
  return tree;
}

// Satori breaks lines only at spaces and CJK characters; Thai has neither
// between words, so mark word boundaries with U+200B.
function markWordBreaks(text: string, lang: string): string {
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') return text;
  return Array.from(new Intl.Segmenter(lang, { granularity: 'word' }).segment(text), (s) => s.segment).join('\u200B');
}

function mapText(node: any, fn: (text: string) => string): void {
  const children = node?.props?.children;
  if (typeof children === 'string') node.props.children = fn(children);
  else if (Array.isArray(children)) node.props.children = children.map((c: any) => (typeof c === 'string' ? fn(c) : (mapText(c, fn), c)));
  else if (children && typeof children === 'object') mapText(children, fn);
}

const SPACED_SCRIPTS = new Set(['latin', 'cyrillic', 'greek']);

function stripLatinTypography(node: any): void {
  if (!node || typeof node !== 'object') return;
  const style = node.props?.style;
  if (style) {
    delete style.letterSpacing;
    delete style.textTransform;
    if (style.fontStyle === 'italic') delete style.fontStyle;
  }
  const children = node.props?.children;
  if (Array.isArray(children)) children.forEach(stripLatinTypography);
  else stripLatinTypography(children);
}

function collectText(node: any, out: string[]): string[] {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) node.forEach((n) => collectText(n, out));
  else if (node && typeof node === 'object') collectText(node.props?.children, out);
  return out;
}

/** Strings the given page will draw, in draw order. Exported for tests. */
export function carouselPageText(envelope: Envelope, page: CarouselPage): string[] {
  return collectText(buildCarouselTree(envelope, page), []);
}

export async function renderCarouselImageResponse(
  envelope: Envelope,
  page: CarouselPage,
  extraHeaders: Record<string, string> = {},
): Promise<ImageResponse> {
  if (!envelope?.data) throw new Error('invalid envelope');

  const tree = buildCarouselTree(envelope, page);
  const [fontData, extraFonts] = await Promise.all([
    loadFont(),
    loadCarouselFonts(collectText(tree, []), carouselLang(envelope)),
  ]);
  tree.props.style.fontFamily = ['NotoSerif', ...extraFonts.map((f) => f.name)].join(', ');

  return new ImageResponse(tree, {
    width: 1200,
    height: 630,
    fonts: [
      // Satori approximates bold by stroking wider when fontWeight
      // >= 700 is declared without a matching face. Good enough for
      // a teaser card; a second @font-face isn't worth the bundle
      // and cold-start cost.
      { name: 'NotoSerif', data: fontData, weight: 400, style: 'normal' },
      ...extraFonts,
    ],
    headers: extraHeaders,
  });
}
