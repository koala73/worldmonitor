import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRadioTunerBand,
  buildRadioTunerTicks,
  buildRadioCategories,
  createRadioClusterOverlayEntry,
  createRadioSelectedOverlayEntry,
  createRadioSingletonOverlayEntry,
  confirmRadioPlayback,
  DEFAULT_RADIO_FILTER,
  filterRadioStations,
  getRadioAcceptedCatalogSnapshot,
  getRadioUIState,
  isEnglishRadioStation,
  normalizeRadioTag,
  radioCategoryColor,
  radioGlobeLabel,
  radioGlobeNeedsRecentering,
  radioGlobeRecenterHeight,
  RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M,
  RADIO_OVERLAY_COHORT_LIMIT,
  RADIO_OVERLAY_SOURCE_OPTIONS,
  RADIO_SINGLETON_GLOBAL_LIMIT,
  RADIO_SINGLETON_MID_LIMIT,
  RADIO_SINGLETON_NEAR_LIMIT,
  radioClusterCategoryId,
  radioCameraPositionChanged,
  radioCameraNavigationAllowed,
  radioClusterBadgeText,
  rankRadioStationsForViewport,
  rankRadioStationsForRequest,
  radioRequestIsCurrent,
  radioLayer,
  reconcileRadioClusterCandidates,
  retainRadioClusterIdentitiesForStations,
  radioStationIdFromPick,
  radioSelectionBracketSvg,
  selectRadioClusterCandidates,
  selectRadioSingletonCandidates,
  radioStationCameraPlan,
  radioTunerCommitSlot,
  radioTunerPointerPosition,
  radioTunerSlot,
  radioTuningStaticShouldPlay,
  radioStationCategoryId,
  setRadioParams,
  setRadioVolume,
  setRadioVoiceDucking,
  radioSingletonLabelLimit,
  radioViewIsGlobal,
  stationMatchesRadioCategory,
} from './radio.js';

const stations = [
  { id: 'news', tags: ['News', 'Weather Radio', 'air traffic'] },
  { id: 'safety', tags: ['police scanner', 'emergency'] },
  { id: 'music', tags: ['jazz', 'soul'] },
  { id: 'other', tags: ['community'] },
];

test('station-level tags produce canonical and detected-genre categories', () => {
  const categories = buildRadioCategories(stations);
  assert.equal(categories.find((category) => category.id === 'all').count, 4);
  assert.equal(categories.find((category) => category.id === 'weather').count, 2);
  assert.equal(categories.find((category) => category.id === 'public-safety').count, 1);
  assert.equal(categories.find((category) => category.id === 'genre:jazz').count, 1);
  assert.equal(categories.find((category) => category.id === 'other').count, 1);
  assert.equal(categories.find((category) => category.id === 'music').color, '#54d17a');
  assert.equal(categories.find((category) => category.id === 'genre:jazz').color, '#54d17a');
});

test('every generated Radio category is accepted by durable preferences', () => {
  const categories = buildRadioCategories([
    ...stations,
    { id: 'hip-hop', tags: ['hip hop'] },
    { id: 'r-and-b', tags: ['r&b'] },
  ]);
  for (const category of categories) {
    assert.equal(setRadioParams({ filter: category.id }), true, category.id);
  }
});

test('station marker categories share the dropdown palette with stable overlap priority', () => {
  assert.equal(radioStationCategoryId(stations[0]), 'news');
  assert.equal(radioStationCategoryId(stations[1]), 'public-safety');
  assert.equal(radioStationCategoryId(stations[2]), 'music');
  assert.equal(radioStationCategoryId(stations[3]), 'other');
  assert.equal(radioCategoryColor('news'), '#44adff');
  assert.equal(radioCategoryColor('music'), '#54d17a');
  assert.equal(radioCategoryColor('genre:jazz'), '#54d17a');
});

test('cluster badges lead with a readable count and concise dominant category', () => {
  assert.equal(radioClusterBadgeText('news', 12), '12 NEWS');
  assert.equal(radioClusterBadgeText('public-safety', 7.9), '7 SAFETY');
  assert.equal(radioClusterBadgeText('genre:jazz', 4), '4 MUSIC');
  assert.equal(radioClusterBadgeText('unknown', -2), '0 OTHER');
});

test('Radio globe labels are compact and frequency-first without misreading names', () => {
  assert.equal(
    radioGlobeLabel({ name: 'La Zeta (Hermosillo) - 93.9 FM - XHHY - Uniradio' }),
    '93.9 FM — La Zeta',
  );
  assert.equal(
    radioGlobeLabel({ name: '100.3 The River - WQRV - Meridianville/Huntsville, AL' }),
    '100.3 FM — The River',
  );
  assert.equal(radioGlobeLabel({ name: "80's New Wave Radio" }), "80's New Wave Radio");
  assert.equal(radioGlobeLabel({ name: "100 GREATEST OF THE 80'S" }), "100 GREATEST OF THE 80'S");
  assert.doesNotMatch(radioGlobeLabel({ name: 'Movie Soundtracks Hits Radio @ 1.fm' }), /^1 FM/);
  assert.equal(
    radioGlobeLabel({ name: '  La   Zeta - 93.9 fm - XHHY  ' }),
    '93.9 FM — La Zeta',
  );
  assert.equal(radioGlobeLabel({ name: '93.9 FM ---' }), '93.9 FM');
  assert.equal(radioGlobeLabel({ name: 'Radio One 93.9 FM / 94.1 FM' }), '93.9 FM — Radio One');
  const truncated = radioGlobeLabel({ name: 'Christian Power Praise Dot Net Worldwide Service' });
  assert.equal(truncated.length, 30);
  assert.ok(truncated.endsWith('…'));
  const unicodeTruncated = radioGlobeLabel({ name: `${'a'.repeat(28)}📻 more` });
  assert.equal(unicodeTruncated, `${'a'.repeat(28)}📻…`);
  assert.doesNotMatch(unicodeTruncated, /�/);
});

test('Radio ranks and caps cluster candidates before shared-host entry construction', () => {
  const candidates = Array.from({ length: 90 }, (_, index) => ({
    id: `cluster-${String(index).padStart(2, '0')}`,
    stationCount: index % 17,
  }));
  const selected = selectRadioClusterCandidates(candidates);
  assert.equal(selected.length, RADIO_OVERLAY_COHORT_LIMIT);
  assert.ok(selected.every((candidate) => candidates.includes(candidate)));
  for (let index = 1; index < selected.length; index += 1) {
    assert.ok(selected[index - 1].stationCount >= selected[index].stationCount);
  }
  assert.deepEqual(selectRadioClusterCandidates([
    { id: 'z', stationCount: 5 },
    { id: 'a', stationCount: 5 },
  ], 1).map(({ id }) => id), ['a']);
});

test('Radio preserves one-to-one cluster identity across substantial membership churn', () => {
  const previous = [
    { id: 'stable:north', identityId: 'stable:north', stationIds: ['a', 'b', 'c', 'd'] },
    { id: 'stable:south', identityId: 'stable:south', stationIds: ['w', 'x', 'y', 'z'] },
  ];
  const generated = [];
  const reconciled = reconcileRadioClusterCandidates([
    { id: 'b:e:4', stationIds: ['a', 'b', 'c', 'e'], text: '4 NEWS' },
    { id: 'new:weak:3', stationIds: ['d', 'm', 'n'], text: '3 OTHER' },
    { id: 'x:q:4', stationIds: ['w', 'x', 'y', 'q'], text: '4 MUSIC' },
  ], previous, (candidate) => {
    const id = `new:${candidate.id}`;
    generated.push(id);
    return id;
  });
  assert.equal(reconciled[0].id, 'stable:north');
  assert.equal(reconciled[0].text, '4 NEWS');
  assert.equal(reconciled[2].id, 'stable:south');
  assert.equal(reconciled[2].text, '4 MUSIC');
  assert.equal(reconciled[1].id, 'new:new:weak:3');
  assert.deepEqual(generated, ['new:new:weak:3']);
  assert.deepEqual(previous[0].stationIds, ['a', 'b', 'c', 'd']);
});

test('directory refresh retains only identities whose represented stations still exist', () => {
  const previous = [
    { id: 'stable:unchanged', stationIds: ['a', 'b', 'c'] },
    { id: 'stable:invalid', stationIds: ['x', 'y', 'z'] },
  ];
  const unchangedRefresh = retainRadioClusterIdentitiesForStations(previous, [
    { id: 'c' }, { id: 'a' }, { id: 'b' }, { id: 'x' }, { id: 'y' }, { id: 'z' },
  ]);
  assert.deepEqual(unchangedRefresh, previous);
  const changedRefresh = retainRadioClusterIdentitiesForStations(previous, [
    { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'x' }, { id: 'z' },
  ]);
  assert.deepEqual(changedRefresh.map(({ id }) => id), ['stable:unchanged']);
});

test('Radio cluster identity inheritance is deterministic for splits and disjoint replacements', () => {
  const previous = [{
    id: 'stable:whole',
    identityId: 'stable:whole',
    stationIds: ['a', 'b', 'c', 'd', 'e', 'f'],
  }];
  const reconciled = reconcileRadioClusterCandidates([
    { id: 'a:c:3', stationIds: ['a', 'b', 'c'] },
    { id: 'd:f:3', stationIds: ['d', 'e', 'f'] },
    { id: 'x:z:3', stationIds: ['x', 'y', 'z'] },
  ], previous, (candidate) => `new:${candidate.id}`);
  assert.deepEqual(reconciled.map(({ id }) => id), [
    'stable:whole',
    'new:d:f:3',
    'new:x:z:3',
  ]);
  assert.equal(new Set(reconciled.map(({ id }) => id)).size, reconciled.length);
});

