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

const REMOVE_CHILD_ERROR = /removeChild/i;
const CLERK_LOCALIZATION_SELECTOR = '[data-localization-key]';
const TRANSLATOR_HTML_CLASS = /^(?:translated|goog-te|skiptranslate)/i;
const SAFE_PRO_ROUTE_HASH = /^#(?:pricing|tiers|api|enterprise|enterprise-contact)$/i;
const DETACHED_NODE_GUARD = Symbol.for('wm.detached-node-guards');

type GuardedHost = DetachedNodeHost & { [DETACHED_NODE_GUARD]?: () => void };

export function isRemoveChildError(error: RemoveChildErrorShape | undefined | null): boolean {
  if (!error) return false;
  const name = error.name ?? error.type ?? '';
  const message = error.message ?? '';
  return REMOVE_CHILD_ERROR.test(message) ||
    (name === 'NotFoundError' && /node to be removed is not a child/i.test(message));
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

/**
 * Browser translators replace React-owned text nodes with `<font>` nodes.
 * Clerk already owns those modal subtrees, and its UI is intentionally loaded
 * without a localization configuration here. Marking only Clerk-generated roots
 * as untranslatable leaves the surrounding localized marketing copy alone.
 */
export function protectClerkDomFromTranslators(doc: Document = document): () => void {
  for (const element of [...doc.querySelectorAll(CLERK_LOCALIZATION_SELECTOR)]) {
    element.setAttribute('translate', 'no');
  }

  const MutationObserverConstructor = doc.defaultView?.MutationObserver;
  if (!MutationObserverConstructor) return () => {};

  const observer = new MutationObserverConstructor((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        // Avoid a cross-realm `instanceof` check: tests supply Happy DOM's
        // Element implementation, while production supplies the browser's.
        if (node.nodeType === 1 && containsClerkUi(node as Element)) {
          (node as Element).setAttribute('translate', 'no');
        }
      }
    }
  });
  observer.observe(doc.documentElement, { childList: true, subtree: true });
  return () => observer.disconnect();
}

/** The React-owned mount is already localized in-app. Browser translators
 *  replace text nodes inside it and then React's commit-phase removeChild
 *  throws. Clerk ships a separate React copy for its modal, so an error
 *  boundary around `<App />` cannot catch that throw. */
export function protectReactRootFromTranslators(root: Element): void {
  root.setAttribute('translate', 'no');
}

/**
 * Recover when a translator or extension already detached the node React is
 * trying to remove or use as an insertBefore reference. The matching
 * parent/child path still reaches the browser implementation.
 */
export function installDetachedNodeGuards(
  proto: DetachedNodeHost = Node.prototype as unknown as DetachedNodeHost,
  onRecovered?: (operation: DetachedNodeOperation) => void,
): () => void {
  const guarded = proto as GuardedHost;
  const installed = guarded[DETACHED_NODE_GUARD];
  if (installed) return installed;

  const originalRemoveChild = proto.removeChild;
  const originalInsertBefore = proto.insertBefore;

  proto.removeChild = function (this: unknown, child: Node): Node {
    if (child.parentNode !== this) {
      onRecovered?.('removeChild');
      return child;
    }
    return originalRemoveChild.call(this, child);
  };

  proto.insertBefore = function (this: unknown, node: Node, child: Node | null): Node {
    if (child !== null && child.parentNode !== this) {
      onRecovered?.('insertBefore');
      return node;
    }
    return originalInsertBefore.call(this, node, child);
  };

  const uninstall = (): void => {
    proto.removeChild = originalRemoveChild;
    proto.insertBefore = originalInsertBefore;
    delete guarded[DETACHED_NODE_GUARD];
  };
  guarded[DETACHED_NODE_GUARD] = uninstall;
  return uninstall;
}
