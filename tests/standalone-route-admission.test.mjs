// The standalone-route admission audit in scripts/enforce-rate-limit-policies.mjs.
// Each fixture is a route shape a past fix changed: a route with no limiter, one
// that imported limiter-bearing helpers without calling the limiting one (x-feed,
// dd36085ef6), and the forms that do delegate admission.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { auditStandaloneRouteAdmission } from '../scripts/enforce-rate-limit-policies.mjs';

const root = mkdtempSync(join(tmpdir(), 'route-admission-'));
after(() => rmSync(root, { recursive: true, force: true }));

const write = (path, src) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), src);
};
const handler = (body) => `export default async function handler(req) {\n${body}\n}\n`;

write('api/_rate-limit.js', 'export async function checkRateLimit() { return null; }\n');
write('api/_relay.js', [
  "import { checkRateLimit } from './_rate-limit.js';",
  'export function getRelayBaseUrl() { return "x"; }',
  'export function createRelayHandler(cfg) { return async (req) => (cfg.requireRateLimit ? checkRateLimit(req, {}) : null); }',
].join('\n'));
write('api/mcp/auth.ts', [
  "import { checkRateLimit } from '../_rate-limit.js';",
  'export async function applyPerMinuteLimit(r: Request) { return checkRateLimit(r, {}); }',
  'export async function applyAnonDiscoveryLimit(r: Request) { return checkRateLimit(r, {}); }',
  'export async function applyFreeTierLimit(r: Request) { return checkRateLimit(r, {}); }',
].join('\n'));

write('api/bare.js', handler('  return new Response("ok");'));
write('api/helper-only.js', `import { getRelayBaseUrl } from './_relay.js';\n${handler('  return fetch(getRelayBaseUrl());')}`);
write('api/direct.js', `import { checkRateLimit } from './_rate-limit.js';\n${handler('  const limited = await checkRateLimit(req, {});\n  return limited ?? new Response("ok");')}`);
write('api/relay.js', "import { createRelayHandler } from './_relay.js';\nexport default createRelayHandler({ requireRateLimit: true });\n");
write('api/relay-unlimited.js', "import { createRelayHandler } from './_relay.js';\nexport default createRelayHandler({ relayPath: '/x' });\n");
write('api/comment-with-glob.js', [
  "import { checkRateLimit } from './_rate-limit.js';",
  '// api/*.js cannot import ../server/, so the limit lives here.',
  handler('  return (await checkRateLimit(req, {})) ?? new Response("ok");'),
].join('\n'));
write('api/call-only-in-comment.js', handler('  // await checkRateLimit(req, {});\n  return new Response("ok");'));
write('api/type-import.ts', `import type { Limiter } from './_rate-limit.js';\n${handler('  return new Response("ok");')}`);
write('api/svc/v1/[rpc].ts', "declare const createDomainGateway: (r: unknown[]) => (req: Request) => Promise<Response>;\nexport default createDomainGateway([]);\n");
write('api/svc/v1/alias.ts', "import gateway from './[rpc]';\nexport default (req: Request) => gateway(req);\n");
write('api/reexport.ts', "export { default } from './direct.js';\n");
write('api/reexport-bare.ts', "export { default } from './bare.js';\n");
write('api/upstash.ts', `import { Ratelimit } from '@upstash/ratelimit';\nconst rl = new Ratelimit({});\n${handler('  const { success } = await rl.limit("ip");\n  return new Response(String(success));')}`);
write('api/upstash-unused.ts', `import { Ratelimit } from '@upstash/ratelimit';\nconst rl = new Ratelimit({});\n${handler('  return new Response(String(rl));')}`);
write('api/proof-only.js', `import { checkIpScopedEdgeProof } from './_rate-limit.js';\n${handler('  return checkIpScopedEdgeProof(req, {}) ?? new Response("ok");')}`);
write('api/renamed-default.ts', "export { unprotected as default } from './two-handlers.js';\n");
write('api/two-handlers.js', `import { checkRateLimit } from './_rate-limit.js';\nexport async function unprotected() { return new Response('ok'); }\n${handler('  return (await checkRateLimit(req, {})) ?? new Response("ok");')}`);
write('api/mcp-route.ts', "import { applyAnonDiscoveryLimit } from './mcp/auth';\nexport default async (req: Request) => (await applyAnonDiscoveryLimit(req)) ?? new Response('ok');\n");
write('api/no-default.ts', 'export const value = 1;\n');
write('api/calls-tostring.js', handler('  return new Response(String(req).toString());'));
write('api/route.test.mjs', handler('  return new Response("ok");'));
write('api/_private.js', handler('  return new Response("ok");'));

const audit = (exempt = {}) => auditStandaloneRouteAdmission(exempt, root);

describe('standalone route admission audit', () => {
  it('flags routes whose own code never calls a limiter', () => {
    assert.deepEqual(audit().bare, [
      'api/bare.js',
      'api/call-only-in-comment.js',
      'api/calls-tostring.js',
      'api/helper-only.js',
      'api/proof-only.js',
      'api/reexport-bare.ts',
      'api/relay-unlimited.js',
      'api/renamed-default.ts',
      'api/type-import.ts',
      'api/upstash-unused.ts',
    ]);
  });

  it('accepts a direct call, a delegate call, an Upstash limiter and a default taken from an admitted route', () => {
    const { admission } = audit();
    assert.equal(admission.get('api/direct.js'), 'checkRateLimit');
    assert.equal(admission.get('api/comment-with-glob.js'), 'checkRateLimit');
    assert.equal(admission.get('api/relay.js'), 'createRelayHandler');
    assert.equal(admission.get('api/upstash.ts'), 'Ratelimit.limit');
    assert.equal(admission.get('api/mcp-route.ts'), 'applyAnonDiscoveryLimit');
    assert.equal(admission.get('api/svc/v1/alias.ts'), 'createDomainGateway via [rpc].ts');
    assert.equal(admission.get('api/reexport.ts'), 'checkRateLimit via direct.js');
  });

  it('serves only default-exporting files outside _ helpers and tests', () => {
    const { routes } = audit();
    assert.ok(!routes.includes('api/no-default.ts'));
    assert.ok(!routes.includes('api/route.test.mjs'));
    assert.ok(!routes.includes('api/_private.js'));
  });

  it('an exemption hides a bare route, and a stale exemption is reported', () => {
    const result = audit({ 'api/bare.js': { reason: 'r' }, 'api/direct.js': { reason: 'r' }, 'api/gone.js': { reason: 'r' } });
    assert.ok(!result.bare.includes('api/bare.js'));
    assert.deepEqual(result.staleExempt.sort(), ['api/direct.js', 'api/gone.js']);
  });

  it('a delegate that stops calling a limiter is reported even when its siblings still do', () => {
    assert.deepEqual(audit().problems, []);
    write('api/mcp/auth.ts', [
      "import { checkRateLimit } from '../_rate-limit.js';",
      'const viaHelper = (r: Request) => checkRateLimit(r, {});',
      'export async function applyPerMinuteLimit(r: Request) { return viaHelper(r); }',
      'export async function applyAnonDiscoveryLimit() { return null; }',
      'export async function applyFreeTierLimit(r: Request) { return checkRateLimit(r, {}); }',
    ].join('\n'));
    assert.deepEqual(audit().problems.map((p) => p.split(':')[0]), ['ADMISSION_DELEGATES.applyAnonDiscoveryLimit']);
  });
});
