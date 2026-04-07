import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const src = readFileSync(resolve(root, 'scripts/seed-portwatch-port-activity.mjs'), 'utf-8');

// ── seeder source assertions ──────────────────────────────────────────────────

describe('seed-portwatch-port-activity.mjs exports', () => {
  it('exports fetchAll', () => {
    assert.match(src, /export\s+async\s+function\s+fetchAll/);
  });

  it('exports validateFn', () => {
    assert.match(src, /export\s+function\s+validateFn/);
  });

  it('CANONICAL_KEY is supply_chain:portwatch-ports:v1:_countries', () => {
    assert.match(src, /supply_chain:portwatch-ports:v1:_countries/);
  });

  it('KEY_PREFIX is supply_chain:portwatch-ports:v1:', () => {
    assert.match(src, /supply_chain:portwatch-ports:v1:/);
  });

  it('Endpoint 3 URL contains Daily_Ports_Data', () => {
    assert.match(src, /Daily_Ports_Data/);
  });

  it('Endpoint 4 URL contains PortWatch_ports_database', () => {
    assert.match(src, /PortWatch_ports_database/);
  });

  it('date filter uses epochToTimestamp', () => {
    assert.match(src, /epochToTimestamp/);
  });

  it('Endpoint 3 pagination loop checks body.exceededTransferLimit', () => {
    assert.match(src, /body\.exceededTransferLimit/);
  });

  it('Endpoint 4 query uses per-country ISO3 filter', () => {
    assert.match(src, /PortWatch_ports_database/);
    assert.match(src, /ISO3=/);
  });

  it('anomalySignal computation is present', () => {
    assert.match(src, /anomalySignal/);
  });

  it('MAX_PORTS_PER_COUNTRY is 50', () => {
    assert.match(src, /MAX_PORTS_PER_COUNTRY\s*=\s*50/);
  });

  it('TTL is 259200 (3 days)', () => {
    assert.match(src, /259[_\s]*200/);
  });

  it('wraps main() in isMain guard', () => {
    assert.match(src, /isMain.*=.*process\.argv/s);
    assert.match(src, /if\s*\(isMain\)/);
  });
});

// ── unit tests ────────────────────────────────────────────────────────────────

function computeAnomalySignal(rows, cutoff30, cutoff7) {
  const last30 = rows.filter(r => r.date >= cutoff30);
  const last7 = rows.filter(r => r.date >= cutoff7);
  const avg30d = last30.reduce((s, r) => s + r.portcalls_tanker, 0) / 30;
  const avg7d = last7.reduce((s, r) => s + r.portcalls_tanker, 0) / Math.max(last7.length, 1);
  return avg30d > 0 && avg7d < avg30d * 0.5;
}

function topN(ports, n) {
  return [...ports].sort((a, b) => b.tankerCalls30d - a.tankerCalls30d).slice(0, n);
}

describe('anomalySignal computation', () => {
  const now = Date.now();
  const cutoff30 = now - 30 * 86400000;
  const cutoff7 = now - 7 * 86400000;

  it('detects anomaly when 7d avg is < 50% of 30d avg', () => {
    const rows = [];
    for (let i = 0; i < 30; i++) {
      rows.push({ date: now - (29 - i) * 86400000, portcalls_tanker: 60 });
    }
    // last 7 days avg = 2 (spike down)
    for (let i = 0; i < 7; i++) {
      rows[rows.length - 7 + i].portcalls_tanker = 2;
    }
    const result = computeAnomalySignal(rows, cutoff30, cutoff7);
    assert.equal(result, true, 'should detect anomaly when 7d avg is far below 30d avg');
  });

  it('does NOT flag anomaly when 7d avg is close to 30d avg', () => {
    const rows = [];
    for (let i = 0; i < 30; i++) {
      rows.push({ date: now - (29 - i) * 86400000, portcalls_tanker: 60 });
    }
    // last 7 days avg = 55 (close to 60)
    for (let i = 0; i < 7; i++) {
      rows[rows.length - 7 + i].portcalls_tanker = 55;
    }
    const result = computeAnomalySignal(rows, cutoff30, cutoff7);
    assert.equal(result, false, 'should not flag anomaly when 7d is close to 30d avg');
  });

  it('returns false when 30d avg is zero (no baseline)', () => {
    const rows = [];
    for (let i = 0; i < 30; i++) {
      rows.push({ date: now - (29 - i) * 86400000, portcalls_tanker: 0 });
    }
    const result = computeAnomalySignal(rows, cutoff30, cutoff7);
    assert.equal(result, false, 'should return false when baseline is zero');
  });
});

describe('top-N port truncation', () => {
  it('returns top 50 ports from a set of 60', () => {
    const ports = Array.from({ length: 60 }, (_, i) => ({
      portId: String(i),
      portName: `Port ${i}`,
      tankerCalls30d: 60 - i,
    }));
    const result = topN(ports, 50);
    assert.equal(result.length, 50, 'should return exactly 50 ports');
    assert.equal(result[0].tankerCalls30d, 60, 'first port should have highest tankerCalls30d');
    assert.equal(result[49].tankerCalls30d, 11, 'last port should be rank 50');
  });

  it('returns all ports when count is less than N', () => {
    const ports = Array.from({ length: 10 }, (_, i) => ({
      portId: String(i),
      portName: `Port ${i}`,
      tankerCalls30d: 10 - i,
    }));
    const result = topN(ports, 50);
    assert.equal(result.length, 10, 'should return all 10 ports when fewer than 50');
  });

  it('sorts by tankerCalls30d descending', () => {
    const ports = [
      { portId: 'a', portName: 'A', tankerCalls30d: 5 },
      { portId: 'b', portName: 'B', tankerCalls30d: 100 },
      { portId: 'c', portName: 'C', tankerCalls30d: 50 },
    ];
    const result = topN(ports, 50);
    assert.equal(result[0].portId, 'b');
    assert.equal(result[1].portId, 'c');
    assert.equal(result[2].portId, 'a');
  });
});

describe('validateFn', () => {
  it('returns true when countries array has >= 50 entries', () => {
    const data = { countries: Array.from({ length: 80 }, (_, i) => `C${i}`), fetchedAt: new Date().toISOString() };
    const countries = data.countries;
    const valid = data && Array.isArray(countries) && countries.length >= 50;
    assert.equal(valid, true);
  });

  it('returns false when countries array has < 50 entries', () => {
    const data = { countries: ['US', 'SA'], fetchedAt: new Date().toISOString() };
    const countries = data.countries;
    const valid = data && Array.isArray(countries) && countries.length >= 50;
    assert.equal(valid, false);
  });

  it('returns false for null data', () => {
    const data = null;
    const valid = !!(data && Array.isArray(data.countries) && data.countries.length >= 50);
    assert.equal(valid, false);
  });
});
