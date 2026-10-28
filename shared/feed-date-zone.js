// RSS dates may end in a zone abbreviation (`... 10:29:20 CET`). Date parses
// UT, UTC, GMT and the US zones, but returns Invalid Date for every other
// name, so a feed dated in CET, AEST or JST loses every item. These are the
// unambiguous abbreviations feeds use; IST (India, Ireland, Israel) is left
// out on purpose.
const ZONE_OFFSETS = {
  WET: '+0000', WEST: '+0100', BST: '+0100',
  CET: '+0100', CEST: '+0200', MET: '+0100', MEST: '+0200',
  EET: '+0200', EEST: '+0300', MSK: '+0300',
  WIB: '+0700', HKT: '+0800', SGT: '+0800', PHT: '+0800', AWST: '+0800',
  JST: '+0900', KST: '+0900', ACST: '+0930', AEST: '+1000', AEDT: '+1100',
  NZST: '+1200', NZDT: '+1300',
};

const TRAILING_ZONE = /\s([A-Z]{3,4})$/;

/** Rewrites a trailing named zone Date cannot read into its numeric offset. */
export function normalizeFeedDateZone(value) {
  const trimmed = String(value ?? '').trim();
  const match = trimmed.match(TRAILING_ZONE);
  const offset = match ? ZONE_OFFSETS[match[1]] : undefined;
  return offset ? `${trimmed.slice(0, match.index)} ${offset}` : trimmed;
}
