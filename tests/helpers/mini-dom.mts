export class MiniClassList {
  private values = new Set<string>();

  add(...tokens: string[]): void {
    tokens.forEach((token) => this.values.add(token));
  }

  remove(...tokens: string[]): void {
    tokens.forEach((token) => this.values.delete(token));
  }

  contains(token: string): boolean {
    return this.values.has(token);
  }

  toggle(token: string, force?: boolean): boolean {
    if (force === true) {
      this.values.add(token);
      return true;
    }
    if (force === false) {
      this.values.delete(token);
      return false;
    }
    if (this.values.has(token)) {
      this.values.delete(token);
      return false;
    }
    this.values.add(token);
    return true;
  }

  setFromString(value: string): void {
    this.values = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  toString(): string {
    return Array.from(this.values).join(' ');
  }
}

export class MiniNode extends EventTarget {
  childNodes: Array<MiniElement | MiniText | MiniDocumentFragment> = [];
  parentNode: MiniNode | null = null;
  parentElement: MiniElement | null = null;

  appendChild<T extends MiniElement | MiniText | MiniDocumentFragment>(child: T): T {
    if (child instanceof MiniDocumentFragment) {
      const children = [...child.childNodes];
      children.forEach((node) => this.appendChild(node));
      return child;
    }
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    child.parentElement = this instanceof MiniElement ? this : null;
    this.childNodes.push(child);
    return child;
  }

  append(...children: Array<MiniElement | MiniText | MiniDocumentFragment | string | number | null | undefined>): void {
    children.forEach((child) => {
      if (child == null) return;
      if (typeof child === 'string' || typeof child === 'number') {
        this.appendChild(new MiniText(child));
        return;
      }
      this.appendChild(child);
    });
  }

  removeChild<T extends MiniElement | MiniText | MiniDocumentFragment>(child: T): T {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) {
      this.childNodes.splice(index, 1);
      child.parentNode = null;
      child.parentElement = null;
    }
    return child;
  }

  insertBefore<T extends MiniElement | MiniText | MiniDocumentFragment>(child: T, referenceNode: MiniElement | MiniText | MiniDocumentFragment | null): T {
    if (referenceNode == null) {
      return this.appendChild(child);
    }
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    const index = this.childNodes.indexOf(referenceNode);
    if (index === -1) {
      return this.appendChild(child);
    }
    child.parentNode = this;
    child.parentElement = this instanceof MiniElement ? this : null;
    this.childNodes.splice(index, 0, child);
    return child;
  }

  get firstChild(): MiniElement | MiniText | MiniDocumentFragment | null {
    return this.childNodes[0] ?? null;
  }

  get lastChild(): MiniElement | MiniText | MiniDocumentFragment | null {
    return this.childNodes.at(-1) ?? null;
  }

  get firstElementChild(): MiniElement | null {
    return this.childNodes.find((child): child is MiniElement => child instanceof MiniElement) ?? null;
  }

  get lastElementChild(): MiniElement | null {
    return [...this.childNodes].reverse().find((child): child is MiniElement => child instanceof MiniElement) ?? null;
  }

  get childElementCount(): number {
    return this.childNodes.filter((child) => child instanceof MiniElement).length;
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent ?? '').join('');
  }

  set textContent(value: string | null) {
    this.childNodes = [new MiniText(value ?? '')];
  }

  replaceChildren(...children: Array<MiniElement | MiniText | MiniDocumentFragment | string | number>): void {
    this.childNodes = [];
    this.append(...children);
  }
}

export class MiniText extends MiniNode {
  private value: string;

  constructor(value: string | number) {
    super();
    this.value = String(value);
  }

  override get textContent(): string {
    return this.value;
  }

  override set textContent(value: string | null) {
    this.value = String(value);
  }

  get outerHTML(): string {
    return this.value;
  }
}

export class MiniDocumentFragment extends MiniNode {
  get outerHTML(): string {
    return this.childNodes.map((child) => child.outerHTML ?? child.textContent ?? '').join('');
  }
}

interface MiniAttributeSelector {
  name: string;
  value: string | null;
}

export class MiniElement extends MiniNode {
  readonly attributes = new Map<string, string>();
  readonly classList = new MiniClassList();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  ownerDocument?: MiniDocument;
  private innerHtml = '';
  id = '';
  title = '';
  disabled = false;
  clientHeight = 0;
  clientWidth = 0;

