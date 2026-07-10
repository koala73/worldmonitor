import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createCountryDeepDivePanelHarness } from './helpers/country-deep-dive-panel-harness.mjs';
import { createBrowserEnvironment } from './helpers/runtime-config-panel-harness.mjs';

type ExportUtils = typeof import('../src/utils/export.ts');
type GlobalSnapshot = { exists: boolean; value: unknown };

async function loadExportUtils(): Promise<ExportUtils> {
  const tempDir = mkdtempSync(join(tmpdir(), 'wm-country-evidence-export-'));
  const outfile = join(tempDir, 'export-utils.bundle.mjs');
  const entry = resolve(process.cwd(), 'src/utils/export.ts');

  const stubModules = new Map([
    ['i18n-stub', `export function t(key) { return key; }`],
    ['dom-utils-stub', `
      export function trustedHtml(value) { return String(value ?? ''); }
      export function setTrustedHtml(el, value) { el.innerHTML = String(value ?? ''); }
    `],
  ]);

  const aliasMap = new Map([
    ['@/services/i18n', 'i18n-stub'],
    ['@/utils/dom-utils', 'dom-utils-stub'],
  ]);

  const plugin = {
    name: 'country-evidence-export-test-stubs',
    setup(buildApi: any) {
      buildApi.onResolve({ filter: /.*/ }, (args) => {
        const target = aliasMap.get(args.path);
        return target ? { path: target, namespace: 'stub' } : null;
      });
      buildApi.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
        contents: stubModules.get(args.path),
        loader: 'js',
      }));
    },
  };

  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    write: false,
    plugins: [plugin],
  });

  writeFileSync(outfile, result.outputFiles[0].text, 'utf8');
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  rmSync(tempDir, { recursive: true, force: true });
  return mod as ExportUtils;
}

function snapshotGlobal(name: string): GlobalSnapshot {
  return {
    exists: Object.prototype.hasOwnProperty.call(globalThis, name),
    value: (globalThis as Record<string, unknown>)[name],
  };
}

function restoreGlobal(name: string, snapshot: GlobalSnapshot): void {
  if (snapshot.exists) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: snapshot.value,
    });
    return;
  }
  delete (globalThis as Record<string, unknown>)[name];
}

function defineGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
}

function zeroCountryBriefSignals() {
  return {
    criticalNews: 0,
    protests: 0,
    militaryFlights: 0,
    militaryVessels: 0,
    militaryFlightsInCountry: 0,
    militaryVesselsInCountry: 0,
    outages: 0,
    aisDisruptions: 0,
    satelliteFires: 0,
    radiationAnomalies: 0,
    temporalAnomalies: 0,
    cyberThreats: 0,
    earthquakes: 0,
    displacementOutflow: 0,
    climateStress: 0,
    conflictEvents: 0,
    activeStrikes: 0,
    orefSirens: 0,
    orefHistory24h: 0,
    aviationDisruptions: 0,
    travelAdvisories: 0,
    travelAdvisoryMaxLevel: null,
    gpsJammingHexes: 0,
    isTier1: true,
    thermalEscalations: 0,
    sanctionsDesignations: 0,
    sanctionsNewDesignations: 0,
  };
}

