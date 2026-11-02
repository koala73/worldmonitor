#!/usr/bin/env node

// UI reports need a picture. GitHub issue forms cannot verify that a field
// holds an image (the required screenshot field in the bug report form only
// refuses an empty box), so this runs on `issues: opened/edited`: an issue
// from outside the maintainer set that mentions the UI and carries no
// attachment gets the `needs-screenshot` label and one comment asking for
// the image. The label clears on the edit that attaches one. The issue is
// never closed, reopened or otherwise changed.
//
// The decision reads the issue as it is now, not the webhook snapshot: an
// edit that lands while the opened run is still labelling would otherwise be
// judged from a payload that predates the label. Issue text reaches this
// script only through the event payload file and the API response, and is
// sent back to GitHub as JSON on stdin, never through shell interpolation.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { isMainModule } from './lib/main-module.mjs';

export const LABEL = 'needs-screenshot';
export const LABEL_COLOR = 'd93f0b';
export const LABEL_DESCRIPTION = 'UI report waiting for a screenshot or recording';
export const COMMENT_MARKER = '<!-- issue-ui-evidence -->';

const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const GH_CALL_TIMEOUT_MS = 30_000;

// Whole-word "UI" in any case. `\b` treats `/` and `(` as boundaries, so the
// `bug(ui/panel-name)` title convention matches too, while "gui", "build",
// "guide" and "suite" do not.
const UI_WORD_RE = /\bui\b/i;

// Every form an attachment takes in issue text: pasted images and files on
// the current user-attachments host, the two legacy image hosts, repo-scoped
// asset links, and raw Markdown or HTML image syntax. The inline Markdown
// form may carry a quoted title. The reference forms (`![alt][ref]`,
// `![alt][]`) are checked separately: they render only when a matching
// `[ref]: url` definition exists, so an undefined reference is not evidence.
// The definition's destination may sit on the line after the label, but a
// blank line ends the definition.
//
// The body is attacker-controlled and up to 65,536 characters, so every
// variable-length run is bounded (CWE-1333): an alt text, label or `img`
// tag longer than the bound is not an attachment, and a body made of
// thousands of unclosed `![x](` or `<img ` starts costs linear time.
const ATTACHMENT_RES = [
  /https?:\/\/github\.com\/user-attachments\/(?:assets|files)\//i,
  /https?:\/\/(?:private-)?user-images\.githubusercontent\.com\//i,
  /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/assets\/\d+\//i,
  /!\[[^\]]{0,300}\]\s{0,16}\([ \t]{0,16}[^)\s][^)]{0,2048}\)/,
  /<img\b[^>]{0,2048}\bsrc\s{0,16}=/i,
];
const REFERENCE_IMAGE_RE = /!\[([^\]]{0,300})\]\s{0,16}\[([^\]]{0,300})\]/g;
const REFERENCE_DEFINITION_RE = /^ {0,3}\[([^\]]{1,300})\]:[ \t]{0,16}(?:\r?\n[ \t]{0,16})?\S/gm;

// One linear pass collects every defined label, then each reference image is
// a set lookup; building a regex per reference would rescan the body per
// match, quadratic on a body of repeated `![a][b]`.
function hasResolvedReferenceImage(text) {
  if (!REFERENCE_IMAGE_RE.test(text)) return false;
  REFERENCE_IMAGE_RE.lastIndex = 0;
  const defined = new Set();
  for (const match of text.matchAll(REFERENCE_DEFINITION_RE)) {
    defined.add(match[1].trim().toLowerCase());
  }
  if (defined.size === 0) return false;
  for (const match of text.matchAll(REFERENCE_IMAGE_RE)) {
    const label = (match[2] || match[1]).trim().toLowerCase();
    if (label && defined.has(label)) return true;
  }
  return false;
}

export function mentionsUi(text) {
  return UI_WORD_RE.test(String(text ?? ''));
}

export function hasAttachment(text) {
  const value = String(text ?? '');
  return ATTACHMENT_RES.some((re) => re.test(value)) || hasResolvedReferenceImage(value);
}

export function nudgeComment() {
  return [
    'This report mentions the UI but has no screenshot or recording attached.',
    '',
    `Please edit the issue description and paste or drag in a screenshot of what you are seeing. The \`${LABEL}\` label clears automatically once an attachment is detected.`,
    '',
    COMMENT_MARKER,
  ].join('\n');
}

// The marker alone is not proof the workflow posted the request: a reporter
// can paste it. The Actions token always comments as a Bot account, and a
// person never can, so the author type is required too.
export function hasNudgeComment(comments) {
  return Array.isArray(comments) && comments.some((comment) =>
    comment?.user?.type === 'Bot' && String(comment?.body ?? '').includes(COMMENT_MARKER));
}

/**
 * Pure decision for one `issues` event. Returns `{ action, reason }` where
 * `action` is `nudge` (label and/or comment), `clear` (remove the label) or
 * `none`. The label and the marker comment are reconciled separately: a
 * `nudge` carries `label` and `comment` booleans naming what is still
 * missing, so a comment that failed after the label landed is retried, and
 * an image that was attached and then removed gets the label back without a
 * second comment. `nudged` says whether the marker comment already exists.
 */
