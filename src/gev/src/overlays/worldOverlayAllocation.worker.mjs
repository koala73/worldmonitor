import * as Cesium from 'cesium';
import {
  AMBIENT_CARD_COLLISION_CAPACITY,
  destroyWorldOverlay,
  getWorldOverlayDiagnostics,
  initWorldOverlay,
  setOverlayEntries,
} from './worldOverlay.js';
import {
  LOCAL_OVERLAY_COHORT_LIMIT,
  createLocalInfrastructureOverlayEntry,
} from '../data/localGeojson.js';
import {
  FIRMS_AMBIENT_COHORT_LIMIT,
  FIRMS_OVERLAY_SOURCE_ID,
} from '../data/firmsLabels.js';
import { applyFirmsOverlayPolicy } from '../data/firmsHeatmap.js';
import {
  applyVesselOverlayPolicy,
  VESSEL_OVERLAY_SOURCE_ID,
  vesselOverlayCohortLimit,
} from '../data/vesselLabels.js';
import {
  createTrackedOverlayEntry,
  TRACKED_OVERLAY_SOURCE_ID,
  TRACKED_OVERLAY_SOURCE_OPTIONS,
} from '../data/trackedReadout.js';
import { CCTV_AMBIENT_CARD_MAX } from '../data/cctvLod.js';
import {
  CCTV_OVERLAY_SOURCE_ID,
  createCctvThumbnailOverlayEntry,
  createFrameSlot,
} from '../data/cctvCards.js';
import {
  EARTHQUAKE_OVERLAY_COHORT_LIMIT,
  EARTHQUAKE_OVERLAY_COLLISION_CAPACITY,
  EARTHQUAKE_OVERLAY_SOURCE_ID,
  createEarthquakeOverlayEntry,
} from '../data/earthquakes.js';
import {
  BIKESHARE_SELECTED_OVERLAY_SOURCE_ID,
  BIKESHARE_SELECTED_OVERLAY_SOURCE_OPTIONS,
  createBikeshareSelectedOverlayEntry,
} from '../data/bikeshare.js';
import {
  ISS_OVERLAY_SOURCE_ID,
  ISS_OVERLAY_SOURCE_OPTIONS,
  createIssOverlayEntry,
} from '../data/satellites.js';
import {
  CCTV_PROJECTION_OVERLAY_SOURCE_ID,
  CCTV_PROJECTION_OVERLAY_SOURCE_OPTIONS,
  createCctvProjectionOverlayEntry,
} from '../data/cctv.js';
import {
  createRocketMissionMarkerOverlayEntry,
  ROCKET_MISSION_AMBIENT_OVERLAY_COHORT_LIMIT,
  ROCKET_MISSION_AMBIENT_OVERLAY_COLLISION_CAPACITY,
  ROCKET_MISSION_AMBIENT_OVERLAY_SOURCE_ID,
} from '../data/rocketLaunches.js';
import {
  createRadioClusterOverlayEntry,
  createRadioSelectedOverlayEntry,
  RADIO_OVERLAY_COHORT_LIMIT,
  RADIO_OVERLAY_SOURCE_ID,
  RADIO_OVERLAY_SOURCE_OPTIONS,
} from '../data/radio.js';
import {
  CABLE_OVERLAY_COLLISION_CAPACITY,
  CABLE_OVERLAY_SOURCE_ID,
  CABLE_REFERENCE_LABEL_WINNER_CAP,
  createCableOverlayEntry,
} from '../data/telegeographySubmarineCables.js';
import {
  destroyDetection,
  getDetectionDiagnostics,
  initDetection,
  setDetectionTuning,
  setMode as setDetectionMode,
} from '../data/detection.js';

/**
 * @module worldOverlayAllocation.worker
 * @description GC-bracketed allocation probe for the world-overlay steady
 * frame. Runs as a `node --expose-gc` child so the unit gate can assert a
 * bytes-per-painted-entry-per-frame budget without requiring `--expose-gc`
 * on the whole test runner. Emits one JSON line on stdout.
 *
 * The workload is deterministic: a fixed-seed grid of moving entries, a
 * non-recording Canvas2D stub (so the probe measures the overlay and not the
 * harness), and a fixed virtual clock stepped at 16 ms per frame.
 */

const ENTRY_COUNT = Number(process.env.GEV_ALLOC_ENTRIES) || 60;
const PROFILE = process.env.GEV_ALLOC_PROFILE || 'generic';
// Long enough for every frame-path function to reach the top optimizing tier
// (V8 boxes intermediate doubles below TurboFan, which is not the steady state
// a 60 fps browser session ever sits in).
const WARMUP_FRAMES = Number(process.env.GEV_ALLOC_WARMUP) || 3000;
// Measured frames are split into GC-bracketed chunks. A chunk's heap delta is
// (allocated - collected), so a chunk can only ever UNDER-report; the reported
// median is immune to a single anomalous chunk, and the maximum is the
// tightest sound estimate of the steady rate.
const CHUNK_FRAMES = Number(process.env.GEV_ALLOC_CHUNK) || 48;
const CHUNK_COUNT = Number(process.env.GEV_ALLOC_CHUNKS) || 10;
const STABILIZATION_CHUNKS = Number(process.env.GEV_ALLOC_STABILIZATION_CHUNKS) || 6;
const FRAME_MS = 16;
const VIEWPORT_WIDTH = 1600;
const VIEWPORT_HEIGHT = 900;

/** Deterministic 32-bit LCG so the workload never varies between runs. */
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Canvas2D stub that records nothing; recording would dominate the delta. */
function silentContext() {
  return {
    font: '',
    filter: 'none',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    measureText(text) { return { width: String(text).length * 6 }; },
    setTransform() {},
    clearRect() {},
    save() {},
    restore() {},
    translate() {},
    scale() {},
    beginPath() {},
    rect() {},
    clip() {},
    roundRect() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    arcTo() {},
    closePath() {},
    fill() {},
    stroke() {},
    fillRect() {},
    fillText() {},
    drawImage() {},
  };
}

