#!/usr/bin/env node
// Keeps one GitHub issue listing the live video slots that need a replacement, from the JSON written by
// `node --import tsx scripts/check-live-video-sources.mjs --all --report <file>`.
// Run with: LIVE_VIDEO_AUDIT_REPORT=<file> node --import tsx scripts/report-live-video-audit.mjs
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { isMainModule } from './lib/main-module.mjs';
import { catalogSlots, DEFAULT_CATALOG, slotStatus } from './check-live-video-sources.mjs';

export const ISSUE_TITLE = 'Live video sources: slots needing a replacement';
/** GitHub rejects an issue body over 65,536 characters; this leaves room for multi-unit characters. */
export const MAX_ISSUE_BODY_CHARS = 60_000;
/** Rows per issue section before the rest are only counted; halved until the body fits. */
const ISSUE_ROWS_PER_SECTION = 50;

const STATUSES = new Set(['ok', 'degraded', 'needs-replacement', 'empty', 'unverifiable-from-runner']);

/** A broken feed on any surface, or a slot viewers see by default with nothing configured. */
function isFinding(slot) {
  return slot.status === 'needs-replacement' || slot.status === 'degraded' || (slot.status === 'empty' && slot.shownByDefault);
}

/** A slot with no entries that the dashboard hides: listed so the owner can fill it, never counted. */
function isUnfilled(slot) {
  return slot.status === 'empty' && !slot.shownByDefault;
}
const VERDICTS = new Set(['live', 'recording', 'failed', 'unverifiable', 'invalid']);
const FINDINGS_HEADER = ['Slot', 'Where it shows', 'Status', 'Entry', 'Why', 'Shown instead'];

function ghJson(args, payload) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
    input: payload ? JSON.stringify(payload) : undefined,
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || 'GitHub API call failed');
  return JSON.parse(result.stdout);
}

// Only text the checker composes from fixed words and numbers renders as Markdown. Anything a probe returned
// (titles, authors, fetch errors) or an owner pasted (entries) renders as a code span, where GitHub turns no
// @mention, #reference, link, image or HTML into anything live.
const SAFE_TEXT = /^[A-Za-z0-9 ,.:;()='/+-]+$/;

/** A table cell of trusted text: one line, pipes and backslashes escaped. */
function text(value) {
  return String(value).replace(/[\r\n]+/g, ' ').replace(/[\\|]/g, '\\$&');
}

/** Untrusted text as an inert code span: one line, backticks swapped for quotes, pipes escaped for the table. */
function code(value) {
  return `\`${String(value).replace(/[\r\n]+/g, ' ').replace(/`/g, "'").replace(/[\\|]/g, '\\$&')}\``;
}

function isAttempt(attempt, entry) {
  return Boolean(attempt) && attempt.entry === entry && VERDICTS.has(attempt.verdict)
    && typeof attempt.why === 'string' && SAFE_TEXT.test(attempt.why) && typeof attempt.unverifiableFromRunner === 'boolean';
}

/** Every catalog slot exactly once, each attempt for the entry configured at that position, and a status its attempts agree with. */
function assertCompleteReport(report, catalog) {
  const incomplete = (detail) => new Error(`Live video audit report is incomplete: ${detail}`);
  if (!report || typeof report !== 'object') throw incomplete('not a JSON object');
  if (typeof report.checkedAt !== 'string' || Number.isNaN(Date.parse(report.checkedAt))) throw incomplete('checkedAt is not a date');
  if (!Array.isArray(report.canaries) || report.canaries.length !== catalog.canaries.length
    || !report.canaries.every((attempt, index) => isAttempt(attempt, catalog.canaries[index]))) {
    throw incomplete('the canaries do not match AUDIT_CANARIES');
  }
  if (!Array.isArray(report.slots)) throw incomplete('slots is not a list');

  const expected = new Map(catalogSlots(catalog));
  const seen = new Set();
  for (const slot of report.slots) {
    const entries = expected.get(slot?.slot);
    if (!entries || seen.has(slot.slot)) throw incomplete(`unexpected or repeated slot ${slot?.slot}`);
    seen.add(slot.slot);
    const wellFormed = typeof slot.surface === 'string' && SAFE_TEXT.test(slot.surface)
      && typeof slot.shownByDefault === 'boolean'
      && (slot.shownInstead === null || (typeof slot.shownInstead === 'string' && SAFE_TEXT.test(slot.shownInstead)))
      && Array.isArray(slot.attempts) && slot.attempts.length === entries.length
      && slot.attempts.every((attempt, index) => isAttempt(attempt, entries[index]))
      && STATUSES.has(slot.status) && slotStatus(slot.attempts) === slot.status;
    if (!wellFormed) throw incomplete(`${slot.slot} is malformed`);
  }
  const missing = [...expected.keys()].filter((slot) => !seen.has(slot));
  if (missing.length > 0) throw incomplete(`missing ${missing.join(', ')}`);
}

