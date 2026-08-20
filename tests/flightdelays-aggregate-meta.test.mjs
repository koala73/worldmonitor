// #6987 — flightDelays serves a combined aggregate (FAA + international +
// NOTAM) but its health probe used to read the FAA-only sidecar meta. A quiet
// FAA window wrote recordCount=0 and the healthy aggregate flipped to
// EMPTY_DATA. The aggregate now carries its own meta written alongside it.
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const healthSrc = readFileSync(new URL('../api/health.js', import.meta.url), 'utf8');
const seederSrc = readFileSync(new URL('../scripts/seed-aviation.mjs', import.meta.url), 'utf8');

describe('flightDelays health meta population (#6987)', () => {
  it('health.js maps flightDelays to the aggregate meta, not the FAA-only meta', () => {
    assert.match(
      healthSrc,
      /flightDelays:\s*\{[^}]*key:\s*'seed-meta:aviation:delays-bootstrap'/,
      'flightDelays must count the combined aggregate it serves (#6987)',
    );
    assert.doesNotMatch(
      healthSrc,
      /flightDelays:\s*\{[^}]*key:\s*'seed-meta:aviation:faa'/,
      'the FAA-only sidecar count belongs to faaDelays, not the combined flightDelays probe',
    );
  });

  it('seed-aviation writes the aggregate meta alongside the bootstrap payload', () => {
    assert.match(seederSrc, /BOOTSTRAP_META_KEY\s*=\s*'seed-meta:aviation:delays-bootstrap'/);
    assert.match(
      seederSrc,
      /upstashSet\(\s*BOOTSTRAP_META_KEY,\s*\{[^}]*recordCount:\s*payload\.alerts\.length/,
      'the aggregate meta must be written from the aggregate payload itself',
    );
  });
});