  constructor(readonly tagName: string) {
    super();
    this.tagName = tagName.toUpperCase();
  }

  get className(): string {
    return this.classList.toString();
  }

  set className(value: string) {
    this.classList.setFromString(value);
  }

  get innerHTML(): string {
    if (this.innerHtml) return this.innerHtml;
    return this.childNodes.map((child) => child.outerHTML ?? child.textContent ?? '').join('');
  }

  set innerHTML(value: string) {
    this.innerHtml = String(value);
    this.childNodes = [];
  }

  override appendChild<T extends MiniElement | MiniText | MiniDocumentFragment>(child: T): T {
    this.innerHtml = '';
    return super.appendChild(child);
  }

  override insertBefore<T extends MiniElement | MiniText | MiniDocumentFragment>(child: T, referenceNode: MiniElement | MiniText | MiniDocumentFragment | null): T {
    this.innerHtml = '';
    return super.insertBefore(child, referenceNode);
  }

  override removeChild<T extends MiniElement | MiniText | MiniDocumentFragment>(child: T): T {
    this.innerHtml = '';
    return super.removeChild(child);
  }

  setAttribute(name: string, value: string): void {
    const stringValue = String(value);
    this.attributes.set(name, stringValue);
    if (name === 'class') {
      this.className = stringValue;
    } else if (name === 'id') {
      this.id = stringValue;
    } else if (name.startsWith('data-')) {
      const key = name
        .slice(5)
        .split('-')
        .map((part, index) => (index === 0 ? part : `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`))
        .join('');
      this.dataset[key] = stringValue;
    }
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
    if (name === 'class') this.className = '';
  }

  matches(selector: string): boolean {
    return matchesSelector(this, selector);
  }

  querySelector(selector: string): MiniElement | null {
    return querySelectorAll(this, selector)[0] ?? null;
  }

  querySelectorAll(selector: string): MiniElement[] {
    return querySelectorAll(this, selector);
  }

  closest(selector: string): MiniElement | null {
    let current: MiniElement | null = this;
    while (current instanceof MiniElement) {
      if (current.matches(selector)) return current;
      current = current.parentElement;
    }
    return null;
  }

  remove(): void {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }

  getBoundingClientRect(): DOMRect {
    return { width: 1, height: 1, top: 0, left: 0, right: 1, bottom: 1, x: 0, y: 0, toJSON: () => ({}) };
  }

  focus(): void {
    const doc = this.ownerDocument ?? globalThis.document as unknown as MiniDocument | undefined;
    if (doc) doc.activeElement = this;
  }

  get nextElementSibling(): MiniElement | null {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes.filter((child): child is MiniElement => child instanceof MiniElement);
    const index = siblings.indexOf(this);
    return index >= 0 ? siblings[index + 1] ?? null : null;
  }

  get isConnected(): boolean {
    let current = this.parentNode;
    while (current) {
      if (current === globalThis.document?.body || current === globalThis.document?.documentElement) {
        return true;
      }
      current = current.parentNode;
    }
    return false;
  }

  get outerHTML(): string {
    return `<${this.tagName.toLowerCase()}>${this.innerHTML}</${this.tagName.toLowerCase()}>`;
  }

  get children(): MiniElement[] {
    return this.childNodes.filter((child): child is MiniElement => child instanceof MiniElement);
  }

  get offsetParent(): MiniElement | null {
    return this.isConnected ? this.parentElement ?? null : null;
  }
}

export class MiniStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.has(key) ? this.values.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}

export class MiniDocument extends EventTarget {
  readonly documentElement: MiniElement;
  readonly body: MiniElement;
  activeElement: MiniElement;

  constructor() {
    super();
    this.documentElement = new MiniElement('html');
    this.documentElement.clientHeight = 800;
    this.documentElement.clientWidth = 1200;
    this.body = new MiniElement('body');
    this.documentElement.ownerDocument = this;
    this.body.ownerDocument = this;
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }

  createElement(tagName: string): MiniElement {
    const element = new MiniElement(tagName);
    element.ownerDocument = this;
    return element;
  }

  createTextNode(value: string): MiniText {
    return new MiniText(value);
  }

  createDocumentFragment(): MiniDocumentFragment {
    return new MiniDocumentFragment();
  }

  getElementById(id: string): MiniElement | null {
    return querySelectorAll(this.documentElement, `#${id}`)[0] ?? null;
  }

