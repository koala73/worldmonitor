import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOCATION_ELASTIC,
  ALLOCATION_WEIGHTED,
  LabelArbiter,
} from './labelArbiter.js';

// Compact rows retain the full identity/corner/rect contract:
// key@corner@x@y@w@h (fade rows append @alpha@selected).
const GOLDEN = {
  elasticTie12: {
    selected: 'firms:000,firms:008,firms:010,vessels:003,vessels:007,vessels:009',
    placements: 'firms:000@NE@-229@-190@38@16|firms:008@NE@451@-65@38@16|firms:010@NE@153@-304@38@16|vessels:003@NE@94@-74@38@16|vessels:007@NE@-418@-73@38@16|vessels:009@NE@-210@180@38@16',
    fades: [],
    selectedCount: 6,
    quotas: 'firms:3,vessels:3',
    labelsByLayer: 'firms:3,vessels:3',
    queue: [2, 6],
    spatialCellCount: 27,
  },
  weightedFew24: {
    selected: 'cctv:003,cctv:009,cctv:015,cctv:018,firms:010,firms:016,vessels:008,vessels:011,vessels:020',
    placements: 'cctv:003@NE@-163@-259@38@16|cctv:009@NE@188@-51@38@16|cctv:015@NE@-230@100@38@16|cctv:018@NE@-431@-109@38@16|firms:010@NE@-199@-290@38@16|firms:016@NE@232@232@38@16|vessels:008@NE@52@-209@38@16|vessels:011@NE@-68@-54@38@16|vessels:020@NE@-31@199@38@16',
    fades: [],
    selectedCount: 9,
    quotas: 'cctv:4,firms:2,vessels:3',
    labelsByLayer: 'cctv:4,firms:2,vessels:3',
    queue: [3, 9],
    spatialCellCount: 28,
  },
  duplicateKeys48: {
    selected: 'a-blocker:fixed,z-duplicates:shared',
    placements: 'a-blocker:fixed@only@0@0@20@20|z-duplicates:shared@free@300@300@20@20',
    fades: [],
    selectedCount: 2,
    quotas: 'a-blocker:1,z-duplicates:1',
    labelsByLayer: 'a-blocker:1,z-duplicates:1',
    queue: [2, 2],
    spatialCellCount: 5,
  },
  stable96: [
    {
      selected: 'flights:003,flights:009,flights:033,flights:057,flights:087,satellites:055,satellites:067,satellites:073,satellites:079,satellites:085,vessels:017,vessels:029,vessels:035,vessels:083,vessels:095',
      placements: 'flights:003@NE@-214@22@38@16|flights:009@NE@190@-267@38@16|flights:033@NE@-437@237@38@16|flights:057@NE@43@241@38@16|flights:087@NE@384@3@38@16|satellites:055@NE@-343@-236@38@16|satellites:067@NE@420@187@38@16|satellites:073@NE@-380@40@38@16|satellites:079@NE@256@32@38@16|satellites:085@NE@-80@207@38@16|vessels:017@NE@-212@-132@38@16|vessels:029@NE@12@-14@38@16|vessels:035@NE@130@-106@38@16|vessels:083@NE@-43@-289@38@16|vessels:095@NE@439@-262@38@16',
      fades: [],
      selectedCount: 15,
      quotas: 'flights:5,satellites:5,vessels:5',
      labelsByLayer: 'flights:5,satellites:5,vessels:5',
      queue: [3, 15],
      spatialCellCount: 52,
    },
    {
      selected: 'flights:003,flights:009,flights:033,flights:057,flights:087,satellites:055,satellites:067,satellites:073,satellites:079,satellites:085,vessels:017,vessels:029,vessels:035,vessels:083,vessels:095',
      placements: 'flights:003@NE@-214@22@38@16|flights:009@NE@190@-267@38@16|flights:033@NE@-437@237@38@16|flights:057@NE@43@241@38@16|flights:087@NE@384@3@38@16|satellites:055@NE@-343@-236@38@16|satellites:067@NE@420@187@38@16|satellites:073@NE@-380@40@38@16|satellites:079@NE@256@32@38@16|satellites:085@NE@-80@207@38@16|vessels:017@NE@-212@-132@38@16|vessels:029@NE@12@-14@38@16|vessels:035@NE@130@-106@38@16|vessels:083@NE@-43@-289@38@16|vessels:095@NE@439@-262@38@16',
      fades: [],
      selectedCount: 15,
      quotas: 'flights:5,satellites:5,vessels:5',
      labelsByLayer: 'flights:5,satellites:5,vessels:5',
      queue: [0, 0],
      spatialCellCount: 52,
    },
  ],
  clustered200: {
    selected: 'firms:000,firms:001',
    placements: 'firms:000@above@70@66@60@20|firms:001@below@70@114@60@20',
    fades: [],
    selectedCount: 2,
    quotas: 'firms:200',
    labelsByLayer: 'firms:2',
    queue: [2, 4],
    spatialCellCount: 9,
  },
  packedCells400: {
    selected: 'air:000,air:003,air:051,air:066,air:171,air:210,air:330,air:351,ground:013,ground:124,ground:157,ground:379,sea:146,sea:230,sea:281,sea:347,sea:383,sea:386',
    placements: 'air:000@packed@-639@-127@10@10|air:003@packed@-607@-639@10@10|air:051@NE@-4288@546@38@16|air:066@NE@-245@-2390@38@16|air:171@NE@5493@2134@38@16|air:210@NE@2943@2389@38@16|air:330@NE@3289@-1454@38@16|air:351@NE@5423@-3072@38@16|ground:013@NE@2371@-2822@38@16|ground:124@NE@-20@3579@38@16|ground:157@NE@-1642@-3390@38@16|ground:379@NE@5196@-1036@38@16|sea:146@NE@-3559@-3258@38@16|sea:230@NE@-1938@-1868@38@16|sea:281@NE@5212@-1783@38@16|sea:347@NE@-2185@2564@38@16|sea:383@NE@2177@-1527@38@16|sea:386@NE@4250@1117@38@16',
    fades: [],
    selectedCount: 18,
    quotas: 'air:8,ground:4,sea:6',
    labelsByLayer: 'air:8,ground:4,sea:6',
    queue: [3, 18],
    spatialCellCount: 55,
  },
  fadeSequence12: [
    {
      selected: 'tracks:000,tracks:005,tracks:007,tracks:009',
      placements: 'tracks:000@NE@-51@-134@38@16|tracks:005@NE@-179@-256@38@16|tracks:007@NE@347@200@38@16|tracks:009@NE@446@22@38@16',
      fades: [
        '7000:',
        '7075:tracks:000@NE@-51@-134@38@16@0.5@true|tracks:005@NE@-179@-256@38@16@0.5@true|tracks:007@NE@347@200@38@16@0.5@true|tracks:009@NE@446@22@38@16@0.5@true',
        '7150:tracks:000@NE@-51@-134@38@16@1@true|tracks:005@NE@-179@-256@38@16@1@true|tracks:007@NE@347@200@38@16@1@true|tracks:009@NE@446@22@38@16@1@true',
      ],
      selectedCount: 4,
      quotas: 'tracks:4',
      labelsByLayer: 'tracks:4',
      queue: [1, 4],
      spatialCellCount: 15,
    },
    {
      selected: 'tracks:007,tracks:009',
      placements: 'tracks:007@NE@347@200@38@16|tracks:009@NE@446@22@38@16',
      fades: [
        '7200:tracks:000@NE@-51@-134@38@16@1@false|tracks:005@NE@-179@-256@38@16@1@false|tracks:007@NE@347@200@38@16@1@true|tracks:009@NE@446@22@38@16@1@true',
        '7275:tracks:000@NE@-51@-134@38@16@0.75@false|tracks:005@NE@-179@-256@38@16@0.75@false|tracks:007@NE@347@200@38@16@1@true|tracks:009@NE@446@22@38@16@1@true',
        '7350:tracks:000@NE@-51@-134@38@16@0.5@false|tracks:005@NE@-179@-256@38@16@0.5@false|tracks:007@NE@347@200@38@16@1@true|tracks:009@NE@446@22@38@16@1@true',
        '7501:tracks:007@NE@347@200@38@16@1@true|tracks:009@NE@446@22@38@16@1@true',
      ],
      selectedCount: 2,
      quotas: 'tracks:2',
      labelsByLayer: 'tracks:2',
      queue: [1, 2],
      spatialCellCount: 15,
    },
  ],
};

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function rect(x, y, w = 38, h = 16) {
  return { x, y, w, h };
}

