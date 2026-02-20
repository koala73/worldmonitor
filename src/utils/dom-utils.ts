/** Anything that can appear as a child of h() / fragment(). */
export type DomChild = Node | string | number | null | undefined | false;

/** Props accepted by h(). */
export interface DomProps {
  className?: string;
  style?: Partial<CSSStyleDeclaration> | string;
  dataset?: Record<string, string>;
  [key: string]: unknown;
}

export function h(
  tag: string,
  propsOrChild?: DomProps | DomChild | null,
  ...children: DomChild[]
): HTMLElement {
  const el = document.createElement(tag);

  let allChildren: DomChild[];

  if (
    propsOrChild != null &&
    typeof propsOrChild === 'object' &&
    !(propsOrChild instanceof Node)
  ) {
    applyProps(el, propsOrChild as DomProps);
    allChildren = children;
  } else {
    allChildren = [propsOrChild as DomChild, ...children];
  }

  appendChildren(el, allChildren);
  return el;
}

export function text(value: string): Text {
  return document.createTextNode(value);
}

export function fragment(...children: DomChild[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  appendChildren(frag, children);
  return frag;
}

export function clearChildren(el: Element): void {
  while (el.lastChild) el.removeChild(el.lastChild);
}

export function replaceChildren(el: Element, ...children: DomChild[]): void {
  const frag = document.createDocumentFragment();
  appendChildren(frag, children);
  clearChildren(el);
  el.appendChild(frag);
}

export function rawHtml(html: string): DocumentFragment {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  return tpl.content;
}

const SAFE_TAGS = new Set([
  'strong', 'em', 'b', 'i', 'br', 'p', 'ul', 'ol', 'li', 'span', 'div', 'a',
]);
const SAFE_ATTRS = new Set(['style', 'class', 'href', 'target', 'rel']);

/** Like rawHtml() but strips tags and attributes not in the allowlist. */
export function safeHtml(html: string): DocumentFragment {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const walk = (parent: Element | DocumentFragment) => {
    const children = Array.from(parent.childNodes);
    for (const node of children) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element;
        if (!SAFE_TAGS.has(el.tagName.toLowerCase())) {
          // Unwrap: keep children, remove the element itself
          while (el.firstChild) parent.insertBefore(el.firstChild, el);
          parent.removeChild(el);
          continue;
        }
        // Strip unsafe attributes
        for (const attr of Array.from(el.attributes)) {
          if (!SAFE_ATTRS.has(attr.name.toLowerCase())) {
            el.removeAttribute(attr.name);
          }
        }
        // Sanitize href to prevent javascript: URIs
        if (el.hasAttribute('href')) {
          const href = el.getAttribute('href') || '';
          if (!/^https?:\/\//i.test(href) && !href.startsWith('/') && !href.startsWith('#')) {
            el.removeAttribute('href');
          }
        }
        walk(el);
      }
    }
  };
  walk(tpl.content);
  return tpl.content;
}

function applyProps(el: HTMLElement, props: DomProps): void {
  for (const key in props) {
    const value = props[key];
    if (value == null || value === false) continue;

    if (key === 'className') {
      el.className = value as string;
    } else if (key === 'style') {
      if (typeof value === 'string') {
        el.style.cssText = value;
      } else if (typeof value === 'object') {
        Object.assign(el.style, value);
      }
    } else if (key === 'dataset') {
      const ds = value as Record<string, string>;
      for (const k in ds) {
        el.dataset[k] = ds[k]!;
      }
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(
        key.slice(2).toLowerCase(),
        value as EventListener,
      );
    } else if (value === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, String(value));
    }
  }
}

function appendChildren(
  parent: Element | DocumentFragment,
  children: DomChild[],
): void {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (child instanceof Node) {
      parent.appendChild(child);
    } else {
      parent.appendChild(document.createTextNode(String(child)));
    }
  }
}
