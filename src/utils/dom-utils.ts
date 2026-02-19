/**
 * Lightweight hyperscript utilities for programmatic DOM construction.
 *
 * These helpers replace innerHTML-based rendering with direct DOM API calls,
 * eliminating HTML string parsing overhead and enabling granular updates.
 *
 * - h()               – create an HTMLElement with props and children
 * - text()            – create a Text node (auto-escapes, no HTML parsing)
 * - fragment()        – create a DocumentFragment from children
 * - clearChildren()   – remove all children from an element
 * - replaceChildren() – atomically swap an element's children
 * - rawHtml()         – parse a static HTML string (e.g. SVG icons) into a fragment
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Anything that can appear as a child of h() / fragment(). */
export type DomChild = Node | string | number | null | undefined | false;

/** Props accepted by h(). */
export interface DomProps {
  className?: string;
  style?: Partial<CSSStyleDeclaration> | string;
  dataset?: Record<string, string>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

/**
 * Hyperscript element builder.
 *
 * ```ts
 * h('div', { className: 'card', dataset: { id: '1' } },
 *   h('span', { className: 'title' }, 'Hello'),
 *   h('p', null, 'Body text')
 * )
 * ```
 *
 * The second argument is treated as props when it is a plain object (not a
 * DOM Node). Pass `null` to skip props and go straight to children.
 */
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
    // propsOrChild is a props object
    applyProps(el, propsOrChild as DomProps);
    allChildren = children;
  } else {
    // propsOrChild is a child (or null/undefined)
    allChildren = [propsOrChild as DomChild, ...children];
  }

  appendChildren(el, allChildren);
  return el;
}

/**
 * Create a Text node. Strings are safe by default (no HTML parsing).
 */
export function text(value: string): Text {
  return document.createTextNode(value);
}

/**
 * Build a DocumentFragment from a list of children.
 */
export function fragment(...children: DomChild[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  appendChildren(frag, children);
  return frag;
}

/**
 * Remove all children from an element (faster than innerHTML = '').
 */
export function clearChildren(el: Element): void {
  while (el.lastChild) el.removeChild(el.lastChild);
}

/**
 * Atomically replace all children of an element.
 *
 * Builds into a DocumentFragment first so there's only one reflow.
 */
export function replaceChildren(el: Element, ...children: DomChild[]): void {
  const frag = document.createDocumentFragment();
  appendChildren(frag, children);
  clearChildren(el);
  el.appendChild(frag);
}

/**
 * Parse a static HTML string (e.g. an SVG icon literal) into a
 * DocumentFragment. Use sparingly — prefer h()/text() for dynamic content.
 */
export function rawHtml(html: string): DocumentFragment {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  return tpl.content;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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
