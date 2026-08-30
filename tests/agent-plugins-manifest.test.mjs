import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  materializePluginSkills,
  rewriteWellKnownSkillForPlugin,
} from '../scripts/build-agent-skills-index.mjs';
import { createTempDir } from './helpers/temp-dir.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..');
const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
const PLUGIN_FIELDS = new Set([
  '$schema',
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'extensions',
]);
const MCP_FIELDS = new Set(['$schema', 'mcpServers']);
const AUTHOR_FIELDS = new Set(['name', 'email', 'url']);
const WELL_KNOWN_SKILLS_DIR = join(ROOT, 'public/.well-known/agent-skills');
const PLUGIN_SKILLS_DIR = join(ROOT, 'skills');
const DISCOVERY_SURFACES = [
  'public/llms.txt',
  'public/llms-full.txt',
  'public/agents.md',
  'public/api/llms.txt',
  'public/developers.md',
  'public/developers/llms.txt',
  'public/agent.txt',
  'public/home.md',
  'docs/agent-discovery.mdx',
  'docs/zh/agent-discovery.mdx',
];

const plugin = JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf-8'));
const publicPlugin = readFileSync(join(ROOT, 'public/plugin.json'));
const mcp = JSON.parse(readFileSync(join(ROOT, 'mcp.json'), 'utf-8'));
const publicLlms = readFileSync(join(ROOT, 'public/llms.txt'), 'utf-8');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
const vercelConfig = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf-8'));
const serverCard = JSON.parse(
  readFileSync(join(ROOT, 'public/.well-known/mcp/server-card.json'), 'utf-8'),
);
const docsServerCard = JSON.parse(
  readFileSync(join(ROOT, 'public/.well-known/mcp/docs-server-card.json'), 'utf-8'),
);
const skillIndex = JSON.parse(
  readFileSync(join(ROOT, 'public/.well-known/agent-skills/index.json'), 'utf-8'),
);

function listSkillDirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== '.' && entry.name !== '..')
    .map((entry) => entry.name)
    .sort();
}

