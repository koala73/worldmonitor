// First-run mission launcher.
//
// The map deliberately does not auto-enable live feeds on every visit: doing so
// would spend optional API quotas, surprise returning operators, and fight share
// links. A new visitor instead gets one compact, explicit choice after startup.
//
// SHOW POLICY (product decision, 2026-08-23). The launcher is NOT one-shot. A new
// operator needs the map explained more than once, so it returns every fresh
// browser session until they say otherwise:
//
//   - a share link never sees it — its author already chose the experience;
//   - `?welcome=0` suppresses, `?welcome=1` replays (it outranks BOTH the
//     session flag and the durable one, so support can always demo it);
//   - ticking "Don't show this again" writes the DURABLE suppression — that
//     tick is the only thing that stops it coming back;
//   - any other close (a mission, Explore manually, ESC) writes only the
//     SESSION flag, so it stays gone for this tab and returns next session.
//
// Choosing a mission is deliberately NOT durable suppression: picking a mission
// is enthusiasm, not "never show me this again".

/** Durable suppression. Written ONLY by the "Don't show this again" checkbox. */
export const FIRST_RUN_STORAGE_KEY = 'gev:first-run-mission:v1';
/** Per-session dismissal. Written by every close path; scoped to sessionStorage. */
export const FIRST_RUN_SESSION_KEY = 'gev:first-run-mission-session:v1';

/**
 * Configurable name for the fires/quakes mission. Flip this ONE constant to
 * re-label the tile; the alternates are pre-written so the choice is a taste
 * call at review time, not an edit.
 * @type {'ENVIRONMENTAL'|'EARTH_WATCH'|'ACTIVE_EVENTS'}
 */
export const ENVIRONMENTAL_LABEL_CHOICE = 'ENVIRONMENTAL';

const ENVIRONMENTAL_LABELS = Object.freeze({
  ENVIRONMENTAL: Object.freeze({ title: 'ENVIRONMENTAL' }),
  EARTH_WATCH: Object.freeze({ title: 'EARTH WATCH' }),
  ACTIVE_EVENTS: Object.freeze({ title: 'ACTIVE EVENTS' }),
});

/**
 * @param {string} [choice]
 * @returns {{title: string}} The label set the constant above selects.
 */
export function environmentalLabel(choice = ENVIRONMENTAL_LABEL_CHOICE) {
  return ENVIRONMENTAL_LABELS[choice] || ENVIRONMENTAL_LABELS.ENVIRONMENTAL;
}

/*
 * MISSION → APP STATE, AND WHAT IT IS ALLOWED TO PERSIST
 * ─────────────────────────────────────────────────────────────────────────────
 * Product decision: picking a mission carries the same weight as clicking the
 * toggles it represents — durable where those clicks are durable — but it must
 * never write a preference the visitor did not effectively choose by picking it.
 * Layer enablement IS durable in this app (`gev:layer-state:v2`, written by
 * LayerStateCoordinator._commitExplicit only for origin user/voice/tool), so:
 *
 *   TOUCHED, DURABLE      layer enables for the mission's OWN layers, at
 *                         `origin: 'user'` — identical to clicking those rows.
 *                         Choosing ENVIRONMENTAL *is* choosing those layers.
 *   TOUCHED, DURABLE      the Context panel reveal, but only for the two
 *                         Context missions, exactly as the visible Contacts /
 *                         Space Missions tabs do it. The globe missions open no
 *                         panel at all — nothing there needs explaining, and a
 *                         panel-collapse write is a pref nobody chose.
 *   TOUCHED, SESSION      the camera. Never persisted by anything.
 *   NOT TOUCHED           detection mode + density. The reasonable-defaults
 *                         landing owns the DENSE/75 start, and Contacts owns
 *                         detection through contactsDetectionPolicy while it is
 *                         active. A mission has no opinion.
 *   NOT TOUCHED           `_detectionUserOverridden`. Setting it would mean "the
 *                         operator hand-edited detection" and would silently
 *                         kill the CRT/NVG/FLIR auto-preset contract for the
 *                         whole session. Missions run through setContextMode and
 *                         DataManager.setEnabled, neither of which writes it.
 *   NOT TOUCHED           detection allocation (`gev:detection-allocation:v1`),
 *                         3D aircraft models, scope feather. All are defaults or
 *                         separate durable prefs the visitor did not choose here.
 *                         In particular nothing calls `_setModels3dEnabled` /
 *                         `_setModels3dMode`, which default to origin 'user' and
 *                         would persist a 3D choice nobody made.
 *
 * The two Context missions deliberately reuse `styleManager.setContextMode`, the
 * same facade the visible tabs and voice use, so Contacts detection ownership,
 * layer isolation and rollback stay in exactly one place.
 */

