// Camera-ownership policy for user-issued destinations. The ORDER is the
// contract: cockpit refuses before anything is released, the release happens
// before the flight, and a deferred flight retires the moment ANY newer
// navigation intent claims the camera.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  announceNavigationAuthority,
  beginDeferredNavigation,
  NAVIGATION_AUTHORITY_EVENT,
  reassertNavigationHandoff,
  runExplicitNavigation,
  stampInitialShareGesture,
} from './navigationPolicy.js';

test('layer authority announcements distinguish passive autofocus from direct intent', () => {
  const events = [];
  const eventTarget = new EventTarget();
  eventTarget.addEventListener(NAVIGATION_AUTHORITY_EVENT, (event) => events.push(event.detail));
  announceNavigationAuthority('context-vessel-autofocus', {
    eventTarget,
    cancelPendingSelection: false,
  });
  announceNavigationAuthority('context-vessel-focus', { eventTarget });
  assert.deepEqual(events, [
    { reason: 'context-vessel-autofocus', cancelPendingSelection: false },
    { reason: 'context-vessel-focus', cancelPendingSelection: true },
  ]);
});

test('an initial globe gesture cancels the passive shared Follow selection', () => {
  const calls = [];
  const result = stampInitialShareGesture((options) => {
    calls.push(options);
    return 7;
  });
  assert.equal(result, 7);
  assert.deepEqual(calls, [{ cancelPendingSelection: true }]);
  assert.equal(stampInitialShareGesture(null), undefined);
});

/** Records every policy side effect in the order it happened. */
function spy(overrides = {}) {
  const log = [];
  return {
    log,
    showToast: (text) => log.push(`toast:${text}`),
    stamp: () => log.push('stamp'),
    release: () => log.push('release'),
    navigate: () => { log.push('navigate'); return 'flew'; },
    ...overrides,
  };
}

/**
 * The wiring StyleManager applies: one generation counter shared by every
 * explicit navigation intent AND by cockpit taking the camera. Deferred
 * flights capture their stamp and recheck it before flying.
 */
function navigator() {
  const state = { generation: 0, cockpitActive: false, log: [] };
  const stamp = () => { state.generation += 1; return state.generation; };
  const release = () => state.log.push('release');
  const showToast = (text) => state.log.push(`toast:${text}`);
  return {
    state,
    /** One explicit intent that flies immediately. Returns its stamp, or false. */
    navigate(noun) {
      return runExplicitNavigation({
        cockpitActive: state.cockpitActive,
        noun,
        showToast,
        stamp,
        release,
        navigate: (generation) => {
          state.log.push(`fly:${noun}`);
          return generation;
        },
      });
    },
    /** An intent whose flight resolves later (the geocoded search). */
    startDeferred(noun) {
      return beginDeferredNavigation({
        cockpitActive: state.cockpitActive,
        noun,
        showToast,
        stamp,
      });
    },
    /** The deferred flight finally resolving. */
    resolveDeferred(generation, label) {
      const cleared = reassertNavigationHandoff({
        generation,
        currentGeneration: state.generation,
        cockpitActive: state.cockpitActive,
        showToast,
        release,
      });
      if (cleared) state.log.push(`fly:${label}`);
      return cleared;
    },
    enterCockpit() {
      // Mirrors CockpitViewController's onCameraTakeover.
      stamp();
      state.cockpitActive = true;
    },
    exitCockpit() { state.cockpitActive = false; },
  };
}

test('a free camera is stamped, released, then flown — in that order', () => {
  const s = spy();
  const result = runExplicitNavigation({ cockpitActive: false, noun: 'location', ...s });
  assert.equal(result, 'flew');
  assert.deepEqual(s.log, ['stamp', 'release', 'navigate']);
});

test('the accepted intent hands its stamp to the flight', () => {
  let seen = null;
  runExplicitNavigation({ stamp: () => 42, navigate: (generation) => { seen = generation; } });
  assert.equal(seen, 42, 'a deferred flight needs its stamp to recheck later');
});

test('cockpit refuses without stamping or releasing anything', () => {
  // Releasing under cockpit destroys its hidden aircraft entity and the rig
  // silently exits on the next update — the refusal must come first.
  for (const noun of ['location', 'camera', 'vessel', 'fire']) {
    const s = spy();
    const result = runExplicitNavigation({ cockpitActive: true, noun, ...s });
    assert.equal(result, false);
    assert.deepEqual(s.log, [`toast:Exit cockpit to fly to a ${noun}`]);
  }
});

test('disposed navigation is inert before any camera or UI mutation', () => {
  const s = spy();
  const result = runExplicitNavigation({ disposed: true, cockpitActive: true, ...s });
  assert.equal(result, false);
  assert.deepEqual(s.log, []);
});

