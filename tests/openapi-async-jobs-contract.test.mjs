import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

// Guards the REST async-job pattern injected by
// scripts/openapi-inject-async-jobs.mjs: RunScenario's success response is a
// 202 Accepted job envelope with a Location header pointing at the
// GetScenarioStatus poll endpoint. The runtime honors the contract via the
// setSuccessStatusOverride gateway side-channel
// (server/worldmonitor/scenario/v1/run-scenario.ts); this test keeps the
// published spec in sync so agents (and the ora.ai / orank scanner, which
// falls back to the spec for auth-gated routes — check `async-job-pattern`)
// always see the documented pattern. A fresh `make generate` must re-run the
// injector.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'docs/api');

const RUN_PATH = '/api/scenario/v1/run-scenario';
const POLL_PATH = '/api/scenario/v1/get-scenario-status';

function assertAsyncJobContract(op, label) {
  assert.ok(op, `${label} operation missing`);
  assert.equal(op.responses?.['200'], undefined, `${label} must not document a 200 success (202 is the success)`);
  const accepted = op.responses?.['202'];
  assert.ok(accepted, `${label} must document a 202 Accepted success`);
  assert.match(accepted.description ?? '', /[Pp]oll/, `${label} 202 description must explain polling`);
  assert.match(accepted.description ?? '', /jobId/, `${label} 202 description must name the job identifier`);

  const location = accepted.headers?.Location;
  assert.ok(location, `${label} 202 must document the Location header`);
  assert.equal(location.schema?.type, 'string', `${label} Location schema type`);
  assert.ok(String(location.example ?? '').startsWith(`${POLL_PATH}?jobId=`), `${label} Location example must target the poll endpoint`);

  // Injector composition: openapi-inject-idempotency.mjs stamps the
  // replay-marker headers on the success response BEFORE the 200→202 rename;
  // the async-jobs injector must merge Location in without clobbering them.
  assert.ok(accepted.headers?.['Idempotent-Replayed'], `${label} 202 must keep the Idempotent-Replayed replay marker`);
  assert.ok(accepted.headers?.['Idempotency-Key'], `${label} 202 must keep the Idempotency-Key echo header`);

  // The success example is an honest job envelope: pending + a poll URL that
  // mirrors the Location header example (two injectors share the literal —
  // openapi-inject-examples.mjs curates the body, openapi-inject-async-jobs.mjs
  // the header; this is the drift guard between them).
  const example = accepted.content?.['application/json']?.example;
  assert.ok(example, `${label} 202 must carry a body example`);
  assert.equal(example.status, 'pending', `${label} example status must be pending at enqueue time`);
  assert.equal(example.statusUrl, location.example, `${label} example statusUrl must mirror the Location example`);
  assert.match(String(example.jobId ?? ''), /^scenario:\d{13}:[a-z0-9]{8}$/, `${label} example jobId must match the real id shape`);

  // The op description orank reads must spell out the async pattern.
  assert.match(op.description ?? '', /202 Accepted/, `${label} op description must state the 202 contract`);
}

describe('OpenAPI async-job pattern contract (RunScenario 202)', () => {
  it('per-service JSON spec documents the 202 + Location pattern', () => {
    const spec = JSON.parse(readFileSync(resolve(apiDir, 'ScenarioService.openapi.json'), 'utf8'));
    assertAsyncJobContract(spec.paths?.[RUN_PATH]?.post, 'ScenarioService.openapi.json run-scenario POST');
    assert.ok(spec.paths?.[POLL_PATH]?.get, 'poll endpoint GetScenarioStatus must stay published');
  });

  it('per-service YAML spec documents the 202 + Location pattern', () => {
    const spec = loadYaml(readFileSync(resolve(apiDir, 'ScenarioService.openapi.yaml'), 'utf8'));
    assertAsyncJobContract(spec.paths?.[RUN_PATH]?.post, 'ScenarioService.openapi.yaml run-scenario POST');
  });

  it('bundle (worldmonitor.openapi.yaml → /openapi.json) documents the 202 + Location pattern', () => {
    const bundle = loadYaml(readFileSync(resolve(apiDir, 'worldmonitor.openapi.yaml'), 'utf8'));
    assertAsyncJobContract(bundle.paths?.[RUN_PATH]?.post, 'bundle run-scenario POST');
    assert.ok(bundle.paths?.[POLL_PATH]?.get, 'bundle must keep the poll endpoint published');
  });

  it('runtime honors the documented 202 (fail-closed source assertions)', () => {
    // The handler marks the request for the 202 upgrade + Location header…
    const handler = readFileSync(resolve(root, 'server/worldmonitor/scenario/v1/run-scenario.ts'), 'utf8');
    assert.match(handler, /setSuccessStatusOverride\(ctx\.request,\s*202\)/, 'run-scenario.ts must set the 202 override');
    assert.match(handler, /setResponseHeader\(ctx\.request,\s*'Location'/, 'run-scenario.ts must set the Location header');
    // …and the gateway drains + applies it (POST-200 only).
    const gateway = readFileSync(resolve(root, 'server/gateway.ts'), 'utf8');
    assert.match(gateway, /drainSuccessStatusOverride\(request\)/, 'gateway.ts must drain the status override');
    // Location must be CORS-exposed or browser agents cannot read the poll URL.
    const cors = readFileSync(resolve(root, 'server/cors.ts'), 'utf8');
    assert.match(cors, /'Location',/, 'cors.ts EXPOSED_HEADERS must include Location');
  });

  it('specs are in sync with the injector (make generate would not change them)', () => {
    // Fails closed if a regenerate/rebase dropped the injected 202 contract.
    execFileSync('node', ['scripts/openapi-inject-async-jobs.mjs', '--check'], {
      cwd: root,
      stdio: 'pipe',
    });
  });
});
