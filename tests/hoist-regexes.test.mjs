import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

const script = resolve('scripts/hoist-regexes.mjs');

test('hoisting preserves repeated matching and leaves stateful iteration local', t => {
  const root = mkdtempSync(join(tmpdir(), 'hoist-regex-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = `"use strict";
function normalize(text) {
  return text.replace(/\\s+/g, ' ').trim();
}
function matches(text) {
  return /^a/i.test(text) && text.match(/a+/g)?.join(',');
}
function tokens(text) {
  return [...text.matchAll(/\\w+/g)].map(m => m[0]);
}
function scan(text) {
  const local = /a/g;
  let match;
  const indices = [];
  while ((match = local.exec(text))) indices.push(match.index);
  return indices;
}
function sticky(text) { return /a/y.test(text); }
function stickyReplace(text) { return text.replace(/a/y, 'b'); }
function dynamic(word, text) { return new RegExp(word).test(text); }
function fixed(text) { return new RegExp('^a', 'i').test(text); }
function invalid(text) { try { return new RegExp('[').test(text); } catch { return false; } }
const prefix = '^a';
function dependent(text) { return new RegExp(prefix, 'i').test(text); }
function shadowed(prefix, text) { return new RegExp(prefix).test(text); }
function localBinding(text) { const prefix = '^b'; return new RegExp(prefix).test(text); }
const workbox = { urlPattern: ({ url }) => /worker/.test(url.pathname) };
function namedMatcher({ url }) { return /named/.test(url.pathname); }
const namedWorkbox = { urlPattern: namedMatcher };
const flags = 'i';
function shadowFlags(flags, text) { return new RegExp('^a', flags).test(text); }
function shadowConstructor(RegExp) { return new RegExp('a').test('b'); }
const page = { evaluate(fn) { return fn(); } };
function browserCallback() { return /browser/.test('browser'); }
page.evaluate(browserCallback);
page.evaluate(() => /inline/.test('inline'));
function run() {
  return ['a aa', ' other ', '', 'a aa'].map(text => [
    normalize(text), matches(text), tokens(text), scan(text), sticky(text), stickyReplace(text), dynamic('a', text), fixed(text), dependent(text), invalid(text), shadowed('^b', text), localBinding(text), shadowFlags('', text), shadowConstructor(class { test() { return true; } }),
  ]);
}
JSON.stringify(run());
`;
  writeFileSync(join(root, 'fixture.js'), source);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', 'fixture.js'], { cwd: root });
  const run = args => execFileSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
  const before = runInNewContext(source);
  const report = JSON.parse(run([]));
  assert.equal(report.hoist, 6);
  assert.equal(report.skipped, 13);
  run(['--write']);
  const after = readFileSync(join(root, 'fixture.js'), 'utf8');
  assert.notEqual(after, source);
  assert.equal(runInNewContext(after), before);
  assert.notEqual(runInNewContext(after.replace('/^a/i', '/^z/i')), before);
  assert.match(after, /const local = \/a\/g/);
  assert.match(after, /return \/a\/y\.test/);
  assert.match(after, /replace\(\/a\/y/);
  const matcher = runInNewContext(`${after}\nworkbox.urlPattern.toString()`);
  assert.equal(runInNewContext(`(${matcher})({url: {pathname: 'worker'}})`), true);
  const named = runInNewContext(`${after}\nnamedWorkbox.urlPattern.toString()`);
  assert.equal(runInNewContext(`(${named})({url: {pathname: 'named'}})`), true);
  assert.equal(JSON.parse(run([])).hoist, 0);
  run(['--write']);
  assert.equal(readFileSync(join(root, 'fixture.js'), 'utf8'), after);
});

test('hoisting preserves mutations to array pattern and flag dependencies', t => {
  const root = mkdtempSync(join(tmpdir(), 'hoist-regex-array-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = `const words = ['alpha'];
const alias = words;
alias.push('beta');
const flags = ['i'];
flags[0] = '';
function matches(text) { return new RegExp(words.join('|')).test(text); }
function aliasMatches(text) { return new RegExp(alias.join('|')).test(text); }
function flagMatches(text) { return new RegExp('alpha', flags.join('')).test(text); }
function fixed(text) { return new RegExp(['alpha', 'beta'].join('|')).test(text); }
const beforeMutation = [matches('beta'), aliasMatches('beta'), flagMatches('ALPHA'), fixed('beta')];
words.push('gamma');
flags[0] = 'i';
JSON.stringify([beforeMutation, [matches('gamma'), aliasMatches('gamma'), flagMatches('ALPHA'), fixed('beta')]]);
`;
  writeFileSync(join(root, 'fixture.js'), source);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', 'fixture.js'], { cwd: root });
  const run = args => execFileSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
  const before = runInNewContext(source);
  assert.equal(before, '[[true,true,false,true],[true,true,true,true]]');
  run(['--write']);
  const after = readFileSync(join(root, 'fixture.js'), 'utf8');
  assert.notEqual(after, source, 'the literal-array pattern should still be hoisted');
  assert.equal(runInNewContext(after), before);
  assert.equal(JSON.parse(run([])).hoist, 0);
  run(['--write']);
  assert.equal(readFileSync(join(root, 'fixture.js'), 'utf8'), after);
});
