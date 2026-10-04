/**
 * Count the full variant's default-on map layers from src/config/variants/full.ts.
 *
 * The module reads import.meta.env and cannot load under Node, so the
 * DEFAULT_MAP_LAYERS literal is isolated in source and counted. Comments are
 * stripped first, and every remaining `: true` must belong to a parsed key, so
 * a layout the parser cannot read fails closed instead of understating the count.
 */
const START = 'export const DEFAULT_MAP_LAYERS';
const END = 'export const MOBILE_DEFAULT_MAP_LAYERS';

export function defaultOnLayerKeys(source) {
  const start = source.indexOf(START);
  const end = source.indexOf(END);
  if (start === -1 || end <= start) {
    throw new Error('default-map-layer-count: could not isolate DEFAULT_MAP_LAYERS in src/config/variants/full.ts');
  }
  const code = source.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const keys = [...code.matchAll(/^\s*['"]?(\w+)['"]?\s*:\s*true\b/gm)].map((m) => m[1]);
  const trueValues = (code.match(/:\s*true\b/g) || []).length;
  if (keys.length !== trueValues) {
    throw new Error(`default-map-layer-count: ${trueValues} true values but ${keys.length} parsed keys — the DEFAULT_MAP_LAYERS layout changed`);
  }
  return keys;
}

export function defaultOnLayerStats(source, catalogKeys) {
  const catalog = new Set(catalogKeys);
  const defaultOnLayers = defaultOnLayerKeys(source).filter((key) => catalog.has(key)).length;
  if (defaultOnLayers <= 0 || defaultOnLayers >= catalog.size) {
    throw new Error(`default-map-layer-count: default-on count must be between 1 and ${catalog.size - 1}, got ${defaultOnLayers}`);
  }
  return {
    defaultOnLayers,
    defaultOnLayerPct: Math.round((defaultOnLayers / catalog.size) * 100),
  };
}
