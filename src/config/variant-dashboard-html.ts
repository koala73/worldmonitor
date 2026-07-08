import { VARIANT_META, type VariantMeta } from './variant-meta';

// Variants that are served from their own worldmonitor.app subdomain by the
// single web deployment (vercel.json host-based rewrites map
// <variant>.worldmonitor.app/dashboard → /dashboard-<variant>.html).
// Desktop/self-host variant builds are NOT in scope — they run
// htmlVariantPlugin at build time with VITE_VARIANT set.
export const WEB_DASHBOARD_VARIANTS = ['tech', 'finance', 'commodity', 'happy', 'energy'] as const;

export function variantDashboardFileName(variant: string): string {
  return `dashboard-${variant}.html`;
}

// HTML-escape for text content and double-quoted attribute values (same
// contexts as middleware.ts escHtml — VARIANT_META values are hand-edited
// prose; '&' already occurs in the tech title).
function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface CountBounds {
  min: number;
  max: number;
}

// Replace with occurrence-count assertion. The web deploy serves the 'full'
// build to every host, so the variant HTML is derived from the BUILT
// dist/dashboard.html — if index.html or htmlVariantPlugin drift and an
// anchor stops matching, the build must fail loudly rather than silently
// shipping full-brand meta on variant subdomains again (#4996).
function replaceCounted(
  html: string,
  pattern: RegExp,
  replacer: (...groups: string[]) => string,
  bounds: CountBounds,
  label: string,
): string {
  let count = 0;
  const result = html.replace(pattern, (...args) => {
    count += 1;
    // drop the offset/whole-string trailing args; keep match + capture groups
    const groups = args.slice(0, -2) as string[];
    return replacer(...groups);
  });
  if (count < bounds.min || count > bounds.max) {
    throw new Error(
      `[variant-dashboard-html] anchor "${label}" matched ${count} time(s), expected ${bounds.min}..${bounds.max} — dist/dashboard.html markup drifted; update src/config/variant-dashboard-html.ts`,
    );
  }
  return result;
}

const ONE: CountBounds = { min: 1, max: 1 };
const TWO: CountBounds = { min: 2, max: 2 };

