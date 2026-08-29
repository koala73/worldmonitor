#!/usr/bin/env node
/**
 * Are the first-run launcher's pins actually load-bearing?
 *
 * A pin that only goes red when you delete the whole feature proves very little.
 * This reverts each decision INDIVIDUALLY — the smallest edit that reintroduces
 * the original defect or contradicts the product rule — and requires
 * src/firstRunExperience.test.mjs to go red for it. Every entry names what it
 * restores, so the count is reproducible rather than asserted in a commit
 * message.
 *
 *   node scripts/qa-firstrun-mutations.mjs
 *
 * Every touched file is restored on exit, including on failure.
 *
 * NOTE: two mutations edit vite.config.js, and a running dev server watches that
 * file and restarts on every write. Writes are therefore content-guarded below
 * so the file is touched exactly twice per mutation instead of on every
 * iteration — enough that a dev server survives, but expect it to restart. If
 * you are mid-QA on a live server, run this before or after, not during.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTS = 'src/firstRunExperience.test.mjs';

const FILES = {
  module: path.join(ROOT, 'src', 'firstRunExperience.js'),
  html: path.join(ROOT, 'index.html'),
  css: path.join(ROOT, 'style.css'),
  vite: path.join(ROOT, 'vite.config.js'),
  main: path.join(ROOT, 'src', 'main.js'),
  ui: path.join(ROOT, 'src', 'ui.js'),
  docs: path.join(ROOT, 'docs', 'CURRENT-STATE.md'),
};

/** @type {Array<{defect: string, file: keyof FILES, from: string, to: string}>} */
const MUTATIONS = [
  // ── Show policy (product decision: session-scoped dismiss vs durable checkbox) ──
  {
    defect: 'dismissing writes the DURABLE key, so the launcher never returns',
    file: 'module',
    from: "writeStored('session', sessionStorageRef, FIRST_RUN_SESSION_KEY, 'dismissed');",
    to: "writeStored('local', sessionStorageRef, FIRST_RUN_STORAGE_KEY, 'suppressed');",
  },
  {
    defect: 'the checkbox is ignored, so nothing can ever suppress the launcher',
    file: 'module',
    from: "    ? writeStored('local', storage, FIRST_RUN_STORAGE_KEY, 'suppressed')",
    to: '    ? false',
  },
  {
    defect: 'unticking the box cannot take the suppression back',
    file: 'module',
    from: "    : removeStored('local', storage, FIRST_RUN_STORAGE_KEY);",
    to: '    : true;',
  },
  {
    defect: 'the session flag is never read, so it re-nags on every reload',
    file: 'module',
    from: "if (readStored('session', sessionStorageRef, FIRST_RUN_SESSION_KEY) === 'dismissed') return false;",
    to: '// session check removed',
  },
  {
    defect: 'the durable flag is never read, so the checkbox does nothing',
    file: 'module',
    from: "if (readStored('local', storage, FIRST_RUN_STORAGE_KEY) === 'suppressed') return false;",
    to: '// durable check removed',
  },
  {
    defect: '?welcome=1 no longer outranks suppression, so demos cannot replay it',
    file: 'module',
    from: "if (params.get('welcome') === '1') return true;",
    to: '// replay hatch removed',
  },
  {
    defect: '?welcome=0 stops suppressing',
    file: 'module',
    from: "if (params.get('welcome') === '0') return false;",
    to: '// suppression param removed',
  },
  {
    defect: 'a share link gets the launcher over the view its author chose',
    file: 'module',
    from: 'if (hasShareState) return false;',
    to: '// share bypass removed',
  },
  {
    defect: 'storage is read from a DEFAULT PARAMETER, outside every guard',
    file: 'module',
    from: 'export function rememberFirstRunSessionDismissed(sessionStorageRef) {',
    to: 'export function rememberFirstRunSessionDismissed(sessionStorageRef = globalThis.sessionStorage) {',
  },
  {
    defect: 'shouldShowFirstRun resolves storage in its parameter list again',
    file: 'module',
    from: 'export function shouldShowFirstRun({\n  hasShareState = false,\n  storage,\n  sessionStorageRef,',
    to: 'export function shouldShowFirstRun({\n  hasShareState = false,\n  storage = globalThis.localStorage,\n  sessionStorageRef = globalThis.sessionStorage,',
  },
  {
    defect: 'the guarded resolver stops catching, so a hostile getter escapes',
    file: 'module',
    from: "  try {\n    return kind === 'session' ? globalThis.sessionStorage : globalThis.localStorage;\n  } catch {\n    // Privacy-restricted storage should not make first launch silent.\n    return null;\n  }",
    to: "  return kind === 'session' ? globalThis.sessionStorage : globalThis.localStorage;",
  },
  {
    defect: 'a blocked getItem throws instead of reading as "nothing stored"',
    file: 'module',
    from: '    return resolveStore(kind, injected)?.getItem?.(key) ?? null;\n  } catch {\n    return null;\n  }',
    to: '    return resolveStore(kind, injected)?.getItem?.(key) ?? null;\n  } finally {\n    // no catch\n  }',
  },

  // ── ESC arbitration ───────────────────────────────────────────────────────
  {
    defect: 'the key handler trusts the CLASS, so an invisible card eats ESC',
    file: 'module',
    from: 'if (closing || !isTopmost()) return;',
    to: 'if (closing) return;',
  },
  {
    defect: 'the launcher stops yielding and fights Cockpit/Scenes for ESC',
    file: 'module',
    from: 'if (revealed && blocked) yieldToExclusiveSurface();\n    else if (!revealed && !blocked) reveal();',
    to: 'if (!revealed) reveal();',
  },
  {
    defect: 'nothing watches for another surface taking the screen',
    file: 'module',
    from: "surfaceObserver?.observe(documentRef.body, { attributes: true, attributeFilter: ['class'] });",
    to: '/* observer never attached */',
  },
  {
    defect: 'cockpit drops off the exclusive list and can stack with the launcher',
    file: 'module',
    from: "export const EXCLUSIVE_SURFACE_CLASSES = Object.freeze([\n  'cockpit-mode',",
    to: 'export const EXCLUSIVE_SURFACE_CLASSES = Object.freeze([',
  },
  {
    defect: 'a scene hides the launcher in CSS but the JS never learns of it',
    file: 'css',
    from: 'body.scene-playback-mode #first-run-launcher {',
    to: 'body.scene-playback-mode-typo #first-run-launcher {',
  },
  {
    defect: 'yielding steals focus back from the surface that just took over',
    file: 'module',
    from: 'dismiss({ restoreFocus: false });',
    to: 'dismiss();',
  },
  {
    defect: 'isTopmost stops hit-testing, so an unclassed overlay buries the card again',
    file: 'module',
    from: '    && root.getClientRects().length > 0\n    && !coveredByOverlay();',
    to: '    && root.getClientRects().length > 0;',
  },
  {
    defect: 'an inconclusive hit test reads as COVERED, so ESC quietly stops working',
    file: 'module',
    from: '      return Boolean(hit) && !root.contains(hit);',
    to: '      return !root.contains(hit);',
  },
  {
    defect: 'the launcher stops honouring a key another surface already claimed',
    file: 'module',
    from: '    if (event.defaultPrevented) return;',
    to: '    /* belt removed */',
  },
  {
    // Anchored past the call so it cannot land on the cockpit disclosure's own
    // stopImmediatePropagation() a few lines below and prove nothing about this.
    defect: 'the radio disclosure returns to stopPropagation, so one ESC does two things',
    file: 'ui',
    from: '      event.stopImmediatePropagation();\n      setRadioDisclosure(false, { returnFocus: true });',
    to: '      event.stopPropagation();\n      setRadioDisclosure(false, { returnFocus: true });',
  },
  {
    defect: 'the "no timer" decision is deleted, so the next editor re-litigates it blind',
    file: 'module',
    from: '   * ACCEPTED, DELIBERATELY NOT TIMED OUT: a surface class that never clears',
    to: '   * (note removed)',
  },
  {
    defect: 'a bounded reveal timer punches the card through a recording in progress',
    file: 'module',
    from: '  const syncToExclusiveSurfaces = () => {\n    if (closing) return;',
    to: '  const syncToExclusiveSurfaces = () => {\n    if (closing) return;\n    globalThis.setTimeout?.(reveal, 45000);',
  },
  {
    defect: 'the accepted no-show vanishes from CURRENT-STATE and reads as a bug',
    file: 'docs',
    from: 'a surface class that never clears means no launcher for that page',
    to: 'the launcher always turns up eventually for that page',
  },

  // ── The checkbox may not promise what storage refused ─────────────────────
  {
    defect: 'a refused write leaves the box ticked, promising a suppression nobody stored',
    file: 'module',
    from: '    if (setFirstRunSuppressed(wanted, storage)) return;',
    to: '    setFirstRunSuppressed(wanted, storage);\n    return;',
  },
  {
    defect: 'a missing storage area reports the write as saved',
    file: 'module',
    from: "    if (typeof store?.setItem !== 'function') return false;\n    store.setItem(key, value);\n    return true;",
    to: '    store?.setItem?.(key, value);\n    return true;',
  },
  {
    defect: 'the scroll fade promises more list on a card where everything fits',
    file: 'module',
    from: 'choiceList.dataset.scrollable = String(overflows);',
    to: "choiceList.dataset.scrollable = 'true'; void overflows;",
  },

  {
    defect: 'the DISPLAY rail opens on first run again, stealing the impression',
    file: 'ui',
    from: "if (panelId === 'pp-toggles' && stored === null) collapsed = true;",
    to: "if (panelId === 'pp-toggles' && stored === null) collapsed = false;",
  },
  {
    defect: 'the first-run rail default overrides a stored user choice',
    file: 'ui',
    from: "if (panelId === 'pp-toggles' && stored === null) collapsed = true;",
    to: "if (panelId === 'pp-toggles') collapsed = true;",
  },

  // ── Mission definitions ────────────────────────────────────────────────────
  {
    defect: 'the removed INFRASTRUCTURE tile comes back as a one-click globe dump',
    file: 'module',
    from: "  environmental: Object.freeze({",
    to: "  infrastructure: Object.freeze({\n    kind: 'globe',\n    layerIds: Object.freeze(['local-datacenters', 'local-dams', 'telegeography-submarine-cables']),\n    busyText: 'Mapping global infrastructure…',\n  }),\n  environmental: Object.freeze({",
  },
  {
    defect: 'ENVIRONMENTAL drops the keyless earthquakes that carry it without a key',
    file: 'module',
    from: "layerIds: Object.freeze(['earthquakes', 'local-firms']),",
    to: "layerIds: Object.freeze(['local-firms']),",
  },
  {
    defect: 'FIRMS is dropped again from the tile whose subcopy promises it',
    file: 'module',
    from: "layerIds: Object.freeze(['earthquakes', 'local-firms']),",
    to: "layerIds: Object.freeze(['earthquakes']),",
  },
  {
    defect: 'the tile stops promising the fires it actually turns on',
    file: 'html',
    from: '<small>Live earthquakes and active fires, from USGS and NASA</small>',
    to: '<small>Live earthquakes worldwide, straight from USGS</small>',
  },
  {
    defect: "the final first-run line is quietly rewritten",
    file: 'html',
    from: 'It feels like a forbidden cockpit—then you realize the sources are public and the data is real.',
    to: "It feels like a forbidden cockpit. It isn't — every feed is public, and every contact is live.",
  },
  {
    defect: 'the ledgered global-chip defect loses its pointer to the real fix',
    file: 'module',
    from: '    // means a KEY REQUIRED terminal state in src/loadingFeedback.js, a state',
    to: '    // (note removed)',
  },
  {
    defect: 'the globe missions never pull the camera out',
    file: 'module',
    from: '    .then(() => flyToGlobe())',
    to: '    .then(() => null)',
  },
  {
    defect: 'a refused layer is reported as a successful mission',
    file: 'module',
    from: 'return { ok: failedLayerIds.length === 0, choice, failedLayerIds };',
    to: 'return { ok: true, choice, failedLayerIds };',
  },
  {
    defect: 'a cancelled globe flight fails the whole mission',
    file: 'module',
    from: '    .catch(() => null);',
    to: '    .catch(() => { throw new Error("flight failed"); });',
  },
  {
    defect: 'Explore manually quietly runs a mission instead of nothing',
    file: 'module',
    from: "if (mission.kind === 'none') return { ok: true, choice };",
    to: "if (mission.kind === 'none') return { ok: true, choice, ran: await setContextMode('contacts') };",
  },
  {
    defect: 'an unknown choice is treated as a success',
    file: 'module',
    from: 'if (!mission) return { ok: false, choice };',
    to: 'if (!mission) return { ok: true, choice };',
  },
  {
    defect: 'the fires/quakes tile name stops being switchable from one constant',
    file: 'module',
    from: 'return ENVIRONMENTAL_LABELS[choice] || ENVIRONMENTAL_LABELS.ENVIRONMENTAL;',
    to: 'return ENVIRONMENTAL_LABELS.ENVIRONMENTAL;',
  },

  // ── Defaults interplay (the ruling this whole integration turns on) ────────
  {
    defect: "mission layer enables stop persisting, unlike the clicks they stand for",
    file: 'module',
    from: "dataManager.setEnabled(layerId, true, { origin: 'user' })",
    to: 'dataManager.setEnabled(layerId, true)',
  },
  {
    defect: 'a mission hand-edits detection and kills the style auto-preset contract',
    file: 'module',
    from: '        flyToGlobe: () => styleManager.resetToGlobeView(),',
    to: '        flyToGlobe: () => { styleManager._detectionUserOverridden = true; return styleManager.resetToGlobeView(); },',
  },
  {
    defect: 'a mission persists a 3D-models choice nobody made',
    file: 'module',
    from: '      const result = await styleManager.setContextMode(mode);',
    to: '      styleManager._setModels3dEnabled?.(true);\n          const result = await styleManager.setContextMode(mode);',
  },
  {
    defect: 'the Context panel is left collapsed, hiding the mode that just started',
    file: 'module',
    from: "styleManager.setPanelCollapsed?.('global-context-panel', false, { explicit: true });",
    to: '// panel reveal removed',
  },
  {
    defect: 'the decision table is deleted, so the next editor re-litigates it blind',
    file: 'module',
    from: ' * MISSION → APP STATE, AND WHAT IT IS ALLOWED TO PERSIST',
    to: ' * (notes removed)',
  },

  // ── Accessibility and the transplant defects ──────────────────────────────
  {
    defect: 'disabling the focused tile drops the keyboard to <body> mid-flight',
    file: 'module',
    from: "for (const button of buttons) button.setAttribute('aria-disabled', String(next));",
    to: 'for (const button of buttons) button.disabled = next;',
  },
  {
    defect: 'Tab escapes into an app the visitor has not seen yet',
    file: 'module',
    from: "if (event.key !== 'Tab') return;",
    to: 'return;',
  },
  {
    defect: 'ESC no longer dismisses the launcher',
    file: 'module',
    from: "if (event.key === 'Escape') {",
    to: 'if (false) {',
  },
  {
    defect: 'focus is never returned to where the visitor left it',
    file: 'module',
    from: "if (typeof previouslyFocused?.focus === 'function' && previouslyFocused.isConnected) {",
    to: 'if (false) {',
  },
  {
    defect: 'app hotkeys eat the launcher keys (bubble instead of capture)',
    file: 'module',
    from: "documentRef.addEventListener('keydown', onKeyDown, true);",
    to: "documentRef.addEventListener('keydown', onKeyDown);",
  },
  {
    defect: 'the card stays clickable through its fade-out (double-launch)',
    file: 'css',
    from: '  transition: opacity 220ms ease, transform 280ms cubic-bezier(0.2, 0.8, 0.2, 1);\n  /* Inert until revealed AND again while fading out, so a click during the\n     dismiss animation cannot launch a second mission behind the fade. */\n  pointer-events: none;',
    to: '  transition: opacity 220ms ease, transform 280ms cubic-bezier(0.2, 0.8, 0.2, 1);',
  },
  {
    defect: 'the launcher survives Clean-UI and recording mode',
    file: 'css',
    from: 'body.ui-clean-view #first-run-launcher,',
    to: 'body.never-matches-anything #first-run-launcher,',
  },
  {
    defect: 'the flex card defeats [hidden] and sits in the a11y tree pre-reveal',
    file: 'css',
    from: '#first-run-launcher[hidden] {\n  display: none;\n}',
    to: '/* [hidden] rule removed */',
  },
  {
    defect: 'the card loses its viewport cap and clips on a short landscape phone',
    file: 'css',
    from: '  max-height: calc(100dvh - 1.5rem);',
    to: '  /* cap removed */',
  },
  {
    defect: 'the mission list stops scrolling, so tiles overflow the capped card',
    file: 'css',
    from: '  min-height: 0;\n  overflow-y: auto;',
    to: '  /* scroll removed */',
  },
  {
    // Anchored to the launcher's OWN selectors: style.css has four other
    // reduced-motion blocks, and a bare `@media` anchor would mutate one of
    // those instead and prove nothing about this feature.
    defect: "the launcher's reduced-motion opt-out is dropped",
    file: 'css',
    from: '  #first-run-launcher,\n  .first-run-choices button,\n  .first-run-arrow { transition: none; }\n  /* Scrolling a tile into view must not animate either. */\n  .first-run-choices { scroll-behavior: auto; }',
    to: '  .first-run-nothing { transition: none; }',
  },

  // ── Markup and startup ordering ───────────────────────────────────────────
  {
    defect: 'a mission tile is dropped from the menu',
    file: 'html',
    from: '      <button type="button" data-first-run-choice="space-missions">',
    to: '      <button type="button" data-first-run-choice-disabled="space-missions">',
  },
  {
    defect: 'the menu order stops matching the owner\'s',
    file: 'html',
    from: '<button type="button" data-first-run-choice="environmental">',
    to: '<button type="button" data-first-run-choice="zzz-environmental">',
  },
  {
    defect: 'the "don\'t show again" checkbox is removed',
    file: 'html',
    from: '<input type="checkbox" data-first-run-suppress />',
    to: '<span data-first-run-suppress-removed></span>',
  },
  {
    defect: 'the status line stops being a polite live region',
    file: 'html',
    from: 'data-first-run-status role="status" aria-live="polite"',
    to: 'data-first-run-status',
  },
  {
    defect: 'the launcher is no longer announced as a dialog',
    file: 'html',
    from: '<aside id="first-run-launcher" role="dialog"',
    to: '<aside id="first-run-launcher"',
  },
  {
    defect: 'the launcher is revealed before the loading cover yields',
    file: 'main',
    from: "      loadingScreen.classList.add('hidden');",
    to: '      initFirstRunExperience({ styleManager, dataManager });\n      loadingScreen.classList.add(\'hidden\');',
  },
  {
    defect: 'the globe missions lose their DataManager and cannot enable layers',
    file: 'main',
    from: 'initFirstRunExperience({ styleManager, dataManager });',
    to: 'initFirstRunExperience({ styleManager });',
  },

  // ── Voice: schema must not drift ──────────────────────────────────────────
  {
    defect: 'the voice TOOL SCHEMA is edited (a Realtime prompt-cache bust)',
    file: 'vite',
    from: "            'earthquakes',\n            'satellites',",
    to: "            'earthquakes',\n            'infrastructure-mode',\n            'satellites',",
  },
  {
    defect: 'the instruction mapping is dropped, so voice cannot reach the modes',
    file: 'vite',
    from: "            'NAMED VIEWS are shorthand",
    to: "            // 'NAMED VIEWS are shorthand",
  },
];

