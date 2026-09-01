#!/usr/bin/env node
// Emits public/.well-known/agent-skills/index.json per the Agent Skills
// Discovery RFC v0.2.0. Each entry points at a SKILL.md and carries a
// digest ("sha256:<hex>") of that file's exact served bytes, so agents can
// verify the skill text hasn't changed since they last fetched it.
//
// Source of truth: public/.well-known/agent-skills/<name>/SKILL.md
// Output:          public/.well-known/agent-skills/index.json
//                  skills/<name>/SKILL.md (regular Agent Plugins entrypoints)
//
// Run locally via `npm run build:agent-skills`. CI re-runs this and
// diffs the output against the committed index.json and plugin skills to
// block drift.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..');
const SKILLS_DIR = resolve(ROOT, 'public/.well-known/agent-skills');
const PLUGIN_SKILLS_DIR = resolve(ROOT, 'skills');
const INDEX_PATH = join(SKILLS_DIR, 'index.json');
const MCP_SKILLS_PATH = resolve(ROOT, 'api/mcp/skill-extension/generated.ts');
const PUBLIC_BASE = 'https://worldmonitor.app';

// Canonical v0.2.0 discovery-schema URL. Graders (orank/ora.ai Identity
// `agent-skills-index-v2`) string-match this exact value; the earlier
// agentskills.io/schemas/... spelling reads as "unknown version" to them.
const SCHEMA = 'https://schemas.agentskills.io/discovery/0.2.0/schema.json';

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
  '- Use `fetch-news-digest` when the user asks what’s in the news right now — the aggregated, categorized, threat-classified output of the curated feed catalog in one call.',
  '- Use `fetch-country-brief` when the user asks for a strategic read on one country’s geopolitical, economic, or security situation (a source-attributed narrative brief).',
  '- Use `fetch-resilience-score` when the user asks how resilient a country is, or wants its composite 0–100 resilience score, 30-day trend, or per-domain/pillar breakdown.',
  '- Use `check-chokepoint-status` when the user asks whether a maritime chokepoint (Suez, Hormuz, Malacca…) is disrupted, congested, or safe right now.',
  '- Use `get-market-quotes` when the user asks for current equity/index/ETF prices or a quick market snapshot.',
  '- Use `track-conflict-events` when the user asks about recent fighting or attacks — geolocated UCDP events with parties and fatality bands.',
  '- Use `scan-cyber-threats` when the user asks about active malware IOCs, C2 infrastructure, or CISA known-exploited vulnerabilities.',
  '- Use `check-sanctions-pressure` when the user asks which countries/programs face OFAC sanctions pressure or what was recently designated (Pro-gated).',
  '- Use `check-country-risk` when the user asks how risky or unstable a country is right now — CII stress score, advisory level, sanctions exposure.',
  '- Use `check-airport-delays` when the user asks whether an airport is delayed or disrupted, with quantified delay/cancellation impact.',
  '- Use `track-military-flights` when the user asks about military air activity in a region — tracked aircraft plus activity clusters.',
  '- Use `monitor-internet-outages` when the user asks whether a country’s internet is down, shut down, or throttled.',
  '- Use `track-earthquakes` when the user asks about recent seismic activity, including test-site proximity concern scoring.',
  '- Use `get-prediction-markets` when the user asks what the market odds are on a geopolitical, economic, or election outcome.',
  '- Use `track-tariff-trends` when the user asks how tariffs between two countries changed or what rate a sector faces (Pro-gated).',
  '- Use `track-vessel-traffic` when the user asks what ships are in an area or whether maritime traffic is disrupted (AIS snapshot).',
  '- Use `assess-energy-shock` when the user asks how a chokepoint disruption could affect a country\'s oil, gas, fuel products, or strategic cover.',
  '- Use `monitor-energy-disruptions` when the user asks which pipelines, storage facilities, LNG terminals, or fuel assets are disrupted, sanctioned, offline, or under watch.',
  '- Use `monitor-supply-chain-stress` when the user asks whether container shipping or carrier-market indicators show current supply-chain pressure.',
  '- Use `trace-trade-flows` when the user asks who trades a strategic commodity, whether flows changed sharply, or which reporter/partner pairs look anomalous (Pro-gated).',
  '- Use `track-unrest-events` when the user asks about protests, riots, strikes, demonstrations, or civil unrest in a country or time window.',
  '- Use `monitor-webcams` when the user asks for live visual context near a location, route, border, port, airport, or city.',
  '- Use `track-climate-hazards` when the user asks about floods, cyclones, droughts, heatwaves, wildfires, climate anomalies, or climate disruption headlines.',
  '- Use `monitor-health-alerts` when the user asks about disease outbreaks or PM2.5 air-quality health warnings.',
  '- Use `check-forecast-signals` when the user asks what World Monitor is forecasting, how probabilities shifted, or how calibrated the forecasts are.',
  '',
  'Beyond these skills the MCP server exposes a broad catalog of tools — displacement, natural disasters, research, imagery, and more. Use them together to check whether a live event (a conflict, sanction, climate hazard, or chokepoint disruption) has a plausible market, health, energy, or supply-chain transmission path.',
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
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isTextMimeType(mimeType) {
  return mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/javascript';
}

