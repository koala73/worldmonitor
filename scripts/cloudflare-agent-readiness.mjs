import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import policy from './shared/agent-request-policy.json' with { type: 'json' };
import { loadEnvFile } from './_seed-utils.mjs';
import { cloudflareRequest, resolveToken, resolveZoneId } from './cloudflare-cache-rule.mjs';

const FIREWALL_PHASE = 'http_request_firewall_custom';
const BLOCK_RULES = ['Block API Bots', 'Block Scriptlike UAs'];

// This script owns the firewall half of agent readiness: the JSON block
// responses on the two bot rules. The cache half — keeping the declared AI
// agents off the shared HTML entry for `/` so middleware.ts can hand them
// /home.md — lives in scripts/cloudflare-cache-rule.mjs since #7804, as a
// carve-out inside the one managed document rule. The UA-keyed bypass this
// script used to append LAST in the cache phase is retired there
// (RETIRED_CACHE_RULES): two scripts each insisting on the last position would
// have moved each other's rule on every run.
export function planAgentReadiness(firewall) {
  const changes = [];
  for (const description of BLOCK_RULES) {
    const matches = firewall.rules.filter((rule) => rule.description === description);
    if (matches.length !== 1 || matches[0].action !== 'block' || matches[0].enabled === false) {
      throw new Error(`Expected one enabled block rule named ${description}`);
    }
    const rule = matches[0];
    const response = {
      status_code: 403,
      content_type: 'application/json',
      content: JSON.stringify(policy.blockedResponse),
    };
    if (!isDeepStrictEqual(rule.action_parameters?.response, response)) {
      const definition = Object.fromEntries(Object.entries(rule).filter(([key]) =>
        !['id', 'version', 'last_updated'].includes(key)));
      changes.push({
        phase: FIREWALL_PHASE, rulesetId: firewall.id, ruleId: rule.id,
        description, method: 'PATCH',
        body: { ...definition, action_parameters: { ...rule.action_parameters, response } },
      });
    }
  }

  return changes;
}

export async function runAgentReadiness(mode, { env = process.env, fetchImpl } = {}) {
  if (!['--plan', '--check', '--apply'].includes(mode)) throw new Error('Use --plan, --check, or --apply');
  const token = resolveToken(env);
  const zoneId = await resolveZoneId(token, { env, fetchImpl });
  const read = (phase) => cloudflareRequest(`/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`, { token, fetchImpl });
  const firewall = await read(FIREWALL_PHASE);
  const changes = planAgentReadiness(firewall);
  if (mode !== '--apply' || changes.length === 0) return { zone: 'worldmonitor.app', ready: changes.length === 0, changes };

  for (const change of changes) {
    const current = await read(change.phase);
    if (!isDeepStrictEqual(current.rules, firewall.rules)) {
      throw new Error('Cloudflare rules changed after planning. Run --plan again before applying.');
    }
    const updated = await cloudflareRequest(`/zones/${zoneId}/rulesets/${change.rulesetId}/rules/${change.ruleId}`, {
      token, fetchImpl, method: change.method, body: change.body,
    });
    firewall.rules = updated.rules;
  }
  const remaining = planAgentReadiness(await read(FIREWALL_PHASE));
  if (remaining.length) throw new Error('Cloudflare verification failed after apply');
  return { zone: 'worldmonitor.app', ready: true, applied: changes.map((change) => change.description) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !['--plan', '--check', '--apply'].includes(mode)) {
    console.error('Usage: node scripts/cloudflare-agent-readiness.mjs --plan|--check|--apply');
    process.exitCode = 1;
  } else {
    loadEnvFile(import.meta.url, { only: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ALL_ACCESS_TOKEN', 'CLOUDFLARE_ZONE_ID'] });
    runAgentReadiness(mode).then((result) => {
      console.log(JSON.stringify(result, null, 2));
      if (mode === '--check' && !result.ready) process.exitCode = 1;
    }).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
