// Extract curated-command tables from the four CLI/SDK surfaces for parity checks.
// Canonical source: cli/src/core.mjs CURATED_COMMANDS.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CURATED_COMMANDS } from '../cli/src/core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

/** @typedef {{ command: string, tool: string, requiredArgs: string[] }} CuratedEntry */

/**
 * @returns {Map<string, CuratedEntry>}
 */
export function extractCliCuratedCommands() {
  /** @type {Map<string, CuratedEntry>} */
  const table = new Map();
  for (const [command, spec] of Object.entries(CURATED_COMMANDS)) {
    table.set(command, {
      command,
      tool: spec.tool,
      requiredArgs: spec.args.filter((arg) => arg.required).map((arg) => arg.name),
    });
  }
  return table;
}

/**
 * @param {string} source
 * @returns {Map<string, CuratedEntry>}
 */
export function extractPythonCuratedCommands(source) {
  const section = sliceSection(source, '# -- curated helpers', '# -- plumbing');
  /** @type {Map<string, CuratedEntry>} */
  const table = new Map();
  const pattern = /def (\w+)\(self(?:, ([^)]*))?\):\s*(?:\n\s+"""[^"]*""")?\s*\n\s+return self\.call_tool\("([^"]+)"/g;
  for (const match of section.matchAll(pattern)) {
    const [, method, params = '', tool] = match;
    const command = methodToCommand(method, tool);
    table.set(command, {
      command,
      tool,
      requiredArgs: parsePythonRequiredArgs(params),
    });
  }
  return table;
}

/**
 * @param {string} source
 * @returns {Map<string, CuratedEntry>}
 */
export function extractRubyCuratedCommands(source) {
  const section = sliceSection(source, '# -- curated helpers', '# -- body decoding');
  /** @type {Map<string, CuratedEntry>} */
  const table = new Map();
  const pattern = /def (\w+)(?:\(([^)]*)\))?\s*\n\s*call_tool\("([^"]+)"/g;
  for (const match of section.matchAll(pattern)) {
    const [, method, params = '', tool] = match;
    const command = methodToCommand(method, tool);
    table.set(command, {
      command,
      tool,
      requiredArgs: parseRubyRequiredArgs(params),
    });
  }
  return table;
}

/**
 * @param {string} source
 * @returns {Map<string, CuratedEntry>}
 */
export function extractGoCuratedCommands(source) {
  const section = sliceSection(source, '// -- curated helpers', '// -- plumbing');
  /** @type {Map<string, CuratedEntry>} */
  const table = new Map();
  const pattern = /func \(c \*Client\) (\w+)\(ctx context\.Context(?:, ([^)]*))?\) \(json\.RawMessage, error\) \{\s*return c\.CallTool\(ctx, "([^"]+)"/g;
  for (const match of section.matchAll(pattern)) {
    const [, method, params = '', tool] = match;
    const command = methodToCommand(pascalToSnake(method), tool);
    table.set(command, {
      command,
      tool,
      requiredArgs: parseGoRequiredArgs(params),
    });
  }
  return table;
}

/**
 * @param {Map<string, CuratedEntry>} canonical
 * @param {Map<string, CuratedEntry>} mirror
 * @param {string} surfaceLabel
 * @returns {string[]}
 */
export function diffCuratedTables(canonical, mirror, surfaceLabel) {
  /** @type {string[]} */
  const errors = [];
  const canonicalCommands = [...canonical.keys()].sort();
  const mirrorCommands = [...mirror.keys()].sort();

  for (const command of canonicalCommands) {
    if (!mirror.has(command)) {
      errors.push(`${surfaceLabel}: missing curated command "${command}"`);
    }
  }
  for (const command of mirrorCommands) {
    if (!canonical.has(command)) {
      errors.push(`${surfaceLabel}: unexpected curated command "${command}"`);
    }
  }

  for (const command of canonicalCommands) {
    const expected = canonical.get(command);
    const actual = mirror.get(command);
    if (!expected || !actual) continue;
    if (actual.tool !== expected.tool) {
      errors.push(
        `${surfaceLabel}: command "${command}" maps to tool "${actual.tool}", expected "${expected.tool}"`,
      );
    }
    if (!sameStringArray(actual.requiredArgs, expected.requiredArgs)) {
      errors.push(
        `${surfaceLabel}: command "${command}" required args ${formatArgs(actual.requiredArgs)} `
          + `!= canonical ${formatArgs(expected.requiredArgs)}`,
      );
    }
  }

  return errors;
}

