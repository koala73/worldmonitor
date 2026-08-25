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

function sectionBetween(markdown, startMarker, endMarker) {
  const start = markdown.indexOf(startMarker);
  const end = markdown.indexOf(endMarker, start + startMarker.length);

  assert.notEqual(start, -1, `missing section marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing section marker: ${endMarker}`);
  return markdown.slice(start, end);
}

function assertTokensInOrder(text, tokens) {
  let cursor = -1;
  for (const token of tokens) {
    const next = text.indexOf(token, cursor + 1);
    assert.ok(next > cursor, `expected ${JSON.stringify(token)} after offset ${cursor}`);
    cursor = next;
  }
}

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

  it('audits archive mode via substatus, not empty statusDetails', () => {
    const ignoredAudit = sectionBetween(markdown, '- **Ignored-board audit**', '\n\nConfirm which issue');
    const archiveWrite = sectionBetween(markdown, '**Archive / mute (any class)**', '\n\n**Ingest-gate**');
    const transition = archiveWrite.slice(archiveWrite.indexOf('Required sequence:'));

    assert.match(
      ignoredAudit,
      /search_issues\([^)]*query='is:ignored'[^)]*limit=100[^)]*period='90d'[^)]*\)/s,
    );
    assert.match(ignoredAudit, /100 results.*truncated|cap of 100.*incomplete/is);
    assert.match(ignoredAudit, /non-overlapping.*time windows/is);
    assert.match(
      ignoredAudit,
      /search_sentry_tools.*pagination-capable full ignored-issue inventory.*input schema/is,
    );
    assert.match(ignoredAudit, /no supported tool.*capability (?:as )?unavailable/is);
    assert.match(ignoredAudit, /observed cohort|coverage window/i);
    assert.match(ignoredAudit, /never (?:call|describe|report).*exhaustive/is);
    assert.match(ignoredAudit, /get_sentry_resource|get_issue_details/);
    assert.match(markdown, /never via empty `statusDetails`/);
    assert.match(ignoredAudit, /Do not treat empty `statusDetails` as clean/);
    assert.match(markdown, /archived_forever/);
    assert.match(markdown, /archived_until_escalating/);
    assert.match(markdown, /archived_until_condition_met/);
    assertTokensInOrder(ignoredAudit, [
      "substatus` is `archived_forever`",
      "execute_sentry_tool(name='get_issue_activity'",
      'lacks a recorded forever decision',
    ]);
    assert.match(ignoredAudit, /includeComments: true[^}]*limit: 100/s);
    assert.match(ignoredAudit, /activity history.*(?:unavailable|100 results).*(?:unproved|incomplete)/is);
    assertTokensInOrder(ignoredAudit, [
      'activity history is unavailable or returns 100 results',
      'do not mutate the issue without explicit user direction',
      'With complete history',
      'In active mode',
      're-archive them as `archived_until_escalating`',
    ]);

    assert.match(archiveWrite, /Default archive is `ignoreMode: 'untilEscalating'`/);
    assert.match(archiveWrite, /ignoreMode: 'forever'/);
    assert.match(archiveWrite, /silently no-ops|silent no-op|no-ops/i);
    assertTokensInOrder(transition, [
      "status='unresolved'",
      'read `status` back',
      'Continue only if the observed state is `unresolved`',
      "status='ignored', ignoreMode='untilEscalating', reason=",
      'After every step 2 attempt',
      'read `status` and `substatus` back',
    ]);
    assert.match(transition, /every step 2 attempt.*failed.*ambiguous.*successful response/is);
    assert.match(transition, /observed state is `unresolved`.*retry step 2 once/is);
    assert.match(transition, /step 3 read-back.*even if.*retry reports failure/is);
    assert.match(transition, /read-back is unavailable.*post-retry.*not.*stop.*issue ID.*observed state/is);
    assert.match(transition, /do not (?:blind-loop|repeat).*write/is);
  });
});
