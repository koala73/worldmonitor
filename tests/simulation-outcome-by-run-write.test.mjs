/**
 * Structural tests for writeSimulationOutcome's by-run write path (#3734 U5).
 *
 * Behavioral testing of this function requires mocking the R2 S3 SDK
 * (which uses native DNS, not the globalThis.fetch interceptable by Node
 * test mocks). The plan's integration coverage through processNextSimulation-
 * Task would have the same coupling problem PLUS need to mock multi-LLM
 * calls. Both have low ROI vs. structural assertions on the SET sequence,
 * since the SET command shape is what the read path (U6) actually depends on.
 *
 * The U3 parity test exercises the Redis schema agreement end-to-end; this
 * file's job is to verify the worker's outcome-write code structure follows
 * the D9 / D10 contract.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

describe('writeSimulationOutcome by-run write structural lock (#3734 U5)', () => {
  const src = readFileSync(resolve(root, 'scripts/seed-forecasts.mjs'), 'utf-8');

  it('writes :latest first (canonical, D10) with the existing TRACE TTL', () => {
    // The :latest SET must remain awaited (no swallow) so the worker's try/catch
    // surfaces transport errors as `status: 'failed'`. Locking the EX flag against
    // TRACE_REDIS_TTL_SECONDS prevents an accidental TTL bump from changing the
    // observable :latest semantics.
    assert.ok(
      /await redisCommand\([\s\S]*?SIMULATION_OUTCOME_LATEST_KEY[\s\S]*?TRACE_REDIS_TTL_SECONDS/.test(src),
      'writeSimulationOutcome must await SET on SIMULATION_OUTCOME_LATEST_KEY with TRACE_REDIS_TTL_SECONDS',
    );
  });

  it('writes :by-run with the 24h TTL constant + no NX flag (D6)', () => {
    // SET <byRunKey> <payload> EX SIMULATION_OUTCOME_BY_RUN_TTL_SECONDS.
    // No NX flag — re-runs (manual --run-id=X) must overwrite cleanly per D6.
    // The shim's TTL constant is the single source of truth (24h * 3600 = 86400).
    assert.ok(
      /SET[\s\S]{0,40}byRunKey[\s\S]{0,80}EX[\s\S]{0,40}SIMULATION_OUTCOME_BY_RUN_TTL_SECONDS/.test(src),
      'by-run SET must use SIMULATION_OUTCOME_BY_RUN_TTL_SECONDS from the shim',
    );
    // No NX flag in the by-run path. The line is short — easiest assertion is
    // that the by-run SET region doesn't contain 'NX' before the closing `]`.
    const byRunMatch = src.match(/'SET', byRunKey, outcomePayloadString[^\]]+\]/);
    assert.ok(byRunMatch, 'by-run SET region not found');
    assert.ok(
      !byRunMatch[0].includes("'NX'"),
      'by-run SET must NOT use NX flag (D6: re-runs overwrite cleanly)',
    );
  });

  it('wraps by-run SET in try/catch + attempts tombstone on failure (D9)', () => {
    // The by-run write must be wrapped in try/catch so a failure doesn't
    // propagate to the worker's try/catch and fail the run. On failure,
    // a tombstone payload with `error: 'by_run_write_failed'` is attempted
    // so the read path can distinguish "expired" from "transient by-run failure".
    assert.ok(
      /by-run SET failed for \$\{runId\}/.test(src),
      'must log "by-run SET failed for ${runId}" on caught failure',
    );
    assert.ok(
      /by_run_write_failed/.test(src),
      'tombstone payload must include error: by_run_write_failed (for read-path distinction)',
    );
    assert.ok(
      /tombstoneAt:\s*Date\.now\(\)/.test(src),
      'tombstone payload must include tombstoneAt for forensics',
    );
  });

  it('returns { outcomeKey } regardless of by-run outcome (R7 — worker unchanged)', () => {
    // The function's return shape must NOT depend on the by-run path.
    // R7 requires auto-trigger (which calls this through writeSimulationOutcome)
    // to behave unchanged — meaning the function still returns a usable result
    // when by-run writes fail.
    // Find the function body via index, then walk to its closing brace and
    // assert the final return shape is `{ outcomeKey }`. Pure regex with
    // [^}]+ doesn't survive nested braces (the function body has them).
    const startIdx = src.indexOf('async function writeSimulationOutcome');
    assert.ok(startIdx >= 0, 'writeSimulationOutcome function declaration not found');
    // Slice a generous window from the function start and look for the
    // single occurrence of "return { outcomeKey }". The function ends with
    // exactly that statement.
    const body = src.slice(startIdx, startIdx + 4000);
    assert.ok(
      /return\s+\{\s*outcomeKey\s*\}/.test(body),
      'writeSimulationOutcome must return { outcomeKey } at the end of its body',
    );
  });
});
