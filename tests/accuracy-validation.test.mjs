import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function readSrc(relPath) {
  return readFileSync(resolve(root, relPath), 'utf-8');
}

// ========================================================================
// 1. Threat Classifier — keyword expansion & contextual overrides
// ========================================================================

describe('Threat classifier accuracy', () => {
  const src = readSrc('src/services/threat-classifier.ts');

  const requiredHighKeywords = [
    'explosions', 'shelling', 'clash', 'clashes', 'killed', 'massacre',
    'atrocity', 'bombardment', 'wounded', 'ambush', 'mortar', 'artillery',
    'sniper', 'mass graves', 'militia attack',
    'car bomb', 'suicide bomb', 'suicide bomber', 'suicide bombing',
    'ied', 'kidnapping', 'hostage crisis',
    'isis', 'isil', 'al-qaeda', 'al qaeda', 'boko haram', 'taliban',
  ];

  for (const kw of requiredHighKeywords) {
    it(`HIGH_KEYWORDS contains "${kw}"`, () => {
      assert.ok(src.includes(`'${kw}'`), `Missing HIGH keyword: ${kw}`);
    });
  }

  it('SHORT_KEYWORDS includes short conflict terms', () => {
    for (const kw of ['clash', 'killed', 'mortar', 'ied', 'isis', 'isil', 'sniper']) {
      assert.ok(src.includes(`'${kw}'`), `Missing SHORT keyword: ${kw}`);
    }
  });

  it('has CONTEXTUAL_OVERRIDES array', () => {
    assert.ok(src.includes('CONTEXTUAL_OVERRIDES'), 'Missing CONTEXTUAL_OVERRIDES');
  });

  it('has isContextuallySuppressed function', () => {
    assert.ok(src.includes('isContextuallySuppressed'), 'Missing isContextuallySuppressed');
  });

  it('suppresses "flood" for marathon/runners context', () => {
    assert.match(src, /flood.*marathon|marathon.*flood/s);
  });

  it('suppresses "killed" for slang usage', () => {
    // Source uses regex like /\bkilled\s+the\s+game\b/
    assert.ok(
      src.includes("keyword: 'killed'") && src.includes('game') && src.includes('vibe'),
      'Missing killed contextual suppression for slang',
    );
  });

  it('expanded exclusion list includes entertainment terms', () => {
    for (const term of ['box office', 'album', 'playlist', 'skincare', 'real estate', 'gardening']) {
      assert.ok(src.includes(`'${term}'`), `Missing exclusion: ${term}`);
    }
  });
});

// ========================================================================
// 2. CII — baseline recalibration & hotspot map fixes
// ========================================================================

describe('CII baseline accuracy', () => {
  const src = readSrc('src/services/country-instability.ts');

  it('Yemen baseline >= 85', () => {
    const match = src.match(/YE:\s*(\d+)/);
    assert.ok(match, 'Could not find YE baseline');
    assert.ok(Number(match[1]) >= 85, `YE baseline too low: ${match[1]}`);
  });

  it('Syria baseline >= 85', () => {
    const match = src.match(/SY:\s*(\d+)/);
    assert.ok(match, 'Could not find SY baseline');
    assert.ok(Number(match[1]) >= 85, `SY baseline too low: ${match[1]}`);
  });

  it('US baseline <= 20', () => {
    const match = src.match(/US:\s*(\d+)/);
    assert.ok(match, 'Could not find US baseline');
    assert.ok(Number(match[1]) <= 20, `US baseline too high: ${match[1]}`);
  });

  it('Germany baseline <= 15', () => {
    const match = src.match(/DE:\s*(\d+)/);
    assert.ok(match, 'Could not find DE baseline');
    assert.ok(Number(match[1]) <= 15, `DE baseline too high: ${match[1]}`);
  });

  it('Baghdad maps to IQ (Iraq), not IR (Iran)', () => {
    assert.match(src, /baghdad:\s*'IQ'/);
  });

  it('Beirut maps to LB (Lebanon), not IR (Iran)', () => {
    assert.match(src, /beirut:\s*'LB'/);
  });

  it('Doha maps to QA (Qatar), not SA (Saudi)', () => {
    assert.match(src, /doha:\s*'QA'/);
  });

  it('Abu Dhabi maps to AE (UAE), not SA (Saudi)', () => {
    assert.match(src, /abudhabi:\s*'AE'/);
  });
});

