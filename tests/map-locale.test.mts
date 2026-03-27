import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

async function loadMapLocale() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const sourcePath = resolve(__dirname, '..', 'src', 'utils', 'map-locale.ts');
  const source = readFileSync(sourcePath, 'utf-8');
  const transformed = transformSync(source, {
    loader: 'ts',
    format: 'esm',
    target: 'es2020',
  });
  const dataUrl = `data:text/javascript;base64,${Buffer.from(transformed.code).toString('base64')}`;
  return import(dataUrl);
}

const mod = await loadMapLocale();

const {
  getLocalizedNameField,
  getLocalizedNameExpression,
  isLocalizableTextField,
  localizeMapLabels,
} = mod;

// ── FR #181: Force English map labels ────────────────────────────────

describe('getLocalizedNameField (FR #181: forced English)', () => {
  it('always returns name:en regardless of language parameter', () => {
    assert.equal(getLocalizedNameField('en'), 'name:en');
    assert.equal(getLocalizedNameField('fr'), 'name:en');
    assert.equal(getLocalizedNameField('zh'), 'name:en');
    assert.equal(getLocalizedNameField('ar'), 'name:en');
    assert.equal(getLocalizedNameField('ja'), 'name:en');
    assert.equal(getLocalizedNameField('ko'), 'name:en');
  });

  it('returns name:en for undefined/empty language', () => {
    assert.equal(getLocalizedNameField(), 'name:en');
    assert.equal(getLocalizedNameField(''), 'name:en');
    assert.equal(getLocalizedNameField(undefined), 'name:en');
  });

  it('returns name:en for unknown language codes', () => {
    assert.equal(getLocalizedNameField('xx'), 'name:en');
    assert.equal(getLocalizedNameField('invalid'), 'name:en');
  });
});

describe('getLocalizedNameExpression (FR #181: forced English)', () => {
  const expectedEnglishExpression = ['coalesce', ['get', 'name:en'], ['get', 'name']];

  it('always returns English expression regardless of language parameter', () => {
    assert.deepEqual(getLocalizedNameExpression('en'), expectedEnglishExpression);
    assert.deepEqual(getLocalizedNameExpression('fr'), expectedEnglishExpression);
    assert.deepEqual(getLocalizedNameExpression('zh'), expectedEnglishExpression);
    assert.deepEqual(getLocalizedNameExpression('ar'), expectedEnglishExpression);
    assert.deepEqual(getLocalizedNameExpression('ja'), expectedEnglishExpression);
  });

  it('returns English expression when no parameter is passed', () => {
    assert.deepEqual(getLocalizedNameExpression(), expectedEnglishExpression);
  });

  it('returns English expression for undefined/empty language', () => {
    assert.deepEqual(getLocalizedNameExpression(undefined), expectedEnglishExpression);
    assert.deepEqual(getLocalizedNameExpression(''), expectedEnglishExpression);
  });
});

// ── isLocalizableTextField ──────────────────────────────────────────

describe('isLocalizableTextField', () => {
  describe('string tokens', () => {
    it('accepts standard name tokens', () => {
      assert.equal(isLocalizableTextField('{name_en}'), true);
      assert.equal(isLocalizableTextField('{name}'), true);
      assert.equal(isLocalizableTextField('{name:latin}'), true);
      assert.equal(isLocalizableTextField('{name:en}'), true);
      assert.equal(isLocalizableTextField('{name_int}'), true);
    });

    it('rejects non-name string tokens', () => {
      assert.equal(isLocalizableTextField('{housenumber}'), false);
      assert.equal(isLocalizableTextField('{ref}'), false);
      assert.equal(isLocalizableTextField('{class}'), false);
      assert.equal(isLocalizableTextField('{route}'), false);
    });

    it('accepts mixed tokens containing a name field', () => {
      assert.equal(isLocalizableTextField('{name}\n{name:en}'), true);
    });
  });

  describe('falsy / non-object values', () => {
    it('rejects null', () => assert.equal(isLocalizableTextField(null), false));
    it('rejects undefined', () => assert.equal(isLocalizableTextField(undefined), false));
    it('rejects empty string', () => assert.equal(isLocalizableTextField(''), false));
    it('rejects false', () => assert.equal(isLocalizableTextField(false), false));
    it('rejects zero', () => assert.equal(isLocalizableTextField(0), false));
  });

  describe('expression arrays', () => {
    it('accepts expression referencing name', () => {
      assert.equal(
        isLocalizableTextField(['coalesce', ['get', 'name:en'], ['get', 'name']]),
        true,
      );
    });

    it('accepts expression referencing name_en', () => {
      assert.equal(isLocalizableTextField(['get', 'name_en']), true);
    });

    it('accepts already-localized coalesce expression', () => {
      assert.equal(
        isLocalizableTextField(['coalesce', ['get', 'name:fr'], ['get', 'name:en'], ['get', 'name']]),
        true,
      );
    });

    it('rejects expression without name references', () => {
      assert.equal(isLocalizableTextField(['get', 'ref']), false);
      assert.equal(isLocalizableTextField(['coalesce', ['get', 'class']]), false);
    });
  });

  describe('stop objects', () => {
    it('accepts stop objects with name tokens', () => {
      assert.equal(
        isLocalizableTextField({ stops: [[8, '{name_en}'], [13, '{name}']] }),
        true,
      );
    });

    it('rejects stop objects without name tokens', () => {
      assert.equal(
        isLocalizableTextField({ stops: [[8, '{ref}'], [13, '{class}']] }),
        false,
      );
    });
  });

  describe('format expressions', () => {
    it('accepts MapLibre format expressions containing name', () => {
      const formatExpr = ['format', ['get', 'name'], {}, '\n', {}, ['get', 'name:en'], { 'font-scale': 0.8 }];
      assert.equal(isLocalizableTextField(formatExpr), true);
    });
  });
});

