// Line classifiers for the five-section country brief that
// get-country-intel-brief prompts for (SITUATION NOW / WHAT THIS MEANS FOR /
// KEY RISKS / OUTLOOK / WATCH ITEMS). One definition for every renderer of
// that text: the dashboard (src/utils/format-intel-brief.ts) and the
// crawlable corpus (scripts/crawlable-developments.mjs). They used to carry
// separate copies whose bullet and outlook rules had already drifted
// ("-5% output" was a bullet on the dashboard and prose in the corpus).
//
// Plain ESM JavaScript: the corpus freeze runs under bare `node`.

export const BRIEF_SECTION_HEADERS = Object.freeze([
  'SITUATION NOW',
  'WHAT THIS MEANS FOR',
  'KEY RISKS',
  'OUTLOOK',
  'WATCH ITEMS',
]);

// A bullet is a marker FOLLOWED BY WHITESPACE: "• Port Sudan" and "- Port
// Sudan" are bullets, "-5% output" is a number.
const BULLET_RE = /^[•\-*]\s+/;
// The OUTLOOK section's rows: "NEXT 24H: ...", "NEXT 48H: ...", "NEXT 72H: ...".
const OUTLOOK_ROW_RE = /^NEXT \d+H:/;

export function isBriefSectionHeader(line) {
  const upper = String(line || '').trim().toUpperCase();
  return upper.length > 0 && BRIEF_SECTION_HEADERS.some((header) => upper.startsWith(header));
}

export function isBriefBullet(line) {
  return BULLET_RE.test(String(line || '').trim());
}

export function stripBriefBullet(line) {
  return String(line || '').trim().replace(BULLET_RE, '');
}

export function isBriefOutlookRow(line) {
  return OUTLOOK_ROW_RE.test(String(line || '').trim());
}
