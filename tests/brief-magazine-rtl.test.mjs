import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderBriefMagazine } from '../server/_shared/brief-render.js';
import { BRIEF_ENVELOPE_VERSION, BRIEF_LOCALIZED_ENVELOPE_VERSION } from '../shared/brief-envelope.js';
import { BRIEF_STRINGS } from '../shared/brief-strings.data.js';
import { htmlDirFor, isRtlLanguage, UI_LANGUAGES } from '../shared/ui-languages.js';
import { formatDigestHtml } from '../scripts/lib/digest-email-html.mjs';
import { injectEmailSummary } from '../scripts/lib/email-summary-html.mjs';

function envelope(lang) {
  const story = {
    category: 'Energy', country: 'IR / OM', threatLevel: 'high',
    headline: 'Hormuz stays open.', description: 'Shipping continues.', source: 'Reuters, AP',
    sourceUrl: 'https://example.com/a', clusterId: 'c1', whyMatters: 'Oil prices.',
  };
  const env = {
    version: lang ? BRIEF_LOCALIZED_ENVELOPE_VERSION : BRIEF_ENVELOPE_VERSION,
    issuedAt: 1_700_000_000_000,
    data: {
      user: { name: 'Elie', tz: 'Asia/Dubai' }, issue: '27.05', date: '2026-05-27', dateLong: '27 May 2026',
      digest: {
        greeting: 'Good evening.', lead: 'Lead.', numbers: { clusters: 3, multiSource: 2, surfaced: 1 },
        threads: [{ tag: 'Energy', teaser: 'Teaser.' }], signals: ['Signal.'], publicLead: 'Public lead.',
      },
      stories: [story],
    },
  };
  return lang ? { ...env, lang } : env;
}

const RENDERER = readFileSync(new URL('../server/_shared/brief-render.js', import.meta.url), 'utf8');
const CSS_START = RENDERER.indexOf('const STYLE_BLOCK = `');
const CSS = RENDERER.slice(CSS_START, RENDERER.indexOf('</style>`', CSS_START));

describe('ui-languages direction helpers', () => {
  it('isRtlLanguage is true only for ar and fa', () => {
    assert.deepEqual(UI_LANGUAGES.filter(isRtlLanguage), ['ar', 'fa']);
  });
  it('htmlDirFor returns rtl for ar and fa', () => {
    assert.equal(htmlDirFor('ar'), 'rtl');
    assert.equal(htmlDirFor('fa'), 'rtl');
    assert.equal(htmlDirFor('fr'), 'ltr');
    assert.equal(htmlDirFor('en'), 'ltr');
  });
});

