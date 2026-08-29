// MAP STACK chip row — the dropdown's replacement control surface.
//
// The product issue was two clicks (open panel → open dropdown) to change
// basemap. These tests pin the three things that make the row a faithful swap:
// it projects the accepted four-source allowlist from the controller's
// stack data, a click dispatches the same selection the `change` handler used
// to, and the lit chip tracks controller state rather than the click. Run with:
// npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MAP_STACK_CHIP_CLASS,
  PRESENTED_MAP_STACK_IDS,
  mapStackChipModel,
  mapStackChipModels,
  renderMapStackChips,
  syncMapStackChips,
} from './mapStackChips.js';

/** Minimal element stand-in — the row only needs create/append/attr/class. */
function makeElement(tagName = 'div') {
  const element = {
    tagName,
    type: '',
    className: '',
    title: '',
    disabled: false,
    textContent: '',
    dataset: {},
    attributes: {},
    listeners: {},
    children: [],
    classList: {
      toggle(name, force) {
        const classes = new Set(String(element.className).split(/\s+/).filter(Boolean));
        const next = force === undefined ? !classes.has(name) : !!force;
        if (next) classes.add(name);
        else classes.delete(name);
        element.className = [...classes].join(' ');
      },
      contains(name) {
        return String(element.className).split(/\s+/).includes(name);
      },
    },
    appendChild(child) { element.children.push(child); return child; },
    setAttribute(name, value) { element.attributes[name] = String(value); },
    getAttribute(name) { return element.attributes[name] ?? null; },
    addEventListener(type, handler) { (element.listeners[type] ||= []).push(handler); },
    click() { for (const handler of element.listeners.click || []) handler(); },
  };
  Object.defineProperty(element, 'innerHTML', {
    get() { return ''; },
    set() { element.children.length = 0; },
  });
  return element;
}

const doc = { createElement: (tagName) => makeElement(tagName) };

/** Text a chip renders, label + optional requirement badge. */
const chipText = (chip) => chip.children.map((child) => child.textContent).join(' ');

// Shaped exactly like MapStackController.getStacks() output.
const CONTROLLER_STACKS = [
  { id: 'photoreal', label: 'Google 3D', requiresIon: false, available: true, unavailableReason: null },
  { id: 'bing-aerial', label: 'Bing Aerial', requiresIon: true, available: true, unavailableReason: null },
  { id: 'bing-labels', label: 'Bing Labels', requiresIon: true, available: true, unavailableReason: null },
  { id: 'osm', label: 'OSM', requiresIon: false, available: true, unavailableReason: null },
];

test('the row renders exactly the four accepted sources', () => {
  const container = makeElement();
  renderMapStackChips(container, CONTROLLER_STACKS, { activeId: 'photoreal', doc });

  assert.deepEqual(container.children.map((chip) => chip.dataset.stackId), [
    'photoreal', 'bing-aerial', 'bing-labels', 'osm',
  ]);
  assert.deepEqual(container.children.map(chipText), [
    'Google 3D', 'Bing Aerial', 'Bing Labels', 'OSM',
  ]);
  assert.deepEqual(PRESENTED_MAP_STACK_IDS, ['photoreal', 'bing-aerial', 'bing-labels', 'osm']);
  assert.ok(container.children.every((chip) => chip.tagName === 'button' && chip.type === 'button'));
  assert.ok(container.children.every((chip) => chip.classList.contains(MAP_STACK_CHIP_CLASS)));
});

test('internal and future stacks stay outside the approved presentation set', () => {
  const container = makeElement();
  // A future Hybrid stack may land in the controller, but it must not appear
  // until the accepted presentation allowlist explicitly includes it.
  const withHybrid = [...CONTROLLER_STACKS, { id: 'hybrid', label: 'Hybrid', available: true }];
  renderMapStackChips(container, withHybrid, { activeId: 'photoreal', doc });

  assert.equal(container.children.length, 4);
  assert.doesNotMatch(container.children.map(chipText).join(' '), /Hybrid/);
});

