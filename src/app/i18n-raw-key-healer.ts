/**
 * Raw i18n-key DOM healer.
 *
 * Why this exists: the entry chunk ships only the eager `en.shell.json` subset
 * (see `services/i18n.ts`). The full English dictionary loads fire-and-forget
 * after first paint, so any string rendered from a key that is NOT in the shell
 * briefly shows its raw key (e.g. `components.liveNews.readyStatus`) until the
 * full bundle lands. Once it does, `services/i18n.ts` dispatches
 * `I18N_RESOURCES_LOADED_EVENT` and the App walks the container through
 * `replaceRawI18nKeyPlaceholders` to swap those placeholders for real text.
 *
 * Scope and limits (deliberate):
 *  - One-shot: runs once when the full bundle arrives. Nodes inserted AFTER the
 *    event resolve correctly on their own — by then `t()` returns real strings —
 *    so no second pass is needed.
 *  - Container-scoped at the call site (`App.state.container`): body-level
 *    overlays are user-opened post-startup, after the bundle has loaded.
 *  - Exact-match only: it heals a text node / attribute whose entire trimmed
 *    value is a single i18n key. Compound strings (`${t(a)}: ${t(b)}`) are not
 *    healed — keep first-paint keys in the shell instead of relying on this.
 *  - The `translate(key) !== key` guard prevents rewriting prose or unresolved
 *    keys, so only strings that genuinely resolve to a different value change.
 */
export type I18nTranslator = (key: string, options?: Record<string, unknown>) => string;

const RAW_I18N_KEY_RE = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)+$/;
const TRANSLATABLE_ATTRIBUTES = ['aria-label', 'title', 'placeholder'] as const;
const TEXT_NODE_TYPE = 3;

function translateRawI18nKeyPlaceholder(value: string, translate: I18nTranslator): string | null {
  const key = value.trim();
  if (!RAW_I18N_KEY_RE.test(key)) return null;

  const translated = translate(key);
  return translated !== key ? translated : null;
}

function replaceRawI18nKeyPlaceholderText(value: string, translate: I18nTranslator): string | null {
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

  collectTextNodes(root);

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
