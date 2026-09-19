import { scheduleAfterFirstPaint } from '@/utils/after-paint';
import type { BeforeSendEvent } from '@vercel/analytics';

let vercelAnalyticsScheduled = false;
let dashboardFontsScheduled = false;

export interface DashboardFontContext {
  variant?: string | null;
  lang?: string | null;
  dir?: string | null;
}

export type DashboardFontFamily = 'nunito' | 'tajawal';

// Which web-font families the dashboard actually needs for a given variant/locale.
// The default (full variant, LTR/non-Arabic) needs none — its body font is the
// system/mono stack — so those users download zero web fonts.
export function dashboardFontFamilies(context: DashboardFontContext = {}): DashboardFontFamily[] {
  const variant = (context.variant || 'full').toLowerCase();
  const lang = (context.lang || 'en').split('-')[0]?.toLowerCase() || 'en';
  const dir = (context.dir || '').toLowerCase();
  const families: DashboardFontFamily[] = [];

  if (variant === 'happy') families.push('nunito');             // happy theme body font
  if (dir === 'rtl' || lang === 'ar') families.push('tajawal'); // Arabic body font

  return families;
}

// Self-hosted @fontsource loaders — Vite bundles these to hashed /assets/*.woff2,
// served immutable (vercel.json) and therefore cached at the CDN/Cloudflare edge
// (unlike fonts.gstatic.com, a third-party origin). Each family pulls only the
// weights the UI actually uses.
const DASHBOARD_FONT_LOADERS: Record<DashboardFontFamily, () => Promise<unknown>> = {
  nunito: () => Promise.all([
    import('@fontsource/nunito/400.css'),
    import('@fontsource/nunito/600.css'),
    import('@fontsource/nunito/700.css'),
    import('@fontsource/nunito/400-italic.css'),
  ]),
  tajawal: () => Promise.all([
    import('@fontsource/tajawal/400.css'),
    import('@fontsource/tajawal/500.css'),
    import('@fontsource/tajawal/700.css'),
  ]),
};

function getBuildVariant(): string {
  try {
    return import.meta.env.VITE_VARIANT || 'full';
  } catch {
    return 'full';
  }
}

let dashboardFontsLoaded = false;

function loadDeferredDashboardFonts(): void {
  if (typeof document === 'undefined' || dashboardFontsLoaded) return;

  const root = document.documentElement;
  const families = dashboardFontFamilies({
    variant: root.dataset.variant || getBuildVariant(),
    lang: root.lang || 'en',
    dir: root.dir || '',
  });
  if (families.length === 0) return;

  dashboardFontsLoaded = true;
  void Promise.all(families.map((family) => DASHBOARD_FONT_LOADERS[family]())).catch(() => {
    // Self-hosted fonts are best-effort; the system fallback stack covers failures.
  });
}

export function initDeferredDashboardFonts(): void {
  if (dashboardFontsScheduled) return;
  dashboardFontsScheduled = true;
  scheduleAfterFirstPaint(loadDeferredDashboardFonts, 3000);
}

export function initVercelAnalytics(): void {
  if (vercelAnalyticsScheduled || typeof window === 'undefined') return;
  vercelAnalyticsScheduled = true;
  scheduleAfterFirstPaint(() => {
    void import('@vercel/analytics')
      .then(({ inject }) => {
        inject({
          beforeSend: (event) => {
            const redacted = redactAnalyticsUrl(event);
            // Sampling is a cost control, not a privacy control — the
            // redaction above must hold for every sampled event.
            return Math.random() > 0.1 ? null : redacted;
          },
        });
      })
      .catch(() => {
        // Analytics is best-effort. Ad blockers/offline users should not affect boot.
      });
  }, 3000);
}

/**
 * Query keys that must never reach Vercel Analytics: checkout/provisioning
 * secrets, the Business Pro invite token, referral codes, Clerk handshake
 * material, and checkout-funnel params (discount/referral codes). Vercel's
 * beforeSend exists to redact event.url before ingest; sampling does not.
 *
 * This is the ANALYTICS-ONLY list. The boot-time live-URL strip below uses a
 * much narrower list: anything a deferred consumer still needs to read
 * (referral codes, checkout-intent params, invite tokens, Dodo IDs) must
 * survive until that consumer runs, so it can never be stripped at boot.
 */
const SENSITIVE_ANALYTICS_QUERY_RE = /^(token|access_token|id_token|refresh_token|auth_token|invite_token|accept-business-invite|email|user_email|customer_email|license_key|licensekey|subscription_id|payment_id|ref|wm_referral|checkoutproduct|checkoutreferral|checkoutdiscount|checkout_product|checkout_referral|checkout_discount|__clerk[a-z_]*|affonso_referral|discount|coupon|promo|voucher)$/i;

const SENSITIVE_ANALYTICS_HASH_RE = /^(token|access_token|id_token|refresh_token|__clerk[a-z_]*|email|license_key)$/i;

