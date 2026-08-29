/**
 * The World Monitor → God's Eye View tracker bridge.
 *
 * `CesiumGlobeMap` is the only consumer; everything here is split out so the
 * spec table can be unit-tested without a browser, a Cesium build or a
 * viewer.
 */

export type { BridgeMarker, BridgeSpec, MarkerPart, MarkerStyle } from './types';
export { BRIDGE_SPECS, setIranEventColorResolver } from './markerSpecs';
export { staticMarkersFor, STATIC_LAYER_KEYS } from './staticLayers';
export { createBridgeRenderer, type BridgeRenderer } from './bridgeSource';
export { resolveMarkers } from './resolve';
