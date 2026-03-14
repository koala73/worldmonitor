import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const relaySrc = readFileSync(resolve(root, 'scripts/ais-relay.cjs'), 'utf-8');

const fnMatch = relaySrc.match(/function classifyVesselType\(shipType\)\s*\{([^}]+)\}/);
const classifyVesselType = new Function('shipType', fnMatch[1]);

describe('classifyVesselType (pure logic)', () => {
  it('classifies tanker (80-89)', () => {
    for (let i = 80; i <= 89; i++) assert.equal(classifyVesselType(i), 'tanker');
  });

  it('classifies cargo (70-79)', () => {
    for (let i = 70; i <= 79; i++) assert.equal(classifyVesselType(i), 'cargo');
  });

  it('classifies other for values outside tanker/cargo range', () => {
    assert.equal(classifyVesselType(50), 'other');
    assert.equal(classifyVesselType(99), 'other');
    assert.equal(classifyVesselType(0), 'other');
  });
});

describe('transit timing constants', () => {
  it('TRANSIT_COOLDOWN_MS is 30 minutes (1800000ms)', () => {
    assert.match(relaySrc, /TRANSIT_COOLDOWN_MS\s*=\s*30\s*\*\s*60\s*\*\s*1000/);
  });

  it('MIN_DWELL_MS is 5 minutes (300000ms)', () => {
    assert.match(relaySrc, /MIN_DWELL_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/);
  });

  it('TRANSIT_WINDOW_MS is 24 hours (86400000ms)', () => {
    assert.match(relaySrc, /TRANSIT_WINDOW_MS\s*=\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  });
});

describe('crossing detection logic', () => {
  it('checks dwell time before recording', () => {
    assert.match(relaySrc, />=\s*MIN_DWELL_MS/);
  });

  it('checks cooldown to prevent re-count', () => {
    assert.match(relaySrc, /transitCooldowns/);
    assert.match(relaySrc, />=\s*TRANSIT_COOLDOWN_MS/);
  });
});

describe('cleanup logic', () => {
  it('prunes pending entries older than 48h with geofence check', () => {
    assert.match(relaySrc, /48\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
    assert.match(relaySrc, /pendingCutoff/);
    assert.match(relaySrc, /vesselChokepoints/);
  });
});

describe('chokepoint definitions', () => {
  const cpMatch = relaySrc.match(/const CHOKEPOINTS\s*=\s*\[([\s\S]*?)\];/);
  const cpBlock = cpMatch[1];
  const names = [...cpBlock.matchAll(/name:\s*'([^']+)'/g)].map(m => m[1]);

  it('defines exactly 15 chokepoints', () => {
    assert.equal(names.length, 15);
  });

  it('includes original 8 chokepoints', () => {
    const original = [
      'Strait of Hormuz', 'Suez Canal', 'Malacca Strait', 'Bab el-Mandeb Strait',
      'Panama Canal', 'Taiwan Strait', 'South China Sea', 'Black Sea',
    ];
    for (const name of original) {
      assert.ok(names.includes(name), `missing original chokepoint: ${name}`);
    }
  });

  it('includes new chokepoints with correct names', () => {
    const added = ['Cape of Good Hope', 'Gibraltar Strait', 'Bosporus Strait'];
    for (const name of added) {
      assert.ok(names.includes(name), `missing new chokepoint: ${name}`);
    }
  });
});

describe('seed function', () => {
  it('writes to supply_chain:chokepoint_transits:v1', () => {
    assert.match(relaySrc, /supply_chain:chokepoint_transits:v1/);
  });

  it('writes seed-meta', () => {
    assert.match(relaySrc, /seed-meta:supply_chain:chokepoint_transits/);
  });
});
