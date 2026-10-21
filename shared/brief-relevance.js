// Brief relevance: which headlines may ground a country brief.
//
// A country brief explains instability, risk and exposure. Sports results,
// entertainment and personal awards mention a country without saying anything
// about it; the 2026-09-21 snapshot grounded Burkina Faso's "What this means"
// on a football score and Egypt's brief on a physics medal.
//
// The keyword threat classifier cannot supply this signal: it returns
// info/general for every title matching no keyword list, which is most real
// news, and its EXCLUSIONS list matches substrings ("relationship", "diet",
// "game") that hit bilateral relations, Japan's Diet and "game-changer".
// This predicate is a narrow, word-bounded title lexicon instead. It rejects
// only what it can name; anything unmatched stays eligible.

const SPORT_TERMS = [
  'football', 'soccer', 'cricket', 'rugby', 'tennis', 'golf', 'basketball',
  'baseball', 'volleyball', 'handball', 'hockey', 'athletics', 'half marathon',
  'motogp', 'formula 1', 'formula one', 'f1', 'grand prix', 'fifa', 'uefa',
  'afcon', 'world cup', 'premier league', 'champions league', 'europa league',
  'la liga', 'serie a', 'bundesliga', 'ligue 1', 'nba', 'nfl', 'ipl',
  'test match', 'friendly match', 'striker', 'goalkeeper', 'midfielder',
  'head coach', 'hat-trick', 'hat trick', 'semi-final', 'semifinal',
  'quarter-final', 'quarterfinal', 'qualifier', 'qualifiers', 'wafu',
  'olympian', 'paralympic', 'paralympics', 'wrestler', 'cyclist',
  'grand slam', 'wimbledon', 'netball', 'asian games',
];

const ENTERTAINMENT_TERMS = [
  'celebrity', 'box office', 'album', 'film festival', 'oscar',
  'oscars', 'grammy', 'grammys', 'emmy', 'emmys', 'eurovision', 'k-pop',
  'kpop', 'rapper', 'pop star', 'popstar', 'actress', 'fashion week',
  'beauty pageant', 'miss universe', 'miss world', 'reality show', 'sitcom',
  'music video', 'red carpet', 'bollywood', 'nollywood', 'hollywood',
];

const LIFESTYLE_TERMS = [
  'recipe', 'recipes', 'cuisine', 'travel guide', 'things to do',
  'best places to', 'horoscope',
];

// A personal honour ("wins global Marie Curie Medal") says nothing about the
// country's stability. Peace prizes and honours given to office-holders stay
// eligible: they are political news ("Tuvalu PM Teo to receive ... award").
const AWARD_RE = /\b(?:wins?|won|awarded|scoops?|bags?|clinches?|receives?|receive|honou?red)\b.*\b(?:medal|award|awards|prize|trophy|title)\b/i;
const POLITICAL_HONOUR_RE = /\b(?:peace prize|pm|prime minister|president|minister|chancellor|king|queen|government)\b/i;

// A match score such as "thrash Burkina Faso 4-0" or "beat Ghana 2–1". Only
// counted beside a result verb, so a "5-4 ruling" or a "3-2 vote" stays.
// Deliberately absent from the term lists: squad, actor, concert, marathon.
// Each also names security or diplomatic news ("death squad", "state actor",
// "in concert with", "marathon talks").
const SCORE_RE = /\b\d{1,2}\s*[-–]\s*\d{1,2}\b/;
const RESULT_VERB_RE = /\b(?:thrash(?:es|ed)?|beat|beats|defeat(?:s|ed)?|edge(?:s|d)?|rout(?:s|ed)?|hammer(?:s|ed)?|stun(?:s|ned)?|draw(?:s|n)? with|held to)\b/i;
// A farewell match or a player leaving the national team. Kept narrow so an
// "army chief retires amid international pressure" stays eligible.
const FAREWELL_RE = /\bfarewell (?:match|game)\b|\binternational retirement\b|\bretire[sd]? from (?:international (?:football|cricket|rugby)|the national team)\b|\boffered farewell\b/i;

// Security, rights, legal and casualty news stays eligible even when it names
// a sport, a star or an award: "North Korea executes man for sharing K-pop
// videos", "Crowd crush at football stadium kills 125", "Hunger striker dies",
// "Nigeria wins appeal to overturn arbitration award".
const KEEP_RE = /\b(?:kill(?:s|ed|ing)?|dead|dies|died|deaths?|execut(?:es?|ed|ion)|arrest(?:s|ed)?|jail(?:s|ed)?|sentenced|detain(?:s|ed)?|protest(?:s|ers?)?|tear gas|crush|stampede|attack(?:s|ed)?|bomb(?:s|ing|ed)?|shooting|court|appeal|arbitration|sanction(?:s|ed)?|coup|riots?|clash(?:es)?|police|(?:anti-)?government|minister|ban(?:s|ned)?|hunger strik(?:e|er)|match-fixing|corruption|fraud)\b/i;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function termsRegExp(terms) {
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${terms.map(escapeRegExp).join('|')})(?=$|[^\\p{L}\\p{N}])`, 'iu');
}

const TERM_RULES = [
  ['sport', termsRegExp(SPORT_TERMS)],
  ['entertainment', termsRegExp(ENTERTAINMENT_TERMS)],
  ['lifestyle', termsRegExp(LIFESTYLE_TERMS)],
];

/**
 * Why a headline title cannot ground a country brief, or null when it can.
 * @param {unknown} title
 * @returns {'sport' | 'entertainment' | 'lifestyle' | 'award' | null}
 */
export function briefIrrelevanceReason(title) {
  if (typeof title !== 'string') return null;
  const text = title.replace(/\s+/g, ' ').trim();
  if (!text || KEEP_RE.test(text)) return null;
  for (const [reason, re] of TERM_RULES) {
    if (re.test(text)) return reason;
  }
  if (SCORE_RE.test(text) && RESULT_VERB_RE.test(text)) return 'sport';
  if (FAREWELL_RE.test(text)) return 'sport';
  if (AWARD_RE.test(text) && !POLITICAL_HONOUR_RE.test(text)) return 'award';
  return null;
}

/** True when a headline title may ground a country brief. */
export function isBriefRelevantTitle(title) {
  return briefIrrelevanceReason(title) === null;
}
