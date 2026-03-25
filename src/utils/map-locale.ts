import { getCurrentLanguage } from '@/services/i18n';

const LANG_TO_TILE_FIELD: Record<string, string> = {
  en: 'name:en',
  bg: 'name:bg',
  cs: 'name:cs',
  fr: 'name:fr',
  de: 'name:de',
  el: 'name:el',
  es: 'name:es',
  it: 'name:it',
  pl: 'name:pl',
  pt: 'name:pt',
  nl: 'name:nl',
  sv: 'name:sv',
  ru: 'name:ru',
  ar: 'name:ar',
  zh: 'name:zh',
  ja: 'name:ja',
  ko: 'name:ko',
  ro: 'name:ro',
  tr: 'name:tr',
  th: 'name:th',
  // vi — not available in Protomaps/OSM tiles
};

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

export function getLocalizedNameField(lang?: string): string {
  const code = lang ?? getCurrentLanguage();
  return LANG_TO_TILE_FIELD[code] ?? 'name:en';
}

export function getLocalizedNameExpression(lang?: string): Expression {
  const field = getLocalizedNameField(lang);

  if (field === 'name:en') {
    return ['coalesce', ['get', 'name:en'], ['get', 'name']];
  }

  return ['coalesce', ['get', field], ['get', 'name:en'], ['get', 'name']];
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
