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
//
// Weak terms (war, sanctions, uranium, occupation, leadership change) only
// fire with a high-salience actor/placename co-occurrence so corporate "price
// war", "uranium miner IPO", labor "occupation", and "CEO leadership change"
// stay non-geo.

// Unambiguous conflict / statecraft vocabulary. Word-boundaried so "war" does
// not fire alone (see GEO_WEAK) and "strike" is only matched in explicit
// military compounds, never alone (no "strike price" false positive).
const GEO_STRONG = /\b(?:cease-?fire|armistice|truce|coup(?:\sd'[ée]tat)?|enrich(?:ed|ment)|invade|invasion|annex(?:ation|ed|es)?|air\s?strikes?|drone\sstrikes?|missile\sstrikes?|strikes?\son|missiles?|ballistic|warheads?|regime\schange|hostages?|prisoner\s(?:swap|exchange)|prisoners\sof\swar|nato|martial\slaw|troops|referendum|secede|secession|assassinat(?:e|ed|ion)|territorial|border\s(?:clash|dispute)|blockade|genocide|ethnic\scleansing|militants?|insurgen(?:t|cy|ts)|militias?)\b/i;

// Weak terms: real geo signal only with a high-salience actor/placename.
// Bare "war"/"sanctions"/"uranium"/"occupation"/"leadership change" alone
// match finance, commodity, labor, and corporate titles.
const GEO_WEAK = /\b(?:uranium|sanctions?|war|wartime|warfare|occupation|leadership\schange)\b/i;

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

// Country list shared by "president of X" and "next president of X" so corporate
// "President of Acme" / "next president of OpenAI" never fire.
const PRESIDENT_COUNTRIES = '(?:united\\sstates|u\\.?s\\.?a?|france|russia|iran|brazil|mexico|venezuela|turkey|t[üu]rkiye|egypt|ukraine|poland|argentina|colombia|philippines|south\\skorea|the\\seu)';

// National head-of-state / head-of-government markets — core geopolitics.
// "prime minister" and "potus" are unambiguously national; "president" and
// "next president" require a country qualifier. "next prime minister" /
// chancellor / premier / supreme leader stay national without "of <country>"
// because those titles are not used for corporate roles.
const GEO_LEADERSHIP = new RegExp(
  String.raw`\b(?:prime\sminister|potus|president\sof\s(?:the\s)?${PRESIDENT_COUNTRIES}|next\spresident\sof\s(?:the\s)?${PRESIDENT_COUNTRIES}|next\s(?:prime\sminister|chancellor|premier|supreme\sleader))\b`,
  'i',
);

// High-salience geopolitical actors and conflict placenames that are
// effectively never the subject of a company/crypto/finance market on their
// own. Excludes ambiguous names that double as companies (Taiwan→TSMC) or
// broad regions/countries that appear in pure equity/macro titles (China,
// Korea, Iran-as-stock, Russia-as-ETF) — those only qualify via a strong
// term or as co-occurrence for GEO_WEAK below.
const GEO_ENTITIES = /\b(?:ukraine|ukrainian|gaza|crimea|donbas|donbass|kashmir|west\sbank|hezbollah|hamas|houthis?|taliban|wagner|putin|khamenei|kim\sjong|zelensky+|netanyahu|isis|islamic\sstate)\b/i;

// Broader actor/placename set used ONLY as the co-occurrence gate for weak
// terms (war/sanctions/uranium/occupation/leadership change). Not a standalone
// geo signal — "Russia stock market" must stay non-geo, but "Russia sanctions"
// and "Iran leadership change" must fire.
const GEO_WEAK_ACTORS = /\b(?:iran|iranian|ukraine|ukrainian|russia|russian|israel|israeli|gaza|crimea|donbas|donbass|kashmir|west\sbank|hezbollah|hamas|houthis?|taliban|wagner|putin|khamenei|kim\sjong|zelensky+|netanyahu|isis|islamic\sstate|venezuela|venezuelan|north\skorea|dprk|syria|syrian|nato)\b/i;

// True iff the market title reads as geopolitical. Pure; no imports.
export function isGeopoliticalMarket(title) {
  const text = String(title ?? '');
  if (!text.trim()) return false;
  if (
    GEO_STRONG.test(text)
    || GEO_NUCLEAR.test(text)
    || GEO_ELECTIONS.test(text)
    || GEO_LEADERSHIP.test(text)
    || GEO_ENTITIES.test(text)
  ) {
    return true;
  }
  // Weak terms only with a high-salience actor/placename co-occurrence.
  return GEO_WEAK.test(text) && GEO_WEAK_ACTORS.test(text);
}
