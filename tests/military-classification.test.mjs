import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Extract server-side classification data from _shared.ts source
// ---------------------------------------------------------------------------
const sharedSrc = readFileSync(
  join(root, 'server/worldmonitor/military/v1/_shared.ts'),
  'utf-8',
);

function extractArray(src, name) {
  // Match both `const X = [...]` and `const X = new Set([...])`
  const re = new RegExp(`(?:export )?const ${name}\\s*=\\s*(?:new Set\\()?\\[([\\s\\S]*?)\\]`);
  const m = src.match(re);
  if (!m) return [];
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

const MILITARY_PREFIXES = extractArray(sharedSrc, 'MILITARY_PREFIXES');
const SHORT_MILITARY_PREFIXES = extractArray(sharedSrc, 'SHORT_MILITARY_PREFIXES');
const AIRLINE_CODES = new Set(extractArray(sharedSrc, 'AIRLINE_CODES'));

function isMilitaryCallsign(callsign) {
  if (!callsign) return false;
  const cs = callsign.toUpperCase().trim();
  for (const prefix of MILITARY_PREFIXES) {
    if (cs.startsWith(prefix)) return true;
  }
  for (const prefix of SHORT_MILITARY_PREFIXES) {
    if (cs.startsWith(prefix) && cs.length > prefix.length && /\d/.test(cs[prefix.length]))
      return true;
  }
  if (/^[A-Z]{3}\d{1,2}$/.test(cs)) {
    const prefix = cs.slice(0, 3);
    if (!AIRLINE_CODES.has(prefix)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Extract client-side hex ranges from military.ts
// ---------------------------------------------------------------------------
const clientSrc = readFileSync(join(root, 'src/config/military.ts'), 'utf-8');

function extractHexRanges(src) {
  const ranges = [];
  const re = /start:\s*'([0-9A-Fa-f]+)',\s*end:\s*'([0-9A-Fa-f]+)'/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    ranges.push({ start: m[1].toUpperCase(), end: m[2].toUpperCase() });
  }
  return ranges;
}

const HEX_RANGES = extractHexRanges(clientSrc);

function isKnownMilitaryHex(hexCode) {
  const hex = hexCode.toUpperCase();
  for (const range of HEX_RANGES) {
    if (hex >= range.start && hex <= range.end) return true;
  }
  return false;
}

// ===========================================================================
// Tests
// ===========================================================================

describe('Military callsign classifier (server-side)', () => {
  describe('correctly identifies military callsigns', () => {
    const military = [
      'RCH1234', 'REACH01', 'MOOSE55', 'NAVY1', 'ARMY22',
      'COBRA11', 'DUKE01', 'SHELL22', 'RAPTOR1', 'REAPER01',
      'NATO01', 'GAF123', 'RAF01', 'FAF55', 'IAF01',
      'RSAF01', 'IRGC1', 'VKS01', 'PLAAF1',
    ];
    for (const cs of military) {
      it(`marks ${cs} as military`, () => {
        assert.ok(isMilitaryCallsign(cs), `${cs} should be military`);
      });
    }
  });

  describe('correctly identifies short-prefix military callsigns', () => {
    const shortMilitary = [
      'AE1234', 'RF01', 'TF122', 'PAT01', 'SAM1', 'OPS22',
    ];
    for (const cs of shortMilitary) {
      it(`marks ${cs} as military (short prefix + digit)`, () => {
        assert.ok(isMilitaryCallsign(cs), `${cs} should be military`);
      });
    }
  });

  describe('does NOT flag commercial airline callsigns', () => {
    const civilian = [
      'AEE123',  // Aegean Airlines
      'AEA456',  // Air Europa
      'THY1234', // Turkish Airlines
      'SVA123',  // Saudia
      'QTR456',  // Qatar Airways
      'UAE789',  // Emirates
      'BAW123',  // British Airways
      'AFR456',  // Air France
      'DLH789',  // Lufthansa
      'KLM12',   // KLM
      'AAL1234', // American Airlines
      'DAL5678', // Delta
      'UAL901',  // United
      'SWA1234', // Southwest
      'JAL123',  // Japan Airlines
      'ANA456',  // All Nippon Airways
      'KAL789',  // Korean Air
      'CCA123',  // Air China
      'AIC456',  // Air India
      'SIA789',  // Singapore Airlines
      'ELY123',  // El Al
      'RYR456',  // Ryanair
      'EZY789',  // easyJet
      'WZZ123',  // Wizz Air
      'FDX456',  // FedEx
      'UPS789',  // UPS
    ];
    for (const cs of civilian) {
      it(`does NOT mark ${cs} as military`, () => {
        assert.ok(!isMilitaryCallsign(cs), `${cs} should NOT be military`);
      });
    }
  });

  describe('short prefixes do NOT match when followed by letters', () => {
    const civilianShort = [
      'AEE123', // Aegean — starts with AE but next char is E (letter)
      'AERO1',  // Generic — starts with AE but not short-prefix match
      'RFAIR',  // hypothetical — RF followed by letter
      'TFLIGHT', // hypothetical — TF followed by letter
      'PATROL1', // starts with PAT but next char is R (letter)
      'SAMPLE',  // starts with SAM but next char is P (letter)
    ];
    for (const cs of civilianShort) {
      it(`does NOT mark ${cs} as military via short prefix`, () => {
        assert.ok(!isMilitaryCallsign(cs), `${cs} should NOT be military`);
      });
    }
  });
});

describe('Military hex range classifier (client-side)', () => {
  describe('correctly identifies military hex codes', () => {
    const military = [
      'AE0000', // US DoD start
      'AF0000', // US DoD mid
      'AFFFFF', // US DoD end
      '43C000', // RAF start
      '43CFFF', // RAF end
      '3AA000', // French military start
      '3F4000', // German military start
    ];
    for (const hex of military) {
      it(`marks ${hex} as military`, () => {
        assert.ok(isKnownMilitaryHex(hex), `${hex} should be military`);
      });
    }
  });

  describe('does NOT flag civilian ICAO hex codes', () => {
    const civilian = [
      'A00001', // US civilian N-number (N1)
      'A0B0C0', // US civilian mid-range
      'A3FFFF', // US civilian — was incorrectly flagged before fix
      'ADF7C7', // Last US civilian N-number (N99999)
      '300000', // Italian civilian (Alitalia range start)
      '330000', // Italian civilian
      '33FE00', // Italian civilian (just below military)
      '340000', // Spanish civilian
      '34FFFF', // Spanish civilian (just below military at 350000)
      '840000', // Japanese civilian (JAL/ANA) — entire block removed
      '870000', // Japanese civilian
      '800000', // Indian civilian (Air India)
      '800100', // Indian civilian
      '718000', // South Korean civilian — no confirmed military range
      '3C0000', // German civilian (Lufthansa range)
      '380000', // French civilian (Air France range)
      'C00000', // Canadian civilian (Air Canada)
      'C10000', // Canadian civilian
      '7C0000', // Australian civilian (Qantas)
    ];
    for (const hex of civilian) {
      it(`does NOT mark ${hex} as military`, () => {
        assert.ok(!isKnownMilitaryHex(hex), `${hex} should NOT be military`);
      });
    }
  });

  describe('validates range boundaries are tight', () => {
    it('US military starts at ADF7C8, not A00000', () => {
      assert.ok(!isKnownMilitaryHex('ADF7C7'), 'ADF7C7 (last N-number) should be civilian');
      assert.ok(isKnownMilitaryHex('ADF7C8'), 'ADF7C8 should be military');
    });

    it('Italy military is only top 256 codes (33FF00-33FFFF)', () => {
      assert.ok(!isKnownMilitaryHex('33FEFF'), '33FEFF should be civilian');
      assert.ok(isKnownMilitaryHex('33FF00'), '33FF00 should be military');
    });

    it('Spain military starts at 350000 (civilian below)', () => {
      assert.ok(!isKnownMilitaryHex('34FFFF'), '34FFFF should be civilian');
      assert.ok(isKnownMilitaryHex('350000'), '350000 should be military');
    });

    it('Canada military starts at C20000 (civilian below)', () => {
      assert.ok(!isKnownMilitaryHex('C1FFFF'), 'C1FFFF should be civilian');
      assert.ok(isKnownMilitaryHex('C20000'), 'C20000 should be military');
    });
  });

  describe('no range spans an entire country ICAO allocation', () => {
    const countryAllocations = [
      { country: 'USA', start: 'A00000', end: 'AFFFFF' },
      { country: 'Italy', start: '300000', end: '33FFFF' },
      { country: 'Spain', start: '340000', end: '37FFFF' },
      { country: 'Japan', start: '840000', end: '87FFFF' },
      { country: 'India', start: '800000', end: '83FFFF' },
      { country: 'France', start: '380000', end: '3BFFFF' },
      { country: 'Germany', start: '3C0000', end: '3FFFFF' },
      { country: 'UK', start: '400000', end: '43FFFF' },
      { country: 'Canada', start: 'C00000', end: 'C3FFFF' },
      { country: 'Australia', start: '7C0000', end: '7FFFFF' },
    ];
    for (const alloc of countryAllocations) {
      it(`no single range covers all of ${alloc.country} (${alloc.start}-${alloc.end})`, () => {
        const fullRange = HEX_RANGES.find(
          (r) => r.start <= alloc.start && r.end >= alloc.end,
        );
        assert.ok(
          !fullRange,
          `Range ${fullRange?.start}-${fullRange?.end} spans entire ${alloc.country} allocation`,
        );
      });
    }
  });
});