export function loadSurfaceTables() {
  const canonical = extractCliCuratedCommands();
  const python = extractPythonCuratedCommands(
    readFileSync(resolve(repoRoot, 'sdk/python/src/worldmonitor_sdk/__init__.py'), 'utf8'),
  );
  const ruby = extractRubyCuratedCommands(
    readFileSync(resolve(repoRoot, 'sdk/ruby/lib/worldmonitor.rb'), 'utf8'),
  );
  const go = extractGoCuratedCommands(
    readFileSync(resolve(repoRoot, 'sdk/go/worldmonitor.go'), 'utf8'),
  );
  return { canonical, python, ruby, go };
}

function sliceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start === -1 || end === -1) {
    throw new Error(`Could not locate curated helper section between ${startMarker} and ${endMarker}`);
  }
  return source.slice(start, end);
}

function methodToCommand(method, tool) {
  const fromTool = tool.replace(/^get_/, '');
  if (method === fromTool) return commandFromTool(tool);
  // CLI short names intentionally diverge from helper method names.
  const byMethod = {
    world_brief: 'world',
    country_brief: 'country',
    country_risk: 'risk',
    market_data: 'markets',
    conflict_events: 'conflicts',
    cyber_threats: 'cyber',
    news_intelligence: 'news',
    natural_disasters: 'disasters',
    sanctions_data: 'sanctions',
    forecast_predictions: 'forecasts',
    maritime_activity: 'maritime',
  };
  if (byMethod[method]) return byMethod[method];
  throw new Error(`Unknown curated helper method "${method}" for tool "${tool}"`);
}

function commandFromTool(tool) {
  const inverse = {
    get_world_brief: 'world',
    get_country_brief: 'country',
    get_country_risk: 'risk',
    get_market_data: 'markets',
    get_conflict_events: 'conflicts',
    get_cyber_threats: 'cyber',
    get_news_intelligence: 'news',
    get_natural_disasters: 'disasters',
    get_sanctions_data: 'sanctions',
    get_forecast_predictions: 'forecasts',
    get_maritime_activity: 'maritime',
  };
  if (!inverse[tool]) throw new Error(`Unknown curated tool "${tool}"`);
  return inverse[tool];
}

function parsePythonRequiredArgs(params) {
  const trimmed = params.trim();
  if (!trimmed || trimmed === '**args') return [];
  const names = trimmed
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith('**'))
    .map((part) => part.split('=')[0].trim());
  return names;
}

function parseRubyRequiredArgs(params) {
  const trimmed = params.trim();
  if (!trimmed || trimmed === 'args = {}') return [];
  const names = trimmed
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith('args'))
    .map((part) => part.split('=')[0].trim());
  return names.map(rubyToSnakeArg);
}

function parseGoRequiredArgs(params) {
  const trimmed = params.trim();
  if (!trimmed || trimmed === 'args Args') return [];
  const names = trimmed
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part && part !== 'args Args')
    .map((part) => part.split(' ')[0].trim());
  return names.map(goToSnakeArg);
}

function rubyToSnakeArg(name) {
  return name;
}

function goToSnakeArg(name) {
  return name.replace(/[A-Z]/g, (letter, index) => (index === 0 ? letter.toLowerCase() : `_${letter.toLowerCase()}`));
}

function pascalToSnake(name) {
  return name.replace(/[A-Z]/g, (letter, index) => (index === 0 ? letter.toLowerCase() : `_${letter.toLowerCase()}`));
}

function sameStringArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function formatArgs(args) {
  return `[${args.join(', ')}]`;
}
