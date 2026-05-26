import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const scriptPath = path.join(repoRoot, 'scripts', 'enforce-safe-html.mjs');

function makeFixture(source) {
  const root = path.join(tmpdir(), `wm-safe-html-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'fixture.ts'), source);
  return root;
}

function runGuard(root) {
  return spawnSync(process.execPath, [
    scriptPath,
    '--root',
    root,
    '--baseline',
    path.join(root, 'baseline.json'),
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

describe('safe HTML lint guard', () => {
  it('blocks unreviewed direct innerHTML assignments', () => {
    const root = makeFixture('const el = document.createElement("div");\nel.innerHTML = userHtml;\n');
    const result = runGuard(root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Direct innerHTML\/outerHTML assignment is blocked/);
    assert.match(result.stderr, /src\/fixture\.ts:2/);
  });

  it('allows documented audited exceptions', () => {
    const root = makeFixture('const el = document.createElement("div");\n// wm-safe-html: audited - static icon sprite generated at build time\nel.innerHTML = STATIC_ICON;\n');
    const result = runGuard(root);

    assert.equal(result.status, 0, result.stderr);
  });

  it('allows clear operations without an audit comment', () => {
    const root = makeFixture('const el = document.createElement("div");\nel.innerHTML = "";\n');
    const result = runGuard(root);

    assert.equal(result.status, 0, result.stderr);
  });

  it('blocks unreviewed Panel setContent calls', () => {
    const root = makeFixture('class TestPanel {\n  render(userHtml) {\n    this.setContent(`<div>${userHtml}</div>`);\n  }\n}\n');
    const result = runGuard(root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Panel\.setContent\(\) calls are also blocked/);
    assert.match(result.stderr, /src\/fixture\.ts:3/);
    assert.match(result.stderr, /\[panel-set-content\]/);
  });

  it('allows audited Panel setContent exceptions', () => {
    const root = makeFixture('class TestPanel {\n  render(staticHtml) {\n    // wm-safe-html: audited - static trusted fixture HTML\n    this.setContent(staticHtml);\n  }\n}\n');
    const result = runGuard(root);

    assert.equal(result.status, 0, result.stderr);
  });
});
