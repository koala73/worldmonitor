/**
 * Pure address-shape parsing, with NO dependencies.
 *
 * Split out of `emailDomain.ts` (#6335) so the checkout hot path can reuse the
 * one definition of "well-formed address" without importing that module's
 * `mailchecker` dependency — a ~1MB disposable-domain list that builds a Set at
 * module load and has no business on a paying customer's checkout request.
 * `emailDomain.ts` re-exports `extractDomain` from here, so every existing
 * caller and its tests are unaffected.
 */

/**
 * Return the lowercased domain part of an email address, or `null` when the
 * address is malformed. "Malformed" here means: not a string, no `@`, an empty
 * local part, more than one `@`, an empty domain, or whitespace in the domain.
 * Does NOT require a dot in the domain — that is only enforced by
 * `isCorporateDomain` in `emailDomain.ts`.
 */
export function extractDomain(email: string): string | null {
  if (typeof email !== "string") return null;
  const trimmed = email.trim();
  const at = trimmed.indexOf("@");
  // `at <= 0` rejects both "no @" (-1) and an empty local part ("@b.com" -> 0).
  if (at <= 0) return null;
  // Reject a second `@` — "a@b@c" is not a single address.
  if (trimmed.indexOf("@", at + 1) !== -1) return null;
  const domain = trimmed.slice(at + 1).toLowerCase();
  if (domain.length === 0) return null;
  if (/\s/.test(domain)) return null;
  return domain;
}
