// @ts-check
/**
 * Edge-safe pure helpers for the brief LLM enrichment path. Shared by:
 *   - scripts/lib/brief-llm.mjs   (Railway cron, Node)
 *   - api/internal/brief-why-matters.ts  (Vercel edge)
 *
 * No `node:*` imports. Hashing via Web Crypto (`crypto.subtle.digest`),
 * which is available in both Edge and modern Node. Everything else is
 * pure string manipulation.
 *
 * Any change here MUST be mirrored byte-for-byte to
 * `scripts/shared/brief-llm-core.js` (enforced by the shared-mirror
 * parity test; see `feedback_shared_dir_mirror_requirement`).
 */

/**
 * System prompt for the one-sentence "why this matters" enrichment.
 * Moved verbatim from scripts/lib/brief-llm.mjs so the edge endpoint
 * and the cron fallback emit the identical editorial voice.
 */
export const WHY_MATTERS_SYSTEM =
  'You are the editor of WorldMonitor Brief, a geopolitical intelligence magazine. ' +
  'For each story below, write ONE concise sentence (18–30 words) explaining the ' +
  'regional or global stakes. Editorial, impersonal, serious. No preamble ' +
  '("This matters because…"), no questions, no calls to action, no markdown, ' +
  'no quotes. One sentence only.';

/**
 * Date-grounding line appended to every brief LLM system prompt.
 *
 * The brief's source stories are dated, but the system prompts are
 * static — without an explicit "today" the model fills date/year
 * gaps from its training-data priors. A May 2026 brief shipped a
 * whyMatters claiming a deploy "in 2024" (plan F6). The proper-noun
 * grounding gate does not catch numeric/date fabrication, so one
 * line stating the current date and forbidding contradictory years
 * is the cheap structural guard.
 *
 * `todayIso` is injectable so prompt-builder tests stay deterministic;
 * production call sites pass nothing and get the current UTC date.
 * A malformed override falls back to today rather than interpolating
 * garbage into the prompt.
 *
 * @param {string} [todayIso] ISO date `YYYY-MM-DD`. Defaults to today (UTC).
 * @returns {string}
 */
export function briefDateLine(todayIso) {
  const iso = typeof todayIso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(todayIso)
    ? todayIso
    : new Date().toISOString().slice(0, 10);
  return (
    `Today is ${iso}. Do not state any year or date that contradicts ` +
    'the dates in the stories below; when a date is not given, omit it ' +
    'rather than guess.'
  );
}

/**
 * @param {{
 *   headline: string;
 *   source: string;
 *   threatLevel: string;
 *   category: string;
 *   country: string;
 * }} story
 * @param {string} [todayIso] ISO date for the date-grounding line; defaults to today.
 * @returns {{ system: string; user: string }}
 */
export function buildWhyMattersUserPrompt(story, todayIso) {
  const user = [
    `Headline: ${story.headline}`,
    `Source: ${story.source}`,
    `Severity: ${story.threatLevel}`,
    `Category: ${story.category}`,
    `Country: ${story.country}`,
    '',
    'One editorial sentence on why this matters:',
  ].join('\n');
  return { system: `${WHY_MATTERS_SYSTEM}\n${briefDateLine(todayIso)}`, user };
}

/**
 * Parse + validate the LLM response into a single editorial sentence.
 * Returns null when the output is obviously wrong (empty, boilerplate
 * preamble that survived stripReasoningPreamble, too short / too long).
 *
 * @param {unknown} text
 * @returns {string | null}
 */
