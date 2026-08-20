import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

import {
  collectRemoveChildEvidence,
  decorateRemoveChildEvent,
  isRemoveChildError,
  protectClerkDomFromTranslators,
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

describe('removeChild error classification and evidence', () => {
  it('matches only the DOM teardown failure', () => {
    const error = new Error('Failed to execute \'removeChild\' on \'Node\': The node to be removed is not a child of this node.');
    error.name = 'NotFoundError';
    assert.equal(isRemoveChildError(error), true);
    assert.equal(
      isRemoveChildError({ type: 'NotFoundError', message: 'The node to be removed is not a child of this node.' }),
      true,
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
    });

    assert.equal(evidence.servedLanguage, 'en');
    assert.equal(evidence.documentLanguage, 'fr');
    assert.equal(evidence.applicationLanguage, 'fr');
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
      routeWithoutSearch: '/pro',
      htmlTranslate: null,
      translatorHtmlClasses: [],
      microsoftTranslatorNodes: 0,
      xTranslateNodes: 0,
      clerkDialogCount: 1,
      clerkLocalizationKeys: ['signUp.emailCode.formSubtitle'],
    };
    const removeChildEvent = {
      exception: { values: [{ name: 'NotFoundError', value: 'Failed to execute \'removeChild\' on \'Node\'' }] },
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
});

describe('/pro removeChild deployment contract', () => {
  it('mounts the teardown boundary, Sentry enrichment, and Clerk isolation', () => {
    const main = source('pro-test/src/main.tsx');
    assert.match(main, /<ProDomErrorBoundary>/);
    assert.match(main, /<App \/>/);

    const sentry = source('pro-test/src/sentry.ts');
    assert.match(sentry, /decorateRemoveChildEvent/);
    assert.match(sentry, /collectRemoveChildEvidence/);
    assert.match(sentry, /beforeSend:/);

    const clerk = source('pro-test/src/services/clerk.ts');
    assert.match(clerk, /protectClerkDomFromTranslators\(\);/);

    const app = source('pro-test/src/App.tsx');
    assert.match(app, /ref=\{ref\} translate="no"/);
  });
});
