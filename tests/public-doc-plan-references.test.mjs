import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  findPublicDocumentationViolations,
  findPublicPlanReferences,
} from '../scripts/check-public-doc-plan-references.mjs';

describe('public documentation plan-reference guard', () => {
  it('allows ordinary public documentation text', () => {
    assert.deepEqual(
      findPublicPlanReferences('See the methodology, public API reference, and docs/exec-plans roadmap.'),
      [],
    );
  });

  it('finds repository, relative, and GitHub links to internal plans', () => {
    const references = findPublicPlanReferences([
      'See `docs/plans/internal-roadmap.md`.',
      'See [details](../plans/internal-roadmap.md).',
      'See [root plan](plans/internal-roadmap.md).',
      'See [explicit root plan](./plans/internal-roadmap.md).',
      'See https://github.com/koala73/worldmonitor/blob/main/docs/plans/internal-roadmap.md.',
      'See https://github.com/koala73/worldmonitor/blob/main/docs/%70lans/internal-roadmap.md.',
      'Progress is 100% and %FF; see docs%2Fplans%2Finternal-roadmap.md.',
    ].join('\n'));

    assert.deepEqual(references.map(reference => reference.line), [1, 2, 3, 4, 5, 6, 7]);
  });

  it('keeps every tracked public document outside the internal plans surface', () => {
    assert.deepEqual(findPublicDocumentationViolations(), []);
  });

  it('uses Mintlify’s publication ignore when scanning public files', () => {
    const docsDir = mkdtempSync(join(tmpdir(), 'public-doc-plan-references-'));
    const legacyDir = join(docsDir, 'legacy');

    try {
      writeFileSync(join(docsDir, '.mintignore'), 'internal/\nplans/\n');
      writeFileSync(join(docsDir, '.mintlifyignore'), 'internal/\nlegacy/\nplans/\n');
      mkdirSync(legacyDir);
      writeFileSync(join(legacyDir, 'note.md'), 'See `docs/plans/internal-roadmap.md`.\n');

      assert.deepEqual(findPublicDocumentationViolations(docsDir), [
        'docs/legacy/note.md:1: references internal planning content: See `docs/plans/internal-roadmap.md`.',
      ]);
    } finally {
      rmSync(docsDir, { recursive: true, force: true });
    }
  });

  it('requires Mintlify to ignore both internal documentation directories', () => {
    const docsDir = mkdtempSync(join(tmpdir(), 'public-doc-plan-references-'));

    try {
      writeFileSync(join(docsDir, '.mintignore'), 'plans/\n');

      assert.deepEqual(findPublicDocumentationViolations(docsDir), [
        'docs/.mintignore: must ignore internal/',
      ]);
    } finally {
      rmSync(docsDir, { recursive: true, force: true });
    }
  });

  it('skips planning content that Mintlify excludes from publication', () => {
    const docsDir = mkdtempSync(join(tmpdir(), 'public-doc-plan-references-'));
    const internalDir = join(docsDir, 'internal');
    const plansDir = join(docsDir, 'plans');

    try {
      writeFileSync(join(docsDir, '.mintignore'), 'internal/\nplans/\n');
      mkdirSync(internalDir);
      mkdirSync(plansDir);
      writeFileSync(join(internalDir, 'note.md'), 'See `docs/plans/internal-roadmap.md`.\n');
      writeFileSync(join(plansDir, 'roadmap.md'), 'See `docs/plans/internal-roadmap.md`.\n');

      assert.deepEqual(findPublicDocumentationViolations(docsDir), []);
    } finally {
      rmSync(docsDir, { recursive: true, force: true });
    }
  });

  it('rejects a missing Mintlify ignore file', () => {
    const docsDir = mkdtempSync(join(tmpdir(), 'public-doc-plan-references-'));

    try {
      assert.deepEqual(findPublicDocumentationViolations(docsDir), [
        'docs/.mintignore: missing required Mintlify ignore file',
        'docs/.mintignore: must ignore plans/',
        'docs/.mintignore: must ignore internal/',
      ]);
    } finally {
      rmSync(docsDir, { recursive: true, force: true });
    }
  });

  it('rejects ignore rules that re-include internal content', () => {
    const docsDir = mkdtempSync(join(tmpdir(), 'public-doc-plan-references-'));

    try {
      writeFileSync(join(docsDir, '.mintignore'), 'internal/\nplans/\n!plans/example.md\n!/internal/example.md\n');

      assert.deepEqual(findPublicDocumentationViolations(docsDir), [
        'docs/.mintignore: must not re-include plans/ content: !plans/example.md',
        'docs/.mintignore: must not re-include internal/ content: !/internal/example.md',
      ]);
    } finally {
      rmSync(docsDir, { recursive: true, force: true });
    }
  });
});