// ── localizeMapLabels ───────────────────────────────────────────────

describe('localizeMapLabels', () => {
  /** Helper to build a mock MapLibre map for testing. */
  function createMockMap(
    layers: Array<{ id: string; type: string }>,
    textFields: Map<string, unknown>,
    opts?: { getThrows?: Set<string>; setThrows?: Set<string> },
  ) {
    const setCalls: Array<{ id: string; value: unknown }> = [];
    return {
      setCalls,
      map: {
        getStyle: () => ({ layers }),
        getLayoutProperty: (layerId: string, prop: string) => {
          assert.equal(prop, 'text-field');
          if (opts?.getThrows?.has(layerId)) throw new Error('layer removed');
          return textFields.get(layerId);
        },
        setLayoutProperty: (layerId: string, prop: string, value: unknown) => {
          assert.equal(prop, 'text-field');
          if (opts?.setThrows?.has(layerId)) throw new Error('cannot set');
          setCalls.push({ id: layerId, value });
        },
      },
    };
  }

  it('rewrites only localizable symbol text-field properties', () => {
    const layers = [
      { id: 'waterway_label', type: 'symbol' },
      { id: 'place_city', type: 'symbol' },
      { id: 'housenumber', type: 'symbol' },
      { id: 'landcover', type: 'fill' },
      { id: 'removed_during_pass', type: 'symbol' },
      { id: 'set_fails', type: 'symbol' },
    ];

    const textFields = new Map<string, unknown>([
      ['waterway_label', '{name_en}'],
      ['place_city', { stops: [[8, '{name_en}'], [13, '{name}']] }],
      ['housenumber', '{housenumber}'],
      ['set_fails', '{name}'],
    ]);

    const { map, setCalls } = createMockMap(layers, textFields, {
      getThrows: new Set(['removed_during_pass']),
      setThrows: new Set(['set_fails']),
    });

    localizeMapLabels(map);

    assert.deepEqual(
      setCalls,
      [
        { id: 'waterway_label', value: ['coalesce', ['get', 'name:en'], ['get', 'name']] },
        { id: 'place_city', value: ['coalesce', ['get', 'name:en'], ['get', 'name']] },
      ],
    );
  });

  it('is safe when style is missing', () => {
    assert.doesNotThrow(() => localizeMapLabels({ getStyle: () => null }));
    assert.doesNotThrow(() => localizeMapLabels({}));
  });

  it('is safe when map is null or undefined', () => {
    assert.doesNotThrow(() => localizeMapLabels(null));
    assert.doesNotThrow(() => localizeMapLabels(undefined));
  });

  it('handles empty layers array', () => {
    const map = { getStyle: () => ({ layers: [] }) };
    assert.doesNotThrow(() => localizeMapLabels(map));
  });

  it('skips fill/line/circle layers entirely', () => {
    const layers = [
      { id: 'water', type: 'fill' },
      { id: 'roads', type: 'line' },
      { id: 'points', type: 'circle' },
    ];
    const { map, setCalls } = createMockMap(layers, new Map());
    localizeMapLabels(map);
    assert.equal(setCalls.length, 0);
  });

  it('is idempotent — calling twice produces identical result', () => {
    const layers = [{ id: 'place_city', type: 'symbol' }];
    const textFields = new Map<string, unknown>([['place_city', '{name_en}']]);
    const { map, setCalls } = createMockMap(layers, textFields);

    localizeMapLabels(map);
    assert.equal(setCalls.length, 1);

    // Simulate the text-field being set to the coalesce expression
    textFields.set('place_city', setCalls[0]!.value);

    // Second call: should still set (expression contains "name" references)
    // but the value will be identical — no functional change
    localizeMapLabels(map);
    assert.equal(setCalls.length, 2);
    assert.deepEqual(setCalls[0]!.value, setCalls[1]!.value);
  });

  it('always uses English expression regardless of browser language (FR #181)', () => {
    const layers = [{ id: 'place_country', type: 'symbol' }];
    const textFields = new Map<string, unknown>([['place_country', '{name_en}']]);
    const setCalls: Array<{ id: string; value: unknown }> = [];
    const map = {
      getStyle: () => ({ layers }),
      getLayoutProperty: (_id: string) => textFields.get(_id),
      setLayoutProperty: (id: string, _prop: string, value: unknown) => {
        setCalls.push({ id, value });
      },
    };

    localizeMapLabels(map);

    assert.equal(setCalls.length, 1);
    // FR #181: Should always be English, never localized to other languages
    assert.deepEqual(setCalls[0]!.value, ['coalesce', ['get', 'name:en'], ['get', 'name']]);
  });
});

