import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const root = resolve(import.meta.dirname, '..');
const envExample = readFileSync(resolve(root, '.env.example'), 'utf8');
const runbook = readFileSync(resolve(root, 'docs/railway-seed-consolidation-runbook.md'), 'utf8');
const normalizedRunbook = runbook.replace(/\s+/g, ' ');

const SHARED_ENV = ['R2_ACCOUNT_ID', 'R2_ENDPOINT', 'R2_BOOTSTRAP_BUCKET', 'IRAN_EVENTS_ENABLED'];
const PUBLISHER_ENV = ['R2_BOOTSTRAP_ACCESS_KEY_ID', 'R2_BOOTSTRAP_SECRET_ACCESS_KEY'];
const EDGE_ENV = ['R2_BOOTSTRAP_READ_KEY_ID', 'R2_BOOTSTRAP_READ_SECRET'];

describe('bootstrap R2 environment documentation', () => {
  it('.env.example documents the live scoped credential names without values or VITE aliases', () => {
    for (const name of [...SHARED_ENV, ...PUBLISHER_ENV, ...EDGE_ENV]) {
      const matches = envExample.match(new RegExp(`^${name}=.*$`, 'gm')) ?? [];
      assert.equal(matches.length, 1, `${name} must be documented exactly once`);
    }

    assert.match(envExample, /^R2_BOOTSTRAP_BUCKET=worldmonitor-bootstrap$/m);
    assert.match(envExample, /^IRAN_EVENTS_ENABLED=false$/m);
    assert.match(envExample, /^BOOTSTRAP_R2_SHADOW_MEASURE=$/m);
    for (const name of [...PUBLISHER_ENV, ...EDGE_ENV]) {
      assert.match(envExample, new RegExp(`^${name}=$`, 'm'), `${name} must not contain a credential value`);
      assert.doesNotMatch(envExample, new RegExp(`^VITE_${name}=`, 'm'), `${name} must never have a client-visible alias`);
    }

    assert.doesNotMatch(
      envExample,
      /^R2_BOOTSTRAP_READ_SECRET_ACCESS_KEY=/m,
      'documentation must use the live edge secret name, not an invented alias',
    );
  });

  it('runbook keeps publisher and edge credentials in separate production environments', () => {
    for (const name of [...SHARED_ENV, ...PUBLISHER_ENV, ...EDGE_ENV]) {
      assert.match(runbook, new RegExp(`\\b${name}\\b`), `${name} missing from the runbook`);
    }

    assert.match(runbook, /R2_BOOTSTRAP_ACCESS_KEY_ID[^\n]*Railway production/i);
    assert.match(runbook, /R2_BOOTSTRAP_READ_KEY_ID[^\n]*Vercel production/i);
    assert.match(runbook, /publisher[^\n]*PUT[^\n]*GET/i);
    assert.match(runbook, /edge[^\n]*GET[^\n]*(?:cannot|never)[^\n]*(?:PUT|DELETE)/i);
    assert.match(normalizedRunbook, /preview.{0,80}(?:(?:do|does) not|must not|never).{0,80}(?:credential|key)/i);
    assert.match(normalizedRunbook, /must not fall back.{0,80}CLOUDFLARE_R2_/i);
  });

  it('runbook pins the always-on service and credential rotation checks', () => {
    assert.match(runbook, /node scripts\/publish-bootstrap-tiers\.mjs --loop/);
    assert.match(runbook, /no cron schedule/i);
    assert.match(runbook, /scripts\/\*\*[^\n]*shared\/\*\*/i);
    assert.match(normalizedRunbook, /create.{0,80}replacement.{0,80}update.{0,80}verify.{0,80}revoke/i);
    assert.match(runbook, /revoke first/i);
  });
});
