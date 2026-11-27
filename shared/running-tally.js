/**
 * A headline that reports a running total ("16 schoolchildren killed so far
 * this month", "Gaza death toll rises to 74,736") counts deaths or attacks over
 * weeks, months or a whole war. It is not a new event, so it never pages a
 * realtime subscriber, whatever level the classifier gave it.
 *
 * Matches only an explicit long window. A toll from one attack or disaster
 * ("death toll in the El Fasher assault rises to 1,500"), or a count over the
 * past day, is not matched. A headline that also reports a new event, one of
 * the event kinds the classifier prompt calls critical (a ceasefire, a coup, a
 * closure), or uses an ordinal or superlative ("third strike in two weeks"),
 * is treated as a new event: a missed cap costs one extra alert, a wrong cap
 * silently drops a critical one.
 *
 * Lives in `shared/` because the AIS relay needs it (Dockerfile.relay copies
 * `shared/`).
 */
// A headline is short. The clip and the bounded numbers keep every pattern
// linear on a crafted publisher title.
const MAX_TITLE_CHARS = 300;
const NUMBER = String.raw`(?:\d{1,3}(?:,\d{3}){1,3}|\d{1,9})`;
const THOUSANDS = String.raw`(?:\d{1,3}(?:,\d{3}){1,3}|\d{4,9})`;
const COUNT = String.raw`(?:${NUMBER}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|several)`;

const RUNNING_TOTAL = [
  /\bso far (?:this|in) (?:week|month|year)\b/i,
  /\bso far in 20\d\d\b/i,
  /\bsince (?:the )?(?:start|beginning|outbreak) of\b/i,
  /\bsince (?:october 7|oct\.? 7|20\d\d)\b/i,
  new RegExp(String.raw`\b(?:in|during) (?:the )?(?:(?:past|last) )?${COUNT} (?:weeks|months|years)\b`, 'i'),
  new RegExp(String.raw`\bover (?:the )?(?:past|last) ${COUNT} (?:weeks|months|years)\b`, 'i'),
  /\bin (?:one|a single) week\b/i,
  new RegExp(String.raw`\b${NUMBER} (?:missiles|drones|attacks|strikes|bombs|shells|rockets)\b.{0,80}\b(?:this|last|past) (?:week|month|year)\b`, 'i'),
  new RegExp(String.raw`\b(?:death toll|number of martyrs|martyrs)\b.{0,40}\b(?:rises|rose|climbs|surges|reaches|hits|tops|passes) (?:to )?${THOUSANDS}\b`, 'i'),
];

const NEW_EVENT = [
  /\b(?:as|after|amid|with) (?:a |an )?(?:new|fresh|latest|another)\b/i,
  /\b(?:first|second|third|fourth|fifth|\d+(?:st|nd|rd|th)|most|best|worst|deadliest|biggest|largest|heaviest|highest|record)\b/i,
  /\bas\b[^,.;]{0,40}\b(?:hit|struck|attacked|killed|sunk|downed)\b/i,
  /\b(?:death )?toll (?:from|in|after|of)\b(?: \S+){0,5}? (?:assault|attack|strike|bombing|blast|explosion|raid|massacre|shelling|earthquake|quake|floods?|fire|crash|storm|cyclone|hurricane|typhoon|landslide|collapse)\b/i,
  /\b(?:death )?toll from\b/i,
  /\b(?:ceasefire|truce|coup|nuclear|pandemic|invades|invaded|declares|declared|closes|closed|agree|agrees|agreed|signs|signed)\b/i,
];

export function isRunningTally(title) {
  if (typeof title !== 'string') return false;
  const text = title.slice(0, MAX_TITLE_CHARS);
  return RUNNING_TOTAL.some((re) => re.test(text)) && !NEW_EVENT.some((re) => re.test(text));
}
