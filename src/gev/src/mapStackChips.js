// MAP STACK source chips — the always-visible replacement for the `<select>`
// that used to sit in the Map Stack panel. One button per stack, rendered from
// `MapStackController.getStacks()`. The four accepted sources below are
// the whole shipped set; keeping the allowlist explicit means a stack added to
// `MAP_STACKS` for internal use cannot reach the tray until someone names it
// here.
//
// The chips are a control SURFACE only: selecting one calls back into the same
// `_setMapStack()` path the dropdown's `change` handler used, and the active
// state is re-synced from controller state (never optimistically), so a failed
// or superseded switch still leaves the truly-active stack lit.

export const MAP_STACK_CHIP_CLASS = 'map-stack-chip';
export const PRESENTED_MAP_STACK_IDS = Object.freeze([
  'photoreal',
  'bing-aerial',
  'bing-labels',
  'osm',
]);

/**
 * Presentation model for one map-stack chip.
 *
 * Unavailable is NOT the same as needs-an-ion-token: `photoreal` is unavailable
 * whenever the Google tileset failed to load (the startup fallback-to-OSM
 * case), and a future stack may have its own reason. The ION badge is therefore
 * gated on the stack's own `requiresIon` flag, and the tooltip quotes the
 * controller's `unavailableReason` rather than assuming one.
 * @param {{id: string, label: string, available?: boolean, requiresIon?: boolean, unavailableReason?: string|null}} stack - Stack descriptor from `getStacks()`.
 * @param {string|null} activeId - Currently active stack id.
 * @returns {{id: string, label: string, available: boolean, active: boolean, requiresIon: boolean, requirement: string, unavailableHint: string, title: string}}
 */
export function mapStackChipModel(stack, activeId) {
  const available = stack?.available !== false;
  const label = String(stack?.label ?? stack?.id ?? '');
  const requiresIon = stack?.requiresIon === true;
  const fallbackReason = requiresIon
    ? 'Cesium ion token required'
    : `${label || 'This map stack'} is unavailable`;
  const unavailableHint = available ? '' : String(stack?.unavailableReason || fallbackReason);
  return {
    id: String(stack?.id ?? ''),
    label,
    available,
    active: !!stack?.id && stack.id === activeId,
    requiresIon,
    // Dropdown parity: unavailable options read "<label> · ion key". A chip has
    // no room for that, so an ion-backed stack gets a compact badge; every
    // unavailable chip carries the real reason in its tooltip.
    requirement: !available && requiresIon ? 'ION' : '',
    unavailableHint,
    title: available ? label : unavailableHint,
  };
}

/**
 * @param {Array<object>} stacks - `MapStackController.getStacks()` output.
 * @param {string|null} activeId - Currently active stack id.
 * @returns {Array<object>} One chip model per approved presentation id, in
 *   `PRESENTED_MAP_STACK_IDS` order; internal and future stacks stay hidden.
 */
export function mapStackChipModels(stacks, activeId) {
  const stacksById = new Map((Array.isArray(stacks) ? stacks : [])
    .map((stack) => [stack?.id, stack]));
  return PRESENTED_MAP_STACK_IDS
    .map((id) => stacksById.get(id))
    .filter(Boolean)
    .map((stack) => mapStackChipModel(stack, activeId));
}

/**
 * Renders the chip row into `container`, replacing any previous chips.
 * @param {HTMLElement} container - Row element.
 * @param {Array<object>} stacks - `MapStackController.getStacks()` output.
 * @param {object} [options]
 * @param {string|null} [options.activeId] - Currently active stack id.
 * @param {(stackId: string) => void} [options.onSelect] - Selection callback.
 * @param {Document} [options.doc] - Document override (tests).
 * @returns {Array<object>} The rendered chip models.
 */
export function renderMapStackChips(container, stacks, { activeId = null, onSelect = null, doc } = {}) {
  if (!container) return [];
  const ownerDoc = doc || container.ownerDocument || globalThis.document;
  if (!ownerDoc?.createElement) return [];

  container.innerHTML = '';
  const models = mapStackChipModels(stacks, activeId);

  for (const model of models) {
    const chip = ownerDoc.createElement('button');
    chip.type = 'button';
    chip.className = [
      MAP_STACK_CHIP_CLASS,
      model.active ? 'active' : '',
      model.available ? '' : 'unavailable',
    ].filter(Boolean).join(' ');
    chip.dataset.stackId = model.id;
    chip.title = model.title;
    chip.setAttribute('aria-pressed', String(model.active));
    chip.setAttribute('aria-disabled', String(!model.available));
    if (!model.available) {
      chip.setAttribute('aria-label', `${model.label} unavailable: ${model.unavailableHint}`);
    }

    const label = ownerDoc.createElement('span');
    label.className = 'map-stack-chip-label';
    label.textContent = model.label;
    chip.appendChild(label);

    if (model.requirement) {
      const requirement = ownerDoc.createElement('span');
      requirement.className = 'map-stack-chip-req';
      requirement.textContent = model.requirement;
      chip.appendChild(requirement);
    }

    chip.addEventListener('click', () => {
      if (!model.available) return;
      onSelect?.(model.id);
    });
    container.appendChild(chip);
  }

  return models;
}

/**
 * Re-points the active chip at controller state. Availability never changes at
 * runtime (it tracks the ion token), so only the active/pressed pair is synced.
 * @param {HTMLElement} container - Row element.
 * @param {string|null} activeId - Currently active stack id.
 * @returns {void}
 */
export function syncMapStackChips(container, activeId) {
  const chips = container?.children;
  if (!chips) return;
  for (const chip of Array.from(chips)) {
    const stackId = chip?.dataset?.stackId;
    if (!stackId) continue;
    const active = stackId === activeId;
    chip.classList?.toggle('active', active);
    chip.setAttribute?.('aria-pressed', String(active));
  }
}
