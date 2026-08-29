import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createHybridAnnotationRenderer } from './hybridAnnotationRenderer.js';

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

function cameraLookingAt(lon, lat) {
  const target = Cesium.Cartesian3.fromDegrees(lon, lat);
  const radial = Cesium.Cartesian3.normalize(target, new Cesium.Cartesian3());
  const position = Cesium.Cartesian3.multiplyByScalar(
    radial,
    Cesium.Cartesian3.magnitude(target) + 1_000_000,
    new Cesium.Cartesian3(),
  );
  const direction = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(target, position, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const right = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.cross(direction, Cesium.Cartesian3.UNIT_Z, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const up = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.cross(right, direction, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const frustum = new Cesium.PerspectiveFrustum({
    fov: Cesium.Math.toRadians(60),
    aspectRatio: 1280 / 720,
    near: 1,
    far: 20_000_000,
  });
  return {
    positionWC: position,
    directionWC: direction,
    rightWC: right,
    upWC: up,
    viewMatrix: Cesium.Matrix4.computeView(
      position,
      direction,
      up,
      right,
      new Cesium.Matrix4(),
    ),
    frustum,
    positionCartographic: { height: 1_000_000 },
  };
}

/** Install the browser globals both renderers touch, restored after the test. */
function installBrowserGlobals(t) {
  const originalDocument = globalThis.document;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalWindow = globalThis.window;
  const originalBrowserConstructors = new Map([
    ['HTMLCanvasElement', globalThis.HTMLCanvasElement],
    ['HTMLImageElement', globalThis.HTMLImageElement],
    ['ImageBitmap', globalThis.ImageBitmap],
    ['OffscreenCanvas', globalThis.OffscreenCanvas],
  ]);
  globalThis.document = fakeDocument();
  globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
  globalThis.window = { setTimeout: (fn) => { fn(); return 1; } };
  for (const name of originalBrowserConstructors.keys()) globalThis[name] = class {};
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalRequestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    for (const [name, original] of originalBrowserConstructors) {
      if (original === undefined) delete globalThis[name];
      else globalThis[name] = original;
    }
  });
}

/** A viewer whose scene/camera is just enough for both sub-renderers. */
function fakeViewer(lon, lat) {
  const camera = cameraLookingAt(lon, lat);
  const dataSources = [];
  const scene = {
    camera,
    canvas: { clientWidth: 1280, clientHeight: 720, width: 1280, height: 720 },
    frameState: { mode: Cesium.SceneMode.SCENE3D },
    clampToHeightSupported: true,
    clampToHeight: (world) => world,
    postRender: { addEventListener() {}, removeEventListener() {} },
  };
  return {
    dataSources,
    viewer: {
      scene,
      camera,
      trackedEntity: null,
      dataSources: {
        add(dataSource) {
          dataSources.push(dataSource);
          return dataSource;
        },
        remove(dataSource) {
          const index = dataSources.indexOf(dataSource);
          if (index >= 0) dataSources.splice(index, 1);
          return index >= 0;
        },
      },
    },
  };
}

function annotationGroups(svg) {
  return svg.children.filter((child) => child.classList.contains('gev-anno'));
}

function naiveRingCentroid(ring) {
  const totals = ring.reduce(
    (sum, [lon, lat]) => ({ lon: sum.lon + lon, lat: sum.lat + lat }),
    { lon: 0, lat: 0 },
  );
  return { lon: totals.lon / ring.length, lat: totals.lat / ring.length, height: 0 };
}

test('hybrid outline upgrade preserves the screen group and adds world geometry', (t) => {
  const originalDocument = globalThis.document;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalBrowserConstructors = new Map([
    ['HTMLCanvasElement', globalThis.HTMLCanvasElement],
    ['HTMLImageElement', globalThis.HTMLImageElement],
    ['ImageBitmap', globalThis.ImageBitmap],
    ['OffscreenCanvas', globalThis.OffscreenCanvas],
  ]);
  globalThis.document = fakeDocument();
  globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
  for (const name of originalBrowserConstructors.keys()) globalThis[name] = class {};
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalRequestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    for (const [name, original] of originalBrowserConstructors) {
      if (original === undefined) delete globalThis[name];
      else globalThis[name] = original;
    }
  });

  const camera = cameraLookingAt(-99, 31);
  const dataSources = [];
  const scene = {
    camera,
    canvas: { clientWidth: 1280, clientHeight: 720, width: 1280, height: 720 },
    frameState: { mode: Cesium.SceneMode.SCENE3D },
    clampToHeightSupported: true,
    clampToHeight: (world) => world,
    postRender: { addEventListener() {}, removeEventListener() {} },
  };
  const viewer = {
    scene,
    camera,
    trackedEntity: null,
    dataSources: {
      add(dataSource) {
        dataSources.push(dataSource);
        return dataSource;
      },
      remove(dataSource) {
        const index = dataSources.indexOf(dataSource);
        if (index >= 0) dataSources.splice(index, 1);
        return index >= 0;
      },
    },
  };
  const renderer = createHybridAnnotationRenderer(viewer);
  const anno = {
    id: 'anno-hybrid-fb3',
    type: 'area',
    color: 'primary',
    label: 'Texas',
    alpha: 1,
    anchor: { lon: -99, lat: 31, height: 0 },
    ring: null,
    footprintKind: null,
    synthesized: false,
  };

  renderer.add(anno);
  const before = findAnnotationGroup(globalThis.document);
  const originalCallout = before.group.querySelector('.gev-anno-callout');
  const originalDot = before.group.querySelector('.gev-anno-dot');
  assert.equal(before.group.querySelectorAll('.gev-anno-ring').length, 2);
  assert.equal(dataSources.length, 1);
  assert.equal(dataSources[0].entities.values.length, 0);

  const ring = [
    [-106, 25],
    [-93, 25],
    [-93, 36],
    [-106, 36],
    [-106, 25],
  ];
  const centroid = naiveRingCentroid(ring);
  anno.ring = ring;
  anno.anchor = centroid;
  anno.footprintKind = 'area';
  renderer.update(anno);

  const after = findAnnotationGroup(globalThis.document);
  const expectedWindow = Cesium.SceneTransforms.worldToWindowCoordinates(
    scene,
    Cesium.Cartesian3.fromDegrees(centroid.lon, centroid.lat, centroid.height),
  );
  assert.equal(after.group, before.group, 'the real hybrid keeps the existing SVG group');
  assert.equal(after.svg.children.filter((child) => child.classList.contains('gev-anno')).length, 1);
  assert.equal(after.group.querySelectorAll('.gev-anno-ring').length, 0, 'screen reticle rings are removed');
  assert.equal(after.group.querySelector('.gev-anno-callout'), originalCallout, 'the callout node is retained');
  assert.equal(after.group.querySelector('.gev-anno-dot'), originalDot, 'the anchor dot is retained');
  assert.equal(originalDot.getAttribute('cx'), expectedWindow.x.toFixed(1));
  assert.equal(originalDot.getAttribute('cy'), expectedWindow.y.toFixed(1));
  assert.deepEqual(centroid, { lon: -100.8, lat: 29.4, height: 0 }, 'closed-ring vertex mean stays pinned');
  assert.equal(dataSources[0].entities.values.length, 2, 'world area adds one fill and one outline');
  assert.equal(dataSources[0].entities.values.filter((entity) => entity.polygon).length, 1);
  assert.equal(dataSources[0].entities.values.filter((entity) => entity.polyline).length, 1);
  assert.equal(Object.hasOwn(anno, '_entities'), false, 'world entity state stays on the inherited proxy');
  renderer.destroy();
});