export function parseWhyMatters(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim();
  if (!s) return null;
  s = s.replace(/^[\u201C"']+/, '').replace(/[\u201D"']+$/, '').trim();
  const match = s.match(/^[^.!?]+[.!?]/);
  const sentence = match ? match[0].trim() : s;
  if (sentence.length < 30 || sentence.length > 400) return null;
  if (/^story flagged by your sensitivity/i.test(sentence)) return null;
  return sentence;
}

/**
 * Deterministic 16-char hex hash of the SIX story fields that flow
 * into the whyMatters prompt (5 core + description). Cache identity
 * MUST cover every field that shapes the LLM output, or two requests
 * with the same core fields but different descriptions will share a
 * cache entry and the second caller gets prose grounded in the first
 * caller's description (P1 regression caught in PR #3269 review).
 *
 * History:
 *   - pre-v3: 5 fields, sync `node:crypto.createHash`.
 *   - v3: moved to Web Crypto (async), same 5 fields.
 *   - v5 (with endpoint cache bump to brief:llm:whymatters:v5:):
 *     6 fields — `description` added to match the analyst path's
 *     v2 prompt which interpolates `Description: <desc>` between
 *     headline and source.
 *
 * Uses Web Crypto so the module is edge-safe. Returns a Promise because
 * `crypto.subtle.digest` is async; cron call sites are already in an
 * async context so the await is free.
 *
 * @param {{
 *   headline?: string;
 *   source?: string;
 *   threatLevel?: string;
 *   category?: string;
 *   country?: string;
 *   description?: string;
 * }} story
 * @returns {Promise<string>}
 */
export async function hashBriefStory(story) {
  const material = [
    story.headline ?? '',
    story.source ?? '',
    story.threatLevel ?? '',
    story.category ?? '',
    story.country ?? '',
    // New in v5: description is a prompt input on the analyst path,
    // so MUST be part of cache identity. Absent on legacy paths →
    // empty string → deterministic; same-story-same-description pairs
    // still collide on purpose, different descriptions don't.
    story.description ?? '',
  ].join('||');
  const bytes = new TextEncoder().encode(material);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  let hex = '';
  const view = new Uint8Array(digest);
  for (let i = 0; i < view.length; i++) {
    hex += view[i].toString(16).padStart(2, '0');
  }
  return hex.slice(0, 16);
}

// ── Analyst-path prompt v2 (multi-sentence, grounded) ──────────────────────
//
// Shadow-diff on 12 prod stories (2026-04-21) showed the v1 analyst output
// was indistinguishable from the legacy Gemini-only output: identical
// single-sentence abstraction-speak ("destabilize / systemic / sovereign
// risk repricing") with no named actors, metrics, or dates. Root cause:
// the 18–30 word cap compressed the context's specifics out of the LLM's
// response. v2 loosens to 40–70 words across 2–3 sentences and REQUIRES
// the LLM to ground at least one specific reference from the live context.

/**
 * System prompt for the analyst-path v2 (2–3 sentences, ~40–70 words,
 * grounded in a specific named actor / metric / date / place drawn
 * from the live context). Shape nudged toward the WMAnalyst chat voice
 * (SITUATION → ANALYSIS → optional WATCH) but rendered as plain prose,
 * no section labels in the output.
 */
export const WHY_MATTERS_ANALYST_SYSTEM_V2 =
  'You are the lead analyst at WorldMonitor Brief, a geopolitical intelligence magazine. ' +
  'Using the Live WorldMonitor Context AND the story, write 2–3 sentences (40–70 words total) ' +
  'on why the story matters.\n\n' +
  'STRUCTURE:\n' +
  '1. SITUATION — what is happening right now, grounded in a SPECIFIC named actor, ' +
  'metric, date, or place relevant to this story.\n' +
  '2. ANALYSIS — the structural consequence (why this forces a repricing, shifts ' +
  'the balance, triggers a cascade).\n' +
  '3. (Optional) WATCH — the threshold or indicator to track, if clear from the context.\n\n' +
  'HARD CONSTRAINTS:\n' +
  '- Total length 40–70 words across 2–3 sentences.\n' +
  '- MUST reference at least ONE specific: named person / country / organization / ' +
  'number / percentage / date / city.\n' +
  '- No preamble ("This matters because…", "The importance of…").\n' +
  '- No markdown, no bullet points, no section labels in the output — plain prose.\n' +
  '- Editorial, impersonal, serious. No calls to action, no questions, no quotes.\n\n' +
  'RELEVANCE RULE (critical, read carefully):\n' +
  '- The context block may contain facts from world-brief, country-brief, risk scores, ' +
  'forecasts, macro signals, and market data. These are BACKGROUND — only cite what is ' +
  "directly relevant to this story's category and country.\n" +
  '- If NO context fact clearly fits, ground instead in a named actor, place, date, ' +
  'or figure drawn from the headline or description. That is a VALID grounding — do ' +
  'NOT invent a market reading, VIX value, or forecast probability to satisfy the rule.\n' +
  '- NEVER drag an off-topic market metric, FX reading, or probability into a ' +
  'humanitarian, aviation, diplomacy, or cyber story. A story about a refugee flow ' +
  'does not need a VIX number; a story about a drone incursion does not need an FX ' +
  "stress reading. If it isn't editorially connected to the story, leave it out.";

/**
 * Parse + validate the analyst-path v2 LLM response. Accepts
 * multi-sentence output (2–3 sentences), 100–500 chars. Otherwise
 * same rejection semantics as v1 (stub echo, empty) plus explicit
 * rejection of preamble boilerplate and leaked section labels.
 *
 * Returns null when the output is obviously wrong so the caller can
 * fall through to the next layer.
 *
 * @param {unknown} text
 * @returns {string | null}
 */
export function parseWhyMattersV2(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim();
  if (!s) return null;
  // Drop surrounding quotes if the model insisted.
  s = s.replace(/^[\u201C"']+/, '').replace(/[\u201D"']+$/, '').trim();
  if (s.length < 100 || s.length > 500) return null;
  // Reject the stub echo (same as v1).
  if (/^story flagged by your sensitivity/i.test(s)) return null;
  // Reject common preamble the system prompt explicitly banned.
  if (/^(this matters because|the importance of|it is important|importantly,|in summary,|to summarize)/i.test(s)) {
    return null;
  }
  // Reject markdown / section-label leakage (we told it to use plain prose).
  if (/^(#|-|\*|\d+\.\s)/.test(s)) return null;
  if (/^(situation|analysis|watch)\s*[:\-–—]/i.test(s)) return null;
  return s;
}

// ─────────────────────────────────────────────────────────────────────
// Hallucination validator for the brief-paragraph LLM rewrite.
//
// The 2026-05-19 Pro brief shipped "Lebanese President Michel Aoun
// pledged..." against a source headline that contained NO name — just
// "Lebanese president vows to 'do the impossible'..." The current
// Lebanese president is Joseph Aoun, not Michel Aoun. The LLM invented
// the name despite the prompt explicitly forbidding invention.
//
// Prompts that say "do not invent proper nouns" are not enforceable on
// every output. This validator catches inventions mechanically: it
// extracts proper-noun sequences from the LLM summary and verifies
// each appears in the source headline (after acronym + demonym
// normalization). When a sequence in the summary has no matching
// contiguous subsequence in the headline, the summary is rejected.
//
// The caller decides what to do with a rejection. In `seed-insights.mjs`
// the integration path writes `worldBrief = sanitizeTitle(topHeadline)`
// (the headline IS the summary), preserving R1 of the plan:
// "falls back to a safe summary (headline-grounded template) rather
// than publishing the hallucination."
//
// Out of scope (documented in docs/plans/2026-05-19-001 Scope Boundaries):
//   - Source-level fact-checking. If the source headline already
//     contains the wrong name (wire-service typo), this validator OKs
//     the summary and the fallback ships the wrong fact verbatim.
//   - Full NER. The pinned heuristic rules below cover the surface
//     PR-2 needs; deeper NER is deferred.
// ─────────────────────────────────────────────────────────────────────

// Title-prefix stop list — when these words sit immediately before a
// capitalized word, they're consumed but not counted as a proper noun
// themselves. "former President Trump" → ['Trump'], not
// ['former', 'President', 'Trump']. The leading lowercase forms
// ('former', 'ex-') are caught by being lowercase in the first place;
// the capitalized title nouns ('President', 'Prime', 'Minister') need
// the explicit stop list because they LOOK like proper nouns.
const TITLE_PREFIX_STOP = new Set([
  'President', 'Prime', 'Minister', 'Senator', 'Representative',
  'Dr', 'Dr.', 'Mr', 'Mr.', 'Ms', 'Ms.', 'Mrs', 'Mrs.',
  'Acting', 'Interim', 'Former', 'Ex',
  'Chairman', 'Chairwoman', 'Chair', 'Speaker',
  'CEO', 'Secretary', 'Defense', 'Foreign',
  'Ambassador', 'General', 'Admiral', 'Colonel', 'Captain',
  'Pope', 'King', 'Queen', 'Prince', 'Princess',
  'Lord', 'Lady', 'Sir', 'Dame',
  'Judge', 'Justice',
]);

// Joiner words — lowercase tokens that bridge proper-noun sequences.
// "Democratic Republic of Congo" is ONE sequence, not three.
const PROPER_NOUN_JOINER = new Set(['of', 'the', 'and', 'for', 'de', 'du', 'der', 'van', 'el', 'al']);

// Acronym ↔ expansion table (bidirectional). When summary contains
// either form and headline contains the other, treated as equivalent.
// Each entry is a single canonical key + its variants. The lookup is
// hostname-style: build a Set of every form, then map each form to
// its canonical key for equivalence.
const ACRONYM_EXPANSIONS = [
  ['WHO', 'World Health Organization'],
  ['UN', 'United Nations'],
  ['US', 'USA', 'United States', 'United States of America', 'America'],
  ['UK', 'United Kingdom', 'Britain', 'Great Britain'],
  ['EU', 'European Union'],
  ['IDF', 'Israel Defense Forces', 'Israeli Defense Forces'],
  ['IMF', 'International Monetary Fund'],
  ['WTO', 'World Trade Organization'],
  ['NATO', 'North Atlantic Treaty Organization'],
  ['OECD'],
  ['OPEC', 'Organization of the Petroleum Exporting Countries'],
  ['IAEA', 'International Atomic Energy Agency'],
  ['ASEAN'],
  ['ECOWAS'],
  ['BRICS'],
  ['DOJ', 'Department of Justice', 'Justice Department'],
  ['FBI', 'Federal Bureau of Investigation'],
  ['SEC', 'Securities and Exchange Commission'],
  ['CIA', 'Central Intelligence Agency'],
  ['NSA', 'National Security Agency'],
  ['DOD', 'Department of Defense', 'Defense Department', 'Pentagon'],
  ['DR Congo', 'Democratic Republic of Congo', 'DRC'],
  ['UAE', 'United Arab Emirates'],
];

// Demonym ↔ nation table. "Israeli strikes" headline ↔ "Israel struck"
// summary — treated as equivalent.
const DEMONYM_TO_NATION = new Map([
  ['Israeli', 'Israel'], ['Israelis', 'Israel'],
  ['American', 'United States'], ['Americans', 'United States'],
  ['Iranian', 'Iran'], ['Iranians', 'Iran'],
  ['Russian', 'Russia'], ['Russians', 'Russia'],
  ['Chinese', 'China'],
  ['French', 'France'],
  ['German', 'Germany'], ['Germans', 'Germany'],
  ['Japanese', 'Japan'],
  ['Lebanese', 'Lebanon'],
  ['Syrian', 'Syria'], ['Syrians', 'Syria'],
  ['Saudi', 'Saudi Arabia'], ['Saudis', 'Saudi Arabia'],
  ['Egyptian', 'Egypt'], ['Egyptians', 'Egypt'],
  ['Turkish', 'Turkey'], ['Turks', 'Turkey'],
  ['Indian', 'India'], ['Indians', 'India'],
  ['Pakistani', 'Pakistan'], ['Pakistanis', 'Pakistan'],
  ['British', 'United Kingdom'], ['Briton', 'United Kingdom'], ['Britons', 'United Kingdom'],
  ['Ukrainian', 'Ukraine'], ['Ukrainians', 'Ukraine'],
  ['Palestinian', 'Palestine'], ['Palestinians', 'Palestine'],
  ['Yemeni', 'Yemen'], ['Yemenis', 'Yemen'],
  ['Iraqi', 'Iraq'], ['Iraqis', 'Iraq'],
  ['Afghan', 'Afghanistan'], ['Afghans', 'Afghanistan'],
  ['Spanish', 'Spain'],
  ['Italian', 'Italy'], ['Italians', 'Italy'],
  ['Korean', 'Korea'], ['Koreans', 'Korea'],
  ['Vietnamese', 'Vietnam'],
  ['Mexican', 'Mexico'], ['Mexicans', 'Mexico'],
  ['Brazilian', 'Brazil'], ['Brazilians', 'Brazil'],
  ['Canadian', 'Canada'], ['Canadians', 'Canada'],
  ['Australian', 'Australia'], ['Australians', 'Australia'],
  ['Cuban', 'Cuba'], ['Cubans', 'Cuba'],
  ['Venezuelan', 'Venezuela'], ['Venezuelans', 'Venezuela'],
  ['Argentine', 'Argentina'], ['Argentinian', 'Argentina'], ['Argentinians', 'Argentina'],
  ['Polish', 'Poland'],
  ['Dutch', 'Netherlands'],
  ['Greek', 'Greece'], ['Greeks', 'Greece'],
  ['Portuguese', 'Portugal'],
  ['Swiss', 'Switzerland'],
  ['Swedish', 'Sweden'], ['Swedes', 'Sweden'],
  ['Norwegian', 'Norway'], ['Norwegians', 'Norway'],
  ['Finnish', 'Finland'], ['Finns', 'Finland'],
  ['Danish', 'Denmark'], ['Danes', 'Denmark'],
  ['Belgian', 'Belgium'], ['Belgians', 'Belgium'],
  ['Austrian', 'Austria'], ['Austrians', 'Austria'],
  ['Filipino', 'Philippines'], ['Filipinos', 'Philippines'],
  ['Thai', 'Thailand'], ['Thais', 'Thailand'],
  ['Indonesian', 'Indonesia'], ['Indonesians', 'Indonesia'],
  ['Nigerian', 'Nigeria'], ['Nigerians', 'Nigeria'],
  ['Ethiopian', 'Ethiopia'], ['Ethiopians', 'Ethiopia'],
  ['Kenyan', 'Kenya'], ['Kenyans', 'Kenya'],
  ['South Korean', 'South Korea'], ['South Koreans', 'South Korea'],
  ['North Korean', 'North Korea'], ['North Koreans', 'North Korea'],
]);

// Build a normalization map from every variant (acronym OR expansion)
// to a single canonical key. Lookup uses lower-case keys for case-
// insensitive matching.
const ACRONYM_NORMALIZE = (() => {
  const map = new Map();
  for (const group of ACRONYM_EXPANSIONS) {
    const canonical = group[0].toLowerCase();
    for (const variant of group) map.set(variant.toLowerCase(), canonical);
  }
  return map;
})();

const DEMONYM_NORMALIZE = (() => {
  const map = new Map();
  for (const [demonym, nation] of DEMONYM_TO_NATION) {
    map.set(demonym.toLowerCase(), nation.toLowerCase());
  }
  return map;
})();

/**
 * Extract contiguous proper-noun sequences from a text. A sequence is
 * a run of capitalized tokens (length ≥ 1), bridged by joiner words
 * (lowercase 'of', 'the', 'and', etc.). All-caps acronyms (length 2-6)
 * count. Title-prefix stop-list words ('President', 'Senator', 'Dr.',
 * 'former', …) when immediately followed by a capitalized token are
 * consumed but not counted as proper nouns themselves.
 *
 * Returns an array of arrays — each inner array is the token sequence
 * of one proper noun, lower-cased.
 *
 * Examples:
 *   "former President Trump said..."  → [['trump']]
 *   "Democratic Republic of Congo declared"
 *                                     → [['democratic', 'republic', 'of', 'congo']]
 *   "The UN said the EU agreed"       → [['un'], ['eu']]
 *   "Lebanese President Michel Aoun"  → [['michel', 'aoun']]
 *
 * @param {string} text
 * @returns {string[][]}
 */
// Common sentence-start words that LOOK like proper nouns when
// capitalized (sentence-start) but aren't. Lowercase keys; matched
// case-insensitively. The list is conservative — words on it are
// EXCLUSIVELY common nouns / function words / discourse markers.
// Real proper nouns at sentence start ("Trump said...", "Israel
// announced...", "WHO declared...") MUST pass through unfiltered.
const SENTENCE_START_AMBIGUOUS = new Set([
  'the', 'a', 'an',
  'this', 'that', 'these', 'those',
  'it', 'he', 'she', 'they', 'we', 'you', 'i',
  'some', 'many', 'most', 'all', 'few', 'several', 'both', 'each', 'every',
  'other', 'another', 'such', 'any', 'either', 'neither',
  'there', 'here', 'now', 'today', 'yesterday', 'tomorrow',
  'when', 'where', 'while', 'as', 'after', 'before', 'during', 'since', 'until',
  'if', 'because', 'although', 'though', 'unless', 'whether',
  'how', 'why', 'what', 'which', 'whose',
  'no', 'not', 'yes',
  'breaking', 'live', 'updated', 'latest', 'exclusive', 'just',
  'meanwhile', 'however', 'moreover', 'additionally', 'furthermore', 'still',
  'with', 'without', 'on', 'in', 'at', 'by', 'for', 'over', 'under', 'about',
]);

/**
 * Collapse dotted acronyms (`U.S.`, `U.S.A.`, `D.O.J.`) into bare form
 * (`US`, `USA`, `DOJ`) so the tokenizer doesn't split them into single-
 * char tokens that fail the 2-6-char acronym rule. PR #3836 review:
 * a valid summary using common dotted style ("the U.S. announced...")
 * against an expanded headline ("United States imposed...") tokenized
 * to `['U', 'S']` vs `['us']` (canonical) and never matched —
 * false-flagging as hallucination.
 *
 * Match: a capital letter followed by a dot, then at least one more
 * capital-letter-then-optional-dot pair. The second pair commitment
 * prevents a sentence-final initial ("...J.") from false-positiving.
 *
 * Examples:
 *   "the U.S. announced"             → "the US announced"
 *   "U.S.A. delegation"              → "USA delegation"
 *   "FBI raided J.D. Vance's office" → "FBI raided JD Vance's office"
 *   "i.e., these things"             → "i.e., these things"  (lowercase, no match)
 *   "end of sentence."               → "end of sentence."    (single dot, no run)
 */
function normalizeDottedAcronyms(text) {
  return text.replace(/(\b[A-Z]\.(?:[A-Z]\.?)+)/g, (match) => match.replace(/\./g, ''));
}

export function extractProperNounSequences(text) {
  if (typeof text !== 'string' || text.length === 0) return [];

  // Normalize dotted acronyms BEFORE sentence-splitting so "U.S." isn't
  // misread as a sentence boundary or split into ['U', 'S'].
  const preprocessed = normalizeDottedAcronyms(text);

  // Split into sentences so sentence-start handling can run per-sentence.
  const sentences = preprocessed.split(/[.!?]+\s+|\n+/);

  const sequences = [];
  for (const rawSentence of sentences) {
    const sentence = rawSentence.trim();
    if (!sentence) continue;

    // Tokenize: keep alphanumeric runs + apostrophes + hyphens
    // (preserves "Mar-a-Lago", "O'Brien").
    const tokens = sentence.split(/[^\p{L}\p{N}'’-]+/u).filter(Boolean);
    if (tokens.length === 0) continue;

    let current = [];
    let bridgeBuffer = []; // joiners pending — kept only if another proper noun follows
    let firstToken = true;

    for (const token of tokens) {
      // Strip trailing punctuation and possessive 's / ’s so
      // "Beirut's" → "beirut" and "U.S." → "U.S" (handled below).
      let stripped = token.replace(/[.,;:'’]+$/g, '');
      stripped = stripped.replace(/['’]s$/i, '');
      const tokenForLookup = stripped || token;
      const isTitlePrefix = TITLE_PREFIX_STOP.has(stripped);
      const isJoiner = PROPER_NOUN_JOINER.has(token.toLowerCase());
      // Capitalized: at least 2 chars long. Single-letter capitalized
      // tokens are sentence-final initials ("...J.D. Vance was met by Smith
      // and J."), middle initials in names, or "I" (the pronoun, already
      // handled by SENTENCE_START_AMBIGUOUS). None should register as
      // a standalone proper noun.
      const isCapitalized = token.length >= 2 && /^[A-Z]/.test(token);
      const isAllCapsAcronym = /^[A-Z]{2,6}$/.test(token);
      const isAmbiguousSentenceStart = firstToken
        && !isAllCapsAcronym
        && SENTENCE_START_AMBIGUOUS.has(token.toLowerCase());

      // Title-prefix consume — even at sentence start, "Former" /
      // "President" / "Dr." consume without registering.
      if (isTitlePrefix && current.length === 0) {
        firstToken = false;
        continue;
      }

      // Skip ambiguous sentence-starters ("The", "It", "Breaking", …)
      // that LOOK like proper nouns but are common-word capitalization.
      if (isAmbiguousSentenceStart) {
        firstToken = false;
        continue;
      }
      firstToken = false;

      if (isJoiner) {
        if (current.length > 0) bridgeBuffer.push(token.toLowerCase());
        continue;
      }

      if (isCapitalized || isAllCapsAcronym) {
        // Flush pending bridge buffer into current sequence.
        if (current.length > 0 && bridgeBuffer.length > 0) {
          current.push(...bridgeBuffer);
        }
        bridgeBuffer = [];
        // Use the punctuation/possessive-stripped form so "Beirut's"
        // lands as "beirut", matching the headline's "Beirut".
        current.push(tokenForLookup.toLowerCase());
      } else {
        // Lowercase non-joiner — ends current sequence.
        if (current.length > 0) {
          sequences.push(current);
          current = [];
        }
        bridgeBuffer = [];
      }
    }
    if (current.length > 0) sequences.push(current);
  }

  return sequences;
}

/**
 * Normalize a token: if it's a known acronym variant, return the
 * canonical key; otherwise return it unchanged (lower-cased).
 */
function normalizeToken(token) {
  const lower = token.toLowerCase();
  if (ACRONYM_NORMALIZE.has(lower)) return ACRONYM_NORMALIZE.get(lower);
  if (DEMONYM_NORMALIZE.has(lower)) return DEMONYM_NORMALIZE.get(lower);
  return lower;
}

/**
 * Apply the same normalization to a token SEQUENCE: greedy match
 * multi-word acronym expansions ("Democratic Republic of Congo" → 'dr
 * congo' canonical) before single-token normalization. Returns a new
 * sequence (array of canonical tokens).
 */
function normalizeSequence(sequence) {
  const out = [];
  let i = 0;
  while (i < sequence.length) {
    // Try multi-word matches first, longest first (5 → 4 → 3 → 2 tokens).
    let matched = false;
    for (let span = Math.min(5, sequence.length - i); span >= 2; span--) {
      const candidate = sequence.slice(i, i + span).join(' ').toLowerCase();
      if (ACRONYM_NORMALIZE.has(candidate)) {
        out.push(ACRONYM_NORMALIZE.get(candidate));
        i += span;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    // Fall through to single-token normalization.
    out.push(normalizeToken(sequence[i]));
    i += 1;
  }
  return out;
}

/**
 * Validate that every proper noun in `summary` has a matching
 * contiguous subsequence in `headline` (after acronym + demonym
 * normalization). The validator catches LLM-introduced invention.
 *
 * Returns `{ ok: true }` when every summary proper-noun sequence is
 * grounded in the headline, OR when either input is malformed (defensive
 * default — ship the LLM output rather than fall back on confusion).
 *
 * Returns `{ ok: false, hallucinated: [...] }` when at least one
 * summary sequence has no matching contiguous subsequence in the
 * headline. The first such sequence is returned; iterating to find
 * all of them is not necessary for the fallback decision.
 *
 * @param {string} summary - the LLM-rewritten brief paragraph
 * @param {string} headline - the source headline the LLM was given
 * @returns {{ ok: boolean, hallucinated?: string[] }}
 */
export function validateNoHallucinatedProperNouns(summary, headline) {
  // Defensive: malformed inputs return ok (ship the LLM output rather
  // than fall back on confusion). Catches null, undefined, empty
  // string, non-string, and weird unicode.
  if (typeof summary !== 'string' || summary.length === 0) return { ok: true };
  if (typeof headline !== 'string' || headline.length === 0) return { ok: true };

  let summarySequences, headlineSequences;
  try {
    summarySequences = extractProperNounSequences(summary).map(normalizeSequence);
    headlineSequences = extractProperNounSequences(headline).map(normalizeSequence);
  } catch {
    return { ok: true };
  }

  if (summarySequences.length === 0) return { ok: true };

  // For each summary sequence, check whether at least one contiguous
  // subsequence of it appears in some headline sequence.
  for (const summarySeq of summarySequences) {
    let found = false;
    for (const headlineSeq of headlineSequences) {
      if (containsSubsequence(headlineSeq, summarySeq)) {
        found = true;
        break;
      }
      // Also check the reverse: a single-token summary sequence
      // (e.g., ['us']) matches if it appears anywhere in a longer
      // headline sequence.
      if (summarySeq.length === 1 && headlineSeq.includes(summarySeq[0])) {
        found = true;
        break;
      }
    }
    if (!found) {
      return { ok: false, hallucinated: summarySeq };
    }
  }

  return { ok: true };
}

/**
 * Does `haystack` contain `needle` as a contiguous subsequence?
 * Both are token arrays. Order matters; positions must be adjacent.
 */
function containsSubsequence(haystack, needle) {
  if (needle.length === 0) return true;
  if (needle.length > haystack.length) return false;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}
