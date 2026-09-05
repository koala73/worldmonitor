import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import jmespath from 'jmespath';

import { TOOL_REGISTRY } from '../api/mcp/registry/index.ts';
import {
  ATTRIBUTION_RIDER_NOTICE,
  LICENCE_MARKER_FIELDS,
  REST_ATTRIBUTION_EXPRESSIONS,
  buildAttributionRider,
  findLicenceMarkerFields,
  mergeAttributionRider,
} from '../shared/attribution-rider.ts';

// Tools whose outputSchema declares a licence marker but which deliberately
// carry NO `_attribution` extraction. Every entry needs a reason, because the
// exemption is the one way a licence-bearing payload can be projected without
// the rider.
//
//   get_sources — its `license` field IS the attribution manifest. The whole
//   payload is the licence inventory for every provider WorldMonitor serves,
//   so projecting it (counting providers by licence, listing the CC-BY set)
//   is the tool working as intended, not a way to detach a value from its
//   licence. There is no separate source list to re-attach: the sources are
//   the data.
const LICENCE_MARKER_EXEMPT_TOOLS = new Set([
  'get_sources',
]);

function licenceBearingTools() {
  return TOOL_REGISTRY
    .map((tool) => ({ tool, markers: findLicenceMarkerFields(tool.outputSchema) }))
    .filter((entry) => entry.markers.length > 0);
}

describe('attribution rider — build-time gate', () => {
  test('every licence-bearing tool declares an extraction or is explicitly exempt', () => {
    const unprotected = licenceBearingTools()
      .filter(({ tool }) => (
        typeof tool._attribution !== 'string'
        && !LICENCE_MARKER_EXEMPT_TOOLS.has(tool.name)
      ))
      .map(({ tool, markers }) => `${tool.name} (${markers.join(', ')})`);

    assert.deepEqual(
      unprotected,
      [],
      'these tools ship licence fields a JMESPath projection can strip, with no '
        + '`_attribution` extraction to re-attach them and no recorded exemption:\n  '
        + unprotected.join('\n  '),
    );
  });

  test('the licence-marker scan actually finds something', () => {
    // Guards the gate itself: a walker that silently stopped matching would
    // make the assertion above vacuously true for every future tool.
    assert.ok(licenceBearingTools().length >= 4, 'expected the marker scan to find licence-bearing tools');
    assert.ok(LICENCE_MARKER_FIELDS.has('attribution'));
    assert.ok(LICENCE_MARKER_FIELDS.has('redistributionRestricted'));
  });

  test('no tool declares an extraction it does not need', () => {
    // The reverse direction. A stale `_attribution` on a tool that no longer
    // carries licence fields is dead weight charged against every projected
    // response's output budget.
    const withMarkers = new Set(licenceBearingTools().map(({ tool }) => tool.name));
    const stale = TOOL_REGISTRY
      .filter((tool) => typeof tool._attribution === 'string' && !withMarkers.has(tool.name))
      .map((tool) => tool.name);
    assert.deepEqual(stale, [], 'these tools declare `_attribution` but carry no licence marker');
  });

  test('every exempt tool still carries a licence marker', () => {
    // Keeps the allowlist honest: an entry for a tool that no longer has
    // licence fields is a stale exemption waiting to cover a future one.
    const withMarkers = new Set(licenceBearingTools().map(({ tool }) => tool.name));
    for (const name of LICENCE_MARKER_EXEMPT_TOOLS) {
      assert.ok(
        withMarkers.has(name),
        `${name} is exempted but no longer carries a licence marker — drop the exemption`,
      );
    }
  });

  test('every declared extraction is a parseable JMESPath expression', () => {
    for (const tool of TOOL_REGISTRY) {
      if (typeof tool._attribution !== 'string') continue;
      assert.doesNotThrow(
        () => jmespath.search({}, tool._attribution),
        `${tool.name} declares an unparseable _attribution expression`,
      );
    }
    for (const [path, expr] of Object.entries(REST_ATTRIBUTION_EXPRESSIONS)) {
      assert.doesNotThrow(
        () => jmespath.search({}, expr),
        `${path} declares an unparseable REST attribution expression`,
      );
    }
  });
});

