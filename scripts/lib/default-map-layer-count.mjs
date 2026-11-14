const START = 'const FULL_MAP_LAYERS';
const END = 'const FULL_MOBILE_MAP_LAYERS';

export function defaultOnLayerKeys(source) {
  const start = source.indexOf(START);
  const end = source.indexOf(END);
  if (start === -1 || end <= start) {
    throw new Error('default-map-layer-count: could not isolate FULL_MAP_LAYERS in src/config/panels.ts');
  }
  const code = source.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const keys = [...code.matchAll(/^\s*['"]?(\w+)['"]?\s*:\s*(?:true|!_desktop)\b(?=\s*[,}])/gm)].map((m) => m[1]);
  const trueValues = (code.match(/:\s*true\b/g) || []).length;
  const webOnValues = (code.match(/:\s*!_desktop\b/g) || []).length;
  if (keys.length !== trueValues + webOnValues) {
    throw new Error(`default-map-layer-count: ${trueValues + webOnValues} on values but ${keys.length} parsed keys. The FULL_MAP_LAYERS layout changed`);
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
