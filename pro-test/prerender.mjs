#!/usr/bin/env node
/**
 * Postbuild prerender script — injects critical SEO content into the built HTML
 * so search engines see real content without executing JavaScript.
 *
 * Reads only keys that exist in pro-test/src/locales/en.json. If you remove a
 * key, also remove it here, otherwise the build will inject the literal string
 * "undefined" into the page that crawlers index.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const __dirname = dirname(fileURLToPath(import.meta.url));

const en = JSON.parse(readFileSync(resolve(__dirname, 'src/locales/en.json'), 'utf-8'));
const STATIC_SCRIPT_NONCE = 'wm-static-bootstrap';

// Single source of truth for the brand's cross-site entity links + Organization
// structured data, injected into BOTH pro pages (see PAGES) so the homepage and
// /pro can't drift. Nonce'd to match the static-bootstrap CSP trust (otherwise
// deploy-config.test.mjs would demand a script-src sha256 hash for it).
const WM_SAMEAS = [
  'https://github.com/koala73/worldmonitor',
  'https://www.npmjs.com/package/worldmonitor',
  'https://x.com/worldmonitorai',
  'https://x.com/eliehabib',
  'https://discord.gg/re63kWKxaz',
  'https://www.wired.com/story/world-monitor-elie-habib/',
];
const ORGANIZATION_JSONLD = `    <script type="application/ld+json" nonce="${STATIC_SCRIPT_NONCE}">${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'World Monitor',
  alternateName: 'WorldMonitor',
  url: 'https://www.worldmonitor.app/',
  logo: 'https://www.worldmonitor.app/favico/apple-touch-icon.png',
  description: 'Open-source real-time global intelligence platform aggregating conflicts, military movements, markets, infrastructure, and geopolitical data. Used by 2M+ people across 190+ countries.',
  founder: {
    '@type': 'Person',
    name: 'Elie Habib',
    url: 'https://x.com/eliehabib',
    sameAs: [
      'https://x.com/eliehabib',
      'https://github.com/koala73',
      'https://www.linkedin.com/in/elie-habib-7047b931',
      'https://www.wikidata.org/wiki/Q121365724',
      'https://www.crunchbase.com/person/elie-habib-2',
    ],
  },
  sameAs: WM_SAMEAS,
  contactPoint: {
    '@type': 'ContactPoint',
    contactType: 'customer support',
    email: 'support@worldmonitor.app',
    url: 'https://www.worldmonitor.app/pro',
    availableLanguage: 'English',
  },
  address: {
    '@type': 'PostalAddress',
    addressLocality: 'Dubai',
    addressCountry: 'AE',
  },
})}</script>`;
const DASHBOARD_SCREENSHOT_BASENAME = 'worldmonitor-7-mar-2026';
const DASHBOARD_SCREENSHOT_ASSETS = [
  { filenamePrefix: DASHBOARD_SCREENSHOT_BASENAME, extension: '.jpg' },
  { filenamePrefix: DASHBOARD_SCREENSHOT_BASENAME + '-640', extension: '.avif' },
  { filenamePrefix: DASHBOARD_SCREENSHOT_BASENAME + '-960', extension: '.avif' },
  { filenamePrefix: DASHBOARD_SCREENSHOT_BASENAME + '-1280', extension: '.avif' },
  { filenamePrefix: DASHBOARD_SCREENSHOT_BASENAME + '-640', extension: '.webp' },
  { filenamePrefix: DASHBOARD_SCREENSHOT_BASENAME + '-960', extension: '.webp' },
  { filenamePrefix: DASHBOARD_SCREENSHOT_BASENAME + '-1280', extension: '.webp' },
];

// This inline critical CSS is UNLAYERED, so it wins the cascade over the
// full Tailwind stylesheet (which lives in @layer utilities) regardless of
// specificity/media -- even after the deferred sheet loads. That means any
// `hidden <bp>:<display>` reveal (e.g. `hidden md:flex` nav rows, `hidden
// sm:block`) must ALSO be re-shown here in the matching @media block, or the
// unlayered `nav .hidden`/`main .hidden` rules keep those elements hidden at
// ALL widths (regressed the pro/welcome desktop nav in #4603; see the
// `nav [class~="md:flex"]`/`main [class~="sm:block"]` reveals below).
const CRITICAL_CSS = [
  ':root{--font-sans:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;--font-mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;--font-display:system-ui,sans-serif;--color-wm-bg:#050505;--color-wm-card:#111;--color-wm-border:#222;--color-wm-green:#4ade80;--color-wm-blue:#60a5fa;--color-wm-text:#f3f4f6;--color-wm-muted:#9ca3af}',
  '*,::before,::after{box-sizing:border-box;border:0 solid #222}html{background:#050505;color:#f3f4f6;-webkit-text-size-adjust:100%;tab-size:4}body{margin:0;background:#050505;color:#f3f4f6;font-family:var(--font-sans);line-height:1.5;-webkit-font-smoothing:antialiased}a{color:inherit;text-decoration:none}img,svg{display:block;vertical-align:middle}img{max-width:100%;height:auto}h1,h2,h3,p{margin:0}',
  '#root,#root>div{min-height:100vh}.glass-panel{background:rgba(17,17,17,.7);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid #222}.text-glow{text-shadow:0 0 20px rgba(74,222,128,.3)}.border-glow{box-shadow:0 0 20px rgba(74,222,128,.1)}',
  'nav{position:fixed;top:0;left:0;right:0;z-index:50;background:rgba(17,17,17,.7);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid #222;border-inline-width:0;border-bottom-width:0}nav>div{max-width:80rem;margin-inline:auto;padding-inline:1rem;height:4rem;display:flex;align-items:center;justify-content:space-between;gap:.75rem}nav a{display:flex;align-items:center;gap:.5rem}nav a[aria-label*="Launch"]{flex-shrink:0;background:#4ade80;color:#050505;padding:.5rem .75rem;border-radius:.25rem;font:700 .75rem/1 ui-monospace,SFMono-Regular,monospace;text-transform:uppercase;letter-spacing:.025em}nav .hidden{display:none}nav [class~=font-display]{font-family:var(--font-display);font-weight:700}nav [class~=text-wm-muted],main [class~=text-wm-muted]{color:#9ca3af}nav [class~=text-wm-green],main [class~=text-wm-green]{color:#4ade80}nav [class~=text-wm-blue]{color:#60a5fa}',
  'main>section:first-child{position:relative;overflow:hidden;padding:7rem 1rem 4rem}main>section:first-child>div:first-child{position:absolute;inset:0;background:radial-gradient(circle at 50% 0%,rgba(74,222,128,.10) 0%,transparent 55%);pointer-events:none}main>section:first-child>div:nth-child(2){position:relative;z-index:10;max-width:64rem;margin-inline:auto;text-align:center}main h1{font-family:var(--font-display);font-weight:700;font-size:2.25rem;line-height:1.08;letter-spacing:-.025em}main p{margin:1.5rem auto 0;max-width:42rem;color:#9ca3af;font-size:1rem;line-height:1.5}',
  'main [class~=relative]{position:relative}main [class~=absolute]{position:absolute}main [class~=inset-0]{inset:0}main [class~=z-10]{z-index:10}main [class~=pointer-events-none]{pointer-events:none}main [class~=flex]{display:flex}main [class~=inline-flex]{display:inline-flex}main [class~=grid]{display:grid}main [class~=block]{display:block}main .hidden{display:none}main [class~=items-center]{align-items:center}main [class~=items-stretch]{align-items:stretch}main [class~=justify-center]{justify-content:center}main [class~=justify-between]{justify-content:space-between}main [class~=flex-col]{flex-direction:column}main [class~=flex-wrap]{flex-wrap:wrap}main [class~=grid-cols-2]{grid-template-columns:repeat(2,minmax(0,1fr))}',
  'main [class~=mx-auto]{margin-inline:auto}main [class~=mt-1]{margin-top:.25rem}main [class~=mt-3]{margin-top:.75rem}main [class~=mt-6]{margin-top:1.5rem}main [class~=mt-8]{margin-top:2rem}main [class~=mt-9]{margin-top:2.25rem}main [class~=mt-10]{margin-top:2.5rem}main [class~=mb-5]{margin-bottom:1.25rem}main [class~=gap-1]{gap:.25rem}main [class~=gap-2]{gap:.5rem}main [class~=gap-3]{gap:.75rem}main [class~=gap-4]{gap:1rem}main [class~=gap-x-6]{column-gap:1.5rem}main [class~=gap-y-3]{row-gap:.75rem}',
  'main [class~=w-full]{width:100%}main [class~=max-w-full]{max-width:100%}main [class~=max-w-2xl]{max-width:42rem}main [class~=max-w-3xl]{max-width:48rem}main [class~=max-w-5xl]{max-width:64rem}main [class~=min-w-0]{min-width:0}main [class~=shrink-0]{flex-shrink:0}main [class~=overflow-hidden]{overflow:hidden}',
  'main [class~=rounded-full]{border-radius:9999px}main [class~=rounded-sm]{border-radius:.25rem}main [class~=rounded-md]{border-radius:.375rem}main .border{border-style:solid;border-width:1px;border-color:#222}main .border-l{border-left-style:solid;border-left-width:1px}main .border-t{border-top-style:solid;border-top-width:1px}main .border-b{border-bottom-style:solid;border-bottom-width:1px}main [class~=bg-wm-card]{background:#111}main [class~=bg-wm-bg]{background:#050505}main [class~=bg-wm-green]{background:#4ade80;color:#050505}main [class~="bg-[#ff5f57]"]{background:#ff5f57}main [class~="bg-[#febc2e]"]{background:#febc2e}main [class~="bg-[#28c840]"]{background:#28c840}',
  'main [class~=px-3]{padding-inline:.75rem}main [class~=px-4]{padding-inline:1rem}main [class~=px-5]{padding-inline:1.25rem}main [class~=py-1]{padding-block:.25rem}main [class~=py-2]{padding-block:.5rem}main [class~=py-3]{padding-block:.75rem}main [class~="py-3.5"]{padding-block:.875rem}main [class~=font-mono]{font-family:var(--font-mono)}main [class~=font-display]{font-family:var(--font-display)}main [class~=font-bold]{font-weight:700}main [class~=uppercase]{text-transform:uppercase}main [class~=text-center]{text-align:center}main [class~=text-left]{text-align:left}',
  'main [class~=text-2xl]{font-size:1.5rem;line-height:1.33}main [class~=text-4xl]{font-size:2.25rem;line-height:1.11}main [class~=text-base]{font-size:1rem;line-height:1.5}main [class~=text-sm]{font-size:.875rem;line-height:1.25rem}main [class~=text-xs]{font-size:.75rem;line-height:1rem}main [class~="text-[9px]"]{font-size:9px}main [class~="text-[10px]"]{font-size:10px}main [class~="text-[11px]"]{font-size:11px}main [class~=leading-none]{line-height:1}main [class~=leading-relaxed]{line-height:1.625}main [class~=tracking-tight]{letter-spacing:-.025em}main [class~=tracking-wide]{letter-spacing:.025em}main [class~=tracking-wider]{letter-spacing:.05em}main [class~=tracking-widest]{letter-spacing:.1em}main [class~="tracking-[1px]"]{letter-spacing:1px}main [class~="tracking-[4px]"]{letter-spacing:4px}main [class~=break-words]{overflow-wrap:break-word}',
  'main [class~=text-wm-bg]{color:#050505}main [class~=text-wm-border]{color:#222}main [class~=text-wm-muted]{color:#9ca3af}main [class~=text-wm-text]{color:#f3f4f6}main [class~=text-wm-blue]{color:#60a5fa}main [class~=opacity-50]{opacity:.5}main [class~=opacity-60]{opacity:.6}main [class~=backdrop-blur-sm]{backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}main picture{display:block}main picture img{display:block;width:100%}',
  'main a[href*="welcome-hero"],main a[href*="moments"]{width:100%;justify-content:center;padding:.875rem 1.25rem;border-radius:.25rem;font:700 .875rem/1.25 var(--font-mono);letter-spacing:.025em;text-transform:uppercase}main a[href*="moments"]{background:transparent;color:#f3f4f6}',
  '@media (min-width:640px){nav>div{padding-inline:1.5rem}main>section:first-child{padding-top:8rem;padding-inline:1.5rem}main h1{font-size:3rem;line-height:1.05}main [class~="sm:flex-row"]{flex-direction:row}main [class~="sm:items-center"]{align-items:center}main [class~="sm:w-auto"]{width:auto}main [class~="sm:grid-cols-4"]{grid-template-columns:repeat(4,minmax(0,1fr))}main [class~="sm:max-w-3xl"]{max-width:48rem}main [class~="sm:max-w-none"]{max-width:none}main [class~="sm:px-4"]{padding-inline:1rem}main [class~="sm:px-6"]{padding-inline:1.5rem}main [class~="sm:px-8"]{padding-inline:2rem}main [class~="sm:tracking-wider"]{letter-spacing:.05em}main [class~="sm:block"]{display:block}}',
  '@media (min-width:768px){main h1{font-size:4.5rem}main p{font-size:1.125rem;line-height:1.75rem}main [class~="md:text-lg"]{font-size:1.125rem;line-height:1.75rem}nav [class~="md:flex"]{display:flex}}',
  // The .js-gated #seo-prerender hide. welcome.html and index.html ALSO inline
  // this exact rule in their <head> (before this critical CSS is injected) as a
  // belt-and-suspenders guard, so the built output intentionally carries it
  // twice — keep the two copies in sync if you ever change the hide technique.
  'html.js #seo-prerender{position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden}'
].join('');

// Flip each deferred preload to a real stylesheet on load, on error (retry a
// failed fetch as a stylesheet), and after a timeout (covers browsers that
// ignore `rel=preload as=style` and never fire an event) -- without a timeout
// or error arm a failed/unsupported preload leaves JS users on critical-CSS
// only, with the full sheet never applied. Idempotent (guarded rel check) and
// CSP-safe (no inline onload; runs inside the nonce'd bootstrap script).
const DEFERRED_STYLES_SCRIPT = "(function(){var links=document.querySelectorAll('link[data-wm-deferred-style]');for(var i=0;i<links.length;i++){(function(l){function a(){if(l.rel!=='stylesheet'){l.rel='stylesheet';}}l.addEventListener('load',a,{once:true});l.addEventListener('error',a,{once:true});setTimeout(a,3000);})(links[i]);}})();";

function findStylesheetTags(html) {
  return [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/gi)]
    .map((match) => match[0]);
}

function tagAttribute(tag, name) {
  const marker = name + '="';
  const start = tag.indexOf(marker);
  if (start === -1) return '';
  const valueStart = start + marker.length;
  const valueEnd = tag.indexOf('"', valueStart);
  return valueEnd === -1 ? '' : tag.slice(valueStart, valueEnd);
}

function inlineCriticalCss(html, file) {
  const stylesheetTags = findStylesheetTags(html);
  if (stylesheetTags.length !== 1) {
    console.error("[prerender] ERROR: Expected exactly one stylesheet tag for " + file + ", found " + stylesheetTags.length + ".");
    process.exit(1);
  }

  const stylesheetTag = stylesheetTags[0];

  const href = tagAttribute(stylesheetTag, 'href');
  if (!href) {
    console.error('[prerender] ERROR: Could not parse stylesheet href for ' + file + '.');
    process.exit(1);
  }

  const crossorigin = stylesheetTag.includes(' crossorigin') ? ' crossorigin' : '';
  const criticalTags = [
    '    <style nonce="' + STATIC_SCRIPT_NONCE + '">' + CRITICAL_CSS + '</style>',
    '    <link rel="preload" as="style" href="' + href + '"' + crossorigin + ' data-wm-deferred-style nonce="' + STATIC_SCRIPT_NONCE + '">',
    '    <script nonce="' + STATIC_SCRIPT_NONCE + '">' + DEFERRED_STYLES_SCRIPT + '</script>',
    '    <noscript><link rel="stylesheet" href="' + href + '"' + crossorigin + '></noscript>',
  ].join('\n');
  return html.replace(stylesheetTag, criticalTags);
}

async function renderWelcomeRoot() {
  const server = await createServer({
    configFile: resolve(__dirname, 'vite.config.ts'),
    appType: 'custom',
    logLevel: 'error',
    server: { hmr: false, middlewareMode: true },
  });
  try {
    const { renderWelcomeApp } = await server.ssrLoadModule('/src/welcome-prerender.tsx');
    return rewriteBuiltAssetUrls(await renderWelcomeApp());
  } finally {
    await server.close();
  }
}

function builtAssetHref(filenamePrefix, extension) {
  const assetsDir = resolve(__dirname, '../public/pro/assets');
  const file = readdirSync(assetsDir).find((candidate) => (
    candidate.startsWith(`${filenamePrefix}-`) && candidate.endsWith(extension)
  ));
  if (!file) {
    console.error(`[prerender] ERROR: Could not find built asset for ${filenamePrefix}${extension}`);
    process.exit(1);
  }
  return `/pro/assets/${file}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rewriteBuiltAssetUrls(markup) {
  let rewritten = markup;
  for (const { filenamePrefix, extension } of DASHBOARD_SCREENSHOT_ASSETS) {
    const builtHref = builtAssetHref(filenamePrefix, extension);
    const sourceAssetPattern = new RegExp(
      `(?:/pro/src/assets/|/@fs/[^"'<>\\s]*/)${escapeRegExp(filenamePrefix + extension)}`,
      'g',
    );
    if (!rewritten.match(sourceAssetPattern)) {
      console.error(`[prerender] ERROR: Could not find SSR asset URL for ${filenamePrefix}${extension} in welcome markup.`);
      process.exit(1);
    }
    rewritten = rewritten.replace(sourceAssetPattern, builtHref);
  }

  // Catch any OTHER dev-only asset URL — a newly added asset import the rewrite
  // map above doesn't cover would otherwise ship a broken /pro/src/assets or
  // /@fs path into the static HTML and break hydration on the hashed client URL.
  const leaked = rewritten.match(/(?:\/pro\/src\/assets\/|\/@fs\/)[^"'<>\s]+/);
  if (leaked) {
    console.error(`[prerender] ERROR: Unrewritten dev asset URL in welcome markup: ${leaked[0]}. Extend rewriteBuiltAssetUrls() to cover it.`);
    process.exit(1);
  }
  return rewritten;
}
// Hides the prerender block from assistive tech once JS runs (the CSS in <head>
// already hides it visually for .js browsers). Appended to every page's block.
const HIDE_SCRIPT = `<script>(function(){try{var s=document.getElementById('seo-prerender');if(s){s.setAttribute('aria-hidden','true');s.setAttribute('inert','')}}catch(e){}})()</script>`;

const indexContent = `
<div id="seo-prerender" lang="en">
  <h1>World Monitor Pro — From ${en.hero.noiseWord} to ${en.hero.signalWord}</h1>
  <p>${en.hero.valueProps}</p>
  <p>${en.hero.launchingDate}</p>

  <h2>Three pillars</h2>
  <h3>${en.pillars.askIt}</h3><p>${en.pillars.askItDesc}</p>
  <h3>${en.pillars.subscribeIt}</h3><p>${en.pillars.subscribeItDesc}</p>
  <h3>${en.pillars.buildOnIt}</h3><p>${en.pillars.buildOnItDesc}</p>

  <h2>Plans</h2>
  <h3>${en.twoPath.proTitle}</h3>
  <p>${en.twoPath.proDesc}</p>
  <p>${en.twoPath.proF1}</p>
  <p>${en.twoPath.proF2}</p>
  <p>${en.twoPath.proF3}</p>
  <p>${en.twoPath.proF4}</p>
  <p>${en.twoPath.proF5}</p>
  <p>${en.twoPath.proF6}</p>
  <p>${en.twoPath.proF7}</p>
  <p>${en.twoPath.proF8}</p>
  <p>${en.twoPath.proF9}</p>

  <h3>${en.twoPath.entTitle}</h3>
  <p>${en.twoPath.entDesc}</p>

  <h2>${en.whyUpgrade.title}</h2>
  <h3>${en.whyUpgrade.noiseTitle}</h3><p>${en.whyUpgrade.noiseDesc}</p>
  <h3>${en.whyUpgrade.fasterTitle}</h3><p>${en.whyUpgrade.fasterDesc}</p>
  <h3>${en.whyUpgrade.controlTitle}</h3><p>${en.whyUpgrade.controlDesc}</p>
  <h3>${en.whyUpgrade.deeperTitle}</h3><p>${en.whyUpgrade.deeperDesc}</p>

  <h2>${en.proShowcase.title}</h2>
  <p>${en.proShowcase.subtitle}</p>
  <h3>${en.proShowcase.equityResearch}</h3><p>${en.proShowcase.equityResearchDesc}</p>
  <h3>${en.proShowcase.geopoliticalAnalysis}</h3><p>${en.proShowcase.geopoliticalAnalysisDesc}</p>
  <h3>${en.proShowcase.economyAnalytics}</h3><p>${en.proShowcase.economyAnalyticsDesc}</p>
  <h3>${en.proShowcase.riskMonitoring}</h3><p>${en.proShowcase.riskMonitoringDesc}</p>
  <h3>${en.proShowcase.orbitalSurveillance}</h3><p>${en.proShowcase.orbitalSurveillanceDesc}</p>
  <h3>${en.proShowcase.morningBriefs}</h3><p>${en.proShowcase.morningBriefsDesc}</p>
  ${/* en.proShowcase.oneKeyDesc is intentionally NOT used here — the React UI renders that plain-text version at App.tsx:734; this prerender block ships a link-rich variant for AEO source-citation credit. Do not remove oneKeyDesc from en.json; the React app still depends on it. */ ''}
  <h3>${en.proShowcase.oneKey}</h3><p>Ingested live: <a href="https://finnhub.io/">Finnhub</a>, <a href="https://fred.stlouisfed.org/">FRED</a>, <a href="https://acleddata.com/">ACLED</a>, <a href="https://ucdp.uu.se/">UCDP</a>, <a href="https://firms.modaps.eosdis.nasa.gov/">NASA FIRMS</a>, <a href="https://aisstream.io/">AISStream</a>, <a href="https://opensky-network.org/">OpenSky</a>, <a href="https://www.usgs.gov/programs/earthquake-hazards">USGS</a>, <a href="https://www.imf.org/en/Data">IMF</a>, <a href="https://www.bis.org/">BIS</a>, and more — all active under one key, no separate registrations.</p>

  <h2>${en.deliveryDesk.title}</h2>
  <p>${en.deliveryDesk.body}</p>
  <p>${en.deliveryDesk.closer}</p>
  <p>${en.deliveryDesk.channels}</p>

  <h2>${en.audience.title}</h2>
  <h3>${en.audience.investorsTitle}</h3><p>${en.audience.investorsDesc}</p>
  <h3>${en.audience.tradersTitle}</h3><p>${en.audience.tradersDesc}</p>
  <h3>${en.audience.researchersTitle}</h3><p>${en.audience.researchersDesc}</p>
  <h3>${en.audience.journalistsTitle}</h3><p>${en.audience.journalistsDesc}</p>
  <h3>${en.audience.govTitle}</h3><p>${en.audience.govDesc}</p>
  <h3>${en.audience.teamsTitle}</h3><p>${en.audience.teamsDesc}</p>

  <h2>${en.dataCoverage.title}</h2>
  <p>${en.dataCoverage.subtitle}</p>

  <h2>${en.apiSection.title}</h2>
  <p>${en.apiSection.subtitle}</p>

  <h2>${en.enterpriseShowcase.title}</h2>
  <p>${en.enterpriseShowcase.subtitle}</p>

  <h2>${en.pricingTable.title}</h2>
  <p>${en.tiers.priceMonthly} · ${en.tiers.priceAnnual} (${en.tiers.annualSavingsNote})</p>

  <h2>${en.faq.title}</h2>
  <dl>
    <dt>${en.faq.q1}</dt><dd>${en.faq.a1}</dd>
    <dt>${en.faq.q2}</dt><dd>${en.faq.a2}</dd>
    <dt>${en.faq.q3}</dt><dd>${en.faq.a3}</dd>
    <dt>${en.faq.q4}</dt><dd>${en.faq.a4}</dd>
    <dt>${en.faq.q5}</dt><dd>${en.faq.a5}</dd>
    <dt>${en.faq.q6}</dt><dd>${en.faq.a6}</dd>
    <dt>${en.faq.q7}</dt><dd>${en.faq.a7}</dd>
    <dt>${en.faq.q8}</dt><dd>${en.faq.a8}</dd>
    <dt>${en.faq.q9}</dt><dd>${en.faq.a9}</dd>
    <dt>${en.faq.q10}</dt><dd>${en.faq.a10}</dd>
    <dt>${en.faq.q11}</dt><dd>${en.faq.a11}</dd>
    <dt>${en.faq.q12}</dt><dd>${en.faq.a12}</dd>
    <dt>${en.faq.q13}</dt><dd>${en.faq.a13}</dd>
  </dl>

  <h2>${en.finalCta.title}</h2>
  <p>${en.finalCta.subtitle}</p>

  <h2>Explore more</h2>
  <ul>
    <li><a href="https://www.worldmonitor.app/dashboard">World Monitor — geopolitics &amp; intelligence dashboard</a></li>
    <li><a href="https://tech.worldmonitor.app/">Tech Monitor — AI labs, startups, cloud</a></li>
    <li><a href="https://finance.worldmonitor.app/">Finance Monitor — markets, central banks, forex</a></li>
    <li><a href="https://commodity.worldmonitor.app/">Commodity Monitor — mining, energy, supply chains</a></li>
    <li><a href="https://happy.worldmonitor.app/">Happy Monitor — positive news &amp; progress</a></li>
    <li><a href="https://www.worldmonitor.app/blog/">World Monitor Blog — OSINT guides &amp; analysis</a></li>
    <li><a href="https://www.worldmonitor.app/blog/posts/what-is-worldmonitor-real-time-global-intelligence/">What is World Monitor?</a></li>
    <li><a href="https://www.worldmonitor.app/blog/posts/build-on-worldmonitor-developer-api-open-source/">Build on World Monitor — developer API &amp; MCP</a></li>
    <li><a href="https://github.com/koala73/worldmonitor">Open source on GitHub (AGPL-3.0)</a></li>
    <li><a href="https://www.wired.com/story/world-monitor-elie-habib/">Featured in WIRED</a></li>
  </ul>
