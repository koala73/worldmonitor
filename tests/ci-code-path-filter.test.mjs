// The `changes` job in test.yml decides whether the `unit` job runs, and `unit`
// is where every generator drift test lives. It computes that decision with an
// awk program embedded in a single-quoted shell string — so a stray apostrophe
// in a comment ends the string, the step dies, and every dependent job reports
// "skipping" rather than "failed". `gh pr checks --watch` exits 0 on that, so
// the whole thing reads green while nothing was verified (#6038).
//
// These tests execute the real program extracted from the workflow, through
// bash, exactly as CI does.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(join(repoRoot, '.github/workflows/test.yml'), 'utf8');

/** The single-quoted awk program the `changes` job pipes its file list into. */
function extractAwkProgram(marker) {
  const at = workflow.indexOf(marker);
  assert.notEqual(at, -1, `test.yml must still assign ${marker}`);
  const open = workflow.indexOf("awk '", at);
  assert.notEqual(open, -1, `${marker} must be computed with a single-quoted awk program`);
  const close = workflow.indexOf("'", open + "awk '".length);
  assert.notEqual(close, -1, `${marker} awk program must be terminated`);
  return workflow.slice(open + "awk '".length, close);
}

/** Run the extracted program through bash the way the workflow step does. */
function runFilter(program, paths) {
  const script = `FILES=$(cat); printf '%s' "$(echo "$FILES" | awk '${program}')"`;
  return execFileSync('bash', ['-c', script], { input: paths.join('\n'), encoding: 'utf8' });
}

describe('#6038 CI code-path filter', () => {
  const program = extractAwkProgram('CODE=$(');

  it('parses as a shell-embedded program at all', () => {
    // An apostrophe anywhere in the program — including in a comment — ends the
    // shell string and makes the step exit non-zero before awk ever runs.
    assert.doesNotMatch(
      program,
      /'/,
      'the CODE awk program is single-quoted in the shell, so it must contain no apostrophes',
    );
    assert.equal(runFilter(program, ['scripts/build-ai-search.mjs']), '1');
  });

  it('routes public/ai-search.md to the unit job that guards it', () => {
    // Without this the drift test skips on exactly the PR that edits the file,
    // leaving the docs-stats exemption as the only gate that runs.
    assert.equal(runFilter(program, ['public/ai-search.md']), '1');
  });

  it('routes a published ranking snapshot to unit too', () => {
    // ai-search.md publishes that snapshot's ranked count and captured date, so
    // a snapshot-only PR must not skip the test that checks the page matches it.
    assert.equal(runFilter(program, ['docs/snapshots/resilience-ranking-2026-10-01.json']), '1');
  });

  it('still excludes ordinary markdown and docs', () => {
    assert.equal(runFilter(program, ['README.md']), '0');
    assert.equal(runFilter(program, ['docs/about.mdx']), '0');
    assert.equal(runFilter(program, ['CHANGELOG.md']), '0');
    assert.equal(runFilter(program, ['README.md', 'docs/about.mdx', 'public/ai-search.md']), '1');
  });
});