test('Radio allocates fresh disjoint cluster identities in canonical membership order', () => {
  const current = [
    { id: 'z-membership', stationIds: ['z2', 'z1'] },
    { id: 'a-membership', stationIds: ['a2', 'a1'] },
  ];
  const reconcile = (input) => {
    let sequence = 0;
    return reconcileRadioClusterCandidates(input, [], () => `stable:${++sequence}`);
  };
  const identities = (result) => Object.fromEntries(
    result.map(({ membershipId, identityId }) => [membershipId, identityId]),
  );

  assert.deepEqual(identities(reconcile(current)), {
    'z-membership': 'stable:2',
    'a-membership': 'stable:1',
  });
  assert.deepEqual(identities(reconcile([...current].reverse())), identities(reconcile(current)));
});

test('Radio split competition never falls through from a consumed majority to a historical minority', () => {
  const previous = [
    { id: 'stable:majority', stationIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] },
    { id: 'stable:minority', stationIds: ['x'] },
  ];
  const current = [
    { id: 'strong-child', stationIds: ['a', 'b', 'c', 'd', 'e'] },
    { id: 'later-child', stationIds: ['f', 'g', 'h', 'i', 'x'] },
  ];
  const reconcile = (currentInput, previousInput) => reconcileRadioClusterCandidates(
    currentInput,
    previousInput,
    (candidate) => `new:${candidate.id}`,
  );
  const forward = reconcile(current, previous);
  const permuted = reconcile([...current].reverse(), [...previous].reverse());
  const identities = (result) => Object.fromEntries(
    result.map(({ membershipId, identityId }) => [membershipId, identityId]),
  );

  assert.deepEqual(identities(forward), {
    'strong-child': 'stable:majority',
    'later-child': 'new:later-child',
  });
  assert.deepEqual(identities(permuted), identities(forward));
});