export function decide(event, { nudged = false } = {}) {
  const issue = event?.issue;
  if (!issue || typeof issue !== 'object') {
    return { action: 'none', reason: 'no-issue' };
  }
  if (issue.pull_request) {
    return { action: 'none', reason: 'pull-request' };
  }
  if (issue.user?.type === 'Bot') {
    return { action: 'none', reason: 'bot-author' };
  }
  if (TRUSTED_ASSOCIATIONS.has(issue.author_association)) {
    return { action: 'none', reason: 'trusted-author' };
  }

  const text = `${issue.title ?? ''}\n${issue.body ?? ''}`;
  const labels = Array.isArray(issue.labels) ? issue.labels : [];
  const hasLabel = labels.some((label) => (typeof label === 'string' ? label : label?.name) === LABEL);

  if (!mentionsUi(text)) {
    return hasLabel ? { action: 'clear', reason: 'ui-mention-removed' } : { action: 'none', reason: 'no-ui-mention' };
  }
  if (hasAttachment(text)) {
    return hasLabel ? { action: 'clear', reason: 'attachment-present' } : { action: 'none', reason: 'attachment-present' };
  }
  if (hasLabel && nudged) {
    return { action: 'none', reason: 'already-nudged' };
  }
  return { action: 'nudge', reason: 'missing-attachment', label: !hasLabel, comment: !nudged };
}

function issuePath(repo, number, suffix = '') {
  return `repos/${repo}/issues/${number}${suffix}`;
}

function ensureLabel({ gh, repo }) {
  try {
    gh(['api', '--method', 'POST', `repos/${repo}/labels`, '--input', '-'], {
      input: JSON.stringify({ name: LABEL, color: LABEL_COLOR, description: LABEL_DESCRIPTION }),
    });
  } catch (error) {
    if (!/already_exists|HTTP 422/.test(String(error?.message))) throw error;
  }
}

/**
 * Perform `decision` against the issue. Every write goes through `gh` so the
 * tests can replace it; returns the write calls made, in order. Only labels
 * and comments are ever written; the issue state is never touched.
 */
export function apply(decision, { gh, repo, number }) {
  const calls = [];
  const run = (args, options) => {
    calls.push(args);
    return gh(args, options);
  };

  switch (decision.action) {
    case 'nudge':
      if (decision.label !== false) {
        ensureLabel({ gh: run, repo });
        run(['api', '--method', 'POST', issuePath(repo, number, '/labels'), '--input', '-'], {
          input: JSON.stringify({ labels: [LABEL] }),
        });
      }
      if (decision.comment !== false) {
        run(['api', '--method', 'POST', issuePath(repo, number, '/comments'), '--input', '-'], {
          input: JSON.stringify({ body: nudgeComment() }),
        });
      }
      break;
    case 'clear':
      run(['api', '--method', 'DELETE', issuePath(repo, number, `/labels/${encodeURIComponent(LABEL)}`)]);
      break;
    default:
      break;
  }
  return calls;
}

function runGh(args, options = {}) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: GH_CALL_TIMEOUT_MS,
    input: options.input,
  });
  if (result.signal) throw new Error(`gh ${args.join(' ')} timed out`);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(' ')} failed (${result.status}): ${String(result.stderr).trim()}`);
  }
  return result.stdout;
}

function loadEvent(env) {
  const path = env.GITHUB_EVENT_PATH;
  if (!path) throw new Error('GITHUB_EVENT_PATH is required');
  return JSON.parse(readFileSync(path, 'utf8'));
}

function fetchIssue({ gh, repo, number }) {
  const issue = JSON.parse(gh(['api', issuePath(repo, number)]));
  if (!issue || typeof issue !== 'object' || issue.number !== number) {
    throw new Error(`issue #${number} read back as ${JSON.stringify(issue).slice(0, 200)}`);
  }
  return issue;
}

function fetchComments({ gh, repo, number }) {
  // --slurp returns one array per page; flatten so a long thread still reads whole.
  const pages = JSON.parse(gh(['api', '--paginate', '--slurp', issuePath(repo, number, '/comments')]));
  if (!Array.isArray(pages)) throw new Error(`issue #${number} comments read back as ${typeof pages}`);
  return pages.flat();
}

export function main(env = process.env, gh = runGh) {
  const event = loadEvent(env);
  const repo = event.repository?.full_name || env.GITHUB_REPOSITORY;
  const number = event.issue?.number;
  if (!repo || !number) throw new Error('event payload has no repository or issue number');

  const issue = fetchIssue({ gh, repo, number });
  const nudged = hasNudgeComment(fetchComments({ gh, repo, number }));
  const decision = decide({ ...event, issue }, { nudged });
  console.log(`issue #${number}: ${decision.action} (${decision.reason})`);
  const calls = apply(decision, { gh, repo, number });
  for (const call of calls) console.log(`  gh ${call.join(' ')}`);
  return decision;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main();
}
