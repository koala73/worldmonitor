// Parity guard for the curated command table copied across four surfaces:
//   - cli/src/core.mjs (canonical CURATED_COMMANDS)
//   - sdk/python/src/worldmonitor_sdk/__init__.py
//   - sdk/ruby/lib/worldmonitor.rb
//   - sdk/go/worldmonitor.go
//
// Issue #7125 — the table is hand-maintained on each surface; this test fails
// when command names, MCP tool mappings, or required positional args drift.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  diffCuratedTables,
  extractCliCuratedCommands,
  extractGoCuratedCommands,
  extractPythonCuratedCommands,
  extractRubyCuratedCommands,
  loadSurfaceTables,
} from '../scripts/extract-curated-command-surfaces.mjs';

const SURFACES = [
  ['python', (tables) => tables.python],
  ['ruby', (tables) => tables.ruby],
  ['go', (tables) => tables.go],
];

describe('cli curated commands parity (#7125)', () => {
  it('keeps every SDK surface aligned with cli/src/core.mjs CURATED_COMMANDS', () => {
    const tables = loadSurfaceTables();
    assert.ok(tables.canonical.size > 0, 'canonical curated command table must not be empty');

    for (const [label, pick] of SURFACES) {
      const errors = diffCuratedTables(tables.canonical, pick(tables), label);
      assert.deepEqual(
        errors,
        [],
        `${label} curated command table drifted from the CLI canonical table:\n${errors.join('\n')}`,
      );
    }
  });
});

