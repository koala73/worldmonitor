/**
 * Email-domain → BCP 47 primary subtag locale inference.
 *
 * Conservative-by-design: provider Map (high confidence) takes precedence;
 * TLD fallback is intentionally narrow (`.cn`, `.jp`, `.kr`, `.ru` only).
 * Domains like `.fr`, `.de`, `.es`, `.it` are NOT in the TLD list because
 * those audiences include too many English-fluent users to safely exclude
 * from English-language broadcasts.
 *
 * Used by `broadcast/_poolSelection.ts` as a fallback when the canonical
 * `users.localePrimary` value is unavailable for an email (i.e., the
 * registrant predates Clerk-based auth or never authenticated post-launch
 * to populate their `users` row).
 *
 * Returns null on no match — caller should treat null as "unknown,
 * probably English on a US-skewed list."
 */

const PROVIDER_LOCALE: ReadonlyMap<string, string> = new Map([
  // Chinese
  ["qq.com", "zh"],
  ["163.com", "zh"],
  ["126.com", "zh"],
  ["sina.com", "zh"],
  ["sina.com.cn", "zh"],
  ["sohu.com", "zh"],
  ["aliyun.com", "zh"],
  ["139.com", "zh"],
  ["21cn.com", "zh"],
  // Japanese
  ["yahoo.co.jp", "ja"],
  ["docomo.ne.jp", "ja"],
  ["ezweb.ne.jp", "ja"],
  ["softbank.ne.jp", "ja"],
  // Korean
  ["naver.com", "ko"],
  ["daum.net", "ko"],
  ["hanmail.net", "ko"],
  ["kakao.com", "ko"],
  // Russian
  ["yandex.ru", "ru"],
  ["mail.ru", "ru"],
  ["rambler.ru", "ru"],
  ["list.ru", "ru"],
  ["bk.ru", "ru"],
  ["inbox.ru", "ru"],
]);

const TLD_LOCALE: ReadonlyMap<string, string> = new Map([
  ["cn", "zh"],
  ["jp", "ja"],
  ["kr", "ko"],
  ["ru", "ru"],
]);

export function inferLocaleFromEmail(email: string | undefined | null): string | null {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.indexOf("@");
  if (at < 0 || at === trimmed.length - 1) return null;
  const domain = trimmed.slice(at + 1);
  if (!domain.includes(".")) return null;

  // Provider Map wins over TLD fallback (precedence enforced explicitly:
  // yahoo.co.jp resolves via provider lookup, not via the .jp TLD branch).
  const byProvider = PROVIDER_LOCALE.get(domain);
  if (byProvider) return byProvider;

  // Final TLD only (last segment after the last dot).
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  return TLD_LOCALE.get(tld) ?? null;
}
