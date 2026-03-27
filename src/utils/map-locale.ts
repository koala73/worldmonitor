/**
 * Force map labels to display in English regardless of browser language.
 * FR #181: Users want map place names to always show in English.
 */
const FORCE_MAP_LANGUAGE = 'en';

type Expression = [string, ...unknown[]];

interface MapStyleLayer {
  id: string;
  type?: string;
}

interface MapStyle {
  layers?: MapStyleLayer[];
}

interface LocalizableMap {
  getStyle?: () => MapStyle | null | undefined;
  getLayoutProperty?: (layerId: string, property: 'text-field') => unknown;
  setLayoutProperty?: (layerId: string, property: 'text-field', value: Expression) => void;
}

export function getLocalizedNameField(_lang?: string): string {
  // FR #181: Force English labels on map regardless of UI language
  return `name:${FORCE_MAP_LANGUAGE}`;
}

export function getLocalizedNameExpression(_lang?: string): Expression {
  // FR #181: Always return English expression for map labels
  return ['coalesce', ['get', 'name:en'], ['get', 'name']];
}

export function isLocalizableTextField(textField: unknown): boolean {
  if (!textField) return false;

  if (typeof textField === 'string') {
    return /\{name[^}]*\}/.test(textField);
  }

  if (typeof textField === 'object') {
    const s = JSON.stringify(textField);
    const hasName =
      s.includes('"name"') ||
      s.includes('"name:') ||
      s.includes('"name_en"') ||
      s.includes('"name_int"') ||
      s.includes('{name');
    return hasName;
  }

  return false;
}

export function localizeMapLabels(map: LocalizableMap | null | undefined): void {
  if (!map) return;

  const style = map?.getStyle?.();
  if (!style?.layers) return;

  const expr = getLocalizedNameExpression();

  for (const layer of style.layers) {
    if (layer.type !== 'symbol') continue;

    let textField: unknown;
    try {
      textField = map.getLayoutProperty?.(layer.id, 'text-field');
    } catch {
      continue;
    }

    if (!isLocalizableTextField(textField)) continue;

    try {
      map.setLayoutProperty?.(layer.id, 'text-field', expr);
    } catch {}
  }
}
