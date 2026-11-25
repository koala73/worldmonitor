#!/usr/bin/env node
// Turns the panel content run's shards (scripts/dogfood/content-prompt.md) into one review issue per day,
// "Panel content review: <date>". A rerun on the same day rewrites that issue; a run filtered by host or panel
// gets its own "(partial, run <id>)" issue, so it never replaces the full run's.
//
// The plan (which panels each shard had to check) comes from the workflow's plan job and is trusted. Each shard's
// setup file and Claude result are written outside the agent's directory and are trusted for their shape only.
// Each shard's findings.json was written by an agent that read third-party page text, so it is untrusted: every
// field renders as an inert code span, a panel row counts only for a panel the plan gave that shard, and a panel
// the agent never reported shows as not reported, so silence never reads as a clean panel.
// Run with: DOGFOOD_PLAN=<plan.json> DOGFOOD_SHARDS=<dir> DOGFOOD_OPEN_ISSUES=<file> node scripts/report-dogfood-content.mjs
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isMainModule } from './lib/main-module.mjs';
import { MAX_ISSUE_BODY_CHARS, code, publishIssue, strings } from './report-dogfood-review.mjs';

const STATUSES = ['suspect', 'broken', 'ok', 'locked', 'not_reached'];
const SEVERITIES = ['high', 'medium', 'low'];
const MAX_FINDINGS = 40;
/** Panel rows are bounded so every non-ok panel can always be named within GitHub's body limit. */
const ROW_NOTE_CHARS = 200;

/** Shorten agent text before it is wrapped in a code span, never after: a cut span would turn live. */
const clip = (value, max) => {
  if (typeof value !== 'string') return '';
  return value.length > max ? `${value.slice(0, max)}…` : value;
};

const isStringList = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');

function readJson(file) {
  if (!existsSync(file)) return null;
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  try { return JSON.parse(text); } catch { /* retried below */ }
  // Agents quote table text from `get text`, raw tabs included, which JSON forbids inside a string. Outside a
  // string a control character is whitespace either way, so turning each into a space changes only the quote.
  try { return JSON.parse(text.replace(/[\u0000-\u001f]/g, ' ')); } catch { return null; }
}

/**
 * One shard's report, from the agent's output directory. The agent writes `panels/<id>.json` per panel
 * (`{ panel, findings, dismissed }`) and never rereads them, which keeps its context small; this joins them. A
 * `findings.json`, the older single-file form, is used when there are no panel files. Returns null when the
 * shard wrote neither, so it reports as not reported.
 */
export function readShardReport(outDir) {
  const panelDir = join(outDir, 'panels');
  const files = existsSync(panelDir) ? readdirSync(panelDir).filter((name) => name.endsWith('.json')).sort() : [];
  const parts = files.map((name) => readJson(join(panelDir, name)))
    .filter((part) => part && typeof part === 'object' && !Array.isArray(part));
  if (parts.length === 0) return readJson(join(outDir, 'findings.json'));
  const list = (value) => (Array.isArray(value) ? value : []);
  return {
    panels: parts.map((part) => part.panel).filter((panel) => panel && typeof panel === 'object' && !Array.isArray(panel)),
    findings: parts.flatMap((part) => list(part.findings)),
    dismissed: parts.flatMap((part) => list(part.dismissed)),
  };
}

/**
 * Merge the shards into one report.
 * @param {{ shards: Array<{ id: string, target: string, panels: string[] }>, panels: Array<{ id: string, name: string, host: string, shard: string }> }} plan
 * @param {Record<string, { findings: unknown, setup: unknown, result: unknown }>} shardFiles keyed by shard id
 */
export function mergeShards(plan, shardFiles) {
  const panels = [];
  const findings = [];
  const dismissed = [];
  let cost = 0;
  const shardStates = [];
  for (const shard of plan.shards) {
    const files = shardFiles[shard.id] ?? {};
    const raw = files.findings;
    const report = raw && typeof raw === 'object' && !Array.isArray(raw) && (Array.isArray(raw.panels) || Array.isArray(raw.findings)) ? raw : null;
    const setup = files.setup && typeof files.setup === 'object' ? files.setup : {};
    const result = files.result && typeof files.result === 'object' ? files.result : {};
    if (Number.isFinite(result.total_cost_usd)) cost += result.total_cost_usd;
    shardStates.push({ id: shard.id, report: Boolean(report), pro: setup.pro_session === true });
    const missing = new Set(strings(setup.missing));
    const rendered = Array.isArray(setup.rendered) ? new Set(strings(setup.rendered)) : null;
    const locked = new Set(strings(setup.locked));
    const rows = new Map();
    for (const row of Array.isArray(report?.panels) ? report.panels : []) {
      if (row && typeof row.id === 'string' && shard.panels.includes(row.id) && !rows.has(row.id)) rows.set(row.id, row);
    }
    for (const id of shard.panels) {
      const meta = plan.panels.find((panel) => panel.id === id) ?? { name: id, host: shard.id };
      const row = rows.get(id);
      let status = row && STATUSES.includes(row.status) ? row.status : 'not_reported';
      if (missing.has(id)) status = 'not_on_host';
      else if (rendered && !rendered.has(id)) status = 'not_rendered';
      else if (locked.has(id) && (status === 'ok' || status === 'not_reported')) status = 'locked';
      panels.push({
        id, name: meta.name, host: meta.host, shard: shard.id, status, checked: row?.checked, note: row?.note,
        viewsSkipped: strings(row?.views_skipped),
        // null when the agent wrote no row; false when either view list is missing or holds a non-string.
        viewsReported: row ? isStringList(row.views_checked) && isStringList(row.views_skipped) : null,
      });
    }
    for (const finding of Array.isArray(report?.findings) ? report.findings : []) {
      if (!finding || typeof finding.title !== 'string' || !finding.title.trim()) continue;
      findings.push({
        ...finding,
        shard: shard.id,
        listed: shard.panels.includes(finding.panel),
        severity: SEVERITIES.includes(finding.severity) ? finding.severity : 'low',
        // Anything not clearly proved by the page is a question for a human.
        kind: finding.kind === 'contradicted' ? 'contradicted' : 'implausible',
      });
    }
    for (const item of Array.isArray(report?.dismissed) ? report.dismissed : []) {
      if (item && typeof item === 'object') dismissed.push(item);
    }
  }
  findings.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'contradicted' ? -1 : 1)
    || SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  return { panels, findings, dismissed, cost, shards: shardStates };
}