/**
 * Params safe to strip from the live URL at boot: read by nobody.
 * handleCheckoutReturn() only DELETES email/license_key (never branches on
 * them), and no other deferred consumer reads Clerk handshake material —
 * so removing these before analytics/RUM init cannot break referral
 * capture, checkout-intent resume, the invite acceptor, or Dodo returns.
 */
const STRIPPABLE_AT_BOOT_RE = /^(email|license_key|licensekey|__clerk[a-z_]*)$/i;

function scrubUrlSearchParams(parsed: URL, pattern: RegExp): boolean {
  let changed = false;
  for (const key of [...parsed.searchParams.keys()]) {
    if (pattern.test(key)) {
      parsed.searchParams.delete(key);
      changed = true;
    }
  }
  return changed;
}

/** Scrub secret-bearing key=value pairs from a hash fragment, covering both
 * `#head?k=v` and OAuth-style `#k=v&k2=v2` shapes. Returns the scrubbed
 * fragment (without the leading #), or null when nothing was sensitive. */
function scrubHashFragment(fragment: string): string | null {
  const qIndex = fragment.indexOf('?');
  if (qIndex >= 0) {
    const head = fragment.slice(0, qIndex);
    const hashParams = new URLSearchParams(fragment.slice(qIndex + 1));
    let hashChanged = false;
    for (const key of [...hashParams.keys()]) {
      if (SENSITIVE_ANALYTICS_QUERY_RE.test(key) || SENSITIVE_ANALYTICS_HASH_RE.test(key)) {
        hashParams.delete(key);
        hashChanged = true;
      }
    }
    if (!hashChanged) return null;
    const rebuilt = hashParams.toString();
    return rebuilt ? `${head}?${rebuilt}` : head;
  }
  // No '?' — OAuth implicit-flow style `#access_token=..&token_type=..`.
  if (!fragment.includes('=') && !fragment.includes('&')) {
    return SENSITIVE_ANALYTICS_HASH_RE.test(fragment) ? '' : null;
  }
  const hashParams = new URLSearchParams(fragment);
  let hashChanged = false;
  for (const key of [...hashParams.keys()]) {
    if (SENSITIVE_ANALYTICS_QUERY_RE.test(key) || SENSITIVE_ANALYTICS_HASH_RE.test(key)) {
      hashParams.delete(key);
      hashChanged = true;
    }
  }
  return hashChanged ? hashParams.toString() : null;
}

export function redactAnalyticsUrl(event: BeforeSendEvent): BeforeSendEvent {
  const raw = event.url;
  if (typeof raw !== 'string' || raw.length === 0) return event;
  let parsed: URL;
  try {
    // Relative analytics URLs resolve against the current origin in the
    // browser; without a window (tests) only absolute URLs parse, which is
    // all production pageview events carry. Deliberately no hardcoded
    // parse-base host here: a literal would read as a fetched host to the
    // source-attribution scanner and stale the manifest.
    const base = typeof window !== 'undefined' ? window.location.origin : undefined;
    parsed = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return event;
  }
  let changed = scrubUrlSearchParams(parsed, SENSITIVE_ANALYTICS_QUERY_RE);
  if (parsed.hash) {
    const scrubbed = scrubHashFragment(parsed.hash.slice(1));
    if (scrubbed !== null) {
      parsed.hash = scrubbed ? `#${scrubbed}` : '';
      changed = true;
    }
  }
  if (!changed) return event;
  const redacted = parsed.toString();
  // Strip the parse-only base when the test path resolved a relative URL
  // against the current origin — absolute production URLs pass through.
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const url = origin && redacted.startsWith(origin) ? redacted.slice(origin.length) || '/' : redacted;
  return { ...event, url };
}

/**
 * Strip unread secret params from the live URL at startup — runs from main.ts
 * before analytics/RUM init, not after App.init's network awaits. Only keys
 * no deferred consumer reads (STRIPPABLE_AT_BOOT_RE): referral codes,
 * checkout-intent params, invite tokens, and Dodo IDs must survive until
 * captureReferralFromUrl / capturePendingCheckoutIntentFromUrl / the invite
 * acceptor / handleCheckoutReturn run, and those consumers delete their own
 * params afterwards. This is the early backstop so RUM pageviews can never
 * carry the unread secrets; the per-event beforeSend above covers the rest.
 */
export function stripSensitiveParamsFromUrl(): void {
  if (typeof window === 'undefined') return;
  let url: URL;
  try {
    url = new URL(window.location.href);
  } catch {
    return;
  }
  let changed = scrubUrlSearchParams(url, STRIPPABLE_AT_BOOT_RE);
  if (url.hash) {
    const scrubbed = scrubHashFragment(url.hash.slice(1));
    if (scrubbed !== null) {
      url.hash = scrubbed ? `#${scrubbed}` : '';
      changed = true;
    }
  }
  if (!changed) return;
  const clean = url.pathname
    + (url.searchParams.toString() ? `?${url.searchParams.toString()}` : '')
    + url.hash;
  try {
    window.history.replaceState({}, '', clean);
  } catch {
    // History API unavailable (extreme embed/iframe cases).
  }
}

export function resetVercelAnalyticsForTesting(): void {
  vercelAnalyticsScheduled = false;
}