describe('cli curated commands parity meta-tests — positive controls', () => {
  it('diffCuratedTables catches a missing command', () => {
    const canonical = extractCliCuratedCommands();
    const mirror = new Map(canonical);
    mirror.delete('risk');
    const errors = diffCuratedTables(canonical, mirror, 'synthetic');
    assert.ok(errors.some((error) => error.includes('missing curated command "risk"')));
  });

  it('diffCuratedTables catches an unexpected extra command', () => {
    const canonical = extractCliCuratedCommands();
    const mirror = new Map(canonical);
    mirror.set('ghost', { command: 'ghost', tool: 'get_ghost', requiredArgs: [] });
    const errors = diffCuratedTables(canonical, mirror, 'synthetic');
    assert.ok(errors.some((error) => error.includes('unexpected curated command "ghost"')));
  });

  it('diffCuratedTables catches a tool-name mismatch', () => {
    const canonical = extractCliCuratedCommands();
    const mirror = new Map(canonical);
    const risk = mirror.get('risk');
    mirror.set('risk', { ...risk, tool: 'get_country_risk_v2' });
    const errors = diffCuratedTables(canonical, mirror, 'synthetic');
    assert.ok(errors.some((error) => error.includes('maps to tool "get_country_risk_v2"')));
  });

  it('diffCuratedTables catches a required-arg mismatch', () => {
    const canonical = extractCliCuratedCommands();
    const mirror = new Map(canonical);
    const world = mirror.get('world');
    mirror.set('world', { ...world, requiredArgs: ['country_code'] });
    const errors = diffCuratedTables(canonical, mirror, 'synthetic');
    assert.ok(errors.some((error) => error.includes('command "world" required args')));
  });

  it('extractors parse the live SDK helper sections', () => {
    const tables = loadSurfaceTables();
    assert.equal(tables.canonical.size, tables.python.size);
    assert.equal(tables.canonical.size, tables.ruby.size);
    assert.equal(tables.canonical.size, tables.go.size);
  });

  it('extractPythonCuratedCommands fails on an induced tool rename', () => {
    const source = `
# -- curated helpers
def country_risk(self, country_code, **args):
    return self.call_tool("get_country_risk_v2", args, country_code=country_code)
# -- plumbing
`;
    const mirror = extractPythonCuratedCommands(source);
    const errors = diffCuratedTables(extractCliCuratedCommands(), mirror, 'python-fixture');
    assert.ok(errors.some((error) => error.includes('get_country_risk_v2')));
  });

  it('extractRubyCuratedCommands fails on an induced missing required arg', () => {
    const source = `
# -- curated helpers
def country_risk(args = {})
  call_tool("get_country_risk", args)
# -- body decoding
`;
    const mirror = extractRubyCuratedCommands(source);
    const errors = diffCuratedTables(extractCliCuratedCommands(), mirror, 'ruby-fixture');
    assert.ok(errors.some((error) => error.includes('command "risk" required args')));
  });

  it('extractPythonCuratedCommands treats a defaulted parameter as optional', () => {
    const source = `
# -- curated helpers
def country_risk(self, country_code=None, **args):
    return self.call_tool("get_country_risk", args, country_code=country_code)
# -- plumbing
`;
    const mirror = extractPythonCuratedCommands(source);
    const errors = diffCuratedTables(extractCliCuratedCommands(), mirror, 'python-fixture');
    assert.ok(errors.some((error) => error.includes('command "risk" required args []')));
  });

  it('extractRubyCuratedCommands treats a defaulted parameter as optional', () => {
    const source = `
# -- curated helpers
def country_risk(country_code = nil, args = {})
  call_tool("get_country_risk", args.merge(country_code: country_code))
end
# -- body decoding
`;
    const mirror = extractRubyCuratedCommands(source);
    const errors = diffCuratedTables(extractCliCuratedCommands(), mirror, 'ruby-fixture');
    assert.ok(errors.some((error) => error.includes('command "risk" required args []')));
  });

  it('extractPythonCuratedCommands fails when a required arg is not forwarded', () => {
    const source = `
# -- curated helpers
def country_risk(self, country_code, **args):
    return self.call_tool("get_country_risk", args)
# -- plumbing
`;
    const mirror = extractPythonCuratedCommands(source);
    const errors = diffCuratedTables(extractCliCuratedCommands(), mirror, 'python-fixture');
    assert.ok(errors.some((error) => error.includes('command "risk" forwards required args []')));
  });

  it('extractRubyCuratedCommands fails when a required arg is not forwarded', () => {
    const source = `
# -- curated helpers
def country_risk(country_code, args = {})
  call_tool("get_country_risk", args)
end
# -- body decoding
`;
    const mirror = extractRubyCuratedCommands(source);
    const errors = diffCuratedTables(extractCliCuratedCommands(), mirror, 'ruby-fixture');
    assert.ok(errors.some((error) => error.includes('command "risk" forwards required args []')));
  });

  it('extractGoCuratedCommands fails when a required arg is not forwarded', () => {
    const source = `
// -- curated helpers
func (c *Client) CountryRisk(ctx context.Context, countryCode string, args Args) (json.RawMessage, error) {
	return c.CallTool(ctx, "get_country_risk", args)
}
// -- plumbing
`;
    const mirror = extractGoCuratedCommands(source);
    const errors = diffCuratedTables(extractCliCuratedCommands(), mirror, 'go-fixture');
    assert.ok(errors.some((error) => error.includes('command "risk" forwards required args []')));
  });

  it('extractPythonCuratedCommands ignores an unreachable nested helper', () => {
    const source = `
# -- curated helpers
if False:
    def country_risk(self, country_code, **args):
        return self.call_tool("get_country_risk", args, country_code=country_code)
# -- plumbing
`;
    const mirror = extractPythonCuratedCommands(source);
    const errors = diffCuratedTables(extractCliCuratedCommands(), mirror, 'python-fixture');
    assert.ok(errors.some((error) => error.includes('missing curated command "risk"')));
  });

  it('extractRubyCuratedCommands ignores a helper in a block comment', () => {
    const source = `
# -- curated helpers
=begin
def country_risk(country_code, args = {})
  call_tool("get_country_risk", args.merge(country_code: country_code))
end
=end
# -- body decoding
`;
    const mirror = extractRubyCuratedCommands(source);
    const errors = diffCuratedTables(extractCliCuratedCommands(), mirror, 'ruby-fixture');
    assert.ok(errors.some((error) => error.includes('missing curated command "risk"')));
  });

  it('extractGoCuratedCommands ignores a helper in a block comment', () => {
    const source = `
// -- curated helpers
/*
func (c *Client) CountryRisk(ctx context.Context, countryCode string, args Args) (json.RawMessage, error) {
	return c.CallTool(ctx, "get_country_risk", withArg(args, "country_code", countryCode))
}
*/
// -- plumbing
`;
    const mirror = extractGoCuratedCommands(source);
    const errors = diffCuratedTables(extractCliCuratedCommands(), mirror, 'go-fixture');
    assert.ok(errors.some((error) => error.includes('missing curated command "risk"')));
  });

  it('extractGoCuratedCommands fails on an induced missing command', () => {
    const source = `
// -- curated helpers
func (c *Client) WorldBrief(ctx context.Context, args Args) (json.RawMessage, error) {
	return c.CallTool(ctx, "get_world_brief", args)
}
// -- plumbing
`;
    const mirror = extractGoCuratedCommands(source);
    const errors = diffCuratedTables(extractCliCuratedCommands(), mirror, 'go-fixture');
    assert.ok(errors.some((error) => error.includes('missing curated command')));
  });
});