</div>
${HIDE_SCRIPT}`;

const welcomeContent = await renderWelcomeRoot();

// Wired feature link, reused below.
const WIRED_STORY_URL = 'https://www.wired.com/story/world-monitor-elie-habib/';

// Crawler-facing prose block for welcome.html (served at the apex `/`). Unlike
// index.html — where the React app REPLACES #root on mount, so the prose can be
// injected inside #root — welcome.html HYDRATES its server-rendered React into
// #root, so this block is injected as a SIBLING before #root (see `beforeRoot`
// below) and never collides with hydration. It leads at <h2>: the hydrated Hero
// already renders the page's single <h1>. AEO/RAG indexers read raw HTML without
// executing JS, so this dense, link-rich, low-markup text lifts the page's
// text-to-markup ratio and gives vector retrieval clean structure; the FAQ pulls
// the same en.welcome.faq strings the React <FAQ> and the head FAQPage JSON-LD
// use, so schema and visible copy stay in lockstep.
// The 1..9 range mirrors the three sibling surfaces that also hardcode nine
// entries: the React <FAQ> (welcome/FAQ.tsx maps [1..9]) and the head FAQPage
// JSON-LD in welcome.html. If en.welcome.faq gains a q10/a10, extend the range
// HERE and in those two places together, or the FAQ will silently diverge
// (the "undefined" guard below only catches MISSING keys, not omitted extras).
const welcomeFaqEntries = [1, 2, 3, 4, 5, 6, 7, 8, 9]
  .map((n) => `    <dt>${en.welcome.faq['q' + n]}</dt><dd>${en.welcome.faq['a' + n]}</dd>`)
  .join('\n');

// The "live numbers" list is generated from the SAME en.welcome.depth values the
// visible React "depth" section renders, so the crawler block's stat table can't
// silently drift from the app (the undefined-guard below also then covers a
// removed key). Each entry pairs a depth value (s<N>v) with its own prose label;
// we deliberately don't reuse the depth *labels* (s<N>l) — those are terse
// dashboard captions ("Pipelines & LNG"), not crawler prose.
const welcomeNumbers = [
  [en.welcome.depth.s1v, 'live map layers'],
  [en.welcome.depth.s2v, 'curated news and data feeds'],
  [en.welcome.depth.s3v, 'named data providers under one key'],
  [en.welcome.depth.s4v, 'maritime chokepoints tracked with live AIS'],
  [en.welcome.depth.s7v, 'submarine cables mapped'],
  [en.welcome.depth.s8v, 'pipelines and LNG terminals'],
  [en.welcome.depth.s9v, 'AI datacenters mapped'],
  [en.welcome.depth.s10v, 'scored geopolitical hotspots'],
  [en.welcome.depth.s11v, 'exchanges and market assets'],
  [en.welcome.depth.s6v, 'countries with resilience rankings'],
  [en.welcome.depth.s12v, 'MCP tools for AI agents'],
  [en.welcome.depth.s13v, 'command-palette actions'],
  [en.welcome.depth.s14v, 'interface languages, including right-to-left'],
  [en.welcome.depth.s15v, 'independent origin types behind every breaking alert'],
]
  .map(([value, label]) => `    <li>${value} ${label}</li>`)
  .join('\n');

const welcomeSeoPrerender = `
<div id="seo-prerender" lang="en">
  <h2>World Monitor — free real-time global intelligence dashboard</h2>
  <p>${en.welcome.hero.sub} It runs instantly in the browser with no signup, is used by 2M+ people across 190+ countries, and is open source under AGPL-3.0. <a href="${WIRED_STORY_URL}">Featured in WIRED</a>.</p>

  <h2>What World Monitor tracks</h2>
  <p>World Monitor fuses 56 live map layers on a dual 3D-globe and WebGL map, then scores how they move together. Everything is normalized onto one surface: you see the raw signals, understand them through a daily AI brief and the Country Instability Index, and act with custom monitors, a Scenario Engine, Route Explorer and a 39-tool MCP server for AI agents. Every panel cites its sources and timestamps inline.</p>
  <h3>Conflict &amp; security</h3>
  <p>Live conflict events from ACLED and UCDP with escalation scoring, 29 scored geopolitical hotspots, military-posture and troop-movement signals, and corroborated breaking alerts that fire only when independent origin types agree.</p>
  <h3>Maritime &amp; trade</h3>
  <p>Live AIS vessel tracking, 13 shipping chokepoints — Hormuz, Bab el-Mandeb, Suez, Malacca and more — with transit counts, week-over-week change and disruption scoring, plus port activity and cargo inference.</p>
  <h3>Aviation &amp; aerospace</h3>
  <p>ADS-B tracking of global flights, satellite passes computed in-browser with SGP4 — watch ISS, Starlink and military birds overhead — and a live map of GPS jamming and spoofing zones.</p>
  <h3>Energy &amp; infrastructure</h3>
  <p>88 pipelines and LNG terminals, nuclear facilities, power grids and refineries, 313 mapped AI datacenters with power and operator metadata, and 86 submarine cables with landing stations, overlaid with outage and threat signals.</p>
  <h3>Markets &amp; macro</h3>
  <p>92 exchanges and assets — equities, commodities, crypto, ETF flows and analyst targets — alongside FRED, IMF and BIS macro data, central-bank and monetary-policy tracking, and GDP, inflation and interest-rate cycles.</p>
  <h3>Climate &amp; natural hazards</h3>
  <p>NASA FIRMS near-real-time fire and hotspot detection, USGS earthquakes, volcanic activity and severe-weather layers — mapped against the infrastructure and supply routes they can disrupt.</p>
  <h3>Cyber &amp; connectivity</h3>
  <p>Ransomware feeds, BGP hijack and route-anomaly detection, internet-outage monitoring and DDoS signals — the digital layer of global risk, tied to the physical cables and datacenters beneath it.</p>

  <h2>See the signals move together</h2>
  <p>${en.welcome.moments.sub} The edge is one surface where a country-risk spike, a chokepoint anomaly and a Brent move can explain each other in real time, before it becomes a consensus note.</p>
  <ul>
    <li><strong>Markets</strong> — country risk, sanctions and hotspot escalation show where geopolitical pressure is rising; ships, cables and flights show whether it can hit supply, trade or capital routes; rates, FX, equities and safe-haven assets show which market regime is repricing.</li>
    <li><strong>Commodities</strong> — AIS, ports, pipelines, LNG and chokepoints show when physical supply slows or reroutes, weather and fires show the disruptions, and oil, gas, grains and miners show how the shock prices through.</li>
    <li><strong>AI infrastructure</strong> — AI datacenters sit beside grids, pipelines and nuclear power, and grid-stress, heat and fire layers show which compute corridors are under pressure and which companies are exposed.</li>
    <li><strong>Connectivity</strong> — subsea cables, landing stations and BGP-anomaly feeds show whether a physical fault is becoming a digital outage, and which trade corridors lose their fallback routes first.</li>
  </ul>

  <h2>Your first five minutes on the live map</h2>
  <p>There is no tour, no empty state and no signup wall. The map is already moving as the page loads — conflicts, vessels, flights, fires and outages render immediately, with nothing to configure first. Click any country to open its dossier. Press the command palette (Ctrl-K or Cmd-K) for 154 commands that jump straight to any layer, panel or country. Switch lens between World, Tech, Finance, Commodity, Energy and Happy — the same engine tuned into six monitors, one click apart. What loads first is maybe a tenth of what is there; the rest surfaces as the world moves — satellite passes, GPS-jamming zones, dark ships, protest clusters and siren alerts.</p>

  <h2>Country briefs, instability scores and corroborated alerts</h2>
  <p>Click any country and a full dossier opens: a Country Instability Index with its component signals, an AI brief with cited headlines, active signals and a 7-day timeline, plus resilience rankings across 196 countries. Breaking alerts are deliberately quiet — a banner fires only when five independent origin types corroborate an event (news classification, keyword velocity, hotspot escalation, military surges and official sirens), deduplicated and rate-limited, so you get fewer alerts and real ones.</p>

  <h2>Where the data comes from</h2>
  <p>65+ named providers, live: <a href="https://acleddata.com/">ACLED</a> and <a href="https://ucdp.uu.se/">UCDP</a> for conflict, <a href="https://aisstream.io/">AISStream</a> for vessels, <a href="https://opensky-network.org/">OpenSky</a> for aircraft, <a href="https://firms.modaps.eosdis.nasa.gov/">NASA FIRMS</a> for fires, <a href="https://www.usgs.gov/programs/earthquake-hazards">USGS</a> for earthquakes, and <a href="https://www.imf.org/en/Data">IMF</a>, <a href="https://www.bis.org/">BIS</a>, <a href="https://fred.stlouisfed.org/">FRED</a> and <a href="https://finnhub.io/">Finnhub</a> for markets and macro — plus 500+ curated news feeds, all active under one key with no separate registrations.</p>

  <h2>How World Monitor works</h2>
  <p>World Monitor ingests 500+ curated feeds and 65+ named providers on independent refresh cycles, normalizes every event into a common schema, geolocates it and deduplicates it across sources. A breaking-news banner fires only when five independent origin types corroborate the same event, so alerts stay rare and real. The Country Instability Index fuses weighted signals per country, the daily AI brief cites the specific headlines behind each assessment, and the correlation engine surfaces when separate systems — geopolitics, shipping, energy and markets — start moving together. Nothing is a black box: every panel shows its sources and the timestamp of its most recent update.</p>

  <h2>Watch shipping chokepoints in real time</h2>
  <p>Thirteen shipping chokepoints — including Hormuz, Bab el-Mandeb, Suez and Malacca — are tracked with live AIS vessel counts, week-over-week transit change and disruption scoring, with density anomalies flagged against each strait's rolling baseline.</p>

  <h2>Built for AI agents — from any stack</h2>
  <p>World Monitor ships a 39-tool MCP server, so Claude, GPT or any MCP-compatible agent can query live country risk scores, chokepoint status, conflicts, markets and country briefs — researching with live data instead of training-data memories. Every tool accepts a JMESPath projection so agents fetch exactly the fields they need, a single OAuth key reaches 65+ upstream providers, and the whole platform is open source under AGPL-3.0. A public REST API with 193 documented operations under one OpenAPI 3.1 spec covers custom integrations, and official zero-dependency SDKs ship on npm (worldmonitor), PyPI (worldmonitor-sdk), RubyGems (worldmonitor) and as a Go module (github.com/koala73/worldmonitor/sdk/go).</p>
  <p>Representative MCP tools include country risk, country brief and world brief; conflict events, military posture and cyber threats; maritime activity, chokepoint status and supply-chain data; market data, economic data and consumer prices; energy intelligence, commodity geography and tariff trends; natural disasters, climate and health signals; news intelligence, prediction markets, situation analysis and forecast generation — each accepting an optional JMESPath projection, with a describe_tool call that returns its full schema. Read-only resources expose country risk, chokepoint status, seed-freshness metadata and market quotes at addressable URIs, and prompt templates pre-package common workflows such as country briefings, energy-shock watch, market-open prep and route-risk checks.</p>

  <h2>Who uses World Monitor</h2>
  <p>Investors and analysts pricing geopolitical risk, traders watching supply-chain and energy disruptions, researchers and journalists corroborating events across independent sources, and government, defence and NGO teams tracking situational awareness — all from one live map instead of a dozen separate tools.</p>

  <h2>Free, Pro and open source</h2>
  <p>The full live map — every layer, 500+ feeds, country briefs and breaking alerts, all six monitors — is free with no signup and no trial clock. World Monitor Pro ($39.99/month or $399.99/year) adds the decision layer described below, and native desktop apps for Windows, macOS and Linux plus an Android TV app for wall displays are available too.</p>

  <h2>What World Monitor Pro and Enterprise add</h2>
  <p>Pro turns the observatory into an operations room. WM Analyst answers questions across 30+ live services with citations; a Scenario Engine and Route Explorer let you game disruptions before they hit; a personal AI digest sends up to 30 ranked items daily, twice-daily or weekly to Slack, Discord, Telegram, Email or webhook; a custom widget builder assembles your own panels from HTML, CSS and JavaScript with AI assistance; and MCP plus a REST API expose 39 tools under one key. Enterprise adds team workspaces with SSO, MFA and RBAC; cloud, on-premises or air-gapped deployment; satellite imagery with change detection and SAR; tens of thousands of mapped infrastructure assets; and 100+ data connectors including Snowflake, Splunk and Sentinel.</p>

  <h2>The numbers, live in the dashboard today</h2>
  <p>Every figure below is live now, not a roadmap — open the app and count. Sources are cited on every panel.</p>
  <ul>
