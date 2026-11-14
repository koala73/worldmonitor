#!/usr/bin/env node
// Checks the REVIEW_PR_TOKEN secret the bot-PR workflows open and auto-merge
// their PRs with. A PR opened with the Actions token gets no CI, so the
// required checks never report and the PR waits for a human. An expired or
// revoked token brings that back silently, so this fails while there is still
// time to rotate it.

import { pathToFileURL } from 'node:url';

export const EXPIRY_ALARM_DAYS = 21;

export function assessReviewToken({ token, status, expiration, now = Date.now() }) {
  if (!token) return { ok: false, message: 'REVIEW_PR_TOKEN is not set. Bot PRs will get no CI and wait for a human.' };
  if (status === 401) return { ok: false, message: 'REVIEW_PR_TOKEN was rejected (401). It has expired or been revoked; rotate it.' };
  if (status !== 200) return { ok: false, message: `REVIEW_PR_TOKEN cannot read the repository (HTTP ${status}). Check its repository access.` };
  if (!expiration) return { ok: true, message: 'REVIEW_PR_TOKEN is valid and has no expiry date.' };
  const expiresAt = Date.parse(expiration);
  if (!Number.isFinite(expiresAt)) return { ok: false, message: `REVIEW_PR_TOKEN expiry header is unreadable: ${expiration}` };
  const daysLeft = Math.floor((expiresAt - now) / 86_400_000);
  const when = new Date(expiresAt).toISOString().slice(0, 10);
  if (daysLeft < EXPIRY_ALARM_DAYS) {
    return { ok: false, message: `REVIEW_PR_TOKEN expires on ${when} (${daysLeft} days). Rotate it and update the secret.` };
  }
  return { ok: true, message: `REVIEW_PR_TOKEN is valid until ${when} (${daysLeft} days).` };
}

async function main() {
  const token = process.env.REVIEW_PR_TOKEN || '';
  const repo = process.env.GITHUB_REPOSITORY || 'koala73/worldmonitor';
  let status = 0;
  let expiration = null;
  if (token) {
    const res = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'worldmonitor-review-token-check',
      },
      signal: AbortSignal.timeout(15_000),
    });
    status = res.status;
    expiration = res.headers.get('github-authentication-token-expiration');
  }
  const verdict = assessReviewToken({ token, status, expiration });
  console.log(verdict.ok ? verdict.message : `::error title=REVIEW_PR_TOKEN::${verdict.message}`);
  process.exitCode = verdict.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
