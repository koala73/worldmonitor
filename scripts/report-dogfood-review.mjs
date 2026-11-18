#!/usr/bin/env node
// Turns the findings file written by the weekly dogfood agent (scripts/dogfood/prompt.md) into one review issue
// per ISO week. A rerun in the same week rewrites that week's issue instead of opening another.
// Run with: DOGFOOD_FINDINGS=<file> node scripts/report-dogfood-review.mjs
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { isMainModule } from './lib/main-module.mjs';

/** GitHub rejects an issue body over 65,536 characters; this leaves room for multi-unit characters. */
export const MAX_ISSUE_BODY_CHARS = 60_000;
const MAX_FINDINGS = 25;
const MAX_FIELD_CHARS = 600;
const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const ISSUE_AUTHOR = 'github-actions[bot]';

/** "2026-W47": the ISO week (Monday start) that contains `date`. */
export function isoWeek(date) {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  day.setUTCDate(day.getUTCDate() + 3 - ((day.getUTCDay() + 6) % 7));
  const firstThursday = new Date(Date.UTC(day.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((day - firstThursday) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export const issueTitle = (week) => `Dogfood review: ${week}`;

// Everything in the findings file was written by an agent that read third-party page text, so all of it is
// untrusted. It renders only as code spans, where GitHub turns no @mention, #reference, link, image or HTML into
// anything live. The only Markdown outside code spans is fixed text and numbers this script composes.
function code(value) {
  let text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length > MAX_FIELD_CHARS) text = `${text.slice(0, MAX_FIELD_CHARS)}…`;
  return text ? `\`${text.replace(/`/g, "'")}\`` : '—';
}

const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);

/** The report as data: throws when the agent left no usable file, so the run fails visibly. */
export function readReport(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.findings)) {
    throw new Error('findings file has no findings list');
  }
  const findings = raw.findings.filter((finding) => finding && typeof finding.title === 'string' && finding.title.trim());
  return {
    target: String(raw.target ?? ''),
    focus: String(raw.focus ?? ''),
    pagesVisited: strings(raw.pages_visited),
    dismissed: Array.isArray(raw.dismissed) ? raw.dismissed.filter((item) => item && typeof item === 'object') : [],
    findings: findings.map((finding) => ({
      ...finding,
      severity: SEVERITIES.includes(finding.severity) ? finding.severity : 'low',
    })).sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity)),
  };
}

function findingLines(finding, index, openIssues) {
  // A duplicate reference links only when it names an issue the publish job itself listed as open, so the
  // agent cannot point the bot at an arbitrary issue or pull request.
  const duplicate = Number.isInteger(finding.duplicate_of) && openIssues.has(finding.duplicate_of)
    ? ` Possible duplicate of #${finding.duplicate_of}.`
    : '';
  const steps = strings(finding.steps).slice(0, 12);
  const consoleLines = strings(finding.console).slice(0, 5);
  return [
    `- [ ] **${index + 1}. ${finding.severity}** ${code(finding.title)}${duplicate}`,
    `  - Where: ${code(finding.url)} at ${code(finding.viewport)}, category ${code(finding.category)}`,
    ...(steps.length > 0 ? [`  - Steps: ${steps.map((step, n) => `${n + 1}. ${code(step)}`).join(' ')}`] : []),
    `  - Expected: ${code(finding.expected)}`,
    `  - Actual: ${code(finding.actual)}`,
    `  - Cause: ${code(finding.cause || 'unknown')}`,
    ...(consoleLines.length > 0 ? [`  - Console: ${consoleLines.map(code).join(' ')}`] : []),
    `  - Evidence in the run artifact: ${strings(finding.evidence).slice(0, 8).map(code).join(' ') || 'none recorded'}`,
  ];
}

