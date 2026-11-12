/** Geographic labels only; keep provider font sizes, collision rules and order. */
interface LabelMap {
  getStyle(): { layers?: { id: string; type?: string }[] } | null | undefined;
  setPaintProperty?(id: string, property: string, value: string | number): unknown;
}

export function improveBasemapLabels(map: LabelMap | null | undefined, light: boolean): void {
  if (!map) return;
  const layers = map.getStyle()?.layers;
  if (!layers) return;
  const palette = light
    ? { water: '#476779', major: '#26384b', city: '#344b60', minor: '#566879' }
    : { water: '#9ebac9', major: '#d3dbe5', city: '#bdc8d5', minor: '#9ba9b9' };
  for (const layer of layers) {
    if (layer.type !== 'symbol') continue;
    // Protomaps, OpenFreeMap and CARTO use these geographic layer families.
    // Unknown providers (including raster maps) retain their original style.
    const place = /^(places?_|label_(other|village|town|state|city|country))/.test(layer.id);
    const water = /^(water_name|watername_|waterway_(line_)?label|water_label_|water_waterway_label)/.test(layer.id);
    const island = layer.id === 'earth_label_islands';
    if (!place && !water && !island) continue;
    const major = /country|continent|capital|state|region/.test(layer.id);
    const city = /city|town|locality/.test(layer.id);
    const role = water ? 'water' : major ? 'major' : city ? 'city' : 'minor';
    const color = palette[role];
    try {
      map.setPaintProperty?.(layer.id, 'text-color', color);
      map.setPaintProperty?.(layer.id, 'text-halo-color', light ? '#f5f7fa' : '#101820');
      map.setPaintProperty?.(layer.id, 'text-halo-width', major ? 1.4 : 1.1);
      map.setPaintProperty?.(layer.id, 'text-halo-blur', 0.3);
    } catch {
      // A provider may remove or replace a layer during a style transition.
    }
  }
}
