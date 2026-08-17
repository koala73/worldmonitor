import { getCurrentLanguageTag } from '@/services/i18n';

/**
 * Tile name fields to try, in order, per catalogue language.
 *
 * One entry each, except Chinese: it is the only language where the three tile
 * sources this app can load disagree on the field name. Measured against the
 * live sources on 2026-08-14 (`vector_layers[].fields` of each TileJSON, and a
 * z10 tile decoded for Taipei, Beijing and Hong Kong):
 *
 *   Protomaps (the default basemap)  name:zh-Hans, name:zh-Hant — no `name:zh`
 *   OpenFreeMap (the fallback style) all three
 *   CARTO                            name:zh only
 *
 * So both scripts list their script-tagged field first and `name:zh` second,
 * which is the only Chinese field CARTO carries. For a Traditional reader that
 * second hop is Chinese of unknown script rather than the English the coalesce
 * would otherwise fall to, which is the better of the two.
 */
const LANG_TO_TILE_FIELDS: Record<string, readonly string[]> = {
  en: ['name:en'],
  bg: ['name:bg'],
  cs: ['name:cs'],
  fr: ['name:fr'],
  de: ['name:de'],
  el: ['name:el'],
  es: ['name:es'],
  hr: ['name:hr'],
  hu: ['name:hu'],
  it: ['name:it'],
  pl: ['name:pl'],
  pt: ['name:pt'],
  nl: ['name:nl'],
  sv: ['name:sv'],
  ru: ['name:ru'],
  uk: ['name:uk'],
  ar: ['name:ar'],
  zh: ['name:zh-Hans', 'name:zh'],
  'zh-TW': ['name:zh-Hant', 'name:zh'],
  ja: ['name:ja'],
  ko: ['name:ko'],
  ro: ['name:ro'],
  tr: ['name:tr'],
  th: ['name:th'],
  hi: ['name:hi'],
  // vi — absent from CARTO. Protomaps and OpenFreeMap both carry name:vi, so
  // this row is addable; left alone here as it is not part of the zh-TW fix.
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

const ENGLISH_ONLY: readonly string[] = ['name:en'];

/**
 * Tile fields for a language, most specific first.
 *
 * Reads the full tag rather than the stripped code: the table is keyed by
 * catalogue language, and `zh-TW` collapsed to `zh` can only ever find the
 * Simplified row.
 */
export function getLocalizedNameFields(lang?: string): readonly string[] {
  const code = lang ?? getCurrentLanguageTag();
  return LANG_TO_TILE_FIELDS[code] ?? ENGLISH_ONLY;
}

export function getLocalizedNameExpression(lang?: string): Expression {
  const fields = getLocalizedNameFields(lang);

  if (fields[0] === 'name:en') {
    return ['coalesce', ['get', 'name:en'], ['get', 'name']];
  }

  return ['coalesce', ...fields.map((field) => ['get', field]), ['get', 'name:en'], ['get', 'name']];
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