${welcomeNumbers}
  </ul>

  <h2>Key terms</h2>
  <dl>
    <dt>Country Instability Index (CII)</dt><dd>A composite score that fuses weighted per-country signals — conflict, unrest, economic and governance indicators — into a single, comparable measure of instability.</dd>
    <dt>Chokepoint</dt><dd>A narrow maritime strait such as Hormuz, Bab el-Mandeb, Suez or Malacca where global shipping concentrates, so a disruption there ripples through world trade and energy prices.</dd>
    <dt>AIS (Automatic Identification System)</dt><dd>Transponder signals broadcast by ships, used to track vessel positions, port calls and chokepoint transits in real time.</dd>
    <dt>ADS-B</dt><dd>Automatic Dependent Surveillance–Broadcast, the transponder feed used to track aircraft positions and flight patterns worldwide.</dd>
    <dt>BGP anomaly</dt><dd>An irregularity in the internet's Border Gateway Protocol routing that can reveal a route hijack, leak or large-scale outage.</dd>
    <dt>OSINT</dt><dd>Open-source intelligence — analysis assembled entirely from publicly available data, which is what World Monitor makes accessible on one map.</dd>
    <dt>MCP (Model Context Protocol)</dt><dd>An open standard that lets AI agents call external tools; World Monitor ships a 39-tool MCP server so agents can query live data directly.</dd>
    <dt>JMESPath</dt><dd>A JSON query language agents use to project just the fields they need from a tool response, cutting token usage on every call.</dd>
    <dt>SGP4</dt><dd>The orbital-propagation model World Monitor runs in the browser to compute live satellite positions and overhead passes.</dd>
    <dt>SAR (Synthetic Aperture Radar)</dt><dd>All-weather, day-and-night satellite radar imaging, available on Enterprise for change detection where optical imagery cannot see.</dd>
  </dl>

  <h2>Six dashboards, one platform</h2>
  <ul>
    <li><a href="https://www.worldmonitor.app/dashboard">World Monitor</a> — geopolitics, conflicts, military and infrastructure</li>
    <li><a href="https://tech.worldmonitor.app/">Tech Monitor</a> — AI labs, startups, cloud and cybersecurity</li>
    <li><a href="https://finance.worldmonitor.app/">Finance Monitor</a> — global markets, central banks, forex and crypto</li>
    <li><a href="https://commodity.worldmonitor.app/">Commodity Monitor</a> — mining, energy, supply chains and freight</li>
    <li><a href="https://happy.worldmonitor.app/">Happy Monitor</a> — positive news, breakthroughs and conservation</li>
    <li><a href="https://energy.worldmonitor.app/">Energy Monitor</a> — oil, gas, chokepoints and energy security</li>
  </ul>

  <h2>${en.welcome.faq.title}</h2>
  <dl>
