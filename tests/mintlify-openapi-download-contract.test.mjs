import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { load as loadYaml } from 'js-yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docsConfig = JSON.parse(readFileSync(resolve(root, 'docs/docs.json'), 'utf8'));
const bundlePath = resolve(root, 'docs/api/worldmonitor.openapi.yaml');

function findTab(language, label) {
  const tabs = docsConfig.navigation.languages.find((entry) => entry.language === language)?.tabs;
  return tabs?.find((tab) => tab.tab === label);
}

describe('Mintlify OpenAPI download contract', () => {
  it('binds both API Reference tabs to the unified World Monitor bundle', () => {
    for (const [language, label] of [
      ['en', 'API Reference'],
      ['zh-Hans', 'API 参考'],
    ]) {
      const tab = findTab(language, label);
      assert.ok(tab, `${language} ${label} tab must exist`);
      assert.equal(
        tab.openapi,
        'api/worldmonitor.openapi.yaml',
        `${language} ${label} tab must inherit the unified OpenAPI bundle`,
      );
    }
  });

  it('keeps the configured bundle real and production-directed', () => {
    const bundle = loadYaml(readFileSync(bundlePath, 'utf8'));
    assert.equal(bundle.openapi, '3.1.0');
    assert.equal(bundle.info?.title, 'WorldMonitor API');
    assert.deepEqual(bundle.servers, [{ url: 'https://api.worldmonitor.app' }]);
    assert.ok(Object.keys(bundle.paths ?? {}).length > 0, 'the unified bundle must contain API paths');
  });
});
