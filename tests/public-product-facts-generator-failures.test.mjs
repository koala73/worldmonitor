// Failure modes of generate-public-product-facts.mjs --check, split out of
// public-product-facts.test.mjs so they run in the unit shards. Each case
// starts its own tsx process, so they read no built output but take about a
// second apiece.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('public product facts generator failure modes', () => {
  it('derives the natural-disasters discovery note from the advertised registry URI', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { TOOL_REGISTRY } from './api/mcp/registry/index.ts';
      const natural = TOOL_REGISTRY.find((tool) => tool.name === 'get_natural_disasters');
      const currentVersion = Number(natural._uiResourceUri.match(/-v([0-9]+)[.]html$/)[1]);
      natural._uiResourceUri = 'ui://worldmonitor/natural-disasters-v' + (currentVersion + 1) + '.html';
      process.argv.push('--check');
      await import('./scripts/generate-public-product-facts.mjs');
    `], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /public\/\.well-known\/mcp\/server-card\.json is stale/);
  });

  it('flags the About page stale when a registry count it restates changes', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { CHOKEPOINT_REGISTRY } from './src/config/chokepoint-registry.ts';
      CHOKEPOINT_REGISTRY.push({ ...CHOKEPOINT_REGISTRY[0], id: 'about-drift-probe' });
      process.argv.push('--check');
      await import('./scripts/generate-public-product-facts.mjs');
    `], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /docs\/about\.mdx is stale/);
  });

  it('fails generation when an About page fact phrase loses its wording', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import fs from 'node:fs';
      const readFileSync = fs.readFileSync;
      fs.readFileSync = (path, ...rest) => {
        const text = readFileSync(path, ...rest);
        return String(path).endsWith('docs/about.mdx') ? String(text).replace(/subsea cables/, 'undersea links') : text;
      };
      (await import('node:module')).syncBuiltinESMExports();
      process.argv.push('--check');
      await import('./scripts/generate-public-product-facts.mjs');
    `], { cwd: ROOT, encoding: 'utf8' });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /docs\/about\.mdx: expected 1 match\(es\) of .*subsea cables/);
  });

  it('fails generation when a restated homepage source phrase loses its wording', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import fs from 'node:fs';
      const readFileSync = fs.readFileSync;
      fs.readFileSync = (path, ...rest) => {
        const text = readFileSync(path, ...rest);
        return String(path).endsWith('/index.html') && !String(path).includes('pro-test')
          ? String(text).replace(/observed source hosts/, 'upstream hosts')
          : text;
      };
      (await import('node:module')).syncBuiltinESMExports();
      process.argv.push('--check');
      await import('./scripts/generate-public-product-facts.mjs');
    `], { cwd: ROOT, encoding: 'utf8' });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /index\.html: expected 1 match\(es\) of .*observed source hosts/);
  });

  it('fails discovery generation when the natural-disasters tool is absent', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { TOOL_REGISTRY } from './api/mcp/registry/index.ts';
      TOOL_REGISTRY.splice(TOOL_REGISTRY.findIndex((tool) => tool.name === 'get_natural_disasters'), 1);
      process.argv.push('--check');
      await import('./scripts/generate-public-product-facts.mjs');
    `], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /get_natural_disasters must exist in TOOL_REGISTRY/);
  });

  it('fails discovery generation for an unrelated natural-disasters resource URI', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { TOOL_REGISTRY } from './api/mcp/registry/index.ts';
      TOOL_REGISTRY.find((tool) => tool.name === 'get_natural_disasters')._uiResourceUri = 'ui://unrelated/natural-disasters-v3.html';
      process.argv.push('--check');
      await import('./scripts/generate-public-product-facts.mjs');
    `], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /get_natural_disasters must advertise a ui:\/\/worldmonitor\/natural-disasters HTML resource/);
  });
});
