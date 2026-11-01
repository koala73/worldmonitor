/**
 * Pure text-analysis primitives shared by the client analysis pipeline and
 * server-side MCP NLP tools (issue #5697). Moved verbatim from
 * src/utils/analysis-constants.ts, which re-exports from here — that file
 * cannot be imported server-side because it also pulls in @/services/i18n.
 *
 * Dependency-free ESM (shared/story-identity.js pattern). Types in
 * text-analysis-core.d.ts.
 */

// Clustering constants
export const SIMILARITY_THRESHOLD = 0.5;

export const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
  'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need',
  'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'he',
  'she', 'we', 'they', 'what', 'which', 'who', 'whom', 'how', 'when',
  'where', 'why', 'all', 'each', 'every', 'both', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'not', 'only', 'same', 'so', 'than',
  'too', 'very', 'just', 'also', 'now', 'new', 'says', 'said', 'after',
]);

export const TOPIC_KEYWORDS = [
  'iran', 'israel', 'ukraine', 'russia', 'china', 'taiwan', 'oil', 'crypto',
  'fed', 'interest', 'inflation', 'recession', 'war', 'sanctions', 'tariff',
  'ai', 'tech', 'layoff', 'trump', 'biden', 'election',
];

export const SUPPRESSED_TRENDING_TERMS = new Set([
  // Meta / media terms
  'ai', 'app', 'api', 'new', 'top', 'big', 'ceo', 'cto',
  'update', 'report', 'latest', 'breaking', 'analysis',
  'reuters', 'exclusive', 'opinion', 'editorial', 'watch',
  'live', 'video', 'photo', 'photos', 'read', 'full',
  'source', 'sources', 'according', 'ahead', 'english',
  'times', 'post', 'news', 'press', 'media', 'journal',
  'morning', 'evening', 'daily', 'weekly', 'monthly',
  'newsletter', 'subscribe', 'podcast', 'interview',
  // Common news verbs (not meaningful standalone)
  'says', 'said', 'tells', 'told', 'calls', 'called',
  'makes', 'made', 'takes', 'took', 'gets', 'gives', 'gave',
  'goes', 'went', 'comes', 'came', 'puts', 'sets', 'set',
  'shows', 'shown', 'finds', 'found', 'keeps', 'kept',
  'holds', 'held', 'runs', 'turns', 'turned', 'leads', 'led',
  'brings', 'brought', 'starts', 'started', 'moves', 'moved',
  'plans', 'planned', 'wants', 'wanted', 'needs', 'needed',
  'looks', 'looked', 'works', 'worked', 'tries', 'tried',
  'asks', 'asked', 'uses', 'used', 'expects', 'expected',
  'reports', 'reported', 'claims', 'claimed', 'warns', 'warned',
  'reveals', 'revealed', 'announces', 'announced', 'confirms',
  'confirmed', 'denies', 'denied', 'launches', 'launched',
  'signs', 'signed', 'faces', 'faced', 'seeks', 'sought',
  'hits', 'hit', 'dies', 'died', 'killed', 'kills',
  'rises', 'rose', 'falls', 'fell', 'wins', 'won', 'lost',
  'ends', 'ended', 'begins', 'began', 'opens', 'opened',
  'closes', 'closed', 'raises', 'raised', 'cuts', 'cut',
  'adds', 'added', 'drops', 'dropped', 'pushes', 'pushed',
  'pulls', 'pulled', 'backs', 'backed', 'blocks', 'blocked',
  'passes', 'passed', 'votes', 'voted', 'joins', 'joined',
  'leaves', 'left', 'returns', 'returned', 'sends', 'sent',
  'urges', 'urged', 'vows', 'vowed', 'pledges', 'pledged',
  'rejects', 'rejected', 'approves', 'approved',
  // Common news adjectives / adverbs / time words
  'first', 'last', 'next', 'major', 'former', 'still',
  'despite', 'amid', 'over', 'under', 'back', 'year',
  'years', 'day', 'days', 'week', 'weeks', 'month', 'months',
  'time', 'long', 'high', 'low', 'part', 'early', 'late',
  'key', 'two', 'three', 'four', 'five', 'million', 'billion',
  'percent', 'nearly', 'almost', 'already', 'just', 'even',
  'since', 'while', 'during', 'before', 'between', 'again',
  'against', 'into', 'through', 'around', 'about', 'much',
  'many', 'several', 'second', 'third', 'possible', 'likely',
  'least', 'best', 'worst', 'largest', 'biggest', 'smallest',
  'highest', 'lowest', 'record', 'global', 'local',
  // Generic news nouns (too vague as standalone trends)
  'state', 'states', 'department', 'officials', 'official',
  'country', 'countries', 'people', 'group', 'groups',
  'plan', 'deal', 'talks', 'move', 'order', 'case',
  'house', 'court', 'secretary', 'board', 'control', 'bank',
  'power', 'leader', 'leaders', 'government', 'minister',
  'president', 'agency', 'market', 'markets', 'company',
  'companies', 'world', 'white', 'head', 'side', 'point',
  'end', 'line', 'area', 'number', 'issue', 'issues',
  'policy', 'security', 'force', 'forces', 'system',
  'service', 'services', 'program', 'project', 'effort',
  'action', 'support', 'level', 'rate', 'rates', 'price',
  'prices', 'trade', 'growth', 'change', 'changes',
  'crisis', 'risk', 'impact', 'future', 'history',
  'data', 'team', 'member', 'members', 'office',
  'sector', 'region', 'regions', 'center', 'role',
  'south', 'north', 'east', 'west', 'eastern', 'western',
  'southern', 'northern', 'central', 'middle',
  'united', 'national', 'international', 'federal',
  // Base verb forms (fallback when NER model unavailable)
  'say', 'get', 'give', 'go', 'come', 'put', 'take', 'make',
  'know', 'think', 'see', 'want', 'look', 'find', 'tell', 'ask',
  'use', 'try', 'leave', 'call', 'keep', 'let', 'begin', 'show',
  'hear', 'play', 'run', 'move', 'help', 'turn', 'start', 'hold',
  'bring', 'write', 'provide', 'sit', 'stand', 'lose', 'pay',
  'meet', 'include', 'continue', 'learn', 'lead', 'believe',
  'feel', 'follow', 'stop', 'speak', 'allow', 'add', 'grow',
  'open', 'walk', 'win', 'offer', 'appear', 'buy', 'wait',
  'serve', 'die', 'send', 'build', 'stay', 'fall', 'reach',
  'remain', 'suggest', 'raise', 'sell', 'require', 'decide',
  'develop', 'break', 'happen', 'create', 'live',
  // Numbers and misc
  '000', '100', '200', '500', 'per', 'than',
  // Finance / trading generic terms
  'trading', 'stock', 'earnings', 'finance', 'defi',
  'ipo', 'tradingview', 'currency', 'dollar',
  'usd', 'investing', 'equity', 'valuation', 'ecb',
  'regulation', 'outlook', 'forecast', 'financial',
  // Web / tech generic terms
  'com', 'platform', 'block',
  // Generic news nouns (additional)
  'focus', 'today', 'chief', 'basel',
  // Generic adjectives / adverbs (additional)
  'ongoing', 'higher', 'poised', 'track',
  // URL / source fragments
  'wall', 'street', 'financialcontent',
  // Media / URL fragments
  'ray', 'msn', 'aol',
  // Date fragments
  '2025', '2026', '2027',
  // Month names
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
  // Company name fragments (too generic standalone)
  'goldman', 'sachs', 'off',
  // Basic English stopwords (pronouns, prepositions, adverbs)
  'here', 'there', 'where', 'when', 'what', 'which', 'who', 'whom',
  'this', 'that', 'these', 'those', 'been', 'being', 'have', 'has',
  'had', 'having', 'does', 'done', 'doing', 'would', 'could', 'should',
  'will', 'shall', 'might', 'must', 'also', 'more', 'most', 'some',
  'other', 'only', 'very', 'after', 'with', 'from', 'they', 'them',
  'their', 'then', 'now', 'how', 'all', 'each', 'every',
  'both', 'few', 'own', 'same', 'such', 'too', 'any', 'well',
]);

