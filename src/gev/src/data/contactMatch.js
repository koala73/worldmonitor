/**
 * Shared identity matching for aircraft contact lookup (`findByQuery`).
 *
 * Voice resolves a spoken or model-supplied identity against the loaded fleet,
 * and the analyst → track_entity handoff feeds it a DISPLAY label — callsign,
 * else registration, else hex. Both aircraft layers scan their own maps, so
 * the precedence and canonicalization live here: two copies of this ranking
 * would drift, and the tie-breaking is exactly what makes the answer stable.
 * @module contactMatch
 */

/**
 * Match strength, strongest first. A lower tier ALWAYS wins regardless of feed
 * order — that is the point: with callsign and registration ranked together, a
 * registration that happened to equal another contact's callsign was resolved
 * by upstream `Map` insertion order, so the same spoken query could follow a
 * different aircraft between polls.
 *
 * Callsign outranks registration at equal strength because the callsign is the
 * identity air traffic uses and the one the operator is most likely saying.
 * @enum {number}
 */
export const CONTACT_MATCH_TIER = Object.freeze({
  HEX_EXACT: 0,
  CALLSIGN_EXACT: 1,
  REGISTRATION_EXACT: 2,
  CALLSIGN_PREFIX: 3,
  REGISTRATION_PREFIX: 4,
  CALLSIGN_SUBSTRING: 5,
  REGISTRATION_SUBSTRING: 6,
  NONE: Number.POSITIVE_INFINITY,
});

/**
 * Reduce an identity to its comparable core: uppercase alphanumerics only.
 *
 * Registrations are written with separators the speaker does not say and the
 * model does not always reproduce — `G-ABCD` / `GABCD`, `05-8152` / `058152`,
 * `N123AB` / `N-123AB`. The DISPLAYED value is never rewritten; only the
 * comparison is canonical.
 * @param {*} value Raw identity text.
 * @returns {string} Canonical form, or '' when there is nothing to compare.
 */
export function canonicalizeContactId(value) {
  return String(value ?? '').replace(/[^a-z0-9]/gi, '').toUpperCase();
}

/**
 * Rank one contact against a query.
 *
 * Hex is checked first and exactly: it is the unique key, so a hex query must
 * never be out-competed by a substring hit elsewhere in the fleet.
 * @param {object} params
 * @param {string} params.query Caller's raw query text.
 * @param {string} [params.hex] Contact's unique transponder address.
 * @param {string} [params.callsign] Contact's callsign, if any.
 * @param {string} [params.registration] Contact's registration, if any.
 * @returns {number} A {@link CONTACT_MATCH_TIER} value; `NONE` when no match.
 */
export function rankContactMatch({ query, hex = '', callsign = '', registration = '' }) {
  const rawQuery = String(query ?? '').trim().toLowerCase();
  if (!rawQuery) return CONTACT_MATCH_TIER.NONE;

  if (String(hex ?? '').trim().toLowerCase() === rawQuery) return CONTACT_MATCH_TIER.HEX_EXACT;

  const callsignText = String(callsign ?? '').trim().toLowerCase();
  // Callsigns carry no separators, so they compare raw — canonicalizing them
  // would silently widen the long-standing callsign contract.
  if (callsignText && callsignText === rawQuery) return CONTACT_MATCH_TIER.CALLSIGN_EXACT;

  const canonicalQuery = canonicalizeContactId(rawQuery);
  const canonicalRegistration = canonicalizeContactId(registration);
  if (canonicalQuery && canonicalRegistration === canonicalQuery) {
    return CONTACT_MATCH_TIER.REGISTRATION_EXACT;
  }

  if (callsignText && callsignText.startsWith(rawQuery)) return CONTACT_MATCH_TIER.CALLSIGN_PREFIX;
  if (canonicalQuery && canonicalRegistration.startsWith(canonicalQuery)) {
    return CONTACT_MATCH_TIER.REGISTRATION_PREFIX;
  }
  if (callsignText && callsignText.includes(rawQuery)) return CONTACT_MATCH_TIER.CALLSIGN_SUBSTRING;
  if (canonicalQuery && canonicalRegistration.includes(canonicalQuery)) {
    return CONTACT_MATCH_TIER.REGISTRATION_SUBSTRING;
  }
  return CONTACT_MATCH_TIER.NONE;
}

/**
 * Should `candidate` replace the best match found so far?
 *
 * Ties are broken on the transponder hex, ascending. The tool this feeds
 * (`track_entity`) is a MUTATION fulfilling "follow that one" — returning an
 * ambiguity for the caller to resolve would cost a round-trip mid-demo, and
 * the model's observed response to a non-ok track result is to retry with
 * different guesses rather than to ask (field session 2026-08-21,
 * 23:48). So the lookup always commits. What it owes the caller is STABILITY:
 * hex is unique and always present, so the same query resolves to the same
 * contact for as long as both are loaded, instead of flipping between polls
 * with feed order. Ambiguity that matters is visible to the operator anyway —
 * the camera moves to a named contact and the card says which.
 * @param {{tier: number, id: string}} candidate Contact just ranked.
 * @param {{tier: number, id: string}|null} incumbent Best match so far.
 * @returns {boolean} True when the candidate should take over.
 */
export function contactMatchWins(candidate, incumbent) {
  if (!candidate || candidate.tier === CONTACT_MATCH_TIER.NONE) return false;
  if (!incumbent) return true;
  if (candidate.tier !== incumbent.tier) return candidate.tier < incumbent.tier;
  return String(candidate.id) < String(incumbent.id);
}
