import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

// Guards the `servers` block injected by scripts/openapi-inject-servers.mjs
// (#4599). Without it the Mintlify docs site renders curl snippets against the
// placeholder base URL https://api.example.com. If a regenerate lands without
// the injection step, these assertions fail and flag the drop.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'docs/api');

const EXPECTED_URL = 'https://api.worldmonitor.app';

const serviceJsonSpecs = readdirSync(apiDir)
  .filter((f) => /Service\.openapi\.json$/.test(f))
  .sort();
const serviceYamlSpecs = readdirSync(apiDir)
  .filter((f) => /Service\.openapi\.yaml$/.test(f))
  .sort();

function assertServers(spec, label) {
  assert.ok(Array.isArray(spec.servers), `${label}: servers must be an array`);
  assert.ok(spec.servers.length >= 1, `${label}: servers must have at least one entry`);
  assert.equal(spec.servers[0].url, EXPECTED_URL, `${label}: servers[0].url must be the production base URL`);
}

describe('OpenAPI servers contract', () => {
  it('audits at least the full known service surface', () => {
    assert.ok(serviceJsonSpecs.length >= 34, `expected >= 34 JSON service specs, found ${serviceJsonSpecs.length}`);
    assert.equal(
      serviceYamlSpecs.length,
      serviceJsonSpecs.length,
      'expected a YAML sibling for every JSON service spec',
    );
  });

  for (const file of serviceJsonSpecs) {
    it(`${file} declares the production servers URL`, () => {
      const spec = JSON.parse(readFileSync(resolve(apiDir, file), 'utf8'));
      assertServers(spec, file);
    });
  }

  for (const file of serviceYamlSpecs) {
    it(`${file} declares the production servers URL`, () => {
      const spec = loadYaml(readFileSync(resolve(apiDir, file), 'utf8'));
      assertServers(spec, file);
    });
  }

  it('bundle (worldmonitor.openapi.yaml) still carries the servers URL', () => {
    const bundle = loadYaml(readFileSync(resolve(apiDir, 'worldmonitor.openapi.yaml'), 'utf8'));
    assertServers(bundle, 'worldmonitor.openapi.yaml');
  });
});
