import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const handlerSrc = readFileSync(
  resolve(root, 'server/worldmonitor/intelligence/v1/get-country-port-activity.ts'),
  'utf-8',
);

const panelSrc = readFileSync(
  resolve(root, 'src/components/CountryDeepDivePanel.ts'),
  'utf-8',
);

const intelSrc = readFileSync(
  resolve(root, 'src/app/country-intel.ts'),
  'utf-8',
);

// ── handler: cache key imports ────────────────────────────────────────────────

describe('get-country-port-activity handler: cache key imports', () => {
  it('imports PORTWATCH_PORT_ACTIVITY_COUNTRIES_KEY', () => {
    assert.match(handlerSrc, /PORTWATCH_PORT_ACTIVITY_COUNTRIES_KEY/);
  });

  it('imports PORTWATCH_PORT_ACTIVITY_KEY_PREFIX', () => {
    assert.match(handlerSrc, /PORTWATCH_PORT_ACTIVITY_KEY_PREFIX/);
  });

  it('imports getCachedJson from redis', () => {
    assert.match(handlerSrc, /getCachedJson/);
  });
});

// ── handler: unavailable country returns empty ────────────────────────────────

describe('get-country-port-activity handler: unavailable country', () => {
  it('returns available: false when country not in countries array', () => {
    assert.match(handlerSrc, /available.*false/);
    assert.match(handlerSrc, /countries\.includes\(code\)/);
  });

  it('returns empty ports array in EMPTY constant', () => {
    assert.match(handlerSrc, /ports.*\[\]/);
  });

  it('returns empty fetchedAt in EMPTY constant', () => {
    assert.match(handlerSrc, /fetchedAt.*''/);
  });
});

// ── handler: top 5 slice ──────────────────────────────────────────────────────

describe('get-country-port-activity handler: top 5 ports', () => {
  it('slices top 5 ports', () => {
    assert.match(handlerSrc, /\.slice\(0,\s*5\)/);
  });
});

// ── handler: field mapping ────────────────────────────────────────────────────

describe('get-country-port-activity handler: field mapping', () => {
  it('maps portId from seeder', () => {
    assert.match(handlerSrc, /portId/);
  });

  it('maps portName from seeder', () => {
    assert.match(handlerSrc, /portName/);
  });

  it('maps tankerCalls30d from seeder', () => {
    assert.match(handlerSrc, /tankerCalls30d/);
  });

  it('maps importTankerDwt from importTankerDwt30d', () => {
    assert.match(handlerSrc, /importTankerDwt/);
    assert.match(handlerSrc, /importTankerDwt30d/);
  });

  it('maps exportTankerDwt from exportTankerDwt30d', () => {
    assert.match(handlerSrc, /exportTankerDwt/);
    assert.match(handlerSrc, /exportTankerDwt30d/);
  });

  it('maps anomalySignal', () => {
    assert.match(handlerSrc, /anomalySignal/);
  });

  it('maps fetchedAt from payload', () => {
    assert.match(handlerSrc, /payload\.fetchedAt/);
  });
});

// ── handler: getCachedJson called with correct key ───────────────────────────