const originals = new Map();
for (const [key, file] of Object.entries(FILES)) originals.set(key, fs.readFileSync(file, 'utf8'));

/** Write only on a real change: a no-op write still wakes every file watcher. */
const write = (file, next) => {
  if (fs.readFileSync(file, 'utf8') !== next) fs.writeFileSync(file, next);
};
const restoreAll = () => {
  for (const [key, file] of Object.entries(FILES)) write(file, originals.get(key));
};
process.on('exit', restoreAll);

let caught = 0;
const missed = [];

console.log(`\nFirst-run launcher pin strength — ${MUTATIONS.length} individual reverts\n`);
for (const { defect, file, from, to } of MUTATIONS) {
  const original = originals.get(file);
  if (!original.includes(from)) {
    missed.push(`${defect} (ANCHOR MISSING — the mutation no longer applies)`);
    console.log(`  \x1b[31mSTALE\x1b[0m ${defect}`);
    continue;
  }
  write(FILES[file], original.replace(from, to));
  let red = false;
  let by = '';
  try {
    execFileSync('node', ['--test', TESTS], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    red = true;
    const failed = String(error.stdout || '').split('\n')
      .filter((line) => line.trim().startsWith('✖') && line.includes('('))
      .map((line) => line.trim().slice(2).split(' (')[0]);
    by = [...new Set(failed)].slice(0, 2).join('; ');
  }
  write(FILES[file], original);
  if (red) {
    caught += 1;
    console.log(`  \x1b[32mRED  \x1b[0m ${defect}\n         caught by: ${by}`);
  } else {
    missed.push(defect);
    console.log(`  \x1b[31mGREEN\x1b[0m ${defect}  <-- no pin covers this`);
  }
}
restoreAll();

console.log(`\n  ${caught}/${MUTATIONS.length} defects caught by the pins`);
if (missed.length) {
  console.log('\n  uncovered:');
  for (const item of missed) console.log(`    - ${item}`);
}
console.log('');
process.exitCode = missed.length ? 1 : 0;