/** @type {Readonly<Record<string, object>>} */
export const FIRST_RUN_MISSIONS = Object.freeze({
  contacts: Object.freeze({
    kind: 'context',
    contextMode: 'contacts',
    busyText: 'Starting live contacts…',
  }),
  'space-missions': Object.freeze({
    kind: 'context',
    contextMode: 'space-missions',
    busyText: 'Opening space missions…',
  }),
  environmental: Object.freeze({
    kind: 'globe',
    // Live USGS earthquakes AND NASA FIRMS active fires. The launcher optimizes
    // for the FULLY CONFIGURED experience (product decision, 2026-08-23): the tile
    // promises both, so it turns on both, and the subcopy in index.html says so.
    //
    // Keyless, FIRMS is honest where it counts — its own layer row reads
    // "UNAVAILABLE · NASA FIRMS · LIVE · KEY REQUIRED", and the quakes half of
    // the tile still delivers in full. What is NOT honest is the GLOBAL status
    // chip, which has no key-required terminal state and folds that row into
    // "LOAD FAILED". That aggregation is the defect, not this preset: fixing it
    // means a KEY REQUIRED terminal state in src/loadingFeedback.js, a state
    // machine shared by every layer and not a thing to refactor the night
    // before a launch. LEDGERED post-launch. Until it lands, keyless visitors
    // are judged on the layer row, which tells them the truth.
    layerIds: Object.freeze(['earthquakes', 'local-firms']),
    busyText: 'Scanning active events…',
  }),
  explore: Object.freeze({ kind: 'none' }),
});

/*
 * STORAGE ACCESS IS LAZY AND GUARDED — NEVER A DEFAULT PARAMETER.
 *
 * `globalThis.localStorage` is a GETTER, and in Safari's private mode (and under
 * some enterprise policies) reading it THROWS SecurityError. A default parameter
 * like `storage = globalThis.localStorage` evaluates that getter before the
 * function body starts, so it throws outside every try/catch this module has —
 * the exception escapes, initFirstRunExperience never runs, and the launcher
 * silently never appears. That is the exact opposite of failing open.
 *
 * So the storage AREA is resolved inside a try, at the moment it is used, and an
 * injected stub (tests, callers) short-circuits the global entirely.
 */

/**
 * Resolve a Web Storage area without letting a hostile getter escape.
 * @param {'local'|'session'} kind
 * @param {object|null|undefined} injected Explicit store; `undefined` means "use the global".
 * @returns {{getItem?: Function, setItem?: Function, removeItem?: Function}|null}
 */
function resolveStore(kind, injected) {
  if (injected !== undefined) return injected;
  try {
    return kind === 'session' ? globalThis.sessionStorage : globalThis.localStorage;
  } catch {
    // Privacy-restricted storage should not make first launch silent.
    return null;
  }
}

/** Read one key, treating every failure as "nothing stored". */
function readStored(kind, injected, key) {
  try {
    return resolveStore(kind, injected)?.getItem?.(key) ?? null;
  } catch {
    return null;
  }
}