function installMockEnvironment({ width, height, dpr }) {
  const byId = new Map();
  const ctx = silentContext();
  let currentTime = 0;
  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    value: { now: () => currentTime },
  });
  Date.now = () => currentTime;
  globalThis.Path2D = class {
    moveTo() {}
    lineTo() {}
    roundRect() {}
    arcTo() {}
    closePath() {}
  };

  class MockElement {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.id = '';
      this.children = [];
      this.parentElement = null;
      this.style = {};
      this.dataset = {};
      this.hidden = false;
      this.width = 0;
      this.height = 0;
      this.clientWidth = width;
      this.clientHeight = height;
      this._rect = { left: 0, top: 0, width, height };
    }

    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      if (child.id) byId.set(child.id, child);
      return child;
    }

    insertBefore(child) { return this.appendChild(child); }

    setAttribute(name, value) {
      if (name === 'id') this.id = String(value);
      else this[name] = String(value);
      if (this.id) byId.set(this.id, this);
    }

    getBoundingClientRect() { return this._rect; }

    getContext() { return this.tagName === 'CANVAS' ? ctx : null; }

    querySelector(selector) {
      const wanted = selector.slice(1);
      for (const child of this.children) if (child.id === wanted) return child;
      return null;
    }

    remove() {
      if (this.parentElement) {
        this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
      }
      if (this.id) byId.delete(this.id);
      this.parentElement = null;
    }

    get nextSibling() { return null; }
  }

  const body = new MockElement('body');
  body.classList = { contains() { return false; } };
  const document = {
    body,
    createElement(tagName) { return new MockElement(tagName); },
    getElementById(id) { return byId.get(id) || null; },
    querySelector(selector) { return byId.get(selector.slice(1)) || null; },
    querySelectorAll(selector) {
      const element = selector.startsWith('#') ? byId.get(selector.slice(1)) : null;
      return element ? [element] : [];
    },
  };

  const window = {
    devicePixelRatio: dpr,
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle() { return { display: 'block', visibility: 'visible', opacity: '1' }; },
  };

  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  globalThis.document = document;
  globalThis.window = window;

  const container = new MockElement('div');
  container.id = 'cesiumContainer';
  body.appendChild(container);

  // Array-backed so raising a frame allocates nothing: the harness floor has
  // to stay far below the budget the gate asserts.
  class MockEvent {
    constructor() { this.listeners = []; }

    addEventListener(listener) {
      this.listeners.push(listener);
      return () => { this.listeners.length = 0; };
    }

    raise() {
      for (let i = 0; i < this.listeners.length; i++) this.listeners[i]();
    }
  }

  const postRender = new MockEvent();
  const viewer = {
    container,
    canvas: { clientWidth: width, clientHeight: height },
    camera: {
      positionWC: new Cesium.Cartesian3(0, 0, 10_000_000),
      positionCartographic: { height: 1000 },
      viewMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY),
      frustum: { projectionMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY) },
      moveEnd: new MockEvent(),
    },
    scene: { postRender, requestRender() {} },
  };

  return {
    viewer,
    postRender,
    advanceTime(ms) { currentTime += ms; },
  };
}

function buildWorkload(count) {
  const random = makeRandom(0x5eed1234);
  const positions = [];
  const drifts = [];
  const entries = [];
  // A roughly 16:9 grid spanning the frustum, so the cohort keeps the same
  // on-screen density whatever the entry count is.
  const columns = Math.max(1, Math.ceil(Math.sqrt((count * 16) / 9)));
  const rows = Math.max(1, Math.ceil(count / columns));
  const spanX = columns > 1 ? 1.72 / (columns - 1) : 0;
  const spanY = rows > 1 ? 1.64 / (rows - 1) : 0;
  for (let index = 0; index < count; index++) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const baseX = -0.86 + column * spanX;
    const baseY = -0.82 + row * spanY;
    positions.push(new Cesium.Cartesian3(baseX, baseY, 0));
    drifts.push({
      baseX,
      baseY,
      phase: random() * Math.PI * 2,
      rate: 0.35 + random() * 0.4,
    });
    const position = positions[index];
    entries.push({
      id: `mover-${index}`,
      position: () => position,
      variant: 'label',
      title: `TRK ${1000 + index}`,
      details: [`ALT ${10_000 + index * 25}`],
      priority: index % 7,
      interactive: true,
      horizonCull: false,
      edgeFade: 'none',
      collisionGroup: 'movers',
    });
  }
  return { entries, positions, drifts };
}

function buildLocalInfrastructureWorkload(count) {
  const workload = buildWorkload(count);
  const split = Math.ceil(count / 2);
  const datacenters = [];
  const dams = [];
  for (let index = 0; index < workload.entries.length; index++) {
    const sourceId = index < split ? 'local-datacenters' : 'local-dams';
    const isDatacenter = sourceId === 'local-datacenters';
    const entry = createLocalInfrastructureOverlayEntry({
      id: `${isDatacenter ? 'dc' : 'dam'}-${index}`,
      layerId: sourceId,
      position: workload.entries[index].position,
      properties: isDatacenter ? {
        tags: {
          name: `DC ${1000 + index}`,
          operator: `Operator ${index % 17}`,
          'capacity:it_load': `${20 + index % 40} MW`,
        },
      } : {
        name: `Dam ${1000 + index}`,
        tags: { associated_river: `River ${index % 23}` },
      },
      priority: index % 7,
      accent: isDatacenter ? '#00ffff' : '#0088ff',
    });
    // The allocation harness uses identity view/projection matrices, so its
    // positions are normalized screen coordinates rather than WGS84 points.
    // Only horizon culling is disabled; every allocation-relevant production
    // field and the two real source registrations stay intact.
    entry.horizonCull = false;
    (isDatacenter ? datacenters : dams).push(entry);
  }
  return {
    ...workload,
    registrations: [
      {
        sourceId: 'local-datacenters',
        entries: datacenters,
        options: { collisionCapacity: 96, cohortLimit: LOCAL_OVERLAY_COHORT_LIMIT },
      },
      {
        sourceId: 'local-dams',
        entries: dams,
        options: { collisionCapacity: 96, cohortLimit: LOCAL_OVERLAY_COHORT_LIMIT },
      },
    ],
  };
}