/**
 * The checker probes the canaries twice, around the batch it vouches for (runCheck). Re-probing them here would
 * vouch for the batch with a third reading taken minutes later, so a wall that has since lifted would publish
 * every verdict the walled batch produced as rot. No live canary in the report means the probe was broken.
 */
function confirmProbeWorks(canaries) {
  const liveCount = canaries.filter((attempt) => attempt.verdict === 'live').length;
  if (liveCount === 0) {
    const reasons = canaries.map((attempt) => `${attempt.entry} (${attempt.why})`).join('; ');
    throw new Error(`every audit canary failed twice, so the probe is broken rather than the catalog: ${reasons}`);
  }
  return `${liveCount} of ${canaries.length} live`;
}

/** Why an attempt failed: the checker's fixed text, then anything the probe reported, as code. */
function because(attempt) {
  const { detail, title, author } = attempt.evidence ?? {};
  const reported = [detail && code(detail), title && code(title), author && `by ${code(author)}`].filter(Boolean).join(' ');
  return reported ? `${text(attempt.why)}: ${reported}` : text(attempt.why);
}

// "entry 2", never "#2": GitHub links #N to an issue.
function entryCell(attempt, index) {
  return `${index > 0 ? `entry ${index + 1}: ` : ''}${code(attempt.entry)}`;
}

/** One row per dead entry ahead of whatever plays; an empty slot gets one row. */
function findingRows(slot) {
  const lead = [text(slot.slot), text(slot.surface), text(slot.status)];
  if (slot.status === 'empty') return [[...lead, '—', 'no entries configured', text(slot.shownInstead ?? '—')]];
  const liveAt = slot.attempts.findIndex((attempt) => attempt.verdict === 'live');
  const unverifiedAt = slot.attempts.findIndex((attempt) => attempt.unverifiableFromRunner);
  // With nothing live, every dead entry is a row: an unverifiable entry ahead of them proves nothing plays.
  const stopAt = liveAt >= 0 ? liveAt : slot.attempts.length;
  let instead = slot.shownInstead ?? '—';
  if (liveAt > 0) instead = `entry ${liveAt + 1} (live)`;
  else if (liveAt < 0 && unverifiedAt >= 0) instead = `entry ${unverifiedAt + 1} (unverified)`;
  return slot.attempts
    .slice(0, stopAt)
    .map((attempt, index) => ({ attempt, index }))
    .filter(({ attempt }) => !attempt.unverifiableFromRunner)
    .map(({ attempt, index }) => [...lead, entryCell(attempt, index), because(attempt), text(instead)]);
}

/** Hotspot wall slots first, in grid priority order; everything else keeps the report's order. */
function inAttentionOrder(slots, gridPriority) {
  const hotspot = ({ slot }) => {
    const index = slot.startsWith('webcams/') ? gridPriority.indexOf(slot.slice('webcams/'.length)) : -1;
    return index < 0 ? Number.POSITIVE_INFINITY : index;
  };
  return slots
    .map((slot, order) => ({ slot, order }))
    .sort((a, b) => (hotspot(a.slot) - hotspot(b.slot)) || (a.order - b.order))
    .map(({ slot }) => slot);
}

/** A table of at most `maxRows` rows; the rest are counted below it and listed in full in the run summary. */
function table(header, rows, maxRows) {
  const more = Math.max(0, rows.length - maxRows);
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.slice(0, maxRows).map((row) => `| ${row.join(' | ')} |`),
    ...(more > 0 ? ['', `… and ${more} more (see the run summary)`] : []),
  ];
}

