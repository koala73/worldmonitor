import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const componentDir = resolve(repoRoot, 'src/components');
const viteConfigSource = readFileSync(resolve(repoRoot, 'vite.config.ts'), 'utf-8');
const manualChunksMatch = viteConfigSource.match(
  /manualChunks\(id(?:,\s*\{[^}]+\})?\)\s*\{([\s\S]*?)\n\s*\/\/ Give lazy-loaded locale chunks/,
);
assert.ok(
  manualChunksMatch,
  'Could not locate the manualChunks body in vite.config.ts; chunk guardrails would otherwise be vacuous.',
);
const manualChunksSource = manualChunksMatch[1];

function extractObjectEntries(objectName) {
  const match = viteConfigSource.match(new RegExp(`const ${objectName}:[\\s\\S]*?= \\{([\\s\\S]*?)\\n\\};`));
  assert.ok(match, `Could not locate ${objectName} in vite.config.ts.`);
  return new Map([...match[1].matchAll(/^\s*([A-Za-z0-9_]+):\s*'([^']+)'/gm)].map(([, key, value]) => [key, value]));
}

function extractArrayEntries(arrayName) {
  const match = viteConfigSource.match(new RegExp(`const ${arrayName} = \\[([\\s\\S]*?)\\] as const;`));
  assert.ok(match, `Could not locate ${arrayName} in vite.config.ts.`);
  return [...match[1].matchAll(/'([^']+)'/g)].map(([, value]) => value);
}

function panelKeyForFile(fileName) {
  const baseName = fileName.replace(/\.ts$/, '');
  if (baseName === 'Panel') return 'Panel';
  if (baseName.endsWith('Panel')) return baseName.slice(0, -'Panel'.length);
  if (baseName === 'CountryBriefPage' || baseName === 'RegionalIntelligenceBoard') return baseName;
  return null;
}

function lineNumberForOffset(source, offset) {
  return source.slice(0, offset).split('\n').length;
}

const panelCluster = extractObjectEntries('PANEL_CLUSTER');
const panelChunkNames = new Set(extractArrayEntries('PANEL_CHUNK_NAMES'));

describe('panel chunk assignment guardrails', () => {
  it('assigns every panel component file to a documented panel cluster', () => {
    const panelFiles = readdirSync(componentDir)
      .filter(file => file.endsWith('.ts'))
      .map(file => ({ file, key: panelKeyForFile(file) }))
      .filter(({ key }) => key !== null && key !== 'Panel');

    const missing = panelFiles
      .filter(({ key }) => !panelCluster.has(key))
      .map(({ file, key }) => `${file} (${key})`);
    assert.deepEqual(missing, [], 'Every panel component file must be assigned in PANEL_CLUSTER.');

    const stale = [...panelCluster.keys()]
      .filter((key) => key !== 'CountryBriefPage' && key !== 'RegionalIntelligenceBoard')
      .filter((key) => !existsSync(resolve(componentDir, `${key}Panel.ts`)));
    assert.deepEqual(stale, [], 'PANEL_CLUSTER contains entries for missing panel files.');

    const invalidChunks = [...panelCluster.entries()]
      .filter(([, chunk]) => !panelChunkNames.has(chunk))
      .map(([key, chunk]) => `${key}: ${chunk}`);
    assert.deepEqual(invalidChunks, [], 'PANEL_CLUSTER must only use PANEL_CHUNK_NAMES entries.');
  });

  it('wires panel modules through PANEL_CLUSTER instead of the monolithic panels chunk', () => {
    assert.match(
      manualChunksSource,
      /\bpanelChunkForComponentId\(id\)/,
      'manualChunks must classify panel files through panelChunkForComponentId().',
    );
    assert.match(
      viteConfigSource,
      /\bPANEL_CLUSTER\[panelKey\]/,
      'panelChunkForComponentId() must route panel files through PANEL_CLUSTER.',
    );
    assert.doesNotMatch(
      manualChunksSource,
      /return\s+'panels'/,
      'The monolithic panels chunk regresses cache invalidation and eager boot downloads.',
    );
  });

  it('keeps panel clusters out of the entry HTML modulepreload list', () => {
    assert.match(
      viteConfigSource,
      /LAZY_HTML_PRELOAD_CHUNKS = \[[^\]]*\.\.\.PANEL_CHUNK_NAMES/s,
      'Panel chunk names must feed the HTML preload filter.',
    );
  });

  it('keeps entry-shared support code out of lazy panel-support', () => {
    assert.match(
      viteConfigSource,
      /function hasStaticEntryImporter\(/,
      'manualChunks must distinguish static entry dependencies from lazy panel-only support.',
    );
    assert.match(
      manualChunksSource,
      /hasStaticEntryImporter\(id,\s*getModuleInfo\)\s*\?\s*'app-shared'\s*:\s*'panel-support'/,
      'Support modules shared by the static app shell must use app-shared, not lazy panel-support.',
    );
  });

  it('does not re-enable the old variant panel chunks', () => {
    assert.doesNotMatch(
      manualChunksSource,
      /return\s+'(?:core|full|finance|happy|tech)-panels'/,
      'Variant panel chunks previously created cross-chunk ESM evaluation cycles.',
    );
  });

  it('keeps generated service clients lazy in component modules', () => {
    const offenders = [];
    for (const file of readdirSync(componentDir).filter(file => file.endsWith('.ts'))) {
      const source = readFileSync(resolve(componentDir, file), 'utf-8');
      for (const match of source.matchAll(/^const\s+[A-Za-z0-9_]+(?:Client)?\s*=\s*new\s+[A-Za-z0-9_]+ServiceClient\b/gm)) {
        offenders.push(`${file}:${lineNumberForOffset(source, match.index ?? 0)}`);
      }
      for (const match of source.matchAll(/^\s*(?:private\s+|public\s+|protected\s+)?static\s+[^=\n]+=\s*new\s+[A-Za-z0-9_]+ServiceClient\b/gm)) {
        offenders.push(`${file}:${lineNumberForOffset(source, match.index ?? 0)}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'Generated ServiceClient instances in component modules must be created through lazy getters, not at module evaluation.',
    );
  });
});