// ── Partial-add rollback (second review) ─────────────────────────────────────
//
// The hybrid builds a mark across TWO sub-renderers. It used to record the
// route only after both had run, so a throw in the second one left the first
// one's content live with nothing pointing at it: remove() was a no-op and the
// engine's rollback (which knows only the id) could not reach it. The next
// annotate of the same geometry then stacked a fresh mark over that orphan.

test('a sub-renderer throw mid-add leaves state the rollback can still remove', (t) => {
  installBrowserGlobals(t);
  const { viewer, dataSources } = fakeViewer(-99, 31);
  const renderer = createHybridAnnotationRenderer(viewer);
  const ring = [[-106, 25], [-93, 25], [-93, 36], [-106, 36], [-106, 25]];
  const anno = {
    id: 'anno-partial-add',
    type: 'area',
    color: 'primary',
    label: 'Texas',
    alpha: 1,
    anchor: naiveRingCentroid(ring),
    ring,
    footprintKind: 'area',
    synthesized: false,
  };

  // The world drape lands first; the screen caption then fails the way a lost
  // context does, AFTER the world geometry is already on the board.
  const { svg } = findAnnotationGroup(globalThis.document);
  const appendChild = svg.appendChild.bind(svg);
  let failNextInsert = true;
  svg.appendChild = (child) => {
    if (failNextInsert) {
      failNextInsert = false;
      throw new Error('screen insert failed');
    }
    return appendChild(child);
  };

  assert.throws(() => renderer.add(anno), /screen insert failed/);
  assert.equal(dataSources[0].entities.values.length, 2, 'the world drape is already live');
  assert.equal(annotationGroups(svg).length, 0, 'the half-built screen group detached itself');

  // The engine's rollback path — it must reach the partial state by id.
  renderer.remove(anno);
  assert.equal(dataSources[0].entities.values.length, 0, 'partial world state must be released');

  // …and the id is free again: a retry draws ONE mark, not a second one over
  // an orphan nothing owns.
  renderer.add(anno);
  assert.equal(dataSources[0].entities.values.length, 2, 'the retry draws exactly one world drape');
  assert.equal(annotationGroups(svg).length, 1, 'and exactly one screen caption');
  renderer.remove(anno);
  assert.equal(dataSources[0].entities.values.length, 0);
  renderer.destroy();
});

