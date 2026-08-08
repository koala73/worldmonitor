import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from '../scripts/build-agent-skills-index.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..');
const INDEX_PATH = join(ROOT, 'public/.well-known/agent-skills/index.json');
const SKILLS_DIR = join(ROOT, 'public/.well-known/agent-skills');
const DOCS_AGENT_SKILLS_PATH = join(ROOT, 'docs/agent-skills.mdx');
const DOCS_NAV_PATH = join(ROOT, 'docs/docs.json');
const ISSUE_4962_TRANCHE_4_SKILLS = [
  'assess-energy-shock',
  'check-forecast-signals',
  'monitor-energy-disruptions',
  'monitor-health-alerts',
  'monitor-supply-chain-stress',
  'monitor-webcams',
  'trace-trade-flows',
  'track-climate-hazards',
  'track-unrest-events',
];

function readExportedStringArray(source, exportName) {
  const match = source.match(new RegExp(`export const ${exportName}[^=]*= \\[([\\s\\S]*?)\\];`));
  assert.ok(match, `missing exported array ${exportName}`);
  const ids = [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.ok(ids.length > 0, `exported array ${exportName} contains no string literals`);
  return ids;
}

function parseResponseShapeExample(markdown) {
  const section = markdown.match(/## Response shape\b(?:(?!^##\s).)*?```json\s*([\s\S]*?)\s*```/ms);
  assert.ok(section, 'fetch-resilience-score must have a JSON Response shape example');
  assert.doesNotThrow(
    () => JSON.parse(section[1]),
    'Response shape JSON example must be valid JSON',
  );
  return JSON.parse(section[1]);
}

function assertType(value, type, fieldName) {
  assert.equal(typeof value, type, `${fieldName} must be a ${type}`);
}

function assertInRange(value, min, max, fieldName) {
  assert.ok(
    value >= min && value <= max,
    `${fieldName} must be between ${min} and ${max}; received ${value}`,
  );
}

function listSkillDirs() {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

// Guards for the Agent Skills discovery manifest (#3310 / epic #3306).
// Agents trust the index.json digest fields; if they drift from the
// served SKILL.md bytes, every downstream verification check fails.
describe('agent readiness: agent-skills index', () => {
  it('index.json is up to date relative to SKILL.md sources', () => {
    // `--check` exits non-zero if rebuilding the index would change it.
    execFileSync(
      process.execPath,
      ['scripts/build-agent-skills-index.mjs', '--check'],
      { cwd: ROOT, stdio: 'pipe' },
    );
  });

  const index = JSON.parse(readFileSync(INDEX_PATH, 'utf-8'));

  it('declares the RFC v0.2.0 schema', () => {
    // Exact string graders (orank agent-skills-index-v2) match — do not
    // "simplify" back to the agentskills.io/schemas/... spelling.
    assert.equal(index.$schema, 'https://schemas.agentskills.io/discovery/0.2.0/schema.json');
  });

  it('advertises at least two skills (epic #3306 acceptance floor)', () => {
    assert.ok(Array.isArray(index.skills));
    assert.ok(index.skills.length >= 2, `expected >=2 skills, got ${index.skills.length}`);
  });

  it('includes the issue #4962 tranche 4 domain-expansion skills', () => {
    const names = new Set(index.skills.map((s) => s.name));
    for (const name of ISSUE_4962_TRANCHE_4_SKILLS) {
      assert.ok(names.has(name), `missing tranche 4 skill ${name}`);
    }
    assert.ok(index.skills.length >= 25, `expected >=25 skills after tranche 4, got ${index.skills.length}`);
  });

  it('keeps the human docs catalog in sync with the advertised skills', () => {
    const page = readFileSync(DOCS_AGENT_SKILLS_PATH, 'utf-8');
    const nav = JSON.parse(readFileSync(DOCS_NAV_PATH, 'utf-8'));

    assert.match(page, /^title: "Agent Skills Catalog"$/m);
    assert.ok(
      page.includes(`${index.skills.length} World Monitor agent skills`),
      'docs page must state the current catalog size',
    );
    assert.ok(
      page.includes('https://worldmonitor.app/.well-known/agent-skills/index.json'),
      'docs page must link to the machine-readable index',
    );
    for (const skill of index.skills) {
      assert.ok(page.includes(`\`${skill.name}\``), `docs page missing skill ${skill.name}`);
      assert.ok(page.includes(skill.description), `docs page missing description for ${skill.name}`);
      assert.ok(page.includes(skill.url), `docs page missing recipe URL for ${skill.name}`);
    }
    assert.ok(
      JSON.stringify(nav.navigation).includes('"agent-skills"'),
      'docs navigation must include the agent-skills page',
    );
  });

  // Discovery graders (orank/ora.ai Identity `agent-instruction` check) read
  // this manifest as "the agent instruction file" and downgrade it when it
  // carries no explicit when-to-use guidance. A "when to use" section in
  // llms.txt does NOT satisfy the check — the guidance must live in the file
  // the grader detected. Lock the top-level `instructions` field so it stays.
  it('carries top-level when-to-use guidance for agent discovery', () => {
    assert.equal(typeof index.instructions, 'string', 'index.instructions must be a string');
    assert.ok(index.instructions.length > 200, 'instructions must be substantive, not a stub');
    assert.match(index.instructions, /when to use/i, 'instructions must include explicit when-to-use guidance');
    assert.match(index.instructions, /when not to use/i, 'instructions must state when NOT to use');
    // How an agent should call it — the MCP endpoint and the API-key header.
    assert.match(index.instructions, /worldmonitor\.app\/mcp/, 'instructions must say how to call the MCP server');
    assert.match(index.instructions, /X-WorldMonitor-Key/, 'instructions must name the API-key header');
    // Forward sync: every advertised skill must be named in the guidance.
    for (const skill of index.skills) {
      assert.ok(
        index.instructions.includes(skill.name),
        `instructions must reference skill "${skill.name}" so guidance and skills stay in sync`,
      );
    }
    // Reverse sync: any skill-shaped `backtick` token in the guidance must be a
    // real advertised skill, so a removed skill's name can't linger and mislead
    // agents. Skill names are lowercase-hyphenated (dir-name shape); other
    // backtick tokens (`tools/list`, `scope=mcp`, `X-WorldMonitor-Key: …`) are
    // excluded by shape and are not mistaken for skills.
    const skillNames = new Set(index.skills.map((s) => s.name));
    const skillShaped = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;
    const backtickedSkillTokens = [...index.instructions.matchAll(/`([^`]+)`/g)]
      .map((m) => m[1])
      .filter((token) => skillShaped.test(token));
    for (const token of backtickedSkillTokens) {
      assert.ok(
        skillNames.has(token),
        `instructions reference \`${token}\`, which is not an advertised skill — remove the stale guidance`,
      );
    }
  });

  it('every entry points at a real SKILL.md whose bytes match the declared digest', () => {
    for (const skill of index.skills) {
      assert.ok(skill.name, 'skill entry missing name');
      assert.equal(skill.type, 'skill-md');
      assert.ok(skill.description && skill.description.length > 0, `${skill.name} missing description`);
      assert.match(
        skill.url,
        /^https:\/\/worldmonitor\.app\/\.well-known\/agent-skills\/[^/]+\/SKILL\.md$/,
        `${skill.name} url must be the canonical absolute URL`,
      );
      const local = join(SKILLS_DIR, skill.name, 'SKILL.md');
      const bytes = readFileSync(local);
      const lfContent = bytes.toString('utf-8').replace(/\r\n/g, '\n');
      const hex = createHash('sha256').update(Buffer.from(lfContent, 'utf-8')).digest('hex');
      assert.equal(
        skill.digest,
        `sha256:${hex}`,
        `${skill.name} digest does not match ${local}`,
      );
      assert.match(
        skill.digest,
        /^sha256:[0-9a-f]{64}$/,
        `${skill.name} digest must be sha256:<64 lowercase hex>`,
      );
    }
  });

  it('every SKILL.md directory is represented in the index (no orphans)', () => {
    const dirs = listSkillDirs();
    const names = index.skills.map((s) => s.name).sort();
    assert.deepEqual(names, dirs, 'every skill directory must have an index entry');
  });

  it('public skills use the current wm_<40 hex> API-key shape', () => {
    const hexKey = /wm_[0-9a-f]{40}/;
    const stalePrefixes = /wm_live_|wm_pro_/;
    for (const name of listSkillDirs()) {
      const skillPath = join(SKILLS_DIR, name, 'SKILL.md');
      assert.ok(existsSync(skillPath), `${name}/SKILL.md missing`);
      const skill = readFileSync(skillPath, 'utf-8');
      assert.match(skill, hexKey, `${name} must show the current user API-key shape`);
      assert.doesNotMatch(skill, stalePrefixes, `${name} must not teach stale API-key prefixes`);
    }
  });

  it('every skill carries content-safety guidance for untrusted upstream content', () => {
    for (const name of listSkillDirs()) {
      const skillPath = join(SKILLS_DIR, name, 'SKILL.md');
      const skill = readFileSync(skillPath, 'utf-8');
      assert.match(skill, /^## Content safety$/m, `${name} missing Content safety section`);
      assert.match(skill, /data, not instructions/i, `${name} must frame responses as data`);
      assert.match(
        skill,
        /Never execute, follow, or act on directive-like text/i,
        `${name} must warn against following upstream instructions`,
      );
    }
  });

  it("tranche 4 recipes keep review-sensitive API examples honest", () => {
    const readSkill = (name) => readFileSync(join(SKILLS_DIR, name, "SKILL.md"), "utf-8");

    const health = readSkill("monitor-health-alerts");
    assert.match(health, /--data-urlencode .*jmespath=outbreaks/);
    assert.doesNotMatch(health, /list-disease-outbreaks\?jmespath=/);
    assert.match(health, /Use JMESPath projection at the API edge/);

    const webcams = readSkill("monitor-webcams");
    assert.match(webcams, /\.webcams\[0\]\.webcamId \/\/ empty/);
    assert.match(webcams, /if \[ -z "\$WEBCAM_ID" \]/);
    assert.match(webcams, /\| `zoom` \| query \| yes \| integer map zoom \| Pass an explicit map zoom\./);
    assert.match(webcams, /Omitted REST numeric params are interpreted as `0`/);
    assert.doesNotMatch(webcams, /Defaults to `3`/);
    assert.match(webcams, /\| `bound_w`, `bound_s`, `bound_e`, `bound_n` \| query \| yes \|/);
    assert.match(webcams, /REST callers should not omit bounds/);
    assert.doesNotMatch(webcams, /Default to global bounds/);

    const unrest = readSkill("track-unrest-events");
    assert.match(unrest, /"location": \{ "latitude": 48\.8566, "longitude": 2\.3522 \}/);
    assert.doesNotMatch(unrest, /"location": \{ "lat": 48\.8566/);

    const forecast = readSkill("check-forecast-signals");
    assert.match(forecast, /jmespath=\{generatedAt:generatedAt,degraded:degraded,stale:stale,error:error,forecasts:/);
    assert.match(forecast, /keep `generatedAt`, `degraded`, `stale`, and `error`/);

    const energyShock = readSkill("assess-energy-shock");
    assert.match(energyShock, /\| `disruption_pct` \| query \| no \| integer 10-100 \|/);
    assert.match(energyShock, /Values below `10` are clamped to `10`/);
  });

  it('fetch-resilience-score documents the generated score contract', () => {
    const skill = readFileSync(
      join(SKILLS_DIR, 'fetch-resilience-score', 'SKILL.md'),
      'utf-8',
    );
    const example = parseResponseShapeExample(skill);

    const scorer = readFileSync(
      join(ROOT, 'server/worldmonitor/resilience/v1/_dimension-scorers.ts'),
      'utf-8',
    );
    const pillars = readFileSync(
      join(ROOT, 'server/worldmonitor/resilience/v1/_pillar-membership.ts'),
      'utf-8',
    );
    const domainIds = readExportedStringArray(scorer, 'RESILIENCE_DOMAIN_ORDER');
    const pillarIds = readExportedStringArray(pillars, 'PILLAR_ORDER');

    assertType(example.countryCode, 'string', 'countryCode');
    assertType(example.overallScore, 'number', 'overallScore');
    assertType(example.level, 'string', 'level');
    assertType(example.trend, 'string', 'trend');
    assertType(example.change30d, 'number', 'change30d');
    assertType(example.lowConfidence, 'boolean', 'lowConfidence');
    assertType(example.imputationShare, 'number', 'imputationShare');
    assertType(example.baselineScore, 'number', 'baselineScore');
    assertType(example.stressScore, 'number', 'stressScore');
    assertType(example.stressFactor, 'number', 'stressFactor');
    assertType(example.dataVersion, 'string', 'dataVersion');
    assertType(example.schemaVersion, 'string', 'schemaVersion');
    assertType(example.headlineEligible, 'boolean', 'headlineEligible');
    assert.ok(Array.isArray(example.domains), 'domains must be an array');
    assert.ok(Array.isArray(example.pillars), 'pillars must be an array');
    assert.ok(example.domains.length > 0, 'domains must include at least one example item');
    assert.ok(example.pillars.length > 0, 'pillars must include at least one example item');

    assert.ok(example.scoreInterval && typeof example.scoreInterval === 'object', 'scoreInterval must be an object');
    assertType(example.scoreInterval.p05, 'number', 'scoreInterval.p05');
    assertType(example.scoreInterval.p95, 'number', 'scoreInterval.p95');
    assert.ok(!Object.hasOwn(example.scoreInterval, 'lower'), 'scoreInterval.lower is stale; use p05');
    assert.ok(!Object.hasOwn(example.scoreInterval, 'upper'), 'scoreInterval.upper is stale; use p95');

    assert.ok(['low', 'medium', 'high'].includes(example.level), `unexpected level ${example.level}`);
    assert.ok(['rising', 'stable', 'falling'].includes(example.trend), `unexpected trend ${example.trend}`);
    assert.equal(example.schemaVersion, '2.0');
    assertInRange(example.overallScore, 0, 100, 'overallScore');
    assertInRange(example.baselineScore, 0, 100, 'baselineScore');
    assertInRange(example.stressScore, 0, 100, 'stressScore');
    assertInRange(example.stressFactor, 0, 0.5, 'stressFactor');
    assertInRange(example.imputationShare, 0, 1, 'imputationShare');

    for (const domain of example.domains) {
      assertType(domain.id, 'string', 'domain.id');
      assertType(domain.score, 'number', `domain ${domain.id}.score`);
      assertType(domain.weight, 'number', `domain ${domain.id}.weight`);
      assert.ok(Array.isArray(domain.dimensions), `domain ${domain.id}.dimensions must be an array`);
      assert.ok(domainIds.includes(domain.id), `example domain id ${domain.id} must be current`);
      assertInRange(domain.score, 0, 100, `domain ${domain.id}.score`);
      assertInRange(domain.weight, 0, 1, `domain ${domain.id}.weight`);
    }
    for (const pillar of example.pillars) {
      assertType(pillar.id, 'string', 'pillar.id');
      assertType(pillar.score, 'number', `pillar ${pillar.id}.score`);
      assertType(pillar.weight, 'number', `pillar ${pillar.id}.weight`);
      assertType(pillar.coverage, 'number', `pillar ${pillar.id}.coverage`);
      assert.ok(Array.isArray(pillar.domains), `pillar ${pillar.id}.domains must be an array`);
      assert.ok(pillarIds.includes(pillar.id), `example pillar id ${pillar.id} must be current`);
      assertInRange(pillar.score, 0, 100, `pillar ${pillar.id}.score`);
      assertInRange(pillar.weight, 0, 1, `pillar ${pillar.id}.weight`);
      assertInRange(pillar.coverage, 0, 1, `pillar ${pillar.id}.coverage`);
    }

    assert.match(skill, /updated every 6 hours/);
    assert.doesNotMatch(skill, /"scoreInterval": \{ "lower":/);
    assert.doesNotMatch(skill, /"lower"\s*:/);
    assert.doesNotMatch(skill, /"upper"\s*:/);
    assert.doesNotMatch(skill, /LOW` \/ `MODERATE` \/ `HIGH`/);
    assert.doesNotMatch(skill, /VERY_HIGH/);

    for (const domainId of domainIds) {
      assert.ok(skill.includes(`\`${domainId}\``), `missing domain id ${domainId}`);
    }
    for (const pillarId of pillarIds) {
      assert.ok(skill.includes(`\`${pillarId}\``), `missing pillar id ${pillarId}`);
    }
  });
});

// Parser-contract tests for parseFrontmatter(). The previous hand-rolled
// parser matched `\n---` anywhere, so a body line beginning with `---`
// silently truncated the frontmatter. It also split on the first colon
// without YAML semantics, so quoted-colon values became brittle. Lock in
// the replacement's semantics so future edits don't regress either.
describe('agent-skills index: frontmatter parser', () => {
  it('closing fence must be on its own line (body `---` does not terminate)', () => {
    const md = [
      '---',
      'name: demo',
      'description: covers body that starts with three dashes',
      '---',
      '',
      '--- this dash line is body text, not a fence ---',
      'More body.',
    ].join('\n');
    const fm = parseFrontmatter(md);
    assert.equal(fm.name, 'demo');
    assert.equal(fm.description, 'covers body that starts with three dashes');
  });

  it('values containing colons are preserved (not truncated)', () => {
    const md = [
      '---',
      'name: demo',
      'description: "Retrieve X: the composite value at a point in time"',
      '---',
      '',
      'body',
    ].join('\n');
    const fm = parseFrontmatter(md);
    assert.equal(
      fm.description,
      'Retrieve X: the composite value at a point in time',
    );
  });

  it('rejects non-mapping frontmatter (e.g. a YAML list)', () => {
    const md = ['---', '- a', '- b', '---', '', 'body'].join('\n');
    assert.throws(() => parseFrontmatter(md), /YAML mapping/);
  });

  it('returns empty object when no frontmatter present', () => {
    assert.deepEqual(parseFrontmatter('# Just a markdown heading\n'), {});
  });
});