export function renderBody(report, { week, runUrl = '', openIssues = new Set(), maxFindings = MAX_FINDINGS }) {
  const shown = report.findings.slice(0, maxFindings);
  const counts = SEVERITIES.map((severity) => `${report.findings.filter((f) => f.severity === severity).length} ${severity}`);
  const lines = [
    `Weekly agent-browser dogfood run for ${week}: ${report.findings.length} finding(s) to review (${counts.join(', ')}).`,
    '',
    `- Target: ${code(report.target)}`,
    `- Focus: ${code(report.focus)}`,
    `- Pages visited: ${report.pagesVisited.length}`,
    ...(runUrl ? [`- [Workflow run](${runUrl}): screenshots and videos are in its \`dogfood-output\` artifact.`] : []),
    '',
    'Nothing here is filed or fixed automatically. For each item, tick it once it is filed as its own issue, fixed, or judged not a bug.',
  ];
  lines.push('', '### Findings', '');
  if (shown.length === 0) lines.push('No findings this week.');
  shown.forEach((finding, index) => lines.push(...findingLines(finding, index, openIssues)));
  if (report.findings.length > shown.length) {
    lines.push('', `… and ${report.findings.length - shown.length} more in the run artifact's findings.json.`);
  }
  if (report.dismissed.length > 0) {
    lines.push('', '### Dismissed as runner artifacts', '', 'Check these too: a real bug can hide behind a known artifact.', '');
    for (const item of report.dismissed.slice(0, maxFindings)) lines.push(`- ${code(item.what)}: ${code(item.why)}`);
  }
  return lines.join('\n');
}

/** A body GitHub will accept: findings are halved until it fits. */
function issueBody(report, rendering) {
  for (let maxFindings = MAX_FINDINGS; ; maxFindings = Math.floor(maxFindings / 2)) {
    const body = renderBody(report, { ...rendering, maxFindings });
    if (body.length <= MAX_ISSUE_BODY_CHARS || maxFindings === 0) return body;
  }
}

function ghJson(args, payload) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
    input: payload ? JSON.stringify(payload) : undefined,
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || 'GitHub API call failed');
  return JSON.parse(result.stdout);
}

/**
 * The repository is public, so anyone can open an issue with this week's title. The bot rewrites only an issue
 * it opened itself, matched on the exact title.
 */
export function publishReview(report, { repository, week, runUrl = '', openIssues = new Set(), summaryPath, gh = ghJson }) {
  if (!repository) throw new Error('GITHUB_REPOSITORY is required to publish the dogfood review');
  const title = issueTitle(week);
  const body = issueBody(report, { week, runUrl, openIssues });
  if (summaryPath) appendFileSync(summaryPath, `${body}\n`);
  const query = `repo:${repository} is:issue in:title "${title}"`;
  const pages = gh(['api', '--paginate', '--slurp', '--method', 'GET', 'search/issues', '-f', `q=${query}`, '-f', 'per_page=100']);
  const existing = pages.flatMap((page) => page?.items ?? [])
    .find((issue) => !issue.pull_request && issue.title === title && issue.user?.login === ISSUE_AUTHOR);
  if (existing) {
    gh(['api', '--method', 'PATCH', `repos/${repository}/issues/${existing.number}`, '--input', '-'], { body });
    return { action: 'updated', issue: existing.number, findings: report.findings.length };
  }
  const created = gh(['api', '--method', 'POST', `repos/${repository}/issues`, '--input', '-'], { title, body });
  return { action: 'created', issue: created.number, findings: report.findings.length };
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    const report = readReport(JSON.parse(readFileSync(process.env.DOGFOOD_FINDINGS, 'utf8')));
    const openIssues = new Set(JSON.parse(readFileSync(process.env.DOGFOOD_OPEN_ISSUES, 'utf8')).map((issue) => issue.number));
    const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
    const runUrl = GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID
      ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
      : '';
    const result = publishReview(report, {
      repository: GITHUB_REPOSITORY, week: isoWeek(new Date()), runUrl, openIssues, summaryPath: process.env.GITHUB_STEP_SUMMARY,
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`Dogfood review could not report: ${error.message}`);
    process.exitCode = 1;
  }
}