/**
 * Write one key, best-effort. Never throws; REPORTS whether the value landed so
 * a caller that showed the visitor a promise ("don't show this again") can take
 * it back rather than display a preference nothing stored.
 * @returns {boolean} true only if the value was actually written.
 */
function writeStored(kind, injected, key, value) {
  try {
    const store = resolveStore(kind, injected);
    if (typeof store?.setItem !== 'function') return false;
    store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove one key, best-effort.
 * @returns {boolean} true only if the removal actually happened.
 */
function removeStored(kind, injected, key) {
  try {
    const store = resolveStore(kind, injected);
    if (typeof store?.removeItem !== 'function') return false;
    store.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide whether the launcher belongs in this page load.
 * @param {object} input
 * @param {boolean} [input.hasShareState]
 * @param {{getItem: Function}|null} [input.storage] Durable (localStorage).
 * @param {{getItem: Function}|null} [input.sessionStorageRef] Per-session.
 * @param {{search?: string}|null} [input.location]
 * @returns {boolean}
 */
export function shouldShowFirstRun({
  hasShareState = false,
  storage,
  sessionStorageRef,
  location = globalThis.location,
} = {}) {
  if (hasShareState) return false;
  const params = new URLSearchParams(location?.search || '');
  if (params.get('welcome') === '0') return false;
  // The demo/support escape hatch outranks both suppressions on purpose.
  if (params.get('welcome') === '1') return true;
  if (readStored('local', storage, FIRST_RUN_STORAGE_KEY) === 'suppressed') return false;
  if (readStored('session', sessionStorageRef, FIRST_RUN_SESSION_KEY) === 'dismissed') return false;
  return true;
}

/**
 * Write (or clear) the durable "don't show this again" suppression. Storage is
 * best-effort — a blocked store still closes the launcher for this session —
 * but the outcome is RETURNED, because the checkbox that calls this is showing
 * the visitor a claim about the future and must not keep a tick nothing saved.
 * @param {boolean} suppressed
 * @param {{setItem: Function, removeItem?: Function}|null} [storage]
 * @returns {boolean} true if the durable state now matches what was asked.
 */
export function setFirstRunSuppressed(suppressed, storage) {
  return suppressed
    ? writeStored('local', storage, FIRST_RUN_STORAGE_KEY, 'suppressed')
    : removeStored('local', storage, FIRST_RUN_STORAGE_KEY);
}

/**
 * Record that this browser session has seen and closed the launcher.
 * @param {{setItem: Function}|null} [sessionStorageRef]
 * @returns {void}
 */
export function rememberFirstRunSessionDismissed(sessionStorageRef) {
  writeStored('session', sessionStorageRef, FIRST_RUN_SESSION_KEY, 'dismissed');
}

/**
 * Run a launcher choice against the app's existing internal APIs.
 *
 * A failed mission is NOT closed: the visitor can retry or fall back to manual
 * exploration rather than being stranded on a map they did not ask for.
 *
 * @param {string} choice Key of FIRST_RUN_MISSIONS.
 * @param {object} deps
 * @param {(mode: string) => Promise<object>} deps.setContextMode
 * @param {(layerId: string) => Promise<boolean>} deps.setLayerEnabled
 * @param {() => Promise<any>} deps.flyToGlobe
 * @returns {Promise<{ok: boolean, choice: string, result?: object, failedLayerIds?: string[]}>}
 */
export async function runFirstRunChoice(choice, { setContextMode, setLayerEnabled, flyToGlobe }) {
  const mission = FIRST_RUN_MISSIONS[choice];
  if (!mission) return { ok: false, choice };
  if (mission.kind === 'none') return { ok: true, choice };
  if (mission.kind === 'context') {
    const result = await setContextMode(mission.contextMode);
    return { ok: Boolean(result?.ok), choice, result };
  }
  // Globe missions: start the pull-out and the layer work together so the
  // camera is already moving while the feeds spin up. The flight is framing,
  // not the mission — a stalled or superseded flight never fails the tile.
  const flight = Promise.resolve()
    .then(() => flyToGlobe())
    .catch(() => null);
  const outcomes = await Promise.all(mission.layerIds.map(async (layerId) => {
    try {
      return { layerId, ok: (await setLayerEnabled(layerId)) !== false };
    } catch {
      return { layerId, ok: false };
    }
  }));
  await flight;
  const failedLayerIds = outcomes.filter((entry) => !entry.ok).map((entry) => entry.layerId);
  return { ok: failedLayerIds.length === 0, choice, failedLayerIds };
}

/**
 * Body classes that mean "another surface owns the screen". Each of these also
 * hides the launcher in CSS, and the observer below turns that into a yield —
 * see the ESC ARBITRATION note on initFirstRunExperience.
 */
export const EXCLUSIVE_SURFACE_CLASSES = Object.freeze([
  'cockpit-mode',
  'scene-playback-mode',
  'recording-mode',
  'ui-clean-view',
]);

/**
 * Is some other surface currently claiming the screen?
 * @param {Document} [documentRef]
 * @returns {boolean}
 */
export function exclusiveSurfaceActive(documentRef = globalThis.document) {
  const list = documentRef?.body?.classList;
  if (!list) return false;
  return EXCLUSIVE_SURFACE_CLASSES.some((name) => list.contains(name));
}

/**
 * Wire and reveal the mission launcher.
 * @param {object} input
 * @param {object} input.styleManager Initialized StyleManager.
 * @param {object} [input.dataManager] DataManager, for the globe missions' layers.
 * @param {Document} [input.documentRef]
 * @param {Storage} [input.storage]
 * @param {Storage} [input.sessionStorageRef]
 * @param {Location} [input.location]
 * @returns {null|{dismiss: Function}}
 */
export function initFirstRunExperience({
  styleManager,
  dataManager = styleManager?._dataManager,
  documentRef = globalThis.document,
  storage,
  sessionStorageRef,
  location = globalThis.location,
} = {}) {
  const root = documentRef?.getElementById?.('first-run-launcher');
  if (!root || root.dataset.initialized === 'true') return null;
  root.dataset.initialized = 'true';

  if (!shouldShowFirstRun({
    hasShareState: styleManager?.hasShareState,
    storage,
    sessionStorageRef,
    location,
  })) {
    root.remove();
    return null;
  }

  // The tile name is configurable from one constant, so paint it from the
  // module rather than trusting the markup to have been edited to match.
  const environmentalTitle = root.querySelector('[data-first-run-environmental-title]');
  if (environmentalTitle) environmentalTitle.textContent = environmentalLabel().title;

  const status = root.querySelector('[data-first-run-status]');
  const suppressBox = root.querySelector('[data-first-run-suppress]');
  const buttons = [...root.querySelectorAll('[data-first-run-choice]')];
  const defaultStatus = status?.textContent || '';
  const previouslyFocused = documentRef.activeElement;
  let busy = false;
  let closing = false;

  const focusables = () => [
    ...root.querySelectorAll('button, input, [href], [tabindex]:not([tabindex="-1"])'),
  ].filter((node) => !node.hasAttribute('disabled') && node.getClientRects().length > 0);

  /**
   * Is something painted OVER the card? A measurable box is not a visible card.
   * The attribution lightbox is a full-screen overlay at `z-index: 200` against
   * this card's 175 and announces itself with NO body class, so it left the
   * launcher measurable but buried: ESC dismissed a card the visitor could not
   * see — and burned the session flag — behind a lightbox that stayed open.
   *
   * Watching one more class would have fixed one more overlay. Hit-testing the
   * card's own centre answers it for ANY overlay, classed or not, shipped or
   * future, which is why this is the general guard and the class list stays the
   * yield mechanism rather than the visibility test.
   *
   * Inconclusive answers count as UNCOVERED on purpose — no elementFromPoint, a
   * zero-sized box, a centre outside the viewport, a null hit. This guard exists
   * to stop the launcher acting while something is demonstrably on top of it; it
   * must never become the reason ESC quietly stops working.
   */
  const coveredByOverlay = () => {
    if (typeof documentRef.elementFromPoint !== 'function') return false;
    const rect = root.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return false;
    try {
      const hit = documentRef.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      return Boolean(hit) && !root.contains(hit);
    } catch {
      return false;
    }
  };

  /**
   * Is the launcher REALLY the thing on screen right now? Not "did we add the
   * class" — the class survives while CSS hides the card behind an exclusive
   * surface, and a handler that trusts the class alone consumes keys for an
   * invisible element. getClientRects() is empty under `display: none`, which
   * is exactly how every one of those surfaces hides this card; the hit test
   * then covers the overlays that leave the box intact and simply sit on top.
   */
  const isTopmost = () => root.isConnected
    && root.classList.contains('visible')
    && root.getClientRects().length > 0
    && !coveredByOverlay();

  const dismiss = ({ restoreFocus = true } = {}) => {
    if (closing) return;
    closing = true;
    rememberFirstRunSessionDismissed(sessionStorageRef);
    root.classList.remove('visible');
    root.setAttribute('aria-hidden', 'true');
    documentRef.removeEventListener('keydown', onKeyDown, true);
    globalThis.removeEventListener?.('resize', onViewportResize);
    surfaceObserver?.disconnect();
    const remove = () => root.remove();
    root.addEventListener('transitionend', remove, { once: true });
    // `transitionend` never fires under prefers-reduced-motion (no transition),
    // so a bounded fallback is what actually removes the node there.
    globalThis.setTimeout?.(remove, 400);
    // Return the keyboard where it was, not to a node that is being removed —
    // but never when yielding, because the surface taking over owns focus now.
    if (!restoreFocus) return;
    if (typeof previouslyFocused?.focus === 'function' && previouslyFocused.isConnected) {
      previouslyFocused.focus({ preventScroll: true });
    } else {
      documentRef.body?.focus?.({ preventScroll: true });
    }
  };

  const setBusy = (next, choice = '') => {
    busy = next;
    root.dataset.state = next ? 'loading' : 'ready';
    root.setAttribute('aria-busy', String(next));
    // aria-disabled, not `disabled`: disabling the focused button drops focus to
    // <body> mid-flight and strands a keyboard visitor outside the launcher.
    for (const button of buttons) button.setAttribute('aria-disabled', String(next));
    if (!status) return;
    if (next) status.textContent = FIRST_RUN_MISSIONS[choice]?.busyText || 'Working…';
    else if (status.dataset.sticky !== 'true') status.textContent = defaultStatus;
  };

  const onChoice = async (event) => {
    if (busy || closing) return;
    const choice = event.currentTarget?.dataset?.firstRunChoice;
    if (!FIRST_RUN_MISSIONS[choice]) return;
    if (status) delete status.dataset.sticky;
    setBusy(true, choice);
    let outcome = null;
    try {
      outcome = await runFirstRunChoice(choice, {
        setContextMode: async (mode) => {
          const result = await styleManager.setContextMode(mode);
          if (result?.ok) {
            // setContextMode is also a voice/internal facade and deliberately
            // does not decide panel chrome. This first-run click is an explicit
            // visual choice, so reveal the result exactly as the visible
            // Contacts / Space Missions tabs do.
            styleManager.setPanelCollapsed?.('global-context-panel', false, { explicit: true });
          }
          return result;
        },
        // `origin: 'user'` on purpose: a mission tile is a real person choosing
        // these layers, so it persists exactly as clicking those rows would.
        setLayerEnabled: (layerId) => dataManager.setEnabled(layerId, true, { origin: 'user' }),
        flyToGlobe: () => styleManager.resetToGlobeView(),
      });
    } catch (error) {
      // A thrown mission is a real defect worth seeing in a bug report; the
      // ordinary "could not enable" path returns ok:false and stays quiet.
      console.warn('[First run] Mission launch failed:', error);
    }
    if (closing) return;
    if (outcome?.ok) {
      dismiss();
      return;
    }
    const failed = outcome?.failedLayerIds?.length
      ? outcome.failedLayerIds
      : outcome?.result?.failedLayerIds;
    const detail = Array.isArray(failed) && failed.length ? ` (${failed.join(', ')})` : '';
    if (status) {
      status.dataset.sticky = 'true';
      status.textContent = `Could not open that mission${detail}. Retry or explore manually.`;
    }
    setBusy(false);
  };

  const onSuppressChange = (event) => {
    const box = event.currentTarget;
    const wanted = Boolean(box?.checked);
    if (setFirstRunSuppressed(wanted, storage)) return;
    // The write is best-effort; the TICK is not. A box left checked after a
    // refused write tells the visitor "never again" about a launcher that is
    // already guaranteed to come back next session. Put the box back where the
    // truth is, and say why rather than leaving a control that undoes itself.
    if (box) box.checked = !wanted;
    if (!status) return;
    status.dataset.sticky = 'true';
    status.textContent = 'This browser is blocking storage, so that could not be saved.';
  };

  function onKeyDown(event) {
    // THE ARBITRATION RULE: never consume input for a card nobody can see.
    // The observer below normally removes the launcher before another surface
    // finishes engaging, but MutationObserver callbacks are microtasks, so a
    // keydown can still arrive in the window between the class landing and the
    // yield running. This check closes that window deterministically.
    if (closing || !isTopmost()) return;
    // AND THE BELT FOR THE COOPERATIVE HALF. A surface that owns this key marks
    // it handled (preventDefault) and silences the rest of us on the way past
    // (stopImmediatePropagation). If one of them ever ships only the first half,
    // the mark alone still keeps ONE key to ONE action — which is precisely what
    // the compact Radio disclosure did with a plain stopPropagation(), a call
    // that never blocks later listeners on the same document.
    if (event.defaultPrevented) return;
    if (event.key === 'Escape') {
      // ESC is an exit, not a mission: it must work even mid-flight. The
      // launcher is the topmost surface while it is up, so it consumes the key
      // rather than also closing a panel the visitor cannot see behind it.
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      return;
    }
    if (event.key !== 'Tab') return;
    // Keep Tab inside the launcher while it is up. The rest of the page is
    // deliberately still live to the mouse, so this stops short of claiming
    // `aria-modal` — it confines the keyboard without asserting the map is inert.
    const order = focusables();
    if (!order.length) return;
    const first = order[0];
    const last = order[order.length - 1];
    const active = documentRef.activeElement;
    // Plain focus(), NOT preventScroll: on a short viewport the mission list
    // scrolls inside the card, and a tile the keyboard just reached has to be
    // brought into view rather than focused somewhere off-screen.
    if (!root.contains(active)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  for (const button of buttons) button.addEventListener('click', onChoice);
  suppressBox?.addEventListener('change', onSuppressChange);
  // Capture phase: the app binds its own global hotkeys (including bare letters
  // that cycle detection and styles), and the launcher owns the keyboard first.
  documentRef.addEventListener('keydown', onKeyDown, true);

  // The scroll fade is an affordance, so it may only appear when the list really
  // overflows. On a viewport where all five tiles fit, a faded bottom edge would
  // promise a sixth mission that does not exist.
  const choiceList = root.querySelector('.first-run-choices');
  const syncScrollAffordance = () => {
    if (!choiceList) return;
    const overflows = choiceList.scrollHeight > choiceList.clientHeight + 1;
    choiceList.dataset.scrollable = String(overflows);
  };

  let revealed = false;
  const reveal = () => {
    if (revealed || closing) return;
    revealed = true;
    root.hidden = false;
    globalThis.requestAnimationFrame?.(() => {
      if (closing) return;
      root.classList.add('visible');
      syncScrollAffordance();
      buttons[0]?.focus?.({ preventScroll: true });
    });
  };

  /*
   * ESC ARBITRATION — the launcher never competes for the key.
   *
   * Two real defects motivated this. Cockpit registers its capture-phase
   * keydown listener at construction, long before this module runs, and calls
   * stopImmediatePropagation() — so with both up, ESC exited Cockpit BEHIND the
   * card. And a Scene starting merely hid the launcher in CSS while its handler
   * stayed armed, so ESC dismissed an invisible launcher (writing the session
   * flag) while the Scene played on.
   *
   * Rather than fight over listener order, the launcher YIELDS. Every exclusive
   * surface announces itself with a body class that already hides this card, so
   * one observer turns "something else took the screen" into "step aside for
   * this session". The stacking question then never arises: the launcher is
   * gone before the other surface can receive a key. And if a surface is
   * already up when this runs, the launcher waits rather than appearing over it.
   *
   * Yielding covers the surfaces that TAKE THE SCREEN and say so. Two more kinds
   * of contender exist, and each is answered where it actually lives:
   *
   *   an overlay that takes the screen SILENTLY — the attribution lightbox sits
   *     at z-index 200 with no class to watch. isTopmost() hit-tests the card's
   *     own centre, so an unclassed overlay disarms the handler exactly like a
   *     classed one, with nothing to keep in step;
   *   a small control that claims only the KEY — a disclosure or popover the
   *     launcher is not hiding behind and must not yield to. Whoever handles ESC
   *     first marks it (preventDefault) and stops the rest (stopImmediatePropagation);
   *     the launcher honours the mark. One key, one action, no ordering fight.
   */
  const yieldToExclusiveSurface = () => {
    if (closing) return;
    // Session-scoped, like any other dismissal: it returns next session. Focus
    // stays with whatever just took the screen.
    dismiss({ restoreFocus: false });
  };

  /*
   * ACCEPTED, DELIBERATELY NOT TIMED OUT: a surface class that never clears
   * means the launcher never appears in that page load.
   *
   * A "reveal anyway after N seconds" timer was considered and rejected. None of
   * the four classes is restored at startup — every one is toggled by a live
   * action (cockpit entry, a scene run, the recording toggle, the clean-view
   * toggle) — so an already-blocked init is an error path, while a genuinely
   * long recording or clean-view session is completely ordinary. A timer would
   * trade a benign no-show for the launcher punching through a recording in
   * progress, which is the worse of the two failures.
   *
   * And the no-show IS benign: the card stays hidden, the key handler is inert
   * (isTopmost() is false), no session flag is written, and the observer is
   * still watching — so it appears the moment the class clears, and returns next
   * session regardless. Documented in docs/CURRENT-STATE.md.
   */
  const syncToExclusiveSurfaces = () => {
    if (closing) return;
    const blocked = exclusiveSurfaceActive(documentRef);
    if (revealed && blocked) yieldToExclusiveSurface();
    else if (!revealed && !blocked) reveal();
  };

  // A rotated phone changes which tiles fit, so the affordance re-measures.
  const onViewportResize = () => syncScrollAffordance();
  globalThis.addEventListener?.('resize', onViewportResize);

  const surfaceObserver = typeof globalThis.MutationObserver === 'function'
    ? new globalThis.MutationObserver(syncToExclusiveSurfaces)
    : null;
  // Attributes only, no subtree: this is a class watch on one element, so it
  // costs nothing per frame and never asks the render governor for a frame.
  if (documentRef.body) {
    surfaceObserver?.observe(documentRef.body, { attributes: true, attributeFilter: ['class'] });
  }
  syncToExclusiveSurfaces();

  return { dismiss, isTopmost };
}