// ── Regression: real CARTO CDN dark-matter layer patterns ───────────

describe('CARTO dark-matter style compatibility', () => {
  // Exact text-field patterns from the live CARTO CDN style
  const CARTO_LAYERS: Array<{ id: string; type: string; tf: unknown; shouldLocalize: boolean }> = [
    { id: 'waterway_label', type: 'symbol', tf: '{name_en}', shouldLocalize: true },
    { id: 'watername_ocean', type: 'symbol', tf: '{name}', shouldLocalize: true },
    { id: 'watername_sea', type: 'symbol', tf: '{name}', shouldLocalize: true },
    { id: 'watername_lake', type: 'symbol', tf: { stops: [[8, '{name_en}'], [13, '{name}']] }, shouldLocalize: true },
    { id: 'place_hamlet', type: 'symbol', tf: { stops: [[8, '{name_en}'], [14, '{name}']] }, shouldLocalize: true },
    { id: 'place_country_1', type: 'symbol', tf: '{name_en}', shouldLocalize: true },
    { id: 'place_capital_dot_z7', type: 'symbol', tf: '{name_en}', shouldLocalize: true },
    { id: 'poi_stadium', type: 'symbol', tf: '{name}', shouldLocalize: true },
    { id: 'poi_park', type: 'symbol', tf: '{name}', shouldLocalize: true },
    { id: 'roadname_minor', type: 'symbol', tf: '{name}', shouldLocalize: true },
    { id: 'roadname_major', type: 'symbol', tf: '{name}', shouldLocalize: true },
    { id: 'housenumber', type: 'symbol', tf: '{housenumber}', shouldLocalize: false },
  ];

  for (const { id, tf, shouldLocalize } of CARTO_LAYERS) {
    it(`${shouldLocalize ? 'localizes' : 'skips'} "${id}" (text-field: ${JSON.stringify(tf).slice(0, 40)})`, () => {
      assert.equal(isLocalizableTextField(tf), shouldLocalize);
    });
  }

  it('localizes all expected layers and skips housenumber in full mock', () => {
    const layers = CARTO_LAYERS.map((l) => ({ id: l.id, type: l.type }));
    const textFields = new Map<string, unknown>(CARTO_LAYERS.map((l) => [l.id, l.tf]));
    const { map, setCalls } = createMockMap(layers, textFields);

    localizeMapLabels(map);

    const localizedIds = new Set(setCalls.map((c) => c.id));
    for (const layer of CARTO_LAYERS) {
      if (layer.shouldLocalize) {
        assert.ok(localizedIds.has(layer.id), `expected "${layer.id}" to be localized`);
      } else {
        assert.ok(!localizedIds.has(layer.id), `expected "${layer.id}" to NOT be localized`);
      }
    }
  });

  /** Helper (duplicated for this describe block) */
  function createMockMap(
    layers: Array<{ id: string; type: string }>,
    textFields: Map<string, unknown>,
  ) {
    const setCalls: Array<{ id: string; value: unknown }> = [];
    return {
      setCalls,
      map: {
        getStyle: () => ({ layers }),
        getLayoutProperty: (layerId: string) => textFields.get(layerId),
        setLayoutProperty: (layerId: string, _prop: string, value: unknown) => {
          setCalls.push({ id: layerId, value });
        },
      },
    };
  }
});

// ── RTL text plugin file existence ───────────────────────────────────

describe('RTL text plugin', () => {
  it('self-hosted mapbox-gl-rtl-text.min.js exists in public/', () => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pluginPath = resolve(__dirname, '..', 'public', 'mapbox-gl-rtl-text.min.js');
    const content = readFileSync(pluginPath, 'utf-8');
    assert.ok(content.length > 10_000, 'RTL plugin should be at least 10KB');
    // Verify it's actually the mapbox RTL plugin (contains its module signature)
    assert.ok(
      content.includes('mapboxgl') || content.includes('RTLTextPlugin') || content.includes('applyArabicShaping'),
      'RTL plugin file should contain expected identifiers',
    );
  });
});
