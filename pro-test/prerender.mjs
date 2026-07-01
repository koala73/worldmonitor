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

const CRITICAL_CSS = [
  ':root{--font-sans:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;--font-mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;--font-display:system-ui,sans-serif;--color-wm-bg:#050505;--color-wm-card:#111;--color-wm-border:#222;--color-wm-green:#4ade80;--color-wm-blue:#60a5fa;--color-wm-text:#f3f4f6;--color-wm-muted:#9ca3af}',
  '*,::before,::after{box-sizing:border-box;border:0 solid #222}html{background:#050505;color:#f3f4f6;-webkit-text-size-adjust:100%;tab-size:4}body{margin:0;background:#050505;color:#f3f4f6;font-family:var(--font-sans);line-height:1.5;-webkit-font-smoothing:antialiased}a{color:inherit;text-decoration:none}img,svg{display:block;vertical-align:middle}img{max-width:100%;height:auto}h1,h2,h3,p{margin:0}',
  '#root,#root>div{min-height:100vh}.glass-panel{background:rgba(17,17,17,.7);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid #222}.text-glow{text-shadow:0 0 20px rgba(74,222,128,.3)}.border-glow{box-shadow:0 0 20px rgba(74,222,128,.1)}',
  'nav{position:fixed;top:0;left:0;right:0;z-index:50;background:rgba(17,17,17,.7);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid #222;border-inline-width:0;border-bottom-width:0}nav>div{max-width:80rem;margin-inline:auto;padding-inline:1rem;height:4rem;display:flex;align-items:center;justify-content:space-between;gap:.75rem}nav a{display:flex;align-items:center;gap:.5rem}nav a[aria-label*="Launch"]{flex-shrink:0;background:#4ade80;color:#050505;padding:.5rem .75rem;border-radius:.25rem;font:700 .75rem/1 ui-monospace,SFMono-Regular,monospace;text-transform:uppercase;letter-spacing:.025em}nav .hidden{display:none}nav [class*=font-display]{font-family:var(--font-display);font-weight:700}nav [class*=text-wm-muted],main [class*=text-wm-muted]{color:#9ca3af}nav [class*=text-wm-green],main [class*=text-wm-green]{color:#4ade80}nav [class*=text-wm-blue]{color:#60a5fa}',
  'main>section:first-child{position:relative;overflow:hidden;padding:7rem 1rem 4rem}main>section:first-child>div:first-child{position:absolute;inset:0;background:radial-gradient(circle at 50% 0%,rgba(74,222,128,.10) 0%,transparent 55%);pointer-events:none}main>section:first-child>div:nth-child(2){position:relative;z-index:10;max-width:64rem;margin-inline:auto;text-align:center}main h1{font-family:var(--font-display);font-weight:700;font-size:2.25rem;line-height:1.08;letter-spacing:-.025em}main p{margin:1.5rem auto 0;max-width:42rem;color:#9ca3af;font-size:1rem;line-height:1.5}',
  'main [class*=relative]{position:relative}main [class*=absolute]{position:absolute}main [class*=inset-0]{inset:0}main [class*=z-10]{z-index:10}main [class*=pointer-events-none]{pointer-events:none}main [class*=flex]{display:flex}main [class*=inline-flex]{display:inline-flex}main [class*=grid]{display:grid}main [class*=block]{display:block}main .hidden{display:none}main [class*=items-center]{align-items:center}main [class*=items-stretch]{align-items:stretch}main [class*=justify-center]{justify-content:center}main [class*=justify-between]{justify-content:space-between}main [class*=flex-col]{flex-direction:column}main [class*=flex-wrap]{flex-wrap:wrap}main [class*=grid-cols-2]{grid-template-columns:repeat(2,minmax(0,1fr))}',
  'main [class*=mx-auto]{margin-inline:auto}main [class*=mt-1]{margin-top:.25rem}main [class*=mt-3]{margin-top:.75rem}main [class*=mt-6]{margin-top:1.5rem}main [class*=mt-8]{margin-top:2rem}main [class*=mt-9]{margin-top:2.25rem}main [class*=mt-10]{margin-top:2.5rem}main [class*=mb-5]{margin-bottom:1.25rem}main [class*=gap-1]{gap:.25rem}main [class*=gap-2]{gap:.5rem}main [class*=gap-3]{gap:.75rem}main [class*=gap-4]{gap:1rem}main [class*=gap-x-6]{column-gap:1.5rem}main [class*=gap-y-3]{row-gap:.75rem}',
  'main [class*=w-full]{width:100%}main [class*=max-w-full]{max-width:100%}main [class*=max-w-2xl]{max-width:42rem}main [class*=max-w-3xl]{max-width:48rem}main [class*=max-w-5xl]{max-width:64rem}main [class*=min-w-0]{min-width:0}main [class*=shrink-0]{flex-shrink:0}main [class*=overflow-hidden]{overflow:hidden}',
  'main [class*=rounded-full]{border-radius:9999px}main [class*=rounded-sm]{border-radius:.25rem}main [class*=rounded-md]{border-radius:.375rem}main .border{border-style:solid;border-width:1px;border-color:#222}main .border-l{border-left-style:solid;border-left-width:1px}main .border-t{border-top-style:solid;border-top-width:1px}main .border-b{border-bottom-style:solid;border-bottom-width:1px}main [class*=bg-wm-card]{background:#111}main [class*=bg-wm-bg]{background:#050505}main [class*=bg-wm-green]{background:#4ade80;color:#050505}main [class*="bg-[#ff5f57]"]{background:#ff5f57}main [class*="bg-[#febc2e]"]{background:#febc2e}main [class*="bg-[#28c840]"]{background:#28c840}',
  'main [class*=px-3]{padding-inline:.75rem}main [class*=px-4]{padding-inline:1rem}main [class*=px-5]{padding-inline:1.25rem}main [class*=py-1]{padding-block:.25rem}main [class*=py-2]{padding-block:.5rem}main [class*=py-3]{padding-block:.75rem}main [class*="py-3.5"]{padding-block:.875rem}main [class*=font-mono]{font-family:var(--font-mono)}main [class*=font-display]{font-family:var(--font-display)}main [class*=font-bold]{font-weight:700}main [class*=uppercase]{text-transform:uppercase}main [class*=text-center]{text-align:center}main [class*=text-left]{text-align:left}',
  'main [class*=text-2xl]{font-size:1.5rem;line-height:1.33}main [class*=text-4xl]{font-size:2.25rem;line-height:1.11}main [class*=text-base]{font-size:1rem;line-height:1.5}main [class*=text-sm]{font-size:.875rem;line-height:1.25rem}main [class*=text-xs]{font-size:.75rem;line-height:1rem}main [class*="text-[9px]"]{font-size:9px}main [class*="text-[10px]"]{font-size:10px}main [class*="text-[11px]"]{font-size:11px}main [class*=leading-none]{line-height:1}main [class*=leading-relaxed]{line-height:1.625}main [class*=tracking-tight]{letter-spacing:-.025em}main [class*=tracking-wide]{letter-spacing:.025em}main [class*=tracking-wider]{letter-spacing:.05em}main [class*=tracking-widest]{letter-spacing:.1em}main [class*="tracking-[1px]"]{letter-spacing:1px}main [class*="tracking-[4px]"]{letter-spacing:4px}main [class*=break-words]{overflow-wrap:break-word}',
  'main [class*=text-wm-bg]{color:#050505}main [class*=text-wm-border]{color:#222}main [class*=text-wm-muted]{color:#9ca3af}main [class*=text-wm-text]{color:#f3f4f6}main [class*=text-wm-blue]{color:#60a5fa}main [class*=opacity-50]{opacity:.5}main [class*=opacity-60]{opacity:.6}main [class*=backdrop-blur-sm]{backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}main picture{display:block}main picture img{display:block;width:100%}',
  'main a[href*="welcome-hero"],main a[href*="moments"]{width:100%;justify-content:center;padding:.875rem 1.25rem;border-radius:.25rem;font:700 .875rem/1.25 var(--font-mono);letter-spacing:.025em;text-transform:uppercase}main a[href*="moments"]{background:transparent;color:#f3f4f6}',
  '@media (min-width:640px){nav>div{padding-inline:1.5rem}main>section:first-child{padding-top:8rem;padding-inline:1.5rem}main h1{font-size:3rem;line-height:1.05}main [class*="sm:flex-row"]{flex-direction:row}main [class*="sm:items-center"]{align-items:center}main [class*="sm:w-auto"]{width:auto}main [class*="sm:grid-cols-4"]{grid-template-columns:repeat(4,minmax(0,1fr))}main [class*="sm:max-w-3xl"]{max-width:48rem}main [class*="sm:max-w-none"]{max-width:none}main [class*="sm:px-4"]{padding-inline:1rem}main [class*="sm:px-6"]{padding-inline:1.5rem}main [class*="sm:px-8"]{padding-inline:2rem}main [class*="sm:tracking-wider"]{letter-spacing:.05em}}',
  '@media (min-width:768px){main h1{font-size:4.5rem}main p{font-size:1.125rem;line-height:1.75rem}main [class*="md:text-lg"]{font-size:1.125rem;line-height:1.75rem}}',
  'html.js #seo-prerender{position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden}'
].join('');

