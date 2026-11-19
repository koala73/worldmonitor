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
export function briefFontPlatform(userAgent) {
  const ua = typeof userAgent === 'string' ? userAgent : '';
  if (/Android|iPhone|iPad|iPod/.test(ua)) return 'plain';
  if (/Macintosh|Mac OS X/.test(ua)) {
    const chrome = /Chrome\/(\d+)/.exec(ua);
    return chrome && Number(chrome[1]) >= 102 && !/\b(Edg|OPR)\//.test(ua) ? 'apple-woff2' : 'apple-woff';
  }
  if (/Windows|X11|Linux|CrOS/.test(ua)) return 'hinted';
  return 'plain';
}
