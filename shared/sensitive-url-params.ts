/**
 * The one list of URL params that must never reach a telemetry vendor:
 * checkout/provisioning secrets, the Business Pro invite, referral codes,
 * Clerk handshake/ticket material, and checkout-funnel codes. Vercel
 * Analytics (secondary-startup.ts) and Umami (analytics.ts) redact these per
 * event. DebugBear RUM reads `location` directly and has no redaction hook,
 * so it waits until none of them is left in the live URL (debugbear-rum.ts).
 *
 * Most of these keys have a deferred reader (referral capture, checkout
 * intent capture, the invite acceptor, the Clerk SDK), so they cannot be
 * stripped from the live URL at boot. STRIPPABLE_AT_BOOT_RE is the subset
 * nobody reads.
 */
export const SENSITIVE_URL_PARAM_RE = /^(token|access_token|id_token|refresh_token|auth_token|invite_token|accept-business-invite|email|user_email|customer_email|license_key|licensekey|subscription_id|payment_id|ref|wm_referral|checkoutproduct|checkoutreferral|checkoutdiscount|checkout_product|checkout_referral|checkout_discount|__clerk[a-z_]*|affonso_referral|discount|coupon|promo|voucher)$/i;

/**
 * Params safe to strip from the live URL at boot: read by nobody.
 * handleCheckoutReturn() only DELETES email/license_key (never branches on
 * them). `__clerk*` is deliberately NOT here: @clerk/clerk-js loads late
 * (scheduleClerkLoad defers it to requestIdleCallback) and reads
 * `__clerk_status` / `__clerk_created_session` / `__clerk_ticket` straight
 * off window.location.href, so stripping them at boot breaks email-link and
 * ticket sign-in in production.
 */
export const STRIPPABLE_AT_BOOT_RE = /^(email|license_key|licensekey)$/i;

/** Delete every key matching `pattern`; true when anything was removed. */
export function scrubParams(params: URLSearchParams, pattern: RegExp): boolean {
  let changed = false;
  for (const key of [...params.keys()]) {
    if (pattern.test(key)) {
      params.delete(key);
      changed = true;
    }
  }
  return changed;
}

/** Scrub key=value pairs from a hash fragment, covering both `#head?k=v` and
 * OAuth-style `#k=v&k2=v2` shapes. Returns the scrubbed fragment (without the
 * leading #), or null when nothing matched. `pattern` is the caller's list:
 * the boot strip uses a much narrower one than the analytics redaction. */
export function scrubHashFragment(fragment: string, pattern: RegExp): string | null {
  const qIndex = fragment.indexOf('?');
  if (qIndex >= 0) {
    const head = fragment.slice(0, qIndex);
    const hashParams = new URLSearchParams(fragment.slice(qIndex + 1));
    if (!scrubParams(hashParams, pattern)) return null;
    const rebuilt = hashParams.toString();
    return rebuilt ? `${head}?${rebuilt}` : head;
  }
  if (!fragment.includes('=') && !fragment.includes('&')) {
    return pattern.test(fragment) ? '' : null;
  }
  const hashParams = new URLSearchParams(fragment);
  return scrubParams(hashParams, pattern) ? hashParams.toString() : null;
}

/** Scrub `pattern` keys from a parsed URL's query and fragment in place. */
export function scrubUrl(parsed: URL, pattern: RegExp): boolean {
  let changed = scrubParams(parsed.searchParams, pattern);
  if (parsed.hash) {
    const scrubbed = scrubHashFragment(parsed.hash.slice(1), pattern);
    if (scrubbed !== null) {
      parsed.hash = scrubbed ? `#${scrubbed}` : '';
      changed = true;
    }
  }
  return changed;
}

/**
 * Remove every sensitive key from `raw`. Returns `raw` itself when nothing
 * matched or it cannot be parsed, so callers can test identity. A relative
 * input resolves against `base` and comes back relative, keeping the same
 * shape as an unredacted value.
 */
export function redactSensitiveUrl(raw: string, base?: string): string {
  if (raw.length === 0) return raw;
  const wasAbsolute = /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//');
  let parsed: URL;
  try {
    parsed = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return raw;
  }
  if (!scrubUrl(parsed, SENSITIVE_URL_PARAM_RE)) return raw;
  const redacted = parsed.toString();
  if (wasAbsolute || !base) return redacted;
  const origin = parsed.origin;
  return redacted.startsWith(origin) ? redacted.slice(origin.length) || '/' : redacted;
}

/** True when `href` still carries any key from the shared sensitive list, in
 * the query string or the fragment. Unparseable or missing input is clean. */
