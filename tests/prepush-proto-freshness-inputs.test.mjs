// Regression for the proto-freshness per-gate cache (#7236 P1).
//
// `make generate` is not just `buf generate` + request-validation. It also
// runs every OpenAPI injector, and those injectors read shared and
// gateway-adjacent generation contracts. If PROTO_INPUTS or the proto trigger
// omit those files, a green proto run can be amended with an injector/contract
// edit and the hook will skip `make generate`, pushing stale docs/api.
//
// This suite scrapes the Makefile recipe and the hook. It does not run
// `make generate`. Coverage is checked with the same `git ls-files` pathspec
// enumeration the gate key uses.

import { strict as assert } from 'node:assert';
import { after, describe, test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAKEFILE = readFileSync(join(ROOT, 'Makefile'), 'utf8').replace(/\r\n/g, '\n');
const HOOK = readFileSync(join(ROOT, '.husky', 'pre-push'), 'utf8').replace(/\r\n/g, '\n');

function extractGenerateRecipe() {
  const match = MAKEFILE.match(/^generate:.*?\n((?:\t[^\n]*\n|#[^\n]*\n|\s*\n)+)/m);
  if (!match) throw new Error('generate target not found in Makefile');
  return match[0];
}

function extractBashArray(source, name) {
  const match = source.match(new RegExp(`${name}=\\(([\\s\\S]*?)\\)`));
  if (!match) throw new Error(`${name} array not found`);
  return [...match[1].matchAll(/'(?:\\.|[^'])*'|"(?:\\.|[^"])*"|[^\s]+/g)]
    .map((token) => token[0].replace(/^['"]|['"]$/g, ''));
}

function extractGenerateScripts(recipe) {
  return [...recipe.matchAll(/node\s+(scripts\/\S+\.mjs)/g)].map((match) => match[1]);
}

function walkScriptReads(absPath, inputs, seen = new Set()) {
  if (seen.has(absPath) || !existsSync(absPath)) return;
  seen.add(absPath);
  const source = readFileSync(absPath, 'utf8');
  for (const match of source.matchAll(/['"]((?:shared|scripts|server|src\/shared)\/[^'"]+)['"]/g)) {
    const rel = match[1];
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) continue;
    inputs.add(rel);
    if (/\.(mjs|js|ts)$/.test(rel)) walkScriptReads(abs, inputs, seen);
  }
  for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const resolved = resolve(dirname(absPath), match[1]);
    for (const candidate of [resolved, `${resolved}.mjs`, `${resolved}.js`, `${resolved}.ts`]) {
      if (!existsSync(candidate) || !candidate.startsWith(`${ROOT}/`)) continue;
      const rel = relative(ROOT, candidate);
      if (
        !rel.startsWith('scripts/')
        && !rel.startsWith('shared/')
        && !rel.startsWith('server/')
        && !rel.startsWith('src/shared/')
      ) continue;
      inputs.add(rel);
      walkScriptReads(candidate, inputs, seen);
    }
  }
}

function generateConsumedPaths() {
  const scripts = extractGenerateScripts(extractGenerateRecipe());
  const inputs = new Set(scripts);
  for (const script of scripts) {
    walkScriptReads(join(ROOT, script), inputs);
  }
  return [...inputs].sort();
}

function filesCoveredByPathspecs(pathspecs) {
  const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '--', ...pathspecs], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return new Set(out.split('\n').filter(Boolean));
}

const GIT_LOCAL_ENV_VARS = execFileSync('git', ['rev-parse', '--local-env-vars'], {
  encoding: 'utf8',
})
  .trim()
  .split('\n');

function isolatedGitEnv() {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  for (const name of GIT_LOCAL_ENV_VARS) delete env[name];
  return env;
}

function makeProtoInputRepo() {
  const root = mkdtempSync(join(tmpdir(), 'wm-proto-freshness-'));
  const git = (args) => execFileSync('git', args, { cwd: root, env: isolatedGitEnv(), encoding: 'utf8' });
  const write = (rel, contents) => {
    const target = join(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  };
  git(['init', '--quiet', '--initial-branch=main', '.']);
  git(['config', 'user.email', 'proto-freshness@example.invalid']);
  git(['config', 'user.name', 'Proto Freshness Fixture']);
  write('proto/service.proto', 'syntax = "proto3";\n');
  write('Makefile', 'generate:\n\t@true\n');
  write('scripts/generate-request-validation.mjs', 'export {}\n');
  write('scripts/openapi-inject-security.mjs', 'export const injector = 1;\n');
  write('src/generated/client.ts', 'export {}\n');
  write('docs/api/worldmonitor.openapi.yaml', 'openapi: 3.1.0\n');
  write('shared/openapi-filter-param-contracts.json', '{}\n');
  write('server/gateway.ts', 'export const PUBLIC_NO_AUTH_RPC_PATHS = new Set<string>();\n');
  write('server/_shared/entitlement-check.ts', 'export const ENDPOINT_ENTITLEMENTS = new Map<string, number>();\n');
  write('server/_shared/idempotency.ts', 'export const IDEMPOTENCY_EXEMPT_RPC_PATHS = new Set<string>();\n');
  write('src/shared/premium-paths.ts', 'export const PREMIUM_RPC_PATHS = new Set<string>();\n');
  git(['add', '-A']);
  git(['commit', '--quiet', '-m', 'base']);
  const cache = join(root, '.git', 'wm-prepush-gate-cache');
  const attest = (mode) => {
    try {
      execFileSync(
        'bash',
        [join(ROOT, 'scripts', 'prepush-attest.sh'), mode, cache, 'proto-freshness', 'true', ...(mode === 'gate-write' ? ['true'] : []), '--', ...extractBashArray(HOOK, 'PROTO_INPUTS')],
        { cwd: root, env: isolatedGitEnv(), encoding: 'utf8' },
      );
      return 0;
    } catch (error) {
      return error.status;
    }
  };
  return { root, write, attest };
}

describe('proto-freshness inputs cover every make generate script and generation contract', () => {
  const protoInputs = extractBashArray(HOOK, 'PROTO_INPUTS');
  const consumed = generateConsumedPaths();
  const covered = filesCoveredByPathspecs(protoInputs);

  test('Makefile generate invokes more than request-validation', () => {
    assert.ok(
      consumed.some((path) => path.startsWith('scripts/openapi-inject-')),
      'generate recipe must still run OpenAPI injectors — otherwise this suite is testing the wrong contract',
    );
    assert.ok(
      consumed.some((path) => path.startsWith('shared/') || path.startsWith('scripts/lib/')),
      'at least one injector must still read a shared generation contract',
    );
    assert.ok(
      consumed.some((path) => path.startsWith('server/') || path.startsWith('src/shared/')),
      'at least one injector helper must still read a gateway-adjacent generation contract',
    );
  });

  test('PROTO_INPUTS pathspecs cover every generate script and generation contract it reads', () => {
    const missing = consumed.filter((path) => !covered.has(path));
    assert.deepEqual(
      missing,
      [],
      `PROTO_INPUTS omits generate inputs (false skip / stale docs/api):\n${missing.map((path) => `  ${path}`).join('\n')}`,
    );
  });

  test('the proto trigger uses PROTO_INPUTS so an injector-only edit cannot skip the gate', () => {
    const start = HOOK.indexOf('Running proto freshness check');
    assert.ok(start >= 0, 'pre-push hook must contain the proto-freshness block');
    const block = HOOK.slice(start, start + 2500);
    assert.match(
      block,
      /git diff --name-only origin\/main -- "\$\{PROTO_INPUTS\[@\]\}"/,
      'proto trigger must reuse PROTO_INPUTS; a second hardcoded path list can omit an injector again',
    );
  });

  const fixtures = [];
  after(() => {
    for (const root of fixtures) rmSync(root, { recursive: true, force: true });
  });

  test('editing an OpenAPI injector invalidates a previously green proto-freshness key', () => {
    const fx = makeProtoInputRepo();
    fixtures.push(fx.root);
    assert.equal(fx.attest('gate-write'), 0);
    assert.equal(fx.attest('gate-read'), 0, 'identical inputs must hit');
    fx.write('scripts/openapi-inject-security.mjs', 'export const injector = 2;\n');
    assert.equal(fx.attest('gate-read'), 3, 'an injector amend must miss so make generate runs again');
  });

  test('editing a shared generation contract invalidates a previously green proto-freshness key', () => {
    const fx = makeProtoInputRepo();
    fixtures.push(fx.root);
    assert.equal(fx.attest('gate-write'), 0);
    fx.write('shared/openapi-filter-param-contracts.json', '{"changed":true}\n');
    assert.equal(fx.attest('gate-read'), 3, 'a shared-contract amend must miss so make generate runs again');
  });

  test('editing a gateway-adjacent generation contract invalidates a previously green proto-freshness key', () => {
    const fx = makeProtoInputRepo();
    fixtures.push(fx.root);
    assert.equal(fx.attest('gate-write'), 0);
    fx.write('server/gateway.ts', 'export const PUBLIC_NO_AUTH_RPC_PATHS = new Set<string>(["/api/probe"]);\n');
    assert.equal(fx.attest('gate-read'), 3, 'a gateway-contract amend must miss so make generate runs again');
  });
});