function buildPhase3FirmsWorkload(count) {
  const localCount = LOCAL_OVERLAY_COHORT_LIMIT * 2;
  const expectedCount = localCount + FIRMS_AMBIENT_COHORT_LIMIT;
  if (count !== expectedCount) throw new Error(`phase3-firms requires ${expectedCount} entries`);
  const workload = buildWorkload(count);
  const datacenters = [];
  const dams = [];
  const firms = [];
  for (let index = 0; index < workload.entries.length; index++) {
    const position = workload.entries[index].position;
    if (index < localCount) {
      const isDatacenter = index < LOCAL_OVERLAY_COHORT_LIMIT;
      const sourceId = isDatacenter ? 'local-datacenters' : 'local-dams';
      const entry = createLocalInfrastructureOverlayEntry({
        id: `${isDatacenter ? 'dc' : 'dam'}-${index}`,
        layerId: sourceId,
        position,
        properties: isDatacenter
          ? { tags: { name: `DC ${index}`, operator: `Operator ${index % 17}` } }
          : { name: `Dam ${index}`, tags: { associated_river: `River ${index % 23}` } },
        priority: index % 7,
        accent: isDatacenter ? '#00ffff' : '#0088ff',
      });
      entry.horizonCull = false;
      (isDatacenter ? datacenters : dams).push(entry);
      continue;
    }
    const fireIndex = index - localCount;
    firms.push(applyFirmsOverlayPolicy({
      id: `fire:${fireIndex}`,
      position,
      gapPx: 10,
      accent: '224, 82, 82',
      title: `▲ ${50 + fireIndex} MW`,
      details: ['high · 2h · N20'],
      selected: false,
      priority: 100 - fireIndex,
    }, 12_000_000));
    firms.at(-1).horizonCull = false;
  }
  return {
    ...workload,
    registrations: [
      {
        sourceId: 'local-datacenters',
        entries: datacenters,
        options: { collisionCapacity: 96, cohortLimit: LOCAL_OVERLAY_COHORT_LIMIT },
      },
      {
        sourceId: 'local-dams',
        entries: dams,
        options: { collisionCapacity: 96, cohortLimit: LOCAL_OVERLAY_COHORT_LIMIT },
      },
      {
        sourceId: FIRMS_OVERLAY_SOURCE_ID,
        entries: firms,
        options: {
          collisionCapacity: FIRMS_AMBIENT_COHORT_LIMIT,
          cohortLimit: FIRMS_AMBIENT_COHORT_LIMIT,
        },
      },
    ],
    ambientCardCapacity: AMBIENT_CARD_COLLISION_CAPACITY,
  };
}

