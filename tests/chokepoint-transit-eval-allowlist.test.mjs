// The self-hosting Redis REST proxy (docker/redis-rest-proxy.mjs) refuses any
// EVAL whose script is not pinned in ALLOWED_EVAL_SCRIPTS, byte for byte. The
// AIS relay runs two chokepoint transit scripts through EVAL, and neither was
// pinned, so every self-hosted deployment logged
// "Command not allowed: EVAL (script not in the pinned allowlist)" and the
// chokepoint transit and transit-summary keys never populated (#10931).
//
// This is a source-text check on purpose: the proxy is a standalone Docker
// entrypoint that must not import from the repo, so the copy is duplicated
// deliberately and only an exact-text comparison can prove the two agree.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { MERGE_TRANSIT_GATES } from '../shared/chokepoint-transit-store.js';
import { MERGE_TRANSIT_WINDOW } from '../shared/chokepoint-transit-window.js';

const here = dirname(fileURLToPath(import.meta.url));
const proxy = readFileSync(resolve(here, '../docker/redis-rest-proxy.mjs'), 'utf8');

function pinnedCopy(name) {
  const block = proxy.match(new RegExp(`const ${name} = (\\[[\\s\\S]*?\\])\\.join\\('\\\\n'\\);`));
  assert.ok(block, `the proxy must carry a pinned ${name} copy`);
  return new Function(`return ${block[1]};`)().join('\n');
}

function allowlist() {
  const block = proxy.match(/const ALLOWED_EVAL_SCRIPTS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(block, 'the proxy must declare ALLOWED_EVAL_SCRIPTS');
  return block[1];
}

describe('chokepoint transit EVAL scripts are pinned in the self-hosted proxy (#10931)', () => {
  for (const [name, shared] of [
    ['MERGE_TRANSIT_GATES_SCRIPT', MERGE_TRANSIT_GATES],
    ['MERGE_TRANSIT_WINDOW_SCRIPT', MERGE_TRANSIT_WINDOW],
  ]) {
    it(`${name}: the pinned copy matches the shared source byte for byte`, () => {
      assert.equal(pinnedCopy(name), shared);
    });

    it(`${name}: the pinned copy is allowlisted`, () => {
      assert.match(
        allowlist(),
        new RegExp(`(^|\\s)${name},`),
        `${name} must be in ALLOWED_EVAL_SCRIPTS or the proxy refuses the relay's EVAL`,
      );
    });
  }

  it('every shared Lua script the relay evaluates is pinned', () => {
    // The gap this suite exists for was one script missing from the set while
    // its sibling was equally absent. Enumerate rather than list, so a third
    // transit script cannot be added to shared/ and silently left out.
    const names = ['MERGE_TRANSIT_GATES_SCRIPT', 'MERGE_TRANSIT_WINDOW_SCRIPT'];
    const missing = names.filter((name) => !new RegExp(`(^|\\s)${name},`).test(allowlist()));
    assert.deepEqual(missing, []);
  });
});
