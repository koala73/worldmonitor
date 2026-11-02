#!/usr/bin/env node

// UI reports need a picture. GitHub issue forms cannot require an attachment
// (there is no upload field type), so this runs on `issues:
// opened/edited/reopened`: an issue from outside the maintainer set that
// mentions the UI and carries no attachment is labelled, told what is
// missing, and closed as not planned. Editing the issue to attach a
// screenshot reopens it on the next run.
//
// The decision reads the issue as it is now, not the webhook snapshot: an
// edit that lands while the opened run is still closing the issue would
// otherwise be judged from a payload that predates the close, and the
// screenshot would never reopen it. Issue text reaches this script only
// through the event payload file and the API response, and is sent back to
// GitHub as JSON on stdin, never through shell interpolation.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { isMainModule } from './lib/main-module.mjs';

export const LABEL = 'needs-screenshot';
export const LABEL_COLOR = 'd93f0b';
export const LABEL_DESCRIPTION = 'UI report closed until a screenshot or recording is attached';
export const COMMENT_MARKER = '<!-- issue-ui-evidence -->';

const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const GH_CALL_TIMEOUT_MS = 30_000;

// Whole-word "UI" in any case. `\b` treats `/` and `(` as boundaries, so the
// `bug(ui/panel-name)` title convention matches too, while "gui", "build",
// "guide" and "suite" do not.
const UI_WORD_RE = /\bui\b/i;

// Every form an attachment takes in issue text: pasted images and files on
// the current user-attachments host, the two legacy image hosts, repo-scoped
// asset links, and raw Markdown or HTML image syntax. The Markdown form
// covers an inline image with or without a quoted title and the full or
// collapsed reference forms (`![alt][ref]`, `![alt][]`).
const ATTACHMENT_RES = [
  /https?:\/\/github\.com\/user-attachments\/(?:assets|files)\//i,
  /https?:\/\/(?:private-)?user-images\.githubusercontent\.com\//i,
  /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/assets\/\d+\//i,
  /!\[[^\]]*\]\s*(?:\([^)]*\S[^)]*\)|\[[^\]]*\])/,
  /<img\b[^>]*\bsrc\s*=/i,
];

export function mentionsUi(text) {
  return UI_WORD_RE.test(String(text ?? ''));
}

export function hasAttachment(text) {
  const value = String(text ?? '');
  return ATTACHMENT_RES.some((re) => re.test(value));
}

export function closeComment() {
  return [
    'This report mentions the UI but has no screenshot or recording attached, so it has been closed for now.',
    '',
    'Please edit the issue description and attach a screenshot of what you are seeing (paste or drag the image into the text box). The issue reopens automatically once an attachment is detected.',
    '',
    COMMENT_MARKER,
  ].join('\n');
}

export function reopenComment(reason) {
  const lead = reason === 'ui-mention-removed'
    ? 'The report no longer refers to the UI, reopening for triage.'
    : 'Attachment detected, reopening for triage.';
  return `${lead}\n\n${COMMENT_MARKER}`;
}

/**
 * Pure decision for one `issues` event. Returns `{ action, reason, comment }`
 * where `action` is `close`, `reopen`, `unlabel` or `none`, and `comment`
 * says whether `close` should post the explanation (it does not when the
 * label is already on the issue, so a manual reopen without a screenshot is
 * re-closed silently instead of repeating the comment).
 */
export function decide(event) {
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
  const open = issue.state === 'open';

  if (!mentionsUi(text)) {
    if (hasLabel) {
      return { action: open ? 'unlabel' : 'reopen', reason: 'ui-mention-removed' };
    }
    return { action: 'none', reason: 'no-ui-mention' };
  }

  if (hasAttachment(text)) {
    if (hasLabel) {
      return { action: open ? 'unlabel' : 'reopen', reason: 'attachment-present' };
    }
    return { action: 'none', reason: 'attachment-present' };
  }

  if (open) {
    return { action: 'close', reason: 'missing-attachment', comment: !hasLabel };
  }
  return { action: 'none', reason: hasLabel ? 'already-closed' : 'closed-by-human' };
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
 * tests can replace it; returns the write calls made, in order.
 */
export function apply(decision, { gh, repo, number }) {
  const calls = [];
  const run = (args, options) => {
    calls.push(args);
    return gh(args, options);
  };
  const patch = (payload) => run(['api', '--method', 'PATCH', issuePath(repo, number), '--input', '-'], {
    input: JSON.stringify(payload),
  });
  const comment = (body) => run(['api', '--method', 'POST', issuePath(repo, number, '/comments'), '--input', '-'], {
    input: JSON.stringify({ body }),
  });
  const removeLabel = () => run(['api', '--method', 'DELETE', issuePath(repo, number, `/labels/${encodeURIComponent(LABEL)}`)]);

  switch (decision.action) {
    case 'close':
      ensureLabel({ gh: run, repo });
      run(['api', '--method', 'POST', issuePath(repo, number, '/labels'), '--input', '-'], {
        input: JSON.stringify({ labels: [LABEL] }),
      });
      if (decision.comment) comment(closeComment());
      patch({ state: 'closed', state_reason: 'not_planned' });
      break;
    case 'reopen':
      // Reopen first: the label is what marks a closed issue as ours, so a
      // reopen that fails after the label is gone would never be retried.
      patch({ state: 'open' });
      removeLabel();
      comment(reopenComment(decision.reason));
      break;
    case 'unlabel':
      removeLabel();
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

export function main(env = process.env, gh = runGh) {
  const event = loadEvent(env);
  const repo = event.repository?.full_name || env.GITHUB_REPOSITORY;
  const number = event.issue?.number;
  if (!repo || !number) throw new Error('event payload has no repository or issue number');

  const decision = decide({ ...event, issue: fetchIssue({ gh, repo, number }) });
  console.log(`issue #${number}: ${decision.action} (${decision.reason})`);
  const calls = apply(decision, { gh, repo, number });
  for (const call of calls) console.log(`  gh ${call.join(' ')}`);
  return decision;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main();
}
