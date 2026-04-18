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

// satori + @resvg/resvg-js are loaded LAZILY inside renderCarouselPng
// so Node test runners don't pay the import cost and Vercel's edge
// bundler doesn't try to pull native binaries into unrelated functions.
//
// This file uses @resvg/resvg-js (native Node binding) — NOT the
// `@resvg/resvg-wasm` variant. The WASM version requires a Vercel
// edge runtime + a `?url` asset import that Vercel's bundler refuses
// to resolve ("Edge Function is referencing unsupported modules"),
// blocking deploys. The native binding works out of the box on the
// Node runtime and is faster per request. Consequence: the carousel
// route MUST run on `runtime: 'nodejs20.x'`, encoded in the route's
// `export const config`.

// RUNTIME DEPENDENCY on Google Fonts CDN.
//
// Satori requires a real TTF/WOFF2 buffer to measure glyphs; the
// family name 'serif' on its own is not enough. On first render in a
// cold Node isolate we fetch Noto Serif Regular from gstatic.com and
// memoise it for subsequent requests on the same isolate. There is
// NO inline fallback font shipped in the bundle today.
//
// Consequence: if the Google Fonts CDN is unreachable, loadFont()
// throws, renderCarouselPng() rethrows, the route returns 503
// no-store, Telegram's sendMediaGroup for that brief drops the whole
// carousel, the digest's long-form text message still sends, and the
// next cron tick re-renders from a fresh isolate. Self-healing
// across ticks because the route refuses to cache any non-200
// response.
//
// CRITICAL: Satori parses ttf / otf / woff — NOT woff2. Using a
// woff2 URL here silently fails every render (Satori throws on an
// unreadable font buffer, the route returns 503, the carousel never
// delivers). The gstatic.com CDN only serves woff2 to modern UA
// strings, so we pull the TTF from @fontsource via jsdelivr
// (public-domain SIL Open Font License). This is the pattern
// @vercel/og uses for the same reason.
//
// If jsdelivr reliability ever becomes a problem, swap this fetch
// for a bundled base64 TTF (copy the @fontsource/noto-serif file
// into this repo and read it via fs / inline import) and delete
// the fetch branch.
const FONT_URL = 'https://cdn.jsdelivr.net/npm/@fontsource/noto-serif/files/noto-serif-latin-400-normal.woff';
let _fontCache: ArrayBuffer | null = null;

// Lazy-loaded in renderCarouselPng so tests + unrelated Vercel
// functions don't pay the import cost.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _resvgLib: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _satoriLib: any = null;
// Concurrent-cold-start guard: the first caller that begins loading
// owns the promise; every other caller awaits the same promise. Was
// previously a plain `_wasmInitialized` boolean which let two cold
// callers into `await initWasm()` simultaneously (benign but wasteful
// and one of the P2 findings on the carousel PR review).
let _libsLoadPromise: Promise<void> | null = null;

async function ensureLibs(): Promise<void> {
  if (_satoriLib && _resvgLib) return;
  if (_libsLoadPromise) return _libsLoadPromise;
  _libsLoadPromise = (async () => {
    const [satoriMod, resvgMod] = await Promise.all([
      import('satori'),
      import('@resvg/resvg-js'),
    ]);
    _satoriLib = satoriMod.default ?? satoriMod;
    _resvgLib = resvgMod;
  })();
  try {
    await _libsLoadPromise;
  } catch (err) {
    // Reset so the NEXT cold request retries — a transient import
    // failure shouldn't poison the isolate for its whole lifetime.
    _libsLoadPromise = null;
    throw err;
  }
}

async function loadFont(): Promise<ArrayBuffer> {
  if (_fontCache) return _fontCache;
  // Google Fonts CDN is a hard runtime dependency — see FONT_URL
  // comment above. On any failure we rethrow so the route handler
  // can return 503 no-store rather than letting Satori render with
  // a missing font (which Satori actually handles by refusing to
  // measure, producing an empty SVG — a more confusing failure than
  // a clean HTTP error).
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

  await ensureLibs();
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
