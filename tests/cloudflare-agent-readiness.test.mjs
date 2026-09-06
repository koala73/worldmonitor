import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planAgentReadiness, runAgentReadiness } from '../scripts/cloudflare-agent-readiness.mjs';
import { AGENT_USER_AGENTS, RETIRED_CACHE_RULES, buildCorpusCacheRule } from '../scripts/cloudflare-cache-rule.mjs';
import policy from '../shared/agent-request-policy.json' with { type: 'json' };

function fixture() {
  return {
    firewall: { id: 'firewall', rules: [
      { id: 'auth', description: 'Allow authenticated API', action: 'skip', expression: 'authenticated', enabled: true },
      ...['Block API Bots', 'Block Scriptlike UAs'].map((description, i) => ({
        id: `block-${i}`, description, action: 'block', enabled: true, expression: `api-policy-${i}`,
      })),
    ] },
  };
}

// Reads of any phase but the firewall throw: the cache phase belongs to
// scripts/cloudflare-cache-rule.mjs (#7804) and this script must not touch it.
function fakeCloudflare(state, { drift = false } = {}) {
  const writes = [];
  let firewallReads = 0;
  return { writes, fetchImpl: async (url, options) => {
    const path = new URL(url).pathname;
    const response = (result) => Response.json({ success: true, result });
    if (path === '/client/v4/zones') return response([{ id: 'zone', name: 'worldmonitor.app' }]);
    if (options.method === 'GET') {
      if (path.includes('firewall_custom')) {
        if (drift && ++firewallReads === 2) state.firewall.rules[1].expression = 'changed-by-owner';
        return response(state.firewall);
      }
      throw new Error(`Unexpected read ${path}`);
    }
    const body = JSON.parse(options.body);
    writes.push({ method: options.method, path, body });
    assert.equal(options.method, 'PATCH');
    assert.ok(path.includes('/rulesets/firewall/'), `wrote outside the firewall phase: ${path}`);
    const ruleId = path.split('/').at(-1);
    const index = state.firewall.rules.findIndex((item) => item.id === ruleId);
    assert.notEqual(index, -1);
    state.firewall.rules[index] = { id: ruleId, ...body };
    return response(state.firewall);
  } };
}

describe('Cloudflare agent readiness', () => {
  it('rejects ambiguous CLI modes before loading credentials or making requests', () => {
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('../scripts/cloudflare-agent-readiness.mjs', import.meta.url)), '--apply', '--plan',
    ], { encoding: 'utf8', env: {} });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
    assert.equal(result.stdout, '');
  });

  it('leaves the homepage cache carve-out to the document rule (#7804)', () => {
    // The UA-keyed bypass this script used to append LAST in the cache phase
    // is now a carve-out inside the corpus rule's `/` claim, and that script
    // deletes the old rule if it ever meets it. Pin the hand-off from both
    // sides so neither script can quietly start owning the surface again.
    assert.ok(
      RETIRED_CACHE_RULES.some((rule) => rule.description === 'Agent homepage Markdown - bypass shared HTML cache'),
      'the document rule must retire the bypass this script used to manage',
    );
    const { expression } = buildCorpusCacheRule();
    for (const ua of policy.userAgents) {
      assert.ok(expression.includes(`lower(http.user_agent) contains "${ua.toLowerCase()}"`), `${ua} must be carved out of the / claim`);
    }
    assert.deepEqual([...AGENT_USER_AGENTS], policy.userAgents.map((ua) => ua.toLowerCase()));
    const changes = planAgentReadiness(fixture().firewall);
    assert.ok(changes.every((change) => change.phase === 'http_request_firewall_custom'), 'this script plans firewall changes only');
  });

  it('plans without a write and changes only the block response parameters', async () => {
    const state = fixture();
    const original = structuredClone(state);
    const api = fakeCloudflare(state);
    const result = await runAgentReadiness('--plan', { env: { CLOUDFLARE_API_TOKEN: 'test' }, fetchImpl: api.fetchImpl });
    assert.equal(result.ready, false);
    assert.equal(result.changes.length, 2);
    assert.equal(api.writes.length, 0);
    assert.deepEqual(state, original);
    for (const change of result.changes) {
      const originalRule = original.firewall.rules.find((rule) => rule.id === change.ruleId);
      const { id, ...definition } = originalRule;
      const { action_parameters, ...changedDefinition } = change.body;
      assert.deepEqual(changedDefinition, definition);
      const response = change.body.action_parameters.response;
      assert.equal(response.status_code, 403);
      assert.equal(response.content_type, 'application/json');
      assert.deepEqual(JSON.parse(response.content), policy.blockedResponse);
    }
  });

  it('applies individual rules, preserves security policy, verifies, and is idempotent', async () => {
    const state = fixture();
    const original = structuredClone(state.firewall.rules);
    const api = fakeCloudflare(state);
    const options = { env: { CLOUDFLARE_API_TOKEN: 'test' }, fetchImpl: api.fetchImpl };
    assert.equal((await runAgentReadiness('--apply', options)).ready, true);
    assert.deepEqual(api.writes.map((write) => write.method), ['PATCH', 'PATCH']);
    assert.deepEqual(state.firewall.rules.map(({ action_parameters, ...rest }) => rest), original);
    assert.equal((await runAgentReadiness('--apply', options)).ready, true);
    assert.equal(api.writes.length, 2);
  });

  it('stops on concurrent rule changes before writing', async () => {
    const api = fakeCloudflare(fixture(), { drift: true });
    await assert.rejects(runAgentReadiness('--apply', {
      env: { CLOUDFLARE_API_TOKEN: 'test' }, fetchImpl: api.fetchImpl,
    }), /changed after planning/);
    assert.equal(api.writes.length, 0);
  });

  it('refuses missing or disabled block rules', () => {
    const state = fixture();
    state.firewall.rules[1].enabled = false;
    assert.throws(() => planAgentReadiness(state.firewall), /Expected one enabled block rule/);
  });
});
