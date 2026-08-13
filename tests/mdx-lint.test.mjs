/**
 * MDX lint: catches syntax that breaks Mintlify's MDX parser.
 *
 * Mintlify parses all .md and .mdx files as MDX, which means:
 * 1. `<foo` is interpreted as a JSX tag (bare angle brackets)
 * 2. `{expr}` is interpreted as a JSX expression (bare curly braces)
 * 3. `<https://example.com>` autolinks are not valid MDX
 *
 * All cause deploy failures when used outside fenced code blocks or
 * inline code spans. Fix: use `&lt;` / `&#123;` or wrap in backticks.
 *
 * Mintlify parses every non-ignored file on disk, not just the pages
 * reachable from docs.json navigation, so this walks the whole tree.
 * Files listed in docs/.mintignore are excluded from these checks.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const DOCS_DIR = fileURLToPath(new URL('../docs/', import.meta.url));

// Parse .mintignore for excluded files/dirs
const mintignorePath = join(DOCS_DIR, '.mintignore');
const ignored = existsSync(mintignorePath)
  ? readFileSync(mintignorePath, 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
  : [];

function isIgnored(relPath) {
  const posix = relPath.split(sep).join('/');
  return ignored.some(pattern => {
    if (pattern.endsWith('/')) {
      const dir = pattern.slice(0, -1);
      return posix === dir || posix.startsWith(pattern);
    }
    return posix === pattern;
  });
}

/**
 * Mintlify parses every .md/.mdx file it finds under docs/, not only the
 * pages wired into docs.json. Anything unreachable from navigation still
 * fails the build the moment its path is in a deployment's changed set.
 */
function collectDocFiles(dir, found = []) {
  for (const entry of readdirSync(dir).sort()) {
    const abs = join(dir, entry);
    if (isIgnored(relative(DOCS_DIR, abs))) continue;
    if (statSync(abs).isDirectory()) collectDocFiles(abs, found);
    else if (entry.endsWith('.mdx') || entry.endsWith('.md')) found.push(abs);
  }
  return found;
}

const docFiles = collectDocFiles(DOCS_DIR);

/** Length of the leading YAML frontmatter block, in lines (0 when absent). */
function frontmatterLength(lines) {
  if (lines[0]?.trim() !== '---') return 0;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return i + 1;
  }
  return 0;
}

/** Strip frontmatter, fenced code blocks and inline code spans from content. */
function stripCode(content) {
  const lines = content.split('\n');
  let inFence = false;
  const result = [];
  // Frontmatter is YAML, not MDX — Mintlify never parses it as content.
  const bodyStart = frontmatterLength(lines);

  for (let i = 0; i < lines.length; i++) {
    if (i < bodyStart) {
      result.push('');
      continue;
    }
    const line = lines[i];
    // Fences inside list items are indented, so anchor on leading whitespace.
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      result.push('');
      continue;
    }
    if (inFence) {
      result.push('');
      continue;
    }
    // Strip inline code spans
    result.push(line.replace(/`[^`]+`/g, ''));
  }
  return result;
}

/** Find bare angle brackets: < followed by syntax Mintlify treats as JSX. */
function findBareAngleBrackets(lines) {
  const issues = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/<[=\d-]|<https?:|\b[A-Za-z_$][\w$.-]*<(?!\/)[^>\n]+>/);
    if (match) {
      issues.push({ line: i + 1, text: lines[i].trim(), type: 'angle bracket' });
    }
  }
  return issues;
}

/** Find bare curly braces interpreted as JSX expressions. */
function findBareCurlyBraces(lines) {
  const issues = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match {word} patterns that MDX will try to evaluate as JS
    // Skip empty braces {} and braces with spaces only (table alignment etc.)
    if (/\{[a-zA-Z_$]/.test(line)) {
      issues.push({ line: i + 1, text: line.trim(), type: 'curly brace' });
    }
  }
  return issues;
}

describe('MDX lint covers the whole published tree', () => {
  it('walks nested directories, not just top-level and navigation pages', () => {
    const names = docFiles.map(f => relative(DOCS_DIR, f).split(sep).join('/'));
    // A silently-empty walk would make every check below pass vacuously.
    assert.ok(names.length > 300, `expected the docs tree, got ${names.length} files`);
    assert.ok(
      names.some(n => n.includes('/')),
      'walk found no nested files — it is only reading the top level'
    );
    // Regression anchor: this page is nested and absent from docs.json
    // navigation, so the old top-level+navigation corpus never saw it and
    // its `<5% GDP` reached Mintlify (deploy failure, 2026-08-12).
    assert.ok(
      names.includes('methodology/financial-system-exposure.md'),
      'nested non-navigation pages are missing from the corpus'
    );
  });

  it('flags the syntax classes that have broken real deploys', () => {
    const cases = [
      'BIS claims <5% GDP',
      '| `gate-2-country-drift` | <= 15 |',
      'Report: <https://www.worldmonitor.app/research/>',
    ];
    for (const line of cases) {
      assert.equal(
        findBareAngleBrackets(stripCode(line)).length,
        1,
        `detector missed a known Mintlify parse failure: ${line}`
      );
    }
    assert.equal(
      findBareCurlyBraces(stripCode('GET returns {purged:true} for the caller')).length,
      1,
      'detector missed a bare JSX expression'
    );
  });

  it('does not flag the escaped and fenced forms docs actually use', () => {
    const clean = [
      'BIS claims &lt;5% GDP',
      'the anchor sits at < 20 points',
      '`elapsed < intervalMs * 0.8`',
      '---\napplies_when: "returns {purged:true} but GET is stale"\n---\nbody',
      'Steps:\n\n  ```bash\n  NAME=resilience-${CAPTURE_DATE}.json\n  ```\n',
    ];
    for (const sample of clean) {
      const lines = stripCode(sample);
      assert.deepEqual(
        [...findBareAngleBrackets(lines), ...findBareCurlyBraces(lines)],
        [],
        `false positive on valid MDX: ${JSON.stringify(sample)}`
      );
    }
  });
});

describe('MDX files have no bare angle brackets', () => {
  for (const file of docFiles) {
    const name = relative(DOCS_DIR, file).split(sep).join('/');
    it(`${name} has no bare <equals, <digit, <hyphen, or autolink outside code`, () => {
      const content = readFileSync(file, 'utf8');
      const lines = stripCode(content);
      const issues = findBareAngleBrackets(lines);
      if (issues.length > 0) {
        const details = issues.map(i => `  line ${i.line}: ${i.text}`).join('\n');
        assert.fail(
          `Bare angle brackets will break Mintlify MDX parsing:\n${details}\n\nFix: replace < with &lt; or wrap in a code fence`
        );
      }
    });
  }
});

describe('MDX files have no bare curly braces', () => {
  for (const file of docFiles) {
    const name = relative(DOCS_DIR, file).split(sep).join('/');
    it(`${name} has no bare {expression} outside code`, () => {
      const content = readFileSync(file, 'utf8');
      const lines = stripCode(content);
      const issues = findBareCurlyBraces(lines);
      if (issues.length > 0) {
        const details = issues.map(i => `  line ${i.line}: ${i.text}`).join('\n');
        assert.fail(
          `Bare curly braces will break Mintlify MDX parsing (interpreted as JSX):\n${details}\n\nFix: escape with &#123; or wrap in a code fence / backticks`
        );
      }
    });
  }
});
