type IdleCallback = () => void;
type RequestIdleCallback = (cb: IdleCallback, opts?: { timeout: number }) => number;

let vercelAnalyticsScheduled = false;
let dashboardFontsScheduled = false;

/**
 * Run non-critical startup work after the first paint and browser load event,
 * then yield to requestIdleCallback when the browser supports it.
 */
export function scheduleAfterFirstPaint(task: () => void, timeoutMs = 3000): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  let ran = false;
  const runOnce = (): void => {
    if (ran) return;
    ran = true;
    task();
  };

  const scheduleIdle = (): void => {
    const ric = (window as unknown as { requestIdleCallback?: RequestIdleCallback }).requestIdleCallback;
    if (typeof ric === 'function') {
      ric(runOnce, { timeout: timeoutMs });
      return;
    }
    setTimeout(runOnce, 0);
  };

  const afterPaint = (): void => {
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => window.requestAnimationFrame(scheduleIdle));
      return;
    }
    scheduleIdle();
  };

  if (document.readyState === 'complete') {
    afterPaint();
  } else {
    window.addEventListener('load', afterPaint, { once: true });
  }
}

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
    return import.meta.env?.VITE_VARIANT || 'full';
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
          beforeSend: (event) => (Math.random() > 0.1 ? null : event),
        });
      })
      .catch(() => {
        // Analytics is best-effort. Ad blockers/offline users should not affect boot.
      });
  }, 3000);
}