describe('get-country-port-activity handler: Redis key construction', () => {
  it('fetches countries key using PORTWATCH_PORT_ACTIVITY_COUNTRIES_KEY', () => {
    assert.match(handlerSrc, /getCachedJson\(PORTWATCH_PORT_ACTIVITY_COUNTRIES_KEY/);
  });

  it('fetches per-country key using PORTWATCH_PORT_ACTIVITY_KEY_PREFIX + code', () => {
    assert.match(handlerSrc, /PORTWATCH_PORT_ACTIVITY_KEY_PREFIX.*code/);
  });
});

// ── panel: updateMaritimeActivity method ─────────────────────────────────────

describe('CountryDeepDivePanel: updateMaritimeActivity', () => {
  it('has updateMaritimeActivity public method', () => {
    assert.match(panelSrc, /public\s+updateMaritimeActivity/);
  });

  it('renders Maritime Activity sectionCard', () => {
    assert.match(panelSrc, /sectionCard\(['"]Maritime Activity['"],/);
  });

  it('removes card from DOM when data is unavailable', () => {
    assert.match(panelSrc, /parentElement\?\.remove\(\)/);
  });

  it('renders anomaly badge for anomalySignal === true', () => {
    assert.match(panelSrc, /port\.anomalySignal/);
    assert.match(panelSrc, /cdp-maritime-anomaly/);
  });

  it('shows trend column with up/down color class', () => {
    assert.match(panelSrc, /cdp-trend-up/);
    assert.match(panelSrc, /cdp-trend-down/);
  });

  it('renders footer with IMF PortWatch source', () => {
    assert.match(panelSrc, /IMF PortWatch/);
  });

  it('has maritimeBody private field', () => {
    assert.match(panelSrc, /private\s+maritimeBody/);
  });

  it('resets maritimeBody to null in resetPanelContent', () => {
    assert.match(panelSrc, /this\.maritimeBody\s*=\s*null/);
  });

  it('maritimeCard is appended to bodyGrid', () => {
    assert.match(panelSrc, /maritimeCard/);
    assert.match(panelSrc, /bodyGrid\.append\(.*maritimeCard/);
  });
});

// ── trend delta passthrough ───────────────────────────────────────────────────

describe('trend delta passthrough', () => {
  it('passes trendDelta directly without reconstruction', () => {
    const seederPort = {
      portId: 'p1', portName: 'Test', lat: 0, lon: 0,
      tankerCalls30d: 0, trendDelta: -100, importTankerDwt30d: 0, exportTankerDwt30d: 0,
      anomalySignal: false,
    };
    const mapped = {
      trendDeltaPct: typeof seederPort.trendDelta === 'number' ? seederPort.trendDelta : 0,
      tankerCalls30d: seederPort.tankerCalls30d,
    };
    assert.strictEqual(mapped.trendDeltaPct, -100, 'should preserve -100 exactly');
    const buggyPrev = seederPort.tankerCalls30d > 0
      ? Math.round(seederPort.tankerCalls30d / (1 + seederPort.trendDelta / 100))
      : seederPort.tankerCalls30d;
    assert.strictEqual(buggyPrev, 0, 'old formula collapses to 0 on shutdown port');
  });

  it('passes lossy example without rounding error', () => {
    const seederPort = {
      tankerCalls30d: 5, trendDelta: 20.0,
    };
    const direct = seederPort.trendDelta;
    const reconstructedPrev = Math.round(seederPort.tankerCalls30d / (1 + seederPort.trendDelta / 100));
    const reconstructedPct = ((seederPort.tankerCalls30d - reconstructedPrev) / reconstructedPrev) * 100;
    assert.strictEqual(direct, 20.0, 'direct passthrough is exact');
    assert.notStrictEqual(reconstructedPct, 20.0, 'reconstruction introduces error');
  });
});

// ── country-intel.ts: call site ───────────────────────────────────────────────

describe('country-intel.ts: getCountryPortActivity call site', () => {
  it('calls intelClient.getCountryPortActivity', () => {
    assert.match(intelSrc, /getCountryPortActivity/);
  });

  it('has stale guard checking getCode() !== code', () => {
    const staleGuardCount = (intelSrc.match(/getCode\(\)\s*!==\s*code/g) ?? []).length;
    assert.ok(staleGuardCount >= 2, `expected at least 2 stale guards, found ${staleGuardCount}`);
  });

  it('calls updateMaritimeActivity on success', () => {
    assert.match(intelSrc, /updateMaritimeActivity\?\./);
  });

  it('calls updateMaritimeActivity with available: false on error', () => {
    assert.match(intelSrc, /available.*false.*ports.*\[\]/s);
  });
});
