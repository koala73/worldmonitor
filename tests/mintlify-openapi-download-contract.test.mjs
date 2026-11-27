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
  it('binds every API Reference operation to a real World Monitor spec', () => {
    // Each service group carries its own spec, so no page in the tab can fall
    // back to Mintlify's demo specification (#6574). The tab itself carries
    // none: a tab-level spec also renders every operation into every sidebar
    // in the tab, which put ~7,400 characters of navigation ahead of each
    // page's main content (orank content-start-position).
    for (const [language, label] of [
      ['en', 'API Reference'],
      ['zh', 'API 参考'],
    ]) {
      const tab = findTab(language, label);
      assert.ok(tab, `${language} ${label} tab must exist`);
      assert.equal(tab.openapi, undefined, `${language} ${label} tab must not carry a tab-level spec`);
      assert.ok(Array.isArray(tab.dropdowns) && tab.dropdowns.length > 1, `${language} ${label} sidebar must be split`);
      const specs = new Set();
      const groups = [];
      const walk = (node) => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== 'object') return;
        if (node.openapi) {
          specs.add(node.openapi);
          groups.push(node);
        }
        Object.values(node).forEach(walk);
      };
      walk(tab.dropdowns);
      assert.ok(groups.length >= 30, `${language} ${label} must bind its service groups`);
      for (const spec of specs) {
        const doc = loadYaml(readFileSync(resolve(root, 'docs', spec), 'utf8'));
        assert.equal(doc.openapi, '3.1.0', spec);
        // Generated service specs target the API host; the hand-authored
        // commerce spec targets www, where those plain functions run.
        assert.ok(doc.servers?.length, spec);
        for (const server of doc.servers) assert.match(server.url, /^https:\/\/(?:api|www)\.worldmonitor\.app$/, spec);
      }
    }
  });

  it('publishes every bundle operation through a service group', () => {
    // A group with a spec renders every operation in it. The one operation
    // only the bundle carries, the chokepoint.disruption webhook, gets an MDX
    // page whose `openapi:` frontmatter names it. Navigation entries such as
    // "GET /path" or "webhook name" are not allowed: the docs-lint export runs
    // with --disable-openapi and fetches them as literal paths, which 404.
    const bundle = loadYaml(readFileSync(bundlePath, 'utf8'));
    const tab = findTab('en', 'API Reference');
    const bound = new Set();
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (typeof node === 'string') {
        assert.doesNotMatch(node, /^(?:(?:GET|POST|PUT|PATCH|DELETE) \/|webhook )/, `${node}: bind a spec or use an MDX page`);
        const mdx = readFileSync(resolve(root, 'docs', `${node}.mdx`), 'utf8');
        const reference = mdx.match(/^openapi:\s*"?[^\s"]+\s+([^"\n]+?)"?\s*$/m)?.[1];
        if (reference) bound.add(reference.startsWith('webhook ') ? reference : reference.toLowerCase());
        return;
      }
      if (!node || typeof node !== 'object') return;
      if (node.openapi) {
        assert.equal(node.pages, undefined, `${node.group}: a group with a spec renders all of its operations`);
        const spec = loadYaml(readFileSync(resolve(root, 'docs', node.openapi), 'utf8'));
        for (const [path, item] of Object.entries(spec.paths ?? {})) {
          for (const method of Object.keys(item)) bound.add(`${method} ${path}`);
        }
      }
      for (const key of ['pages', 'groups', 'dropdowns']) if (node[key]) walk(node[key]);
    };
    walk(tab.dropdowns);
    for (const [path, item] of Object.entries(bundle.paths)) {
      for (const method of Object.keys(item).filter((key) => ['get', 'post', 'put', 'patch', 'delete'].includes(key))) {
        assert.ok(bound.has(`${method} ${path}`), `${method.toUpperCase()} ${path} has no API Reference page`);
      }
    }
    for (const name of Object.keys(bundle.webhooks ?? {})) {
      assert.ok(bound.has(`webhook ${name}`), `webhook ${name} has no API Reference page`);
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