function assertPluginName(name) {
  assert.equal(typeof name, 'string');
  assert.ok(name.length >= 1 && name.length <= 64, `plugin name length must be 1–64, got ${name.length}`);
  assert.match(name, /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
  assert.doesNotMatch(name, /--|\.\./);
}

describe('agent readiness: Agent Plugins manifest', () => {
  it('root plugin.json is a closed Agent Plugins 1.0.0 manifest', () => {
    assert.equal(plugin.$schema, PLUGIN_SCHEMA);
    assertPluginName(plugin.name);
    for (const key of Object.keys(plugin)) {
      assert.ok(PLUGIN_FIELDS.has(key), `plugin.json has unknown top-level field "${key}"`);
    }
    assert.equal(typeof plugin.version, 'string');
    assert.equal(plugin.version, pkg.version, 'plugin.json version must match package.json');
    assert.equal(typeof plugin.description, 'string');
    assert.equal(typeof plugin.homepage, 'string');
    assert.equal(typeof plugin.repository, 'string');
    assert.equal(plugin.license, pkg.license);
    assert.ok(Array.isArray(plugin.keywords));
    assert.equal(typeof plugin.author, 'object');
    assert.ok(plugin.author);
    for (const key of Object.keys(plugin.author)) {
      assert.ok(AUTHOR_FIELDS.has(key), `plugin.json author has unknown field "${key}"`);
      assert.equal(typeof plugin.author[key], 'string');
    }
  });

  it('public/plugin.json is a byte-identical copy of the repo-root manifest', () => {
    const rootBytes = readFileSync(join(ROOT, 'plugin.json'));
    assert.equal(rootBytes.equals(publicPlugin), true, 'public/plugin.json must match plugin.json exactly');
  });

  it('mcp.json is a closed Agent Plugins MCP config pointing at the live servers', () => {
    assert.equal(mcp.$schema, MCP_SCHEMA);
    for (const key of Object.keys(mcp)) {
      assert.ok(MCP_FIELDS.has(key), `mcp.json has unknown top-level field "${key}"`);
    }
    assert.equal(typeof mcp.mcpServers, 'object');
    assert.ok(mcp.mcpServers);
    const expected = {
      worldmonitor: serverCard.url ?? serverCard.serverUrl,
      'worldmonitor-docs': docsServerCard.url ?? docsServerCard.serverUrl,
    };
    assert.deepEqual(Object.keys(mcp.mcpServers).sort(), Object.keys(expected).sort());
    for (const [name, entry] of Object.entries(mcp.mcpServers)) {
      assert.equal(entry.type, 'streamable-http', `${name} must use streamable-http`);
      assert.equal(entry.url, expected[name], `${name} URL must match the published server card`);
      assert.match(entry.url, /^https:\/\//);
      assert.equal('headers' in entry, false, `${name} must not embed headers (no portable secrets)`);
      for (const field of Object.keys(entry)) {
        assert.ok(['type', 'url'].includes(field), `${name} has unknown field "${field}"`);
      }
    }
  });

  it('describes mcp.json as part of the repository package, not the HTTP manifest', () => {
    assert.equal(existsSync(join(ROOT, 'public/mcp.json')), false);
    const mcpRoute = (vercelConfig.headers ?? []).find((rule) => rule.source === '/mcp.json');
    assert.equal(mcpRoute, undefined, 'vercel.json must not serve /mcp.json as a static Agent Plugin file');
    assert.doesNotMatch(
      publicLlms,
      /\[Agent Plugin\][^\n]*`plugin\.json` \+ `mcp\.json` \+ `skills\/`/,
      'the public /plugin.json link must not promise sibling HTTP files that only exist in the repository package',
    );
    assert.match(publicLlms, /repository package/i);
  });

  it('every well-known agent skill has a plugin skills/ SKILL.md inside the plugin root', () => {
    const wellKnown = listSkillDirs(WELL_KNOWN_SKILLS_DIR);
    const pluginSkills = listSkillDirs(PLUGIN_SKILLS_DIR);
    assert.deepEqual(
      pluginSkills,
      wellKnown,
      'skills/ must list exactly the published well-known agent skills',
    );
    assert.deepEqual(
      wellKnown,
      skillIndex.skills.map((skill) => skill.name).sort(),
      'well-known skill dirs must match the generated index',
    );
    for (const name of wellKnown) {
      const pluginSkill = join(PLUGIN_SKILLS_DIR, name, 'SKILL.md');
      const canonical = join(WELL_KNOWN_SKILLS_DIR, name, 'SKILL.md');
      assert.equal(existsSync(pluginSkill), true, `missing skills/${name}/SKILL.md`);
      const stat = lstatSync(pluginSkill);
      assert.equal(stat.isSymbolicLink(), false, `skills/${name}/SKILL.md must be a regular file, not a symlink`);
      assert.equal(stat.isFile(), true, `skills/${name}/SKILL.md must be a regular file`);
      const indexed = spawnSync('git', ['ls-files', '-s', `skills/${name}/SKILL.md`], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      assert.match(
        indexed.stdout,
        /^100644 /,
        `git must store skills/${name}/SKILL.md as a regular file (not mode 120000)`,
      );
      const body = readFileSync(pluginSkill, 'utf-8');
      assert.equal(body.startsWith('---\n'), true, `skills/${name}/SKILL.md must open with YAML frontmatter`);
      assert.equal(
        body,
        rewriteWellKnownSkillForPlugin(readFileSync(canonical, 'utf-8')),
        `skills/${name}/SKILL.md must match the well-known recipe with public-site API origin`,
      );
    }
  });

  it('prunes a deleted well-known skill and converges writer then checker', (t) => {
    const root = createTempDir('wm-plugin-skill-prune-', t);
    const skillsDir = join(root, 'public/.well-known/agent-skills');
    const pluginSkillsDir = join(root, 'skills');
    const indexPath = join(skillsDir, 'index.json');
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(pluginSkillsDir, { recursive: true });

    const keepBody = [
      '---',
      'name: keep-skill',
      'description: keep this recipe',
      '---',
      '',
      'GET https://edge.worldmonitor.app/api/keep',
      '',
    ].join('\n');
    const retiredBody = [
      '---',
      'name: retired-skill',
      'description: retire this recipe',
      '---',
      '',
      'GET https://edge.worldmonitor.app/api/retired',
      '',
    ].join('\n');

    const writeRecipe = (dir, name, body) => {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, 'SKILL.md'), body);
    };
    const writeIndex = (names) => {
      writeFileSync(indexPath, `${JSON.stringify({
        $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
        instructions: 'test',
        skills: names.map((name) => ({
          name,
          type: 'skill-md',
          description: `${name} recipe`,
          url: `https://worldmonitor.app/.well-known/agent-skills/${name}/SKILL.md`,
          digest: 'sha256:00',
        })),
      }, null, 2)}\n`);
    };

    writeRecipe(skillsDir, 'keep-skill', keepBody);
    writeRecipe(skillsDir, 'retired-skill', retiredBody);
    writeIndex(['keep-skill', 'retired-skill']);
    const paths = { skillsDir, pluginSkillsDir, indexPath };
    materializePluginSkills(paths);

    mkdirSync(join(pluginSkillsDir, 'local-scratch'), { recursive: true });
    writeFileSync(join(pluginSkillsDir, 'local-scratch', 'NOTES.md'), 'do not delete\n');
    mkdirSync(join(pluginSkillsDir, 'third-party-skill'), { recursive: true });
    writeFileSync(join(pluginSkillsDir, 'third-party-skill', 'SKILL.md'), 'local install\n');

    rmSync(join(skillsDir, 'retired-skill'), { recursive: true, force: true });

    assert.throws(
      () => materializePluginSkills({ check: true, ...paths }),
      /retired-skill/,
    );

    materializePluginSkills(paths);

    assert.equal(existsSync(join(pluginSkillsDir, 'retired-skill', 'SKILL.md')), false);
    assert.equal(existsSync(join(pluginSkillsDir, 'retired-skill')), false);
    assert.equal(
      readFileSync(join(pluginSkillsDir, 'local-scratch', 'NOTES.md'), 'utf-8'),
      'do not delete\n',
    );
    assert.equal(
      readFileSync(join(pluginSkillsDir, 'third-party-skill', 'SKILL.md'), 'utf-8'),
      'local install\n',
    );
    assert.equal(
      readFileSync(join(pluginSkillsDir, 'keep-skill', 'SKILL.md'), 'utf-8'),
      rewriteWellKnownSkillForPlugin(keepBody),
    );

    writeIndex(['keep-skill']);
    assert.doesNotThrow(() => materializePluginSkills({ check: true, ...paths }));
  });

  it('rewrites worldmonitor API subdomains to the public site origin', () => {
    assert.equal(
      rewriteWellKnownSkillForPlugin('GET https://edge.worldmonitor.app/api/foo'),
      'GET https://worldmonitor.app/api/foo',
    );
    assert.equal(
      rewriteWellKnownSkillForPlugin('GET https://worldmonitor.app/api/foo'),
      'GET https://worldmonitor.app/api/foo',
    );
    assert.equal(
      rewriteWellKnownSkillForPlugin('GET https://www.worldmonitor.app/api/foo'),
      'GET https://www.worldmonitor.app/api/foo',
    );
    assert.equal(
      rewriteWellKnownSkillForPlugin('GET https://earthquake.usgs.gov/api/foo'),
      'GET https://earthquake.usgs.gov/api/foo',
    );
  });

  it('tracks skills/*/SKILL.md while still ignoring local skills.sh extras', () => {
    const tracked = spawnSync('git', ['check-ignore', '-q', 'skills/fetch-country-brief/SKILL.md'], {
      cwd: ROOT,
    });
    assert.notEqual(tracked.status, 0, 'skills/*/SKILL.md must not be gitignored');
    const localExtra = spawnSync('git', ['check-ignore', '-q', 'skills/local-install/README.md'], {
      cwd: ROOT,
    });
    assert.equal(localExtra.status, 0, 'non-SKILL.md files under /skills/ must stay gitignored');
  });

  it('serves /plugin.json as JSON with CORS and a one-hour cache', () => {
    const rule = (vercelConfig.headers ?? []).find((entry) => entry.source === '/plugin.json');
    assert.ok(rule, 'vercel.json must set headers for /plugin.json');
    const headers = Object.fromEntries((rule.headers ?? []).map((h) => [h.key, h.value]));
    assert.equal(headers['Content-Type'], 'application/json; charset=utf-8');
    assert.equal(headers['Access-Control-Allow-Origin'], '*');
    assert.equal(headers['Cache-Control'], 'public, max-age=3600');
    assert.equal(headers.Link, '<https://www.worldmonitor.app/plugin.json>; rel="canonical"');
    const catchAll = (vercelConfig.headers ?? []).find((entry) =>
      typeof entry.source === 'string' && entry.source.includes('plugin\\.json'),
    );
    assert.ok(catchAll, 'HTML-cache catch-all must exclude /plugin.json');
  });

  it('advertises /plugin.json on every agent discovery surface', () => {
    for (const path of DISCOVERY_SURFACES) {
      const body = readFileSync(join(ROOT, path), 'utf-8');
      assert.ok(
        body.includes('https://worldmonitor.app/plugin.json') || body.includes('/plugin.json'),
        `${path} must advertise /plugin.json`,
      );
    }
    const catalog = JSON.parse(readFileSync(join(ROOT, 'public/.well-known/api-catalog'), 'utf-8'));
    const hrefs = catalog.linkset.flatMap((ctx) =>
      Object.values(ctx).flatMap((value) => (Array.isArray(value) ? value.map((entry) => entry.href) : [])),
    );
    assert.ok(hrefs.includes('https://worldmonitor.app/plugin.json'), 'api-catalog must advertise /plugin.json');
    const view = JSON.parse(readFileSync(join(ROOT, 'public/agent-view.json'), 'utf-8'));
    assert.equal(view.discovery.agentPlugin, 'https://worldmonitor.app/plugin.json');
    for (const path of ['docs/agent-discovery.mdx', 'docs/zh/agent-discovery.mdx']) {
      const body = readFileSync(join(ROOT, path), 'utf-8');
      assert.ok(
        body.includes('skills/*/SKILL.md'),
        `${path} must describe the plugin skill glob in MDX-safe form (angle-bracket placeholders render away)`,
      );
      assert.equal(
        body.includes('skills/<name>/SKILL.md'),
        false,
        `${path} must not use <name> — MDX treats it as a tag and emits skills//SKILL.md`,
      );
    }
  });
});