export function renderAuditBody(report, { runUrl = '', canaries, gridPriority = [], maxRows = Number.POSITIVE_INFINITY }) {
  const findings = report.slots.filter(isFinding);
  const shown = inAttentionOrder(findings.filter((slot) => slot.shownByDefault), gridPriority);
  const hidden = inAttentionOrder(findings.filter((slot) => !slot.shownByDefault), gridPriority);
  const unverifiable = report.slots.filter((slot) => slot.status === 'unverifiable-from-runner');
  const recheckSkipped = report.slots.flatMap((slot) => slot.attempts).filter((attempt) => attempt.evidence?.recheckSkipped === true).length;
  const lines = [
    `Daily live video source audit: ${findings.length} slot(s) need attention, ${shown.length} of them shown by default.`,
    '',
    `- Checked: ${new Date(report.checkedAt).toISOString()}${runUrl ? ` — [Workflow run](${runUrl})` : ''}`,
    `- Canaries: ${canaries}`,
    ...(recheckSkipped > 0
      ? [`- Alone checks skipped: ${recheckSkipped} stalled YouTube ${recheckSkipped === 1 ? 'entry' : 'entries'}, because the audit time budget was used up`]
      : []),
    '',
    'Status `needs-replacement` means no entry is live, `degraded` means an entry failed while another plays or could not be verified, and `empty` means a slot viewers see by default has no entries.',
  ];
  if (shown.length > 0) lines.push('', '### Shown by default', '', ...table(FINDINGS_HEADER, shown.flatMap(findingRows), maxRows));
  if (hidden.length > 0) lines.push('', '### Not shown by default', '', ...table(FINDINGS_HEADER, hidden.flatMap(findingRows), maxRows));
  if (unverifiable.length > 0) {
    const rows = unverifiable.flatMap((slot) => slot.attempts
      .map((attempt, index) => ({ attempt, index }))
      .filter(({ attempt }) => attempt.unverifiableFromRunner)
      .map(({ attempt, index }) => [text(slot.slot), text(slot.surface), entryCell(attempt, index), because(attempt)]));
    lines.push(
      '', '### Could not verify from the runner', '',
      'An HLS 403, 451, 429 or 5xx, an HLS timeout, connection error or incomplete certificate chain, a YouTube player that never became ready, gave no verdict or never started while no canary played, a player that stopped reporting whether a video is live, or a YouTube player API that did not load can depend on the runner (its network, its region, or YouTube itself). These slots may still play for viewers, so they are not counted above. A YouTube player that stalls while a canary plays is checked alone up to twice within the audit time budget, and is counted above only if both checks stall.',
      '', ...table(['Slot', 'Where it shows', 'Entry', 'Why'], rows, maxRows),
    );
  }
  const unfilled = report.slots.filter(isUnfilled);
  if (unfilled.length > 0) {
    const bySurface = new Map();
    for (const slot of unfilled) bySurface.set(slot.surface, [...(bySurface.get(slot.surface) ?? []), slot.slot]);
    lines.push(
      '', '### Unfilled slots (hidden from viewers)', '',
      `${unfilled.length} slot(s) have no entries, so the dashboard hides them. They are not counted above; fill one the same way as a broken slot.`,
      '', ...[...bySurface].map(([surface, slots]) => {
        const listed = slots.slice(0, maxRows);
        const more = slots.length - listed.length;
        return `- ${surface}: ${[...listed, ...(more > 0 ? [`… and ${more} more (see the run summary)`] : [])].join(', ')}`;
      }),
    );
  }
  lines.push(
    '', '### Fix a slot', '',
    '1. Find a live stream for the slot and check it: `npm run live-video:check -- <url>`',
    '2. When it prints `LIVE`, paste its `paste:` line into the slot\'s list in `src/config/live-video-sources.ts`. Entries are tried in order.',
    '3. Re-check the slot before committing: `npm run live-video:check -- --slot <slot>`',
    '',
    'Each daily run rewrites this issue, closes it once no slot needs attention, and reopens it if a slot regresses.',
  );
  return lines.join('\n');
}

/**
 * The body GitHub will accept: at most ISSUE_ROWS_PER_SECTION rows per section, halved until it fits under
 * MAX_ISSUE_BODY_CHARS. With no rows left the body is headings and counts, so it always fits.
 */
function issueBody(report, rendering) {
  for (let maxRows = ISSUE_ROWS_PER_SECTION; ; maxRows = Math.floor(maxRows / 2)) {
    const body = renderAuditBody(report, { ...rendering, maxRows });
    if (body.length <= MAX_ISSUE_BODY_CHARS || maxRows === 0) return body;
  }
}

/**
 * The workflow files and rewrites this issue as `github.token`. The repository is public, so anyone can open an
 * issue with the same title; the bot must never rewrite, reopen or comment on one it does not own.
 */
const AUDIT_ISSUE_AUTHOR = 'github-actions[bot]';
const ownedByAudit = (issue) => !issue.pull_request && issue.title === ISSUE_TITLE && issue.user?.login === AUDIT_ISSUE_AUTHOR;

