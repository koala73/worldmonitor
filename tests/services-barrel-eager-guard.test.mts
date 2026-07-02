import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

// #4571 U4 — re-introduction guard.
//
// These services run a module-load side effect (a top-level `new XServiceClient()`
// plus `createCircuitBreaker()` calls). Re-exporting such a module via `export *`
// from the @/services barrel makes it un-tree-shakeable: any eager importer of the
// barrel then pulls the whole service (and its client init) into eager main.js,
// regardless of whether the service's fetchers are dynamic-imported. That is the
// exact regression #4571 removed (~150KB of service code off boot). This guard trips
// if a deferred service is re-added to the barrel's `export *`.
const DEFERRED = ['economic', 'market', 'aviation', 'trade'];

const src = readFileSync(new URL('../src/services/index.ts', import.meta.url), 'utf8');

describe('@/services barrel keeps side-effectful services tree-shakeable (#4571 U4)', () => {
  for (const svc of DEFERRED) {
    it(`does not \`export * from './${svc}'\` (would pull it into eager main.js)`, () => {
      const re = new RegExp(`export\\s*\\*\\s*from\\s*['"]\\./${svc}['"]`);
      assert.ok(
        !re.test(src),
        `src/services/index.ts must not re-export './${svc}' via \`export *\` — it has a `
          + `module-load side effect and must stay in a lazy chunk. Consumers import it directly `
          + `(@/services/${svc}) or dynamically (data-loader). See #4571.`,
      );
    });
  }
});