describe('attribution rider — extraction against real payload shapes', () => {
  function extractionFor(name) {
    const tool = TOOL_REGISTRY.find((candidate) => candidate.name === name);
    assert.ok(tool, `${name} missing from the registry`);
    assert.equal(typeof tool._attribution, 'string', `${name} must declare _attribution`);
    return tool._attribution;
  }

  test('get_resilience_indicators flattens and dedupes indicator sources', () => {
    const source = {
      key: 'worldbank-wdi',
      name: 'World Bank WDI',
      attribution: 'World Bank',
      license: 'CC BY 4.0',
      url: 'https://data.worldbank.org',
      licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
      attributionUrl: 'https://data.worldbank.org/summary-terms-of-use',
    };
    const payload = {
      countryCode: 'DE',
      indicators: [
        // Same source cited by two indicators with DIFFERENT per-indicator
        // provenance flags — the flattened rider must carry it once.
        { id: 'a', sources: [{ ...source, observationProvenance: true }], rawValue: { available: true, numericValue: 1 } },
        { id: 'b', sources: [{ ...source, observationProvenance: false }], rawValue: { available: true, numericValue: 2 } },
        { id: 'c', sources: [{ key: 'iea', name: 'IEA', attribution: 'IEA', license: 'IEA Terms', url: 'https://iea.org', licenseUrl: '', attributionUrl: '' }] },
      ],
    };
    const rider = buildAttributionRider(payload, extractionFor('get_resilience_indicators'));
    assert.ok(rider);
    assert.equal(rider.required, true);
    assert.equal(rider.notice, ATTRIBUTION_RIDER_NOTICE);
    assert.equal(rider.sources.length, 2);
    assert.deepEqual(rider.sources[0], source);
    // Per-indicator provenance is meaningless once flattened, so the
    // extraction must not carry it into the rider.
    assert.equal('observationProvenance' in rider.sources[0], false);
    // Empty licence strings are pruned rather than shipped as noise.
    assert.deepEqual(rider.sources[1], {
      key: 'iea', name: 'IEA', attribution: 'IEA', license: 'IEA Terms', url: 'https://iea.org',
    });
  });

  test('the toronto tools extract from their cache envelopes', () => {
    const occurrences = buildAttributionRider(
      {
        cached_at: '2026-09-01T00:00:00.000Z',
        stale: false,
        data: {
          reported_occurrences: {
            semantic: 'reported_occurrence',
            source: 'tps-mci',
            attribution: 'Toronto Police Service Public Safety Data Portal',
            fetchedAt: '2026-09-01T00:00:00.000Z',
            records: [{ id: '1' }],
          },
        },
      },
      extractionFor('get_toronto_reported_occurrences'),
    );
    assert.ok(occurrences);
    assert.deepEqual(occurrences.sources, [{
      attribution: 'Toronto Police Service Public Safety Data Portal',
      source: 'tps-mci',
      fetchedAt: '2026-09-01T00:00:00.000Z',
    }]);

    const aggregates = buildAttributionRider(
      {
        cached_at: null,
        stale: true,
        data: {
          annual_aggregates: {
            semantic: 'annual_aggregate',
            source: 'tps-calls-attended',
            attribution: 'Toronto Police Service Public Safety Data Portal',
            fetchedAt: '2026-09-01T00:00:00.000Z',
            records: [],
          },
        },
      },
      extractionFor('get_toronto_calls_attended'),
    );
    assert.ok(aggregates);
    assert.deepEqual(aggregates.sources, [{
      attribution: 'Toronto Police Service Public Safety Data Portal',
      source: 'tps-calls-attended',
      fetchedAt: '2026-09-01T00:00:00.000Z',
    }]);
  });

  test('get_imd_cyclone_marine extracts its source name, url and attribution', () => {
    const rider = buildAttributionRider(
      {
        cached_at: '2026-09-05T00:00:00.000Z',
        stale: false,
        data: {
          imd_cyclone_marine: {
            coverageState: 'ok',
            cyclones: [{ id: 'BOB-01' }],
            sourceName: 'India Meteorological Department',
            sourceUrl: 'https://rsmcnewdelhi.imd.gov.in',
            attribution: 'India Meteorological Department (IMD), New Delhi',
          },
        },
      },
      extractionFor('get_imd_cyclone_marine'),
    );
    assert.ok(rider);
    assert.deepEqual(rider.sources, [{
      attribution: 'India Meteorological Department (IMD), New Delhi',
      sourceName: 'India Meteorological Department',
      sourceUrl: 'https://rsmcnewdelhi.imd.gov.in',
    }]);
  });

  test('the REST toronto expression reads the flat gateway response', () => {
    const rider = buildAttributionRider(
      {
        semantic: 'reported_occurrence',
        source: 'tps-mci',
        sourceLabel: 'TPS Major Crime Indicators',
        attribution: 'Toronto Police Service Public Safety Data Portal',
        sourceUrl: 'https://data.torontopolice.on.ca',
        fetchedAt: 1757030400000,
        occurrences: [{ id: '1' }],
        aggregates: [],
      },
      REST_ATTRIBUTION_EXPRESSIONS['/api/safety/v1/get-toronto-safety'],
    );
    assert.ok(rider);
    assert.deepEqual(rider.sources, [{
      attribution: 'Toronto Police Service Public Safety Data Portal',
      source: 'tps-mci',
      sourceUrl: 'https://data.torontopolice.on.ca',
      fetchedAt: 1757030400000,
    }]);
  });
});

