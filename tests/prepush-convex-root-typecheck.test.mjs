// The root `tsc` (run by the Vercel build as `tsc && vite build`) reaches every
// Convex module: src/services/convex-client.ts imports convex/_generated/api,
// whose api.d.ts imports each module. It checks them under the root options
// (noUncheckedIndexedAccess), which convex/tsconfig.json does not set. So a
// convex-only change can pass `tsc -p convex` and still fail the Vercel build
// (#10909: `rows[0].audience` → TS2532). The pre-push gate must run the root
// type check for convex/ changes too.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hook = readFileSync(resolve(root, '.husky/pre-push'), 'utf8');

describe('pre-push root type check covers convex/', () => {
  it('the coupling is real: src imports the generated Convex api, and the root config is stricter', () => {
    assert.match(readFileSync(resolve(root, 'src/services/convex-client.ts'), 'utf8'), /convex\/_generated\/api/);
    const rootConfig = readFileSync(resolve(root, 'tsconfig.json'), 'utf8');
    const convexConfig = readFileSync(resolve(root, 'convex/tsconfig.json'), 'utf8');
    assert.match(rootConfig, /"noUncheckedIndexedAccess": true/);
    // If convex/tsconfig.json ever adopts the option, this guard can relax.
    assert.doesNotMatch(convexConfig, /noUncheckedIndexedAccess/);
  });

  it('runs `npm run typecheck` when convex/ changes', () => {
    const trigger = hook.match(/if changed '([^']+)'; then\n\s+if gate_cached typecheck /);
    assert.ok(trigger, 'frontend type-check trigger not found in .husky/pre-push');
    assert.ok(new RegExp(trigger[1]).test('convex/alertScopeMigration.ts'), `trigger ${trigger[1]} must match convex/ paths`);
  });

  it('runs on every hook edit, so loosening the trigger fails locally', () => {
    const list = hook.match(/for contract_test in ([^;]+);/);
    assert.ok(list, 'contract_test list not found in .husky/pre-push');
    assert.ok(list[1].split(/\s+/).includes('tests/prepush-convex-root-typecheck.test.mjs'), list[1]);
  });

  it('keys the typecheck cache on convex/ so a convex edit is not a cache hit', () => {
    const inputs = hook.match(/^TYPECHECK_INPUTS=\(([^)]*)\)/m);
    assert.ok(inputs, 'TYPECHECK_INPUTS not found');
    assert.ok(inputs[1].split(/\s+/).includes('convex'), `TYPECHECK_INPUTS must include convex: ${inputs[1]}`);
  });
});
