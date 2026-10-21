import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  findPublicDocumentationViolations,
  findPublicPlanReferences,
  inspectDocumentationPublication,
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

describe('documentation publication coverage', () => {
  function fixture(t, pages = ['guide']) {
    const dir = mkdtempSync(join(tmpdir(), 'doc-publication-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, '.mintignore'), 'internal/\nplans/\n');
    writeFileSync(join(dir, 'docs.json'), JSON.stringify({ navigation: { pages } }));
    writeFileSync(join(dir, 'guide.mdx'), '# Guide\n');
    return dir;
  }

  it('classifies every repository document without silently publishing an orphan', () => {
    assert.deepEqual(inspectDocumentationPublication().violations, []);
  });

  it('rejects an indexable page outside navigation and ignores the legacy filename', t => {
    const dir = fixture(t);
    writeFileSync(join(dir, 'orphan.md'), '# Missing page\n');
    writeFileSync(join(dir, '.mintlifyignore'), 'orphan.md\n');
    const result = inspectDocumentationPublication(dir);
    assert.deepEqual(result.documents, [
      { path: 'guide.mdx', status: 'public' },
      { path: 'orphan.md', status: 'unclassified' },
    ]);
    assert.deepEqual(result.violations, [
      'docs/orphan.md: add to navigation, set noindex: true, or exclude in .mintignore',
    ]);
  });

  it('accepts explicit noindex and publication exclusions', t => {
    const dir = fixture(t);
    mkdirSync(join(dir, 'internal'));
    writeFileSync(join(dir, 'internal', 'note.md'), '# Internal\n');
    writeFileSync(join(dir, 'unlisted.mdx'), '---\nnoindex: true\n---\n# Direct link only\n');
    const result = inspectDocumentationPublication(dir);
    assert.deepEqual(result.violations, []);
    assert.deepEqual(result.documents.map(doc => doc.status), ['public', 'excluded', 'noindex']);
  });

  it('does not accept a noindex example in page content as an indexing directive', t => {
    const dir = fixture(t, []);
    writeFileSync(join(dir, 'guide.mdx'), '# Guide\n```yaml\nnoindex: true\n```\n');
    assert.equal(inspectDocumentationPublication(dir).documents[0].status, 'unclassified');
  });

  it('rejects an excluded navigation target and a missing navigation source', t => {
    const dir = fixture(t, ['guide', 'missing']);
    writeFileSync(join(dir, '.mintignore'), 'internal/\nplans/\nguide.mdx\n');
    assert.deepEqual(inspectDocumentationPublication(dir).violations, [
      'docs/guide.mdx: excluded page is still in navigation',
      'docs/docs.json: navigation page has no Markdown source: missing',
    ]);
  });

  it('requires hidden groups to be searchable before treating their pages as public', t => {
    const dir = fixture(t);
    const config = { navigation: { groups: [{ hidden: true, pages: ['guide'] }] } };
    writeFileSync(join(dir, 'docs.json'), JSON.stringify(config));
    assert.equal(inspectDocumentationPublication(dir).documents[0].status, 'unclassified');
    config.navigation.groups[0].searchable = true;
    writeFileSync(join(dir, 'docs.json'), JSON.stringify(config));
    assert.deepEqual(inspectDocumentationPublication(dir).violations, []);
  });

  it('fails closed on ignore syntax it cannot evaluate', t => {
    const dir = fixture(t);
    writeFileSync(join(dir, '.mintignore'), 'internal/\nplans/\n*.md\n');
    assert.match(inspectDocumentationPublication(dir).violations[0], /requires literal relative files or directories/);
  });
});
