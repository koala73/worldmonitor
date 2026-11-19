import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  SOURCES,
  TENSION_EVIDENCE_ACTIVATION_KEY,
  TENSION_EVIDENCE_COMPLETION_META_KEY,
  TENSION_EVIDENCE_KEY,
  buildEvidence,
} from '../scripts/_tension-evidence.mjs';
import { describeReadings, isEvidencePayload, readEvidenceSources } from '../scripts/seed-tension-evidence.mjs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('tension evidence seeder', () => {
  it('pairs each source with its seed-meta clock and leaves an unreadable source unusable', async () => {
    const now = Date.parse('2026-10-25T12:00:00Z');
    const stored = {
      [SOURCES.surgeHistory.key]: {
        history: [{ assessedAt: now - 60_000, sourceVersion: 'adsb.lol', theaters: [{ theaterId: 'iran-theater', byCountry: { USA: 3 } }] }],
      },
      [SOURCES.surgeHistory.metaKey]: { fetchedAt: now - 60_000, recordCount: 0 },
      [SOURCES.sanctions.key]: { events: [], gaps: [] },
    };
    const keysRead = [];
    const sources = await readEvidenceSources(async key => {
      keysRead.push(key);
      return stored[key] ?? null;
    });
    assert.deepEqual(Object.keys(sources).sort(), Object.keys(SOURCES).sort());
    assert.equal(keysRead.length, 2 * Object.keys(SOURCES).length);
    assert.equal(sources.surgeHistory.fetchedAt, now - 60_000);
    assert.equal(sources.sanctions.fetchedAt, undefined, 'no seed-meta, no clock');
    const { live } = buildEvidence(sources, {}, now);
    assert.deepEqual(live.usa_iran.map(item => item.channel), ['military_aircraft']);
  });

  it('accepts only a payload with a clock, live readings and history', () => {
    assert.equal(isEvidencePayload({ updatedAt: 1, live: {}, days: {} }), true);
    assert.equal(isEvidencePayload({ updatedAt: 1, live: [], days: {} }), false);
    assert.equal(isEvidencePayload({ live: {}, days: {} }), false);
    assert.equal(isEvidencePayload(null), false);
  });

  it('prints notable readings with a marker and pairs with no readings plainly', () => {
    const lines = describeReadings({
      live: {
        iran_gcc: [{ channel: 'airports', value: 1, baseline: null, countries: [], airports: [{ name: 'Riyadh', status: 'halted' }], notable: true }],
        usa_china: [],
      },
    });
    assert.deepEqual(lines, ['iran_gcc', '  * airports: 1 (no usual yet) Riyadh halted', 'usa_china', '    (no readings)']);
  });

  it('marks the history live after every publish', () => {
    const seeder = read('scripts/seed-tension-evidence.mjs');
    assert.match(seeder, /afterPublish:[\s\S]*?\['SET', TENSION_EVIDENCE_ACTIVATION_KEY, '1'\]/);
    assert.match(seeder, /readSeedSnapshot\(TENSION_EVIDENCE_KEY, \{ strict: true/);
    assert.equal(TENSION_EVIDENCE_ACTIVATION_KEY, 'seed-activated:intelligence:tension-evidence');
  });

  it('runs as a 15-minute derived-signals section named with literals', () => {
    const line = read('scripts/seed-bundle-derived-signals.mjs').split('\n').find(text => text.includes("label: 'Tension-Evidence'"));
    assert.ok(line, 'the derived-signals bundle has a Tension-Evidence section');
    assert.match(line, /script: 'seed-tension-evidence\.mjs'/);
    assert.match(line, /seedMetaKey: 'intelligence:tension-evidence'/);
    assert.match(line, new RegExp(`canonicalKey: '${TENSION_EVIDENCE_KEY}'`));
    assert.match(line, new RegExp(`completionMetaKey: '${TENSION_EVIDENCE_COMPLETION_META_KEY}'`));
    assert.match(line, /intervalMs: 15 \* MIN/);
    assert.match(line, /timeoutMs: 60_000/);
  });

  it('redeploys the derived-signals service when the evidence code changes', () => {
    const services = JSON.parse(read('scripts/railway-services.json'));
    const entry = (Array.isArray(services) ? services : services.services).find(s => s.service === 'seed-bundle-derived-signals');
    const patterns = entry.watchPatterns ?? entry.watchPaths;
    for (const file of ['scripts/seed-tension-evidence.mjs', 'scripts/_tension-evidence.mjs']) {
      assert.ok(patterns.includes(file), `${file} is a watch path`);
    }
  });
});