${welcomeFaqEntries}
  </dl>

  <h2>More questions analysts and agents ask</h2>
  <dl>
    <dt>How fresh is the data?</dt><dd>Feeds refresh on independent cycles ranging from seconds to minutes, and every panel shows the timestamp of its most recent update. The free tier refreshes every 5–15 minutes; Pro runs near real time.</dd>
    <dt>Can I get alerts on Slack, Telegram or email?</dt><dd>Yes. Pro delivers scheduled AI digests and real-time alerts to Slack, Discord, Telegram, Email or webhook, AES-256 encrypted, with quiet hours and per-rule triggers.</dd>
    <dt>Does it work on mobile, desktop and TV?</dt><dd>Yes. World Monitor runs in any modern browser, with native desktop apps for Windows, macOS and Linux and an Android TV app for SOC walls and trading floors.</dd>
    <dt>What languages does it support?</dt><dd>24 interface languages, including right-to-left scripts such as Arabic and Farsi.</dd>
    <dt>Can I self-host World Monitor?</dt><dd>Yes. The platform is open source under AGPL-3.0 on GitHub — read the code, self-host it or build on it. Enterprise adds on-premises and air-gapped deployment.</dd>
    <dt>Is there an API for developers?</dt><dd>Yes. A REST API spans all 30+ service domains with structured JSON, cache headers and OpenAPI 3.1 docs, authenticated per key and rate-limited per tier, alongside the 39-tool MCP server.</dd>
  </dl>

  <h2>Learn more</h2>
  <ul>
    <li><a href="https://www.worldmonitor.app/pro">World Monitor Pro</a> — AI analyst, scheduled digests, MCP for Claude &amp; GPT</li>
    <li><a href="https://www.worldmonitor.app/blog/">World Monitor Blog</a> — OSINT guides, geopolitics and market intelligence</li>
    <li><a href="https://www.worldmonitor.app/blog/posts/what-is-worldmonitor-real-time-global-intelligence/">What is World Monitor?</a></li>
    <li><a href="https://www.worldmonitor.app/blog/posts/worldmonitor-is-not-palantir/">WorldMonitor is not an open-source Palantir</a></li>
    <li><a href="https://www.worldmonitor.app/blog/posts/osint-for-everyone-open-source-intelligence-democratized/">OSINT for everyone — open-source intelligence democratized</a></li>
    <li><a href="https://github.com/koala73/worldmonitor">Open source on GitHub (AGPL-3.0)</a></li>
    <li><a href="${WIRED_STORY_URL}">Featured in WIRED</a></li>
  </ul>
