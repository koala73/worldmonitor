import { isValid as mailcheckerIsValid } from "mailchecker";
import { extractDomain } from "./emailShape";

// Re-exported so this module stays the address-semantics entry point for
// existing callers, while the pure shape parse lives in a dependency-free
// module the checkout path can import without pulling in `mailchecker` (#6335).
export { extractDomain };

// Free / consumer email providers. A "corporate" domain is, by definition, NOT
// one of these. Kept as the single convex-side source of truth for the
// business-seat invite gate (isCorporateDomain below).
//
// The set is intentionally a copy of the list the enterprise-contact edge
// handler already enforces (`server/worldmonitor/leads/v1/submit-contact.ts`,
// FREE_EMAIL_DOMAINS). The two are NOT wired to a single import on purpose:
// that handler is bundled for the edge/gateway (esbuild via
// scripts/build-sidecar-sebuf.mjs) and must NOT pull in `mailchecker`'s ~1MB
// disposable-domain list, which this module depends on. See the U1 report note.
export const FREE_EMAIL_DOMAINS = new Set<string>([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.fr", "yahoo.co.uk", "yahoo.co.jp",
  "hotmail.com", "hotmail.fr", "hotmail.co.uk", "outlook.com", "outlook.fr",
  "live.com", "live.fr", "msn.com", "aol.com", "icloud.com", "me.com", "mac.com",
  "protonmail.com", "proton.me", "mail.com", "zoho.com", "yandex.com", "yandex.ru",
  "gmx.com", "gmx.net", "gmx.de", "web.de", "mail.ru", "inbox.com",
  "fastmail.com", "tutanota.com", "tuta.io", "hey.com",
  "qq.com", "163.com", "126.com", "sina.com", "foxmail.com",
  "rediffmail.com", "ymail.com", "rocketmail.com",
  "wanadoo.fr", "free.fr", "laposte.net", "orange.fr", "sfr.fr",
  "t-online.de", "libero.it", "virgilio.it",
]);

/**
 * Case-insensitive equality of the two addresses' domains. Returns `false` if
 * either address is malformed (no domain to compare).
 */
export function sameDomain(a: string, b: string): boolean {
  const da = extractDomain(a);
  const db = extractDomain(b);
  return da !== null && db !== null && da === db;
}

/**
 * True only when `email` is well-formed AND its domain is a real corporate
 * domain: not a free/consumer provider, not disposable/temporary, and it
 * contains a dot. This is the gate that makes "same company email" mean a
 * company — used to decide whether a Business owner may invite teammates and
 * whether an invitee's address is acceptable.
 */
export function isCorporateDomain(email: string): boolean {
  const domain = extractDomain(email);
  if (domain === null) return false;
  // A corporate domain must have a TLD (a dot). Bare hostnames ("a@b") fail.
  if (!domain.includes(".")) return false;
  // Free/consumer provider -> not corporate.
  if (FREE_EMAIL_DOMAINS.has(domain)) return false;
  // Disposable / throwaway (or otherwise invalid) -> not corporate.
  // mailchecker.isValid() returns false for disposable and malformed addresses.
  if (!mailcheckerIsValid(email.trim())) return false;
  return true;
}