// Derive a variant subdomain dashboard page from the built full-variant
// dashboard.html. Only identity/meta surfaces change: title/description/
// keywords/subject/classification metas, canonical + hreflang cluster,
// og/twitter cards, the WebApplication JSON-LD block, and the visually
// hidden <h1>. The Organization/WebSite JSON-LD blocks intentionally keep
// the World Monitor identity (each variant isPartOf World Monitor — same
// modelling as the middleware.ts crawler stub).
export function renderVariantDashboardHtml(fullDashboardHtml: string, variant: string): string {
  const meta: VariantMeta | undefined = VARIANT_META[variant];
  if (!meta || variant === 'full') {
    throw new Error(`[variant-dashboard-html] unknown web dashboard variant "${variant}"`);
  }
  const origin = new URL(meta.url).origin;
  const ogImage = `${origin}/favico/${variant}/og-image.png`;

  let html = fullDashboardHtml;

  // Titles
  html = replaceCounted(html, /(<title>)[^<]*(<\/title>)/g, (_m, a, b) => `${a}${escHtml(meta.title)}${b}`, ONE, '<title>');
  html = replaceCounted(html, /(<meta name="title" content=")[^"]*(" \/>)/g, (_m, a, b) => `${a}${escHtml(meta.title)}${b}`, ONE, 'meta title');
  html = replaceCounted(html, /(<meta property="og:title" content=")[^"]*(" \/>)/g, (_m, a, b) => `${a}${escHtml(meta.title)}${b}`, ONE, 'og:title');
  html = replaceCounted(html, /(<meta name="twitter:title" content=")[^"]*(" \/>)/g, (_m, a, b) => `${a}${escHtml(meta.title)}${b}`, ONE, 'twitter:title');

  // Descriptions + keywords + subject/classification
  html = replaceCounted(html, /(<meta name="description" content=")[^"]*(" \/>)/g, (_m, a, b) => `${a}${escHtml(meta.description)}${b}`, ONE, 'meta description');
  html = replaceCounted(html, /(<meta property="og:description" content=")[^"]*(" \/>)/g, (_m, a, b) => `${a}${escHtml(meta.description)}${b}`, ONE, 'og:description');
  html = replaceCounted(html, /(<meta name="twitter:description" content=")[^"]*(" \/>)/g, (_m, a, b) => `${a}${escHtml(meta.description)}${b}`, ONE, 'twitter:description');
  html = replaceCounted(html, /(<meta name="keywords" content=")[^"]*(" \/>)/g, (_m, a, b) => `${a}${escHtml(meta.keywords)}${b}`, ONE, 'meta keywords');
  html = replaceCounted(html, /(<meta name="subject" content=")[^"]*(" \/>)/g, (_m, a, b) => `${a}${escHtml(meta.subject)}${b}`, ONE, 'meta subject');
  html = replaceCounted(html, /(<meta name="classification" content=")[^"]*(" \/>)/g, (_m, a, b) => `${a}${escHtml(meta.classification)}${b}`, ONE, 'meta classification');

  // Site name (og:site_name + application-name)
  html = replaceCounted(
    html,
    /(<meta (?:property="og:site_name"|name="application-name") content=")[^"]*(" \/>)/g,
    (_m, a, b) => `${a}${escHtml(meta.siteName)}${b}`,
    TWO,
    'site name metas',
  );

  // Canonical + URL cards — the core #4996 fix: the page must self-canonicalize
  // on its own subdomain instead of pointing crawlers back at www.
  html = replaceCounted(html, /(<link rel="canonical" href=")[^"]*(" \/>)/g, (_m, a, b) => `${a}${escHtml(meta.url)}${b}`, ONE, 'canonical');
  html = replaceCounted(html, /(<meta property="og:url" content=")[^"]*(" \/>)/g, (_m, a, b) => `${a}${escHtml(meta.url)}${b}`, ONE, 'og:url');
  html = replaceCounted(html, /(<meta name="twitter:url" content=")[^"]*(" \/>)/g, (_m, a, b) => `${a}${escHtml(meta.url)}${b}`, ONE, 'twitter:url');

  // hreflang cluster: alternates of THIS page live on the same subdomain;
  // preserve the ?lang= suffix per entry.
  html = replaceCounted(
    html,
    /(<link rel="alternate" hreflang="[^"]+" href=")https:\/\/www\.worldmonitor\.app\/dashboard((?:\?[^"]*)?" \/>)/g,
    (_m, a, b) => `${a}${escHtml(meta.url)}${b}`,
    { min: 1, max: 80 },
    'hreflang alternates',
  );

  // Social card images (per-variant OG assets exist under public/favico/<variant>/,
  // same files middleware.ts VARIANT_OG points at).
  html = replaceCounted(
    html,
    /(<meta (?:property="og:image"|name="twitter:image") content=")[^"]*(" \/>)/g,
    (_m, a, b) => `${a}${escHtml(ogImage)}${b}`,
    TWO,
    'og/twitter image',
  );

  // WebApplication JSON-LD block: name, url, screenshot, featureList.
  html = replaceCounted(
    html,
    /("@type": "WebApplication",\s*"name": )"[^"]*"/g,
    (_m, a) => `${a}${JSON.stringify(meta.siteName)}`,
    ONE,
    'WebApplication name',
  );
  html = replaceCounted(
    html,
    /("@type": "WebApplication",[\s\S]{0,600}?"url": )"[^"]*"/g,
    (_m, a) => `${a}${JSON.stringify(meta.url)}`,
    ONE,
    'WebApplication url',
  );
  html = replaceCounted(html, /("screenshot": )"[^"]*"/g, (_m, a) => `${a}${JSON.stringify(ogImage)}`, ONE, 'WebApplication screenshot');
  html = replaceCounted(
    html,
    /("featureList": )\[[\s\S]*?\]/g,
    (_m, a) => `${a}${JSON.stringify(meta.features, null, 8).replace(/\n/g, '\n      ')}`,
    ONE,
    'WebApplication featureList',
  );

  // Visually-hidden <h1> — the topic signal crawlers read on this page.
  html = replaceCounted(html, /(<h1 class="app-heading">)[^<]*(<\/h1>)/g, (_m, a, b) => `${a}${escHtml(meta.title)}${b}`, ONE, 'app-heading h1');

  return html;
}