test('re-rendering replaces the previous chips instead of stacking a second row', () => {
  const container = makeElement();
  renderMapStackChips(container, CONTROLLER_STACKS, { activeId: 'photoreal', doc });
  renderMapStackChips(container, CONTROLLER_STACKS, { activeId: 'osm', doc });

  assert.equal(container.children.length, PRESENTED_MAP_STACK_IDS.length);
});

test('clicking a chip dispatches that stack id — the same selection the dropdown made', () => {
  const container = makeElement();
  const selected = [];
  renderMapStackChips(container, CONTROLLER_STACKS, {
    activeId: 'photoreal',
    onSelect: (stackId) => selected.push(stackId),
    doc,
  });

  container.children[3].click();
  container.children[1].click();
  assert.deepEqual(selected, ['osm', 'bing-aerial']);
});

test('the active chip is the pressed chip, and exactly one is pressed', () => {
  const container = makeElement();
  renderMapStackChips(container, CONTROLLER_STACKS, { activeId: 'bing-labels', doc });

  const pressed = container.children.filter((chip) => chip.getAttribute('aria-pressed') === 'true');
  assert.deepEqual(pressed.map((chip) => chip.dataset.stackId), ['bing-labels']);
  assert.ok(pressed[0].classList.contains('active'));
  assert.ok(container.children
    .filter((chip) => chip.dataset.stackId !== 'bing-labels')
    .every((chip) => !chip.classList.contains('active')));
});

test('the lit chip tracks controller state, not the click', () => {
  const container = makeElement();
  renderMapStackChips(container, CONTROLLER_STACKS, { activeId: 'photoreal', doc });

  // A rejected/superseded switch reports the stack that is genuinely active.
  syncMapStackChips(container, 'photoreal');
  assert.ok(container.children[0].classList.contains('active'));
  assert.equal(container.children[3].getAttribute('aria-pressed'), 'false');

  // A landed switch moves both the class and the pressed state.
  syncMapStackChips(container, 'osm');
  assert.ok(container.children[3].classList.contains('active'));
  assert.equal(container.children[3].getAttribute('aria-pressed'), 'true');
  assert.ok(!container.children[0].classList.contains('active'));
  assert.equal(container.children[0].getAttribute('aria-pressed'), 'false');
});

test('keyless ion stacks stay focusable, aria-disabled, and say why', () => {
  const container = makeElement();
  const keyless = CONTROLLER_STACKS.map((stack) => (stack.requiresIon ? {
    ...stack,
    available: false,
    unavailableReason: 'Cesium ion token required for Bing stacks',
  } : stack));
  const selected = [];
  renderMapStackChips(container, keyless, {
    activeId: 'photoreal',
    onSelect: (stackId) => selected.push(stackId),
    doc,
  });

  const bingAerial = container.children[1];
  assert.equal(bingAerial.disabled, false, 'unavailable sources remain keyboard-reachable');
  assert.equal(bingAerial.getAttribute('aria-disabled'), 'true');
  assert.equal(
    bingAerial.getAttribute('aria-label'),
    'Bing Aerial unavailable: Cesium ion token required for Bing stacks',
  );
  assert.ok(bingAerial.classList.contains('unavailable'));
  assert.equal(bingAerial.title, 'Cesium ion token required for Bing stacks');
  assert.equal(chipText(bingAerial), 'Bing Aerial ION');

  bingAerial.click();
  assert.deepEqual(selected, [], 'an unavailable stack must not reach the switch path');

  assert.equal(container.children[3].getAttribute('aria-disabled'), 'false', 'OSM stays selectable');
});