// ========================================================================
// 3. Anomaly detection — dual-baseline keys, EMA/anchor, short-term min
// ========================================================================

describe('Dual-baseline anomaly detection', () => {
  const shared = readSrc('server/worldmonitor/infrastructure/v1/_shared.ts');
  const record = readSrc('server/worldmonitor/infrastructure/v1/record-baseline-snapshot.ts');
  const get = readSrc('server/worldmonitor/infrastructure/v1/get-temporal-baseline.ts');

  it('defines SHORT_BASELINE_TTL', () => {
    assert.ok(shared.includes('SHORT_BASELINE_TTL'), 'Missing SHORT_BASELINE_TTL');
  });

  it('defines EMA_ALPHA', () => {
    assert.ok(shared.includes('EMA_ALPHA'), 'Missing EMA_ALPHA');
  });

  it('defines anchorMean in BaselineEntry', () => {
    assert.ok(shared.includes('anchorMean'), 'Missing anchorMean field');
  });

  it('defines emaMean in BaselineEntry', () => {
    assert.ok(shared.includes('emaMean'), 'Missing emaMean field');
  });

  it('defines makeShortBaselineKey', () => {
    assert.ok(shared.includes('makeShortBaselineKey'), 'Missing makeShortBaselineKey');
  });

  it('defines getDualBaselineSeverity', () => {
    assert.ok(shared.includes('getDualBaselineSeverity'), 'Missing getDualBaselineSeverity');
  });

  it('record-baseline writes to short-term keys', () => {
    assert.ok(record.includes('makeShortBaselineKey'), 'record-baseline does not use short keys');
    assert.ok(record.includes('SHORT_BASELINE_TTL'), 'record-baseline does not use SHORT_BASELINE_TTL');
  });

  it('record-baseline computes EMA', () => {
    assert.ok(record.includes('EMA_ALPHA'), 'record-baseline does not compute EMA');
    assert.ok(record.includes('emaMean'), 'record-baseline does not store emaMean');
  });

  it('record-baseline computes anchor mean', () => {
    assert.ok(record.includes('anchorMean'), 'record-baseline does not store anchorMean');
    assert.ok(record.includes('ANCHOR_FREEZE_COUNT'), 'record-baseline does not use ANCHOR_FREEZE_COUNT');
  });

  it('get-temporal-baseline fetches both baselines', () => {
    assert.ok(get.includes('makeShortBaselineKey'), 'get-temporal does not fetch short baseline');
    assert.ok(get.includes('Promise.all'), 'get-temporal does not fetch in parallel');
  });

  it('short-term min samples < 10', () => {
    const match = shared.match(/MIN_SAMPLES_SHORT\s*=\s*(\d+)/);
    assert.ok(match, 'Could not find MIN_SAMPLES_SHORT');
    assert.ok(Number(match[1]) < 10, `MIN_SAMPLES_SHORT too high: ${match[1]}`);
  });

  it('get-temporal-baseline uses anchor mean for boiling frog detection', () => {
    assert.ok(get.includes('anchorMean'), 'get-temporal does not reference anchorMean');
  });
});

// ========================================================================
// 4. Geo-convergence — region overrides
// ========================================================================

describe('Geo-convergence per-region thresholds', () => {
  const src = readSrc('src/services/geo-convergence.ts');

  it('defines REGION_OVERRIDES', () => {
    assert.ok(src.includes('REGION_OVERRIDES'), 'Missing REGION_OVERRIDES');
  });

  it('defines getThresholdForCell function', () => {
    assert.ok(src.includes('getThresholdForCell'), 'Missing getThresholdForCell');
  });

  it('Taiwan Strait threshold >= 4', () => {
    const match = src.match(/Taiwan Strait.*?(\d+)/s);
    assert.ok(match, 'Could not find Taiwan Strait override');
    assert.ok(Number(match[1]) >= 4, `Taiwan Strait threshold too low: ${match[1]}`);
  });

  it('detectGeoConvergence uses per-cell thresholds', () => {
    assert.ok(src.includes('getThresholdForCell('), 'detectGeoConvergence does not call getThresholdForCell');
  });

  it('Sahel has lower threshold than default (<=3)', () => {
    assert.ok(src.includes('Sahel'), 'Missing Sahel region override');
    // REGION_OVERRIDES format: [minLat, maxLat, minLon, maxLon, threshold, label]
    // Find the line with Sahel and extract the 5th element (threshold)
    const sahelLine = src.split('\n').find(l => l.includes('Sahel'));
    assert.ok(sahelLine, 'Could not find Sahel line');
    const nums = sahelLine.match(/[\d.-]+/g);
    // 5th number is the threshold (after minLat, maxLat, minLon, maxLon)
    assert.ok(nums && nums.length >= 5, 'Could not parse Sahel numbers');
    const threshold = Number(nums[4]);
    assert.ok(threshold <= 3, `Sahel threshold should be <= 3, got ${threshold}`);
  });
});

