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
  const index = { $schema: SCHEMA, skills };
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