test('a non-ion stack that fails never claims an ion token is required', () => {
  // The startup fallback-to-OSM case: Google 3D tiles failed to load, so
  // photoreal is unavailable for a reason that has nothing to do with ion.
  const container = makeElement();
  const tilesFailed = CONTROLLER_STACKS.map((stack) => (stack.id === 'photoreal' ? {
    ...stack,
    available: false,
    unavailableReason: 'Google 3D is unavailable',
  } : stack));
  renderMapStackChips(container, tilesFailed, { activeId: 'osm', doc });

  const google = container.children[0];
  assert.equal(google.getAttribute('aria-disabled'), 'true');
  assert.equal(google.getAttribute('aria-label'), 'Google 3D unavailable: Google 3D is unavailable');
  assert.equal(chipText(google), 'Google 3D', 'no ION badge on a stack that does not need ion');
  assert.equal(google.title, 'Google 3D is unavailable');
  assert.equal(chipText(container.children[1]), 'Bing Aerial', 'available ion stacks stay unbadged');
});

test('models carry the stack\'s own reason and never invent an active chip', () => {
  assert.deepEqual(mapStackChipModels([{ id: 'osm', label: 'OSM' }], null), [{
    id: 'osm',
    label: 'OSM',
    available: true,
    active: false,
    requiresIon: false,
    requirement: '',
    unavailableHint: '',
    title: 'OSM',
  }]);

  // A stack list without a controller-supplied reason still explains itself.
  assert.deepEqual(
    [
      mapStackChipModel({ id: 'bing-aerial', label: 'Bing Aerial', requiresIon: true, available: false }, null),
      mapStackChipModel({ id: 'hybrid', label: 'Hybrid', available: false }, null),
    ].map(({ requirement, unavailableHint, title }) => ({ requirement, unavailableHint, title })),
    [
      {
        requirement: 'ION',
        unavailableHint: 'Cesium ion token required',
        title: 'Cesium ion token required',
      },
      {
        requirement: '',
        unavailableHint: 'Hybrid is unavailable',
        title: 'Hybrid is unavailable',
      },
    ],
  );

  assert.deepEqual(mapStackChipModels(undefined, 'osm'), []);
});

