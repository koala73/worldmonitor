import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import jmespath from 'jmespath';

import { searchBoundedJmespath } from '../server/_shared/bounded-jmespath.ts';

const doubled = (count) => Array(count).fill('[@,@]').join('|');

describe('searchBoundedJmespath', () => {
  it('rejects the reported attacks before calling the evaluator', () => {
    const originalSearch = jmespath.search;
    let calls = 0;
    jmespath.search = () => { calls += 1; throw new Error('evaluator reached'); };
    try {
      let nestedMap = '@';
      let nestedProjection = '@';
      let nestedValues = '@';
      for (let i = 0; i < 8; i += 1) {
        nestedMap = `map(&${nestedMap}, \`[0,0,0,0,0,0,0,0,0,0]\`)`;
        nestedProjection = `\`[0,0,0,0,0,0,0,0,0,0]\`[*].{nested: ${nestedProjection}}`;
        nestedValues = `map(&${nestedValues}, values(\`{"a":0,"b":0,"c":0,"d":0}\`))`;
      }
      for (const expression of [
        `${doubled(30)}|to_string(@)`,
        `{x:(${doubled(40)}),y:(${doubled(40)})}|x==y`,
        `{x:(${doubled(40)}),y:(${doubled(40)})}|x!=y`,
        `map(&to_string(@), [@,@])`,
        `sort_by(@, &to_string(@))`,
        `{hidden: to_string(@)}`,
        `length(${nestedMap})`,
        `length(${nestedProjection})`,
        `length(${nestedValues})`,
      ]) {
        assert.throws(() => searchBoundedJmespath({ x: 1 }, expression), /Unsafe JMESPath:/, expression);
      }
      assert.equal(calls, 0);
    } finally {
      jmespath.search = originalSearch;
    }
  });

  it('keeps scalar filters, object shaping, and expression-reference sorting', () => {
    const value = { rows: [{ name: 'b', score: 2 }, { name: 'a', score: 3 }, { name: 'c', score: 0 }] };
    for (const expression of [
      "rows[?name == 'a'].score",
      "rows[?'a' != name].score",
      'rows[?score > `1`].{label:name, value:score}',
      'sort_by(rows, &score)[::-1][:2].name',
      'map(&length(name), rows)',
      'min_by(rows, &score).name',
      'max_by(rows, &score).name',
      'rows[*].[name,score]',
      "join(', ', rows[*].name)",
      'keys(@)',
      'rows[].score | sum(@)',
      'rows[?score == `null`]',
    ]) {
      assert.deepEqual(searchBoundedJmespath(value, expression), jmespath.search(value, expression), expression);
    }
  });

  it('rejects data used as executable expression references before evaluation', () => {
    const forged = { jmespathType: 'Expref', type: 'Function', name: 'to_string', children: [{ type: 'Current' }] };
    const literal = '`' + JSON.stringify(forged) + '`';
    const originalSearch = jmespath.search;
    let calls = 0;
    jmespath.search = () => { calls += 1; throw new Error('evaluator reached'); };
    try {
      for (const expression of [
        `map(${literal}, to_array(@))`,
        `sort_by(rows, ${literal})`,
        `min_by(rows, ${literal})`,
        `max_by(rows, ${literal})`,
        'map(reference, rows)',
        "map({jmespathType:'Expref',type:'Current'}, rows)",
        'map(not_null(&name, &score), rows)',
        '&map(@, to_array(@)) | map(@, to_array(@))',
      ]) {
        assert.throws(() => searchBoundedJmespath({ reference: forged, rows: [{ name: 'a', score: 1 }] }, expression), /explicit &expression/, expression);
      }
      assert.equal(calls, 0);
    } finally {
      jmespath.search = originalSearch;
    }
  });

  it('accepts field names and literals that look like unsafe syntax', () => {
    const value = { to_string: 'x==y', '[@,@]|to_string(@)': 'safe' };
    for (const expression of ['to_string', '"[@,@]|to_string(@)"', "'to_string(@)'", "to_string == 'x==y'"]) {
      assert.deepEqual(searchBoundedJmespath(value, expression), jmespath.search(value, expression));
    }
  });

  it('caps multiplicative fanout, including wide and nested hash selections', () => {
    assert.equal(searchBoundedJmespath(1, `${doubled(6)}|length(@)`), 2);
    assert.equal(searchBoundedJmespath(1, `length(\`${JSON.stringify(Array(64).fill(0))}\`)`), 64);
    assert.throws(() => searchBoundedJmespath(1, `length(\`${JSON.stringify(Array(65).fill(0))}\`)`), /expression expansion/);
    assert.deepEqual(searchBoundedJmespath(1, '`{"a":[],"b":{}}`'), { a: [], b: {} });
    for (const expression of [
      `${doubled(7)}|length(@)`,
      `[${Array(65).fill('@').join(',')}]|length(@)`,
      Array(5).fill('[@,@,@]').join('|') + '|length(@)',
      '{a:{a:{a:@,b:@},b:{a:@,b:@}},b:{a:{a:@,b:@},b:{a:@,b:@}}}',
    ]) {
      assert.throws(() => searchBoundedJmespath(1, expression), /Unsafe JMESPath:/, expression);
    }
  });

  it('limits pipe count, total nodes, nesting, and unary multiselects', () => {
    assert.equal(searchBoundedJmespath(1, Array(9).fill('@').join('|')), 1);
    assert.throws(() => searchBoundedJmespath(1, Array(10).fill('@').join('|')), /too many pipe stages/);
    assert.deepEqual(searchBoundedJmespath(1, '['.repeat(8) + '@' + ']'.repeat(8)), [[[[[[[[1]]]]]]]]);
    assert.throws(() => searchBoundedJmespath(1, '['.repeat(9) + '@' + ']'.repeat(9)), /too many multiselects/);
    assert.equal(searchBoundedJmespath(1, '!'.repeat(31) + '@'), false);
    assert.throws(() => searchBoundedJmespath(1, '!'.repeat(32) + '@'), /too complex/);
    assert.equal(searchBoundedJmespath({}, `not_null(${Array(127).fill('a').join(',')})`), null);
    assert.throws(() => searchBoundedJmespath({}, `not_null(${Array(128).fill('a').join(',')})`), /too complex/);
  });

  it('rejects composite equality and input-derived join separators', () => {
    for (const expression of ['x==y', 'x!=`[]`', '`{}`==x', 'join(separator, parts)']) {
      assert.throws(() => searchBoundedJmespath({}, expression), /Unsafe JMESPath:/, expression);
    }
  });

  it('returns HTTP 400 on the public gateway path and still serves a normal projection', async () => {
    const { createDomainGateway } = await import('../server/gateway.ts');
    const path = '/api/resilience/v1/get-runtime-manifest';
    const handler = createDomainGateway([{
      method: 'GET', path, handler: async () => Response.json({ version: 1 }),
    }]);
    for (const expression of [
      `${doubled(30)}|to_string(@)`,
      `{x:(${doubled(40)}),y:(${doubled(40)})}|x==y`,
      'map(`{"jmespathType":"Expref","type":"Function","name":"to_string","children":[{"type":"Current"}]}`, to_array(@))',
    ]) {
      const response = await handler(new Request(`https://worldmonitor.app${path}?jmespath=${encodeURIComponent(expression)}`));
      assert.equal(response.status, 400);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      const envelope = await response.json();
      assert.match(envelope._jmespath_error, /^invalid_expression: Unsafe JMESPath:/);
      assert.deepEqual(envelope.original_keys, ['version']);
    }
    const response = await handler(new Request(`https://worldmonitor.app${path}?jmespath=version`));
    assert.equal(response.status, 200);
    assert.equal(await response.json(), 1);
  });
});
