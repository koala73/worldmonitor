#!/usr/bin/env node
// Emits public/.well-known/agent-skills/index.json per the Agent Skills
// Discovery RFC v0.2.0. Each entry points at a SKILL.md and carries a
// sha256 of that file's exact served bytes, so agents can verify the
// skill text hasn't changed since they last fetched it.
//
// Source of truth: public/.well-known/agent-skills/<name>/SKILL.md
// Output:          public/.well-known/agent-skills/index.json
//
// Run locally via `npm run build:agent-skills`. CI re-runs this and
// diffs the output against the committed index.json to block drift.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..');
const SKILLS_DIR = resolve(ROOT, 'public/.well-known/agent-skills');
const INDEX_PATH = join(SKILLS_DIR, 'index.json');
const PUBLIC_BASE = 'https://worldmonitor.app';

const SCHEMA = 'https://agentskills.io/schemas/v0.2.0/index.json';

// Top-level, publisher-level "when to use this" guidance embedded directly in
// the discovery manifest. Discovery graders (e.g. orank/ora.ai's Identity
// `agent-instruction` check) read THIS file as "the agent instruction file"
// and want explicit when-to-use guidance in it — a "when to use" section in
// llms.txt does not satisfy the check because the grader evaluates the manifest
// it found, not llms.txt. Names best-fit jobs, when NOT to use, and how an
// agent should call World Monitor. Keep in sync with the "When to Use World
// Monitor (Agent Guidance)" section of public/llms.txt.
const INSTRUCTIONS = [
  'World Monitor is a live, machine-readable global-intelligence API and MCP server. Reach for it when a task needs fresh, correlated, structured data about the state of the world — JSON to reason over, not prose to re-parse.',
  '',
  'When to use these skills:',
  '- Use `fetch-country-brief` when the user asks for a strategic read on one country’s geopolitical, economic, or security situation (a source-attributed narrative brief).',
  '- Use `fetch-resilience-score` when the user asks how resilient a country is, or wants its composite 0–100 resilience score, 30-day trend, or per-domain/pillar breakdown.',
  '',
  'Beyond these two skills the MCP server exposes a broad catalog of tools — conflict events, sanctions, shipping chokepoints, markets, commodities, energy, maritime and aviation activity, cyber threats, natural disasters, forecasts, and prediction markets. Use them together to check whether a live event (a conflict, sanction, or chokepoint disruption) has a plausible market or supply-chain transmission path.',
  '',
  'When NOT to use: World Monitor is not a general web-search engine, a historical archive, or a trading-execution venue — it places no orders and stores no user documents. For a one-off narrative that needs no correlation across live layers, a plain LLM is cheaper and faster.',
  '',
  'How an agent should call it:',
  '- MCP server (recommended): https://worldmonitor.app/mcp — Streamable HTTP; issue `tools/list` for the live inventory.',
  '- REST API: base https://api.worldmonitor.app — OpenAPI spec at https://worldmonitor.app/openapi.yaml.',
  '- CLI (shell/scripts): the `worldmonitor` npm package wraps these tools — `npx worldmonitor tools` (public, no key) or `npm i -g worldmonitor`, then pass `--api-key` for data calls. https://www.npmjs.com/package/worldmonitor',
  '- Auth: OAuth2 (`scope=mcp`) or an API-key header `X-WorldMonitor-Key: wm_<40-hex>`. Issue a key at https://worldmonitor.app/pro.',
].join('\n');

// Closing fence must be anchored to its own line so values that happen to
// start with `---` in the body can't prematurely terminate frontmatter.
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---(?:\n|$)/;

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function parseFrontmatter(md) {
  const match = FRONTMATTER_RE.exec(md);
  if (!match) return {};
  const parsed = yaml.load(match[1]);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Frontmatter must be a YAML mapping');
  }
  return parsed;
}

function collectSkills() {
  const entries = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  return entries.map((name) => {
    const skillPath = join(SKILLS_DIR, name, 'SKILL.md');
    const stat = statSync(skillPath);
    if (!stat.isFile()) {
      throw new Error(`Expected ${skillPath} to exist and be a file`);
    }
    const bytes = readFileSync(skillPath);
    const md = bytes.toString('utf-8');
    const fm = parseFrontmatter(md);
    if (!fm.description) {
      throw new Error(`${skillPath} missing "description" in frontmatter`);
    }
    if (fm.name && fm.name !== name) {
      throw new Error(
        `${skillPath} frontmatter name="${fm.name}" disagrees with directory "${name}"`,
      );
    }
    return {
      name,
      type: 'task',
      description: fm.description,
      url: `${PUBLIC_BASE}/.well-known/agent-skills/${name}/SKILL.md`,
      sha256: sha256Hex(bytes),
    };
  });
}

function build() {
  const skills = collectSkills();
  if (skills.length === 0) {
    throw new Error(`No skills found under ${SKILLS_DIR}`);
  }
  const index = { $schema: SCHEMA, instructions: INSTRUCTIONS, skills };
  return JSON.stringify(index, null, 2) + '\n';
}

function main() {
  const content = build();
  const check = process.argv.includes('--check');
  if (check) {
    const current = readFileSync(INDEX_PATH, 'utf-8');
    if (current !== content) {
      process.stderr.write(
        'agent-skills index.json is out of date. Run `npm run build:agent-skills`.\n',
      );
      process.exit(1);
    }
    process.stdout.write('agent-skills index.json is up to date.\n');
    return;
  }
  writeFileSync(INDEX_PATH, content);
  process.stdout.write(`Wrote ${INDEX_PATH}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