export function buildResourceContent(content, mimeType) {
  return isTextMimeType(mimeType)
    ? { mimeType, text: content.toString('utf-8') }
    : { mimeType, blob: content.toString('base64') };
}

// Agent Plugins 1.0.0 requires skills/<name>/SKILL.md to resolve to a regular
// file. Git symlinks become one-line relative paths on Windows
// (`core.symlinks=false`) and in zip extracts, so the plugin would ship no
// valid recipes. Materialize regular files from the well-known sources, but
// rewrite checkout-specific API hosts (`*.worldmonitor.app/api/`) to the
// public site origin already advertised by plugin.json. That keeps the
// portable package off Vite env hosts that secret scanners treat as
// credentials when they appear in newly added files.
export function rewriteWellKnownSkillForPlugin(md) {
  return md.replace(/https:\/\/([A-Za-z0-9.-]+)(\/api\/)/g, (full, host, suffix) => {
    const normalized = host.toLowerCase();
    if (normalized === 'worldmonitor.app' || normalized === 'www.worldmonitor.app') {
      return full;
    }
    if (normalized.endsWith('.worldmonitor.app')) {
      return `${PUBLIC_BASE}${suffix}`;
    }
    return full;
  });
}

function isOwnedSkillName(name) {
  return typeof name === 'string'
    && name.length > 0
    && name === basename(name)
    && name !== '.'
    && name !== '..';
}

