#!/usr/bin/env node
/**
 * Postbuild prerender script — injects critical SEO content into the built HTML
 * so search engines see real content without executing JavaScript.
 *
 * Reads only keys that exist in pro-test/src/locales/en.json. If you remove a
 * key, also remove it here, otherwise the build will inject the literal string
 * "undefined" into the page that crawlers index.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const en = JSON.parse(readFileSync(resolve(__dirname, 'src/locales/en.json'), 'utf-8'));

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
    <li><a href="https://www.worldmonitor.app/">World Monitor — geopolitics &amp; intelligence dashboard</a></li>
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

// /welcome landing page — reads ONLY en.welcome.* keys.
const w = en.welcome;
const momentTitle = (moment) => moment.title ?? `${moment.title1} ${moment.title2}`;
const welcomeContent = `
<div id="seo-prerender" lang="en">
  <h1>${w.hero.headline1} ${w.hero.headline2}</h1>
  <p>${w.hero.eyebrow}. ${w.hero.sub}</p>
  <p>${w.hero.trustUsers} · ${w.hero.trustOpenSource}. <a href="https://www.worldmonitor.app/">${w.hero.ctaPrimary}</a> — ${w.hero.ctaFree}.</p>

  <h2>${w.live.title}</h2>
  <p>${w.live.subtitle}</p>
  <p>${w.live.cardHeadlines} · ${w.live.cardCii} · ${w.live.cardChokepoints} · ${w.live.cardMarkets}</p>

  <h2>What is World Monitor?</h2>
  <p>World Monitor is a free real-time global intelligence dashboard that correlates geopolitics, markets, commodities, shipping, aviation, infrastructure, cyber threats, weather and live news on one map. It is designed for people who need to see when separate signals converge before they become a consensus headline.</p>

  <h2>Best real-time geopolitical intelligence dashboard for markets</h2>
  <p>For market analysis, World Monitor combines country risk, conflict events, sanctions, shipping chokepoints, military flight activity, macro indicators, FX, equities, crypto, energy and safe-haven assets. The value is the correlation layer: geopolitical pressure, transmission path and price action are visible together instead of split across news, maps and market terminals.</p>

  <h2>Commodity disruption monitoring</h2>
  <p>For commodity intelligence, World Monitor connects physical supply signals with traded markets: AIS vessel movement, ports, pipelines, LNG, refineries, waterways, chokepoints, weather, fires, earthquakes, outages, conflict layers, oil, gas, gold, metals, grains, miners, shipping names and commodity-linked currencies. Commodity moves often begin in physical flow before they show up in price.</p>

  <h2>How World Monitor is different from a conflict map or market terminal</h2>
  <p>Conflict maps show events. Market terminals show prices. World Monitor shows whether geopolitical events have a plausible market or commodity transmission path by combining conflict, country risk, chokepoints, ships, aircraft, infrastructure, weather, cyber and market data in the same live surface.</p>

  <h2>Source-backed intelligence surfaces</h2>
  <p>World Monitor cites sources inside the dashboard and uses public or documented feeds including <a href="https://acleddata.com/">ACLED</a>, <a href="https://ucdp.uu.se/">UCDP</a>, <a href="https://aisstream.io/">AISStream</a>, <a href="https://opensky-network.org/">OpenSky</a>, <a href="https://firms.modaps.eosdis.nasa.gov/">NASA FIRMS</a>, <a href="https://earthquake.usgs.gov/">USGS</a>, <a href="https://fred.stlouisfed.org/">FRED</a>, <a href="https://www.imf.org/en/Data">IMF</a>, <a href="https://www.bis.org/">BIS</a>, <a href="https://www.eia.gov/opendata/">EIA</a> and <a href="https://finnhub.io/">Finnhub</a>.</p>

  <h2>${w.moments.title}</h2>
  <p>${w.moments.sub}</p>
  <h3>${momentTitle(w.moments.m1)}</h3><p>${w.moments.m1.kicker}.</p>
  <p>${w.moments.m1.s1} ${w.moments.m1.s2} ${w.moments.m1.s3} ${w.moments.m1.s4}</p>
  <h3>${momentTitle(w.moments.m2)}</h3><p>${w.moments.m2.kicker}.</p>
  <p>${w.moments.m2.s1} ${w.moments.m2.s2} ${w.moments.m2.s3} ${w.moments.m2.s4}</p>
  <h3>${momentTitle(w.moments.m3)}</h3><p>${w.moments.m3.kicker}.</p>
  <p>${w.moments.m3.s1} ${w.moments.m3.s2} ${w.moments.m3.s3} ${w.moments.m3.s4}</p>
  <h3>${momentTitle(w.moments.m4)}</h3><p>${w.moments.m4.kicker}.</p>
  <p>${w.moments.m4.s1} ${w.moments.m4.s2} ${w.moments.m4.s3} ${w.moments.m4.s4}</p>
  <p>${w.moments.bridge1} ${w.moments.bridge2}</p>

  <h2>${w.firstFive.title}</h2>
  <p>${w.firstFive.sub}</p>
  <dl>
    <dt>${w.firstFive.f1Title}</dt><dd>${w.firstFive.f1Desc}</dd>
    <dt>${w.firstFive.f2Title}</dt><dd>${w.firstFive.f2Desc}</dd>
    <dt>${w.firstFive.f3Title}</dt><dd>${w.firstFive.f3Desc}</dd>
    <dt>${w.firstFive.f4Title}</dt><dd>${w.firstFive.f4Desc}</dd>
    <dt>${w.firstFive.f5Title}</dt><dd>${w.firstFive.f5Desc}</dd>
  </dl>

  <h2>${w.depth.title}</h2>
  <p>${w.depth.sub}</p>
  <p>${w.depth.s1v} ${w.depth.s1l} · ${w.depth.s2v} ${w.depth.s2l} · ${w.depth.s3v} ${w.depth.s3l} · ${w.depth.s4v} ${w.depth.s4l} · ${w.depth.s5v} ${w.depth.s5l} · ${w.depth.s6v} ${w.depth.s6l} · ${w.depth.s7v} ${w.depth.s7l} · ${w.depth.s8v} ${w.depth.s8l} · ${w.depth.s9v} ${w.depth.s9l} · ${w.depth.s10v} ${w.depth.s10l} · ${w.depth.s11v} ${w.depth.s11l} · ${w.depth.s12v} ${w.depth.s12l} · ${w.depth.s13v} ${w.depth.s13l} · ${w.depth.s14v} ${w.depth.s14l} · ${w.depth.s15v} ${w.depth.s15l}</p>
  <dl>
    <dt>${w.depth.n1Title}</dt><dd>${w.depth.n1Desc}</dd>
    <dt>${w.depth.n2Title}</dt><dd>${w.depth.n2Desc}</dd>
    <dt>${w.depth.n3Title}</dt><dd>${w.depth.n3Desc}</dd>
    <dt>${w.depth.n4Title}</dt><dd>${w.depth.n4Desc}</dd>
    <dt>${w.depth.n5Title}</dt><dd>${w.depth.n5Desc}</dd>
    <dt>${w.depth.n6Title}</dt><dd>${w.depth.n6Desc}</dd>
  </dl>

  <h2>${w.agents.title}</h2>
  <p>${w.agents.sub}</p>
  <p>${w.agents.b1} · ${w.agents.b2} · ${w.agents.b3} · ${w.agents.b4}</p>

  <h2>${w.pricing.title1} ${w.pricing.title2}</h2>
  <p>${w.pricing.sub}</p>
  <h3>${w.pricing.freeTitle}</h3><p>${w.pricing.freeDesc}</p>
  <p>${w.pricing.freeF1} · ${w.pricing.freeF2} · ${w.pricing.freeF3} · ${w.pricing.freeF4}</p>
  <h3>${w.pricing.proTitle}</h3><p>${w.pricing.proDesc}</p>
  <p>${w.pricing.proF1} · ${w.pricing.proF2} · ${w.pricing.proF3} · ${w.pricing.proF4} · ${w.pricing.proF5}</p>
  <p>${w.pricing.note} — <a href="https://www.worldmonitor.app/pro">${w.pricing.cta}</a></p>

  <h2>${w.faq.title}</h2>
  <dl>
    <dt>${w.faq.q1}</dt><dd>${w.faq.a1}</dd>
    <dt>${w.faq.q2}</dt><dd>${w.faq.a2}</dd>
    <dt>${w.faq.q3}</dt><dd>${w.faq.a3}</dd>
    <dt>${w.faq.q4}</dt><dd>${w.faq.a4}</dd>
    <dt>${w.faq.q5}</dt><dd>${w.faq.a5}</dd>
    <dt>${w.faq.q6}</dt><dd>${w.faq.a6}</dd>
    <dt>${w.faq.q7}</dt><dd>${w.faq.a7}</dd>
    <dt>${w.faq.q8}</dt><dd>${w.faq.a8}</dd>
    <dt>${w.faq.q9}</dt><dd>${w.faq.a9}</dd>
  </dl>

  <h2>${w.cta.title}</h2>
  <p>${w.cta.subtitle}</p>
  <p><a href="https://www.worldmonitor.app/">${w.cta.button}</a> — ${w.cta.note}. <a href="https://www.worldmonitor.app/pro">${w.cta.secondary}</a></p>

  <h2>Explore more</h2>
  <ul>
    <li><a href="https://www.worldmonitor.app/pro">World Monitor Pro — AI analyst, digest &amp; MCP</a></li>
    <li><a href="https://www.worldmonitor.app/blog/">World Monitor Blog — OSINT guides &amp; analysis</a></li>
    <li><a href="https://www.worldmonitor.app/blog/posts/what-is-worldmonitor-real-time-global-intelligence/">What is World Monitor?</a></li>
    <li><a href="https://github.com/koala73/worldmonitor">Open source on GitHub (AGPL-3.0)</a></li>
    <li><a href="https://www.wired.me/story/the-music-streaming-ceo-who-built-a-global-war-map">Featured in WIRED</a></li>
  </ul>
</div>
${HIDE_SCRIPT}`;

const PAGES = [
  { file: 'index.html', content: indexContent },
  { file: 'welcome.html', content: welcomeContent },
];

for (const { file, content } of PAGES) {
  // Fail loudly if any key resolved to undefined — this prevents the build from
  // silently shipping "undefined" strings to crawlers.
  if (content.includes('undefined')) {
    console.error(`[prerender] ERROR: SEO content for ${file} contains literal "undefined". Check that all en.json keys referenced in this file exist.`);
    process.exit(1);
  }

  const htmlPath = resolve(__dirname, '../public/pro', file);
  let html = readFileSync(htmlPath, 'utf-8');
  if (!html.includes('<div id="root"></div>')) {
    console.error(`[prerender] ERROR: ${file} has no empty <div id="root"></div> to inject into.`);
    process.exit(1);
  }
  html = html.replace('<div id="root"></div>', `<div id="root">${content}</div>`);
  writeFileSync(htmlPath, html, 'utf-8');
  console.log(`[prerender] Injected SEO content into public/pro/${file}`);
}