test('the refusal is a strict false, distinguishable from a flight result', () => {
  const refused = runExplicitNavigation({ cockpitActive: true, showToast() {} });
  assert.strictEqual(refused, false);
  // A navigate() that legitimately returns undefined is not a refusal.
  assert.strictEqual(runExplicitNavigation({ navigate: () => undefined }), undefined);
});

test('deferred handoff: the current request re-releases, then proceeds', () => {
  const s = spy();
  const ok = reassertNavigationHandoff({ generation: 4, currentGeneration: 4, ...s });
  assert.equal(ok, true);
  assert.deepEqual(s.log, ['release']);
});

test('deferred intent stamps without releasing a camera owner', () => {
  const s = spy({ stamp: () => { s.log.push('stamp'); return 7; } });
  assert.equal(beginDeferredNavigation({ ...s, noun: 'location' }), 7);
  assert.deepEqual(s.log, ['stamp']);
});

test('disposed deferred intent is inert before stamp or UI mutation', () => {
  const s = spy();
  assert.equal(beginDeferredNavigation({ disposed: true, cockpitActive: true, ...s }), false);
  assert.deepEqual(s.log, []);
});

test('disposed deferred work is inert before release', () => {
  const s = spy();
  assert.equal(reassertNavigationHandoff({
    generation: 4,
    currentGeneration: 4,
    disposed: true,
    ...s,
  }), false);
  assert.deepEqual(s.log, []);
});

test('deferred handoff: a superseded request neither flies nor releases', () => {
  // The newer intent owns the camera now — releasing here would yank it.
  const s = spy();
  const ok = reassertNavigationHandoff({ generation: 3, currentGeneration: 4, ...s });
  assert.equal(ok, false);
  assert.deepEqual(s.log, [], 'a stale flight must be completely inert');
});

test('deferred handoff: cockpit taken mid-flight refuses and explains', () => {
  const s = spy();
  const ok = reassertNavigationHandoff({
    generation: 4, currentGeneration: 4, cockpitActive: true, ...s,
  });
  assert.equal(ok, false);
  assert.deepEqual(s.log, ['toast:Exit cockpit to fly to a location']);
});

test('deferred handoff: supersession is checked before cockpit, so it stays silent', () => {
  const s = spy();
  reassertNavigationHandoff({ generation: 3, currentGeneration: 4, cockpitActive: true, ...s });
  assert.deepEqual(s.log, [], 'a stale request must not toast on the user');
});

// Interleavings: the generation advances on EVERY explicit intent, not just on
// another search. A search-only token left all of these open — the stale search
// still held the current token and flew over the newer destination.
test('interleaving: a canned destination during a search retires the search', () => {
  const nav = navigator();
  const searchGeneration = nav.startDeferred('location');
  nav.navigate('location'); // user clicks a city pill while the geocode runs
  assert.equal(nav.resolveDeferred(searchGeneration, 'search'), false);
  assert.deepEqual(nav.state.log, ['release', 'fly:location']);
  assert.ok(!nav.state.log.includes('fly:search'), 'the stale search must not fly');
});

test('interleaving: a clicked vessel during a search retires the search', () => {
  const nav = navigator();
  const searchGeneration = nav.startDeferred('location');
  nav.navigate('vessel');
  assert.equal(nav.resolveDeferred(searchGeneration, 'search'), false);
  assert.deepEqual(nav.state.log, ['release', 'fly:vessel']);
});

test('interleaving: a CCTV focus during a search retires the search', () => {
  const nav = navigator();
  const searchGeneration = nav.startDeferred('location');
  nav.navigate('camera');
  assert.equal(nav.resolveDeferred(searchGeneration, 'search'), false);
  assert.ok(!nav.state.log.includes('fly:search'));
});

test('interleaving: cockpit entered AND exited during a search still retires it', () => {
  // The cockpit flag is back to false by the time the flight resolves, so only
  // the generation stamped by the takeover can catch this one.
  const nav = navigator();
  const searchGeneration = nav.startDeferred('location');
  nav.enterCockpit();
  nav.exitCockpit();
  assert.equal(nav.state.cockpitActive, false);
  assert.equal(nav.resolveDeferred(searchGeneration, 'search'), false);
  assert.deepEqual(nav.state.log, [], 'the deferred search never released');
});

test('interleaving: an uninterrupted search still flies', () => {
  const nav = navigator();
  const searchGeneration = nav.startDeferred('location');
  assert.equal(nav.resolveDeferred(searchGeneration, 'search'), true);
  assert.deepEqual(nav.state.log, ['release', 'fly:search']);
});

test('interleaving: the newest of two searches wins', () => {
  const nav = navigator();
  const first = nav.startDeferred('location');
  const second = nav.startDeferred('location');
  assert.equal(nav.resolveDeferred(first, 'first'), false);
  assert.equal(nav.resolveDeferred(second, 'second'), true);
  assert.ok(!nav.state.log.includes('fly:first'));
  assert.ok(nav.state.log.includes('fly:second'));
});
