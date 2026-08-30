import COUNTRY_NAMES from './country-names.json';
import ISO3_TO_ISO2 from './iso3-to-iso2.json';

/**
 * Resolve an opaque, caller-supplied country designator to ISO 3166-1 alpha-2.
 *
 * Callers that accept a country from an untrusted or non-deterministic source —
 * chiefly the MCP tool layer, where an LLM picks the argument — get one string
 * of unknown kind. It may already be alpha-2 (`IQ`), alpha-3 (`IRQ`), an English
 * name (`Iraq`), or an alias (`UK`, `DRC`, `Burma`). This resolves all of them.
 *
 * It exists because the alternative those callers reached for was
 * `String(x).toUpperCase().slice(0, 2)`, which is silently wrong rather than
 * merely lossy: the downstream proto only enforces `^[A-Z]{2}$`, so a truncated
 * name that happens to yield two letters PASSES validation and returns the wrong
 * country's data. `Iraq` → `IR` answered as Iran, `China` → `CH` as Switzerland,
 * `Israel` → `IS` as Iceland. Only the residue that truncates to something
 * invalid (`''`) ever surfaced as an error (WORLDMONITOR-Y2).
 *
 * Returning `null` for genuinely unresolvable input lets the caller raise a
 * message naming the value, which an agent can act on — unlike a wrong answer.
 *
 * Edge-safe: pure data + string work over two JSON maps, no filesystem reads.
 * The sibling resolvers cannot serve this layer — `shared/country-name-to-iso2.cjs`
 * is CommonJS (and has no alpha-3 step), `scripts/_country-resolver.mjs` reads
 * from disk and needs the caller to have already split iso2/iso3/name apart, and
 * `src/services/country-geometry.ts` is browser-only and built from loaded map
 * geometry.
 */

// Null-prototype copies. Both maps are indexed by a key derived from untrusted
// caller input, and a bare `map[key]` on a normal object reaches the prototype
// chain: `__proto__` returns Object.prototype and `constructor` the Object
// constructor. Both are truthy, so they would satisfy a `if (hit) return hit`
// guard and escape as a NON-STRING despite this module's `string | null`
// signature — landing in `encodeURIComponent(code)` at the call sites.
/**
 * Aliases the generated map lacks. Kept byte-identical to `EXTRA_ALIASES` in
 * `shared/country-name-to-iso2.cjs` — the two resolvers must not diverge, and
 * `tests/mcp-country-code-resolve.test.mts` pins them by enumerating that
 * module's MERGED export rather than the raw JSON (enumerating the JSON is
 * blind to exactly this table, which is how the divergence went unnoticed).
 */
const EXTRA_ALIASES: Record<string, string> = { 'bosnia herzegovina': 'BA' };

const NAME_TO_ISO2: Record<string, string> =
  Object.assign(Object.create(null), COUNTRY_NAMES, EXTRA_ALIASES);
const ISO3_MAP: Record<string, string> = Object.assign(Object.create(null), ISO3_TO_ISO2);

/** The only shape any caller may receive — also the downstream proto's rule. */
const ISO2_PATTERN = /^[A-Z]{2}$/;
const ISO3_PATTERN = /^[A-Z]{3}$/;

/**
 * Last line of defence: every return path funnels through this, so a malformed
 * or regenerated data file can never widen what leaves this module.
 */
function asIso2(value: unknown): string | null {
  return typeof value === 'string' && ISO2_PATTERN.test(value) ? value : null;
}

/**
 * Mirrors the key normalization in `scripts/build-country-names.cjs`, which
 * built `country-names.json`, so lookups land in the same token space.
 *
 * The punctuation class is deliberately WIDER than the builder's: it also folds
 * curly quotes and the backtick. Widening at lookup time is safe in one
 * direction only — keys were written with the narrow ASCII set, so folding more
 * input characters can only map onto an existing key, never invent a new one.
 * It is what makes a pasted `Côte d’Ivoire` (curly apostrophe) resolve the same
 * as `Cote d'Ivoire`. `shared/country-name-to-iso2.cjs` made the same widening;
 * `tests/mcp-country-code-resolve.test.mts` pins the two to agreement.
 */