describe('buildAttributionRider — contract', () => {
  test('returns null when the payload carries no sources', () => {
    assert.equal(buildAttributionRider({ data: { reported_occurrences: null } }, 'data.reported_occurrences.{attribution: attribution}'), null);
    assert.equal(buildAttributionRider(null, 'indicators[].sources[]'), null);
    assert.equal(buildAttributionRider({ indicators: [] }, 'indicators[].sources[]'), null);
    // A multiselect-hash over a payload missing every field yields all-nulls,
    // which prunes to nothing rather than shipping a rider of nulls.
    assert.equal(buildAttributionRider({ data: { x: {} } }, 'data.x.{attribution: attribution}'), null);
  });

  test('never throws on a broken expression or a hostile payload', () => {
    assert.equal(buildAttributionRider({ a: 1 }, 'this is not ][ jmespath'), null);
    assert.equal(buildAttributionRider({ a: 1 }, ''), null);
    assert.equal(buildAttributionRider({ a: 1 }, undefined), null);
    // Scalars and arrays in the extraction result are skipped, not coerced.
    assert.equal(buildAttributionRider({ xs: ['a', 'b'] }, 'xs'), null);
    assert.equal(buildAttributionRider({ xs: [[{ attribution: 'x' }]] }, 'xs'), null);
  });
});

describe('mergeAttributionRider — the rider cannot be projected away', () => {
  const rider = { required: true, notice: ATTRIBUTION_RIDER_NOTICE, sources: [{ attribution: 'A' }] };

  test('wraps the projected text without parsing it', () => {
    const merged = mergeAttributionRider('[1,2,3]', rider);
    const parsed = JSON.parse(merged);
    assert.deepEqual(parsed.data, [1, 2, 3]);
    assert.deepEqual(parsed._attribution, rider);
  });

  test('an expression that projects a literal `_attribution` key cannot displace the rider', () => {
    // The attack: name the rider key inside the projection and hope the merge
    // is an object spread that the projected value can win. It is not — the
    // rider is concatenated OUTSIDE the projected document.
    const hostile = JSON.stringify({ _attribution: { required: false, sources: [] } });
    const parsed = JSON.parse(mergeAttributionRider(hostile, rider));
    assert.deepEqual(parsed._attribution, rider);
    assert.deepEqual(parsed.data, { _attribution: { required: false, sources: [] } });
  });

  test('rides on the _jmespath_error soft-fail envelope too', () => {
    const envelope = JSON.stringify({ _jmespath_error: 'invalid_expression: bad', original_keys: ['data'] });
    const parsed = JSON.parse(mergeAttributionRider(envelope, rider));
    assert.equal(parsed.data._jmespath_error, 'invalid_expression: bad');
    assert.deepEqual(parsed._attribution, rider);
  });

  test('handles the `null` document both projection helpers coerce to', () => {
    const parsed = JSON.parse(mergeAttributionRider('null', rider));
    assert.equal(parsed.data, null);
    assert.deepEqual(parsed._attribution, rider);
  });
});
