import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

describe('CII docs drift guards', () => {
  it('internal review docs do not retain stale CII country-count or source-of-truth claims', () => {
    const internalDocPaths = [
      'docs/Docs_To_Review/todo_docs.md',
      'docs/Docs_To_Review/todo.md',
      'docs/Docs_To_Review/TODO_Performance.md',
      'docs/Docs_To_Review/COMPONENTS.md',
    ];
    const stalePatterns = [
      /22-country CII computation/i,
      /20 hardcoded Tier 1 countries/i,
      /\bCII\s+v5\s+(?:stability|stress|instability|scores?|scoring)\b/i,
      /\breal-time\s+CII\s+v5\s+instability\s+score\b/i,
      /\bComputes\s+CII\s+v5\s+scores\b/i,
      /\bserver-authoritative\s+CII\s+v5\s+scoring\b/i,
      /src\/workers\/cii\.worker\.ts/i,
      /src\/components\/CIIPanel\.ts` \(150 lines\)/i,
      /\*\*Country Instability Index\*\* \(`country-instability\.ts`\)/i,
    ];

    const violations: string[] = [];
    for (const relPath of internalDocPaths) {
      const text = readFileSync(resolve(root, relPath), 'utf8');
      for (const pattern of stalePatterns) {
        if (pattern.test(text)) violations.push(`${relPath}: ${pattern}`);
      }
    }

    assert.equal(
      violations.length,
      0,
      `internal CII review docs contain stale claims:\n  ${violations.join('\n  ')}`,
    );
  });
});
