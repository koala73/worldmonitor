import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseFrontmatter } from '../scripts/build-agent-skills-index.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_DIR = 'sentry-triage';
const SKILL_PATH = join(ROOT, '.agents/skills', SKILL_DIR, 'SKILL.md');

describe('cursor skill: sentry-triage', () => {
  const markdown = readFileSync(SKILL_PATH, 'utf8');
  const frontmatter = parseFrontmatter(markdown);

  it('uses Cursor Agent Skills frontmatter that matches the folder name', () => {
    assert.equal(frontmatter.name, SKILL_DIR);
    assert.equal(typeof frontmatter.description, 'string');
    assert.match(frontmatter.description, /sentry/i);
    assert.match(frontmatter.description, /triage/i);
  });

  it('does not keep Claude-only command tokens', () => {
    assert.doesNotMatch(markdown, /\$ARGUMENTS\b/);
    assert.doesNotMatch(markdown, /\$\{?[0-9]+\}?\b/);
    assert.doesNotMatch(markdown, /^allowed-tools:/m);
    assert.doesNotMatch(markdown, /mcp__sentry__/);
  });

  it('binds WorldMonitor Sentry identity and Cursor MCP tools', () => {
    assert.match(markdown, /elie-habib/);
    assert.match(markdown, /worldmonitor/);
    assert.match(markdown, /search_issues/);
    assert.match(markdown, /search_events/);
    assert.match(markdown, /analyze_issue_with_seer/);
    assert.match(markdown, /update_issue/);
  });

  it('is not hidden by the repo-wide skills/ gitignore rule', () => {
    let ignored = false;
    try {
      execFileSync('git', ['check-ignore', '-q', SKILL_PATH], { cwd: ROOT });
      ignored = true;
    } catch (error) {
      ignored = error.status !== 1;
    }
    assert.equal(ignored, false, `${SKILL_PATH} must be trackable`);
  });

  it('encodes the repo-specific resolve and event-read rules', () => {
    assert.match(markdown, /inNextRelease/);
    assert.match(markdown, /plain resolve/i);
    assert.match(markdown, /UNKNOWN_FUNCTION/);
    assert.match(markdown, /sentry-beforesend\.test\.mjs/);
    assert.match(markdown, /Fixes WORLDMONITOR-/);
  });
});
