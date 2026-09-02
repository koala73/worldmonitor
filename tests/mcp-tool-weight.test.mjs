// Drift guard named by api/mcp/types.ts::_weight.
//
// The shared API-tier budget charges 1 for a cache read, 2 for one downstream
// fetch, and 1 + N when a tool's execution fans out to N signed fetches. The
// class default in `toolWeight` covers the first two; a tool that fetches more
// must publish `_weight`. A later second fetch that forgets the override would
// keep billing 2 while every named-example test stayed green.
//
// The fan-out is therefore DERIVED from each execution function rather than
// listed. The first version of that deriver read only the `_execute` body, so
// a fetch signed inside a module-level helper was invisible: 14 of the 41
// `_execute` tools scored 0, and publishing the CORRECT weight on one of them
// made this file fail, demanding the wrong one. The deriver now resolves those
// helpers out of the registry sources.
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { TOOL_REGISTRY, toolWeight } from '../api/mcp/registry/index.ts';

const REGISTRY_DIR = fileURLToPath(new URL('../api/mcp/registry/', import.meta.url));

/** Occurrences of a `fetch(` call in a chunk of source. */
const countFetch = (src) => (src.match(/\bfetch\s*\(/g) ?? []).length;

/** Occurrences of `name(` — how many times a source calls a named helper. */
const countCalls = (src, name) => (src.match(new RegExp(`\\b${name}\\s*\\(`, 'g')) ?? []).length;

/**
 * The body of the function whose declaration starts at `start`.
 *
 * Walks the parameter list first, then skips any `<…>` return-type annotation,
 * so a destructured parameter (`({ a })`) or a generic return type
 * (`Promise<{ a: number }>`) is not mistaken for the opening brace.
 */
function declarationBody(src, start) {
  let i = src.indexOf('(', start);
  if (i === -1) return '';
  let parens = 0;
  for (; i < src.length; i += 1) {
    if (src[i] === '(') parens += 1;
    else if (src[i] === ')') {
      parens -= 1;
      if (parens === 0) { i += 1; break; }
    }
  }
  let angle = 0;
  for (; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '<') angle += 1;
    else if (ch === '>') angle = Math.max(0, angle - 1);
    else if (ch === '{' && angle === 0) break;
  }
  if (src[i] !== '{') return '';
  let depth = 0;
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(i, j + 1);
    }
  }
  return '';
}

const DECLARATION = new RegExp(
  '^(?:export\\s+)?(?:async\\s+)?function\\s+([A-Za-z_$][\\w$]*)\\s*[(<]'
  + '|^(?:export\\s+)?const\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:async\\s*)?[(<]',
  'gm',
);

/**
 * Module-level registry helpers that sign a downstream fetch, mapped to how
 * many signed fetches each performs.
 *
 * `_execute` reaches this file as a transpiled closure, so a helper it calls is
 * only a bare identifier in its source — there is nothing to introspect. The
 * helper's own body has to come off disk. Iterated to a fixed point so a helper
 * that delegates to another helper is counted once, not dropped.
 */
