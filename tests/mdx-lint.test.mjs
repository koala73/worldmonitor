/**
 * MDX lint: catches bare angle brackets that break Mintlify's MDX parser.
 *
 * MDX interprets `<foo` as a JSX tag. Bare `<` followed by a letter, digit,
 * or hyphen outside fenced code blocks causes deploy failures.
 *
 * Fix: use `&lt;` or wrap in backtick code spans / fenced blocks.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const DOCS_DIR = new URL('../docs/', import.meta.url).pathname;

const mdxFiles = readdirSync(DOCS_DIR)
  .filter(f => f.endsWith('.mdx'))
  .map(f => join(DOCS_DIR, f));

/** True if the line is inside a fenced code block. */
function findBareAngleBrackets(content) {
  const lines = content.split('\n');
  let inFence = false;
  const issues = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // Strip inline code spans before checking
    const stripped = line.replace(/`[^`]+`/g, '');

    // Match bare < followed by a digit or hyphen (the patterns that break MDX)
    const match = stripped.match(/<[\d-]/);
    if (match) {
      issues.push({ line: i + 1, text: line.trim() });
    }
  }
  return issues;
}

describe('MDX files have no bare angle brackets', () => {
  for (const file of mdxFiles) {
    const name = file.split('/').pop();
    it(`${name} has no bare <digit or <hyphen outside code fences`, () => {
      const content = readFileSync(file, 'utf8');
      const issues = findBareAngleBrackets(content);
      if (issues.length > 0) {
        const details = issues
          .map(i => `  line ${i.line}: ${i.text}`)
          .join('\n');
        assert.fail(
          `Found bare angle brackets that will break Mintlify MDX parsing:\n${details}\n\nFix: replace < with &lt; or wrap in a code fence`
        );
      }
    });
  }
});
