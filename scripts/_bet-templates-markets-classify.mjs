// Geopolitical classification for prediction-market titles (Phase 2 / #5525,
// #5733). WorldMonitor's identity is geopolitical intelligence, so the market
// bet-family is split into a dedicated geopolitical slice (long horizon, top
// ensemble priority) and a general slice — and the split is driven by the
// market TEXT, deliberately NOT by the bootstrap feed's geopolitical/tech/
// finance pools. Those pools are unreliable: the same market appears in all
// three and the "geopolitical" pool is dominated by crypto/finance titles
// (#5733). Classifying from the title keeps this robust to the broken producer
// labels.
//
// Precision over recall: a FALSE geopolitical tag pollutes the flagship slice
// (a company/crypto market stealing a geo ensemble slot), which is worse than a
// missed one, so the matcher keys on unambiguous conflict/statecraft terms and
// high-salience actors — never on bare country names ("Chinese AI model" is
// tech, "Korea" alone is ambiguous) and never on bare "election"/"strike"
// (company boards hold elections; options have strike prices).

// Unambiguous conflict / statecraft vocabulary. Word-boundaried so "war" does
// not fire on "warrant"/"forward" and "strike" is only matched in explicit
// military compounds, never alone (no "strike price" false positive).
const GEO_TERMS = /\b(?:cease-?fire|armistice|truce|coup(?:\sd'[ée]tat)?|uranium|enrich(?:ed|ment)|sanctions?|invade|invasion|annex(?:ation|ed|es)?|air\s?strikes?|drone\sstrikes?|missile\sstrikes?|strikes?\son|missiles?|ballistic|warheads?|war|wartime|warfare|regime\schange|leadership\schange|hostages?|prisoner\s(?:swap|exchange)|prisoners\sof\swar|nato|occupation|martial\slaw|troops|referendum|secede|secession|assassinat(?:e|ed|ion)|territorial|border\s(?:clash|dispute)|blockade|genocide|ethnic\scleansing|militants?|insurgen(?:t|cy|ts)|militias?)\b/i;

// "nuclear" is only geopolitical in a weapon/statecraft context — bare
// "nuclear" would falsely tag nuclear-ENERGY company/reactor/SMR markets (a
// real prediction-market category). Require a conflict/diplomacy qualifier;
// "energy"/"power"/"reactor" deliberately fall through as NON-geo.
const GEO_NUCLEAR = /\bnuclear\s(?:weapons?|warheads?|tests?|strikes?|deal|program(?:me)?|talks|enrichment|arsenal|threat|attack|bomb|war|escalation|facilit(?:y|ies)|site)\b/i;

// National / legislative elections and control-of-chamber markets — core
// geopolitical events. QUALIFIED so corporate "board election", "union
// election", or "Hall of Fame election" never match (bare "election" is not
// matched on its own).
const GEO_ELECTIONS = /\b(?:(?:presidential|parliamentary|general|snap|midterm|legislative|congressional|senate|gubernatorial|federal|national|primary)\selections?|midterms?|runoff|presidenc(?:y|ies)|control\sof\s(?:the\s)?(?:senate|house|congress|parliament|bundestag|knesset|duma))\b/i;

// National head-of-state / head-of-government markets — core geopolitics.
// "prime minister" and "potus" are unambiguously national; "president" is
// matched ONLY with a country qualifier so corporate "President of <company>"
// or "Vice President" never fire.
const GEO_LEADERSHIP = /\b(?:prime\sminister|potus|president\sof\s(?:the\s)?(?:united\sstates|u\.?s\.?a?|france|russia|iran|brazil|mexico|venezuela|turkey|t[üu]rkiye|egypt|ukraine|poland|argentina|colombia|philippines|south\skorea|the\seu)|next\s(?:president|prime\sminister|chancellor|premier|supreme\sleader))\b/i;

// High-salience geopolitical actors and conflict placenames that are
// effectively never the subject of a company/crypto/finance market. Excludes
// ambiguous names that double as companies (Taiwan→TSMC) or broad regions
// (China, Korea) — those only qualify via a GEO_TERMS co-occurrence.
const GEO_ENTITIES = /\b(?:ukraine|ukrainian|gaza|crimea|donbas|donbass|kashmir|west\sbank|hezbollah|hamas|houthis?|taliban|wagner|putin|khamenei|kim\sjong|zelensky+|netanyahu|isis|islamic\sstate)\b/i;

// True iff the market title reads as geopolitical. Pure; no imports.
export function isGeopoliticalMarket(title) {
  const text = String(title ?? '');
  if (!text.trim()) return false;
  return GEO_TERMS.test(text)
    || GEO_NUCLEAR.test(text)
    || GEO_ELECTIONS.test(text)
    || GEO_LEADERSHIP.test(text)
    || GEO_ENTITIES.test(text);
}
