#!/usr/bin/env node

/**
 * Refuse commit messages and PR text that the Sentry GitHub integration reads
 * as a resolve marker. Each marker resolves the issue pinned to a release
 * (`inRelease`), which the daily `audit:sentry-resolve-pins` job then reports.
 *
 * The matcher is a port of getsentry/sentry `src/sentry/utils/groupreference.py`
 * as of a93490822dae8e052dc15ef943c4845e1aaf8f28. After a keyword it captures the
 * whole following run of letters, digits, `_`, `-`, whitespace and commas, and
 * every short ID inside that run resolves. So "post-fix events of Sentry
 * WORLDMONITOR-1AY" fires (the hyphen gives `fix` a word boundary), as does
 * "Fixes Sentry WORLDMONITOR-1FR and WORLDMONITOR-1FS", and the run crosses
 * line breaks. A keyword-adjacent grep misses all of these.
 *
 * Backticks are stripped before matching. Upstream would stop at them, but a
 * backticked marker pinned a live issue on 2026-09-07, so this stays stricter.
 *
 *   node scripts/check-sentry-resolve-markers.mjs --text-file body.md
 *   printf '%s\n' "$PUSH_STDIN" | node scripts/check-sentry-resolve-markers.mjs --push-stdin
 *
 * Escape hatch: WM_ALLOW_SENTRY_RESOLVE_MARKERS=1.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { isMainModule } from './lib/main-module.mjs';

const KEYWORDS = '(?:Fix|Fixes|Fixed|Close|Closes|Closed|Resolve|Resolves|Resolved)';
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\([^)]+\)/gi;
const FIXES_RE = new RegExp(String.raw`\b${KEYWORDS}:?\s+([A-Za-z0-9_\-\s,]+)\b`, 'gi');
const FIXES_URL_RE = new RegExp(String.raw`\b${KEYWORDS}:?\s+(https?://\S+)`, 'gi');
const SHORT_ID_RE = /\b([A-Z0-9_-]+-[A-Z0-9]+)\b/gi;
const ISSUE_URL_RE = /\/issues\/(\d+)/;
const PROJECT_SHORT_ID_RE = /^WORLDMONITOR-[A-Z0-9]+$/i;
const ZERO_SHA_RE = /^0+$/;

function lineAt(text, index) {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end === -1 ? text.length : end).trim();
}

export function findSentryResolveReferences(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const normalized = text.replace(MARKDOWN_LINK_RE, '$1').replaceAll('`', '');
  const refs = [];
  const seen = new Set();
  const add = (shortId, index) => {
    if (seen.has(shortId)) return;
    seen.add(shortId);
    refs.push({ shortId, line: lineAt(normalized, index) });
  };

  for (const match of normalized.matchAll(FIXES_RE)) {
    for (const id of match[1].matchAll(SHORT_ID_RE)) {
      if (PROJECT_SHORT_ID_RE.test(id[1])) add(id[1].toUpperCase(), match.index);
    }
  }
  for (const match of normalized.matchAll(FIXES_URL_RE)) {
    let url;
    try {
      url = new URL(match[1]);
    } catch {
      continue;
    }
    if (!/(^|\.)sentry\.io$/i.test(url.hostname)) continue;
    const issue = url.pathname.match(ISSUE_URL_RE);
    if (issue) add(`issue ${issue[1]}`, match.index);
  }
  return refs;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function hasCommit(ref) {
  try {
    git(['cat-file', '-e', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

export function pushedCommitMessages(pushStdin) {
  const messages = [];
  for (const line of pushStdin.split('\n')) {
    const [, localSha, remoteRef, remoteSha] = line.trim().split(/\s+/);
    if (!localSha || ZERO_SHA_RE.test(localSha) || !remoteRef?.startsWith('refs/heads/')) continue;
    if (!hasCommit(localSha)) continue;
    let exclude = [];
    if (remoteSha && !ZERO_SHA_RE.test(remoteSha) && hasCommit(remoteSha)) exclude = [`^${remoteSha}`];
    else if (hasCommit('refs/remotes/origin/main')) exclude = ['^refs/remotes/origin/main'];
    const log = git(['log', '--format=%H%x00%B%x1e', localSha, ...exclude]);
    for (const entry of log.split('\x1e')) {
      const [sha, body] = entry.replace(/^\n/, '').split('\x00');
      if (sha) messages.push({ source: `commit ${sha.slice(0, 12)}`, text: body ?? '' });
    }
  }
  return messages;
}

function main() {
  const { values } = parseArgs({
    options: {
      'text-file': { type: 'string', multiple: true },
      'push-stdin': { type: 'boolean' },
    },
    strict: true,
  });
  if (process.env.WM_ALLOW_SENTRY_RESOLVE_MARKERS) return 0;

  if (!values['text-file'] && !values['push-stdin']) {
    console.error('Pass --text-file <path> or --push-stdin.');
    return 2;
  }
  const sources = [];
  for (const path of values['text-file'] ?? []) sources.push({ source: path, text: readFileSync(path, 'utf8') });
  if (values['push-stdin']) sources.push(...pushedCommitMessages(readFileSync(0, 'utf8')));

  let found = 0;
  for (const { source, text } of sources) {
    for (const ref of findSentryResolveReferences(text)) {
      found += 1;
      console.error(`${source}: Sentry would resolve ${ref.shortId} pinned to a release`);
      console.error(`  ${ref.line}`);
    }
  }
  if (found === 0) return 0;
  console.error([
    '',
    'SENTRY RESOLVE MARKER: a fix/close/resolve keyword is followed by a run of words,',
    'commas or hyphens that reaches a short ID, so the GitHub integration pins the issue',
    'inRelease and the daily resolve-pin audit goes red. Put the short ID in its own',
    'sentence after a period, or reword so no keyword (including "post-fix") precedes it.',
    'Intentional? Re-run with WM_ALLOW_SENTRY_RESOLVE_MARKERS=1.',
  ].join('\n'));
  return 1;
}

if (isMainModule(import.meta.url, process.argv[1])) process.exitCode = main();
