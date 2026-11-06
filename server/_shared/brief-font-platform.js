// Which brief font file set a browser gets. Google Fonts serves the same families as different
// files depending on the User-Agent, and each renders slightly differently, so the brief picks the
// set Google would have sent and keeps every platform's rendering unchanged:
//
//   plain        Android and iOS (any browser): no hinting, no overlap flags.
//   apple-woff2  Chrome 102+ on macOS (not Edge or Opera): italics carry glyph overlap flags.
//   apple-woff   Other macOS browsers and older Chrome: the same fonts, italics as WOFF.
//   hinted       Windows, Linux and ChromeOS: IBM Plex Mono keeps its TrueType hinting.
//
// Anything unrecognised gets `plain`. The classes come from probing fonts.googleapis.com with
// many User-Agents; scripts/brief-fonts/subset_brief_fonts.py cuts one file set per class.

/** @param {string} userAgent @returns {'plain' | 'apple-woff2' | 'apple-woff' | 'hinted'} */


const BRIEF_FONT_PLATFORM_RE = /Android|iPhone|iPad|iPod/;
const BRIEF_FONT_PLATFORM_RE_2 = /Macintosh|Mac OS X/;
const CHROME_RE = /Chrome\/(\d+)/;
const BRIEF_FONT_PLATFORM_RE_3 = /\b(Edg|OPR)\//;
const BRIEF_FONT_PLATFORM_RE_4 = /Windows|X11|Linux|CrOS/;export function briefFontPlatform(userAgent) {
  const ua = typeof userAgent === 'string' ? userAgent : '';
  if (BRIEF_FONT_PLATFORM_RE.test(ua)) return 'plain';
  if (BRIEF_FONT_PLATFORM_RE_2.test(ua)) {
    const chrome = CHROME_RE.exec(ua);
    return chrome && Number(chrome[1]) >= 102 && !BRIEF_FONT_PLATFORM_RE_3.test(ua) ? 'apple-woff2' : 'apple-woff';
  }
  if (BRIEF_FONT_PLATFORM_RE_4.test(ua)) return 'hinted';
  return 'plain';
}
