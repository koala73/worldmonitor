interface RemoveChildErrorShape {
  name?: string;
  type?: string;
  message?: string;
}

interface RemoveChildEvidenceSource {
  document: Document;
  location: Location;
  servedLanguage: string;
  applicationLanguage: string;
  browserLanguage?: string;
  browserLanguages?: readonly string[];
}

interface EventContext {
  extra?: Record<string, unknown>;
  tags?: Record<string, unknown>;
}

export interface RemoveChildEvidence {
  servedLanguage: string;
  documentLanguage: string;
  applicationLanguage: string;
  browserLanguage: string;
  browserLanguages: string[];
  routeWithoutSearch: string;
  htmlTranslate: string | null;
  translatorHtmlClasses: string[];
  microsoftTranslatorNodes: number;
  xTranslateNodes: number;
  clerkDialogCount: number;
  clerkLocalizationKeys: string[];
}

export interface DetachedNodeHost {
  removeChild: (this: unknown, child: Node) => Node;
  insertBefore: (this: unknown, node: Node, child: Node | null) => Node;
}

export type DetachedNodeOperation = 'removeChild' | 'insertBefore';

export interface RemoveChildPolicyEvent extends EventContext {
  exception?: { values?: Array<{ name?: string; type?: string; value?: string }> };
}

const DETACHED_REMOVE_CHILD_MESSAGE = /the node to be removed is not a child of this node/i;
const CLERK_LOCALIZATION_SELECTOR = '[data-localization-key]';
const TRANSLATOR_HTML_CLASS = /^(?:translated|goog-te|skiptranslate)/i;
const SAFE_PRO_ROUTE_HASH = /^#(?:pricing|tiers|api|enterprise|enterprise-contact)$/i;
const DETACHED_NODE_GUARD = Symbol.for('wm.detached-node-guards');

type GuardedHost = DetachedNodeHost & { [DETACHED_NODE_GUARD]?: () => void };

const CLERK_TRANSLATOR_PROTECTED_ROOTS = new WeakSet<Node>();
const CLERK_PROTECTION_BY_DOCUMENT = new WeakMap<Document, () => void>();

export function isRemoveChildError(error: RemoveChildErrorShape | undefined | null): boolean {
  if (!error) return false;
  const name = error.name ?? error.type ?? '';
  const message = error.message ?? '';
  return name === 'NotFoundError' && DETACHED_REMOVE_CHILD_MESSAGE.test(message);
}

function bounded(value: string, maxLength = 120): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function uniqueFirst(values: string[], limit: number): string[] {
  return [...new Set(values.filter(Boolean).map((value) => bounded(value)))].slice(0, limit);
}

export function collectRemoveChildEvidence(source: RemoveChildEvidenceSource): RemoveChildEvidence {
  const { document: doc, location } = source;
  const html = doc.documentElement;
  const htmlTranslate = html.getAttribute('translate');
  // Only known in-page sections are reported. An arbitrary fragment can carry
  // an OAuth response or another sensitive handoff, so it is not telemetry.
  const safeHash = SAFE_PRO_ROUTE_HASH.test(location.hash) ? location.hash : '';
  const route = `${bounded(location.pathname)}${safeHash}`;

  return {
    servedLanguage: bounded(source.servedLanguage, 32),
    documentLanguage: bounded(html.getAttribute('lang') ?? '', 32),
    applicationLanguage: bounded(source.applicationLanguage, 32),
    // Browser locale, not the served page language. Production crashes that
    // blanked /pro after sign-up arrived from Chinese-locale Windows Chromium
    // sessions; this is the discriminator the events themselves lacked.
    browserLanguage: bounded(source.browserLanguage ?? '', 32),
    browserLanguages: uniqueFirst([...(source.browserLanguages ?? [])], 8),
    // Query strings can contain referral and checkout attribution. The route
    // and hash are enough to identify /pro and its section.
    routeWithoutSearch: route,
    htmlTranslate: htmlTranslate === null ? null : bounded(htmlTranslate, 32),
    translatorHtmlClasses: uniqueFirst(
      [...html.classList].filter((className) => TRANSLATOR_HTML_CLASS.test(className)),
      8,
    ),
    microsoftTranslatorNodes: doc.querySelectorAll('font[_msttexthash], font[_msthash]').length,
    xTranslateNodes: doc.querySelectorAll('x-translate').length,
    clerkDialogCount: doc.querySelectorAll('[role="dialog"]').length,
    clerkLocalizationKeys: uniqueFirst(
      [...doc.querySelectorAll(CLERK_LOCALIZATION_SELECTOR)]
        .map((element) => element.getAttribute('data-localization-key') ?? '')
        .filter((key) => key.startsWith('signUp.') || key.startsWith('signIn.')),
      8,
    ),
  };
}

