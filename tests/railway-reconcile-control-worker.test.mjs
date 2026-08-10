// Keep the colocated Cloudflare Worker suite inside the root `test:data`
// discovery surface as well as the Worker's deployment job. Importing a
// node:test module registers the same tests without duplicating its fixtures.
import '../workers/railway-reconcile-control/index.test.mjs';