function collectSigningHelpers(dir = REGISTRY_DIR) {
  const declarations = new Map();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(new URL(file, `file://${dir}`), 'utf8');
    DECLARATION.lastIndex = 0;
    let match;
    while ((match = DECLARATION.exec(src)) !== null) {
      const name = match[1] ?? match[2];
      const body = declarationBody(src, match.index);
      if (body) declarations.set(name, body);
    }
  }
  const helpers = new Map();
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    for (const [name, body] of declarations) {
      if (!body.includes('buildAuthHeaders')) continue;
      let fan = countFetch(body);
      for (const [other, otherFan] of helpers) {
        if (other !== name) fan += countCalls(body, other) * otherFan;
      }
      if (fan > 0 && helpers.get(name) !== fan) {
        helpers.set(name, fan);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return helpers;
}

const SIGNING_HELPERS = collectSigningHelpers();

/**
 * Authenticated downstream fan-out of one `_execute` body: every `fetch(` the
 * function signs itself, plus every signed fetch it delegates to a helper.
 *
 * Published weight is `1 + fan-out` (the MCP call plus each signed fetch), so a
 * second fetch — direct or delegated — must set `_weight: 3`.
 */
function authenticatedFanOut(execute, helpers = SIGNING_HELPERS) {
  const src = Function.prototype.toString.call(execute);
  let total = src.includes('buildAuthHeaders') ? countFetch(src) : 0;
  for (const [name, fan] of helpers) {
    total += countCalls(src, name) * fan;
  }
  return total;
}

function isPositiveInt(value) {
  return Number.isInteger(value) && value >= 1;
}

describe('fan-out matcher', () => {
  it('counts each fetch in a function that also signs', () => {
    async function twoFetches() {
      const buildAuthHeaders = async () => ({});
      await buildAuthHeaders();
      await fetch('https://example.test/a');
      await fetch('https://example.test/b');
    }
    assert.equal(authenticatedFanOut(twoFetches, new Map()), 2);
  });

  it('ignores fetch in a function that never signs', () => {
    async function unsigned() {
      await fetch('https://example.test/a');
      await fetch('https://example.test/b');
    }
    assert.equal(authenticatedFanOut(unsigned, new Map()), 0);
  });

  it('resolves a signed fetch made through a module-level helper', () => {
    // The blind spot: this body signs nothing and calls no fetch, so the
    // body-only deriver scored it 0 and billed it the class default.
    // The helpers are declared inside each fixture so the file stays lint-clean;
    // only the CALL sites are what the matcher reads.
    const helpers = new Map([['fetchDigest', 1]]);
    async function delegating() {
      const fetchDigest = async () => ({});
      return fetchDigest('https://example.test/a');
    }
    assert.equal(authenticatedFanOut(delegating, helpers), 1);
  });

  it('counts a helper once per call site, and adds it to direct fetches', () => {
    const helpers = new Map([['fetchDigest', 1]]);
    async function mixed() {
      const buildAuthHeaders = async () => ({});
      const fetchDigest = async () => ({});
      await buildAuthHeaders();
      await fetch('https://example.test/a');
      await fetchDigest('https://example.test/b');
      await fetchDigest('https://example.test/c');
    }
    assert.equal(authenticatedFanOut(mixed, helpers), 3);
  });

  it('multiplies by the helper\'s own fan-out', () => {
    const helpers = new Map([['fetchPair', 2]]);
    async function delegating() {
      const fetchPair = async () => ({});
      return fetchPair('https://example.test/a');
    }
    assert.equal(authenticatedFanOut(delegating, helpers), 2);
  });

  it('does not match a helper name that is only a substring', () => {
    const helpers = new Map([['fetchDigest', 1]]);
    async function unrelated() {
      const prefetchDigest = async () => ({});
      return prefetchDigest('https://example.test/a');
    }
    assert.equal(authenticatedFanOut(unrelated, helpers), 0);
  });
});

describe('signing-helper collection', () => {
  it('finds the registry helper that signs on its callers\' behalf', () => {
    // Named explicitly so a rename, a move, or an inlining that silently
    // returns the deriver to body-only reads this file as a failure rather
    // than as fourteen tools quietly scoring zero again.
    assert.equal(
      SIGNING_HELPERS.get('fetchNlpDigestItems'),
      1,
      `fetchNlpDigestItems must resolve to one signed fetch; collected: ${JSON.stringify([...SIGNING_HELPERS])}`,
    );
  });

  it('the helpers it finds actually change a real tool\'s derived fan-out', () => {
    // Without helper resolution both of these scored 0 while genuinely making
    // one signed downstream fetch each.
    for (const name of ['extract_entities', 'get_news_clusters']) {
      const tool = TOOL_REGISTRY.find((candidate) => candidate.name === name);
      assert.ok(tool, `${name} must exist in the registry`);
      assert.equal(authenticatedFanOut(tool._execute, new Map()), 0, `${name} signs nothing in its own body`);
      assert.equal(authenticatedFanOut(tool._execute), 1, `${name} fetches once through a helper`);
    }
  });
});

describe('toolWeight class defaults', () => {
  it('a cache tool (no _execute) charges 1', () => {
    assert.equal(toolWeight({ name: 'cache_example' }), 1);
  });

  it('an execution tool charges 2', () => {
    assert.equal(toolWeight({ name: 'rpc_example', _execute: async () => ({}) }), 2);
  });

  it('an explicit _weight overrides the class default', () => {
    assert.equal(toolWeight({ name: 'cache_override', _weight: 4 }), 4);
    assert.equal(
      toolWeight({ name: 'rpc_override', _execute: async () => ({}), _weight: 3 }),
      3,
    );
  });
});

describe('registry class defaults match the published table', () => {
  const cacheTools = TOOL_REGISTRY.filter((tool) => typeof tool._execute !== 'function');
  const executeTools = TOOL_REGISTRY.filter((tool) => typeof tool._execute === 'function');

  it('every cache tool without an override bills 1', () => {
    assert.ok(cacheTools.length >= 20, 'cache-tool floor: the catalog did not vanish');
    for (const tool of cacheTools) {
      if (tool._weight !== undefined) continue;
      assert.equal(toolWeight(tool), 1, `${tool.name} is a cache read and must bill 1`);
    }
  });

  it('every execution tool without an override bills 2', () => {
    assert.ok(executeTools.length >= 20, 'execution-tool floor: the catalog did not vanish');
    for (const tool of executeTools) {
      if (tool._weight !== undefined) continue;
      assert.equal(toolWeight(tool), 2, `${tool.name} is an _execute tool and must bill 2`);
    }
  });
});

/** The rule both published-override checks apply, so they cannot disagree. */
function assertOverrideMatchesFanOut(tool, helpers = SIGNING_HELPERS) {
  assert.ok(
    isPositiveInt(tool._weight),
    `${tool.name}._weight must be a positive integer, got ${JSON.stringify(tool._weight)}`,
  );
  assert.equal(
    typeof tool._execute,
    'function',
    `${tool.name} publishes _weight but has no _execute — cache tools use the class default`,
  );
  const fanOut = authenticatedFanOut(tool._execute, helpers);
  assert.equal(
    tool._weight,
    1 + fanOut,
    `${tool.name}._weight is ${tool._weight} but its _execute signs ${fanOut} fetch(es), `
      + 'directly or through a helper; the override must be 1 + that fan-out',
  );
  assert.equal(toolWeight(tool), tool._weight);
}

describe('explicit _weight values', () => {
  it('every published override is a positive integer matching 1 + derived fan-out', () => {
    const overrides = TOOL_REGISTRY.filter((tool) => tool._weight !== undefined);
    assert.ok(
      overrides.length >= 2,
      'the two double-fetch tools must keep publishing _weight; do not delete the overrides to silence this',
    );
    for (const tool of overrides) assertOverrideMatchesFanOut(tool);
  });

  it('a CORRECT override on a helper-delegating tool is accepted', () => {
    // The second half of the old defect. A tool that signs nothing itself and
    // delegates twice genuinely costs 3, and publishing 3 was rejected with
    // "must be 1" — so the only way to satisfy the guard was to UNDER-bill.
    const helpers = new Map([['fetchDigest', 1]]);
    assertOverrideMatchesFanOut({
      name: 'delegating_double',
      _weight: 3,
      _execute: async () => {
        const fetchDigest = async () => ({});
        await fetchDigest('https://example.test/a');
        await fetchDigest('https://example.test/b');
      },
    }, helpers);
  });

  it('an under-billing override on the same tool is still rejected', () => {
    const helpers = new Map([['fetchDigest', 1]]);
    assert.throws(() => assertOverrideMatchesFanOut({
      name: 'delegating_double',
      _weight: 1,
      _execute: async () => {
        const fetchDigest = async () => ({});
        await fetchDigest('https://example.test/a');
        await fetchDigest('https://example.test/b');
      },
    }, helpers), /must be 1 \+ that fan-out/);
  });
});

describe('derived downstream fan-out', () => {
  it('a second authenticated fetch in _execute requires the matching weight override', () => {
    const multiFetch = [];
    for (const tool of TOOL_REGISTRY) {
      if (typeof tool._execute !== 'function') continue;
      const fanOut = authenticatedFanOut(tool._execute);
      if (fanOut < 2) continue;
      multiFetch.push({ name: tool.name, fanOut, weight: tool._weight });
      assert.ok(
        isPositiveInt(tool._weight),
        `${tool.name} fetches ${fanOut} times but has no _weight override — `
          + `it would bill ${toolWeight(tool)} instead of ${1 + fanOut}`,
      );
      assert.equal(
        tool._weight,
        1 + fanOut,
        `${tool.name} fetches ${fanOut} times so _weight must be ${1 + fanOut}`,
      );
      assert.equal(toolWeight(tool), 1 + fanOut);
    }
    assert.ok(
      multiFetch.length >= 2,
      `expected get_country_brief and get_airspace to derive as multi-fetch, found ${JSON.stringify(multiFetch)}`,
    );
    assert.deepEqual(
      multiFetch.map((row) => row.name).sort(),
      ['get_airspace', 'get_country_brief'],
      'the multi-fetch set drifted — add the new tool\'s _weight or fix the fan-out matcher',
    );
  });
});
