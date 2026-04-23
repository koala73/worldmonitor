import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from '../scripts/build-agent-skills-index.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..');
const INDEX_PATH = join(ROOT, 'public/.well-known/agent-skills/index.json');
const SKILLS_DIR = join(ROOT, 'public/.well-known/agent-skills');

// Guards for the Agent Skills discovery manifest (#3310 / epic #3306).
// Agents trust the index.json sha256 fields; if they drift from the
// served SKILL.md bytes, every downstream verification check fails.
describe('agent readiness: agent-skills index', () => {
  it('index.json is up to date relative to SKILL.md sources', () => {
    // `--check` exits non-zero if rebuilding the index would change it.
    execFileSync(
      process.execPath,
      ['scripts/build-agent-skills-index.mjs', '--check'],
      { cwd: ROOT, stdio: 'pipe' },
    );
  });

  const index = JSON.parse(readFileSync(INDEX_PATH, 'utf-8'));

  it('declares the RFC v0.2.0 schema', () => {
    assert.equal(index.$schema, 'https://agentskills.io/schemas/v0.2.0/index.json');
  });

  it('advertises at least two skills (epic #3306 acceptance floor)', () => {
    assert.ok(Array.isArray(index.skills));
    assert.ok(index.skills.length >= 2, `expected >=2 skills, got ${index.skills.length}`);
  });

  it('every entry points at a real SKILL.md whose bytes match the declared sha256', () => {
    for (const skill of index.skills) {
      assert.ok(skill.name, 'skill entry missing name');
      assert.equal(skill.type, 'task');
      assert.ok(skill.description && skill.description.length > 0, `${skill.name} missing description`);
      assert.match(
        skill.url,
        /^https:\/\/worldmonitor\.app\/\.well-known\/agent-skills\/[^/]+\/SKILL\.md$/,
        `${skill.name} url must be the canonical absolute URL`,
      );
      const local = join(SKILLS_DIR, skill.name, 'SKILL.md');
      const bytes = readFileSync(local);
      const hex = createHash('sha256').update(bytes).digest('hex');
      assert.equal(
        skill.sha256,
        hex,
        `${skill.name} sha256 does not match ${local}`,
      );
    }
  });

  it('every SKILL.md directory is represented in the index (no orphans)', () => {
    const dirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    const names = index.skills.map((s) => s.name).sort();
    assert.deepEqual(names, dirs, 'every skill directory must have an index entry');
  });
});

// Parser-contract tests for parseFrontmatter(). The previous hand-rolled
// parser matched `\n---` anywhere, so a body line beginning with `---`
// silently truncated the frontmatter. It also split on the first colon
// without YAML semantics, so quoted-colon values became brittle. Lock in
// the replacement's semantics so future edits don't regress either.
describe('agent-skills index: frontmatter parser', () => {
  it('closing fence must be on its own line (body `---` does not terminate)', () => {
    const md = [
      '---',
      'name: demo',
      'description: covers body that starts with three dashes',
      '---',
      '',
      '--- this dash line is body text, not a fence ---',
      'More body.',
    ].join('\n');
    const fm = parseFrontmatter(md);
    assert.equal(fm.name, 'demo');
    assert.equal(fm.description, 'covers body that starts with three dashes');
  });

  it('values containing colons are preserved (not truncated)', () => {
    const md = [
      '---',
      'name: demo',
      'description: "Retrieve X: the composite value at a point in time"',
      '---',
      '',
      'body',
    ].join('\n');
    const fm = parseFrontmatter(md);
    assert.equal(
      fm.description,
      'Retrieve X: the composite value at a point in time',
    );
  });

  it('rejects non-mapping frontmatter (e.g. a YAML list)', () => {
    const md = ['---', '- a', '- b', '---', '', 'body'].join('\n');
    assert.throws(() => parseFrontmatter(md), /YAML mapping/);
  });

  it('returns empty object when no frontmatter present', () => {
    assert.deepEqual(parseFrontmatter('# Just a markdown heading\n'), {});
  });
});