// Pure utility functions that can be shared
export function tokenize(text) {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
  return new Set(words);
}

// Scripts written without spaces between words: a whole title would be one
// token, so they are compared by overlapping character pairs instead.
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
// Korean is spaced, but each Hangul character is a syllable, so a
// two-character word is a whole word (정부, 경제).
const HANGUL = /\p{Script=Hangul}/u;

/**
 * Tokens for a title in any language. `tokenize` keeps only a-z and digits,
 * which leaves Cyrillic, Arabic or Chinese titles with no tokens; it stays as
 * is so dashboard clusters do not move. Here every script's letters count:
 * spaced scripts give words of three or more characters (two in Hangul),
 * unspaced scripts give character pairs.
 */
export function tokenizeAnyScript(text) {
  const tokens = new Set();
  for (const run of text.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}\p{M}]+/u)) {
    if (!run) continue;
    const chars = [...run];
    if (UNSPACED_SCRIPT.test(run)) {
      if (chars.length === 1) tokens.add(run);
      for (let i = 0; i + 1 < chars.length; i++) tokens.add(chars[i] + chars[i + 1]);
    } else if (chars.length > (HANGUL.test(run) ? 1 : 2) && !STOP_WORDS.has(run)) {
      tokens.add(run);
    }
  }
  return tokens;
}

export function jaccardSimilarity(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  // Walk the smaller set and derive the union size, so one huge title costs
  // nothing extra against each ordinary headline it is compared with.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const x of small) if (large.has(x)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

export function includesKeyword(text, keywords) {
  return keywords.some(keyword => text.includes(keyword));
}

export function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function containsTopicKeyword(text, keyword) {
  const normalizedKeyword = keyword.trim().toLowerCase();
  if (!normalizedKeyword) return false;
  const pattern = new RegExp(`\\b${escapeRegex(normalizedKeyword)}\\b`, 'i');
  return pattern.test(text);
}