// ========================================================================
// 5. Military bases — data fixes
// ========================================================================

describe('Military base data accuracy', () => {
  const src = readSrc('src/config/bases-expanded.ts');

  it('Diego Garcia latitude is negative (Southern Hemisphere)', () => {
    const match = src.match(/diego_garcia.*?lat:\s*([-\d.]+)/si);
    assert.ok(match, 'Could not find Diego Garcia');
    assert.ok(Number(match[1]) < 0, `Diego Garcia lat should be negative, got ${match[1]}`);
  });

  it('Camp Victory status is closed', () => {
    const match = src.match(/camp_victory.*?status:\s*'(\w+)'/si);
    assert.ok(match, 'Could not find Camp Victory');
    assert.equal(match[1], 'closed');
  });

  it('Camp Victory description mentions "Closed 2011"', () => {
    const match = src.match(/camp_victory.*?description:\s*'([^']+)'/si);
    assert.ok(match, 'Could not find Camp Victory description');
    assert.ok(match[1].includes('Closed 2011'), `Description should mention Closed 2011`);
  });

  it('no instances of "Quatar" (should be "Qatar")', () => {
    assert.ok(!src.includes('Quatar'), 'Found misspelling "Quatar"');
  });

  it('no instances of "United Kingdoms" (should be "United Kingdom")', () => {
    assert.ok(!src.includes('United Kingdoms'), 'Found misspelling "United Kingdoms"');
  });

  it('Al Udeid country is Qatar', () => {
    const match = src.match(/al_udeid.*?country:\s*'([^']+)'/si);
    assert.ok(match, 'Could not find Al Udeid');
    assert.equal(match[1], 'Qatar');
  });

  it('French Chad base is closed', () => {
    const match = src.match(/ndjamena.*?status:\s*'(\w+)'/si);
    assert.ok(match);
    assert.equal(match[1], 'closed');
  });

  it('French Niger base is closed', () => {
    const match = src.match(/niamey.*?status:\s*'(\w+)'/si);
    assert.ok(match);
    assert.equal(match[1], 'closed');
  });

  it('Niger Air Base 201 is closed (US withdrawal 2024)', () => {
    const match = src.match(/niger_air_base_201.*?status:\s*'(\w+)'/si);
    assert.ok(match, 'Could not find Niger Air Base 201');
    assert.equal(match[1], 'closed');
  });

  it('Italian Afghanistan base is closed with correct name', () => {
    assert.ok(src.includes('Herat Military Base'), 'Herat name not fixed');
    assert.ok(!src.includes('Heart miliraty'), 'Old typo still present');
  });

  it('Japan Djibouti base has correct arm field', () => {
    const match = src.match(/japan_selfdefense.*?arm:\s*'([^']+)'/si);
    assert.ok(match);
    assert.ok(match[1].includes('Japan'), `arm should mention Japan, got: ${match[1]}`);
  });

  it('no instances of "militaray" typo', () => {
    assert.ok(!src.includes('militaray'), 'Found typo "militaray"');
  });
});

// ========================================================================
// 6. Signal aggregator — bounding box ordering
// ========================================================================