function buildPhase3VesselsWorkload(count) {
  const localCount = LOCAL_OVERLAY_COHORT_LIMIT * 2;
  const vesselAmbientCount = vesselOverlayCohortLimit(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
  const expectedCount = localCount + FIRMS_AMBIENT_COHORT_LIMIT + vesselAmbientCount + 1;
  if (count !== expectedCount) throw new Error(`phase3-vessels requires ${expectedCount} entries`);
  const workload = buildWorkload(count);
  const datacenters = [];
  const dams = [];
  const firms = [];
  const vessels = [];
  for (let index = 0; index < workload.entries.length; index++) {
    const position = workload.entries[index].position;
    if (index < localCount) {
      const isDatacenter = index < LOCAL_OVERLAY_COHORT_LIMIT;
      const sourceId = isDatacenter ? 'local-datacenters' : 'local-dams';
      const entry = createLocalInfrastructureOverlayEntry({
        id: `${isDatacenter ? 'dc' : 'dam'}-${index}`,
        layerId: sourceId,
        position,
        properties: isDatacenter
          ? { tags: { name: `DC ${index}`, operator: `Operator ${index % 17}` } }
          : { name: `Dam ${index}`, tags: { associated_river: `River ${index % 23}` } },
        priority: index % 7,
        accent: isDatacenter ? '#00ffff' : '#0088ff',
      });
      entry.horizonCull = false;
      (isDatacenter ? datacenters : dams).push(entry);
      continue;
    }
    const firmsEnd = localCount + FIRMS_AMBIENT_COHORT_LIMIT;
    if (index < firmsEnd) {
      const fireIndex = index - localCount;
      const entry = applyFirmsOverlayPolicy({
        id: `fire:${fireIndex}`,
        position,
        gapPx: 10,
        accent: '224, 82, 82',
        title: `▲ ${50 + fireIndex} MW`,
        details: ['high · 2h · N20'],
        selected: false,
        priority: 100 - fireIndex,
      }, 12_000_000);
      entry.horizonCull = false;
      firms.push(entry);
      continue;
    }
    const vesselIndex = index - firmsEnd;
    const selected = vesselIndex === vesselAmbientCount;
    const entry = applyVesselOverlayPolicy({
      id: selected ? 'vessel:selected' : `vessel:${vesselIndex}`,
      position,
      gapPx: selected ? 12 : 10,
      accent: '57, 213, 255',
      title: selected ? 'SELECTED VESSEL' : `VESSEL ${vesselIndex}`,
      details: selected
        ? ['CARGO · 14.5KT · 231°', 'MMSI 353136000 · POS: LIVE']
        : ['CARGO · 14.5KT · 231°'],
      selected,
      priority: selected ? 100000 : vesselAmbientCount - vesselIndex,
    }, 12_000_000);
    entry.horizonCull = false;
    vessels.push(entry);
  }
  return {
    ...workload,
    registrations: [
      {
        sourceId: 'local-datacenters',
        entries: datacenters,
        options: { collisionCapacity: 96, cohortLimit: LOCAL_OVERLAY_COHORT_LIMIT },
      },
      {
        sourceId: 'local-dams',
        entries: dams,
        options: { collisionCapacity: 96, cohortLimit: LOCAL_OVERLAY_COHORT_LIMIT },
      },
      {
        sourceId: FIRMS_OVERLAY_SOURCE_ID,
        entries: firms,
        options: {
          collisionCapacity: FIRMS_AMBIENT_COHORT_LIMIT,
          cohortLimit: FIRMS_AMBIENT_COHORT_LIMIT,
        },
      },
      {
        sourceId: VESSEL_OVERLAY_SOURCE_ID,
        entries: vessels,
        options: { collisionCapacity: vesselAmbientCount, cohortLimit: vesselAmbientCount },
      },
    ],
    ambientCardCapacity: AMBIENT_CARD_COLLISION_CAPACITY,
  };
}

function buildPhase3TrackedWorkload(count) {
  const localCount = LOCAL_OVERLAY_COHORT_LIMIT * 2;
  const vesselAmbientCount = vesselOverlayCohortLimit(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
  const expectedCount = localCount + FIRMS_AMBIENT_COHORT_LIMIT + vesselAmbientCount + 1;
  if (count !== expectedCount) throw new Error(`phase3-tracked requires ${expectedCount} entries`);
  const workload = buildPhase3VesselsWorkload(count);
  const vesselRegistration = workload.registrations.find(
    ({ sourceId }) => sourceId === VESSEL_OVERLAY_SOURCE_ID,
  );
  const selectedIndex = vesselRegistration.entries.findIndex(({ selected }) => selected);
  const selected = vesselRegistration.entries.splice(selectedIndex, 1)[0];
  const trackedEntity = {
    gevTrackedId: 'flights:allocation-probe',
    gevDisplayPosition: selected.position,
    gevLabelModel: {
      title: 'ALLOC01',
      details: ['FL350 · 451 kts', 'TEST AIR · A320'],
      accent: '#39d0ff',
    },
  };
  const tracked = createTrackedOverlayEntry(trackedEntity);
  tracked.horizonCull = false;
  vesselRegistration.options = {
    collisionCapacity: vesselAmbientCount,
    cohortLimit: vesselAmbientCount,
  };
  workload.registrations.push({
    sourceId: TRACKED_OVERLAY_SOURCE_ID,
    entries: [tracked],
    options: TRACKED_OVERLAY_SOURCE_OPTIONS,
  });
  return workload;
}

function buildPhase4CctvWorkload(count) {
  const phase3Count = LOCAL_OVERLAY_COHORT_LIMIT * 2 + FIRMS_AMBIENT_COHORT_LIMIT
    + vesselOverlayCohortLimit(VIEWPORT_WIDTH, VIEWPORT_HEIGHT) + 1;
  const expectedCount = phase3Count + CCTV_AMBIENT_CARD_MAX + 1;
  if (count !== expectedCount) throw new Error(`phase4-cctv requires ${expectedCount} entries`);
  const workload = buildPhase3TrackedWorkload(phase3Count);
  const cctv = [];
  for (let index = 0; index <= CCTV_AMBIENT_CARD_MAX; index++) {
    const column = index % 7;
    const row = Math.floor(index / 7);
    const baseX = -0.78 + column * 0.26;
    const baseY = -0.68 + row * 0.23;
    const position = new Cesium.Cartesian3(baseX, baseY, 0);
    workload.positions.push(position);
    workload.drifts.push({
      baseX,
      baseY,
      phase: index * 0.37,
      rate: 0.38 + (index % 5) * 0.07,
    });
    const slot = createFrameSlot();
    slot.frame = { width: 192, height: 108 };
    slot.stamp = 1;
    const active = index === CCTV_AMBIENT_CARD_MAX;
    const entry = createCctvThumbnailOverlayEntry({
      id: active ? 'cctv:active' : `cctv:${index}`,
      position,
      title: active ? 'ACTIVE CAMERA' : `CAMERA ${index}`,
      frameSlot: slot,
      rank: index,
      active,
    });
    // Allocation-relevant thumbnail geometry, stable image-slot dereference,
    // image draw, altitude scaling, and protected policy stay production-real;
    // only the identity-matrix harness's non-WGS84 horizon/range inputs relax.
    entry.horizonCull = false;
    entry.maxDistance = Number.POSITIVE_INFINITY;
    cctv.push(entry);
  }
  workload.registrations.push({
    sourceId: CCTV_OVERLAY_SOURCE_ID,
    entries: cctv,
    options: {
      collisionCapacity: CCTV_AMBIENT_CARD_MAX,
      cohortLimit: CCTV_AMBIENT_CARD_MAX,
    },
  });
  return workload;
}

function buildPhase5EarthquakesWorkload(count) {
  const phase4Count = LOCAL_OVERLAY_COHORT_LIMIT * 2 + FIRMS_AMBIENT_COHORT_LIMIT
    + vesselOverlayCohortLimit(VIEWPORT_WIDTH, VIEWPORT_HEIGHT) + 1
    + CCTV_AMBIENT_CARD_MAX + 1;
  const expectedCount = phase4Count + EARTHQUAKE_OVERLAY_COHORT_LIMIT;
  if (count !== expectedCount) throw new Error(`phase5-earthquakes requires ${expectedCount} entries`);
  const workload = buildPhase4CctvWorkload(phase4Count);
  const earthquakes = [];
  for (let index = 0; index < EARTHQUAKE_OVERLAY_COHORT_LIMIT; index++) {
    const column = index % 12;
    const row = Math.floor(index / 12);
    const baseX = -0.82 + column * 0.15;
    const baseY = -0.74 + row * 0.2;
    const position = new Cesium.Cartesian3(baseX, baseY, 0);
    workload.positions.push(position);
    workload.drifts.push({
      baseX,
      baseY,
      phase: index * 0.29,
      rate: 0.31 + (index % 7) * 0.05,
    });
    const entry = createEarthquakeOverlayEntry({
      id: `quake-${index}`,
      position,
      magnitude: 2.5 + (index % 45) / 10,
      accent: index % 3 === 0 ? '#ff0000' : index % 3 === 1 ? '#ffa500' : '#ffff00',
    });
    entry.horizonCull = false;
    earthquakes.push(entry);
  }
  workload.registrations.push({
    sourceId: EARTHQUAKE_OVERLAY_SOURCE_ID,
    entries: earthquakes,
    options: {
      collisionCapacity: EARTHQUAKE_OVERLAY_COLLISION_CAPACITY,
      cohortLimit: EARTHQUAKE_OVERLAY_COHORT_LIMIT,
    },
  });
  return workload;
}

function buildPhase5BikeshareWorkload(count) {
  const earthquakeCount = LOCAL_OVERLAY_COHORT_LIMIT * 2 + FIRMS_AMBIENT_COHORT_LIMIT
    + vesselOverlayCohortLimit(VIEWPORT_WIDTH, VIEWPORT_HEIGHT) + 1
    + CCTV_AMBIENT_CARD_MAX + 1 + EARTHQUAKE_OVERLAY_COHORT_LIMIT;
  const expectedCount = earthquakeCount + 1;
  if (count !== expectedCount) throw new Error(`phase5-bikeshare requires ${expectedCount} entries`);
  const workload = buildPhase5EarthquakesWorkload(earthquakeCount);
  const position = new Cesium.Cartesian3(0.12, -0.08, 0);
  workload.positions.push(position);
  workload.drifts.push({ baseX: 0.12, baseY: -0.08, phase: 0.7, rate: 0.41 });
  const entry = createBikeshareSelectedOverlayEntry('allocation:station', {
    stationId: 'station',
    stationName: 'CONGRESS & 6TH',
    bikesAvailable: 7,
    docksAvailable: 4,
    capacity: 11,
    isInstalled: true,
    isRenting: true,
    isReturning: true,
    point: { position },
  });
  entry.horizonCull = false;
  workload.registrations.push({
    sourceId: BIKESHARE_SELECTED_OVERLAY_SOURCE_ID,
    entries: [entry],
    options: BIKESHARE_SELECTED_OVERLAY_SOURCE_OPTIONS,
  });
  return workload;
}

function buildPhase5SatellitesWorkload(count) {
  const bikeshareCount = LOCAL_OVERLAY_COHORT_LIMIT * 2 + FIRMS_AMBIENT_COHORT_LIMIT
    + vesselOverlayCohortLimit(VIEWPORT_WIDTH, VIEWPORT_HEIGHT) + 1
    + CCTV_AMBIENT_CARD_MAX + 1 + EARTHQUAKE_OVERLAY_COHORT_LIMIT + 1;
  const expectedCount = bikeshareCount + 1;
  if (count !== expectedCount) throw new Error(`phase5-satellites requires ${expectedCount} entries`);
  const workload = buildPhase5BikeshareWorkload(bikeshareCount);
  const position = new Cesium.Cartesian3(-0.42, 0.54, 0);
  workload.positions.push(position);
  workload.drifts.push({ baseX: -0.42, baseY: 0.54, phase: 1.3, rate: 0.62 });
  const entry = createIssOverlayEntry(() => position);
  entry.horizonCull = false;
  workload.registrations.push({
    sourceId: ISS_OVERLAY_SOURCE_ID,
    entries: [entry],
    options: ISS_OVERLAY_SOURCE_OPTIONS,
  });
  return workload;
}

function buildPhase5CctvProjectionWorkload(count) {
  const satelliteCount = LOCAL_OVERLAY_COHORT_LIMIT * 2 + FIRMS_AMBIENT_COHORT_LIMIT
    + vesselOverlayCohortLimit(VIEWPORT_WIDTH, VIEWPORT_HEIGHT) + 1
    + CCTV_AMBIENT_CARD_MAX + 1 + EARTHQUAKE_OVERLAY_COHORT_LIMIT + 2;
  const expectedCount = satelliteCount + 1;
  if (count !== expectedCount) {
    throw new Error(`phase5-cctv-projection requires ${expectedCount} entries`);
  }
  const workload = buildPhase5SatellitesWorkload(satelliteCount);
  const position = new Cesium.Cartesian3(0.48, 0.44, 0);
  workload.positions.push(position);
  workload.drifts.push({ baseX: 0.48, baseY: 0.44, phase: 1.8, rate: 0.47 });
  const entry = createCctvProjectionOverlayEntry({
    cameraId: 'allocation:projection',
    name: 'ACTIVE CAMERA',
    position: () => position,
  });
  entry.horizonCull = false;
  workload.registrations.push({
    sourceId: CCTV_PROJECTION_OVERLAY_SOURCE_ID,
    entries: [entry],
    options: CCTV_PROJECTION_OVERLAY_SOURCE_OPTIONS,
  });
  return workload;
}

function buildPhase5CivilWorkload(count) {
  const workload = buildPhase5CctvProjectionWorkload(count);
  const registration = workload.registrations.find(
    ({ sourceId }) => sourceId === TRACKED_OVERLAY_SOURCE_ID,
  );
  const entry = registration?.entries[0];
  if (!entry) throw new Error('phase5-civil requires the protected tracked entry');
  entry.title = 'ALLOC01 · FL350 · 451 kts';
  entry.details = ['TEST AIR · A320', 'AUS → LAX'];
  return workload;
}

function buildPhase5MilitaryWorkload(count) {
  const workload = buildPhase5CctvProjectionWorkload(count);
  const registration = workload.registrations.find(
    ({ sourceId }) => sourceId === TRACKED_OVERLAY_SOURCE_ID,
  );
  const entry = registration?.entries[0];
  if (!entry) throw new Error('phase5-military requires the protected tracked entry');
  entry.id = 'military:allocation-probe';
  entry.title = 'RCH451';
  entry.details = ['C17 · 05-8152', 'USAF · 28000 ft · 400 kt'];
  entry.accent = '#ffd166';
  return workload;
}

function appendRocketMissionAmbientWorkload(workload, count) {
  const entries = [];
  for (let index = 0; index < count; index++) {
    const column = index % 8;
    const row = Math.floor(index / 8);
    const baseX = -0.78 + column * 0.22;
    const baseY = -0.68 + row * 0.24;
    const position = new Cesium.Cartesian3(baseX, baseY, 0);
    workload.positions.push(position);
    workload.drifts.push({
      baseX,
      baseY,
      phase: index * 0.33,
      rate: 0.3 + (index % 6) * 0.06,
    });
    const entry = createRocketMissionMarkerOverlayEntry({
      id: `allocation-${index}`,
      name: `MISSION ${1000 + index} | PAYLOAD`,
      launchSite: `Launch Complex ${index}`,
      launchTime: new Date(Date.UTC(2026, 6, 31) - index * 60_000).toISOString(),
    }, () => position);
    entry.horizonCull = false;
    entries.push(entry);
  }
  workload.registrations.push({
    sourceId: ROCKET_MISSION_AMBIENT_OVERLAY_SOURCE_ID,
    entries,
    options: {
      cohortLimit: ROCKET_MISSION_AMBIENT_OVERLAY_COHORT_LIMIT,
      collisionCapacity: ROCKET_MISSION_AMBIENT_OVERLAY_COLLISION_CAPACITY,
    },
  });
  return workload;
}

function buildRocketMissionAmbientWorkload(count) {
  if (count !== ROCKET_MISSION_AMBIENT_OVERLAY_COHORT_LIMIT) {
    throw new Error(
      `rocket-missions requires ${ROCKET_MISSION_AMBIENT_OVERLAY_COHORT_LIMIT} entries`,
    );
  }
  return appendRocketMissionAmbientWorkload({
    entries: [],
    positions: [],
    drifts: [],
    registrations: [],
  }, count);
}

function buildPhase5RocketMissionWorkload(count) {
  const phase5Count = LOCAL_OVERLAY_COHORT_LIMIT * 2 + FIRMS_AMBIENT_COHORT_LIMIT
    + vesselOverlayCohortLimit(VIEWPORT_WIDTH, VIEWPORT_HEIGHT) + 1
    + CCTV_AMBIENT_CARD_MAX + 1 + EARTHQUAKE_OVERLAY_COHORT_LIMIT + 3;
  const expectedCount = phase5Count + ROCKET_MISSION_AMBIENT_OVERLAY_COHORT_LIMIT;
  if (count !== expectedCount) {
    throw new Error(`phase5-rockets requires ${expectedCount} entries`);
  }
  return appendRocketMissionAmbientWorkload(
    buildPhase5MilitaryWorkload(phase5Count),
    ROCKET_MISSION_AMBIENT_OVERLAY_COHORT_LIMIT,
  );
}

function buildAllLiveRadioWorkload(count) {
  const phase5Count = LOCAL_OVERLAY_COHORT_LIMIT * 2 + FIRMS_AMBIENT_COHORT_LIMIT
    + vesselOverlayCohortLimit(VIEWPORT_WIDTH, VIEWPORT_HEIGHT) + 1
    + CCTV_AMBIENT_CARD_MAX + 1 + EARTHQUAKE_OVERLAY_COHORT_LIMIT + 3
    + ROCKET_MISSION_AMBIENT_OVERLAY_COHORT_LIMIT;
  // 2026-08-18: "every shared-host source" includes the migrated
  // submarine-cable cohort, so the aggregate exercises cable labels
  // interacting with Radio/earthquake/mission quotas and allocation.
  const expectedCount = phase5Count + RADIO_OVERLAY_COHORT_LIMIT + 1
    + CABLE_REFERENCE_LABEL_WINNER_CAP;
  if (count !== expectedCount) throw new Error(`all-live-radio requires ${expectedCount} entries`);
  const workload = buildPhase5RocketMissionWorkload(phase5Count);
  appendSubmarineCableWorkload(workload, CABLE_REFERENCE_LABEL_WINNER_CAP);
  const entries = [];
  for (let index = 0; index < RADIO_OVERLAY_COHORT_LIMIT; index += 1) {
    const position = new Cesium.Cartesian3(-0.72 + (index % 8) * 0.18, -0.64 + Math.floor(index / 8) * 0.16, 0);
    workload.positions.push(position);
    workload.drifts.push({ baseX: position.x, baseY: position.y, phase: index * 0.21, rate: 0.35 });
    const entry = createRadioClusterOverlayEntry({
      id: `cluster-${index}`,
      position: () => position,
      text: `${3 + index} NEWS`,
      accent: '#44adff',
      stationCount: 3 + index,
    });
    entry.horizonCull = false;
    entries.push(entry);
  }
  const selectedPosition = new Cesium.Cartesian3(0.08, 0.12, 0);
  workload.positions.push(selectedPosition);
  workload.drifts.push({ baseX: selectedPosition.x, baseY: selectedPosition.y, phase: 0.5, rate: 0.4 });
  const selectedEntry = createRadioSelectedOverlayEntry({
    id: 'selected',
    name: 'ALLOCATION RADIO',
    tags: ['news'],
  }, () => selectedPosition);
  selectedEntry.horizonCull = false;
  entries.push(selectedEntry);
  workload.registrations.push({
    sourceId: RADIO_OVERLAY_SOURCE_ID,
    entries,
    options: RADIO_OVERLAY_SOURCE_OPTIONS,
  });
  return workload;
}

/**
 * Append the submarine-cable reference cohort (2026-08-18 host migration):
 * the full 160-winner ambient-label field a mid-ocean camera can produce,
 * mixing cable and landing-point accents. Per-frame drift republishes
 * nothing (the real source republishes at 2 Hz and skips identical
 * cohorts); the probe measures the host's steady projection/solve/paint
 * cost for the source shape. Shared by the isolated row and the all-live
 * aggregate.
 */
function appendSubmarineCableWorkload(workload, count) {
  const entries = [];
  for (let index = 0; index < count; index++) {
    const column = index % 16;
    const row = Math.floor(index / 16);
    const baseX = -0.84 + column * 0.112;
    const baseY = -0.78 + row * 0.164;
    const position = new Cesium.Cartesian3(baseX, baseY, 0);
    workload.positions.push(position);
    workload.drifts.push({
      baseX,
      baseY,
      phase: index * 0.23,
      rate: 0.33 + (index % 5) * 0.04,
    });
    const kind = index % 3 === 0 ? 'cable' : 'landing-point';
    const entry = createCableOverlayEntry({
      id: `${kind}-reference-${index}-alloc`,
      kind,
      label: kind === 'cable' ? `Cable System ${index}` : `Landing Point ${index}`,
      tip: position,
      distanceM: 200_000 + index * 40_000,
    });
    entry.horizonCull = false;
    // The mock camera sits beyond the source's real 9,000 km label range;
    // lift the range gate (an environment adjustment like horizonCull) so the
    // probe measures painting labels, not distance-culling them.
    entry.maxDistance = Number.POSITIVE_INFINITY;
    entries.push(entry);
  }
  workload.registrations.push({
    sourceId: CABLE_OVERLAY_SOURCE_ID,
    entries,
    options: {
      cohortLimit: CABLE_REFERENCE_LABEL_WINNER_CAP,
      collisionCapacity: CABLE_OVERLAY_COLLISION_CAPACITY,
    },
  });
  return workload;
}

function buildSubmarineCablesWorkload(count) {
  if (count !== CABLE_REFERENCE_LABEL_WINNER_CAP) {
    throw new Error(`submarine-cables requires ${CABLE_REFERENCE_LABEL_WINNER_CAP} entries`);
  }
  return appendSubmarineCableWorkload(
    { entries: [], positions: [], drifts: [], registrations: [] },
    count,
  );
}

function buildPhase6DetectionWorkload(count) {
  const random = makeRandom(0xd37ec710);
  const positions = [];
  const drifts = [];
  const observations = [];
  const columns = Math.max(1, Math.ceil(Math.sqrt((count * 16) / 9)));
  const rows = Math.max(1, Math.ceil(count / columns));
  const spanX = columns > 1 ? 1_400_000 / (columns - 1) : 0;
  const spanY = rows > 1 ? 1_050_000 / (rows - 1) : 0;
  const polarRadiusM = Cesium.Ellipsoid.WGS84.radii.z;
  const equatorialRadiusM = Cesium.Ellipsoid.WGS84.radii.x;
  for (let index = 0; index < count; index++) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const baseX = -700_000 + column * spanX;
    const baseY = -525_000 + row * spanY;
    const normalizedHorizontal = (baseX * baseX + baseY * baseY)
      / (equatorialRadiusM * equatorialRadiusM);
    const z = polarRadiusM * Math.sqrt(Math.max(0, 1 - normalizedHorizontal));
    const position = new Cesium.Cartesian3(baseX, baseY, z);
    positions.push(position);
    drifts.push({
      baseX,
      baseY,
      phase: random() * Math.PI * 2,
      rate: 0.3 + random() * 0.35,
      amplitude: 3_000,
    });
    observations.push({
      position,
      sourceId: `detect-${index}`,
      id: `D${String(index).padStart(4, '0')}`,
      metric: index % 5 === 0 ? '' : `FL${String(180 + (index % 220)).padStart(3, '0')}`,
      type: ['AIR', 'SAT', 'SEA', 'VEH'][index % 4],
      tier: index % 17 === 0 ? 'military' : undefined,
    });
  }
  return {
    entries: [],
    positions,
    drifts,
    detectionLayer: {
      id: 'flights',
      getDetectableObjects() { return observations; },
    },
  };
}

function advanceWorkload(positions, drifts, frame) {
  for (let index = 0; index < positions.length; index++) {
    const drift = drifts[index];
    const t = frame * 0.016 * drift.rate + drift.phase;
    const amplitude = drift.amplitude ?? 0.03;
    positions[index].x = drift.baseX + Math.sin(t) * amplitude;
    positions[index].y = drift.baseY + Math.cos(t * 0.7) * amplitude;
  }
}

function main() {
  if (typeof globalThis.gc !== 'function') {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: 'no-gc' })}\n`);
    return;
  }
  const env = installMockEnvironment({
    width: VIEWPORT_WIDTH,
    height: VIEWPORT_HEIGHT,
    dpr: 2,
  });
  initWorldOverlay(env.viewer);
  const workload = PROFILE === 'phase6-detection'
    ? buildPhase6DetectionWorkload(ENTRY_COUNT)
    : PROFILE === 'local-infrastructure'
      ? buildLocalInfrastructureWorkload(ENTRY_COUNT)
      : PROFILE === 'phase3-firms'
      ? buildPhase3FirmsWorkload(ENTRY_COUNT)
      : PROFILE === 'phase3-vessels'
        ? buildPhase3VesselsWorkload(ENTRY_COUNT)
        : PROFILE === 'phase3-tracked'
          ? buildPhase3TrackedWorkload(ENTRY_COUNT)
          : PROFILE === 'phase4-cctv'
            ? buildPhase4CctvWorkload(ENTRY_COUNT)
            : PROFILE === 'phase5-earthquakes'
              ? buildPhase5EarthquakesWorkload(ENTRY_COUNT)
              : PROFILE === 'phase5-bikeshare'
                ? buildPhase5BikeshareWorkload(ENTRY_COUNT)
                : PROFILE === 'phase5-satellites'
                  ? buildPhase5SatellitesWorkload(ENTRY_COUNT)
                  : PROFILE === 'phase5-cctv-projection'
                    ? buildPhase5CctvProjectionWorkload(ENTRY_COUNT)
                    : PROFILE === 'phase5-civil'
                      ? buildPhase5CivilWorkload(ENTRY_COUNT)
                      : PROFILE === 'phase5-military'
                        ? buildPhase5MilitaryWorkload(ENTRY_COUNT)
                        : PROFILE === 'rocket-missions'
                          ? buildRocketMissionAmbientWorkload(ENTRY_COUNT)
                          : PROFILE === 'phase5-rockets'
                            ? buildPhase5RocketMissionWorkload(ENTRY_COUNT)
                            : PROFILE === 'all-live-radio'
                              ? buildAllLiveRadioWorkload(ENTRY_COUNT)
                              : PROFILE === 'submarine-cables'
                                ? buildSubmarineCablesWorkload(ENTRY_COUNT)
        : buildWorkload(ENTRY_COUNT);
  const { entries, positions, drifts } = workload;
  const solveIntervalMs = Number(process.env.GEV_ALLOC_SOLVE_MS) || 125;
  const detectionActive = !!workload.detectionLayer;
  if (detectionActive) {
    // Spread polar ECEF x/y over the viewport while retaining a real WGS84
    // horizon test and detection's manual matrix projection path.
    env.viewer.camera.viewMatrix[0] = 1 / 800_000;
    env.viewer.camera.viewMatrix[5] = 1 / 600_000;
    env.viewer.camera.positionCartographic.height = 2_500_000;
    initDetection(env.viewer, [workload.detectionLayer], () => {});
    setDetectionTuning({ densityPct: 100, allocationStrategy: 'ELASTIC' });
    setDetectionMode('DENSE');
  } else if (workload.registrations) {
    for (const registration of workload.registrations) {
      setOverlayEntries(registration.sourceId, registration.entries, {
        ...registration.options,
        // Exercise the stricter moving-source solve cadence while retaining
        // the production source ids, entries, caps, and bounded cohorts.
        moving: true,
        solveIntervalMs,
      });
    }
  } else {
    setOverlayEntries('alloc-probe', entries, {
      collisionCapacity: 96,
      cohortLimit: 256,
      moving: true,
      solveIntervalMs,
    });
  }

  let frame = 0;
  const tick = () => {
    advanceWorkload(positions, drifts, frame);
    env.advanceTime(FRAME_MS);
    env.postRender.raise();
    frame++;
  };

  for (let i = 0; i < WARMUP_FRAMES; i++) tick();

  // Enter the same explicit-GC regime used by the measurement before taking
  // samples. Frame-only warmup does not stabilize the first GC-bracketed
  // chunks on Node 24, so those transition chunks are deliberately discarded.
  for (let chunk = 0; chunk < STABILIZATION_CHUNKS; chunk++) {
    globalThis.gc();
    globalThis.gc();
    for (let i = 0; i < CHUNK_FRAMES; i++) tick();
  }
  const warm = getWorldOverlayDiagnostics();
  const detectionWarm = detectionActive ? getDetectionDiagnostics() : null;
  const painted = detectionActive ? detectionWarm.visibleCount : warm.paintedCount;
  const candidates = detectionActive ? detectionWarm.observationCount : warm.candidateCount;
  const solveRevisionBefore = detectionActive ? detectionWarm.solveRevision : warm.solveRevision;

  const chunkRates = [];
  for (let chunk = 0; chunk < CHUNK_COUNT; chunk++) {
    globalThis.gc();
    globalThis.gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < CHUNK_FRAMES; i++) tick();
    const after = process.memoryUsage().heapUsed;
    chunkRates.push((after - before) / CHUNK_FRAMES);
  }
  const solveRevisionAfter = detectionActive
    ? getDetectionDiagnostics().solveRevision
    : getWorldOverlayDiagnostics().solveRevision;
  const sorted = chunkRates.slice().sort((a, b) => a - b);
  const maxBytesPerFrame = sorted[sorted.length - 1];
  const medianBytesPerFrame = sorted[Math.floor(sorted.length / 2)];
  const perCandidate = (value) => value / Math.max(1, candidates);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    profile: PROFILE,
    ambientCardCapacity: workload.ambientCardCapacity ?? null,
    entryCount: ENTRY_COUNT,
    warmupFrames: WARMUP_FRAMES,
    stabilizationChunks: STABILIZATION_CHUNKS,
    chunkFrames: CHUNK_FRAMES,
    chunkCount: CHUNK_COUNT,
    measuredFrames: CHUNK_FRAMES * CHUNK_COUNT,
    paintedCount: painted,
    paintedBySource: warm.paintedBySource,
    candidateCount: candidates,
    detectionSelectedCount: detectionWarm?.selectedCount ?? null,
    detectionCollectiveLabelBudget: detectionWarm?.collectiveLabelBudget ?? null,
    solveCount: solveRevisionAfter - solveRevisionBefore,
    // Frame cost is the primary signal; the per-candidate rate is the
    // scale-invariant one. Neither is normalized by paintedCount, which
    // saturates at the domain collision capacity.
    maxBytesPerFrame,
    medianBytesPerFrame,
    maxBytesPerCandidatePerFrame: perCandidate(maxBytesPerFrame),
    medianBytesPerCandidatePerFrame: perCandidate(medianBytesPerFrame),
    chunkBytesPerFrame: chunkRates,
  })}\n`);

  if (detectionActive) destroyDetection();
  destroyWorldOverlay();
}

main();