export function decorateRemoveChildEvent<T extends RemoveChildPolicyEvent>(
  event: T,
  evidence: RemoveChildEvidence,
): T {
  const exception = event.exception?.values?.[0];
  if (!exception || !isRemoveChildError({
    name: exception.name,
    type: exception.type,
    message: exception.value,
  })) {
    return event;
  }

  return {
    ...event,
    extra: {
      ...(event.extra ?? {}),
      removeChildDomEvidence: evidence,
    },
    tags: {
      ...(event.tags ?? {}),
      removeChildContext: 'captured',
    },
  };
}

function containsClerkUi(element: Element): boolean {
  return element.matches(CLERK_LOCALIZATION_SELECTOR) ||
    Boolean(element.querySelector(CLERK_LOCALIZATION_SELECTOR));
}

function clerkProtectionRoot(element: Element): Element {
  return element.closest('[role="dialog"]') ?? element;
}

function protectClerkRoot(root: Element, protectedRoots: Set<Element>): void {
  root.setAttribute('translate', 'no');
  CLERK_TRANSLATOR_PROTECTED_ROOTS.add(root);
  protectedRoots.add(root);
}

/**
 * Browser translators replace React-owned text nodes with `<font>` nodes.
 * Clerk already owns those modal subtrees, and its UI is intentionally loaded
 * without a localization configuration here. Marking only Clerk-generated roots
 * as untranslatable leaves the surrounding localized marketing copy alone.
 */
export function protectClerkDomFromTranslators(doc: Document = document): () => void {
  const installed = CLERK_PROTECTION_BY_DOCUMENT.get(doc);
  if (installed) return installed;

  const protectedRoots = new Set<Element>();
  for (const element of [...doc.querySelectorAll(CLERK_LOCALIZATION_SELECTOR)]) {
    protectClerkRoot(clerkProtectionRoot(element), protectedRoots);
  }

  const MutationObserverConstructor = doc.defaultView?.MutationObserver;
  let observer: MutationObserver | undefined;

  if (MutationObserverConstructor) {
    observer = new MutationObserverConstructor((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          // Avoid a cross-realm `instanceof` check: tests supply Happy DOM's
          // Element implementation, while production supplies the browser's.
          if (node.nodeType === 1 && containsClerkUi(node as Element)) {
            protectClerkRoot(clerkProtectionRoot(node as Element), protectedRoots);
          }
        }
      }
    });
    observer.observe(doc.documentElement, { childList: true, subtree: true });
  }

  const stop = (): void => {
    observer?.disconnect();
    for (const root of protectedRoots) CLERK_TRANSLATOR_PROTECTED_ROOTS.delete(root);
    protectedRoots.clear();
    if (CLERK_PROTECTION_BY_DOCUMENT.get(doc) === stop) {
      CLERK_PROTECTION_BY_DOCUMENT.delete(doc);
    }
  };
  CLERK_PROTECTION_BY_DOCUMENT.set(doc, stop);
  return stop;
}

/** The React-owned mount is already localized in-app. Browser translators
 *  replace text nodes inside it and then React's commit-phase removeChild
 *  throws. Clerk ships a separate React copy for its modal, so an error
 *  boundary around `<App />` cannot catch that throw. */
export function protectReactRootFromTranslators(root: Element): void {
  root.setAttribute('translate', 'no');
}

function isInsideClerkTranslatorProtectedRoot(node: unknown): boolean {
  let current = node as Node | null;
  while (current) {
    if (CLERK_TRANSLATOR_PROTECTED_ROOTS.has(current)) {
      return true;
    }
    current = current.parentNode;
  }
  return false;
}

/**
 * Recover only when a node was already detached from a Clerk-owned protected
 * subtree. The application React root relies on its error boundary instead:
 * swallowing every stale mutation there would hide first-party lifecycle bugs.
 * insertBefore always keeps native behavior because appending after a stale
 * reference silently corrupts DOM order.
 */
export function installDetachedNodeGuards(
  proto: DetachedNodeHost = Node.prototype as unknown as DetachedNodeHost,
  onRecovered?: (operation: DetachedNodeOperation) => void,
): () => void {
  const guarded = proto as GuardedHost;
  const installed = guarded[DETACHED_NODE_GUARD];
  if (installed) return installed;

  const originalRemoveChild = proto.removeChild;

  proto.removeChild = function (this: unknown, child: Node): Node {
    if (child != null && child.parentNode !== this && isInsideClerkTranslatorProtectedRoot(this)) {
      onRecovered?.('removeChild');
      return child;
    }
    return originalRemoveChild.call(this, child);
  };

  const uninstall = (): void => {
    proto.removeChild = originalRemoveChild;
    delete guarded[DETACHED_NODE_GUARD];
  };
  guarded[DETACHED_NODE_GUARD] = uninstall;
  return uninstall;
}