describe('renderBriefMagazine — right-to-left', () => {
  it('a v5 ar envelope renders <html lang="ar" dir="rtl">', () => {
    assert.match(renderBriefMagazine(envelope('ar')), /<html lang="ar" dir="rtl">/);
    assert.match(renderBriefMagazine(envelope('fa')), /<html lang="fa" dir="rtl">/);
  });
  it('a v5 fr envelope and a v4 envelope render no dir attribute', () => {
    assert.match(renderBriefMagazine(envelope('fr')), /<html lang="fr">/);
    assert.match(renderBriefMagazine(envelope()), /<html lang="en">/);
  });
  it('public mode renders no dir attribute for a v5 ar envelope', () => {
    const html = renderBriefMagazine(envelope('ar'), { publicMode: true });
    assert.match(html, /<html lang="en">/);
    assert.doesNotMatch(html, /<html[^>]*dir=|<bdi>|<span dir="ltr">/);
  });
  it('source names, issue code and page counter are direction-isolated in an RTL page', () => {
    const html = renderBriefMagazine(envelope('ar'));
    assert.match(html, /<div class="page-number mono"><span dir="ltr">01 \/ \d\d<\/span><\/div>/);
    assert.match(html, /· <bdi><a class="source-link"[^>]*>Reuters, AP<\/a><\/bdi>/);
    assert.match(html, /<span class="tag"><bdi>IR \/ OM<\/bdi><\/span>/);
    assert.ok(html.includes('\u206627.05\u2069'), 'issue code isolated');
    assert.ok(html.includes('<h1><span dir="ltr">WorldMonitor<br/>Brief.</span></h1>'), 'brand isolated');
    assert.ok(html.includes('<div class="kicker"><bdi>27 May 2026</bdi></div>'), 'cover date isolated');
    assert.ok(html.includes('\u2066Asia/Dubai\u2069'), 'timezone isolated');
    assert.match(html, /· <span dir="ltr">[^<]+<\/span> ·/, 'running-head date isolated');
  });
  it('left-to-right pages carry no isolation markup', () => {
    for (const html of [renderBriefMagazine(envelope('fr')), renderBriefMagazine(envelope())]) {
      assert.doesNotMatch(html, /<bdi>|dir="ltr"|[\u2066\u2068\u2069]/);
    }
  });
  it('the stylesheet contains no physical left/right padding, margin, border or inset outside the symmetric rules', () => {
    const physical = CSS.split('\n').filter((line) => /(?:^|[\s;{])(?:padding|margin|border)-(?:left|right)\b|(?:^|[\s;{])(?:left|right):/.test(line.replace(/\/\*.*?\*\//g, '')));
    assert.deepEqual(physical.map((l) => l.trim()), [
      'width: 100%; position: absolute; bottom: 6vh; left: 0; padding: 0 6vw;',
      'position: fixed; bottom: var(--pager-bottom); left: 50%;',
      'top: 0; left: 0; right: 0;',
    ]);
  });
  it('Arabic-script headings are not tracked', () => {
    assert.match(RENDERER, /\[dir="rtl"\] \.digest h2, \[dir="rtl"\] \.story h3 \{\s*letter-spacing: normal;/);
  });
  it('the pager script branches on document direction', () => {
    const nav = RENDERER.slice(RENDERER.indexOf('const NAV_SCRIPT = `'));
    assert.match(nav, /var rtl = document\.documentElement\.dir === 'rtl';/);
    assert.match(nav, /'translateX\(' \+ \(rtl \? '' : '-'\) \+ \(current \* 100\) \+ 'vw\)'/);
    assert.match(nav, /e\.key === 'ArrowRight'\) \{ e\.preventDefault\(\); if \(rtl\) prev\(\); else next\(\); \}/);
    assert.match(nav, /e\.key === 'ArrowLeft'\) \{ e\.preventDefault\(\); if \(rtl\) next\(\); else prev\(\); \}/);
    assert.match(nav, /isVertical \? e\.deltaY : \(rtl \? -e\.deltaX : e\.deltaX\)/);
    assert.match(nav, /if \(rtl \? dx > 0 : dx < 0\) next\(\); else prev\(\);/);
  });
});

describe('brief strings — RTL arrows', () => {
  const forwardKeys = Object.keys(BRIEF_STRINGS.en).filter((k) => k !== 'mag.navHint' && typeof BRIEF_STRINGS.en[k] === 'string' && BRIEF_STRINGS.en[k].includes('→'));
  it('ar and fa forward arrows point left', () => {
    assert.ok(forwardKeys.length >= 5);
    for (const lang of ['ar', 'fa']) for (const k of forwardKeys) assert.ok(BRIEF_STRINGS[lang][k].includes('←'), `${lang} ${k}`);
  });
  it('no ar or fa string contains a rightward forward arrow', () => {
    for (const lang of ['ar', 'fa']) {
      for (const [k, v] of Object.entries(BRIEF_STRINGS[lang])) {
        if (typeof v !== 'string') continue;
        assert.ok(!v.replace('← →', '').includes('→'), `${lang} ${k}: ${v}`);
      }
    }
  });
});

describe('digest email — right-to-left', () => {
  const stories = [{ title: 'Hormuz stays open', link: 'https://example.com/a', severity: 'critical', sources: ['Reuters'], description: 'Shipping continues.' }];
  it('email HTML for lang=ar carries dir="rtl" and right-side accents', () => {
    const html = injectEmailSummary(formatDigestHtml(stories, Date.UTC(2026, 4, 27), { lang: 'ar' }), { lead: 'Lead.', threads: [], signals: [] }, 'ar');
    assert.match(html, /^<div dir="rtl" style="font-family/);
    assert.match(html, /border-right: 3px solid/);
    assert.match(html, /border-right:3px solid #4ade80/);
    assert.match(html, /<td style="padding-right: 10px;">/);
    assert.match(html, /<td style="text-align: left; vertical-align: middle;">/);
    assert.doesNotMatch(html, /border-left|padding-left/);
  });
  it('email HTML for lang=en keeps left-side accents and no dir', () => {
    const html = formatDigestHtml(stories, Date.UTC(2026, 4, 27), { lang: 'en' });
    assert.doesNotMatch(html, /dir="rtl"|border-right|padding-right/);
    assert.match(html, /border-left: 3px solid/);
    assert.match(html, /<td style="text-align: right; vertical-align: middle;">/);
  });
});
