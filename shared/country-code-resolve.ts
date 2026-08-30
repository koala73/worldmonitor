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

const NAME_TO_ISO2: Record<string, string> = COUNTRY_NAMES;
const ISO3_MAP: Record<string, string> = ISO3_TO_ISO2;

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
export function resolveCountryCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const direct = NAME_TO_ISO2[normalizeCountryToken(trimmed)];
  if (direct) return direct;

  const stripped = trimmed.replace(/\s*\([^)]*\)\s*$/, '');
  if (stripped !== trimmed) {
    const viaStripped = NAME_TO_ISO2[normalizeCountryToken(stripped)];
    if (viaStripped) return viaStripped;
  }

  const upper = trimmed.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper)) return upper;
  if (/^[A-Z]{3}$/.test(upper)) return ISO3_MAP[upper] ?? null;

  return null;
}
