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
 * Render a single page of the carousel into an ImageResponse.
 * Throws on structurally unusable envelope OR font-fetch failure —
 * callers (the edge route) should catch + return 503 no-store so
 * Vercel's CDN + Telegram's media fetcher don't pin a bad render.
 */
export async function renderCarouselImageResponse(
  envelope: Envelope,
  page: CarouselPage,
  extraHeaders: Record<string, string> = {},
): Promise<ImageResponse> {
  if (!envelope?.data) throw new Error('invalid envelope');

  const fontData = await loadFont();

  const tree =
    page === 'cover' ? buildCover(envelope) :
    page === 'threads' ? buildThreads(envelope) :
    buildStory(envelope);

  return new ImageResponse(tree, {
    width: 1200,
    height: 630,
    fonts: [
      // Satori approximates bold by stroking wider when fontWeight
      // >= 700 is declared without a matching face. Good enough for
      // a teaser card; a second @font-face isn't worth the bundle
      // and cold-start cost.
      { name: 'NotoSerif', data: fontData, weight: 400, style: 'normal' },
    ],
    headers: extraHeaders,
  });
}
