// Guards the Claude directory plugin bundle in claude-plugin/.
//
// The directory scans that folder on every push to the tracked branch and
// serves passing versions to installed users, so a renamed MCP tool or a
// changed access class would ship a skill that tells Claude to call a tool
// that no longer exists, or misstates which account can use it. This test
// pins each skill's Tools table to the live registry and keeps the bundle
// inside the directory's automated rules (no executables, no env
// credentials, connector URL equal to the registry's published remote).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_REGISTRY, toolAccess } from '../api/mcp/registry/index.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = join(ROOT, 'claude-plugin');
const SKILLS = join(PLUGIN, 'skills');

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, 'SKILL.md must start with YAML front matter');
  return Object.fromEntries(
    match[1].split('\n').map((line) => {
      const idx = line.indexOf(':');
      return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
    }),
  );
}

function toolsTable(text) {
  const section = /## Tools\n\n([\s\S]*?)\n\n/.exec(text);
  assert.ok(section, 'SKILL.md must have a "## Tools" table');
  return section[1]
    .split('\n')
    .slice(2)
    .map((row) => row.split('|').map((cell) => cell.trim()).filter(Boolean))
    .map(([tool, access]) => ({ tool: tool.replaceAll('`', ''), access }));
}

const skillDirs = readdirSync(SKILLS).filter((name) => statSync(join(SKILLS, name)).isDirectory());
const toolsByName = new Map(TOOL_REGISTRY.map((tool) => [tool.name, tool]));

describe('claude-plugin bundle', () => {
  it('manifest names the plugin, its license and an existing square icon', () => {
    const manifest = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin/plugin.json'), 'utf8'));
    assert.equal(manifest.name, 'worldmonitor');
    assert.equal(manifest.license, 'AGPL-3.0-only');
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    assert.ok(existsSync(join(PLUGIN, '.claude-plugin/icon.png')), 'icon.png is read once, at first portal save');
  });

  it('declares exactly the connector URL the MCP registry publishes', () => {
    const mcp = JSON.parse(readFileSync(join(PLUGIN, '.mcp.json'), 'utf8'));
    const registryRemote = JSON.parse(readFileSync(join(ROOT, 'server.json'), 'utf8')).remotes[0].url;
    assert.deepEqual(mcp, { mcpServers: { worldmonitor: { type: 'http', url: registryRemote } } });
  });

  it('ships only manifest, connector config, README, icon and skills', () => {
    const files = walk(PLUGIN).map((file) => relative(PLUGIN, file)).sort();
    for (const file of files) {
      assert.match(
        file,
        /^(\.claude-plugin\/(plugin\.json|icon\.png)|\.mcp\.json|README\.md|skills\/[a-z0-9-]+\/SKILL\.md)$/,
        `unexpected file in the directory bundle: ${file}`,
      );
    }
  });

  it('README meets the directory minimum of 40 words outside code blocks', () => {
    const prose = readFileSync(join(PLUGIN, 'README.md'), 'utf8').replace(/```[\s\S]*?```/g, '');
    assert.ok(prose.split(/\s+/).filter(Boolean).length >= 40);
  });

  it('never reads or embeds a credential', () => {
    for (const file of walk(PLUGIN).filter((f) => /\.(md|json)$/.test(f))) {
      const text = readFileSync(file, 'utf8');
      assert.doesNotMatch(text, /\$\{?[A-Z_]*(KEY|TOKEN|SECRET)/, `${relative(ROOT, file)} reads an env credential`);
      assert.doesNotMatch(text, /X-WorldMonitor-Key|\bwm_[0-9a-f]{8,}/, `${relative(ROOT, file)} embeds an API key`);
    }
  });

  it('has skills', () => {
    assert.ok(skillDirs.length > 0);
  });

  for (const dir of skillDirs) {
    describe(`skill ${dir}`, () => {
      const text = readFileSync(join(SKILLS, dir, 'SKILL.md'), 'utf8');

      it('front matter name matches its folder and has a description', () => {
        const fm = frontmatter(text);
        assert.equal(fm.name, dir);
        assert.ok(fm.description && fm.description.length > 40);
      });

      it('lists only live tools with their current access class', () => {
        const rows = toolsTable(text);
        assert.ok(rows.length > 0);
        for (const { tool, access } of rows) {
          const def = toolsByName.get(tool);
          assert.ok(def, `${dir} names unknown MCP tool ${tool}`);
          assert.equal(access, toolAccess(def), `${dir}: ${tool} access class changed`);
        }
      });

      it('mentions no tool missing from its Tools table', () => {
        const listed = new Set(toolsTable(text).map((row) => row.tool));
        const mentioned = new Set([...text.matchAll(/`((?:get|open|search|describe)_[a-z_]+)`/g)].map((m) => m[1]));
        for (const tool of mentioned) assert.ok(listed.has(tool), `${dir} mentions ${tool} outside its Tools table`);
      });
    });
  }
});