describe('Signal aggregator country attribution', () => {
  const src = readSrc('src/services/signal-aggregator.ts');

  it('Taiwan check comes before China check', () => {
    // Search within coordsToCountry method body only (return 'TW' / return 'CN')
    const methodStart = src.indexOf('coordsToCountry');
    assert.ok(methodStart > 0, 'Could not find coordsToCountry method');
    const methodBody = src.slice(methodStart);
    const twIdx = methodBody.indexOf("return 'TW'");
    const cnIdx = methodBody.indexOf("return 'CN'");
    assert.ok(twIdx > 0 && cnIdx > 0, 'Could not find TW/CN returns in coordsToCountry');
    assert.ok(twIdx < cnIdx, 'Taiwan must be checked before China');
  });

  it('Pakistan check comes before India check', () => {
    const methodStart = src.indexOf('coordsToCountry');
    assert.ok(methodStart > 0, 'Could not find coordsToCountry method');
    const methodBody = src.slice(methodStart);
    const pkIdx = methodBody.indexOf("return 'PK'");
    const inIdx = methodBody.indexOf("return 'IN'");
    assert.ok(pkIdx > 0 && inIdx > 0, 'Could not find PK/IN returns in coordsToCountry');
    assert.ok(pkIdx < inIdx, 'Pakistan must be checked before India');
  });

  it('South Korea check comes before North Korea (Seoul must resolve to KR)', () => {
    const methodStart = src.indexOf('coordsToCountry');
    assert.ok(methodStart > 0, 'Could not find coordsToCountry method');
    const methodBody = src.slice(methodStart);
    const krIdx = methodBody.indexOf("return 'KR'");
    const kpIdx = methodBody.indexOf("return 'KP'");
    assert.ok(krIdx > 0 && kpIdx > 0, 'Could not find KR/KP returns');
    assert.ok(krIdx < kpIdx, 'South Korea must be checked before North Korea');
  });

  it('North Korea south boundary excludes Seoul (>= 39)', () => {
    const methodStart = src.indexOf('coordsToCountry');
    const methodBody = src.slice(methodStart);
    // Find the NK line (return 'KP') and extract latitude bound
    const kpLine = methodBody.split('\n').find(l => l.includes("return 'KP'"));
    assert.ok(kpLine, 'Could not find KP bounding box');
    const latMatch = kpLine.match(/lat\s*>=\s*([\d.]+)/);
    assert.ok(latMatch, 'Could not parse NK south latitude');
    assert.ok(Number(latMatch[1]) >= 39, `NK south boundary ${latMatch[1]} too low — would catch Seoul at 37.56°N`);
  });

  it('Pakistan east boundary excludes western India (<= 74)', () => {
    const methodStart = src.indexOf('coordsToCountry');
    const methodBody = src.slice(methodStart);
    const pkLine = methodBody.split('\n').find(l => l.includes("return 'PK'"));
    assert.ok(pkLine, 'Could not find PK bounding box');
    const lonMatch = pkLine.match(/lon\s*<=\s*([\d.]+)/);
    assert.ok(lonMatch, 'Could not parse PK east longitude');
    assert.ok(Number(lonMatch[1]) <= 74, `PK east boundary ${lonMatch[1]} too wide — would catch Mumbai at 72.8°E`);
  });

  it('includes Japan bounding box', () => {
    assert.ok(src.includes("'JP'"), 'Missing Japan (JP) bounding box');
  });

  it('includes Brazil bounding box', () => {
    assert.ok(src.includes("'BR'"), 'Missing Brazil (BR) bounding box');
  });
});

// ========================================================================
// 7. Country instability — round 2 fixes
// ========================================================================

describe('CII round 2 fixes', () => {
  const src = readSrc('src/services/country-instability.ts');

  it('Brussels maps to BE (Belgium)', () => {
    assert.match(src, /brussels:\s*'BE'/);
  });

  it('Myanmar keywords include yangon', () => {
    assert.ok(src.includes("'yangon'"), 'Missing yangon keyword for Myanmar');
  });

  it('COD substring fallback removed', () => {
    assert.ok(!src.includes('substring(0, 2)'), 'Dangerous substring fallback still present');
  });

  it('ZONE_COUNTRY_MAP includes Taiwan Strait', () => {
    assert.ok(src.includes("'Taiwan Strait'"), 'Missing Taiwan Strait in ZONE_COUNTRY_MAP');
  });

  it('ZONE_COUNTRY_MAP includes Horn of Africa', () => {
    assert.ok(src.includes("'Horn of Africa'"), 'Missing Horn of Africa in ZONE_COUNTRY_MAP');
  });
});

// ========================================================================
// 8. Military tracking fixes
// ========================================================================

