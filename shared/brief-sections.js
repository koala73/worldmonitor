// The country brief's sections: the server renders these headings into the
// brief text (server/worldmonitor/intelligence/v1/get-country-intel-brief.ts)
// and the freeze and corpus parse them back out (scripts/crawlable-developments.mjs).
// One table, so the two sides cannot drift.

export const BRIEF_SECTION_KEYS = Object.freeze(['situation', 'implications', 'risks', 'outlook', 'watch']);

const FIXED_HEADINGS = Object.freeze({
  situation: 'SITUATION NOW',
  risks: 'KEY RISKS',
  outlook: 'OUTLOOK',
  watch: 'WATCH ITEMS',
});

export const IMPLICATIONS_HEADING_PREFIX = 'WHAT THIS MEANS FOR';

/** The fixed headings, in capitals, without the per-country implications heading. */
export const BRIEF_FIXED_SECTION_HEADINGS = Object.freeze(Object.values(FIXED_HEADINGS));

/** The heading the server writes for a section key. */
export function briefSectionHeading(key, countryName) {
  if (key === 'implications') return `${IMPLICATIONS_HEADING_PREFIX} ${String(countryName || '').toUpperCase()}`;
  return FIXED_HEADINGS[key];
}

/** The section key for a heading line, or null. The implications heading matches by prefix. */
export function briefSectionKey(heading) {
  const upper = String(heading || '').trim().replace(/:\s*$/, '').toUpperCase();
  for (const [key, fixed] of Object.entries(FIXED_HEADINGS)) {
    if (upper === fixed) return key;
  }
  return upper.startsWith(`${IMPLICATIONS_HEADING_PREFIX} `) ? 'implications' : null;
}
