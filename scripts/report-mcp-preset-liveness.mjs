#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { isMainModule } from './lib/main-module.mjs';

export const ISSUE_TITLE = 'MCP preset liveness: endpoint findings';

function ghJson(args, payload) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
    input: payload ? JSON.stringify(payload) : undefined,
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || 'GitHub API call failed');
  return JSON.parse(result.stdout);
}

function cell(value) {
  return String(value).replace(/[\r\n]+/g, ' ').replace(/[\\|]/g, '\\$&').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function publishFindings(report, {
  repository = process.env.GITHUB_REPOSITORY,
  runUrl = '',
  probeOutcome = 'success',
  summaryPath,
  gh = ghJson,
} = {}) {
  if (!Number.isInteger(report.expectedCount) || report.expectedCount <= 0
    || !Array.isArray(report.results) || report.results.length !== report.expectedCount
    || report.results.some(result => typeof result.ok !== 'boolean' || !result.name || !result.serverUrl || !result.observed)) {
    throw new Error('MCP preset probe report is incomplete');
  }
  const findings = report.results.filter(result => !result.ok);
  if (probeOutcome !== 'success' && findings.length === 0) {
    throw new Error('MCP preset suite failed without endpoint findings; inspect the test log');
  }
  const body = [
    `Weekly MCP preset liveness check: ${findings.length} finding(s) among ${report.expectedCount} endpoints.`,
    '',
    `Observed: ${cell(report.checkedAt)}${runUrl ? ` — [Workflow run](${runUrl})` : ''}`,
    '',
    '| Preset | Catalog URL | Observed result |',
    '| --- | --- | --- |',
    ...findings.map(result => `| ${cell(result.name)} | ${cell(result.serverUrl)} | ${cell(result.observed)} |`),
    '',
    'Open presets require HTTP 200; keyed presets also accept HTTP 401/403. Redirects are not followed. Reserved example-domain templates are skipped.',
    '',
    'Recheck each finding and repair or remove the affected catalog entry. This unauthenticated check proves HTTP reachability, not authenticated tool execution. Repeat failures update this issue; close it after verifying recovery.',
    '',
    'Run locally: `LIVE_MCP_TESTS=1 node --test tests/mcp-presets.test.mjs`. See #8087.',
  ].join('\n');
  if (summaryPath) appendFileSync(summaryPath, `${body}\n`);
  if (!findings.length) return { findings: 0 };
  if (!repository) throw new Error('GITHUB_REPOSITORY is required to publish MCP preset findings');
  const pages = gh(['api', '--paginate', '--slurp', `repos/${repository}/issues?state=open&per_page=100`]);
  const existing = pages.flat().find(issue => !issue.pull_request && issue.title === ISSUE_TITLE);
  const endpoint = `repos/${repository}/issues${existing ? `/${existing.number}` : ''}`;
  gh(['api', '--method', existing ? 'PATCH' : 'POST', endpoint, '--input', '-'], { title: ISSUE_TITLE, body });
  return { findings: findings.length, action: existing ? 'updated' : 'created' };
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    const report = JSON.parse(readFileSync(process.env.MCP_PRESET_REPORT, 'utf8'));
    const runUrl = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
    console.log(JSON.stringify(publishFindings(report, {
      runUrl, probeOutcome: process.env.PROBE_OUTCOME, summaryPath: process.env.GITHUB_STEP_SUMMARY,
    })));
  } catch (error) {
    console.error(`MCP preset monitor could not report: ${error.message}`);
    process.exitCode = 1;
  }
}
