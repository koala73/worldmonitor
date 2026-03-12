#!/usr/bin/env node
/**
 * Postbuild prerender script — injects critical SEO content into the built HTML
 * so search engines see real content without executing JavaScript.
 *
 * This is a lightweight SSG alternative: it embeds key text content
 * (headings, descriptions, FAQ answers) directly into the HTML body
 * as a hidden div that gets replaced when React hydrates.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const htmlPath = resolve(__dirname, '../public/pro/index.html');

const en = JSON.parse(readFileSync(resolve(__dirname, 'src/locales/en.json'), 'utf-8'));

const seoContent = `
<div id="seo-prerender" style="position:absolute;left:-9999px;top:-9999px;overflow:hidden;width:1px;height:1px;">
  <h1>${en.hero.title1} ${en.hero.title2}</h1>
  <p>${en.hero.subtitle}</p>
  <p>${en.hero.missionLine}</p>

  <h2>Plans</h2>
  <h3>${en.twoPath.proTitle}</h3>
  <p>${en.twoPath.proDesc}</p>
  <p>${en.twoPath.proF1}</p>
  <p>${en.twoPath.proF2}</p>
  <p>${en.twoPath.proF3}</p>
  <p>${en.twoPath.proF4}</p>

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
  <h3>${en.proShowcase.morningBriefs}</h3><p>${en.proShowcase.morningBriefsDesc}</p>
  <h3>${en.proShowcase.oneKey}</h3><p>${en.proShowcase.oneKeyDesc}</p>

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
  </dl>

  <h2>${en.finalCta.title}</h2>
  <p>${en.finalCta.subtitle}</p>
</div>`;

let html = readFileSync(htmlPath, 'utf-8');
html = html.replace('<div id="root"></div>', `<div id="root">${seoContent}</div>`);
writeFileSync(htmlPath, html, 'utf-8');
console.log('[prerender] Injected SEO content into public/pro/index.html');
