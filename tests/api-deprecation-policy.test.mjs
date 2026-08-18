import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const policyUrl = 'https://www.worldmonitor.app/docs/api-versioning';

describe('REST API versioning and deprecation policy', () => {
  it('keeps the policy discoverable from the OpenAPI generator and source bundle', () => {
    for (const path of [
      'proto/buf.gen.yaml',
      'docs/api/worldmonitor.openapi.yaml',
    ]) {
      assert.match(read(path), new RegExp(policyUrl.replaceAll('.', '\\.')));
    }
  });

  it('publishes an actionable lifecycle contract for agents', () => {
    const policy = read('docs/api-versioning.mdx');

    assert.match(policy, /\/api\/<domain>\/v<major>/);
    assert.match(policy, /Deprecation/);
    assert.match(policy, /Sunset/);
    assert.match(policy, /rel="deprecation"/);
    assert.match(policy, /six months/i);
    assert.match(policy, /90 days/i);
  });

  it('links the policy from agent-facing API discovery surfaces', () => {
    for (const path of [
      'docs/api-reference.mdx',
      'docs/agent-discovery.mdx',
      'public/api/llms.txt',
    ]) {
      assert.match(read(path), /api-versioning/);
    }
  });

  it('keeps the policy in both English and Chinese API navigation', () => {
    // Walk the parsed nav tree rather than grepping the raw file: a page name
    // appearing anywhere in docs.json — including inside an unrelated group or
    // a comment-like string — satisfied the previous regex without the page
    // actually being reachable from navigation.
    const navigation = JSON.parse(read('docs/docs.json'));
    const pages = [];
    (function collect(node) {
      if (typeof node === 'string') pages.push(node);
      else if (Array.isArray(node)) node.forEach(collect);
      else if (node && typeof node === 'object') Object.values(node).forEach(collect);
    })(navigation.navigation);

    assert.ok(pages.includes('api-versioning'), 'English nav must link the policy page');
    assert.ok(pages.includes('zh/api-versioning'), 'Chinese nav must link the policy page');
  });
});