const DEFERRED_STYLES_SCRIPT = "(function(){var links=document.querySelectorAll('link[data-wm-deferred-style]');for(var i=0;i<links.length;i++){links[i].addEventListener('load',function(){this.rel='stylesheet';},{once:true});}})();";

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
    <li><a href="https://www.wired.me/story/the-music-streaming-ceo-who-built-a-global-war-map">Featured in WIRED</a></li>
  </ul>
</div>
${HIDE_SCRIPT}`;

const welcomeContent = await renderWelcomeRoot();

const PAGES = [
  { file: 'index.html', content: indexContent, rootAttributes: '' },
  { file: 'welcome.html', content: welcomeContent, rootAttributes: ' data-wm-prerendered="welcome" data-wm-prerender-lang="en"' },
];

for (const { file, content, rootAttributes } of PAGES) {
  // Fail loudly if any key resolved to undefined — this prevents the build from
  // silently shipping "undefined" strings to crawlers.
  if (content.includes('undefined')) {
    console.error(`[prerender] ERROR: SEO content for ${file} contains literal "undefined". Check that all en.json keys referenced in this file exist.`);
    process.exit(1);
  }

  const htmlPath = resolve(__dirname, '../public/pro', file);
  let html = readFileSync(htmlPath, 'utf-8');
  html = inlineCriticalCss(html, file);
  if (!html.includes('<div id="root"></div>')) {
    console.error(`[prerender] ERROR: ${file} has no empty <div id="root"></div> to inject into.`);
    process.exit(1);
  }
  html = html.replace('<div id="root"></div>', `<div id="root"${rootAttributes}>${content}</div>`);
  writeFileSync(htmlPath, html, 'utf-8');
  console.log(`[prerender] Injected SEO content into public/pro/${file}`);
}
