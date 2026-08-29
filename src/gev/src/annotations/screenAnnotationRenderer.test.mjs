import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createScreenAnnotationRenderer } from './screenAnnotationRenderer.js';

class FakeClassList {
  constructor(owner) {
    this.owner = owner;
    this.names = new Set();
  }

  reset(value) {
    this.names = new Set(String(value || '').split(/\s+/).filter(Boolean));
  }

  add(...names) {
    for (const name of names) this.names.add(name);
    this.owner.attributes.set('class', Array.from(this.names).join(' '));
  }

  remove(...names) {
    for (const name of names) this.names.delete(name);
    this.owner.attributes.set('class', Array.from(this.names).join(' '));
  }

  contains(name) {
    return this.names.has(name);
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.classList = new FakeClassList(this);
    this.textContent = '';
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'class') this.classList.reset(value);
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  set className(value) {
    this.setAttribute('class', value);
  }

  get className() {
    return this.getAttribute('class') || '';
  }

  set id(value) {
    this.setAttribute('id', value);
  }

  get id() {
    return this.getAttribute('id') || '';
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const className = selector.startsWith('.') ? selector.slice(1) : null;
    const matches = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (className && child.classList.contains(className)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  addEventListener() {}

  getBBox() {
    return { x: 0, y: 0, width: 40, height: 16 };
  }

  set innerHTML(value) {
    this._innerHTML = value;
  }
}

function fakeDocument() {
  const head = new FakeElement('head');
  const body = new FakeElement('body');
  const roots = [head, body];
  return {
    head,
    body,
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (_namespace, tag) => new FakeElement(tag),
    getElementById(id) {
      let found = null;
      const visit = (node) => {
        if (node.getAttribute('id') === id) found = node;
        for (const child of node.children) visit(child);
      };
      for (const root of roots) visit(root);
      return found;
    },
  };
}

function findAnnotationGroup(document) {
  const layer = document.body.children.find((child) => child.classList.contains('gev-screen-whiteboard'));
  const svg = layer.children.find((child) => child.classList.contains('gev-screen-whiteboard-svg'));
  return {
    svg,
    group: svg.children.find((child) => child.classList.contains('gev-anno')),
  };
}

test('outline upgrade preserves the existing SVG group identity', (t) => {
  const originalDocument = globalThis.document;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.document = fakeDocument();
  globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalRequestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  });

  const camera = {
    positionWC: Cesium.Cartesian3.ZERO,
    directionWC: Cesium.Cartesian3.ZERO,
    positionCartographic: { height: 1000 },
  };
  const sampledAnchors = [];
  const scene = {
    camera,
    canvas: { clientWidth: 1280, clientHeight: 720, width: 1280, height: 720 },
    clampToHeightSupported: true,
    clampToHeight(world) {
      const cartographic = Cesium.Cartographic.fromCartesian(world);
      sampledAnchors.push([
        Number(Cesium.Math.toDegrees(cartographic.longitude).toFixed(4)),
        Number(Cesium.Math.toDegrees(cartographic.latitude).toFixed(4)),
      ]);
      return world;
    },
    postRender: { addEventListener() {}, removeEventListener() {} },
  };
  const renderer = createScreenAnnotationRenderer({ scene, camera, trackedEntity: null });
  const anno = {
    id: 'anno-fb3',
    type: 'area',
    color: 'primary',
    label: 'Texas',
    alpha: 1,
    anchor: { lon: -99, lat: 31, height: 0 },
    ring: null,
  };
  renderer.add(anno);
  const before = findAnnotationGroup(globalThis.document);
  assert.ok(before.group.querySelector('.gev-anno-ring'), 'pending area starts as a reticle');

  const labelProxy = Object.assign(Object.create(anno), {
    type: 'label',
    ring: null,
    anchor: { lon: -97.5, lat: 31.2, height: 0 },
  });
  renderer.update(labelProxy);
  const after = findAnnotationGroup(globalThis.document);

  assert.equal(after.group, before.group, 'the rendered group is mutated, not replaced');
  assert.deepEqual(sampledAnchors.at(-1), [-97.5, 31.2], 'the existing group projects from the re-seated anchor');
  assert.equal(after.svg.children.filter((child) => child.classList.contains('gev-anno')).length, 1);
  assert.equal(after.group.querySelector('.gev-anno-ring'), null, 'reticle rings are removed in place');
  assert.ok(after.group.querySelector('.gev-anno-callout'), 'the original callout remains in the group');
  renderer.destroy();
});