function placementsFor(x, y, shape = 'full') {
  if (shape === 'verticalOnly') {
    return [
      { corner: 'above', rect: rect(x - 30, y - 34, 60, 20) },
      { corner: 'below', rect: rect(x - 30, y + 14, 60, 20) },
    ];
  }
  if (shape === 'few') {
    return [
      { corner: 'NE', rect: rect(x + 8, y - 24) },
      { corner: 'SW', rect: rect(x - 46, y + 8) },
    ];
  }
  return [
    { corner: 'NE', rect: rect(x + 8, y - 24) },
    { corner: 'NW', rect: rect(x - 46, y - 24) },
    { corner: 'SE', rect: rect(x + 8, y + 8) },
    { corner: 'SW', rect: rect(x - 46, y + 8) },
  ];
}

function makeCohort(count, {
  seed,
  layers,
  shape = 'full',
  tieHeavy = false,
  spreadX = 900,
  spreadY = 560,
} = {}) {
  const random = seededRandom(seed);
  return Array.from({ length: count }, (_, index) => {
    const x = Math.floor(random() * spreadX) - Math.floor(spreadX / 2);
    const y = Math.floor(random() * spreadY) - Math.floor(spreadY / 2);
    const layerId = layers[index % layers.length];
    return {
      key: `${layerId}:${String(index).padStart(3, '0')}`,
      layerId,
      sourceId: index,
      priority: tieHeavy ? index % 2 : Math.floor(random() * 7),
      centerDistance: tieHeavy ? 100 : Math.hypot(x, y),
      keyholeAlpha: tieHeavy ? 1 : 0.55 + Math.floor(random() * 4) * 0.1,
      screenX: x,
      screenY: y,
      placements: placementsFor(x, y, shape),
    };
  });
}

