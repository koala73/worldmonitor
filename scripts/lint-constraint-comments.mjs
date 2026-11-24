import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import ts from 'typescript';

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function paths(...args) {
  return git(...args).split('\0').filter(Boolean);
}

const scope = ['src', 'server', 'api', 'tests', 'e2e', 'scripts', 'middleware.ts',
  ':(exclude)src/generated/**', ':(exclude)tests/fixtures/**'];
const constraint = /\b(?:do not remove|do not change (?:the )?wording|talk to [\w@.-]+(?: [\w.-]+){0,4} before changing)\b/gi;
const reference = git('rev-parse', '--verify', '--quiet', 'HEAD').trim();
let base = reference;
try {
  base = git('merge-base', 'origin/main', 'HEAD').trim();
} catch {
  // Shallow checkouts can still check local edits against HEAD.
}

const changed = paths('diff', '--name-only', '-z', '--diff-filter=ACMRT', base, '--', ...scope);
const untracked = paths('ls-files', '--others', '--exclude-standard', '-z', '--', ...scope);

for (const file of [...changed, ...untracked]) {
  if (!/\.[cm]?[jt]sx?$/.test(file) || !lstatSync(file).isFile()) continue;
  const source = readFileSync(file, 'utf8');
  const matches = [...source.matchAll(constraint)];
  if (!matches.length) continue;

  const diff = changed.includes(file)
    ? git('diff', '--follow', '--no-ext-diff', '--no-color', '--unified=0', base, '--', file)
    : null;
  const ranges = diff?.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm);
  const additions = ranges && Array.from(ranges, ([, start, length]) => [Number(start), Number(start) + Number(length ?? 1)]);
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest);
  for (const match of matches) {
    const line = tree.getLineAndCharacterOfPosition(match.index).line + 1;
    if (additions && !additions.some(([start, end]) => start <= line && line < end)) continue;
    const comment = ts.isInComment(tree, match.index);
    if (comment && match.index + match[0].length <= comment.end) {
      console.warn(`${file}:${line}: warning: "${match[0]}" — explain the external constraint or encode it in code or a test.`);
    }
  }
}
