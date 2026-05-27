import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const scriptPath = path.join(repoRoot, 'scripts', 'enforce-safe-html.mjs');
const legacyAuditMarker = 'wm-safe-html:' + ' audited';

function makeFixture(source) {
  const root = path.join(tmpdir(), `wm-safe-html-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'fixture.ts'), source);
  return root;
}

function runGuard(root, extraArgs = []) {
  return spawnSync(process.execPath, [
    scriptPath,
    '--root',
    root,
    '--baseline',
    path.join(root, 'baseline.json'),
    ...extraArgs,
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

  it('does not allow comment-audited direct innerHTML exceptions', () => {
    const root = makeFixture(`const el = document.createElement("div");\n// ${legacyAuditMarker} - static icon sprite generated at build time\nel.innerHTML = STATIC_ICON;\n`);
    const result = runGuard(root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Direct innerHTML\/outerHTML assignment is blocked/);
  });

  it('allows clear operations without an audit comment', () => {
    const root = makeFixture('const el = document.createElement("div");\nel.innerHTML = "";\n');
    const result = runGuard(root);

    assert.equal(result.status, 0, result.stderr);
  });

  it('does not treat innerHTML comparisons as assignments', () => {
    const root = makeFixture('const el = document.createElement("div");\nif (el.innerHTML === html) {\n  console.log("same");\n}\n');
    const result = runGuard(root);

    assert.equal(result.status, 0, result.stderr);
  });

  it('blocks bracket-notation direct HTML assignments', () => {
    const root = makeFixture('const el = document.createElement("div");\nel["innerHTML"] = userHtml;\n');
    const result = runGuard(root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[direct-html-assignment\]/);
  });

  it('blocks compound direct HTML assignments', () => {
    const root = makeFixture('const el = document.createElement("div");\nel.innerHTML += userHtml;\n');
    const result = runGuard(root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[direct-html-assignment\]/);
  });

  it('blocks direct HTML assignments split after the receiver', () => {
    const root = makeFixture('const el = document.createElement("div");\nel\n  .innerHTML = userHtml;\n');
    const result = runGuard(root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[direct-html-assignment\]/);
    assert.match(result.stderr, /src\/fixture\.ts:3/);
  });

  it('blocks direct insertAdjacentHTML calls', () => {
    const root = makeFixture('const el = document.createElement("div");\nel.insertAdjacentHTML("beforeend", userHtml);\n');
    const result = runGuard(root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Direct insertAdjacentHTML\(\) calls are blocked/);
    assert.match(result.stderr, /\[html-insertion-call\]/);
  });

  it('blocks unreviewed Panel setContent calls', () => {
    const root = makeFixture('class TestPanel {\n  render(userHtml) {\n    this.setContent(`<div>${userHtml}</div>`);\n  }\n}\n');
    const result = runGuard(root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Panel\.setContent\(\) calls are also blocked/);
    assert.match(result.stderr, /src\/fixture\.ts:3/);
    assert.match(result.stderr, /\[panel-set-content\]/);
  });

  it('blocks setContent calls on non-this receivers', () => {
    const root = makeFixture('function render(targetPanel, userHtml) {\n  targetPanel.setContent(`<div>${userHtml}</div>`);\n}\n');
    const result = runGuard(root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Panel\.setContent\(\) calls are also blocked/);
    assert.match(result.stderr, /src\/fixture\.ts:2/);
    assert.match(result.stderr, /\[panel-set-content\]/);
  });

  it('does not allow comment-audited Panel setContent exceptions', () => {
    const root = makeFixture(`class TestPanel {\n  render(staticHtml) {\n    // ${legacyAuditMarker} - static trusted fixture HTML\n    this.setContent(staticHtml);\n  }\n}\n`);
    const result = runGuard(root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Panel\.setContent\(\) calls are also blocked/);
  });

  it('fails when a legacy HTML sink is present in the baseline', () => {
    const root = makeFixture('const ok = true;\n');
    writeFileSync(path.join(root, 'baseline.json'), JSON.stringify({
      entries: [{
        file: 'src/fixture.ts',
        line: 1,
        kind: 'direct-html-assignment',
        fingerprint: 'legacy',
        code: 'el.innerHTML = html;',
      }],
    }));
    const result = runGuard(root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Safe HTML baseline must remain empty/);
  });

  it('rejects attempts to update the legacy baseline', () => {
    const root = makeFixture('const el = document.createElement("div");\nel.innerHTML = userHtml;\n');
    const result = runGuard(root, ['--update-baseline']);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--update-baseline has been removed/);
  });

  it('is wired into npm lint and the pre-push guardrail', () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const prePush = readFileSync(path.join(repoRoot, '.husky', 'pre-push'), 'utf8');

    assert.match(pkg.scripts.lint, /npm run lint:safe-html/);
    assert.match(prePush, /npm run lint:safe-html/);
  });

  it('does not baseline legacy HTML sinks in the project', () => {
    const baseline = JSON.parse(readFileSync(path.join(repoRoot, 'scripts', 'safe-html-baseline.json'), 'utf8'));

    assert.equal(baseline.entries.length, 0);
  });
});