describe('Military tracking accuracy', () => {
  const flights = readSrc('src/services/military-flights.ts');
  const vessels = readSrc('src/services/military-vessels.ts');
  const military = readSrc('src/config/military.ts');

  it('RAF/RN operator returns GB not UK', () => {
    assert.ok(flights.includes("raf: 'GB'"), 'RAF should map to GB');
    assert.ok(flights.includes("rn: 'GB'"), 'RN should map to GB');
  });

  it('militaryCountries includes Russia and China', () => {
    assert.ok(flights.includes("'Russia'"), 'Missing Russia from militaryCountries');
    assert.ok(flights.includes("'China'"), 'Missing China from militaryCountries');
  });

  it('MID 303 maps to USA not Alaska', () => {
    assert.ok(!vessels.includes("'Alaska'"), 'MID 303 should not map to Alaska');
  });

  it('no country: UK in military config (should be GB)', () => {
    assert.ok(!military.includes("country: 'UK'"), 'Found country UK, should be GB');
  });
});

// ========================================================================
// 9. Conflict service fixes
// ========================================================================

describe('Conflict service accuracy', () => {
  const src = readSrc('src/services/conflict/index.ts');

  it('ISO3_TO_ISO2 includes BRA and ARE', () => {
    assert.ok(src.includes("BRA: 'BR'"), 'Missing BRA→BR mapping');
    assert.ok(src.includes("ARE: 'AE'"), 'Missing ARE→AE mapping');
  });

  it('UCDP war threshold does not use eventCount alone', () => {
    assert.ok(!src.includes('eventCount > 100'), 'eventCount > 100 as war trigger is not UCDP methodology');
  });
});

// ========================================================================
// 10. Geo config freshness
// ========================================================================