function findingLines(finding, index, openIssues) {
  const duplicate = Number.isInteger(finding.duplicate_of) && openIssues.has(finding.duplicate_of)
    ? ` Possible duplicate of #${finding.duplicate_of}.`
    : '';
  const consoleLines = strings(finding.console).slice(0, 3);
  return [
    `- [ ] **${index + 1}. ${finding.severity}** ${code(finding.panel)} ${code(finding.title)}${finding.listed ? '' : ' (panel not in this shard\'s list)'}${duplicate}`,
    `  - Check: ${code(finding.check)}, shard ${code(finding.shard)}`,
    `  - On screen: ${code(finding.quote)}`,
    `  - Shown wrong by: ${code(finding.evidence_source)}`,
    `  - Expected: ${code(finding.expected)}`,
    `  - Actual: ${code(finding.actual)}`,
    ...(consoleLines.length > 0 ? [`  - Console: ${consoleLines.map(code).join(' ')}`] : []),
    `  - Evidence in the shard's artifact: ${strings(finding.evidence).slice(0, 6).map(code).join(' ') || 'none recorded'}`,
  ];
}

export function renderContentBody(merged, {
  date, runUrl = '', openIssues = new Set(), maxFindings = MAX_FINDINGS, showOk = true, noteChars = ROW_NOTE_CHARS, showDismissed = true,
  showViews = true,
}) {
  const count = (status) => merged.panels.filter((panel) => panel.status === status).length;
  const contradicted = merged.findings.filter((finding) => finding.kind === 'contradicted');
  const implausible = merged.findings.filter((finding) => finding.kind === 'implausible');
  const proShards = merged.shards.filter((shard) => shard.pro).length;
  const noReport = merged.shards.filter((shard) => !shard.report).map((shard) => shard.id);
  // A panel's verdict covers only the views its agent opened; the prompt has it check the default and one other.
  const partial = merged.panels.filter((panel) => panel.viewsSkipped.length > 0);
  const skippedViews = partial.reduce((sum, panel) => sum + panel.viewsSkipped.length, 0);
  const unlisted = merged.panels.filter((panel) => panel.viewsReported === false).length;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const lines = [
    `Panel content run for ${date}: ${merged.panels.length} panels in ${merged.shards.length} shards.`,
    '',
    `- Panels: ${count('ok')} ok, ${count('suspect')} suspect, ${count('broken')} broken, ${count('locked')} locked, ${count('not_reached') + count('not_reported')} not checked, ${count('not_rendered')} not rendered by setup, ${count('not_on_host')} not on their host.`,
    `- Findings: ${contradicted.length} contradicted by the page or its API, ${implausible.length} implausible and needing a human.`,
    `- Views: ${plural(partial.length, 'panel')} left ${plural(skippedViews, 'view')} unchecked; ${plural(unlisted, 'panel')} did not report ${unlisted === 1 ? 'its' : 'their'} views.`,
    `- Pro session in ${proShards} of ${merged.shards.length} shards. Agent cost $${merged.cost.toFixed(2)}.`,
    ...(noReport.length > 0 ? [`- Shards that left no findings file: ${noReport.map(code).join(' ')}`] : []),
    ...(runUrl ? [`- [Workflow run](${runUrl}): screenshots are in each shard's \`content-<shard>\` artifact.`] : []),
    '',
    'Nothing here is filed or fixed automatically. Tick an item once it is filed as its own issue, fixed, or judged not a bug.',
  ];
  let shown = 0;
  const section = (heading, list, empty) => {
    lines.push('', `### ${heading}`, '');
    if (list.length === 0) lines.push(empty);
    for (const finding of list) {
      if (shown >= maxFindings) { lines.push(`… and more in the shard artifacts' findings.json.`); return; }
      lines.push(...findingLines(finding, shown, openIssues));
      shown += 1;
    }
  };
  section('Contradicted by the page, its API or the clock', contradicted, 'None.');
  section('Implausible: check before filing', implausible, 'None.');

  const notOk = merged.panels.filter((panel) => panel.status !== 'ok');
  lines.push('', '### Panels that are not ok', '');
  if (notOk.length === 0) lines.push('Every panel was checked and found ok.');
  for (const panel of notOk) {
    const note = clip(panel.note, noteChars);
    lines.push(`- ${code(panel.id)} ${code(panel.name)} on ${code(panel.host)}: **${panel.status.replace(/_/g, ' ')}**${note ? ` ${code(note)}` : ''}`);
  }
  const ok = merged.panels.filter((panel) => panel.status === 'ok');
  if (ok.length > 0 && showOk) {
    lines.push('', '<details><summary>Panels found ok</summary>', '');
    for (const panel of ok) lines.push(`- ${code(panel.id)} on ${code(panel.host)}: ${code(clip(panel.checked, noteChars))}`);
    lines.push('', '</details>');
  }
  if (ok.length > 0 && !showOk) lines.push('', 'The ok panels are listed in the shard artifacts; this body had no room for them.');
  if (partial.length > 0 && showViews) {
    lines.push('', '### Views not checked', '', 'A panel\'s status covers only the views its agent opened. These tabs, sorts, filters and pickers were not checked.', '');
    for (const panel of partial) {
      lines.push(`- ${code(panel.id)} on ${code(panel.host)} (${panel.status.replace(/_/g, ' ')}): ${panel.viewsSkipped.map((view) => code(clip(view, 60))).join(' ')}`);
    }
  }
  if (merged.dismissed.length > 0 && showDismissed) {
    lines.push('', '### Dismissed as runner artifacts', '', 'Check these too: a real bug can hide behind a known artifact.', '');
    for (const item of merged.dismissed.slice(0, maxFindings)) lines.push(`- ${code(item.what)}: ${code(item.why)}`);
  }
  return lines.join('\n');
}