test('annotation fade consumes the actual tracked host paint rectangle after layout', (t) => {
  const originalDocument = globalThis.document;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalProjection = Cesium.SceneTransforms.worldToWindowCoordinates;
  globalThis.document = fakeDocument();
  globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
  Cesium.SceneTransforms.worldToWindowCoordinates = () => ({ x: 0, y: 0 });
  t.after(() => {
    Cesium.SceneTransforms.worldToWindowCoordinates = originalProjection;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalRequestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  });

  const positionWC = Cesium.Cartesian3.fromDegrees(0, 0, 1000);
  const directionWC = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.negate(positionWC, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const camera = { positionWC, directionWC, positionCartographic: { height: 1000 } };
  const scene = {
    camera,
    canvas: { clientWidth: 800, clientHeight: 600, width: 800, height: 600 },
    clampToHeightSupported: false,
    postRender: { addEventListener() {}, removeEventListener() {} },
  };
  const paintRectCalls = [];
  const renderer = createScreenAnnotationRenderer(
    { scene, camera, trackedEntity: null },
    {
      activeTrackedReadoutId: () => 'installations:test',
      overlayPaintRect(sourceId, entryId) {
        paintRectCalls.push({ sourceId, entryId });
        return { x: -10, y: -10, w: 120, h: 80 };
      },
    },
  );
  renderer.add({
    id: 'anno-overlap',
    type: 'label',
    color: 'primary',
    label: 'OVERLAP',
    alpha: 1,
    anchor: { lon: 0, lat: 0, height: 0 },
  });
  const { group } = findAnnotationGroup(globalThis.document);
  assert.deepEqual(paintRectCalls.at(-1), {
    sourceId: 'tracked',
    entryId: 'installations:test',
  });
  assert.ok(
    Number(group.getAttribute('opacity')) < 1,
    'final annotation bbox fades against the complete painted card rectangle',
  );
  renderer.destroy();
});

// ── Partial-add unwind (second review) ───────────────────────────────────────
//
// add() inserts the group and records it, then does more live-document work
// (draw-on wiring, the first projection pass). A throw in that tail used to
// leave an ORPHANED <g> plus a record nobody owned — the engine's rollback only
// deletes its own map entry — so re-annotating the same place stacked a second
// mark over the corpse.

test('an add that throws after inserting its group unwinds instead of orphaning it', (t) => {
  const originalDocument = globalThis.document;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalProjection = Cesium.SceneTransforms.worldToWindowCoordinates;
  globalThis.document = fakeDocument();
  globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
  t.after(() => {
    Cesium.SceneTransforms.worldToWindowCoordinates = originalProjection;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalRequestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  });

  const positionWC = Cesium.Cartesian3.fromDegrees(0, 0, 1000);
  const directionWC = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.negate(positionWC, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const camera = { positionWC, directionWC, positionCartographic: { height: 1000 } };
  const scene = {
    camera,
    canvas: { clientWidth: 1280, clientHeight: 720, width: 1280, height: 720 },
    clampToHeightSupported: false,
    postRender: { addEventListener() {}, removeEventListener() {} },
  };
  const renderer = createScreenAnnotationRenderer({ scene, camera, trackedEntity: null });
  const anno = {
    id: 'anno-partial-screen',
    type: 'pin',
    color: 'primary',
    label: 'Capitol',
    alpha: 1,
    anchor: { lon: 0, lat: 0, height: 0 },
  };

  // The group is in the document and recorded by the time add() reaches its
  // first projection pass — so a throw there is real partial state, not a
  // clean bail-out.
  Cesium.SceneTransforms.worldToWindowCoordinates = () => { throw new Error('projection failed'); };
  assert.throws(() => renderer.add(anno), /projection failed/);
  Cesium.SceneTransforms.worldToWindowCoordinates = () => ({ x: 0, y: 0 });
  const { svg } = findAnnotationGroup(globalThis.document);
  assert.equal(
    svg.children.filter((child) => child.classList.contains('gev-anno')).length,
    0,
    'the half-built group must not stay in the document',
  );

  // The id is free again: a retry draws exactly one mark, and remove() still
  // owns it (a leaked record would leave a second group behind).
  renderer.add(anno);
  assert.equal(
    svg.children.filter((child) => child.classList.contains('gev-anno')).length,
    1,
    'the retry must draw one mark, not stack over an orphan',
  );
  renderer.destroy();
});