describe('Geo config accuracy', () => {
  const geo = readSrc('src/config/geo.ts');
  const airports = readSrc('src/config/airports.ts');

  it('Taiwan Strait lon >= 119.8', () => {
    const match = geo.match(/taiwan_strait.*?lon:\s*([\d.]+)/si);
    assert.ok(match);
    assert.ok(Number(match[1]) >= 119.8, `Taiwan Strait lon too low: ${match[1]}`);
  });

  it('Palisades nuclear plant is construction (restart pending)', () => {
    const match = geo.match(/palisades.*?status:\s*'(\w+)'/si);
    assert.ok(match);
    assert.equal(match[1], 'construction');
  });

  it('Pickering nuclear plant is active (units 5-8 operating)', () => {
    const match = geo.match(/pickering.*?status:\s*'(\w+)'/si);
    assert.ok(match);
    assert.equal(match[1], 'active');
  });

  it('Mexico City airport uses MMMX ICAO code (Benito Juárez)', () => {
    const match = airports.match(/MEX.*?icao:\s*'(\w+)'/si);
    assert.ok(match);
    assert.equal(match[1], 'MMMX');
  });

  it('Damascus description mentions post-Assad', () => {
    const match = geo.match(/damascus.*?description:\s*'([^']+)'/si);
    assert.ok(match);
    assert.ok(match[1].toLowerCase().includes('assad'), 'Should reference Assad transition');
  });

  it('Beirut keywords include qassem (not nasrallah)', () => {
    // Find beirut hotspot keywords
    assert.ok(geo.includes("'qassem'"), 'Missing qassem in Beirut keywords');
  });

  it('Beijing lastMajorEventDate is 2024 or later', () => {
    const match = geo.match(/id:\s*'beijing'[\s\S]*?lastMajorEventDate:\s*'(\d{4})/);
    assert.ok(match, 'Could not find Beijing lastMajorEventDate');
    assert.ok(Number(match[1]) >= 2024, `Beijing event date too old: ${match[1]}`);
  });

  it('Kyiv lastMajorEventDate is 2024 or later', () => {
    const match = geo.match(/id:\s*'kyiv'[\s\S]*?lastMajorEventDate:\s*'(\d{4})/);
    assert.ok(match, 'Could not find Kyiv lastMajorEventDate');
    assert.ok(Number(match[1]) >= 2024, `Kyiv event date too old: ${match[1]}`);
  });

  it('Taipei lastMajorEventDate is 2024 or later', () => {
    const match = geo.match(/id:\s*'taipei'[\s\S]*?lastMajorEventDate:\s*'(\d{4})/);
    assert.ok(match, 'Could not find Taipei lastMajorEventDate');
    assert.ok(Number(match[1]) >= 2024, `Taipei event date too old: ${match[1]}`);
  });
});

// ========================================================================
// 11. TIER1 coverage and zone mapping accuracy
// ========================================================================

describe('TIER1 country coverage', () => {
  const countries = readSrc('src/config/countries.ts');
  const cii = readSrc('src/services/country-instability.ts');
  const serverShared = readSrc('server/worldmonitor/intelligence/v1/_shared.ts');
  const serverRisk = readSrc('server/worldmonitor/intelligence/v1/get-risk-scores.ts');
  const agg = readSrc('src/services/signal-aggregator.ts');

  for (const code of ['AF', 'SD', 'SO', 'ET', 'IQ']) {
    it(`TIER1_COUNTRIES includes ${code}`, () => {
      assert.ok(countries.includes(`${code}:`), `Missing ${code} in TIER1_COUNTRIES`);
    });

    it(`BASELINE_RISK includes ${code}`, () => {
      assert.ok(cii.includes(`${code}:`), `Missing ${code} in client BASELINE_RISK`);
    });

    it(`server TIER1 includes ${code}`, () => {
      assert.ok(serverShared.includes(`${code}:`), `Missing ${code} in server TIER1`);
    });

    it(`server BASELINE_RISK includes ${code}`, () => {
      assert.ok(serverRisk.includes(`${code}:`), `Missing ${code} in server BASELINE_RISK`);
    });

    it(`signal aggregator has ${code} bounding box`, () => {
      const methodStart = agg.indexOf('coordsToCountry');
      const methodBody = agg.slice(methodStart);
      assert.ok(methodBody.includes(`return '${code}'`), `Missing ${code} bounding box in coordsToCountry`);
    });
  }
});

describe('ZONE_COUNTRY_MAP accuracy', () => {
  const cii = readSrc('src/services/country-instability.ts');

  it('Sahel maps to correct African countries (not MM)', () => {
    const match = cii.match(/'Sahel':\s*\[([^\]]+)\]/);
    assert.ok(match, 'Could not find Sahel zone mapping');
    assert.ok(!match[1].includes("'MM'"), 'Sahel should not map to Myanmar');
    assert.ok(match[1].includes("'ML'"), 'Sahel should include Mali');
    assert.ok(match[1].includes("'BF'"), 'Sahel should include Burkina Faso');
    assert.ok(match[1].includes("'NE'"), 'Sahel should include Niger');
  });

  it('Central Africa maps to correct countries (not MM)', () => {
    const match = cii.match(/'Central Africa':\s*\[([^\]]+)\]/);
    assert.ok(match, 'Could not find Central Africa zone mapping');
    assert.ok(!match[1].includes("'MM'"), 'Central Africa should not map to Myanmar');
    assert.ok(match[1].includes("'CF'"), 'Central Africa should include CAR');
    assert.ok(match[1].includes("'CD'"), 'Central Africa should include DRC');
  });

  it('Horn of Africa includes ET and SO (not YE/SA)', () => {
    const match = cii.match(/'Horn of Africa':\s*\[([^\]]+)\]/);
    assert.ok(match, 'Could not find Horn of Africa zone mapping');
    assert.ok(match[1].includes("'ET'"), 'Horn of Africa should include Ethiopia');
    assert.ok(match[1].includes("'SO'"), 'Horn of Africa should include Somalia');
    assert.ok(!match[1].includes("'SA'"), 'Horn of Africa should not include Saudi Arabia');
  });

  it('zoneCountries includes yemen_redsea', () => {
    assert.ok(cii.includes('yemen_redsea:'), 'Missing yemen_redsea in conflict zone countries');
  });

  it('zoneCountries includes south_lebanon', () => {
    assert.ok(cii.includes('south_lebanon:'), 'Missing south_lebanon in conflict zone countries');
  });

  it('sudan conflict zone maps to SD', () => {
    const match = cii.match(/sudan:\s*\[([^\]]+)\]/);
    assert.ok(match, 'Could not find sudan zone mapping');
    assert.ok(match[1].includes("'SD'"), 'Sudan zone should map to SD');
  });
});