async function loadCountryBriefPage(options: { premiumAccess?: boolean } = {}) {
  const premiumAccess = options.premiumAccess === true;
  const tempDir = mkdtempSync(join(tmpdir(), 'wm-country-brief-page-'));
  const outfile = join(tempDir, 'CountryBriefPage.bundle.mjs');
  const entry = resolve(process.cwd(), 'src/components/CountryBriefPage.ts');

  const stubModules = new Map([
    ['sanitize-stub', `
      export function escapeHtml(value) { return String(value ?? ''); }
      export function sanitizeUrl(value) { return value ?? ''; }
    `],
    ['intel-brief-stub', `export function formatIntelBrief(value) { return value; }`],
    ['i18n-stub', `
      export function t(key, params) {
        if (params && typeof params.count === 'number') return key + ':' + params.count;
        return key;
      }
    `],
    ['utils-stub', `
      export function getCSSColor() { return '#44ff88'; }
      export function showToast(message) {
        globalThis.__wmCountryBriefPageTestState.toasts.push(message);
      }
    `],
    ['related-assets-stub', `
      export function getNearbyInfrastructure() { return []; }
      export function haversineDistanceKm() { return 0; }
    `],
    ['ports-stub', `export const PORTS = [];`],
    ['export-stub', `
      const state = globalThis.__wmCountryBriefPageTestState;
      export function exportCountryBriefJSON(data) { state.jsonExports.push(data); }
      export function exportCountryBriefCSV(data) { state.csvExports.push(data); }
      export function exportCountryEvidenceMarkdown(data) { state.evidenceExports.push(data); }
    `],
    ['country-geometry-stub', `export const ME_STRIKE_BOUNDS = {};`],
    ['country-flag-stub', `export function toFlagEmoji(code, fallback = ':world:') { return code ? ':' + code + ':' : fallback; }`],
    ['dom-utils-stub', `
      function setAttributes(el, attrText) {
        for (const match of attrText.matchAll(/([A-Za-z0-9_-]+)="([^"]*)"/g)) {
          el.setAttribute(match[1], match[2]);
        }
      }

      function textFromHtml(html) {
        return String(html ?? '').replace(/<[^>]+>/g, '').trim();
      }

      function materializeCountryBriefExportControls(root, html) {
        if (!String(html).includes('cb-export-option')) return;
        const page = document.createElement('div');
        page.className = 'country-brief-page';
        const menu = document.createElement('div');
        menu.className = 'cb-export-menu hidden';
        for (const match of String(html).matchAll(/<button\\s+([^>]*class="[^"]*cb-export-option[^"]*"[^>]*)>([\\s\\S]*?)<\\/button>/g)) {
          const button = document.createElement('button');
          setAttributes(button, match[1]);
          button.textContent = textFromHtml(match[2]);
          menu.appendChild(button);
        }
        page.appendChild(menu);
        root.appendChild(page);
      }

      export function trustedHtml(value) { return String(value ?? ''); }

      export function setTrustedHtml(el, value) {
        const html = String(value ?? '');
        el.innerHTML = html;
        materializeCountryBriefExportControls(el, html);
      }
    `],
    ['auth-state-stub', `export function getAuthState() { return { user: null }; }`],
    ['panel-gating-stub', `export function hasPremiumAccess() { return ${premiumAccess ? 'true' : 'false'}; }`],
    ['analytics-stub', `
      export function trackGateHit(feature) {
        globalThis.__wmCountryBriefPageTestState.gateHits.push(feature);
      }
    `],
  ]);

  const aliasMap = new Map([
    ['@/utils/sanitize', 'sanitize-stub'],
    ['@/utils/format-intel-brief', 'intel-brief-stub'],
    ['@/services/i18n', 'i18n-stub'],
    ['@/utils', 'utils-stub'],
    ['@/services/related-assets', 'related-assets-stub'],
    ['@/config/ports', 'ports-stub'],
    ['@/utils/export', 'export-stub'],
    ['@/services/country-geometry', 'country-geometry-stub'],
    ['@/utils/country-flag', 'country-flag-stub'],
    ['@/utils/dom-utils', 'dom-utils-stub'],
    ['@/services/auth-state', 'auth-state-stub'],
    ['@/services/panel-gating', 'panel-gating-stub'],
    ['@/services/analytics', 'analytics-stub'],
  ]);

  const plugin = {
    name: 'country-brief-page-test-stubs',
    setup(buildApi: any) {
      buildApi.onResolve({ filter: /.*/ }, (args: any) => {
        const target = aliasMap.get(args.path);
        return target ? { path: target, namespace: 'stub' } : null;
      });
      buildApi.onLoad({ filter: /.*/, namespace: 'stub' }, (args: any) => ({
        contents: stubModules.get(args.path),
        loader: 'js',
      }));
    },
  };

  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    write: false,
    plugins: [plugin],
  });

  writeFileSync(outfile, result.outputFiles[0].text, 'utf8');
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  return {
    CountryBriefPage: mod.CountryBriefPage,
    cleanupBundle() {
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

async function createCountryBriefPageHarness(options: { premiumAccess?: boolean } = {}) {
  const originalGlobals = {
    document: snapshotGlobal('document'),
    window: snapshotGlobal('window'),
    localStorage: snapshotGlobal('localStorage'),
    requestAnimationFrame: snapshotGlobal('requestAnimationFrame'),
    cancelAnimationFrame: snapshotGlobal('cancelAnimationFrame'),
    navigator: snapshotGlobal('navigator'),
    HTMLElement: snapshotGlobal('HTMLElement'),
    HTMLButtonElement: snapshotGlobal('HTMLButtonElement'),
  };
  const browserEnvironment = createBrowserEnvironment();
  const state = {
    evidenceExports: [] as Array<Record<string, unknown>>,
    jsonExports: [] as Array<Record<string, unknown>>,
    csvExports: [] as Array<Record<string, unknown>>,
    gateHits: [] as string[],
    toasts: [] as string[],
  };

  defineGlobal('document', browserEnvironment.document);
  defineGlobal('window', browserEnvironment.window);
  defineGlobal('localStorage', browserEnvironment.localStorage);
  defineGlobal('requestAnimationFrame', browserEnvironment.requestAnimationFrame);
  defineGlobal('cancelAnimationFrame', browserEnvironment.cancelAnimationFrame);
  defineGlobal('navigator', browserEnvironment.window.navigator);
  defineGlobal('HTMLElement', browserEnvironment.HTMLElement);
  defineGlobal('HTMLButtonElement', browserEnvironment.HTMLButtonElement);
  defineGlobal('__wmCountryBriefPageTestState', state);

  let CountryBriefPage;
  let cleanupBundle: (() => void) | undefined;
  try {
    ({ CountryBriefPage, cleanupBundle } = await loadCountryBriefPage(options));
  } catch (error) {
    delete (globalThis as Record<string, unknown>).__wmCountryBriefPageTestState;
    restoreGlobal('document', originalGlobals.document);
    restoreGlobal('window', originalGlobals.window);
    restoreGlobal('localStorage', originalGlobals.localStorage);
    restoreGlobal('requestAnimationFrame', originalGlobals.requestAnimationFrame);
    restoreGlobal('cancelAnimationFrame', originalGlobals.cancelAnimationFrame);
    restoreGlobal('navigator', originalGlobals.navigator);
    restoreGlobal('HTMLElement', originalGlobals.HTMLElement);
    restoreGlobal('HTMLButtonElement', originalGlobals.HTMLButtonElement);
    throw error;
  }

  function cleanup() {
    cleanupBundle?.();
    delete (globalThis as Record<string, unknown>).__wmCountryBriefPageTestState;
    restoreGlobal('document', originalGlobals.document);
    restoreGlobal('window', originalGlobals.window);
    restoreGlobal('localStorage', originalGlobals.localStorage);
    restoreGlobal('requestAnimationFrame', originalGlobals.requestAnimationFrame);
    restoreGlobal('cancelAnimationFrame', originalGlobals.cancelAnimationFrame);
    restoreGlobal('navigator', originalGlobals.navigator);
    restoreGlobal('HTMLElement', originalGlobals.HTMLElement);
    restoreGlobal('HTMLButtonElement', originalGlobals.HTMLButtonElement);
  }

  return {
    createPage() {
      return new CountryBriefPage();
    },
    document: browserEnvironment.document,
    getOverlay() {
      return browserEnvironment.document.querySelector('.country-brief-overlay') as HTMLElement | null;
    },
    getEvidenceExports() {
      return state.evidenceExports;
    },
    getGateHits() {
      return state.gateHits;
    },
    getToasts() {
      return state.toasts;
    },
    cleanup,
  };
}

function dispatchDelegatedClick(delegateRoot: HTMLElement, target: HTMLElement): void {
  const event = new Event('click', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'target', { value: target });
  delegateRoot.dispatchEvent(event);
}

describe('country evidence bundle export', () => {
  it('builds a portable bundle with active signals, sources, freshness, and disclaimer', async () => {
    const { buildCountryEvidenceBundle, COUNTRY_EVIDENCE_PROVENANCE_DISCLAIMER } = await loadExportUtils();

    const bundle = buildCountryEvidenceBundle({
      country: 'France',
      code: 'fr',
      context: 'Country dossier',
      exportedAt: '2026-06-10T12:00:00.000Z',
      briefGeneratedAt: '2026-06-10T11:55:00.000Z',
      briefCached: false,
      score: 38,
      level: 'normal',
      trend: 'stable',
      components: { unrest: 8, conflict: 12, security: 9, information: 4 },
      signals: {
        criticalNews: 2,
        protests: 0,
        travelAdvisoryMaxLevel: 'reconsider',
      },
      brief: 'SITUATION NOW\n- Demonstrations remain localized.',
      headlines: [{
        title: 'Transport unions announce strikes',
        source: 'Reuters',
        link: 'https://example.com/story?x=1',
        pubDate: '2026-06-10T06:00:00.000Z',
      }],
    });

    assert.equal(bundle.country, 'France');
    assert.equal(bundle.code, 'FR');
    assert.equal(bundle.briefCacheStatus, 'fresh');
    assert.deepEqual(bundle.signals, [
      { label: 'Critical news', value: '2' },
      { label: 'Maximum travel advisory', value: 'reconsider' },
    ]);
    assert.equal(bundle.sources[0]?.publisher, 'Reuters');
    assert.equal(bundle.sources[0]?.url, 'https://example.com/story?x=1');
    assert.equal(bundle.sources[0]?.freshness, '6h old at export.');
    assert.equal(bundle.provenanceDisclaimer, COUNTRY_EVIDENCE_PROVENANCE_DISCLAIMER);
  });

  it('redacts secret-like URL credentials and query params while preserving benign citation params', async () => {
    const { buildCountryEvidenceBundle, renderCountryEvidenceMarkdown } = await loadExportUtils();
    const openAiProjectKey = ['sk', 'proj', 'urlredactionfixture1234567890', 'abcdef123456'].join('-');
    const awsAccessKey = ['AK', 'IA', 'URLREDACTEXAMPLE'].join('');
    const jwt = [
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      'eyJ1cmwiOiJyZWRhY3Rpb24tZml4dHVyZSJ9',
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    ].join('.');

    const bundle = buildCountryEvidenceBundle({
      country: 'Testland',
      code: 'TL',
      exportedAt: '2026-06-10T12:00:00.000Z',
      headlines: [{
        title: 'Credentialed source URL',
        source: 'Wire',
        link: `https://analyst:${openAiProjectKey}@example.com/story(2026)?x=1&api_key=${openAiProjectKey}&token=plain-secret-value&ref=${awsAccessKey}#id_token=${jwt}`,
        pubDate: '2026-06-10T11:00:00.000Z',
      }],
    });
    const url = bundle.sources[0]?.url ?? '';
    const markdown = renderCountryEvidenceMarkdown(bundle);

    assert.match(url, /^https:\/\/%5Bredacted-user-id%5D:%5Bredacted-secret%5D@example\.com\/story%282026%29\?/);
    assert.match(url, /[?&]x=1(?:&|#|$)/);
    assert.match(url, /[?&]api_key=%5Bredacted-secret%5D(?:&|#|$)/);
    assert.match(url, /[?&]token=%5Bredacted-secret%5D(?:&|#|$)/);
    assert.match(url, /[?&]ref=%5Bredacted-secret%5D(?:&|#|$)/);
    assert.match(url, /id_token=.*redacted-secret/);
    assert.doesNotMatch(url, new RegExp(openAiProjectKey));
    assert.doesNotMatch(url, new RegExp(awsAccessKey));
    assert.doesNotMatch(url, /eyJhbGci/);
    assert.doesNotMatch(markdown, new RegExp(openAiProjectKey));
    assert.doesNotMatch(markdown, new RegExp(awsAccessKey));
    assert.doesNotMatch(markdown, /eyJhbGci/);
  });

  it('omits unsafe or missing citations without fabricating source metadata', async () => {
    const { buildCountryEvidenceBundle, renderCountryEvidenceMarkdown } = await loadExportUtils();

    const bundle = buildCountryEvidenceBundle({
      country: 'Unknown',
      code: 'xx',
      exportedAt: '2026-06-10T12:00:00.000Z',
      headlines: [
        { title: '', source: '', link: '', pubDate: null },
        { title: 'Newswire note', source: '', link: '', pubDate: null },
        { title: 'Unsafe link', source: null, link: 'javascript:alert(1)', pubDate: 'not-a-date' },
      ],
    });
    const markdown = renderCountryEvidenceMarkdown(bundle);

    assert.equal(bundle.sources.length, 2);
    assert.equal(bundle.sources[0]?.title, 'Newswire note');
    assert.equal(bundle.sources[0]?.publisher, undefined);
    assert.equal(bundle.sources[0]?.url, undefined);
    assert.equal(bundle.sources[0]?.note, 'URL unavailable; citation link was not provided.');
    assert.equal(bundle.sources[1]?.url, undefined);
    assert.equal(bundle.sources[1]?.note, 'URL omitted because it was missing or unsafe.');
    assert.doesNotMatch(markdown, /javascript:alert/);
    assert.match(markdown, /Publisher: Unavailable/);
  });

  it('redacts secret-like values and private identifiers from rendered evidence', async () => {
    const { buildCountryEvidenceBundle, renderCountryEvidenceMarkdown } = await loadExportUtils();
    const legacyOpenAiKey = ['sk', 'live', 'abc1234567890'].join('_');
    const awsAccessKey = ['AK', 'IA', 'IOSFODNN7EXAMPLE'].join('');
    const awsSecret = ['wJalrXUtnFEMI', '/K7MDENG+bPxRfiCY', 'EXAMPLEKEY'].join('');
    const slackToken = ['xox', 'b-redacted-fixture-token'].join('');
    const googleKey = ['AI', 'za', 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p'].join('');
    const openAiProjectKey = ['sk', 'proj', 'abc1234567890abcdefABCDEF', 'xyz1234567890'].join('-');
    const colonOpenAiKey = ['sk', 'proj', 'colonredactionfixture1234567890', 'abcdef123456'].join('-');
    const jwt = [
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    ].join('.');

    const bundle = buildCountryEvidenceBundle({
      country: 'Testland',
      code: 'TL',
      exportedAt: '2026-06-10T12:00:00.000Z',
      brief: [
        'The session: closed-door talks remain underway.',
        `api_key: ${colonOpenAiKey}`,
        `Contact analyst@example.com with token=${legacyOpenAiKey} and user_abcdef123456.`,
        `AWS ${awsAccessKey} aws_secret_access_key=${awsSecret}`,
        `Slack ${slackToken} Google ${googleKey} OpenAI ${openAiProjectKey}`,
        `Authorization: Bearer ${jwt}`,
      ].join('\n'),
      headlines: [{
        title: 'Report includes wm_0123456789abcdef0123456789abcdef01234567',
        source: `Desk user_abc12345 ${slackToken}`,
        link: 'https://example.com/private',
        pubDate: '2026-06-10T11:00:00.000Z',
      }],
    });
    const markdown = renderCountryEvidenceMarkdown(bundle);

    assert.match(markdown, /The session: closed-door talks remain underway\./);
    assert.match(markdown, /api_key: \[redacted-secret\]/);
    assert.doesNotMatch(markdown, /session[:=]\s*\[redacted-secret\]/);
    assert.doesNotMatch(markdown, /analyst@example\.com/);
    assert.doesNotMatch(markdown, new RegExp(legacyOpenAiKey));
    assert.doesNotMatch(markdown, new RegExp(colonOpenAiKey));
    assert.doesNotMatch(markdown, /wm_0123456789abcdef0123456789abcdef01234567/);
    assert.doesNotMatch(markdown, /user_abcdef123456/);
    assert.doesNotMatch(markdown, new RegExp(awsAccessKey));
    assert.doesNotMatch(markdown, new RegExp(awsSecret.replace(/[+/]/g, '\\$&')));
    assert.doesNotMatch(markdown, new RegExp(slackToken));
    assert.doesNotMatch(markdown, new RegExp(googleKey));
    assert.doesNotMatch(markdown, new RegExp(openAiProjectKey));
    assert.doesNotMatch(markdown, /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9/);
    assert.match(markdown, /\[redacted-email\]/);
    assert.match(markdown, /\[redacted-secret\]/);
    assert.match(markdown, /\[redacted-user-id\]/);
  });

  it('escapes unlinked source titles and publisher markdown inline text', async () => {
    const { buildCountryEvidenceBundle, renderCountryEvidenceMarkdown } = await loadExportUtils();

    const markdown = renderCountryEvidenceMarkdown(buildCountryEvidenceBundle({
      country: 'Linkland',
      code: 'LL',
      exportedAt: '2026-06-10T12:00:00.000Z',
      headlines: [{
        title: 'Unlinked ](http://evil.com) title',
        source: 'Publisher [spoof](http://evil.com)',
        link: '',
        pubDate: '2026-06-10T11:00:00.000Z',
      }],
    }));

    assert.doesNotMatch(markdown, /\]\(http:\/\/evil\.com\)/);
    assert.match(markdown, /Unlinked \\\]\\\(http:\/\/evil\\\.com\\\) title/);
    assert.match(markdown, /Publisher: Publisher \\\[spoof\\\]\\\(http:\/\/evil\\\.com\\\)/);
  });

  it('renders Markdown with the expected handoff sections', async () => {
    const { buildCountryEvidenceBundle, renderCountryEvidenceMarkdown } = await loadExportUtils();

    const markdown = renderCountryEvidenceMarkdown(buildCountryEvidenceBundle({
      country: 'Norway',
      code: 'NO',
      exportedAt: '2026-06-10T12:00:00.000Z',
      score: 12,
      level: 'low',
      trend: 'stable',
      brief: '## Spoofed Sources\n- This heading came from AI text.',
      headlines: [{
        title: 'Grid operator updates alert level',
        source: 'NVE',
        link: 'https://example.org/report(2026)overview',
        pubDate: '2026-06-08T12:00:00.000Z',
      }],
    }));

    assert.match(markdown, /^# WorldMonitor Evidence Bundle: Norway \(NO\)/);
    assert.match(markdown, /## Risk Context/);
    assert.match(markdown, /## Selected Signals/);
    assert.match(markdown, /## Intelligence Brief/);
    assert.match(markdown, /> ## Spoofed Sources/);
    assert.doesNotMatch(markdown, /\n## Spoofed Sources/);
    assert.match(markdown, /## Sources/);
    assert.match(markdown, /\[Grid operator updates alert level\]\(https:\/\/example.org\/report%282026%29overview\)/);
    assert.match(markdown, /Freshness: 2d old at export\./);
    assert.match(markdown, /## Provenance Disclaimer/);
  });

  it('wires country brief export surfaces to the evidence Markdown exporter', () => {
    const legacySource = readFileSync(resolve(process.cwd(), 'src/components/CountryBriefPage.ts'), 'utf8');
    const dossierSource = readFileSync(resolve(process.cwd(), 'src/components/CountryDeepDivePanel.ts'), 'utf8');

    assert.match(legacySource, /exportCountryEvidenceMarkdown/);
    assert.match(legacySource, /data-format="evidence-md"/);
    assert.match(legacySource, /format === 'json' \|\| format === 'csv' \|\| format === 'evidence-md'/);
    assert.match(legacySource, /if \(format === 'evidence-md' && !this\.canExportEvidenceBundle\(\)\) return;/);
    assert.match(legacySource, /if \(format === 'evidence-md'\) exportCountryEvidenceMarkdown\(data\)/);
    assert.match(legacySource, /data-format="json"/);
    assert.match(legacySource, /data-format="csv"/);
    assert.match(legacySource, /trackGateHit\('evidence-export'\)/);

    assert.match(dossierSource, /exportCountryEvidenceMarkdown/);
    assert.match(dossierSource, /cdp-evidence-export-btn/);
    assert.match(dossierSource, /if \(!hasPremiumAccess\(getAuthState\(\)\)\)/);
    assert.match(dossierSource, /trackGateHit\('evidence-export'\)/);
    assert.match(dossierSource, /this\.exportEvidenceBundle\(\)/);
    assert.match(dossierSource, /exportCountryEvidenceMarkdown\(data\)/);
  });

  it('blocks country brief evidence export for free users', async () => {
    const harness = await createCountryBriefPageHarness({ premiumAccess: false });
    try {
      const page = harness.createPage();
      page.show('France', 'FR', null, zeroCountryBriefSignals());

      const overlay = harness.getOverlay();
      assert.ok(overlay, 'expected country brief overlay');
      const button = overlay.querySelector('[data-format="evidence-md"]') as HTMLElement | null;
      assert.ok(button, 'expected evidence export option');

      dispatchDelegatedClick(overlay, button);

      assert.equal(harness.getEvidenceExports().length, 0);
      assert.deepEqual(harness.getGateHits(), ['evidence-export']);
      assert.deepEqual(harness.getToasts(), ['Evidence export is available on Pro.']);
    } finally {
      harness.cleanup();
    }
  });

  it('passes the active dossier context to the evidence exporter for Pro users when clicked', async () => {
    const harness = await createCountryDeepDivePanelHarness({ premiumAccess: true });
    try {
      const panel = harness.createPanel();
      panel.show('France', 'FR', {
        code: 'FR',
        name: 'France',
        score: 38,
        level: 'normal',
        trend: 'stable',
        change24h: 0,
        components: { unrest: 8, conflict: 12, security: 9, information: 4 },
        lastUpdated: null,
      }, {
        criticalNews: 2,
        protests: 0,
        militaryFlights: 1,
        militaryVessels: 0,
        militaryFlightsInCountry: 0,
        militaryVesselsInCountry: 0,
        outages: 0,
        aisDisruptions: 0,
        satelliteFires: 0,
        radiationAnomalies: 0,
        temporalAnomalies: 0,
        cyberThreats: 0,
        earthquakes: 0,
        displacementOutflow: 0,
        climateStress: 0,
        conflictEvents: 0,
        activeStrikes: 0,
        orefSirens: 0,
        orefHistory24h: 0,
        aviationDisruptions: 0,
        travelAdvisories: 1,
        travelAdvisoryMaxLevel: 'exercise caution',
        gpsJammingHexes: 0,
        isTier1: true,
        thermalEscalations: 0,
        sanctionsDesignations: 0,
        sanctionsNewDesignations: 0,
      });
      panel.updateBrief({
        code: 'FR',
        brief: 'SITUATION NOW\n- Demonstrations remain localized.',
        generatedAt: '2026-06-10T11:55:00.000Z',
        cached: true,
      });
      panel.updateNews([{
        title: 'Transport unions announce strikes',
        source: 'Reuters',
        link: 'https://example.com/story',
        pubDate: '2026-06-10T06:00:00.000Z',
        threat: { level: 'medium' },
      }]);
      for (let attempt = 0; attempt < 25 && harness.getWidgets().length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      const button = harness.getPanelRoot()?.querySelector('.cdp-evidence-export-btn') as HTMLButtonElement | null;
      assert.ok(button, 'expected evidence export button');
      button.dispatchEvent(new Event('click'));

      const exports = harness.getEvidenceExports();
      assert.equal(exports.length, 1);
      assert.equal(exports[0].country, 'France');
      assert.equal(exports[0].code, 'FR');
      assert.equal(exports[0].context, 'Country dossier');
      assert.equal(exports[0].score, 38);
      assert.equal(exports[0].signals.criticalNews, 2);
      assert.equal(exports[0].signals.militaryFlights, 1);
      assert.equal(exports[0].brief, 'SITUATION NOW\n- Demonstrations remain localized.');
      assert.equal(exports[0].briefGeneratedAt, '2026-06-10T11:55:00.000Z');
      assert.equal(exports[0].briefCached, true);
      assert.equal(exports[0].headlines[0].title, 'Transport unions announce strikes');
      assert.equal(exports[0].headlines[0].source, 'Reuters');
      assert.equal(exports[0].headlines[0].link, 'https://example.com/story');
    } finally {
      harness.cleanup();
    }
  });

  it('blocks active dossier evidence export for free users', async () => {
    const harness = await createCountryDeepDivePanelHarness({ premiumAccess: false });
    try {
      const panel = harness.createPanel();
      panel.show('France', 'FR', null, {
        criticalNews: 0,
        protests: 0,
        militaryFlights: 0,
        militaryVessels: 0,
        militaryFlightsInCountry: 0,
        militaryVesselsInCountry: 0,
        outages: 0,
        aisDisruptions: 0,
        satelliteFires: 0,
        radiationAnomalies: 0,
        temporalAnomalies: 0,
        cyberThreats: 0,
        earthquakes: 0,
        displacementOutflow: 0,
        climateStress: 0,
        conflictEvents: 0,
        activeStrikes: 0,
        orefSirens: 0,
        orefHistory24h: 0,
        aviationDisruptions: 0,
        travelAdvisories: 0,
        travelAdvisoryMaxLevel: null,
        gpsJammingHexes: 0,
        isTier1: true,
        thermalEscalations: 0,
        sanctionsDesignations: 0,
        sanctionsNewDesignations: 0,
      });
      for (let attempt = 0; attempt < 25 && harness.getWidgets().length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      const button = harness.getPanelRoot()?.querySelector('.cdp-evidence-export-btn') as HTMLButtonElement | null;
      assert.ok(button, 'expected evidence export button');
      button.dispatchEvent(new Event('click'));

      assert.equal(harness.getEvidenceExports().length, 0);
      assert.deepEqual(harness.getGateHits(), ['evidence-export']);
      assert.deepEqual(harness.getToasts(), ['Evidence export is available on Pro.']);
    } finally {
      harness.cleanup();
    }
  });
});
