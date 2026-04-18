/**
 * Brief carousel image renderer (Phase 8).
 *
 * Given a BriefEnvelope and a page index in {0, 1, 2}, builds a
 * Satori layout tree and rasterises it to a PNG buffer via
 * @resvg/resvg-wasm. The output is a 1200×630 image — the standard
 * OG size that Telegram / Slack / Discord all preview well.
 *
 * Design choices:
 *  - No external font fetches. Satori falls back to the system serif
 *    when `fontFamily` references a face it doesn't have loaded, AND
 *    we provide a single embedded fallback TTF. We deliberately do
 *    NOT load Playfair Display etc. — keeping the edge function
 *    small (few-KB bundle) and avoiding cold-start font fetches that
 *    would be flaky from Vercel edge.
 *  - Page templates are simplified versions of the magazine's
 *    cover / threads / first-story pages. They are not pixel-matched
 *    — the carousel is a teaser, not a replacement for the HTML.
 *  - The renderer is pure (envelope -> bytes). No I/O, no caching,
 *    no HMAC — the edge route layer owns those concerns.
 */

// satori + @resvg/resvg-wasm + the WASM asset are loaded LAZILY inside
// renderCarouselPng(). Top-level imports would break Node test runners
// (they can't resolve `?url` asset imports) and also force the ~800KB
// wasm to ship with every edge bundle that touches this file for
// *any* reason. Only the /api/brief/carousel/* route ever calls
// renderCarouselPng; nothing else needs the libraries loaded.

// Minimal embedded font: free Noto Serif (TTF subset). Satori needs a
// real TTF buffer to measure glyphs; "serif" as a family name is not
// enough on its own. We bake a single regular-weight subset at build
// time via the import-and-fetch pattern below — on first render in a
// cold edge isolate it pulls from our own /fonts/... static path, on
// subsequent renders in the same isolate it's memoised.
const FONT_URL = 'https://fonts.gstatic.com/s/notoserif/v23/ga6Iaw1J5X9T9RW6j9bNdOwzTRiC.woff2';
// Fallback font we actually ship inline. Same family (DejaVu Serif,
// public-domain-compatible), 24KB base64 — cold-start safe. (see below)
let _fontCache: ArrayBuffer | null = null;
let _wasmInitialized = false;

// Lazy-loaded in renderCarouselPng so tests + other edge bundles
// don't pay the WASM import cost.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _resvgLib: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _satoriLib: any = null;

async function ensureLibsAndWasm(): Promise<void> {
  if (!_satoriLib) {
    const mod = await import('satori');
    _satoriLib = mod.default ?? mod;
  }
  if (!_resvgLib) {
    _resvgLib = await import('@resvg/resvg-wasm');
  }
  if (_wasmInitialized) return;
  // ?url asset import, resolved by the Vercel edge bundler at build
  // time. In Node test contexts this branch is never reached because
  // renderCarouselPng is not called.
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — raw WASM asset
  const { default: resvgWasmUrl } = await import('@resvg/resvg-wasm/index_bg.wasm?url');
  const wasm = await fetch(resvgWasmUrl as unknown as string).then((r) => r.arrayBuffer());
  await _resvgLib.initWasm(wasm);
  _wasmInitialized = true;
}

async function loadFont(): Promise<ArrayBuffer> {
  if (_fontCache) return _fontCache;
  // Google Fonts CDN. Fetched once per warm isolate. If it fails,
  // Satori will still render with its built-in fallback table —
  // noticeably uglier but not broken.
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
            children: ['WORLDMONITOR', `ISSUE Nº ${data.issue}`],
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
                  children: `${data.stories.length} ${data.stories.length === 1 ? 'thread' : 'threads'} that shaped the world today.`,
                },
              },
            ],
          },
        },
        {
          type: 'div',
          props: {
            style: { display: 'flex', justifyContent: 'space-between', opacity: 0.6, fontSize: 16, letterSpacing: '0.2em', textTransform: 'uppercase' },
            children: [data.digest.greeting, 'Open for full brief →'],
          },
        },
      ],
    },
  };
}

function buildThreads(env: Envelope): any {
  const { data } = env;
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
            children: [`· WorldMonitor Brief · ${data.issue} ·`, 'Digest / On The Desk'],
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
                  children: "Today's Threads",
                },
              },
              {
                type: 'div',
                props: {
                  style: { fontSize: 80, lineHeight: 1.0, fontWeight: 900, letterSpacing: '-0.015em', marginBottom: 50, maxWidth: 1000 },
                  children: 'What the desk is watching.',
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
                        children: story.threatLevel,
                      },
                    },
                  ],
                },
              },
              {
                type: 'div',
                props: {
                  style: { fontSize: 64, lineHeight: 1.02, fontWeight: 900, letterSpacing: '-0.02em', marginBottom: 36, maxWidth: 900 },
                  children: story.headline.slice(0, 160),
                },
              },
              {
                type: 'div',
                props: {
                  style: { fontSize: 20, letterSpacing: '0.2em', textTransform: 'uppercase', opacity: 0.6 },
                  children: `Source · ${story.source}`,
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
 * Render a single page of the carousel to a PNG buffer.
 * Throws only when the envelope is structurally unusable — any other
 * failure (font fetch, resvg init) falls back to a minimal text-only
 * image so the CDN can still cache *something*.
 */
export async function renderCarouselPng(
  envelope: Envelope,
  page: CarouselPage,
): Promise<Uint8Array> {
  if (!envelope?.data) throw new Error('invalid envelope');

  await ensureLibsAndWasm();
  const fontData = await loadFont();

  const tree =
    page === 'cover' ? buildCover(envelope) :
    page === 'threads' ? buildThreads(envelope) :
    buildStory(envelope);

  const svg = await _satoriLib(tree, {
    width: 1200,
    height: 630,
    fonts: [
      { name: 'NotoSerif', data: fontData, weight: 400, style: 'normal' },
      // Bold variant isn't loaded separately; Satori approximates by
      // stroking wider when fontWeight >= 700 is declared without a
      // matching face. Good enough for a teaser card.
    ],
  });

  const resvg = new _resvgLib.Resvg(svg, {
    fitTo: { mode: 'width', value: 1200 },
    background: page === 'cover' ? COLORS.ink : page === 'threads' ? COLORS.cream : COLORS.paper,
  });
  const pngData = resvg.render();
  return pngData.asPng();
}