test('a release that throws keeps the mark addressable for a retry cleanup', (t) => {
  installBrowserGlobals(t);
  const { viewer, dataSources } = fakeViewer(-99, 31);
  const renderer = createHybridAnnotationRenderer(viewer);
  const ring = [[-106, 25], [-93, 25], [-93, 36], [-106, 36], [-106, 25]];
  const anno = {
    id: 'anno-release-throw',
    type: 'area',
    color: 'primary',
    label: 'Texas',
    alpha: 1,
    anchor: naiveRingCentroid(ring),
    ring,
    footprintKind: 'area',
    synthesized: false,
  };

  renderer.add(anno);
  const { svg } = findAnnotationGroup(globalThis.document);
  assert.equal(dataSources[0].entities.values.length, 2);
  assert.equal(annotationGroups(svg).length, 1);

  // The world route releases fine, then the screen release fails part-way
  // (its fade-out timer throws) — so its SVG group is still in the document.
  const workingSetTimeout = globalThis.window.setTimeout;
  globalThis.window.setTimeout = () => { throw new Error('teardown scheduling failed'); };
  assert.throws(() => renderer.remove(anno), /teardown scheduling failed/);
  assert.equal(dataSources[0].entities.values.length, 0, 'the world route did release');
  assert.equal(annotationGroups(svg).length, 1, 'the screen route did NOT — that is the orphan');

  // Dropping the routing entry here would make that orphan permanently
  // unreachable. It must still be addressable, so a retry finishes the job.
  globalThis.window.setTimeout = workingSetTimeout;
  renderer.remove(anno);
  assert.equal(annotationGroups(svg).length, 0, 'the retry cleanup must reach the orphan');
  assert.equal(dataSources[0].entities.values.length, 0, 'without double-releasing the world route');

  // Fully released now — a third call is inert.
  renderer.remove(anno);
  assert.equal(annotationGroups(svg).length, 0);
  renderer.destroy();
});

test('a world add that fails mid-way leaves its landed entities removable', (t) => {
  installBrowserGlobals(t);
  const { viewer, dataSources } = fakeViewer(-99, 31);
  const renderer = createHybridAnnotationRenderer(viewer);
  const ring = [[-106, 25], [-93, 25], [-93, 36], [-106, 36], [-106, 25]];
  const anno = {
    id: 'anno-partial-world-add',
    type: 'area',
    color: 'primary',
    label: 'Texas',
    alpha: 1,
    anchor: naiveRingCentroid(ring),
    ring,
    footprintKind: 'area',
    synthesized: false,
  };

  // The draped fill lands; the outline throws (bad geometry / lost context).
  const entities = dataSources[0].entities;
  const realAdd = entities.add.bind(entities);
  let addsLeft = 1;
  entities.add = (options) => {
    if (addsLeft <= 0) throw new Error('entity add failed');
    addsLeft -= 1;
    return realAdd(options);
  };

  assert.throws(() => renderer.add(anno), /entity add failed/);
  assert.equal(entities.values.length, 1, 'one entity landed before the failure');

  entities.add = realAdd;
  renderer.remove(anno);
  assert.equal(entities.values.length, 0,
    'the rollback must see the entities that landed before the throw');

  const { svg } = findAnnotationGroup(globalThis.document);
  renderer.add(anno);
  assert.equal(entities.values.length, 2, 'the retry draws a complete mark');
  assert.equal(annotationGroups(svg).length, 1);
  renderer.destroy();
});