// The committed discovery index is the ownership ledger for generated
// `skills/<name>/SKILL.md` files. Walk that prior set — not the live
// `skills/` tree — so a deleted well-known recipe can be pruned without
// touching ignored local installs (`npx skills add`, scratch notes).
export function readIndexedPluginSkillNames(indexPath = INDEX_PATH) {
  if (!existsSync(indexPath)) return [];
  const parsed = JSON.parse(readFileSync(indexPath, 'utf-8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.skills)) {
    throw new Error(`${indexPath} is not a generated agent-skills index`);
  }
  const names = [];
  for (const skill of parsed.skills) {
    const name = skill && typeof skill === 'object' ? skill.name : null;
    if (!isOwnedSkillName(name)) {
      throw new Error(`${indexPath} has an unsafe or missing skill name`);
    }
    names.push(name);
  }
  return names;
}

export function collectPluginSkillNames(skillsDir = SKILLS_DIR) {
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter(isOwnedSkillName)
    .sort();
}

export function expectedPluginSkillBody(name, skillsDir = SKILLS_DIR) {
  const canonical = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf-8');
  return rewriteWellKnownSkillForPlugin(canonical);
}

function pluginSkillPath(pluginSkillsDir, name) {
  return join(pluginSkillsDir, name, 'SKILL.md');
}

function pruneStalePluginSkill(pluginSkillsDir, name, { check }) {
  const dest = pluginSkillPath(pluginSkillsDir, name);
  const dir = join(pluginSkillsDir, name);
  if (check) {
    return existsSync(dest) ? name : null;
  }
  if (existsSync(dest)) {
    const stat = lstatSync(dest);
    if (stat.isSymbolicLink() || stat.isFile()) {
      unlinkSync(dest);
    }
  }
  if (existsSync(dir) && readdirSync(dir).length === 0) {
    rmdirSync(dir);
  }
  return null;
}

function assertPluginSkillRegularFile(dest, name) {
  if (!existsSync(dest)) {
    throw new Error(`missing skills/${name}/SKILL.md — run \`npm run build:agent-skills\``);
  }
  const stat = lstatSync(dest);
  if (stat.isSymbolicLink()) {
    throw new Error(
      `skills/${name}/SKILL.md is a symlink; Agent Plugins installs need a regular file`,
    );
  }
  if (!stat.isFile()) {
    throw new Error(`skills/${name}/SKILL.md must be a regular file`);
  }
}

export function materializePluginSkills({
  check = false,
  skillsDir = SKILLS_DIR,
  pluginSkillsDir = PLUGIN_SKILLS_DIR,
  indexPath = INDEX_PATH,
} = {}) {
  const names = collectPluginSkillNames(skillsDir);
  const priorNames = readIndexedPluginSkillNames(indexPath);
  const current = new Set(names);
  const leftover = [];
  for (const name of priorNames.filter((prior) => !current.has(prior))) {
    const stale = pruneStalePluginSkill(pluginSkillsDir, name, { check });
    if (stale) leftover.push(stale);
  }
  const drifted = [];
  for (const name of names) {
    const expected = expectedPluginSkillBody(name, skillsDir);
    const dest = pluginSkillPath(pluginSkillsDir, name);
    if (check) {
      assertPluginSkillRegularFile(dest, name);
      const body = readFileSync(dest, 'utf-8');
      if (body !== expected) drifted.push(name);
      continue;
    }
    mkdirSync(join(pluginSkillsDir, name), { recursive: true });
    if (existsSync(dest) && lstatSync(dest).isSymbolicLink()) {
      unlinkSync(dest);
    }
    writeFileSync(dest, expected);
  }
  if (check && leftover.length > 0) {
    throw new Error(
      `plugin skills/${leftover.join(', ')}/SKILL.md remain after their well-known sources were removed. Run \`npm run build:agent-skills\`.`,
    );
  }
  if (check && drifted.length > 0) {
    throw new Error(
      `plugin skills/${drifted.join(', ')}/SKILL.md drifted from well-known recipes. Run \`npm run build:agent-skills\`.`,
    );
  }
  return names;
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

export function collectSkills() {
  const entries = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  return entries.map((name) => {
    const skillDir = join(SKILLS_DIR, name);
    const skillPath = join(skillDir, 'SKILL.md');
    const files = readdirSync(skillDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .sort();
    if (!files.includes(skillPath) || !statSync(skillPath).isFile()) {
      throw new Error(`Expected ${skillPath} to exist and be a file`);
    }
    const bytes = readFileSync(skillPath);
    const md = bytes.toString('utf-8');
    const lfMd = md.replace(/\r\n/g, '\n');
    const fm = parseFrontmatter(lfMd);
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
      // v0.2.0 entry types are `skill-md` (a bare SKILL.md) or `archive`;
      // every entry here points at a served SKILL.md.
      type: 'skill-md',
      description: fm.description,
      url: `${PUBLIC_BASE}/.well-known/agent-skills/${name}/SKILL.md`,
      digest: `sha256:${sha256Hex(bytes)}`,
      frontmatter: fm,
      resources: files.map((file) => {
        const content = readFileSync(file);
        const relativePath = file.slice(skillDir.length + 1).split('\\').join('/');
        const mimeType = relativePath.endsWith('.md') ? 'text/markdown' : 'application/octet-stream';
        return {
          uri: `skill://${name}/${relativePath}`,
          digest: `sha256:${sha256Hex(content)}`,
          size: content.byteLength,
          ...buildResourceContent(content, mimeType),
        };
      }),
    };
  });
}

function buildIndex(skills) {
  const publicSkills = skills.map(({ name, type, description, url, digest }) => ({
    name, type, description, url, digest,
  }));
  const index = { $schema: SCHEMA, instructions: INSTRUCTIONS, skills: publicSkills };
  return JSON.stringify(index, null, 2) + '\n';
}

function buildMcpModule(skills) {
  const entries = skills.map(({ name, frontmatter, resources }) => ({
    uri: `skill://${name}/SKILL.md`,
    frontmatter,
    resources: resources.map(({ uri, digest, size }) => ({ uri, digest, size })),
  }));
  const resources = Object.fromEntries(skills.flatMap((skill) => skill.resources.map((resource) => [
    resource.uri,
    'text' in resource
      ? { mimeType: resource.mimeType, text: resource.text }
      : { mimeType: resource.mimeType, blob: resource.blob },
  ])));
  return [
    '// Generated by scripts/build-agent-skills-index.mjs. Do not edit.',
    `export const SKILL_ENTRIES = ${JSON.stringify(entries, null, 2)} as const;`,
    `export const SKILL_RESOURCES = ${JSON.stringify(resources, null, 2)} as const;`,
    '',
  ].join('\n');
}

function build() {
  const skills = collectSkills();
  if (skills.length === 0) {
    throw new Error(`No skills found under ${SKILLS_DIR}`);
  }
  return { index: buildIndex(skills), mcpModule: buildMcpModule(skills) };
}

function main() {
  const { index, mcpModule } = build();
  const check = process.argv.includes('--check');
  if (check) {
    const current = readFileSync(INDEX_PATH, 'utf-8').replace(/\r\n/g, '\n');
    const currentMcpModule = readFileSync(MCP_SKILLS_PATH, 'utf-8').replace(/\r\n/g, '\n');
    if (current !== index || currentMcpModule !== mcpModule) {
      process.stderr.write(
        'agent-skills index.json is out of date. Run `npm run build:agent-skills`.\n',
      );
      process.exit(1);
    }
    try {
      materializePluginSkills({ check: true });
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
      process.exit(1);
    }
    process.stdout.write('agent-skills index.json and plugin skills/ are up to date.\n');
    return;
  }
  // Materialize (and prune) before overwriting the index so the prior
  // generated ledger is still on disk when stale plugin skills are removed.
  const names = materializePluginSkills();
  writeFileSync(INDEX_PATH, index);
  writeFileSync(MCP_SKILLS_PATH, mcpModule);
  process.stdout.write(
    `Wrote ${INDEX_PATH}, ${MCP_SKILLS_PATH}, and ${names.length} skills/*/SKILL.md files\n`,
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main();
}