/**
 * This audit's own issues in `state`, newest update first. Search narrows the candidates to that title: listing the
 * repository's issues would page through hundreds of unrelated ones (8,000+ issues and PRs in every state) inside
 * ghJson's single 30 s budget. The exact-title, not-a-PR and author checks happen here, since search matches the
 * phrase anywhere in a title and ranks by relevance rather than by update time.
 */
function auditIssues(repository, gh, state) {
  const query = `repo:${repository} is:issue is:${state} in:title "${ISSUE_TITLE}"`;
  const pages = gh(['api', '--paginate', '--slurp', '--method', 'GET', 'search/issues', '-f', `q=${query}`, '-f', 'per_page=100']);
  return pages
    .flatMap((page) => page?.items ?? [])
    .filter(ownedByAudit)
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
}

function regressedComment(report, findings, runUrl) {
  return [
    `Regressed: ${findings} slot(s) need attention as of ${new Date(report.checkedAt).toISOString()}. The issue body lists them.`,
    runUrl ? `[Workflow run](${runUrl})` : '',
  ].filter(Boolean).join(' ');
}

function recoveredComment(report, runUrl) {
  const unverifiable = report.slots.filter((slot) => slot.status === 'unverifiable-from-runner').length;
  const unfilled = report.slots.filter(isUnfilled).length;
  return [
    `Recovered: no live video slot needs attention as of ${new Date(report.checkedAt).toISOString()}.`,
    unverifiable > 0 ? `${unverifiable} slot(s) could not be verified from the runner; the run summary lists them.` : '',
    unfilled > 0 ? `${unfilled} unfilled slot(s) stay hidden from viewers; the run summary lists them.` : '',
    runUrl ? `[Workflow run](${runUrl})` : '',
  ].filter(Boolean).join(' ');
}

export async function publishAudit(report, {
  repository = process.env.GITHUB_REPOSITORY,
  runUrl = '',
  summaryPath,
  catalog = DEFAULT_CATALOG,
  gh = ghJson,
} = {}) {
  assertCompleteReport(report, catalog);
  // Before anything else reads the report: a run that cannot publish fails fast.
  if (!repository) throw new Error('GITHUB_REPOSITORY is required to publish the live video audit');
  const canaries = confirmProbeWorks(report.canaries);
  const rendering = { runUrl, canaries, gridPriority: catalog.gridPriority ?? [] };
  if (summaryPath) appendFileSync(summaryPath, `${renderAuditBody(report, rendering)}\n`);
  const body = issueBody(report, rendering);

  const findings = report.slots.filter(isFinding).length;
  const [existing] = auditIssues(repository, gh, 'open');
  if (findings === 0) {
    if (!existing) return { findings, action: 'none' };
    gh(['api', '--method', 'POST', `repos/${repository}/issues/${existing.number}/comments`, '--input', '-'], { body: recoveredComment(report, runUrl) });
    gh(['api', '--method', 'PATCH', `repos/${repository}/issues/${existing.number}`, '--input', '-'], { state: 'closed', state_reason: 'completed' });
    return { findings, action: 'closed', issue: existing.number };
  }
  if (existing) {
    // An issue closed between the lookup and this write is reopened, not left closed with a fresh body.
    gh(['api', '--method', 'PATCH', `repos/${repository}/issues/${existing.number}`, '--input', '-'], { title: ISSUE_TITLE, body, state: 'open' });
    return { findings, action: 'updated' };
  }
  // A regression after a recovery reopens the closed issue, so recover and regress cycles never pile up duplicates.
  const [closed] = auditIssues(repository, gh, 'closed');
  if (closed) {
    gh(['api', '--method', 'PATCH', `repos/${repository}/issues/${closed.number}`, '--input', '-'], { title: ISSUE_TITLE, body, state: 'open' });
    gh(['api', '--method', 'POST', `repos/${repository}/issues/${closed.number}/comments`, '--input', '-'], { body: regressedComment(report, findings, runUrl) });
    return { findings, action: 'reopened', issue: closed.number };
  }
  gh(['api', '--method', 'POST', `repos/${repository}/issues`, '--input', '-'], { title: ISSUE_TITLE, body });
  return { findings, action: 'created' };
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    const report = JSON.parse(readFileSync(process.env.LIVE_VIDEO_AUDIT_REPORT, 'utf8'));
    const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
    const runUrl = GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID
      ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
      : '';
    console.log(JSON.stringify(await publishAudit(report, { runUrl, summaryPath: process.env.GITHUB_STEP_SUMMARY })));
  } catch (error) {
    console.error(`Live video audit could not report: ${error.message}`);
    process.exitCode = 1;
  }
}
