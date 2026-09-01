import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { createDomainGateway } from '../server/gateway.ts';
import {
  appendDeprecationPolicyLink,
  appendDeprecationPolicyLinkToRecord,
  DEPRECATION_POLICY_LINK,
  DEPRECATION_POLICY_URL,
} from '../server/_shared/deprecation-policy.ts';
import handler from '../api/not-found.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const htmlPolicyUrl = 'https://www.worldmonitor.app/docs/api-versioning';
const staticPolicyUrl = 'https://www.worldmonitor.app/api-versioning.md';

describe('REST API versioning and deprecation policy', () => {
  it('keeps the policy discoverable from the OpenAPI generator and source bundle', () => {
    for (const path of [
      'proto/buf.gen.yaml',
      'docs/api/worldmonitor.openapi.yaml',
    ]) {
      const source = read(path);
      assert.match(source, new RegExp(htmlPolicyUrl.replaceAll('.', '\\.')));
      assert.match(source, /api-versioning\.md/);
    }
  });

  it('publishes an actionable lifecycle contract for agents', () => {
    for (const path of ['docs/api-versioning.mdx', 'public/api-versioning.md']) {
      const policy = read(path);
      assert.match(policy, /\/api\/<domain>\/v<major>/);
      assert.match(policy, /Deprecation/);
      assert.match(policy, /Sunset/);
      assert.match(policy, /rel="deprecation"/);
      assert.match(policy, /six months/i);
      assert.match(policy, /90 days/i);
      assert.match(policy, /api-versioning\.md/);
    }
  });

  it('links the policy from agent-facing API discovery surfaces', () => {
    for (const path of [
      'docs/api-reference.mdx',
      'docs/agent-discovery.mdx',
      'public/api/llms.txt',
      'public/agents.md',
      'public/llms.txt',
      'public/.well-known/api-catalog',
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

  it('advertises an absolute policy-discovery Link on homepage and /api/(.*) Vercel rules', () => {
    const vercel = JSON.parse(read('vercel.json'));
    const homepageLinks = vercel.headers
      .filter((rule) => rule.source === '/')
      .flatMap((rule) => rule.headers ?? [])
      .filter((header) => header.key === 'Link')
      .map((header) => header.value);
    assert.ok(
      homepageLinks.some((value) => /<\/api-versioning\.md>; rel="deprecation"; type="text\/markdown"/.test(value)),
      'a / homepage Link header must advertise the static REST deprecation policy',
    );

    const apiRule = vercel.headers.find((rule) => rule.source === '/api/(.*)');
    const apiLink = apiRule?.headers.find((header) => header.key === 'Link')?.value;
    assert.equal(
      apiLink,
      `<${staticPolicyUrl}>; rel="deprecation"; type="text/markdown"`,
      '/api/(.*) must use the absolute www policy URL so api.worldmonitor.app callers do not follow a root-relative 404',
    );
  });
});

describe('appendDeprecationPolicyLink', () => {
  it('sets the RFC 9745 policy-discovery Link and is idempotent', () => {
    const headers = new Headers();
    appendDeprecationPolicyLink(headers);
    assert.equal(headers.get('Link'), DEPRECATION_POLICY_LINK);
    appendDeprecationPolicyLink(headers);
    assert.equal(headers.get('Link'), DEPRECATION_POLICY_LINK);
    assert.equal(DEPRECATION_POLICY_URL, staticPolicyUrl);
  });

  it('appends beside an existing canonical Link on a record', () => {
    const headers = { Link: '</twin.md>; rel="canonical"' };
    appendDeprecationPolicyLinkToRecord(headers);
    assert.match(headers.Link, /rel="canonical"/);
    assert.match(headers.Link, /rel="deprecation"/);
    appendDeprecationPolicyLinkToRecord(headers);
    assert.equal(headers.Link.match(/rel="deprecation"/g)?.length, 1);
  });
});

describe('deprecation policy Link on live API handlers', () => {
  it('gateway success and OPTIONS responses carry rel="deprecation"', async () => {
    const gateway = createDomainGateway([
      {
        method: 'GET',
        path: '/api/seismology/v1/list-earthquakes',
        handler: async () => Response.json({ source: 'rpc' }),
      },
    ]);

    const ok = await gateway(new Request('https://worldmonitor.app/api/seismology/v1/list-earthquakes'));
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('link') ?? '', /rel="deprecation"/);
    assert.match(ok.headers.get('link') ?? '', /api-versioning\.md/);

    const options = await gateway(new Request('https://worldmonitor.app/api/seismology/v1/list-earthquakes', {
      method: 'OPTIONS',
      headers: { Origin: 'https://worldmonitor.app' },
    }));
    assert.equal(options.status, 204);
    assert.match(options.headers.get('link') ?? '', /rel="deprecation"/);
  });

  it('unmatched /api catch-all 404s advertise the same policy Link', async () => {
    const res = await handler(new Request('https://worldmonitor.app/api/definitely-missing'));
    assert.equal(res.status, 404);
    assert.match(res.headers.get('link') ?? '', /rel="deprecation"/);
    assert.match(res.headers.get('link') ?? '', /api-versioning\.md/);
  });
});
