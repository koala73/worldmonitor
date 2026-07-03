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
// if a deferred service is re-added to the barrel.
const DEFERRED = ['economic', 'market', 'aviation', 'trade', 'supply-chain', 'cyber', 'cable-activity', 'research'];
// research is barrel-only (no data-loader consumer) — export*-guarded and static-import guarded,
// but it does not need a dynamic-import assertion until data-loader actually consumes it.
const BARREL_ONLY = new Set(['research']);
const DATA_LOADER_DEFERRED = DEFERRED.filter((s) => !BARREL_ONLY.has(s));

const src = readFileSync(new URL('../src/services/index.ts', import.meta.url), 'utf8');
const dataLoaderSrc = readFileSync(new URL('../src/app/data-loader.ts', import.meta.url), 'utf8');

describe('@/services barrel keeps side-effectful services tree-shakeable (#4571 U4)', () => {
  for (const svc of DEFERRED) {
    it(`does not re-export './${svc}' (star, namespace, or named — each pulls it into eager main.js)`, () => {
      // `export * from './svc'`, `export * as svc from './svc'`, and named re-exports
      // all re-export the module through the barrel. Since the module has a top-level
      // side effect, Rollup retains it (and runs its client/breaker init) for any eager
      // barrel importer either way — a named re-export is NOT a safe escape hatch.
      const starRe = new RegExp(`export\\s*\\*\\s*from\\s*['"]\\./${svc}['"]`);
      const namespaceRe = new RegExp(`export\\s*\\*\\s*as\\s+\\w+\\s*from\\s*['"]\\./${svc}['"]`);
      const namedRe = new RegExp(`export\\s*\\{[^}]*\\}\\s*from\\s*['"]\\./${svc}['"]`);
      assert.ok(
        !starRe.test(src) && !namespaceRe.test(src) && !namedRe.test(src),
        `src/services/index.ts must not re-export './${svc}' (via \`export *\`, namespace, or named `
          + `\`export { … } from\`) — it has a module-load side effect and must stay in a lazy `
          + `chunk. Consumers import it directly (@/services/${svc}) or dynamically (data-loader). See #4571.`,
      );
    });
  }
});

describe('data-loader keeps deferred service fetchers behind dynamic imports (#4571)', () => {
  for (const svc of DEFERRED) {
    it(`does not statically import @/services/${svc}`, () => {
      const staticValueImportRe = new RegExp(`import\\s+(?!type\\b)[\\s\\S]*?from\\s*['"]@/services/${svc}['"]`);
      assert.ok(
        !staticValueImportRe.test(dataLoaderSrc),
        `src/app/data-loader.ts must not statically import @/services/${svc}; use await import('@/services/${svc}') at the gated call site.`,
      );
    });
  }

  for (const svc of DATA_LOADER_DEFERRED) {
    it(`has an explicit dynamic import for @/services/${svc}`, () => {
      const dynamicImportRe = new RegExp(`import\\(\\s*['"]@/services/${svc}['"]\\s*\\)`);
      assert.ok(
        dynamicImportRe.test(dataLoaderSrc),
        `src/app/data-loader.ts should keep @/services/${svc} reachable through an explicit dynamic import.`,
      );
    });
  }
});