function roundedAlpha(value) {
  return Number(value.toFixed(6));
}

function snapshotSolve(arbiter, candidates, options, fadeTimes = []) {
  const diagnostics = arbiter.solve(candidates, options);
  const selected = Array.from(arbiter.selectedKeys).sort();
  const placements = selected.map((key) => {
    const state = arbiter.states.get(key);
    const { x, y, w, h } = state.lastPlacement.rect;
    return [key, state.corner, x, y, w, h];
  });
  const current = new Map(candidates.map((candidate) => [candidate.key, candidate]));
  const fades = fadeTimes.map((now) => [
    now,
    ...arbiter.renderEntries(current, now)
      .map((entry) => {
        const { x, y, w, h } = entry.placement.rect;
        return [
          entry.candidate.key,
          entry.placement.corner,
          x,
          y,
          w,
          h,
          roundedAlpha(entry.temporalAlpha),
          entry.selected,
        ];
      })
      .sort(([a], [b]) => a.localeCompare(b)),
  ]);
  return {
    selected: selected.join(','),
    placements: placements.map((row) => row.join('@')).join('|'),
    fades: fades.map(([now, ...entries]) => `${now}:${entries.map((row) => row.join('@')).join('|')}`),
    selectedCount: diagnostics.selectedCount,
    quotas: Object.entries(diagnostics.quotas).map((row) => row.join(':')).join(','),
    labelsByLayer: Object.entries(diagnostics.labelsByLayer).map((row) => row.join(':')).join(','),
    queue: [diagnostics.spatialQueueBuildCount, diagnostics.spatialQueueNextCount],
    spatialCellCount: arbiter._spatial.cells.size,
  };
}