</div>
${HIDE_SCRIPT}`;

const PAGES = [
  { file: 'index.html', content: indexContent, rootAttributes: '' },
  {
    file: 'welcome.html',
    content: welcomeContent,
    rootAttributes: ' data-wm-prerendered="welcome" data-wm-prerender-lang="en"',
    // Injected as a sibling BEFORE #root (not inside it) so React hydration of
    // the SSR'd #root subtree is untouched. Hidden for JS users via the
    // html.js #seo-prerender rule; visible to no-JS AEO/RAG crawlers.
    beforeRoot: welcomeSeoPrerender,
  },
];

for (const { file, content, rootAttributes, beforeRoot = '' } of PAGES) {
  // Fail loudly if any key resolved to undefined — this prevents the build from
  // silently shipping "undefined" strings to crawlers.
  if ((content + beforeRoot).includes('undefined')) {
    console.error(`[prerender] ERROR: SEO content for ${file} contains literal "undefined". Check that all en.json keys referenced in this file exist.`);
    process.exit(1);
  }

  const htmlPath = resolve(__dirname, '../public/pro', file);
  let html = readFileSync(htmlPath, 'utf-8');
  html = inlineCriticalCss(html, file);
  if (!html.includes('</head>')) {
    console.error(`[prerender] ERROR: ${file} has no </head> to inject Organization JSON-LD into.`);
    process.exit(1);
  }
  html = html.replace('</head>', `${ORGANIZATION_JSONLD}\n  </head>`);
  if (!html.includes('<div id="root"></div>')) {
    console.error(`[prerender] ERROR: ${file} has no empty <div id="root"></div> to inject into.`);
    process.exit(1);
  }
  html = html.replace('<div id="root"></div>', `${beforeRoot}<div id="root"${rootAttributes}>${content}</div>`);
  writeFileSync(htmlPath, html, 'utf-8');
  console.log(`[prerender] Injected SEO content into public/pro/${file}`);
}
