import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureHealthEvidence, readIncidents, resolveIncident } from '../scripts/health-incident-evidence.mjs';

test('immutable observations preserve recurrence, ownership and explicit causal closure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'health-evidence-'));
  const snapshot = (minute, status) => ({ checkedAt: `2031-01-01T00:0${minute}:00Z`, checks: { toronto: { status } } });
  try {
    const original = await captureHealthEvidence(dir, snapshot(0, 'SEED_ERROR'), 'existing-thread');
    const bytes = await readFile(original, 'utf8');
    await captureHealthEvidence(dir, snapshot(0, 'SEED_ERROR'), 'existing-thread');
    assert.equal((await readdir(dir)).length, 2);
    await captureHealthEvidence(dir, snapshot(1, 'OK'), 'another-thread');
    let [incident] = await readIncidents(dir);
    assert.equal(incident.owner, 'existing-thread');
    assert.equal(incident.state, 'recovered');
    assert.equal(incident.causeStatus, 'open');
    await captureHealthEvidence(dir, snapshot(2, 'SEED_ERROR'), 'another-thread');
    [incident] = await readIncidents(dir);
    assert.equal(incident.occurrences, 2);
    assert.equal(incident.firstSeen, '2031-01-01T00:00:00.000Z');
    await assert.rejects(resolveIncident(dir, incident.id, ''), /evidence/);
    await resolveIncident(dir, incident.id, 'verified-repair-report.md');
    assert.equal((await readIncidents(dir))[0].causeStatus, 'resolved');
    await captureHealthEvidence(dir, snapshot(3, 'SEED_ERROR'), 'existing-thread');
    assert.equal((await readIncidents(dir)).length, 2);
    assert.equal(await readFile(original, 'utf8'), bytes);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('missing checks and pending caches cannot prove recovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'health-evidence-'));
  try {
    await assert.rejects(captureHealthEvidence(dir, { checkedAt: 'bad', checks: {} }, 'owner'));
    assert.equal((await readdir(dir)).length, 0);
    await captureHealthEvidence(dir, { checkedAt: '2031-01-01', checks: { a: { status: 'SEED_ERROR' } } }, 'owner');
    await captureHealthEvidence(dir, { checkedAt: '2031-01-02', checks: { b: { status: 'EMPTY_ON_DEMAND' } } }, 'owner');
    const incidents = await readIncidents(dir);
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].state, 'failing');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
