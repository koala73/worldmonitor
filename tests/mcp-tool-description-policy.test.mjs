// The Claude Connectors Directory requires that "tool descriptions contain no
// instructions about model behavior, other tools, or external instruction
// sources". A description says what its own tool returns. Which tool fits
// which question, and how to treat availability flags, lives in
// SERVER_INSTRUCTIONS (api/mcp/constants.ts), which the policy does not cover.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

const { __testing__ } = await import('../api/mcp.ts');
const { SERVER_INSTRUCTIONS } = await import('../api/mcp/constants.ts');
const REGISTRY = __testing__.TOOL_REGISTRY;
const NAMES = REGISTRY.map((tool) => tool.name);

// A sentence that opens with a command to the reader, or a phrase that tells
// the model when or how to act.
const DIRECTIVE_OPENER = /^(Preserve|Prefer|Check|Always|ALWAYS|Never|NEVER|Do not|Don't|Make sure|Remember|Ensure|Treat|Use (this|it))\b/;
const DIRECTIVE_PHRASE = /\b(before quoting|before concluding|read it every time|use it instead|(read|check) \S+ first|do not (quote|cite|use|call|trust)|(read|check) \S+ on every call)\b/i;

const sentences = (text) => text.split(/(?<=[.;:])\s+/).map((s) => s.trim()).filter(Boolean);

function descriptionViolations(tool, names) {
  const found = [];
  for (const other of names) {
    if (other !== tool.name && new RegExp(`\\b${other}\\b`).test(tool.description)) found.push(`names ${other}`);
  }
  for (const s of sentences(tool.description)) {
    if (DIRECTIVE_OPENER.test(s) || DIRECTIVE_PHRASE.test(s)) found.push(`directive: "${s.slice(0, 100)}"`);
  }
  return found;
}

describe('MCP tool descriptions describe only their own tool', () => {
  it('flags the forms the directory policy forbids', () => {
    const names = ['get_a', 'get_b'];
    const check = (description) => descriptionViolations({ name: 'get_a', description }, names);
    assert.deepEqual(check('Returns rates. Use get_b for history.'), ['names get_b']);
    assert.equal(check('Returns scores; check underAudit before quoting scores.').length, 1);
    assert.equal(check('Returns prices. Preserve unavailable flags.').length, 1);
    assert.equal(check('Returns rows. Read hasScore first.').length, 1);
    assert.equal(check('Returns rows. Read coverageState on every call: degraded means partial.').length, 1);
    assert.equal(check('Returns shares. Use this to answer who supplies weapons.').length, 1);
    assert.deepEqual(check('The route embeds your query on every call.'), []);
    assert.deepEqual(check('Returns rates; underAudit marks scores still under audit.'), []);
    assert.deepEqual(check('get_a returns its own rows.'), []);
  });

  it('no registered tool description names another tool or directs the model', () => {
    const failures = REGISTRY.flatMap((tool) => descriptionViolations(tool, NAMES).map((v) => `${tool.name}: ${v}`));
    assert.deepEqual(failures, []);
  });

  // The scorecard description switches wording while an accuracy audit is
  // configured; the registry only shows whichever mode is live today.
  it('the forecast scorecard description passes in audit mode too', async () => {
    const { forecastScorecardDescription } = await import('../api/mcp/registry/cache-tools.ts');
    const audit = { since: '2026-10-07', issue: 8990, reason: 'Fixture reason.' };
    for (const configured of [null, audit]) {
      const tool = { name: 'get_forecast_scorecard', description: forecastScorecardDescription(configured) };
      assert.deepEqual(descriptionViolations(tool, NAMES), [], `audit=${Boolean(configured)}`);
    }
  });

  it('the guidance removed from descriptions is still in the server instructions', () => {
    for (const name of ['open_country_brief', 'get_country_brief', 'get_us_import_duty', 'get_tariff_averages', 'get_forecast_case', 'get_five_factor_scorecard', 'get_commodity_geo', 'get_similar_events']) {
      assert.match(SERVER_INSTRUCTIONS, new RegExp(`\\b${name}\\b`), `${name} routing must stay in SERVER_INSTRUCTIONS`);
    }
    assert.match(SERVER_INSTRUCTIONS, /upstreamUnavailable/);
  });
});
