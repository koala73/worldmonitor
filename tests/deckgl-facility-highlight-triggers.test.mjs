/**
 * Renderer-attribute coverage for the static facility IconLayers (#7777).
 *
 * DeckGLMap runs in a browser (DOM + WebGL) and cannot be instantiated in
 * node:test. These tests therefore import the real compiled deck.gl
 * layer classes and exercise the exact construction semantics the map's
 * layer builders must keep:
 *
 *  1. `diffProps()` against matched old/new IconLayer props — the same
 *     function deck.gl calls when matching layers by id across renders —
 *     must invalidate `getSize`/`getColor` attributes when the highlight
 *     signature changes, and must NOT invalidate them on unchanged renders.
 *     A Set object reference alone is insufficient (in-place mutation keeps
 *     the reference), so the builders must pass the sorted-content
 *     signature, not the Set.
 *  2. A signature helper replicating `getSetSignature()` must stay stable
 *     across repeated unchanged renders (same content -> same string, so no
 *     spurious invalidation) and must change on add/remove/clear/expiry.
 *  3. The builder source must reuse stable filtered data arrays and pass
 *     the signature into `updateTriggers.getSize`/`getColor` for both the
 *     nuclear and datacenter builders.
 *
 * Calling the accessors directly or comparing arrays alone cannot detect the
 * demonstrated failure (probe: array reuse without triggers left nuclear
 * size 11 instead of highlighted 15 and datacenter size 10 instead of 14,
 * with stale colors), so (1) inspects the real attribute-invalidation path.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const deckGlMapSrc = readFileSync(resolve(ROOT, 'src/components/DeckGLMap.ts'), 'utf-8');

const { default: IconLayer } = await import(
  resolve(ROOT, 'node_modules/@deck.gl/layers/dist/index.js')
).then((m) => ({ default: m.IconLayer }));
const { diffProps } = await import(
  resolve(ROOT, 'node_modules/@deck.gl/core/dist/lifecycle/props.js')
);

// ---------- fixture: mirror of the in-class getSetSignature ----------
function getSetSignature(set) {
  return [...set].sort().join('|');
}

function makeFacilityProps({ data, size, color, highlights }) {
  const highlighted = highlights;
  return {
    id: 'probe-layer',
    data,
    getSize: (d) => (highlighted.has(d.id) ? size.highlight : size.base),
    getColor: (d) => (highlighted.has(d.id) ? color.highlight : color.base),
    updateTriggers: {
      getSize: getSetSignature(highlights),
      getColor: getSetSignature(highlights),
    },
  };
}

function facilityInvalidation(oldProps, newProps) {
  const data = [{ id: 'a' }, { id: 'b' }];
  const flags = diffProps(
    new IconLayer({ ...makeFacilityProps(newProps), data }).props,
    new IconLayer({ ...makeFacilityProps(oldProps), data }).props,
  );
  return flags.updateTriggersChanged || false;
}

const SIZE = { base: 11, highlight: 15 };
const COLOR = { base: [255, 220, 0, 200], highlight: [255, 100, 100, 220] };

// ---------- signature stability ----------

describe('facility highlight signature (mirrors getSetSignature)', () => {
  it('is stable across repeated unchanged renders', () => {
    const highlights = new Set(['a']);
    const data = [{ id: 'a' }];
    const first = makeFacilityProps({ data, size: SIZE, color: COLOR, highlights });
    const second = makeFacilityProps({ data, size: SIZE, color: COLOR, highlights });
    assert.equal(second.updateTriggers.getSize, first.updateTriggers.getSize);
    assert.equal(
      facilityInvalidation(
        { data, size: SIZE, color: COLOR, highlights },
        { data, size: SIZE, color: COLOR, highlights },
      ),
      false,
      'unchanged renders must not invalidate size/color attributes',
    );
  });

  it('changes on highlight add, remove, clear, and timed expiry', () => {
    const base = getSetSignature(new Set());
    const added = getSetSignature(new Set(['a']));
    const removed = getSetSignature(new Set());
    assert.notEqual(added, base, 'add must change the signature');
    assert.equal(removed, base, 'remove/clear must restore the empty signature');

    // Timed expiry deletes the id in place — same Set object, new content.
    const live = new Set(['a']);
    const beforeExpiry = getSetSignature(live);
    live.delete('a');
    assert.notEqual(getSetSignature(live), beforeExpiry, 'expiry must change the signature');
  });

  it('a Set object reference alone does not invalidate after in-place mutation', () => {
    const data = [{ id: 'a' }];
    const highlights = new Set();
    const mkWithSetRef = (set) =>
      new IconLayer({
        id: 'probe-layer',
        data,
        getSize: (d) => (set.has(d.id) ? SIZE.highlight : SIZE.base),
        updateTriggers: { getSize: set, getColor: set },
      }).props;
    const before = mkWithSetRef(highlights);
    highlights.add('a'); // in-place mutation: same reference, new content
    const after = mkWithSetRef(highlights);
    assert.equal(
      diffProps(after, before).updateTriggersChanged,
      false,
      'passing the Set itself as a trigger value cannot detect in-place mutation',
    );
  });

  it('invalidates size and color when the signature changes', () => {
    const data = [{ id: 'a' }];
    const changed = facilityInvalidation(
      { data, size: SIZE, color: COLOR, highlights: new Set() },
      { data, size: SIZE, color: COLOR, highlights: new Set(['a']) },
    );
    assert.deepEqual(changed, { getSize: true, getColor: true });
  });

  it('the new accessor values read highlighted after the signature change', () => {
    const highlights = new Set(['a']);
    const props = makeFacilityProps({ data: [], size: SIZE, color: COLOR, highlights });
    assert.equal(props.getSize({ id: 'a' }), SIZE.highlight);
    assert.deepEqual(props.getColor({ id: 'a' }), COLOR.highlight);
    assert.equal(props.getSize({ id: 'b' }), SIZE.base);
  });
});

// ---------- builder source contract ----------

function methodSource(name) {
  const start = deckGlMapSrc.indexOf(name);
  assert.ok(start >= 0, `${name} must exist in DeckGLMap.ts`);
  const braceStart = deckGlMapSrc.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < deckGlMapSrc.length; i++) {
    if (deckGlMapSrc[i] === '{') depth++;
    else if (deckGlMapSrc[i] === '}') {
      depth--;
      if (depth === 0) return deckGlMapSrc.slice(start, i + 1);
    }
  }
  assert.fail(`${name} must have balanced braces`);
}

describe('facility layer builders (#7777)', () => {
  for (const [method, getter, catalog] of [
    ['private createNuclearLayer', 'getActiveNuclearFacilities', 'NUCLEAR_FACILITIES'],
    ['private createDatacentersLayer', 'getActiveDatacenters', 'AI_DATA_CENTERS'],
  ]) {
    it(`${method} reuses a stable filtered catalog array`, () => {
      const src = methodSource(method);
      assert.doesNotMatch(
        src,
        /\.filter\(/,
        `${method} must not allocate a fresh filtered array on every render`,
      );
      assert.match(
        src,
        new RegExp(`const data = this\\.${getter}\\(\\);`),
        `${method} must read the cached catalog array via ${getter}()`,
      );
      const getterSrc = methodSource(`private ${getter}`);
      assert.match(
        getterSrc,
        new RegExp(`${catalog}\\.filter\\([^)]*status !== 'decommissioned'`),
        `${getter} must keep the decommissioned-status filter`,
      );
      assert.match(
        getterSrc,
        /\?\?=/,
        `${getter} must cache the filtered array so the reference stays stable`,
      );
    });

    it(`${method} invalidates size and color from the highlight signature`, () => {
      const src = methodSource(method);
      assert.match(
        src,
        /const highlightSignature = this\.getSetSignature\(highlighted\w+\);/,
        `${method} must derive the sorted-content signature from the highlight Set`,
      );
      assert.match(
        src,
        /updateTriggers:\s*{\s*getSize:\s*highlightSignature,\s*getColor:\s*highlightSignature\s*}/,
        `${method} must pass the signature into updateTriggers.getSize/getColor`,
      );
    });
  }

  it('highlight mutations (add/remove/clear/expiry) flow through highlightAssets/flashAssets', () => {
    assert.match(deckGlMapSrc, /public highlightAssets\(assets/);
    assert.match(deckGlMapSrc, /public flashAssets\(assetType/);
    // flashAssets timed expiry mutates the same Set in place — the signature
    // derived at build time is what lets deck.gl see it.
    assert.match(deckGlMapSrc, /setTimeout\(\(\) => \{\s*ids\.forEach\(id => this\.highlightedAssets/);
  });
});
