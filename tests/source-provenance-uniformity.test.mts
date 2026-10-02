/**
 * Curated provenance facts surface uniformly (#6419 step 1).
 *
 * Every `stateAffiliated` value and every `knownBiases` label in the registry
 * must reach the agent summary, the state object, and the primary-source HTML
 * for every source, with no exemption by tier, type, or risk class. The old
 * badge path returned null for reviewed `low`, which hid labels on exactly the
 * sources that carried them most often.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleFeedsModule } from './_lib/bundle-feeds-module.mts';
import * as provenance from '../shared/source-provenance.ts';
import { CONFIGURED_SOURCE_PROVENANCE_DECLARATIONS } from '../shared/source-provenance-declarations.ts';
import { getSourceTier } from '../server/_shared/source-tiers.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const tempDir = join(repoRoot, 'tmp-source-provenance-uniformity-test');

// Namespace access keeps each case red on its own when an export is missing.
const api = provenance as unknown as Record<string, any>;
const { SOURCE_PROPAGANDA_RISK, SOURCE_TYPES, getSourceProvenanceState } = provenance;

let renderer: {
  renderPrimarySourceProvenance: (name: string) => { riskBadge: string; tierBadge: string; facts?: string };
};

before(async () => {
  renderer = await bundleFeedsModule<typeof renderer>({
    repoRoot,
    tempDir,
    outfileName: 'uniformity-renderer-bundle.mjs',
    entryPoint: join(repoRoot, 'src/components/news/source-provenance.ts'),
  });
});

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function registryNames(): string[] {
  return [...new Set([
    ...Object.keys(SOURCE_PROPAGANDA_RISK),
    ...Object.keys(SOURCE_TYPES),
    ...Object.keys(CONFIGURED_SOURCE_PROVENANCE_DECLARATIONS),
  ])];
}

function curatedFacts(name: string): string[] {
  const profile = SOURCE_PROPAGANDA_RISK[name];
  if (!profile) return [];
  return [
    ...(profile.stateAffiliated ? [profile.stateAffiliated] : []),
    ...(profile.knownBiases ?? []),
  ];
}

describe('provenance facts reach every surface for every source (#6419)', () => {
  it('surfaces every stateAffiliated and knownBiases label in summary, state, and primary HTML', () => {
    const offenders: string[] = [];
    let labelled = 0;
    let labelledLow = 0;

    for (const name of registryNames()) {
      const profile = SOURCE_PROPAGANDA_RISK[name];
      const facts = curatedFacts(name);
      if (facts.length === 0) continue;
      const state = getSourceProvenanceState(name) as unknown as { knownBiases?: string[]; summary?: string; risk: string; type: string };
      const rendered = renderer.renderPrimarySourceProvenance(name);
      // Visible text only: a fact that survives only in a tooltip is not surfaced.
      const html = `${rendered.riskBadge}${rendered.facts ?? ''}`.replace(/\s+title="[^"]*"/g, '');
      const where = `${name} (tier ${getSourceTier(name)}, type ${state.type}, risk ${state.risk})`;
      if (profile?.knownBiases?.length) {
        labelled += 1;
        if (profile.risk === 'low') labelledLow += 1;
      }
      for (const fact of facts) {
        if (!state.summary?.includes(fact)) offenders.push(`${where}: summary lacks "${fact}"`);
        if (!html.includes(escapeHtml(fact))) offenders.push(`${where}: primary HTML lacks "${fact}"`);
      }
      for (const label of profile?.knownBiases ?? []) {
        if (!state.knownBiases?.includes(label)) offenders.push(`${where}: state.knownBiases lacks "${label}"`);
      }
    }

    assert.deepEqual(offenders, [], `curated facts dropped:\n${offenders.join('\n')}`);
    const expectedLabelled = Object.values(SOURCE_PROPAGANDA_RISK).filter((p) => p.knownBiases?.length).length;
    assert.equal(labelled, expectedLabelled, 'sweep must see every labelled registry entry');
    assert.ok(labelledLow > 0, 'labelled sources must include reviewed-low sources, the class the risk badge hides');
  });

  it('every state carries knownBiases and a summary, including unregistered sources', () => {
    for (const name of ['Reuters', 'Completely Unlisted Outlet XYZ']) {
      const state = getSourceProvenanceState(name) as unknown as { knownBiases?: string[]; summary?: string };
      assert.deepEqual(state.knownBiases, [], `${name} knownBiases must be present and empty`);
      assert.match(state.summary ?? '', /Perspective: none recorded\./, `${name} summary`);
    }
  });
});

describe('knownBiases registry lint (#6419)', () => {
  it('labels are trimmed, non-empty, unique per source, and never a domestic left/right lean', () => {
    assert.ok(api.LEAN_AXIS_LABEL instanceof RegExp, 'LEAN_AXIS_LABEL must be exported');
    const offenders: string[] = [];
    for (const [name, profile] of Object.entries(SOURCE_PROPAGANDA_RISK)) {
      const labels = profile.knownBiases;
      if (!labels) continue;
      if (labels.length === 0) offenders.push(`${name}: empty knownBiases (delete the key)`);
      if (new Set(labels).size !== labels.length) offenders.push(`${name}: duplicate labels`);
      for (const label of labels) {
        if (!label || label.trim() !== label) offenders.push(`${name}: untrimmed or empty "${label}"`);
        if (api.LEAN_AXIS_LABEL.test(label)) offenders.push(`${name}: lean-axis label "${label}"`);
      }
    }
    assert.deepEqual(offenders, [], offenders.join('\n'));
  });
});

describe('LEAN_AXIS_LABEL (#6419)', () => {
  it('rejects domestic left/right lean labels and their common rewordings', () => {
    for (const label of [
      'Center-left', 'Centre-right', 'Israeli centre-right', 'Israeli left-liberal', 'Far-right',
      'Left-wing', 'Right leaning', 'Left of centre', 'Conservative', 'Liberal', 'Progressive', 'Centrist',
    ]) {
      assert.ok(api.LEAN_AXIS_LABEL.test(label), `must reject "${label}"`);
    }
  });

  it('accepts conflict-alignment labels', () => {
    for (const label of [
      'Pro-Ukraine', 'Anti-Kremlin', 'Pro-EU', 'Israeli mainstream', 'Iranian opposition',
      'Opposition-leaning Venezuela analysis', 'Israeli-Palestinian human-rights perspective',
    ]) {
      assert.ok(!api.LEAN_AXIS_LABEL.test(label), `must accept "${label}"`);
    }
  });
});

describe('summary never contradicts a curated fact (#6419)', () => {
  it('a state-affiliated source is never summarised as independent', () => {
    const offenders = registryNames().filter((name) => {
      const state = getSourceProvenanceState(name);
      return state.stateAffiliated && /independent/i.test(state.summary.replace(state.note ?? '', ''));
    });
    assert.deepEqual(offenders, []);
  });

  it('official government sources are never called state-affiliated', () => {
    const offenders = registryNames().filter((name) => {
      const state = getSourceProvenanceState(name);
      return state.type === 'gov' && /State-affiliated/.test(state.summary);
    });
    assert.deepEqual(offenders, []);
  });
});

describe('provenance coverage (#6419)', () => {
  it('coverage numbers equal a direct tally of the registry, and the caveat names both', () => {
    assert.equal(typeof api.getProvenanceCoverage, 'function', 'getProvenanceCoverage must be exported');
    const names = registryNames();
    const coverage = api.getProvenanceCoverage();
    assert.equal(coverage.sources, names.length);
    assert.equal(coverage.riskReviewed, names.filter((n) => Object.hasOwn(SOURCE_PROPAGANDA_RISK, n)).length);
    assert.equal(coverage.stateAffiliated, names.filter((n) => SOURCE_PROPAGANDA_RISK[n]?.stateAffiliated).length);
    assert.equal(coverage.perspectiveLabelled, names.filter((n) => SOURCE_PROPAGANDA_RISK[n]?.knownBiases?.length).length);
    assert.ok(coverage.caveat.includes(String(coverage.perspectiveLabelled)));
    assert.ok(coverage.caveat.includes(String(coverage.sources)));
    assert.equal(api.getProvenanceCoverage(), coverage, 'memoised');
  });
});

describe('state affiliation survives a note (#6419)', () => {
  it('Voice of America summary and badge title both name USA', () => {
    const state = getSourceProvenanceState('Voice of America') as unknown as { summary?: string };
    assert.match(state.summary ?? '', /USA/);
    const badge = provenance.describePropagandaBadge(
      provenance.getSourcePropagandaRisk('Voice of America'),
      provenance.getSourceType('Voice of America'),
    );
    assert.ok(badge);
    assert.match(badge!.title, /USA/);
    assert.match(badge!.title, /US government-funded/);
  });
});

describe('MCP news app renders the shared summary (#6419)', () => {
  it('news-intelligence-app no longer derives provenance labels', () => {
    const source = readFileSync(join(repoRoot, 'api/mcp/ui/news-intelligence-app.ts'), 'utf8');
    assert.doesNotMatch(source, /riskReviewed/);
  });
});

process.on('exit', () => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