export function urlCarriesSensitiveParams(href: unknown): boolean {
  if (typeof href !== 'string' || href.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return false;
  }
  for (const key of parsed.searchParams.keys()) {
    if (SENSITIVE_URL_PARAM_RE.test(key)) return true;
  }
  return parsed.hash.length > 1 && scrubHashFragment(parsed.hash.slice(1), SENSITIVE_URL_PARAM_RE) !== null;
}

/** How often and how long a URL-reading vendor waits for the deferred
 * consumers (referral/checkout capture after App.init, the invite acceptor
 * after sign-in, the Clerk SDK) to remove their params. */
export const SENSITIVE_URL_RECHECK_MS = 500;
export const SENSITIVE_URL_MAX_WAIT_MS = 20_000;

/**
 * Run `onClean` once `readHref()` no longer carries a sensitive param, or
 * `onGiveUp` if it still does after SENSITIVE_URL_MAX_WAIT_MS. For vendors
 * such as DebugBear RUM that read `location` themselves with no redaction
 * hook: the only way to keep a param out of them is to not load them yet.
 */
export function whenUrlFreeOfSensitiveParams(
  readHref: () => unknown,
  onClean: () => void,
  onGiveUp: () => void,
): void {
  let waited = 0;
  const check = (): void => {
    if (!urlCarriesSensitiveParams(readHref())) {
      onClean();
      return;
    }
    if (waited >= SENSITIVE_URL_MAX_WAIT_MS) {
      onGiveUp();
      return;
    }
    waited += SENSITIVE_URL_RECHECK_MS;
    setTimeout(check, SENSITIVE_URL_RECHECK_MS);
  };
  check();
}

/**
 * Sentry events keep user identity, IP and page state so we can reach the
 * people who hit an error. Credentials stay out: params on the shared
 * SENSITIVE_URL_PARAM_RE list (invite and checkout tokens, Clerk tickets,
 * license keys) are removed from every URL, and credential-named fields are
 * dropped. Scrubs in place so beforeSend callers keep event identity.
 */
const CREDENTIAL_FIELD = /^(?:(?:proxy-)?authorization|(?:set-)?cookie|passw(?:or)?d|secret|client[_-]?secret|private[_-]?key|(?:access|refresh|id|auth|invite|csrf)?[_-]?token|(?:x[_-]?)?api[_-]?key)$/i;
/** Keys whose value is a bare query string or fragment, not a URL around one. */
const QUERY_FIELD = /^(?:query_string|(?:url|http)\.query)$/i;
const FRAGMENT_FIELD = /^(?:url|http)\.fragment$/i;
const ABSOLUTE_URL = /(?:https?|wss?):\/\/[^\s<>"']+/gi;
const RELATIVE_URL = /(^|[\s"'(=])(\/[^\s<>"']*[?#][^\s<>"']*)/g;
const RELATIVE_BASE = 'https://telemetry.invalid';
const MAX_DEPTH = 12;

function scrubQuery(value: string): string {
  const prefix = value.startsWith('?') ? '?' : '';
  const params = new URLSearchParams(value.slice(prefix.length));
  return scrubParams(params, SENSITIVE_URL_PARAM_RE) ? prefix + params.toString() : value;
}

function scrubFragment(value: string): string {
  const prefix = value.startsWith('#') ? '#' : '';
  const scrubbed = scrubHashFragment(value.slice(prefix.length), SENSITIVE_URL_PARAM_RE);
  return scrubbed === null ? value : prefix + scrubbed;
}

function scrubText(value: string, key: string): string {
  if (QUERY_FIELD.test(key)) return scrubQuery(value);
  if (FRAGMENT_FIELD.test(key)) return scrubFragment(value);
  if (!value.includes('?') && !value.includes('#')) return value;
  return value
    .replace(ABSOLUTE_URL, (url) => redactSensitiveUrl(url))
    .replace(RELATIVE_URL, (_, lead: string, url: string) => lead + redactSensitiveUrl(url, RELATIVE_BASE));
}

export function scrubSentryCredentials<T>(value: T): T {
  const seen = new WeakSet<object>();
  function visit(node: object, depth: number): void {
    if (seen.has(node) || depth > MAX_DEPTH) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((item, i) => {
        if (typeof item === 'string') node[i] = scrubText(item, '');
        else if (item && typeof item === 'object') visit(item, depth + 1);
      });
      return;
    }
    const record = node as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const item = record[key];
      if (CREDENTIAL_FIELD.test(key)) delete record[key];
      else if (typeof item === 'string') record[key] = scrubText(item, key);
      else if (Array.isArray(item) && QUERY_FIELD.test(key)) {
        record[key] = item.filter((pair) => !(Array.isArray(pair) && SENSITIVE_URL_PARAM_RE.test(String(pair[0]))));
      } else if (item && typeof item === 'object') visit(item, depth + 1);
    }
  }
  if (value && typeof value === 'object') visit(value, 0);
  return value;
}
