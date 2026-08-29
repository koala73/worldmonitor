const STORE_KEY = '__gevContextStore';

function createStore() {
  return {
    entities: new Map(),
    selectedEntityId: null,
    selectedAt: null,
  };
}

export function getContextStore() {
  if (!window[STORE_KEY]) {
    window[STORE_KEY] = createStore();
  }
  return window[STORE_KEY];
}

/**
 * Is there a window to hang the store on?
 *
 * The tracking-subject helpers run inside the aircraft layers' per-poll
 * refresh, which unit tests drive with no DOM at all. Without this guard the
 * bare `window` read throws mid-poll and takes the rest of the refresh with
 * it.
 * @returns {boolean} True when the store is reachable.
 */
function hasContextHost() {
  return typeof window !== 'undefined' && Boolean(window);
}

export function registerEntityContext(entity, metadata) {
  if (!entity || !metadata?.id) return null;
  const store = getContextStore();
  const record = {
    ...metadata,
    entity,
    updatedAt: Date.now(),
  };
  entity.__gevContextId = metadata.id;
  store.entities.set(metadata.id, record);
  return record;
}

export function selectEntityContext(entity) {
  const store = getContextStore();
  const contextId = entity?.__gevContextId;
  if (!contextId || !store.entities.has(contextId)) return null;
  store.selectedEntityId = contextId;
  store.selectedAt = Date.now();
  const record = store.entities.get(contextId);
  window.dispatchEvent(new CustomEvent('gev:entity-selected', { detail: record }));
  return record;
}

/**
 * Publish the live subject of a TRACKING layer (aircraft) into the shared
 * selection slot.
 *
 * Selecting a contact is a click-selection like any other — voice's
 * `scope:'selected'` and the Cockpit's selected-target lookup both read this
 * one slot, so a tracking layer that stays out of it is invisible to them
 * even while its readout card is on screen.
 *
 * Deliberately does NOT dispatch `gev:entity-selected`: tracking layers own a
 * separate publication lane (`gev:awareness-subject-selected`) that the
 * readout and Contacts panel already consume, and a second event for the same
 * click would make those two surfaces fight over one subject.
 *
 * A tracking layer has at most one subject, so any earlier record it left
 * behind is dropped — its feed refreshes continuously and a frozen snapshot
 * must never reach the visible-entity scan.
 *
 * @param {object} metadata Record fields; `id` and `layerId` required.
 * @returns {object|null} The stored record, or null when identity is missing.
 */
export function selectTrackedSubjectContext(metadata) {
  if (!hasContextHost() || !metadata?.id || !metadata?.layerId) return null;
  const store = getContextStore();
  const id = String(metadata.id);
  for (const [key, record] of store.entities) {
    if (record?.layerId === metadata.layerId && key !== id) store.entities.delete(key);
  }
  // Reuse the existing carrier so a per-poll refresh does not churn identity.
  const carrier = store.entities.get(id)?.entity || { __gevContextId: id };
  const record = registerEntityContext(carrier, { ...metadata, id });
  if (!record) return null;
  store.selectedEntityId = id;
  store.selectedAt = Date.now();
  return record;
}

/**
 * Refresh a tracking layer's subject in place WITHOUT claiming the selection.
 *
 * The per-poll position/identity refresh must not resurrect a subject the
 * operator has since replaced by clicking something else.
 * @param {object} metadata Record fields; `id` and `layerId` required.
 * @returns {object|null} The stored record, or null when it is not registered.
 */
export function refreshTrackedSubjectContext(metadata) {
  if (!hasContextHost() || !metadata?.id || !metadata?.layerId) return null;
  const store = getContextStore();
  const id = String(metadata.id);
  const existing = store.entities.get(id);
  if (!existing || existing.layerId !== metadata.layerId) return null;
  return registerEntityContext(existing.entity, { ...metadata, id });
}

/**
 * Drop a tracking layer's subject when the operator deselects it.
 *
 * Pairs with {@link selectTrackedSubjectContext} and stays event-free for the
 * same reason: `gev:awareness-subject-cleared` is the tracking layers' lane.
 * @param {string} layerId Owning layer.
 * @returns {void}
 */
export function clearTrackedSubjectContext(layerId) {
  if (!hasContextHost() || !layerId) return;
  const store = getContextStore();
  for (const [key, record] of store.entities) {
    if (record?.layerId === layerId) store.entities.delete(key);
  }
  if (store.selectedEntityId && !store.entities.has(store.selectedEntityId)) {
    store.selectedEntityId = null;
    store.selectedAt = null;
  }
}

export function getSelectedEntityContext({ dataManager = null } = {}) {
  const store = getContextStore();
  if (!store.selectedEntityId) return null;
  const record = store.entities.get(store.selectedEntityId);
  if (!record || !isContextRecordActive(record, dataManager)) {
    store.selectedEntityId = null;
    store.selectedAt = null;
    return null;
  }
  return record;
}

/**
 * Drop the selected context record owned by a layer.
 * @param {string} layerId Owning layer.
 * @param {object} [options] Clear origin.
 * @param {boolean} [options.evicted=false] The record aged out of its feed
 *   rather than being deselected. Readouts that stay on screen hold their
 *   last-known values for an eviction and only tear down on a deliberate clear.
 */
export function clearSelectedEntityContextForLayer(layerId, { evicted = false } = {}) {
  const store = getContextStore();
  if (!store.selectedEntityId) return;
  const record = store.entities.get(store.selectedEntityId);
  if (record?.layerId === layerId) {
    store.selectedEntityId = null;
    store.selectedAt = null;
    window.dispatchEvent(new CustomEvent('gev:entity-selection-cleared', {
      detail: { layerId, reason: evicted ? 'evicted' : 'deliberate' },
    }));
  }
}

/** Remove obsolete context records when a viewport-scoped layer refreshes. */
export function removeEntityContextsForLayer(layerId) {
  const store = getContextStore();
  for (const [id, record] of store.entities) {
    if (record?.layerId === layerId) store.entities.delete(id);
  }
  if (store.selectedEntityId && !store.entities.has(store.selectedEntityId)) {
    store.selectedEntityId = null;
    store.selectedAt = null;
    // A viewport refresh dropped the record out from under the selection —
    // the user did not deselect anything.
    window.dispatchEvent(new CustomEvent('gev:entity-selection-cleared', {
      detail: { layerId, reason: 'evicted' },
    }));
  }
}

export function isContextRecordActive(record, dataManager = null) {
  if (!record) return false;
  if (record.entity?.show === false) return false;
  if (record.dataSource && record.dataSource.show === false) return false;
  if (dataManager && record.layerId && !dataManager.isEnabled(record.layerId)) return false;
  return true;
}
