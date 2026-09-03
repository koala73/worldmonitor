// RUN WITH: `npm run test:data` OR `npx tsx --test tests/enforce-runtime-handler-contract.test.mjs`.
//
// scripts/enforce-runtime-handler-contract.mjs must reject the exact
// #4749 shape (Web-style single-argument default export under
// runtime:'nodejs'), accept the (req, res) shape, follow re-export shims, and
// pass the live repo. Fixtures are fed through `readSource` so the analyser
// runs on real parsed TypeScript/JavaScript, not on a regex.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  analyzeRouteFile,
  collectNodeRuntimeHandlerShapeViolations,
  collectRouteViolations,
} from '../scripts/enforce-runtime-handler-contract.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = resolve(ROOT, 'scripts/enforce-runtime-handler-contract.mjs');

function violationsFor(files, entry = Object.keys(files)[0]) {
  const readSource = (file) => {
    const key = Object.keys(files).find((name) => resolve('/fixture', name) === file || name === file);
    if (key === undefined) throw new Error(`fixture has no file ${file}`);
    return files[key];
  };
  // Re-export resolution goes through existsSync, which fixtures cannot
  // satisfy; the shim cases below use the live repo instead.
  const analysis = analyzeRouteFile(resolve('/fixture', entry), { readSource });
  return { analysis, violations: collectRouteViolations(analysis, entry) };
}