test('the controller is the single source of the unavailability reason', () => {
  const controller = readFileSync(new URL('./mapStackController.js', import.meta.url), 'utf8');

  assert.doesNotMatch(
    controller,
    /bing-road/,
    'Bing Road is retired: an old map=bing-road link must take the unknown-id photoreal fallback',
  );

  assert.match(
    controller,
    /getStacks\(\) \{[\s\S]*?unavailableReason: available \? null : this\._unavailableReason\(stack\)/,
    'getStacks() must expose why a stack is unavailable, not just that it is',
  );
  assert.match(
    controller,
    /if \(!this\.isStackAvailable\(stack\.id\)\) \{\s*const message = this\._unavailableReason\(stack\);/,
    'the toast and the chip tooltip must read the same reason',
  );
  assert.match(controller, /_unavailableReason\(stack\) \{[\s\S]*?stack\?\.requiresIon/);
});

test('a missing row or document is inert rather than throwing during boot', () => {
  assert.deepEqual(renderMapStackChips(null, CONTROLLER_STACKS, { doc }), []);
  assert.deepEqual(renderMapStackChips(makeElement(), CONTROLLER_STACKS, { doc: {} }), []);
  assert.doesNotThrow(() => syncMapStackChips(null, 'osm'));
});

test('the active cyan survives hover', () => {
  const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  const hover = css.indexOf('.map-stack-chip:hover');
  const active = css.indexOf('.map-stack-chip.active {');
  const unavailable = css.indexOf('.map-stack-chip.unavailable');

  assert.ok(hover > 0 && active > hover, 'active must follow hover so it wins at equal specificity');
  assert.ok(unavailable > active, 'unavailable must follow both so a keyless chip never lights up');
  assert.doesNotMatch(
    css.slice(hover, active),
    /:not\(/,
    'a :not() in the hover selector outranks .active and washes the cyan out on hover',
  );
});

test('the keyboard focus ring survives on the ACTIVE chip', () => {
  // The bug this pins: `.active` legitimately wins the color/border/background/
  // box-shadow it shares with the focus rule, and the base rule sets
  // `outline: none` — so a focus state built only from those properties is
  // INVISIBLE on the active chip. The ring must live on a property no other
  // chip-state rule sets.
  const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '');
  const chipRules = [...css.matchAll(/([^{}]*\.map-stack-chip[^{}]*)\{([^{}]*)\}/g)]
    .map(([, selector, body], order) => ({
      selector: stripComments(selector).trim(),
      body: stripComments(body),
      order,
    }));
  assert.ok(chipRules.length >= 5, 'expected the chip state rules to be found');

  const ringIndex = chipRules.findIndex(({ selector, body }) => selector.includes(':focus-visible')
    && /outline:\s*(?!none)\S/.test(body)
    && /outline-offset:/.test(body));
  assert.ok(ringIndex >= 0, 'a :focus-visible rule must draw a real outline ring');

  // Nothing after it may touch outline again, so the ring cannot be erased by
  // .active, :disabled, or anything added later.
  for (const rule of chipRules.slice(ringIndex + 1)) {
    assert.doesNotMatch(
      rule.body,
      /outline/,
      `"${rule.selector}" must not touch outline — it would erase the focus ring`,
    );
  }
  for (const selector of ['.map-stack-chip.active', '.map-stack-chip.unavailable']) {
    assert.ok(
      chipRules.some((rule) => rule.selector.includes(selector)),
      `expected a ${selector} rule to exist for this check to mean anything`,
    );
  }

  // `transition: all` animates outline-width off the `outline: none` base, and
  // Chrome parks that transition at 0px for chips on a wrapped line — the ring
  // never appeared on rows 2 and 3. The base rule must list its properties.
  const base = chipRules.find((rule) => rule.selector.endsWith('.map-stack-chip'));
  assert.ok(base, 'expected the base .map-stack-chip rule');
  assert.doesNotMatch(
    base.body,
    /transition:\s*all\b/,
    'transition: all animates outline-width and kills the focus ring on wrapped rows',
  );
  assert.doesNotMatch(base.body, /transition:[^;]*outline/, 'the focus ring must not be animated');
  assert.match(base.body, /transition:\s*\n?\s*color/, 'the hover/active treatment still animates');
});

test('the Visual Presets tray owns Map Source and the retired left panel is absent', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('./ui.js', import.meta.url), 'utf8');

  assert.doesNotMatch(html, /map-stack-select/, 'the SOURCE dropdown is replaced by the chip row');
  assert.match(
    html,
    /<section class="map-source-section"[\s\S]*?<div id="map-stack-chips" class="map-stack-chip-row" role="group" aria-label="Map source"><\/div>/,
  );
  assert.doesNotMatch(html, /id="stack-panel"/, 'the duplicate left MAP STACK panel is retired');
  assert.match(html, /id="map-source-label">MAP SOURCE<[\s\S]*?id="map-stack-status"/);
  assert.match(
    html,
    /<button id="control-panel-toggle"[\s\S]*?data-dock-toggle-target="control-panel"[\s\S]*?aria-controls="control-panel-popover"/,
    'the compact wing must expose a semantic keyboard disclosure',
  );
  assert.match(ui, /event\.key !== 'Escape'[\s\S]*?disclosure\?\.focus/);
  assert.match(ui, /map-stack-chip\.active, \.map-stack-chip/);

  assert.match(
    ui,
    /renderMapStackChips\(this\._mapStackChips, this\.mapStackController\.getStacks\(\), \{[\s\S]*?onSelect: \(stackId\) => \{ this\._setMapStack\(stackId\); \}/,
    'chips must dispatch through the same _setMapStack path the dropdown used',
  );
  assert.match(
    ui,
    /_renderMapStackState\(state\) \{[\s\S]*?syncMapStackChips\(this\._mapStackChips, state\.activeId\)/,
    'the active chip must be re-synced from controller state',
  );
});