function buildGoldenBattery() {
  const elasticTie12 = makeCohort(12, {
    seed: 0x12e1a57,
    layers: ['firms', 'vessels'],
    tieHeavy: true,
  });
  const elasticArbiter = new LabelArbiter();

  const weightedFew24 = makeCohort(24, {
    seed: 0x24fe771,
    layers: ['cctv', 'firms', 'vessels'],
    shape: 'few',
  });
  const weightedArbiter = new LabelArbiter();

  const duplicateTail = makeCohort(45, {
    seed: 0x48d0b1e,
    layers: ['z-duplicates'],
    shape: 'verticalOnly',
  }).map((candidate, index) => ({
    ...candidate,
    key: `z-duplicates:tail-${String(index).padStart(2, '0')}`,
    priority: 0,
  }));
  const duplicateCandidates = [
    {
      key: 'a-blocker:fixed',
      layerId: 'a-blocker',
      sourceId: 'blocker',
      priority: 100,
      centerDistance: 0,
      keyholeAlpha: 1,
      screenX: 0,
      screenY: 0,
      placements: [{ corner: 'only', rect: rect(0, 0, 20, 20) }],
    },
    {
      key: 'z-duplicates:shared',
      layerId: 'z-duplicates',
      sourceId: 'blocked-copy',
      priority: 99,
      centerDistance: 1,
      keyholeAlpha: 1,
      screenX: 4,
      screenY: 4,
      placements: [{ corner: 'blocked', rect: rect(0, 0, 20, 20) }],
    },
    {
      key: 'z-duplicates:shared',
      layerId: 'z-duplicates',
      sourceId: 'free-copy',
      priority: 99,
      centerDistance: 1,
      keyholeAlpha: 1,
      screenX: 300,
      screenY: 300,
      placements: [{ corner: 'free', rect: rect(300, 300, 20, 20) }],
    },
    ...duplicateTail,
  ];
  const duplicateArbiter = new LabelArbiter();

  const stable96 = makeCohort(96, {
    seed: 0x96c0ffee,
    layers: ['flights', 'satellites', 'vessels'],
    shape: 'few',
    tieHeavy: true,
  });
  const stableArbiter = new LabelArbiter();

  const clustered200 = makeCohort(200, {
    seed: 0x200f1e1d,
    layers: ['firms'],
    shape: 'verticalOnly',
  }).map((candidate, index) => ({
    ...candidate,
    priority: 200 - index,
    centerDistance: index,
    screenX: 100,
    screenY: 100,
    placements: placementsFor(100, 100, 'verticalOnly'),
  }));
  const clusteredArbiter = new LabelArbiter();

  const packed400 = makeCohort(400, {
    seed: 0x400b17c5,
    layers: ['air', 'ground', 'sea'],
    shape: 'few',
    spreadX: 12000,
    spreadY: 8000,
  });
  const packedCell = (candidate, cellX, cellY, priority) => ({
    ...candidate,
    priority,
    keyholeAlpha: 1,
    centerDistance: 0,
    screenX: cellX * 32 + 1,
    screenY: cellY * 32 + 1,
    placements: [{
      corner: 'packed',
      rect: rect(cellX * 32 + 1, cellY * 32 + 1, 10, 10),
    }],
  });
  packed400[0] = packedCell(packed400[0], -20, -4, 1000);
  packed400[3] = packedCell(packed400[3], -19, -20, 999);
  const packedArbiter = new LabelArbiter();

  const fade12 = makeCohort(12, {
    seed: 0xfade0012,
    layers: ['tracks'],
    shape: 'few',
  });
  const fadeArbiter = new LabelArbiter();

  return {
    elasticTie12: snapshotSolve(elasticArbiter, elasticTie12, {
      capacity: 6,
      strategy: ALLOCATION_ELASTIC,
      now: 1000,
      preserveIncumbents: false,
    }),
    weightedFew24: snapshotSolve(weightedArbiter, weightedFew24, {
      capacity: 9,
      strategy: ALLOCATION_WEIGHTED,
      layerWeights: { cctv: 2, firms: 0.75, vessels: 1.25 },
      now: 2000,
      preserveIncumbents: false,
    }),
    duplicateKeys48: snapshotSolve(duplicateArbiter, duplicateCandidates, {
      capacity: 2,
      strategy: ALLOCATION_ELASTIC,
      demandByLayer: { 'a-blocker': 1, 'z-duplicates': 47 },
      now: 3000,
      preserveIncumbents: false,
    }),
    stable96: [
      snapshotSolve(stableArbiter, stable96, {
        capacity: 15,
        strategy: ALLOCATION_WEIGHTED,
        now: 4000,
        preserveIncumbents: true,
      }),
      snapshotSolve(stableArbiter, stable96.slice().reverse(), {
        capacity: 15,
        strategy: ALLOCATION_WEIGHTED,
        now: 4300,
        preserveIncumbents: true,
      }),
    ],
    clustered200: snapshotSolve(clusteredArbiter, clustered200, {
      capacity: 200,
      strategy: ALLOCATION_ELASTIC,
      now: 5000,
      preserveIncumbents: false,
    }),
    packedCells400: snapshotSolve(packedArbiter, packed400, {
      capacity: 18,
      strategy: ALLOCATION_WEIGHTED,
      layerWeights: { air: 1.5, ground: 0.75, sea: 1 },
      now: 6000,
      preserveIncumbents: false,
    }),
    fadeSequence12: [
      snapshotSolve(fadeArbiter, fade12, {
        capacity: 4,
        strategy: ALLOCATION_ELASTIC,
        now: 7000,
        preserveIncumbents: false,
      }, [7000, 7075, 7150]),
      snapshotSolve(fadeArbiter, fade12.slice(4), {
        capacity: 2,
        strategy: ALLOCATION_ELASTIC,
        now: 7200,
        preserveIncumbents: false,
      }, [7200, 7275, 7350, 7501]),
    ],
  };
}

if (process.env.GEV_PRINT_ARBITER_GOLDEN === '1') {
  process.stdout.write(`${JSON.stringify(buildGoldenBattery(), null, 2)}\n`);
} else {
  test('seeded arbiter scenario battery matches the current golden behavior', () => {
    assert.deepEqual(buildGoldenBattery(), GOLDEN);
  });
}
