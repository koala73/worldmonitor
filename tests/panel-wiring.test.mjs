import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

function readRepoFile(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('full-variant awareness panels are registered, instantiated, and refreshed', () => {
  const panelsConfig = readRepoFile('src/config/panels.ts');
  const panelLayout = readRepoFile('src/app/panel-layout.ts');
  const dataLoader = readRepoFile('src/app/data-loader.ts');
  const appSource = readRepoFile('src/App.ts');

  for (const panelId of ['comms-health', 'economic-stress']) {
    assert.match(panelsConfig, new RegExp(`'${panelId}': \\{`));
  }

  assert.match(panelLayout, /new CommsHealthPanel\(\)/);
  assert.match(panelLayout, /this\.ctx\.panels\['comms-health'\] = /);
  assert.match(panelLayout, /new EconomicStressPanel\(\)/);
  assert.match(panelLayout, /this\.ctx\.panels\['economic-stress'\] = /);
  assert.match(dataLoader, /fetchCommsHealth/);
  assert.match(dataLoader, /fetchEconomicStress/);
  assert.match(dataLoader, /loadCommsHealth\(\)/);
  assert.match(dataLoader, /loadEconomicStress\(\)/);
  assert.match(dataLoader, /this\.ctx\.panels\['comms-health'\]/);
  assert.match(dataLoader, /this\.ctx\.panels\['economic-stress'\]/);

  assert.match(appSource, /this\.dataLoader\.loadCommsHealth\(\)/);
  assert.match(appSource, /this\.dataLoader\.loadEconomicStress\(\)/);
});
