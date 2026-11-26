// Guards the Antigravity Marketplace bundle in antigravity-plugin/.
//
// The Marketplace installs that folder from
// https://github.com/koala73/worldmonitor/tree/main/antigravity-plugin, so it
// must stay a standalone plugin: only Antigravity files, the fields the
// Marketplace requires, and the same MCP-tool skills as claude-plugin/
// (whose test pins every skill's Tools table to the live tool registry).
// `agy plugin validate --strict antigravity-plugin` is the authoritative
// check; this test keeps the bundle from drifting between manual runs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = join(ROOT, 'antigravity-plugin');

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const manifest = JSON.parse(readFileSync(join(PLUGIN, 'plugin.json'), 'utf8'));

describe('antigravity-plugin bundle', () => {
  it('manifest carries every field the Marketplace requires', () => {
    assert.equal(manifest.$schema, 'https://antigravity.google/schemas/v1/plugin.json');
    assert.equal(manifest.name, 'worldmonitor');
    assert.match(manifest.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.doesNotMatch(manifest.displayName, /^(Antigravity|Gemini|Claude|Cursor)\b|\b(Plugin|MCP)$/i);
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    assert.ok(manifest.description.length >= 80 && manifest.description.length <= 160, 'description is 1-2 short sentences');
    assert.ok(Array.isArray(manifest.suggestedPrompts) && manifest.suggestedPrompts.length >= 1 && manifest.suggestedPrompts.length <= 3);
    assert.match(manifest.author.url, /^https:\/\//);
    assert.equal(manifest.license, 'AGPL-3.0-only');
  });

  it('logo is a bundled square PNG with a transparent border', () => {
    const png = readFileSync(join(PLUGIN, manifest.logo));
    assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    assert.equal(width, height, 'logo must be 1:1');
    assert.ok(width >= 128, 'logo must be at least 128px');
    assert.equal(png[25], 6, 'logo must be RGBA so its padding is transparent');
  });

  it('ships only Antigravity plugin files, none executable', () => {
    const files = walk(PLUGIN).map((file) => relative(PLUGIN, file)).sort();
    for (const file of files) {
      assert.match(file, /^(plugin\.json|mcp_config\.json|README\.md|assets\/logo\.png|skills\/[a-z0-9-]+\/SKILL\.md)$/, `unexpected file ${file}`);
      assert.equal(statSync(join(PLUGIN, file)).mode & 0o111, 0, `${file} must not be executable`);
    }
  });

  it('skills are the claude-plugin MCP-tool skills, byte for byte', () => {
    const skills = (dir) => readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory()).sort();
    const claudeSkills = join(ROOT, 'claude-plugin/skills');
    const antigravitySkills = join(PLUGIN, 'skills');
    assert.deepEqual(skills(antigravitySkills), skills(claudeSkills));
    for (const name of skills(claudeSkills)) {
      assert.equal(
        readFileSync(join(antigravitySkills, name, 'SKILL.md'), 'utf8'),
        readFileSync(join(claudeSkills, name, 'SKILL.md'), 'utf8'),
        `antigravity-plugin/skills/${name} must match claude-plugin/skills/${name}; copy it over`,
      );
    }
  });
});
