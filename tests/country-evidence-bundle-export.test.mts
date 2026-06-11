import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createCountryDeepDivePanelHarness } from './helpers/country-deep-dive-panel-harness.mjs';

type ExportUtils = typeof import('../src/utils/export.ts');

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

    const bundle = buildCountryEvidenceBundle({
      country: 'Testland',
      code: 'TL',
      exportedAt: '2026-06-10T12:00:00.000Z',
      brief: 'Contact analyst@example.com with token=sk_live_abc1234567890 and user_abcdef123456.',
      headlines: [{
        title: 'Report includes wm_0123456789abcdef0123456789abcdef01234567',
        source: 'Desk user_abc12345',
        link: 'https://example.com/private',
        pubDate: '2026-06-10T11:00:00.000Z',
      }],
    });
    const markdown = renderCountryEvidenceMarkdown(bundle);

    assert.doesNotMatch(markdown, /analyst@example\.com/);
    assert.doesNotMatch(markdown, /sk_live_abc1234567890/);
    assert.doesNotMatch(markdown, /wm_0123456789abcdef0123456789abcdef01234567/);
    assert.doesNotMatch(markdown, /user_abcdef123456/);
    assert.match(markdown, /\[redacted-email\]/);
    assert.match(markdown, /\[redacted-secret\]/);
    assert.match(markdown, /\[redacted-user-id\]/);
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
    assert.match(legacySource, /if \(format === 'evidence-md'\) exportCountryEvidenceMarkdown\(data\)/);
    assert.match(legacySource, /data-format="json"/);
    assert.match(legacySource, /data-format="csv"/);

    assert.match(dossierSource, /exportCountryEvidenceMarkdown/);
    assert.match(dossierSource, /cdp-evidence-export-btn/);
    assert.match(dossierSource, /this\.exportEvidenceBundle\(\)/);
    assert.match(dossierSource, /exportCountryEvidenceMarkdown\(data\)/);
  });

  it('passes the active dossier context to the evidence exporter when clicked', async () => {
    const harness = await createCountryDeepDivePanelHarness();
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
});
