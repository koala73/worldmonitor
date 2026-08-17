import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

import { discoverProtoServiceNames, loadUnifiedOpenApiSpec } from './_lib/openapi-spec-cache.mjs';

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
  it('audits the complete discovered service surface', () => {
    assert.ok(serviceJsonSpecs.length > 0, 'service-spec discovery must not be empty');
    assert.deepEqual(
      serviceJsonSpecs.map((file) => file.replace(/\.openapi\.json$/, '')),
      discoverProtoServiceNames(),
      'generated JSON service specs must match the proto service universe exactly',
    );
    assert.deepEqual(
      serviceYamlSpecs.map((file) => file.replace(/\.yaml$/, '')),
      serviceJsonSpecs.map((file) => file.replace(/\.json$/, '')),
      'every JSON service spec must have the exact YAML sibling set',
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
    const bundle = loadUnifiedOpenApiSpec();
    assertServers(bundle, 'worldmonitor.openapi.yaml');
  });
});
