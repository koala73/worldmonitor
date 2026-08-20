import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'esbuild';
import { Window } from 'happy-dom';

import {
  collectRemoveChildEvidence,
  decorateRemoveChildEvent,
  installDetachedNodeGuards,
  isRemoveChildError,
  protectClerkDomFromTranslators,
  protectReactRootFromTranslators,
} from '../pro-test/src/services/clerk-dom-safety.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function source(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

function browserWindow(): Window {
  const window = new Window({
    url: 'https://www.worldmonitor.app/pro?wm_referral=private#pricing',
  });
  window.document.documentElement.setAttribute('lang', 'fr');
  return window;
}

interface BoundaryHarness {
  captures: Array<{ error: Error; context: Record<string, unknown> }>;
}

interface ClerkLoadHarness {
  loadCalls: number;
  protectionStarts: number;
  protectionStops: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __proDomBoundaryHarness: BoundaryHarness;
  // eslint-disable-next-line no-var
  var __proClerkLoadHarness: ClerkLoadHarness;
}

async function loadProDomErrorBoundary(): Promise<{
  ProDomErrorBoundary: {
    new (props: { children: unknown }): {
      state: { failed: boolean };
      componentDidCatch(error: Error, info: { componentStack: string }): void;
      render(): { type: string; props: Record<string, unknown> };
    };
    getDerivedStateFromError(error: Error): { failed: boolean };
  };
}> {
  const stubSources: Record<string, string> = {
    react: `
      export class Component {
        constructor(props) {
          this.props = props;
          this.state = {};
        }
      }
    `,
    'react/jsx-runtime': `
      export const Fragment = Symbol.for('react.fragment');
      export function jsx(type, props) { return { type, props }; }
      export const jsxs = jsx;
    `,
    '@sentry/react': `
      export function captureException(error, context) {
        globalThis.__proDomBoundaryHarness.captures.push({ error, context });
      }
    `,
  };
  const plugin: Plugin = {
    name: 'pro-dom-boundary-harness',
    setup(buildApi) {
      buildApi.onResolve({ filter: /.*/ }, (args) =>
        Object.hasOwn(stubSources, args.path)
          ? { path: args.path, namespace: 'pro-dom-boundary-stub' }
          : null,
      );
      buildApi.onLoad(
        { filter: /.*/, namespace: 'pro-dom-boundary-stub' },
        (args) => ({ contents: stubSources[args.path], loader: 'js' }),
      );
    },
  };
  const result = await build({
    absWorkingDir: repoRoot,
    stdin: {
      contents: `export { ProDomErrorBoundary } from './pro-test/src/ProDomErrorBoundary.tsx';`,
      resolveDir: repoRoot,
      loader: 'tsx',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    write: false,
    plugins: [plugin],
  });
  const dataUrl =
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`;
  return import(`${dataUrl}#${Date.now()}-${Math.random()}`);
}

async function loadClerkServiceWithFailedLoad(): Promise<{
  ensureClerk(): Promise<unknown>;
}> {
  const stubSources: Record<string, string> = {
    '@clerk/clerk-js': `
      export class Clerk {
        async load() {
          globalThis.__proClerkLoadHarness.loadCalls += 1;
          throw new Error('simulated Clerk load failure');
        }
      }
    `,
    './clerk-dom-safety': `
      export function protectClerkDomFromTranslators() {
        globalThis.__proClerkLoadHarness.protectionStarts += 1;
        return () => { globalThis.__proClerkLoadHarness.protectionStops += 1; };
      }
    `,
  };
  const plugin: Plugin = {
    name: 'pro-clerk-load-harness',
    setup(buildApi) {
      buildApi.onResolve({ filter: /.*/ }, (args) =>
        Object.hasOwn(stubSources, args.path)
          ? { path: args.path, namespace: 'pro-clerk-load-stub' }
          : null,
      );
      buildApi.onLoad(
        { filter: /.*/, namespace: 'pro-clerk-load-stub' },
        (args) => ({ contents: stubSources[args.path], loader: 'js' }),
      );
    },
  };
  const result = await build({
    absWorkingDir: repoRoot,
    stdin: {
      contents: `export { ensureClerk } from './pro-test/src/services/clerk.ts';`,
      resolveDir: repoRoot,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    define: { 'import.meta.env.VITE_CLERK_PUBLISHABLE_KEY': '"pk_test"' },
    plugins: [plugin],
  });
  const dataUrl =
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`;
  return import(`${dataUrl}#${Date.now()}-${Math.random()}`);
}

describe('removeChild error classification and evidence', () => {
  it('matches only the DOM teardown failure', () => {
    const error = new Error('Failed to execute \'removeChild\' on \'Node\': The node to be removed is not a child of this node.');
    error.name = 'NotFoundError';
    assert.equal(isRemoveChildError(error), true);
    assert.equal(
      isRemoveChildError({ type: 'NotFoundError', message: 'The node to be removed is not a child of this node.' }),
      true,
    );
    assert.equal(isRemoveChildError(new Error('removeChild is not a function')), false);
    assert.equal(
      isRemoveChildError({ name: 'TypeError', message: 'The node to be removed is not a child of this node.' }),
      false,
    );
    assert.equal(
      isRemoveChildError({ name: 'NotFoundError', message: "Failed to execute 'removeChild' on 'Node'" }),
      false,
    );
    assert.equal(isRemoveChildError(new Error('Failed to fetch')), false);
    assert.equal(isRemoveChildError(null), false);
  });

  it('captures language, translator, route, and Clerk step without query text', () => {
    const window = browserWindow();
    const doc = window.document;
    doc.documentElement.classList.add('translated-ltr', 'wm-analytics');
    const microsoftFont = doc.createElement('font');
    microsoftFont.setAttribute('_msttexthash', '123');
    doc.body.appendChild(microsoftFont);
    doc.body.appendChild(doc.createElement('x-translate'));

    const clerkStep = doc.createElement('div');
    clerkStep.setAttribute('data-localization-key', 'signUp.emailCode.formSubtitle');
    const dialog = doc.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.appendChild(clerkStep);
    doc.body.appendChild(dialog);

    const evidence = collectRemoveChildEvidence({
      document: doc,
      location: window.location,
      servedLanguage: 'en',
      applicationLanguage: 'fr',
      browserLanguage: 'zh-TW',
      browserLanguages: ['zh-TW', 'zh', 'en-US'],
    });

    assert.equal(evidence.servedLanguage, 'en');
    assert.equal(evidence.documentLanguage, 'fr');
    assert.equal(evidence.applicationLanguage, 'fr');
    assert.equal(evidence.browserLanguage, 'zh-TW');
    assert.deepEqual(evidence.browserLanguages, ['zh-TW', 'zh', 'en-US']);
    assert.equal(evidence.routeWithoutSearch, '/pro#pricing');
    assert.deepEqual(evidence.translatorHtmlClasses, ['translated-ltr']);
    assert.equal(evidence.microsoftTranslatorNodes, 1);
    assert.equal(evidence.xTranslateNodes, 1);
    assert.equal(evidence.clerkDialogCount, 1);
    assert.deepEqual(evidence.clerkLocalizationKeys, ['signUp.emailCode.formSubtitle']);
  });

  it('omits unknown fragment values that could contain an auth handoff', () => {
    const window = browserWindow();
    window.location.hash = '#access_token=private';
    const evidence = collectRemoveChildEvidence({
      document: window.document,
      location: window.location,
      servedLanguage: 'en',
      applicationLanguage: 'en',
    });
    assert.equal(evidence.routeWithoutSearch, '/pro');
  });

  it('enriches only removeChild events and preserves existing event context', () => {
    const evidence = {
      servedLanguage: 'en',
      documentLanguage: 'en',
      applicationLanguage: 'en',
      browserLanguage: 'zh-CN',
      browserLanguages: ['zh-CN'],
      routeWithoutSearch: '/pro',
      htmlTranslate: null,
      translatorHtmlClasses: [],
      microsoftTranslatorNodes: 0,
      xTranslateNodes: 0,
      clerkDialogCount: 1,
      clerkLocalizationKeys: ['signUp.emailCode.formSubtitle'],
    };
    const removeChildEvent = {
      exception: { values: [{ name: 'NotFoundError', value: "Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node." }] },
      extra: { kept: true },
      tags: { surface: 'pro-marketing' },
    };
    const enriched = decorateRemoveChildEvent(removeChildEvent, evidence);
    assert.deepEqual(enriched.extra, {
      kept: true,
      removeChildDomEvidence: evidence,
    });
    assert.equal(enriched.tags?.removeChildContext, 'captured');
    assert.equal(enriched.tags?.surface, 'pro-marketing');

    const fetchEvent = { exception: { values: [{ value: 'Failed to fetch' }] } };
    assert.equal(decorateRemoveChildEvent(fetchEvent, evidence), fetchEvent);
  });
});

describe('Clerk translator isolation', () => {
  it('marks existing and newly mounted Clerk UI untranslatable without touching app DOM', async () => {
    const window = browserWindow();
    const doc = window.document;
    const existingButton = doc.createElement('div');
    existingButton.setAttribute('data-localization-key', 'userButton.tooltip');
    doc.body.appendChild(existingButton);

    const stop = protectClerkDomFromTranslators(doc);
    try {
      assert.equal(existingButton.getAttribute('translate'), 'no');

      const modalRoot = doc.createElement('div');
      const step = doc.createElement('section');
      step.setAttribute('data-localization-key', 'signUp.emailCode.formSubtitle');
      modalRoot.appendChild(step);
      doc.body.appendChild(modalRoot);

      const appRoot = doc.createElement('main');
      appRoot.textContent = 'localized marketing copy';
      doc.body.appendChild(appRoot);

      await new Promise((resolve) => window.setTimeout(resolve, 0));
      assert.equal(modalRoot.getAttribute('translate'), 'no');
      assert.equal(appRoot.getAttribute('translate'), null);
    } finally {
      stop();
    }
  });

  it('disconnects translator protection after each failed Clerk load retry', async () => {
    globalThis.__proClerkLoadHarness = {
      loadCalls: 0,
      protectionStarts: 0,
      protectionStops: 0,
    };
    const { ensureClerk } = await loadClerkServiceWithFailedLoad();

    await assert.rejects(ensureClerk(), /simulated Clerk load failure/);
    await assert.rejects(ensureClerk(), /simulated Clerk load failure/);
    assert.deepEqual(globalThis.__proClerkLoadHarness, {
      loadCalls: 2,
      protectionStarts: 2,
      protectionStops: 2,
    });
  });

  it('installs one observer per document and permits a fresh install after cleanup', () => {
    const window = browserWindow();
    const first = protectClerkDomFromTranslators(window.document);
    const second = protectClerkDomFromTranslators(window.document);
    assert.equal(second, first);

    first();
    const afterCleanup = protectClerkDomFromTranslators(window.document);
    assert.notEqual(afterCleanup, first);
    afterCleanup();
  });
});

describe('detached node host-config guard', () => {
  function throwingProto() {
    const originalRemoveChild = function <T extends Node>(this: Node, child: T): T {
      if (child.parentNode !== this) {
        const error = new Error("Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.");
        error.name = 'NotFoundError';
        throw error;
      }
      return child;
    };
    const originalInsertBefore = function <T extends Node>(this: Node, node: T, child: Node | null): T {
      if (child && child.parentNode !== this) {
        const error = new Error("Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node.");
        error.name = 'NotFoundError';
        throw error;
      }
      return node;
    };
    return { removeChild: originalRemoveChild, insertBefore: originalInsertBefore };
  }

  it('recovers a stale removeChild only inside a Clerk-owned protected root', () => {
    const proto = throwingProto();
    const recovered: string[] = [];
    const window = browserWindow();
    const parent = window.document.createElement('div');
    parent.setAttribute('role', 'dialog');
    const clerkStep = window.document.createElement('span');
    clerkStep.setAttribute('data-localization-key', 'signUp.emailCode.formSubtitle');
    parent.appendChild(clerkStep);
    const matchingChild = window.document.createTextNode('matching');
    const orphan = window.document.createTextNode('translator-font');
    const unrelatedParent = window.document.createElement('div');
    parent.appendChild(matchingChild);
    unrelatedParent.appendChild(orphan);
    window.document.body.appendChild(parent);
    const stopProtection = protectClerkDomFromTranslators(window.document);
    const stop = installDetachedNodeGuards(proto, (operation) => recovered.push(operation));
    try {
      assert.equal(proto.removeChild.call(parent, matchingChild), matchingChild);
      assert.equal(proto.removeChild.call(parent, orphan), orphan);
      assert.deepEqual(recovered, ['removeChild']);
    } finally {
      stop();
      stopProtection();
    }
  });

  it('does not hide stale removeChild failures in the application React root', () => {
    const proto = throwingProto();
    const recovered: string[] = [];
    const window = browserWindow();
    const appRoot = window.document.createElement('div');
    const otherRoot = window.document.createElement('div');
    const movedChild = window.document.createTextNode('moved');
    otherRoot.appendChild(movedChild);
    protectReactRootFromTranslators(appRoot);
    const stop = installDetachedNodeGuards(proto, (operation) => recovered.push(operation));
    try {
      assert.throws(
        () => proto.removeChild.call(appRoot, movedChild),
        /node to be removed is not a child/i,
      );
      assert.deepEqual(recovered, []);
    } finally {
      stop();
    }
  });

  it('is idempotent and restores the original host methods', () => {
    const proto = throwingProto();
    const first = proto.removeChild;
    const stop = installDetachedNodeGuards(proto);
    const again = installDetachedNodeGuards(proto);
    assert.notEqual(proto.removeChild, first);
    stop();
    assert.equal(proto.removeChild, first);
    again();
    assert.equal(proto.removeChild, first);
  });

  it('keeps a real DOM remove when the child still belongs to the parent', () => {
    const window = browserWindow();
    const proto = window.Node.prototype;
    const parent = window.document.createElement('div');
    parent.setAttribute('role', 'dialog');
    const child = window.document.createTextNode('Sign up');
    parent.appendChild(child);
    const stop = installDetachedNodeGuards(proto);
    try {
      parent.removeChild(child);
      assert.equal(child.parentNode, null);
      assert.equal(parent.childNodes.length, 0);
    } finally {
      stop();
    }
  });

  it('never appends after a stale insertBefore reference in a Clerk-owned root', () => {
    const window = browserWindow();
    const proto = window.Node.prototype;
    const parent = window.document.createElement('div');
    const clerkStep = window.document.createElement('span');
    clerkStep.setAttribute('data-localization-key', 'signUp.emailCode.formSubtitle');
    const first = window.document.createElement('span');
    first.textContent = 'first';
    const last = window.document.createElement('span');
    last.textContent = 'last';
    const staleRef = window.document.createTextNode('old');
    const next = window.document.createElement('span');
    next.textContent = 'next';
    parent.append(clerkStep, first, staleRef, last);
    window.document.body.appendChild(parent);
    const stopProtection = protectClerkDomFromTranslators(window.document);
    parent.appendChild(staleRef);
    window.document.body.appendChild(staleRef);
    const stop = installDetachedNodeGuards(proto);
    try {
      assert.throws(
        () => parent.insertBefore(next, staleRef),
        /node before which the new node is to be inserted is not a child/i,
      );
      assert.equal(next.parentNode, null);
      assert.deepEqual(
        [...parent.children].map((element) => element.textContent),
        ['', 'first', 'last'],
      );

      // The failed mutation leaves the tree usable and preserves the caller's
      // intended position on the next valid update.
      parent.insertBefore(next, last);
      assert.deepEqual(
        [...parent.children].map((element) => element.textContent),
        ['', 'first', 'next', 'last'],
      );
    } finally {
      stop();
      stopProtection();
    }
  });

  it('preserves native removeChild failures outside a protected surface', () => {
    const window = browserWindow();
    const parent = window.document.createElement('div');
    const unrelatedParent = window.document.createElement('div');
    const child = window.document.createTextNode('moved');
    unrelatedParent.appendChild(child);
    const recovered: string[] = [];
    const stop = installDetachedNodeGuards(
      window.Node.prototype,
      (operation) => recovered.push(operation),
    );
    try {
      assert.throws(
        () => parent.removeChild(child),
        /node to be removed is not a child/i,
      );
      assert.deepEqual(recovered, []);
    } finally {
      stop();
    }
  });

  it('preserves native insertBefore failures outside a protected surface', () => {
    const window = browserWindow();
    const parent = window.document.createElement('div');
    const unrelatedParent = window.document.createElement('div');
    const staleReference = window.document.createTextNode('moved');
    const next = window.document.createElement('span');
    unrelatedParent.appendChild(staleReference);
    const recovered: string[] = [];
    const stop = installDetachedNodeGuards(
      window.Node.prototype,
      (operation) => recovered.push(operation),
    );
    try {
      assert.throws(
        () => parent.insertBefore(next, staleReference),
        /node before which the new node is to be inserted is not a child/i,
      );
      assert.equal(next.parentNode, null);
      assert.deepEqual(recovered, []);
    } finally {
      stop();
    }
  });
});

describe('React root translator isolation', () => {
  it('marks the React-owned mount untranslatable', () => {
    const window = browserWindow();
    const root = window.document.createElement('div');
    root.id = 'root';
    window.document.body.appendChild(root);
    protectReactRootFromTranslators(root);
    assert.equal(root.getAttribute('translate'), 'no');
  });
});

describe('Pro DOM error boundary behavior', () => {
  it('renders and reports recovery only for the detached-child failure', async () => {
    globalThis.__proDomBoundaryHarness = { captures: [] };
    const { ProDomErrorBoundary } = await loadProDomErrorBoundary();
    const detached = new Error(
      "Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.",
    );
    detached.name = 'NotFoundError';

    assert.deepEqual(ProDomErrorBoundary.getDerivedStateFromError(detached), { failed: true });
    const boundary = new ProDomErrorBoundary({ children: 'application' });
    boundary.state = { failed: true };
    const fallback = boundary.render();
    assert.equal(fallback.type, 'div');
    assert.equal(fallback.props.role, 'alert');
    assert.equal(fallback.props['data-testid'], 'pro-dom-error-boundary');

    boundary.componentDidCatch(detached, { componentStack: 'at App' });
    assert.equal(globalThis.__proDomBoundaryHarness.captures.length, 1);
    assert.equal(globalThis.__proDomBoundaryHarness.captures[0]?.error, detached);
  });

  it('rethrows unrelated descendant failures to the outer handler', async () => {
    globalThis.__proDomBoundaryHarness = { captures: [] };
    const { ProDomErrorBoundary } = await loadProDomErrorBoundary();
    const unrelated = new Error('render failed');

    assert.throws(
      () => ProDomErrorBoundary.getDerivedStateFromError(unrelated),
      (error: unknown) => error === unrelated,
    );
    const boundary = new ProDomErrorBoundary({ children: 'application' });
    assert.throws(
      () => boundary.componentDidCatch(unrelated, { componentStack: 'at App' }),
      (error: unknown) => error === unrelated,
    );
    assert.equal(globalThis.__proDomBoundaryHarness.captures.length, 0);
  });
});

describe('/pro removeChild deployment contract', () => {
  it('mounts the teardown boundary, Sentry enrichment, Clerk isolation, and host-config guard', () => {
    const main = source('pro-test/src/main.tsx');
    assert.match(main, /<ProDomErrorBoundary>/);
    assert.match(main, /<App \/>/);
    assert.match(main, /installDetachedNodeGuards/);
    assert.match(main, /protectReactRootFromTranslators/);
    assert.match(main, /captureMessage[\s\S]*removeChildDomEvidence/);

    const sentry = source('pro-test/src/sentry.ts');
    assert.match(sentry, /decorateRemoveChildEvent/);
    assert.match(sentry, /collectRemoveChildEvidence/);
    assert.match(sentry, /browserLanguage/);
    assert.match(sentry, /beforeSend:/);

    const clerk = source('pro-test/src/services/clerk.ts');
    assert.match(clerk, /stopTranslatorProtection = protectClerkDomFromTranslators\(\)/);

    const app = source('pro-test/src/App.tsx');
    assert.match(app, /ref=\{ref\} translate="no"/);
  });
});
