const SAFE_STYLE_PROPERTIES = [
  'align-content',
  'align-items',
  'align-self',
  'background',
  'background-color',
  'border',
  'border-bottom',
  'border-color',
  'border-left',
  'border-radius',
  'border-right',
  'border-style',
  'border-top',
  'border-width',
  'bottom',
  'box-sizing',
  'color',
  'column-gap',
  'display',
  'flex',
  'flex-basis',
  'flex-direction',
  'flex-grow',
  'flex-shrink',
  'flex-wrap',
  'font-size',
  'font-variant-numeric',
  'font-weight',
  'gap',
  'grid-auto-flow',
  'grid-column',
  'grid-row',
  'grid-template-columns',
  'grid-template-rows',
  'height',
  'inset',
  'justify-content',
  'justify-items',
  'justify-self',
  'left',
  'letter-spacing',
  'line-height',
  'margin',
  'margin-bottom',
  'margin-left',
  'margin-right',
  'margin-top',
  'max-height',
  'max-width',
  'min-height',
  'min-width',
  'opacity',
  'overflow',
  'overflow-x',
  'overflow-y',
  'padding',
  'padding-bottom',
  'padding-left',
  'padding-right',
  'padding-top',
  'position',
  'right',
  'row-gap',
  'text-align',
  'text-decoration',
  'text-transform',
  'top',
  'vertical-align',
  'white-space',
  'width',
  'z-index',
] as const;

const SAFE_STYLE_FUNCTIONS = [
  'calc',
  'clamp',
  'hsl',
  'hsla',
  'max',
  'min',
  'minmax',
  'repeat',
  'rgb',
  'rgba',
  'var',
] as const;

type SafeStyleProperty = (typeof SAFE_STYLE_PROPERTIES)[number];

const SAFE_STYLE_PROPERTY_SET: ReadonlySet<string> = new Set(SAFE_STYLE_PROPERTIES);
const SAFE_STYLE_FUNCTION_SET: ReadonlySet<string> = new Set(SAFE_STYLE_FUNCTIONS);

const UNSAFE_STYLE_VALUE =
  /\\|url|image-set|image\s*\(|['"]|@|\/\*|\*\/|expression\s*\(|javascript\s*:|behavior\s*:|-moz-binding/i;

const SAFE_STYLE_VALUE = /^[a-z0-9#%.,()\s_+\-*/]+$/i;

interface SafeStyleDeclaration {
  property: SafeStyleProperty;
  value: string;
  important: boolean;
}

function safeProperty(name: string): SafeStyleProperty | null {
  const property = name.trim().toLowerCase();
  if (!SAFE_STYLE_PROPERTY_SET.has(property)) return null;
  return property as SafeStyleProperty;
}

function isSafeStyleValue(value: string): boolean {
  if (!SAFE_STYLE_VALUE.test(value) || UNSAFE_STYLE_VALUE.test(value)) return false;
  let depth = 0;
  for (const char of value) {
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  if (depth !== 0) return false;
  for (const match of value.matchAll(/([a-z_][\w-]*)(\s*\()?/gi)) {
    if (!match[2]) continue;
    const name = match[1];
    if (!name || !SAFE_STYLE_FUNCTION_SET.has(name.toLowerCase())) return false;
  }
  return true;
}

function parseSafeDeclaration(chunk: string): SafeStyleDeclaration | null {
  const colon = chunk.indexOf(':');
  if (colon <= 0) return null;
  const property = safeProperty(chunk.slice(0, colon));
  if (!property) return null;
  let rawValue = chunk.slice(colon + 1).trim().replace(/\s+/g, ' ');
  let important = false;
  const importantMatch = /^(.*?)\s*!important$/i.exec(rawValue);
  const bareValue = importantMatch?.[1]?.trim();
  if (bareValue !== undefined) {
    if (!bareValue) return null;
    important = true;
    rawValue = bareValue;
  }
  if (!isSafeStyleValue(rawValue)) return null;
  return { property, value: rawValue, important };
}

export function sanitizeWidgetStyle(style: string): string {
  const kept: string[] = [];
  for (const chunk of style.split(';')) {
    const declaration = parseSafeDeclaration(chunk);
    if (!declaration) continue;
    const important = declaration.important ? ' !important' : '';
    kept.push(`${declaration.property}: ${declaration.value}${important}`);
  }
  return kept.join('; ');
}