export function normalizeCountryToken(raw: unknown): string {
  return String(raw ?? '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’‘`.(),/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolve to an uppercase alpha-2 code, or `null` when nothing matches.
 *
 * Ladder order is load-bearing:
 *
 *  1. Name/alias map FIRST, before the bare alpha-2 passthrough. `UK` is a valid
 *     `^[A-Z]{2}$` string but is NOT the ISO code for the United Kingdom (`GB`
 *     is; `UK` is only exceptionally reserved). Passthrough-first would send
 *     `UK` downstream to fail validation or miss. The map is safe to consult
 *     first because `uk` is its ONLY two-character key — pinned by a test — so
 *     this step cannot shadow a legitimate alpha-2 argument.
 *  2. Trailing-parenthetical retry, for historical dual names such as
 *     `Russia (Soviet Union)` and `Myanmar (Burma)`.
 *  3. Bare alpha-2 passthrough (case-insensitive).
 *  4. Alpha-3 map. Runs after the name map because `drc` and `uae` are
 *     three-character ALIASES with no alpha-3 entry; the one three-character key
 *     present in both (`usa`) agrees, so the order is unambiguous.
 */
/** One designator, no parenthetical handling: name/alias, alpha-2, alpha-3. */
function resolveDesignator(value: string): string | null {
  const byName = asIso2(NAME_TO_ISO2[normalizeCountryToken(value)]);
  if (byName) return byName;

  const upper = value.trim().toUpperCase();
  // Shape only, deliberately — do NOT gate this on the codes these two maps
  // happen to contain. They are geojson-derived and incomplete: CX (Christmas
  // Island), TK (Tokelau), BV, SJ, YT, RE, MQ and GP are all real ISO 3166-1
  // codes absent from them, and a membership check rejected every one, turning
  // valid requests the tool schema promises to accept into -32602.
  //
  // Letting an unassigned code like `XX` through is the lesser evil and not
  // what this module guards against: it is not a country, so it cannot produce
  // a WRONG country — it fails honestly downstream. Truncating a NAME to two
  // letters is the bug here, because that yields a valid code for a real,
  // different country.
  if (ISO2_PATTERN.test(upper)) return upper;
  if (ISO3_PATTERN.test(upper)) return asIso2(ISO3_MAP[upper]);
  return null;
}

/**
 * Upper bound on a caller-supplied designator, checked before any regex or
 * Unicode work runs.
 *
 * The parenthetical match below is quadratic in the input length, and the
 * argument comes from an LLM over the network with no length limit of its own:
 * a ~192KB value burned ~46s of Edge CPU per request. NFKD compounds it (U+FDFA
 * expands one character to eighteen) and the `&` pass adds another 5x, all
 * ahead of the regex. One gate closes both. The longest real designator in the
 * shipped data is 32 characters (`democratic republic of the congo`), so this
 * is generous. Mirrors the repo's other untrusted-string caps —
 * `JMESPATH_MAX_EXPR_BYTES` (api/mcp/constants.ts) and `MAX_JSON_RPC_ID_BYTES`
 * (api/mcp/handler.ts).
 */
const MAX_DESIGNATOR_LENGTH = 128;

export function resolveCountryCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_DESIGNATOR_LENGTH) return null;

  const whole = resolveDesignator(trimmed);
  if (whole) return whole;

  // Trailing parenthetical. The earlier version simply DISCARDED it and kept
  // the base name, which reproduced the very bug this module exists to fix:
  // `Congo (DRC)` answered as CG (Republic of the Congo) and `China (Taiwan)`
  // as CN. In curated feed data the parenthetical is a historical alias
  // (`Russia (Soviet Union)`); in caller text it is usually a DISAMBIGUATOR,
  // and the two readings point at different countries.
  const parenthetical = trimmed.match(/^([^(]*)\s*\(([^)]*)\)$/);
  if (!parenthetical) return null;
  const base = (parenthetical[1] ?? '').trim();
  const inner = (parenthetical[2] ?? '').trim();
  if (!base || !inner) return resolveDesignator(base || inner);

  // Two sides that each NAME a different country make the input ambiguous, and
  // this must be decided before recombination: the name map holds composite
  // keys that are territorial claims rather than names (`morocco western
  // sahara` -> MA), so `Western Sahara (Morocco)` would otherwise recombine
  // onto Morocco and silently answer for the wrong country — the exact class
  // this module exists to close, on a disputed territory.
  //
  // Compare NAME-map hits only, never resolveDesignator: its bare alpha-2
  // passthrough makes a two-letter modifier like `DR` self-resolve, which would
  // read `Congo (DR)` as a disagreement and reject a valid designator.
  const baseName = asIso2(NAME_TO_ISO2[normalizeCountryToken(base)]);
  const innerName = asIso2(NAME_TO_ISO2[normalizeCountryToken(inner)]);
  if (baseName && innerName && baseName !== innerName) return null;

  // A recombination that lands on an exact key in the curated name map names a
  // single country. This turns `Samoa (American)` into AS, `Sudan (South)` into
  // SS and `Guinea (Equatorial)` into GQ instead of their larger neighbours.
  //
  // Try every insertion position, not just the two ends: the parenthetical is
  // often a token lifted from the MIDDLE of the name, so `congo rep (dem)`
  // reassembles only as `congo dem rep` (CD) and appending it would have left
  // the answer at CG. Any exact key hit is that country by definition, and the
  // one family of keys where that is not true — composite territorial claims
  // like `morocco western sahara` — is already rejected by the gate above.
  // Bounded work: the input is length-capped, so this is a handful of lookups.
  const baseTokens = normalizeCountryToken(base).split(' ').filter(Boolean);
  const innerToken = normalizeCountryToken(inner);
  for (let at = 0; at <= baseTokens.length; at++) {
    const combined = [...baseTokens.slice(0, at), innerToken, ...baseTokens.slice(at)].join(' ');
    const hit = asIso2(NAME_TO_ISO2[combined]);
    if (hit) return hit;
  }

  const fromInner = resolveDesignator(inner);
  const fromBase = resolveDesignator(base);
  // Both sides naming a country is only meaningful when they agree
  // (`GB (United Kingdom)`, `Iraq (IQ)`). When they disagree the input is
  // genuinely ambiguous — say so rather than picking one and being wrong.
  if (fromInner && fromBase) return fromInner === fromBase ? fromInner : null;
  return fromInner ?? fromBase ?? null;
}
