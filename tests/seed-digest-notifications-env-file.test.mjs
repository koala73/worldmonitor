// The digest cron reads UPSTASH_*, CONVEX_* and provider tokens straight from
// process.env at module scope. Every other scripts/ entry loads .env.local
// through loadEnvFile() first (AGENTS.md: never add an env parser or read
// credentials from $HOME). Dockerfile.digest-notifications keeps a tight COPY
// list, so the loader has to stay a leaf module or the image loses it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const program = (file) => {
  const source = readFileSync(resolve(root, file), 'utf8');
  return { source, ast: parse(source, { ecmaVersion: 'latest', sourceType: 'module' }) };
};

const isLoadEnvFileCall = (node) =>
  node.type === 'ExpressionStatement'
  && node.expression.type === 'CallExpression'
  && node.expression.callee.type === 'Identifier'
  && node.expression.callee.name === 'loadEnvFile';

describe('seed-digest-notifications loads credentials through loadEnvFile', () => {
  const { source, ast } = program('scripts/seed-digest-notifications.mjs');

  it('imports loadEnvFile from the leaf env module', () => {
    const imports = ast.body.filter((node) => node.type === 'ImportDeclaration' && node.source.value === './_env-file.mjs');
    assert.equal(imports.length, 1);
    assert.ok(imports[0].specifiers.some((s) => s.type === 'ImportSpecifier' && s.imported.name === 'loadEnvFile'));
  });

  it('calls loadEnvFile(import.meta.url) at module scope before the first process.env read', () => {
    const call = ast.body.find(isLoadEnvFileCall);
    assert.ok(call, 'no top-level loadEnvFile() call');
    const [arg] = call.expression.arguments;
    assert.equal(arg?.type, 'MemberExpression');
    assert.equal(source.slice(arg.start, arg.end), 'import.meta.url');
    const firstEnvRead = source.indexOf('process.env');
    assert.ok(firstEnvRead > call.end, 'process.env is read before loadEnvFile() runs');
  });
});

describe('scripts/_env-file.mjs stays a leaf module', () => {
  it('imports only node builtins, so one COPY line ships it', () => {
    const { ast } = program('scripts/_env-file.mjs');
    const sources = ast.body.filter((node) => node.type === 'ImportDeclaration').map((node) => node.source.value);
    assert.ok(sources.length > 0);
    for (const spec of sources) assert.match(spec, /^node:/, `${spec} would widen the digest image closure`);
    assert.ok(ast.body.some((node) => node.type === 'ExportNamedDeclaration' && node.declaration?.id?.name === 'loadEnvFile'));
  });

  it('is what _seed-utils re-exports, so the 149 seeders keep one loader', async () => {
    const seedUtils = await import('../scripts/_seed-utils.mjs');
    const envFile = await import('../scripts/_env-file.mjs');
    assert.equal(seedUtils.loadEnvFile, envFile.loadEnvFile);
    assert.equal(seedUtils.isTestRuntime, envFile.isTestRuntime);
  });
});
