/**
 * Roundtrip + edge-case tests for the Route Explorer URL state module.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseExplorerUrl,
  serializeExplorerUrl,
  DEFAULT_EXPLORER_STATE,
  type ExplorerUrlState,
} from '../src/components/RouteExplorer/url-state.ts';

describe('parseExplorerUrl', () => {
  it('returns defaults for empty search string', () => {
    const out = parseExplorerUrl('');
    assert.deepEqual(out, DEFAULT_EXPLORER_STATE);
  });

  it('returns defaults when explorer param is missing', () => {
    const out = parseExplorerUrl('?other=value');
    assert.deepEqual(out, DEFAULT_EXPLORER_STATE);
  });

  it('parses a complete state string', () => {
    const out = parseExplorerUrl('?explorer=from:CN,to:DE,hs:85,cargo:container,tab:2');
    assert.deepEqual(out, {
      fromIso2: 'CN',
      toIso2: 'DE',
      hs2: '85',
      cargo: 'container',
      tab: 2,
    });
  });

  it('uppercases ISO2 codes', () => {
    const out = parseExplorerUrl('?explorer=from:cn,to:de');
    assert.equal(out.fromIso2, 'CN');
    assert.equal(out.toIso2, 'DE');
  });

  it('lowercases cargo type', () => {
    const out = parseExplorerUrl('?explorer=cargo:CONTAINER');
    assert.equal(out.cargo, 'container');
  });

  it('drops invalid ISO2 codes silently', () => {
    const out = parseExplorerUrl('?explorer=from:USA,to:1');
    assert.equal(out.fromIso2, null);
    assert.equal(out.toIso2, null);
  });

  it('drops invalid HS2 codes silently', () => {
    const out = parseExplorerUrl('?explorer=hs:abc');
    assert.equal(out.hs2, null);
  });

  it('drops invalid cargo type silently', () => {
    const out = parseExplorerUrl('?explorer=cargo:rocket');
    assert.equal(out.cargo, null);
  });

  it('drops invalid tab silently', () => {
    const out = parseExplorerUrl('?explorer=tab:99');
    assert.equal(out.tab, 1);
  });

  it('accepts partial state', () => {
    const out = parseExplorerUrl('?explorer=from:CN,hs:27');
    assert.equal(out.fromIso2, 'CN');
    assert.equal(out.toIso2, null);
    assert.equal(out.hs2, '27');
    assert.equal(out.cargo, null);
    assert.equal(out.tab, 1);
  });

  it('does not throw on malformed param', () => {
    const out = parseExplorerUrl('?explorer=garbage:::');
    assert.deepEqual(out, DEFAULT_EXPLORER_STATE);
  });
});

describe('serializeExplorerUrl', () => {
  it('returns null for default state', () => {
    assert.equal(serializeExplorerUrl(DEFAULT_EXPLORER_STATE), null);
  });

  it('serializes complete state', () => {
    const state: ExplorerUrlState = {
      fromIso2: 'CN',
      toIso2: 'DE',
      hs2: '85',
      cargo: 'container',
      tab: 2,
    };
    assert.equal(serializeExplorerUrl(state), 'from:CN,to:DE,hs:85,cargo:container,tab:2');
  });

  it('omits tab=1 from output', () => {
    const state: ExplorerUrlState = { ...DEFAULT_EXPLORER_STATE, fromIso2: 'CN', tab: 1 };
    assert.equal(serializeExplorerUrl(state), 'from:CN');
  });

  it('omits null fields', () => {
    const state: ExplorerUrlState = { ...DEFAULT_EXPLORER_STATE, fromIso2: 'CN', hs2: '85' };
    assert.equal(serializeExplorerUrl(state), 'from:CN,hs:85');
  });
});

describe('roundtrip', () => {
  const cases: ExplorerUrlState[] = [
    { fromIso2: 'CN', toIso2: 'DE', hs2: '85', cargo: 'container', tab: 1 },
    { fromIso2: 'IR', toIso2: 'CN', hs2: '27', cargo: 'tanker', tab: 3 },
    { fromIso2: null, toIso2: null, hs2: '10', cargo: 'bulk', tab: 4 },
    { fromIso2: 'BR', toIso2: 'NL', hs2: null, cargo: null, tab: 2 },
  ];

  for (const state of cases) {
    it(`roundtrips ${JSON.stringify(state)}`, () => {
      const serialized = serializeExplorerUrl(state);
      assert.ok(serialized, 'expected non-null serialization');
      const parsed = parseExplorerUrl(`?explorer=${serialized}`);
      assert.deepEqual(parsed, state);
    });
  }
});
