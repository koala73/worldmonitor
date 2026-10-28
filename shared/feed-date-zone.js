// RSS dates may end in a zone abbreviation (`... 10:29:20 CET`). Date parses
// UT, UTC, GMT and the US zones, but returns Invalid Date for every other
// name, so a feed dated in CET, AEST or JST loses every item. These are the
// unambiguous abbreviations feeds use; IST (India, Ireland, Israel) and BST
// (British Summer, Bangladesh Standard) are left out on purpose.
const ZONE_OFFSETS = {
  WET: '+0000', WEST: '+0100',
  CET: '+0100', CEST: '+0200', MET: '+0100', MEST: '+0200',
  EET: '+0200', EEST: '+0300', MSK: '+0300',
  WIB: '+0700', HKT: '+0800', SGT: '+0800', PHT: '+0800', AWST: '+0800',
  JST: '+0900', KST: '+0900', ACST: '+0930', AEST: '+1000', AEDT: '+1100',
  NZST: '+1200', NZDT: '+1300',
};

const TRAILING_ZONE = /\s([A-Z]{3,4})$/;

// Zone-less shapes Date cannot read, both read as UTC:
// IAEA `26-10-28  14:21` (YY-MM-DD HH:MM; only when the first number cannot
// be a month, so Date still reads month-first `10-28-26 14:21`) and
// Crisis Group `Friday, October 23, 2026 - 18:13`.
const SHORT_YEAR_DATE = /^(\d{2})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/;
const DASHED_TIME = /^([A-Za-z]+, [A-Za-z]+ \d{1,2}, \d{4}) - (\d{1,2}:\d{2})$/;

/** Rewrites feed date text Date cannot read into a form it parses exactly. */
export function normalizeFeedDateZone(value) {
  const trimmed = String(value ?? '').trim();
  const short = trimmed.match(SHORT_YEAR_DATE);
  if (short && Number(short[1]) > 12) return `20${short[1]}-${short[2]}-${short[3]}T${short[4]}:${short[5]}:00Z`;
  const dashed = trimmed.match(DASHED_TIME);
  if (dashed) return `${dashed[1]} ${dashed[2]} +0000`;
  const match = trimmed.match(TRAILING_ZONE);
  const offset = match ? ZONE_OFFSETS[match[1]] : undefined;
  return offset ? `${trimmed.slice(0, match.index)} ${offset}` : trimmed;
}
