export type I18nTranslator = (key: string) => string;

const RAW_I18N_KEY_RE = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)+$/;
const TRANSLATABLE_ATTRIBUTES = ['aria-label', 'title', 'placeholder'] as const;
const TEXT_NODE_TYPE = 3;

export function translateRawI18nKeyPlaceholder(value: string, translate: I18nTranslator): string | null {
  const key = value.trim();
  if (!RAW_I18N_KEY_RE.test(key)) return null;

  const translated = translate(key);
  return translated !== key ? translated : null;
}

export function replaceRawI18nKeyPlaceholderText(value: string, translate: I18nTranslator): string | null {
  const replacement = translateRawI18nKeyPlaceholder(value, translate);
  if (replacement === null) return null;

  const leading = value.match(/^\s*/)?.[0] ?? '';
  const trailing = value.match(/\s*$/)?.[0] ?? '';
  return `${leading}${replacement}${trailing}`;
}

export function replaceRawI18nKeyPlaceholders(root: ParentNode, translate: I18nTranslator): void {
  const textNodes: Text[] = [];

  const collectTextNodes = (node: Node): void => {
    if (node.nodeType === TEXT_NODE_TYPE) {
      textNodes.push(node as Text);
      return;
    }

    for (const child of Array.from(node.childNodes)) {
      collectTextNodes(child);
    }
  };

  collectTextNodes(root as Node);

  for (const node of textNodes) {
    const next = replaceRawI18nKeyPlaceholderText(node.nodeValue ?? '', translate);
    if (next !== null) {
      node.nodeValue = next;
    }
  }

  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[aria-label], [title], [placeholder]'))) {
    for (const attr of TRANSLATABLE_ATTRIBUTES) {
      const value = el.getAttribute(attr);
      if (!value) continue;

      const replacement = translateRawI18nKeyPlaceholder(value, translate);
      if (replacement !== null) el.setAttribute(attr, replacement);
    }
  }
}