test('Radio split identities cannot migrate to weaker children to increase inherited count', () => {
  const previous = [
    { id: 'stable:alpha', stationIds: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9'] },
    { id: 'stable:beta', stationIds: ['b1', 'b2', 'b3', 'b4', 'b5'] },
  ];
  const reconciled = reconcileRadioClusterCandidates([
    {
      id: 'strong-tie',
      stationIds: ['a1', 'a2', 'a3', 'a4', 'a5', 'b1', 'b2', 'b3', 'b4', 'b5'],
    },
    { id: 'weaker-alpha-child', stationIds: ['a6', 'a7', 'a8', 'a9'] },
  ], previous, (candidate) => `new:${candidate.id}`);

  assert.deepEqual(reconciled.map(({ id }) => id), [
    'stable:beta',
    'new:weaker-alpha-child',
  ]);
});

test('Radio duplicate prior records cannot assign one stable identity twice', () => {
  const previous = [
    { id: 'stable:duplicate', stationIds: ['a', 'b'] },
    { identityId: 'stable:duplicate', stationIds: ['c', 'd'] },
  ];
  const current = [
    { id: 'a-child', stationIds: ['a', 'b'] },
    { id: 'z-child', stationIds: ['c', 'd'] },
  ];
  const reconcile = (currentInput, previousInput) => reconcileRadioClusterCandidates(
    currentInput,
    previousInput,
    (candidate) => `new:${candidate.id}`,
  );
  const forward = reconcile(current, previous);
  const permuted = reconcile([...current].reverse(), [...previous].reverse());
  const identities = (result) => Object.fromEntries(
    result.map(({ membershipId, identityId }) => [membershipId, identityId]),
  );

  assert.deepEqual(identities(forward), {
    'a-child': 'stable:duplicate',
    'z-child': 'new:z-child',
  });
  assert.deepEqual(identities(permuted), identities(forward));
  assert.equal(forward.filter(({ identityId }) => identityId === 'stable:duplicate').length, 1);
});

test('Radio cluster merges preserve the larger contributor over a fully retained minority', () => {
  const previous = [
    { id: 'stable:minority', stationIds: ['a', 'b'] },
    { id: 'stable:majority', stationIds: ['c', 'd', 'e', 'f', 'g', 'h'] },
  ];
  const [merged] = reconcileRadioClusterCandidates([
    { id: 'merged', stationIds: ['a', 'b', 'c', 'd', 'e'] },
  ], previous, () => 'new:merged');

  assert.equal(merged.id, 'stable:majority');
});

test('Radio cluster inheritance never discards the greatest low-ratio contributor', () => {
  const previous = [
    { id: 'stable:four', stationIds: ['a', 'b', 'c', 'd', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w'] },
    { id: 'stable:two', stationIds: ['e', 'f'] },
  ];
  const [merged] = reconcileRadioClusterCandidates([{
    id: 'merged',
    stationIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
  }], previous, () => 'new:merged');

  assert.equal(merged.id, 'stable:four');
});

test('Radio cluster inheritance permits a unique one-member overlap', () => {
  const [reconciled] = reconcileRadioClusterCandidates([
    { id: 'current', stationIds: ['a', 'x', 'y'] },
  ], [
    { id: 'stable:single-overlap', stationIds: ['a', 'b', 'c'] },
  ], () => 'new:current');

  assert.equal(reconciled.id, 'stable:single-overlap');
});

test('Radio cluster majority ties are deterministic across input permutations', () => {
  const previous = [
    { id: 'stable:zulu', stationIds: ['a', 'b', 'x'] },
    { id: 'stable:alpha', stationIds: ['c', 'd', 'y'] },
  ];
  const current = [{ id: 'merged', stationIds: ['a', 'b', 'c', 'd'] }];
  const forward = reconcileRadioClusterCandidates(current, previous, () => 'new:merged');
  const reversed = reconcileRadioClusterCandidates(current, [...previous].reverse(), () => 'new:merged');

  assert.equal(forward[0].id, 'stable:alpha');
  assert.equal(reversed[0].id, 'stable:alpha');
  assert.equal(new Set(forward.map(({ id }) => id)).size, forward.length);
});

test('active station tags own cluster labels even when overlapping tags have higher marker priority', () => {
  const overlapping = [
    { id: 'weather-news', tags: ['weather', 'news'] },
    { id: 'weather-only', tags: ['weather'] },
    { id: 'talk', tags: ['talk'] },
  ];
  assert.equal(radioStationCategoryId(overlapping[0]), 'news');
  assert.equal(radioClusterCategoryId(overlapping, 'weather'), 'weather');
  assert.equal(radioClusterCategoryId(overlapping, 'genre:jazz'), 'genre:jazz');
  assert.equal(radioClusterCategoryId(overlapping, 'all'), 'news');
});

test('filters do not rewrite inputs and overlapping operational tags remain discoverable', () => {
  const before = structuredClone(stations);
  assert.deepEqual(filterRadioStations(stations, 'public-safety').map((station) => station.id), ['safety']);
  assert.equal(stationMatchesRadioCategory(stations[0], 'aviation-marine'), true);
  assert.deepEqual(stations, before);
});

test('tag normalization is bounded and stable', () => {
  assert.equal(normalizeRadioTag('  Hip-Hop__Music  '), 'hip hop music');
  assert.equal(normalizeRadioTag('x'.repeat(100)).length, 80);
});

test('late directory responses cannot overwrite a disabled or newer generation', () => {
  assert.equal(radioRequestIsCurrent(4, 4, true), true);
  assert.equal(radioRequestIsCurrent(3, 4, true), false);
  assert.equal(radioRequestIsCurrent(4, 4, false), false);
});

test('destroy and re-init reset Radio audio ownership, volume, filter, and telemetry', async () => {
  const originalAudio = globalThis.Audio;
  const audioInstances = [];
  globalThis.Audio = class FakeAudio {
    constructor() {
      this.volume = 0.8;
      this.listeners = new Map();
      this.srcRemoved = false;
      audioInstances.push(this);
    }

    addEventListener(type, listener) { this.listeners.set(type, listener); }
    pause() {}
    play() { return Promise.resolve(); }
    removeAttribute(name) { if (name === 'src') this.srcRemoved = true; }
    load() {}
  };
  const viewer = {
    camera: { positionWC: { x: 7_000_000, y: 0, z: 0 } },
    scene: { canvas: { disableRootEvents: true, onwheel: null, addEventListener() {}, removeEventListener() {} } },
    dataSources: { add() {}, remove() {} },
    entities: { add(entity) { return entity; }, remove() {} },
  };

  radioLayer.destroy();
  try {
    radioLayer.init(viewer);
    radioLayer.enable();
    radioLayer.setLifecyclePresentation({
      lifecycleState: 'enabled', enabled: true, uncertain: false,
    });
    assert.equal(audioInstances.length, 1);
    assert.equal(setRadioVolume(0.25), true);
    setRadioVoiceDucking(true, { restoreDelayMs: 5, restoreDurationMs: 5 });
    assert.equal(getRadioUIState().voiceDucked, true);
    assert.equal(getRadioUIState().effectiveVolume, 0);
    const oldAudio = audioInstances[0];

    radioLayer.destroy();
    assert.equal(oldAudio.srcRemoved, true);
    assert.equal(getRadioUIState().loading, false);
    assert.equal(getRadioUIState().stale, false);
    assert.equal(getRadioUIState().degraded, false);
    assert.equal(getRadioUIState().error, null);
    assert.equal(getRadioUIState().updatedAt, null);
    assert.equal(getRadioUIState().filter, DEFAULT_RADIO_FILTER);
    assert.equal(getRadioUIState().voiceDucked, false);
    assert.equal(getRadioUIState().voiceRestoring, false);
    assert.equal(getRadioUIState().volume, 0.8);
    assert.equal(getRadioUIState().effectiveVolume, 0.8);

    radioLayer.init(viewer);
    assert.equal(audioInstances.length, 2, 're-init creates a clean Audio session');
    const nextState = getRadioUIState();
    for (const eventName of ['playing', 'pause', 'waiting', 'error']) {
      oldAudio.listeners.get(eventName)?.();
      assert.deepEqual(getRadioUIState(), nextState, `discarded ${eventName} callback is inert`);
    }
  } finally {
    radioLayer.destroy();
    if (originalAudio === undefined) delete globalThis.Audio;
    else globalThis.Audio = originalAudio;
  }
});

test('late media errors after replacement or Pause cannot mutate the active station', async () => {
  const originalAudio = globalThis.Audio;
  const originalFetch = globalThis.fetch;
  const audioInstances = [];
  globalThis.Audio = class FakeAudio {
    constructor() {
      this.volume = 0.8;
      this.src = '';
      this.currentSrc = '';
      this.listeners = new Map();
      this.playCalls = 0;
      audioInstances.push(this);
    }

    addEventListener(type, listener) { this.listeners.set(type, listener); }
    pause() {}
    play() {
      this.playCalls += 1;
      this.currentSrc = this.src;
      return new Promise(() => {});
    }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    load() {}
  };
  const stationRows = [
    {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Primary station',
      lat: 30,
      lon: -97,
      streamUrl: 'https://radio.example.com/primary.mp3',
      homepage: null,
      tags: ['news'],
      languages: ['English'],
      state: 'Texas',
      country: 'United States',
      countryCode: 'US',
      metadataTrust: 'untrusted-community',
      codec: 'MP3',
      bitrate: 128,
    },
    {
      id: '00000000-0000-4000-8000-000000000002',
      name: 'Fallback station',
      lat: 31,
      lon: -98,
      streamUrl: 'https://radio.example.com/fallback.mp3',
      homepage: null,
      tags: ['news'],
      languages: ['English'],
      state: 'Texas',
      country: 'United States',
      countryCode: 'US',
      metadataTrust: 'untrusted-community',
      codec: 'MP3',
      bitrate: 128,
    },
  ];
  globalThis.fetch = async (url) => String(url).startsWith('/api/gev/radio/click/')
    ? { ok: true }
    : {
      ok: true,
      json: async () => ({
        stations: stationRows,
        updatedAt: new Date().toISOString(),
        stale: false,
        degraded: false,
        acceptedGeneration: 1,
        catalogInstance: 'qa-instance-a',
      }),
    };
  const viewer = {
    camera: { positionWC: { x: 7_000_000, y: 0, z: 0 } },
    scene: { canvas: { disableRootEvents: true, onwheel: null, addEventListener() {}, removeEventListener() {} } },
    dataSources: { add() {}, remove() {} },
    entities: { add(entity) { return entity; }, remove() {} },
  };

  radioLayer.destroy();
  try {
    radioLayer.init(viewer);
    radioLayer.enable();
    await radioLayer.update();
    radioLayer.setLifecyclePresentation({
      lifecycleState: 'enabled',
      enabled: true,
      uncertain: true,
    });
    assert.equal(radioLayer.getUIState().presentationActive, false);
    assert.equal(radioLayer.selectStation(stationRows[0].id, {
      autoplay: true,
      origin: 'voice',
    }), false, 'uncertain lifecycle blocks direct station selection');
    assert.equal(radioLayer.cycleStation(1, {
      stationIds: stationRows.map(({ id }) => id),
      autoplay: false,
      rotate: true,
    }), false, 'uncertain lifecycle blocks cycling before camera or fallback mutation');
    assert.equal(await radioLayer.togglePlayback({ origin: 'user' }), false);
    assert.equal(radioLayer.getUIState().selected, null);
    assert.equal(audioInstances.reduce((sum, audio) => sum + audio.playCalls, 0), 0);
    radioLayer.setLifecyclePresentation({
      lifecycleState: 'enabled',
      enabled: true,
      uncertain: false,
    });
    void radioLayer.togglePlayback({ origin: 'user' });
    await Promise.resolve();
    const primaryAudio = audioInstances.at(-1);
    const loadingState = radioLayer.getUIState();
    assert.equal(loadingState.audioState, 'loading');
    assert.equal(loadingState.selected?.id, stationRows[0].id);

    radioLayer.selectStation(stationRows[1].id, {
      autoplay: true,
      focus: false,
      origin: 'user',
    });
    await Promise.resolve();
    const replacementAudio = audioInstances.at(-1);
    assert.notEqual(replacementAudio, primaryAudio);
    assert.equal(radioLayer.getUIState().selected?.id, stationRows[1].id);
    assert.equal(audioInstances.reduce((sum, audio) => sum + audio.playCalls, 0), 2);

    primaryAudio.currentSrc = '';
    primaryAudio.listeners.get('error')?.();
    assert.equal(radioLayer.getUIState().audioState, 'loading');
    assert.equal(radioLayer.getUIState().selected?.id, stationRows[1].id);
    assert.equal(audioInstances.reduce((sum, audio) => sum + audio.playCalls, 0), 2);

    const controlEvents = [];
    const unsubscribeControls = radioLayer.subscribePlaybackControls((event) => {
      const observed = radioLayer.getUIState();
      const cleanupResult = radioLayer.stopPlayback({
        origin: 'voice-cleanup',
        attemptId: event.attemptId,
      });
      controlEvents.push({
        action: event.action,
        observedAudioState: observed.audioState,
        observedStationId: observed.playingStationId,
        cleanupResult,
      });
    });
    assert.equal(radioLayer.pause({ origin: 'user' }), true);
    replacementAudio.listeners.get('error')?.();
    await Promise.resolve();

    const state = radioLayer.getUIState();
    assert.equal(state.audioState, 'paused');
    assert.equal(state.selected?.id, stationRows[1].id);
    assert.equal(state.playingStationId, stationRows[1].id);
    assert.equal(replacementAudio.src, stationRows[1].streamUrl);
    assert.deepEqual(controlEvents, [{
      action: 'pause',
      observedAudioState: 'paused',
      observedStationId: stationRows[1].id,
      cleanupResult: false,
    }]);

    void radioLayer.togglePlayback({ origin: 'user' });
    await Promise.resolve();
    const resumedAudio = audioInstances.at(-1);
    assert.equal(radioLayer.getUIState().audioState, 'loading');
    assert.equal(radioLayer.stopPlayback({ origin: 'user' }), true);
    assert.deepEqual(controlEvents[1], {
      action: 'stop',
      observedAudioState: 'stopped',
      observedStationId: null,
      cleanupResult: false,
    });
    assert.equal(radioLayer.getUIState().audioState, 'stopped');
    assert.equal(resumedAudio.src, '');
    unsubscribeControls();
    assert.equal(audioInstances.reduce((sum, audio) => sum + audio.playCalls, 0), 3);
  } finally {
    radioLayer.destroy();
    globalThis.fetch = originalFetch;
    if (originalAudio === undefined) delete globalThis.Audio;
    else globalThis.Audio = originalAudio;
  }
});

test('unusable directory responses preserve warm client state atomically', async () => {
  const originalFetch = globalThis.fetch;
  const now = new Date().toISOString();
  const station = {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Warm Station',
    lat: 30.2672,
    lon: -97.7431,
    streamUrl: 'https://stream.example.org/live.mp3',
    homepage: null,
    tags: ['news'],
    languages: ['English'],
    state: 'Texas',
    country: 'United States',
    countryCode: 'US',
    metadataTrust: 'untrusted-community',
    codec: 'MP3',
    bitrate: 128,
  };
  const viewer = {
    camera: { positionWC: { x: 7_000_000, y: 0, z: 0 } },
    scene: { canvas: { disableRootEvents: true, onwheel: null, addEventListener() {}, removeEventListener() {} } },
    dataSources: { add() {}, remove() {} },
    entities: { add(entity) { return entity; }, remove() {} },
  };
  radioLayer.destroy();
  try {
    radioLayer.init(viewer);
    globalThis.fetch = async () => new Response(JSON.stringify({
      stations: [station],
      stale: false,
      degraded: false,
      acceptedGeneration: 1,
      catalogInstance: 'qa-instance-a',
      updatedAt: now,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    radioLayer.enable();
    await radioLayer.update();
    assert.equal(getRadioUIState().stationCount, 1);
    assert.equal(getRadioUIState().updatedAt, now);
    const acceptedSnapshot = getRadioAcceptedCatalogSnapshot();
    assert.equal(acceptedSnapshot.generation, 1);
    assert.equal(acceptedSnapshot.stations[0].id, station.id);
    assert.equal(acceptedSnapshot.stations[0].metadataTrust, 'untrusted-community');
    assert.equal(Object.isFrozen(acceptedSnapshot), true);
    assert.equal(Object.isFrozen(acceptedSnapshot.stations), true);
    assert.equal(Object.isFrozen(acceptedSnapshot.stations[0]), true);
    assert.equal(Object.isFrozen(acceptedSnapshot.stations[0].tags), true);
    assert.equal(Object.isFrozen(acceptedSnapshot.stations[0].languages), true);
    assert.throws(() => { acceptedSnapshot.stations[0].name = 'mutated'; }, TypeError);
    radioLayer.selectStation(station.id, { autoplay: false, focus: false });

    const replacement = {
      ...station,
      id: '00000000-0000-4000-8000-000000000002',
      name: 'Partial Replacement',
    };
    for (const body of [
      { stations: [replacement], stale: false, degraded: true, acceptedGeneration: 1, updatedAt: now },
      { stations: [replacement], stale: true, degraded: true, acceptedGeneration: 1, updatedAt: now },
    ]) {
      globalThis.fetch = async () => new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
      await radioLayer.update();
      const preserved = getRadioUIState();
      assert.equal(preserved.stationCount, 1);
      assert.equal(preserved.selected?.id, station.id);
      assert.equal(preserved.selected?.name, station.name);
      assert.equal(preserved.updatedAt, now);
      assert.equal(preserved.degraded, true);
      assert.equal(preserved.stale, body.stale);
      assert.equal(getRadioAcceptedCatalogSnapshot(), acceptedSnapshot);
    }

    for (const body of [
      { stations: {} },
      { stations: [station, { id: 'malformed' }], stale: false, degraded: false, updatedAt: now },
      { stations: [station], stale: false, degraded: false, updatedAt: 'not-a-date' },
      { stations: [station], stale: 'false', degraded: false, updatedAt: now },
    ]) {
      globalThis.fetch = async () => new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
      await radioLayer.update();
      assert.equal(getRadioUIState().stationCount, 1);
      assert.equal(getRadioUIState().updatedAt, now);
      assert.equal(getRadioUIState().stale, true);
      assert.equal(getRadioUIState().degraded, true);
    }
  } finally {
    globalThis.fetch = originalFetch;
    radioLayer.destroy();
  }
});

test('tuner drag keeps one immutable catalog resolution through refresh and release', async () => {
  const originalFetch = globalThis.fetch;
  const viewer = {
    camera: { positionWC: { x: 7_000_000, y: 0, z: 0 } },
    scene: { canvas: { disableRootEvents: true, onwheel: null, addEventListener() {}, removeEventListener() {} } },
    dataSources: { add() {}, remove() {} },
    entities: { add(entity) { return entity; }, remove() {} },
  };
  const stationA = {
    id: '00000000-0000-4000-8000-000000000041',
    name: 'Generation A',
    lat: 30,
    lon: -97,
    streamUrl: 'https://radio.example.com/a.mp3',
    homepage: null,
    tags: ['news'],
    languages: ['English'],
    state: 'Texas',
    country: 'United States',
    countryCode: 'US',
    metadataTrust: 'untrusted-community',
    codec: 'MP3',
    bitrate: 128,
  };
  const stationB = {
    ...stationA,
    name: 'Generation B',
    streamUrl: 'https://radio.example.com/b.mp3',
  };
  const stationC = {
    ...stationB,
    id: '00000000-0000-4000-8000-000000000042',
    name: 'Generation C',
  };
  const publish = async (stationOrStations, acceptedGeneration) => {
    const stations = Array.isArray(stationOrStations) ? stationOrStations : [stationOrStations];
    globalThis.fetch = async () => new Response(JSON.stringify({
      stations,
      stale: false,
      degraded: false,
      acceptedGeneration,
      catalogInstance: 'qa-instance-a',
      updatedAt: new Date().toISOString(),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    await radioLayer.update();
  };

  radioLayer.destroy();
  try {
    radioLayer.init(viewer);
    radioLayer.enable();
    await publish(stationA, 1);
    assert.equal(radioLayer.beginTuning(), true);
    assert.equal(radioLayer.previewTuningStation(stationA.id, { rotate: false }), true);
    assert.equal(getRadioUIState().tuningCatalogGeneration, 1);

    await publish(stationB, 2);
    assert.equal(getRadioUIState().tuningPreviewStationId, stationA.id);
    const changed = radioLayer.commitTuningStation(stationA.id, { origin: 'user' });
    assert.deepEqual(changed, {
      ok: false,
      reason: 'station-unavailable',
      stationId: stationA.id,
      generation: 1,
    });
    assert.equal(getRadioUIState().selected, null);
    assert.equal(getRadioUIState().tuningUnavailableStationId, stationA.id);

    assert.equal(radioLayer.beginTuning(), true);
    assert.equal(radioLayer.previewTuningStation(stationB.id, { rotate: false }), true);
    await publish(stationB, 3);
    const unchanged = radioLayer.commitTuningStation(stationB.id, { origin: 'user' });
    assert.equal(unchanged.ok, true);
    assert.equal(unchanged.generation, 2);
    assert.equal(getRadioUIState().selected?.name, 'Generation B');

    assert.equal(radioLayer.beginTuning(), true);
    assert.equal(radioLayer.previewTuningStation(stationB.id, { rotate: false }), true);
    await publish(stationC, 4);
    const removed = radioLayer.commitTuningStation(stationB.id, { origin: 'user' });
    assert.equal(removed.ok, false);
    assert.equal(removed.reason, 'station-unavailable');
    assert.equal(removed.stationId, stationB.id);
    assert.notEqual(getRadioUIState().selected?.id, stationC.id);

    await publish([stationA, stationC], 5);
    assert.equal(radioLayer.selectStation(stationA.id, { autoplay: false, focus: false }), true);
    assert.equal(radioLayer.beginTuning(), true);
    assert.equal(radioLayer.previewTuningStation(stationC.id, { rotate: false }), true);
    await publish([stationA, { ...stationC, name: 'Changed target' }], 6);
    const priorSelectionMismatch = radioLayer.commitTuningStation(stationC.id, { origin: 'user' });
    assert.equal(priorSelectionMismatch.ok, false);
    assert.equal(priorSelectionMismatch.reason, 'station-unavailable');
    assert.equal(getRadioUIState().selected, null);
    assert.equal(getRadioUIState().tuningUnavailableStationId, stationC.id);

    await publish([stationB, stationC], 7);
    assert.equal(radioLayer.selectStation(stationB.id, { autoplay: false, focus: false }), true);
    assert.equal(radioLayer.beginTuning(), true);
    assert.equal(radioLayer.previewTuningStation(stationB.id, { rotate: false }), true);
    await publish([{ ...stationB, name: 'Same ID replacement' }, stationC], 8);
    const sameIdMismatch = radioLayer.commitTuningStation(stationB.id, { origin: 'user' });
    assert.equal(sameIdMismatch.ok, false);
    assert.equal(sameIdMismatch.reason, 'station-unavailable');
    assert.equal(getRadioUIState().selected, null);
    assert.equal(getRadioUIState().tuningUnavailableStationId, stationB.id);
  } finally {
    globalThis.fetch = originalFetch;
    radioLayer.destroy();
  }
});

test('failed exact tuner release cannot consume a stale playback fallback', async () => {
  const originalFetch = globalThis.fetch;
  const originalAudio = globalThis.Audio;
  const playUrls = [];
  const stationRows = [
    {
      id: '00000000-0000-4000-8000-000000000071',
      name: 'Exact target',
      lat: 30,
      lon: -97,
      streamUrl: 'https://radio.example.com/exact.mp3',
      homepage: null,
      tags: ['news'],
      languages: ['English'],
      state: 'Texas',
      country: 'United States',
      countryCode: 'US',
      metadataTrust: 'untrusted-community',
      codec: 'MP3',
      bitrate: 128,
    },
    {
      id: '00000000-0000-4000-8000-000000000072',
      name: 'Stale fallback',
      lat: 31,
      lon: -98,
      streamUrl: 'https://radio.example.com/fallback.mp3',
      homepage: null,
      tags: ['news'],
      languages: ['English'],
      state: 'Texas',
      country: 'United States',
      countryCode: 'US',
      metadataTrust: 'untrusted-community',
      codec: 'MP3',
      bitrate: 128,
    },
  ];
  globalThis.Audio = class FakeAudio {
    constructor() {
      this.volume = 0.8;
      this.src = '';
    }

    addEventListener() {}
    pause() {}
    play() {
      playUrls.push(this.src);
      if (this.src === stationRows[0].streamUrl) {
        return Promise.reject(new DOMException('Exact target unavailable', 'NotSupportedError'));
      }
      return Promise.resolve();
    }
    removeAttribute() { this.src = ''; }
    load() {}
  };
  globalThis.fetch = async (url) => String(url).startsWith('/api/gev/radio/click/')
    ? { ok: true }
    : new Response(JSON.stringify({
      stations: stationRows,
      stale: false,
      degraded: false,
      acceptedGeneration: 1,
      catalogInstance: 'qa-instance-a',
      updatedAt: new Date().toISOString(),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const viewer = {
    camera: { positionWC: { x: 7_000_000, y: 0, z: 0 } },
    scene: { canvas: { disableRootEvents: true, onwheel: null, addEventListener() {}, removeEventListener() {} } },
    dataSources: { add() {}, remove() {} },
    entities: { add(entity) { return entity; }, remove() {} },
  };

  radioLayer.destroy();
  try {
    radioLayer.init(viewer);
    radioLayer.enable();
    await radioLayer.update();
    assert.equal(radioLayer.selectStation(stationRows[0].id, { autoplay: false }), true);
    assert.equal(radioLayer.cycleStation(1, {
      stationIds: stationRows.map(({ id }) => id),
      autoplay: false,
    }), true, 'non-playing cycle creates the stale-fallback precondition');
    assert.equal(radioLayer.beginTuning(), true);
    assert.equal(radioLayer.previewTuningStation(stationRows[0].id, { rotate: false }), true);
    assert.equal(radioLayer.commitTuningStation(stationRows[0].id, { origin: 'user' }).ok, true);
    await new Promise((resolve) => setTimeout(resolve));
    const state = radioLayer.getUIState();
    assert.deepEqual(playUrls, [stationRows[0].streamUrl]);
    assert.equal(state.selected?.id, stationRows[0].id);
    assert.equal(state.audioState, 'error');
    assert.equal(state.tuningStatic, true);
    assert.equal(state.tuningAwaitingStationId, stationRows[0].id);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAudio === undefined) delete globalThis.Audio;
    else globalThis.Audio = originalAudio;
    radioLayer.destroy();
  }
});

test('tuner cancellation restores the frozen start marker after catalog removal', async () => {
  const originalFetch = globalThis.fetch;
  const originalAudio = globalThis.Audio;
  const selectedEntities = new Map();
  let playCalls = 0;
  let flyToCalls = 0;
  globalThis.Audio = class FakeAudio {
    constructor() {
      this.volume = 0.8;
    }

    addEventListener() {}
    pause() {}
    play() { playCalls += 1; return Promise.resolve(); }
    removeAttribute() {}
    load() {}
  };
  const viewer = {
    camera: {
      positionWC: { x: 7_000_000, y: 0, z: 0 },
      flyTo() { flyToCalls += 1; },
    },
    scene: {
      canvas: { disableRootEvents: true, onwheel: null, addEventListener() {}, removeEventListener() {} },
      requestRender() {},
    },
    dataSources: { add() {}, remove() {} },
    entities: {
      add(entity) { selectedEntities.set(entity.id, entity); return entity; },
      remove(entity) { return selectedEntities.delete(entity?.id); },
    },
  };
  const stationA = {
    id: '00000000-0000-4000-8000-000000000051',
    name: 'Frozen start',
    lat: 30,
    lon: -97,
    streamUrl: 'https://radio.example.com/start.mp3',
    homepage: null,
    tags: ['news'],
    languages: ['English'],
    state: 'Texas',
    country: 'United States',
    countryCode: 'US',
    metadataTrust: 'untrusted-community',
    codec: 'MP3',
    bitrate: 128,
  };
  const stationB = {
    ...stationA,
    id: '00000000-0000-4000-8000-000000000052',
    name: 'Preview target',
    lat: 44,
    lon: 12,
    streamUrl: 'https://radio.example.com/preview.mp3',
  };
  const publish = async (rows, acceptedGeneration) => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      stations: rows,
      stale: false,
      degraded: false,
      acceptedGeneration,
      catalogInstance: 'qa-instance-a',
      updatedAt: new Date().toISOString(),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    await radioLayer.update();
  };

  radioLayer.destroy();
  try {
    radioLayer.init(viewer);
    radioLayer.enable();
    radioLayer.setLifecyclePresentation({
      lifecycleState: 'enabled', enabled: true, uncertain: false,
    });
    let nextGeneration = 1;
    const restoreRemovedStartMarker = async () => {
      await publish([stationA, stationB], nextGeneration);
      nextGeneration += 1;
      assert.equal(radioLayer.selectStation(stationA.id, { autoplay: false, focus: false }), true);
      const startMarker = selectedEntities.get(`radio:selected:${stationA.id}`);
      assert.ok(startMarker);
      assert.equal(radioLayer.beginTuning(), true);
      assert.equal(radioLayer.previewTuningStation(stationB.id, { rotate: false }), true);
      await publish([stationB], nextGeneration);
      nextGeneration += 1;
      assert.equal(getRadioUIState().selected, null);
      assert.equal(radioLayer.cancelTuning(), true);
      const restoredMarker = selectedEntities.get(`radio:selected:${stationA.id}`);
      assert.ok(restoredMarker, 'the frozen start marker remains visible after cancellation');
      assert.deepEqual(restoredMarker.position, startMarker.position);
      assert.equal(getRadioUIState().tuningRestoredStationId, stationA.id);
      assert.equal(getRadioUIState().tuningActive, false);
      assert.equal(getRadioUIState().selected, null, 'stale marker never becomes playback authority');
      assert.equal(playCalls, 0);
      assert.equal(flyToCalls, 0);
      return radioLayer.getAcceptedCatalogSnapshot();
    };

    const sameFilterSnapshot = await restoreRemovedStartMarker();
    const sameFilter = getRadioUIState().filter;
    assert.equal(radioLayer.setFilter(sameFilter), true);
    assert.equal(getRadioUIState().filter, sameFilter);
    assert.equal(getRadioUIState().tuningRestoredStationId, null);
    assert.equal(selectedEntities.has(`radio:selected:${stationA.id}`), false);
    assert.equal(radioLayer.getAcceptedCatalogSnapshot(), sameFilterSnapshot);
    assert.equal(getRadioUIState().selected, null);
    assert.equal(playCalls, 0);
    assert.equal(flyToCalls, 0);

    const changedFilterSnapshot = await restoreRemovedStartMarker();
    assert.equal(radioLayer.setFilter('news'), true);
    assert.equal(getRadioUIState().filter, 'news');
    assert.equal(getRadioUIState().tuningRestoredStationId, null);
    assert.equal(selectedEntities.has(`radio:selected:${stationA.id}`), false);
    assert.equal(radioLayer.getAcceptedCatalogSnapshot(), changedFilterSnapshot);
    assert.equal(getRadioUIState().selected, null);
    assert.equal(playCalls, 0);
    assert.equal(flyToCalls, 0);

    const equalGenerationSnapshot = await restoreRemovedStartMarker();
    await publish([stationB], equalGenerationSnapshot.generation);
    assert.equal(
      getRadioUIState().tuningRestoredStationId,
      null,
      'the next accepted equal-generation refresh clears the presentation-only marker',
    );
    assert.equal(selectedEntities.has(`radio:selected:${stationA.id}`), false);
    assert.equal(radioLayer.getAcceptedCatalogSnapshot(), equalGenerationSnapshot);
    assert.equal(playCalls, 0);
    assert.equal(flyToCalls, 0);

    assert.equal(radioLayer.selectStation(stationB.id, { autoplay: false, focus: false }), true);
    assert.equal(getRadioUIState().tuningRestoredStationId, null);
    assert.equal(selectedEntities.has(`radio:selected:${stationA.id}`), false);
  } finally {
    globalThis.fetch = originalFetch;
    radioLayer.destroy();
    if (originalAudio === undefined) delete globalThis.Audio;
    else globalThis.Audio = originalAudio;
  }
});

test('Radio public tuner, filter, and resume mutations require certain enabled lifecycle authority', async () => {
  const originalFetch = globalThis.fetch;
  const stationRows = [{
    id: '00000000-0000-4000-8000-000000000061',
    name: 'Lifecycle station',
    lat: 30,
    lon: -97,
    streamUrl: 'https://radio.example.com/lifecycle.mp3',
    homepage: null,
    tags: ['news'],
    languages: ['English'],
    state: 'Texas',
    country: 'United States',
    countryCode: 'US',
    metadataTrust: 'untrusted-community',
    codec: 'MP3',
    bitrate: 128,
  }];
  globalThis.fetch = async () => new Response(JSON.stringify({
    stations: stationRows,
    stale: false,
    degraded: false,
    acceptedGeneration: 1,
    catalogInstance: 'qa-instance-a',
    updatedAt: new Date().toISOString(),
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const viewer = {
    camera: { positionWC: { x: 7_000_000, y: 0, z: 0 } },
    scene: { canvas: { disableRootEvents: true, onwheel: null, addEventListener() {}, removeEventListener() {} } },
    dataSources: { add() {}, remove() {} },
    entities: { add(entity) { return entity; }, remove() {} },
  };
  viewer.scene.requestRender = () => {};

  radioLayer.destroy();
  try {
    radioLayer.init(viewer);
    radioLayer.enable();
    await radioLayer.update();
    radioLayer.setLifecyclePresentation({
      lifecycleState: 'enabled', enabled: true, uncertain: false,
    });
    assert.equal(radioLayer.beginTuning(), true);
    assert.equal(radioLayer.setTuningStatic(false), true);

    for (const presentation of [
      { lifecycleState: 'disabled', enabled: false, uncertain: false },
      { lifecycleState: 'enabling', enabled: false, uncertain: false },
      { lifecycleState: 'disabling', enabled: true, uncertain: false },
      { lifecycleState: 'enabled', enabled: true, uncertain: true },
    ]) {
      radioLayer.setLifecyclePresentation(presentation);
      const before = getRadioUIState();
      assert.equal(radioLayer.setTuningStatic(true), false, presentation.lifecycleState);
      assert.equal(radioLayer.setFilter('news'), false, presentation.lifecycleState);
      assert.equal(await radioLayer.togglePlayback({ origin: 'user' }), false, presentation.lifecycleState);
      const after = getRadioUIState();
      assert.equal(after.tuningStatic, before.tuningStatic, presentation.lifecycleState);
      assert.equal(after.filter, before.filter, presentation.lifecycleState);
      assert.equal(after.selected, null, presentation.lifecycleState);
      assert.equal(after.audioState, 'stopped', presentation.lifecycleState);
    }

    radioLayer.setLifecyclePresentation({
      lifecycleState: 'enabled', enabled: true, uncertain: false,
    });
    assert.equal(radioLayer.setTuningStatic(true), true);
    assert.equal(getRadioUIState().tuningStatic, true);
    assert.equal(radioLayer.cancelTuning(), true);
    assert.equal(radioLayer.setFilter('news'), true);
    assert.equal(getRadioUIState().filter, 'news');
  } finally {
    globalThis.fetch = originalFetch;
    radioLayer.destroy();
  }
});

test('tuner refuses a degraded fallback that has no accepted catalog generation', async () => {
  const originalFetch = globalThis.fetch;
  const viewer = {
    camera: { positionWC: { x: 7_000_000, y: 0, z: 0 } },
    scene: { canvas: { disableRootEvents: true, onwheel: null, addEventListener() {}, removeEventListener() {} } },
    dataSources: { add() {}, remove() {} },
    entities: { add(entity) { return entity; }, remove() {} },
  };
  const station = {
    id: '00000000-0000-4000-8000-000000000043',
    name: 'Degraded Fallback',
    lat: 30,
    lon: -97,
    streamUrl: 'https://radio.example.com/degraded.mp3',
    homepage: null,
    tags: ['news'],
    languages: ['English'],
    state: 'Texas',
    country: 'United States',
    countryCode: 'US',
    metadataTrust: 'untrusted-community',
    codec: 'MP3',
    bitrate: 128,
  };

  radioLayer.destroy();
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      stations: [station],
      stale: false,
      degraded: true,
      acceptedGeneration: null,
      updatedAt: new Date().toISOString(),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    radioLayer.init(viewer);
    radioLayer.enable();
    await radioLayer.update();

    assert.equal(getRadioUIState().stationCount, 1, 'fallback remains visible outside the tuner');
    assert.equal(getRadioUIState().acceptedCatalogGeneration, null);
    assert.deepEqual(radioLayer.getTunerStations(), []);
    assert.equal(radioLayer.beginTuning(), false);
    assert.equal(getRadioUIState().tuningActive, false);
    assert.equal(getRadioUIState().tuningCatalogGeneration, null);
  } finally {
    globalThis.fetch = originalFetch;
    radioLayer.destroy();
  }
});

test('accepted snapshots allowlist station fields and never regress generation identity', async () => {
  const originalFetch = globalThis.fetch;
  const now = new Date().toISOString();
  const station = {
    id: '00000000-0000-4000-8000-000000000011',
    name: 'Generation One',
    lat: 30.2672,
    lon: -97.7431,
    streamUrl: 'https://stream.example.org/one.mp3',
    homepage: null,
    tags: ['news'],
    languages: ['English'],
    state: 'Texas',
    country: 'United States',
    countryCode: 'US',
    metadataTrust: 'untrusted-community',
    codec: 'MP3',
    bitrate: 128,
    extension: { mutable: true },
  };
  const viewer = {
    camera: { positionWC: { x: 7_000_000, y: 0, z: 0 } },
    scene: { canvas: { disableRootEvents: true, onwheel: null, addEventListener() {}, removeEventListener() {} } },
    dataSources: { add() {}, remove() {} },
    entities: { add(entity) { return entity; }, remove() {} },
  };
  const serve = (stations, acceptedGeneration, catalogInstance = 'qa-instance-a') => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      stations,
      stale: false,
      degraded: false,
      acceptedGeneration,
      catalogInstance,
      updatedAt: now,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  radioLayer.destroy();
  try {
    radioLayer.init(viewer);
    serve([station], 1);
    radioLayer.enable();
    await radioLayer.update();
    const generationOne = getRadioAcceptedCatalogSnapshot();
    assert.equal(generationOne.generation, 1);
    assert.equal('extension' in generationOne.stations[0], false);

    const forgedSameGeneration = {
      ...station,
      id: '00000000-0000-4000-8000-000000000012',
      name: 'Forged Same Generation',
    };
    serve([forgedSameGeneration], 1);
    await radioLayer.update();
    assert.strictEqual(getRadioAcceptedCatalogSnapshot(), generationOne);
    assert.equal(getRadioUIState().selected, null);
    assert.equal(getRadioUIState().stationCount, 1);

    const generationTwoStation = {
      ...station,
      id: '00000000-0000-4000-8000-000000000013',
      name: 'Generation Two',
    };
    serve([generationTwoStation], 2);
    await radioLayer.update();
    const generationTwo = getRadioAcceptedCatalogSnapshot();
    assert.notStrictEqual(generationTwo, generationOne);
    assert.equal(generationTwo.generation, 2);
    assert.equal(generationTwo.stations[0].id, generationTwoStation.id);

    serve([station], 1);
    await radioLayer.update();
    assert.strictEqual(getRadioAcceptedCatalogSnapshot(), generationTwo);
    assert.equal(getRadioUIState().stationCount, 1);
    assert.equal(getRadioUIState().stale, true);
    assert.equal(getRadioUIState().degraded, true);
    assert.match(getRadioUIState().error, /refresh failed/i);

    // Producer restart: a NEW instance token restarts the generation sequence.
    // Generation 1 from instance B is a fresh catalog, not a repeat of the old
    // instance's generation 1 and not a regression from its generation 2.
    const restartStation = {
      ...station,
      id: '00000000-0000-4000-8000-000000000021',
      name: 'Post Restart Station',
    };
    serve([restartStation], 1, 'qa-instance-b');
    await radioLayer.update();
    const postRestart = getRadioAcceptedCatalogSnapshot();
    assert.notStrictEqual(postRestart, generationTwo);
    assert.equal(postRestart.instance, 'qa-instance-b');
    assert.equal(postRestart.generation, 1);
    assert.equal(postRestart.stations[0].id, restartStation.id);
    assert.equal(getRadioUIState().stationCount, 1);
    assert.equal(getRadioUIState().stale, false);
    assert.equal(getRadioUIState().degraded, false);
    assert.equal(getRadioUIState().error, null);

    // Same generation NUMBER as the pre-restart snapshot from yet another
    // instance must also fully reconcile — equal numbers across instances are
    // different catalogs, not "unchanged".
    const secondRestartStation = {
      ...station,
      id: '00000000-0000-4000-8000-000000000022',
      name: 'Second Restart Station',
    };
    serve([secondRestartStation], 1, 'qa-instance-c');
    await radioLayer.update();
    const secondRestart = getRadioAcceptedCatalogSnapshot();
    assert.equal(secondRestart.instance, 'qa-instance-c');
    assert.equal(secondRestart.stations[0].id, secondRestartStation.id);
  } finally {
    globalThis.fetch = originalFetch;
    radioLayer.destroy();
  }
});

test('update abort, destroy, and re-init invalidate the prior session and reset catalog telemetry', async () => {
  const originalFetch = globalThis.fetch;
  let resolveFetch;
  let requestSignal = null;
  const viewer = {
    camera: { positionWC: { x: 7_000_000, y: 0, z: 0 } },
    scene: { canvas: { disableRootEvents: true, onwheel: null, addEventListener() {}, removeEventListener() {} } },
    dataSources: { add() {}, remove() {} },
    entities: { add(entity) { return entity; }, remove() {} },
  };
  const lateStation = {
    id: '00000000-0000-4000-8000-000000000099',
    name: 'Late Station',
    lat: 30,
    lon: -97,
    streamUrl: 'https://radio.example.com/late.mp3',
    homepage: null,
    tags: ['news'],
    languages: ['English'],
    state: 'Texas',
    country: 'United States',
    countryCode: 'US',
    metadataTrust: 'untrusted-community',
    codec: 'MP3',
    bitrate: 128,
  };

  radioLayer.destroy();
  try {
    globalThis.fetch = (_url, options) => {
      requestSignal = options.signal;
      return new Promise((resolve) => { resolveFetch = resolve; });
    };
    radioLayer.init(viewer);
    radioLayer.enable();
    const pending = radioLayer.update();
    assert.equal(getRadioUIState().loading, true);
    radioLayer.disable();
    assert.equal(requestSignal.aborted, true);
    assert.equal(getRadioUIState().loading, false);

    radioLayer.destroy();
    radioLayer.init(viewer);
    const cleanState = getRadioUIState();
    assert.deepEqual({
      enabled: cleanState.enabled,
      loading: cleanState.loading,
      stale: cleanState.stale,
      degraded: cleanState.degraded,
      error: cleanState.error,
      updatedAt: cleanState.updatedAt,
      stationCount: cleanState.stationCount,
      selected: cleanState.selected,
      audioState: cleanState.audioState,
      voiceDucked: cleanState.voiceDucked,
      voiceRestoring: cleanState.voiceRestoring,
      acceptedCatalogGeneration: cleanState.acceptedCatalogGeneration,
    }, {
      enabled: false,
      loading: false,
      stale: false,
      degraded: false,
      error: null,
      updatedAt: null,
      stationCount: 0,
      selected: null,
      audioState: 'stopped',
      voiceDucked: false,
      voiceRestoring: false,
      acceptedCatalogGeneration: null,
    });
    assert.equal(getRadioAcceptedCatalogSnapshot().generation, null);

    resolveFetch(new Response(JSON.stringify({
      stations: [lateStation],
      stale: false,
      degraded: false,
      acceptedGeneration: 99,
      catalogInstance: 'qa-instance-a',
      updatedAt: new Date().toISOString(),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await pending;
    assert.deepEqual(getRadioUIState(), cleanState, 'retired update completion is inert after re-init');
  } finally {
    globalThis.fetch = originalFetch;
    radioLayer.destroy();
  }
});

test('All is the initial Radio filter', () => {
  assert.equal(DEFAULT_RADIO_FILTER, 'all');
  assert.equal(getRadioUIState().filter, 'all');
});

test('local viewport ranking chooses geographic distance without a language override', () => {
  const ranked = rankRadioStationsForViewport([
    { id: 'english-far', lat: 30.5, lon: -97.7, languages: ['English'] },
    { id: 'spanish-near', lat: 30.2673, lon: -97.7430, languages: ['Spanish'] },
    { id: 'english-near', lat: 30.28, lon: -97.74, languages: ['en'] },
  ], { lat: 30.2672, lon: -97.7431 });
  assert.deepEqual(ranked.map((station) => station.id), ['spanish-near', 'english-near', 'english-far']);
});

test('global viewport ranking prefers English stations, then distance', () => {
  const ranked = rankRadioStationsForViewport([
    { id: 'spanish-nearest', lat: 0, lon: 0, languages: ['Spanish'] },
    { id: 'english-far', lat: 15, lon: 0, languages: ['English'] },
    { id: 'english-near', lat: 5, lon: 0, languages: ['eng'] },
  ], { lat: 0, lon: 0 }, { preferEnglish: true });
  assert.deepEqual(ranked.map((station) => station.id), ['english-near', 'english-far', 'spanish-nearest']);
  assert.equal(isEnglishRadioStation(ranked[0]), true);
});

test('explicit Radio requests combine category, country, station name, and distance', () => {
  const rows = [
    { id: 'music-austin', name: 'Austin Music', tags: ['music'], countryCode: 'US', country: 'United States', lat: 30.26, lon: -97.74 },
    { id: 'news-dallas', name: 'Texas News', tags: ['news'], countryCode: 'US', country: 'United States', lat: 32.77, lon: -96.79 },
    { id: 'news-austin', name: 'Austin Public News', tags: ['news'], countryCode: 'US', country: 'United States', lat: 30.27, lon: -97.75 },
    { id: 'news-mexico', name: 'Noticias', tags: ['news'], countryCode: 'MX', country: 'Mexico', lat: 25.68, lon: -100.31 },
  ];
  const ranked = rankRadioStationsForRequest(rows, {
    categoryId: 'news',
    country: 'US',
    anchor: { lat: 30.2672, lon: -97.7431 },
  });
  assert.deepEqual(ranked.map((station) => station.id), ['news-austin', 'news-dallas']);
  assert.equal(rankRadioStationsForRequest(rows, {
    categoryId: 'news',
    stationQuery: 'public',
  })[0].id, 'news-austin');
});

test('viewport ranking treats the antimeridian as adjacent', () => {
  const ranked = rankRadioStationsForViewport([
    { id: 'far', lat: 0, lon: 150, languages: ['English'] },
    { id: 'across-dateline', lat: 0, lon: -179.9, languages: ['English'] },
  ], { lat: 0, lon: 179.9 });
  assert.equal(ranked[0].id, 'across-dateline');
});

test('global-view threshold tolerates Cesium altitude round-off without widening the boundary', () => {
  assert.equal(radioViewIsGlobal(1_999_999.6), true);
  assert.equal(radioViewIsGlobal(1_999_998.4), false);
});

test('Radio picks resolve ordinary, selected, primitive, and clustered entity ids', () => {
  assert.equal(radioStationIdFromPick({ id: 'radio:alpha' }), 'alpha');
  assert.equal(radioStationIdFromPick({ primitive: { id: 'radio:beta' } }), 'beta');
  assert.equal(radioStationIdFromPick({ id: { id: 'radio:selected:gamma' } }), 'gamma');
  assert.equal(radioStationIdFromPick({ id: [{ id: 'other' }, { id: 'radio:delta' }] }), 'delta');
  assert.equal(radioStationIdFromPick({ primitive: { id: [{ id: 'radio:cluster-first' }, { id: 'radio:cluster-second' }] } }), 'cluster-first');
  assert.equal(radioStationIdFromPick({ id: 'flights:abc' }), null);
});

test('selected Radio station bracket is a transparent four-corner category-colored SVG', () => {
  const svg = radioSelectionBracketSvg('#44adff');
  assert.match(svg, /viewBox="0 0 40 40"/);
  assert.match(svg, /M2 13V2H13 M27 2H38V13 M38 27V38H27 M13 38H2V27/);
  assert.match(svg, /stroke="#44adff"/);
  assert.match(radioSelectionBracketSvg('bad-color'), /stroke="#9aa7b3"/);
});

test('Radio text uses protected selected and bounded ambient WorldOverlay entries', () => {
  const position = { x: 1, y: 2, z: 3 };
  const selected = createRadioSelectedOverlayEntry({
    id: 'station-a',
    name: 'Austin News 93.9 FM - KQA',
    tags: ['news'],
  }, position);
  assert.equal(selected.variant, 'selected');
  assert.equal(selected.selected, true);
  assert.equal(selected.protected, true);
  assert.equal(selected.paintLane, 'selected');
  assert.equal(selected.title, '93.9 FM — Austin News');
  assert.equal(selected.position, position);
  assert.equal(selected.maxDistance, RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M);

  const cluster = createRadioClusterOverlayEntry({
    id: 'a:z:12',
    position,
    text: '12 NEWS',
    accent: '#44adff',
    stationCount: 12,
  });
  assert.equal(cluster.variant, 'label');
  assert.equal(cluster.paintLane, 'ambient-label');
  assert.equal(cluster.collisionGroup, 'ambient-label');
  assert.equal(cluster.horizonCull, true);
  assert.equal(cluster.maxDistance, RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M);
  assert.equal(cluster.distanceScale.far, RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M);
  assert.equal(cluster.title, '12 NEWS');
  assert.equal(cluster.priority, 12);
  assert.equal(cluster.stateless, true);
  assert.equal(cluster.edgeFade, 'none');
  assert.equal(RADIO_OVERLAY_SOURCE_OPTIONS.cohortLimit, RADIO_OVERLAY_COHORT_LIMIT);
  assert.ok(RADIO_OVERLAY_COHORT_LIMIT < 750);

  const singleton = createRadioSingletonOverlayEntry({
    station: { id: 'station-b', name: '100.3 The River - WQRV', tags: ['public safety'] },
    position,
    priority: 1.5,
  });
  assert.equal(singleton.id, 'station:station-b');
  assert.equal(singleton.title, '100.3 FM — The River');
  assert.equal(singleton.paintLane, 'ambient-label');
  assert.equal(singleton.collisionGroup, 'ambient-label');
  assert.equal(singleton.interactive, false);
  assert.equal(singleton.horizonCull, true);
  assert.equal(singleton.maxDistance, RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M);
  assert.equal(singleton.distanceScale.far, RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M);
  assert.equal(singleton.priority, 1.5);
  assert.equal(singleton.stateless, true);
});

test('Radio singleton labels are zoom-aware, nearest-first, stable, and bounded', () => {
  assert.equal(radioSingletonLabelLimit(25_000_000), RADIO_SINGLETON_GLOBAL_LIMIT);
  assert.equal(radioSingletonLabelLimit(2_000_000), RADIO_SINGLETON_GLOBAL_LIMIT);
  assert.equal(radioSingletonLabelLimit(1_999_999), RADIO_SINGLETON_MID_LIMIT);
  assert.equal(radioSingletonLabelLimit(250_000), RADIO_SINGLETON_MID_LIMIT);
  assert.equal(radioSingletonLabelLimit(249_999), RADIO_SINGLETON_NEAR_LIMIT);
  const ranked = selectRadioSingletonCandidates([
    { station: { id: 'far' }, distanceM: 30 },
    { station: { id: 'near-z' }, distanceM: 10 },
    { station: { id: 'near-a' }, distanceM: 10 },
  ], 2);
  assert.deepEqual(ranked.map(({ station }) => station.id), ['near-a', 'near-z']);
});

test('directory tuner maps every absolute slot to an available station', () => {
  assert.deepEqual(radioTunerSlot(0, 4), {
    slot: 0, max: 3, locked: true, stationIndex: 0, leftIndex: 0, rightIndex: 0,
  });
  assert.deepEqual(radioTunerSlot(1, 4), {
    slot: 1, max: 3, locked: true, stationIndex: 1, leftIndex: 1, rightIndex: 1,
  });
  assert.deepEqual(radioTunerSlot(99, 4), {
    slot: 3, max: 3, locked: true, stationIndex: 3, leftIndex: 3, rightIndex: 3,
  });
  assert.equal(radioTunerSlot(0, 0).locked, false);
});

test('directory tuner pointer progress maps left, center, right, and midpoint ties exactly', () => {
  assert.deepEqual(radioTunerPointerPosition(7, 0, 114, 750), {
    ratio: 0, coordinate: 0, stationIndex: 0,
  });
  assert.deepEqual(radioTunerPointerPosition(57, 0, 114, 750), {
    ratio: 0.5, coordinate: 374.5, stationIndex: 375,
  });
  assert.deepEqual(radioTunerPointerPosition(107, 0, 114, 750), {
    ratio: 1, coordinate: 749, stationIndex: 749,
  });
  assert.deepEqual(radioTunerPointerPosition(50, 10, 80, 1), {
    ratio: 0.5, coordinate: 0, stationIndex: 0,
  });
  assert.equal(radioTunerPointerPosition(50, 10, 80, 0).stationIndex, -1);
  assert.deepEqual(radioTunerCommitSlot(2.5, 5), radioTunerSlot(3, 5));
});

test('directory tuner bands preserve stable filtered order without injecting outside selections', () => {
  const ranked = Array.from({ length: 800 }, (_, index) => ({ id: `station-${index}` }));
  const selected = { id: 'selected-outside-band' };
  const band = buildRadioTunerBand(ranked, selected, 750);
  assert.equal(band.length, 750);
  assert.deepEqual(band, ranked.slice(0, 750));
  assert.ok(!band.includes(selected));
  assert.deepEqual(buildRadioTunerBand(ranked, ranked[5], 24), ranked.slice(0, 24));
});

test('directory tuner virtual tape is bounded and moves opposite the needle', () => {
  const at100 = buildRadioTunerTicks(100, 750, 300);
  const at101 = buildRadioTunerTicks(101, 750, 300);
  assert.ok(at100.ticks.length <= Math.ceil(286 / at100.pitchPx) + 6);
  assert.ok(at101.needleX > at100.needleX);
  const sharedIndex = at100.ticks.find((tick) => at101.ticks.some((next) => next.stationIndex === tick.stationIndex));
  assert.ok(sharedIndex);
  const before = at100.ticks.find((tick) => tick.stationIndex === sharedIndex.stationIndex);
  const after = at101.ticks.find((tick) => tick.stationIndex === sharedIndex.stationIndex);
  assert.ok(after.xPx < before.xPx);
  assert.ok(Math.abs(after.xPx - before.xPx) >= 4 * (at101.needleX - at100.needleX) - 1e-9);
  const singleton = buildRadioTunerTicks(0, 1, 300);
  assert.equal(singleton.ratio, 0.5);
  assert.equal(singleton.ticks.length, 1);
  assert.equal(buildRadioTunerTicks(0, 0, 300).ticks.length, 0);
});

test('station camera plans preserve altitude and viewing orientation without zooming', () => {
  const nadir = radioStationCameraPlan({ lat: 30, lon: -97 }, {
    height: 600,
    heading: 0,
    pitch: -Math.PI / 2,
    roll: 0,
  });
  assert.ok(Math.abs(nadir.lat - 30) < 1e-9);
  assert.ok(Math.abs(nadir.lon + 97) < 1e-9);
  assert.equal(nadir.height, 600);
  assert.equal(nadir.heading, 0);
  assert.equal(nadir.pitch, -Math.PI / 2);
  assert.equal(nadir.roll, 0);
  const oblique = radioStationCameraPlan({ lat: 30, lon: -97 }, {
    height: 600,
    heading: 0,
    pitch: -Math.PI / 6,
    roll: 0.2,
  });
  assert.equal(oblique.height, 600);
  assert.equal(oblique.heading, 0);
  assert.equal(oblique.pitch, -Math.PI / 6);
  assert.equal(oblique.roll, 0.2);
  assert.ok(oblique.lat < 30);
  assert.ok(Math.abs(oblique.lon + 97) < 0.001);
});

test('Radio recenters clipped global and below-center closer Earth discs', () => {
  const centered = {
    earthCenterX: 600,
    earthCenterY: 400,
    earthRadius: 250,
    keyholeCenterX: 600,
    keyholeCenterY: 400,
    keyholeRadius: 420,
  };
  assert.equal(radioGlobeNeedsRecentering(centered), false);
  assert.equal(radioGlobeNeedsRecentering({ ...centered, earthCenterY: 560 }), true);
  assert.equal(radioGlobeNeedsRecentering({ ...centered, earthCenterX: 755 }), true);
  assert.equal(radioGlobeNeedsRecentering({ ...centered, earthRadius: 405 }), false);
  const closer = { ...centered, earthRadius: 900 };
  assert.equal(radioGlobeNeedsRecentering({ ...closer, earthCenterY: 800 }), false);
  assert.equal(radioGlobeNeedsRecentering({ ...closer, earthCenterY: 1_300 }), true);
  assert.equal(radioGlobeNeedsRecentering(null), false);
});

test('Radio recovery preserves closer altitude and caps extreme full-globe zoom', () => {
  assert.equal(radioGlobeRecenterHeight(2_915_647, false), 2_915_647);
  assert.equal(radioGlobeRecenterHeight(9_748_850, true), 9_748_850);
  assert.equal(radioGlobeRecenterHeight(97_488_500, true), 13_000_000);
  assert.equal(radioGlobeRecenterHeight(Number.NaN, true), null);
});

test('Radio camera navigation yields to every live tracked-entity owner', () => {
  const viewer = { camera: {} };
  assert.equal(radioCameraNavigationAllowed(viewer), true);
  for (const gevTrackedId of ['flights:abc123', 'military:def456']) {
    const trackedEntity = { gevTrackedId };
    viewer.trackedEntity = trackedEntity;
    assert.equal(radioCameraNavigationAllowed(viewer), false, gevTrackedId);
    assert.equal(viewer.trackedEntity, trackedEntity);
  }
  viewer.trackedEntity = undefined;
  assert.equal(radioCameraNavigationAllowed(viewer), true);
  assert.equal(radioCameraNavigationAllowed({ trackedEntity: {} }), false);
  assert.equal(radioCameraNavigationAllowed(null), false);
});

test('tuner static spans drag and broadcaster handoff but voice ducking silences it', () => {
  assert.equal(radioTuningStaticShouldPlay({ tuningActive: true, tuningStatic: true }), true);
  assert.equal(radioTuningStaticShouldPlay({ tuningStatic: true, awaitingStationId: 'news' }), true);
  assert.equal(radioTuningStaticShouldPlay({
    tuningStatic: true,
    awaitingStationId: 'news',
    voiceDucked: true,
  }), false);
  assert.equal(radioTuningStaticShouldPlay({ tuningStatic: false, awaitingStationId: 'news' }), false);
});

test('station horizon scans ignore stationary camera noise but detect movement', () => {
  const prior = { x: 1_000, y: -2_000, z: 3_000 };
  assert.equal(radioCameraPositionChanged(prior, { x: 1_000, y: -2_000, z: 3_000 }), false);
  assert.equal(radioCameraPositionChanged(prior, { x: 1_000.5, y: -2_000, z: 3_000 }), false);
  assert.equal(radioCameraPositionChanged(prior, { x: 1_002, y: -2_000, z: 3_000 }), true);
  assert.equal(radioCameraPositionChanged(null, prior), true);
});

test('voice ducking preserves the user-owned Radio volume', async () => {
  radioLayer.destroy();
  radioLayer.enable();
  radioLayer.setLifecyclePresentation({
    lifecycleState: 'enabled', enabled: true, uncertain: false,
  });
  try {
    setRadioVoiceDucking(true);
    let state = getRadioUIState();
    assert.equal(state.voiceDucked, true);
    assert.equal(state.volume, 0.8);
    assert.equal(state.effectiveVolume, 0);
    assert.equal(setRadioVolume(0.42), true);
    state = getRadioUIState();
    assert.equal(state.voiceDucked, true);
    assert.equal(state.volume, 0.42);
    assert.equal(state.effectiveVolume, 0);
    setRadioVoiceDucking(false, { restoreDelayMs: 0, restoreDurationMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 25));
    state = getRadioUIState();
    assert.equal(state.voiceDucked, false);
    assert.equal(state.voiceRestoring, false);
    assert.equal(state.volume, 0.42);
    assert.equal(state.effectiveVolume, 0.42);
  } finally {
    radioLayer.destroy();
  }
});

test('Radio volume requires certain enabled lifecycle authority', () => {
  radioLayer.destroy();
  assert.equal(setRadioVolume(0.2), false);
  assert.equal(getRadioUIState().volume, 0.8);

  radioLayer.enable();
  for (const presentation of [
    { lifecycleState: 'enabling', enabled: false, uncertain: false },
    { lifecycleState: 'disabling', enabled: true, uncertain: false },
    { lifecycleState: 'enabled', enabled: true, uncertain: true },
  ]) {
    radioLayer.setLifecyclePresentation(presentation);
    assert.equal(setRadioVolume(0.2), false, presentation.lifecycleState);
    assert.equal(getRadioUIState().volume, 0.8);
  }

  radioLayer.setLifecyclePresentation({
    lifecycleState: 'enabled', enabled: true, uncertain: false,
  });
  assert.equal(setRadioVolume(0.2), true);
  assert.equal(getRadioUIState().volume, 0.2);
  radioLayer.destroy();
});

test('voice playback confirmation waits for playing and requires a hard duck', async () => {
  let listener = () => {};
  let state = {
    audioState: 'loading',
    playingStationId: 'news',
    voiceDucked: true,
  };
  const confirmed = confirmRadioPlayback({
    startPlayback: async () => {
      state = { ...state, audioState: 'playing' };
      listener(state);
      return true;
    },
    subscribe: (next) => {
      listener = next;
      next({ ...state, audioState: 'stopped' });
      return () => { listener = () => {}; };
    },
    getState: () => state,
    timeoutMs: 50,
  });
  assert.equal(await confirmed, true);

  state = { ...state, voiceDucked: false };
  assert.equal(await confirmRadioPlayback({
    startPlayback: async () => true,
    subscribe: (next) => {
      next(state);
      return () => {};
    },
    getState: () => state,
    timeoutMs: 5,
  }), false);
});

test('voice playback confirmation accepts fallback buffering but times out safely', async () => {
  let listener = () => {};
  const state = {
    audioState: 'loading',
    playingStationId: 'fallback',
    voiceDucked: true,
  };
  const startedAt = Date.now();
  const confirmed = await confirmRadioPlayback({
    startPlayback: async () => false,
    subscribe: (next) => {
      listener = next;
      next(state);
      return () => { listener = () => {}; };
    },
    getState: () => state,
    timeoutMs: 10,
  });
  assert.equal(confirmed, false);
  assert.ok(Date.now() - startedAt >= 8);
});