  querySelector(selector: string): MiniElement | null {
    return this.documentElement.querySelector(selector);
  }

  querySelectorAll(selector: string): MiniElement[] {
    return this.documentElement.querySelectorAll(selector);
  }
}

function splitSelectorList(selector: string): string[] {
  return String(selector)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseSimpleSelector(selector: string): {
  tag: string | null;
  id: string | null;
  classes: string[];
  attributes: MiniAttributeSelector[];
  notAttributes: MiniAttributeSelector[];
} {
  const trimmed = selector.trim();
  const result = {
    tag: null as string | null,
    id: null as string | null,
    classes: [] as string[],
    attributes: [] as MiniAttributeSelector[],
    notAttributes: [] as MiniAttributeSelector[],
  };
  let remaining = trimmed;

  const tagMatch = remaining.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
  if (tagMatch) {
    result.tag = tagMatch[0].toUpperCase();
    remaining = remaining.slice(tagMatch[0].length);
  }

  while (remaining.length > 0) {
    if (remaining.startsWith('#')) {
      const match = remaining.match(/^#([A-Za-z0-9_-]+)/);
      if (!match) break;
      result.id = match[1]!;
      remaining = remaining.slice(match[0].length);
      continue;
    }

    if (remaining.startsWith('.')) {
      const match = remaining.match(/^\.([A-Za-z0-9_-]+)/);
      if (!match) break;
      result.classes.push(match[1]!);
      remaining = remaining.slice(match[0].length);
      continue;
    }

    if (remaining.startsWith(':not(')) {
      const match = remaining.match(/^:not\(\[([^\]=]+)(?:="([^"]*)")?\]\)/);
      if (!match) break;
      result.notAttributes.push({ name: match[1]!, value: match[2] ?? null });
      remaining = remaining.slice(match[0].length);
      continue;
    }

    if (remaining.startsWith('[')) {
      const match = remaining.match(/^\[([^\]=]+)(?:="([^"]*)")?\]/);
      if (!match) break;
      result.attributes.push({ name: match[1]!, value: match[2] ?? null });
      remaining = remaining.slice(match[0].length);
      continue;
    }

    break;
  }

  return result;
}

function matchesSelector(element: MiniElement, selector: string): boolean {
  return splitSelectorList(selector).some((part) => {
    const parsed = parseSimpleSelector(part);
    if (parsed.tag && element.tagName !== parsed.tag) return false;
    if (parsed.id && element.id !== parsed.id) return false;
    if (parsed.classes.some((name) => !element.classList.contains(name))) return false;
    if (parsed.attributes.some(({ name, value }) => {
      if (!element.hasAttribute(name)) return true;
      return value != null && element.getAttribute(name) !== value;
    })) return false;
    if (parsed.notAttributes.some(({ name, value }) => {
      if (!element.hasAttribute(name)) return false;
      return value == null ? true : element.getAttribute(name) === value;
    })) return false;
    return true;
  });
}

function querySelectorAll(root: MiniElement | MiniNode, selector: string): MiniElement[] {
  const matches: MiniElement[] = [];

  function visit(node: MiniElement | MiniText | MiniDocumentFragment): void {
    if (!(node instanceof MiniElement)) return;
    if (node.matches(selector)) {
      matches.push(node);
    }
    node.childNodes.forEach(visit);
  }

  if (root instanceof MiniElement) {
    root.childNodes.forEach(visit);
    return matches;
  }

  root.childNodes.forEach(visit);
  return matches;
}

export function createBrowserEnvironment() {
  const document = new MiniDocument();
  const localStorage = new MiniStorage();
  const window = {
    document,
    localStorage,
    innerHeight: 800,
    innerWidth: 1200,
    addEventListener() {},
    removeEventListener() {},
    open() {},
    location: {
      origin: 'https://worldmonitor.test',
      href: 'https://worldmonitor.test/',
    },
    navigator: {
      clipboard: {
        async writeText() {},
      },
    },
    getComputedStyle() {
      return {
        display: '',
        visibility: '',
        gridTemplateColumns: 'none',
        columnGap: '0',
      };
    },
  };

  return {
    document,
    localStorage,
    window,
    requestAnimationFrame(callback: FrameRequestCallback) {
      if (typeof callback === 'function') callback(0);
      return 1;
    },
    cancelAnimationFrame() {},
    HTMLElement: MiniElement,
    HTMLButtonElement: MiniElement,
  };
}