describe('enforce-runtime-handler-contract — fixtures', () => {
  it('rejects the #4749 shape: runtime nodejs with a Web-style single-argument default export', () => {
    const { analysis, violations } = violationsFor({
      'api/mcp-proxy.ts': [
        "export const config = { runtime: 'nodejs' };",
        'export default async function handler(req) {',
        "  if (req.headers.get('origin')) return new Response('x');",
        "  return new Response('ok');",
        '}',
      ].join('\n'),
    });
    assert.equal(analysis.runtime, 'nodejs');
    assert.equal(violations.length, 1);
    assert.match(violations[0].message, /takes 1 parameter/);
    assert.match(violations[0].message, /#4749/);
    assert.equal(violations[0].line, 2);
    assert.match(violations[0].remedy, /handler\(req, res\)/);
  });

  it('accepts runtime nodejs with a (req, res) default export', () => {
    const { violations } = violationsFor({
      'api/mcp-proxy.ts': [
        "export const config = { runtime: 'nodejs' };",
        'export default async function handler(req, res) {',
        '  res.writeHead(204); res.end();',
        '}',
      ].join('\n'),
    });
    assert.deepEqual(violations, []);
  });

  it('accepts typed IncomingMessage / ServerResponse parameters on a Node route', () => {
    const { violations } = violationsFor({
      'api/x.ts': [
        "import type { IncomingMessage, ServerResponse } from 'node:http';",
        "export const config = { runtime: 'nodejs' };",
        'export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> { res.end(); }',
      ].join('\n'),
    });
    assert.deepEqual(violations, []);
  });

  it('treats a route with no runtime declaration as Node (Vercel default) — api/story.js shape passes, single-arg fails', () => {
    const ok = violationsFor({ 'api/story.js': 'export default function handler(req, res) { res.end(); }\n' });
    assert.equal(ok.analysis.runtime, 'nodejs');
    assert.deepEqual(ok.violations, []);

    const bad = violationsFor({ 'api/oops.js': "export default async function handler(req) { return new Response('x'); }\n" });
    assert.equal(bad.violations.length, 1);
    assert.match(bad.violations[0].message, /no runtime declared \(Vercel defaults to Node\)/);
  });

  it('rejects a Node route whose first parameter is typed as Request or whose second is an Edge context', () => {
    const typedRequest = violationsFor({
      'api/x.ts': "export const config = { runtime: 'nodejs' };\nexport default async function handler(req: Request, res: unknown) {}\n",
    });
    assert.equal(typedRequest.violations.length, 1);
    assert.match(typedRequest.violations[0].message, /typed as Request/);

    const edgeContext = violationsFor({
      'api/x.ts': "export const config = { runtime: 'nodejs' };\nexport default (req, ctx: { waitUntil: (p: Promise<unknown>) => void }) => new Response('x');\n",
    });
    assert.equal(edgeContext.violations.length, 1);
    assert.match(edgeContext.violations[0].message, /Edge context/);
  });

  it('rejects HTTP-method / fetch named exports on a Node route (they flip Vercel to web-handler dispatch)', () => {
    const { violations } = violationsFor({
      'api/x.ts': [
        "export const config = { runtime: 'nodejs' };",
        "export async function POST(request: Request) { return new Response('x'); }",
        'export default function handler(req, res) { res.end(); }',
      ].join('\n'),
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0].message, /exports POST/);
  });

  it('rejects a Node route whose default export is a factory call the gate cannot verify', () => {
    const { violations } = violationsFor({
      'api/x.ts': "export const config = { runtime: 'nodejs' };\nexport default createDomainGateway({ service: 'x' });\n",
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0].message, /cannot be verified statically/);
  });

  it('accepts Edge routes with the Web signature — single-arg, (req, ctx) arrow, or factory call', () => {
    for (const source of [
      "export const config = { runtime: 'edge' };\nexport default async function handler(req) { return new Response('x'); }\n",
      "export const config = { runtime: 'edge' };\nexport default (req: Request, ctx: { waitUntil: (p: Promise<unknown>) => void }) => new Response('x');\n",
      "export const config = { runtime: 'edge' };\nexport default createDomainGateway({});\n",
    ]) {
      const { analysis, violations } = violationsFor({ 'api/x.ts': source });
      assert.equal(analysis.runtime, 'edge');
      assert.deepEqual(violations, [], source);
    }
  });

  it('rejects an Edge route that uses the Node (req, res) shape', () => {
    const { violations } = violationsFor({
      'api/x.ts': "export const config = { runtime: 'edge' };\nexport default function handler(req, res) { res.end(); }\n",
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0].message, /Edge route default-exports a Node-style/);
  });

  it('resolves `export default handler` to the local function it names', () => {
    const local = violationsFor({
      'api/x.ts': "export const config = { runtime: 'nodejs' };\nfunction handler(req, res) { res.end(); }\nexport default handler;\n",
    });
    assert.deepEqual(local.violations, []);

    const arrow = violationsFor({
      'api/x.ts': "export const config = { runtime: 'nodejs' };\nconst handler = async (req) => new Response('x');\nexport default handler;\n",
    });
    assert.equal(arrow.violations.length, 1);
    assert.match(arrow.violations[0].message, /takes 1 parameter/);
  });

  it('refuses to classify a runtime that is not a string literal', () => {
    const { violations } = violationsFor({
      'api/x.ts': "const RUNTIME = 'nodejs';\nexport const config = { runtime: RUNTIME };\nexport default function handler(req, res) {}\n",
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0].message, /not a string literal/);
  });

  it('ignores helper modules without a default export', () => {
    const { violations } = violationsFor({ 'api/mcp/utils.ts': 'export function helper() { return 1; }\n' });
    assert.deepEqual(violations, []);
  });
});

describe('enforce-runtime-handler-contract — live repo', () => {
  it('follows the api/mcp.ts re-export shim to api/mcp/handler.ts and classifies it as Edge', () => {
    const analysis = analyzeRouteFile(resolve(ROOT, 'api/mcp.ts'));
    assert.equal(analysis.runtime, 'edge');
    assert.equal(analysis.defaultExport?.kind, 'function');
    assert.ok(analysis.via.some((file) => file.endsWith('/api/mcp/handler.ts')), 'must resolve the re-export');
    assert.deepEqual(collectRouteViolations(analysis, 'api/mcp.ts'), []);
  });

  it('classifies api/mcp-proxy.ts as a Node route with a (req, res) default export', () => {
    const analysis = analyzeRouteFile(resolve(ROOT, 'api/mcp-proxy.ts'));
    assert.equal(analysis.runtime, 'nodejs');
    assert.equal(analysis.config.runtime, 'nodejs');
    assert.equal(analysis.defaultExport?.kind, 'function');
    assert.equal(analysis.defaultExport.params.length, 2);
    assert.deepEqual(analysis.webHandlerExports, []);
    assert.deepEqual(collectRouteViolations(analysis, 'api/mcp-proxy.ts'), []);
  });

  it('passes the whole tracked api/ surface and covers both runtimes', () => {
    const { routes, violations } = collectNodeRuntimeHandlerShapeViolations(ROOT);
    assert.deepEqual(violations, []);
    const byFile = new Map(routes.map((route) => [route.file, route]));
    assert.equal(byFile.get('api/mcp-proxy.ts')?.runtime, 'nodejs');
    assert.equal(byFile.get('api/story.js')?.runtime, 'nodejs');
    assert.equal(byFile.get('api/og-story.js')?.runtime, 'nodejs');
    assert.equal(byFile.get('api/mcp.ts')?.runtime, 'edge');
    assert.ok(routes.length > 50, `expected the full route inventory, got ${routes.length}`);
  });

  it('CLI exits 0 on the live repo and reports the inventory', () => {
    const result = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /runtime handler contract ok: \d+ tracked api\/ routes \(\d+ nodejs, \d+ edge\)/);
  });
});