/**
 * A body GitHub will accept. Findings are cut first, then the ok list and dismissals, then the skipped views, then
 * panel notes; the totals and every non-ok panel row always stay. Nothing rendered is ever sliced, because cutting
 * through a code span would make agent text live.
 */
export function contentIssueBody(merged, rendering) {
  const attempts = [];
  for (let maxFindings = MAX_FINDINGS; maxFindings > 0; maxFindings = Math.floor(maxFindings / 2)) attempts.push({ maxFindings });
  attempts.push(
    { maxFindings: 0 },
    { maxFindings: 0, showOk: false, showDismissed: false },
    { maxFindings: 0, showOk: false, showDismissed: false, showViews: false },
    { maxFindings: 0, showOk: false, showDismissed: false, showViews: false, noteChars: 0 },
  );
  for (const attempt of attempts) {
    const body = renderContentBody(merged, { ...rendering, ...attempt });
    if (body.length <= MAX_ISSUE_BODY_CHARS) return body;
  }
  throw new Error('the review does not fit in an issue body even without findings and notes');
}

/** "Panel content review: <date>" for a full run; a filtered run gets its own issue so it cannot replace one. */
export function contentIssueTitle(date, { partialRunId = '' } = {}) {
  return partialRunId ? `Panel content review: ${date} (partial, run ${partialRunId})` : `Panel content review: ${date}`;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    const plan = JSON.parse(readFileSync(process.env.DOGFOOD_PLAN, 'utf8'));
    const dir = process.env.DOGFOOD_SHARDS;
    const shardFiles = Object.fromEntries(plan.shards.map(({ id }) => [id, {
      findings: readShardReport(join(dir, `content-${id}`, 'dogfood-output')),
      setup: readJson(join(dir, `content-${id}`, 'dogfood-output.setup.json')),
      result: readJson(join(dir, `content-${id}`, 'dogfood-output.result.json')),
    }]));
    const merged = mergeShards(plan, shardFiles);
    if (merged.shards.every((shard) => !shard.report)) throw new Error('no shard left a findings file');
    const openIssues = new Set(JSON.parse(readFileSync(process.env.DOGFOOD_OPEN_ISSUES, 'utf8')).map((issue) => issue.number));
    const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
    const runUrl = GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID
      ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
      : '';
    const date = new Date().toISOString().slice(0, 10);
    const body = contentIssueBody(merged, { date, runUrl, openIssues });
    const partialRunId = process.env.DOGFOOD_PARTIAL === 'true' ? (GITHUB_RUN_ID || 'local') : '';
    const title = contentIssueTitle(date, { partialRunId });
    const result = publishIssue({ repository: GITHUB_REPOSITORY, title, body, summaryPath: process.env.GITHUB_STEP_SUMMARY });
    console.log(JSON.stringify({ ...result, panels: merged.panels.length, findings: merged.findings.length }));
  } catch (error) {
    console.error(`Panel content review could not report: ${error.message}`);
    process.exitCode = 1;
  }
}
