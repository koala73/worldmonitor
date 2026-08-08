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
    const navigation = read('docs/docs.json');

    assert.match(navigation, /"api-versioning"/);
    assert.match(navigation, /"zh\/api-versioning"/);
  });
});
