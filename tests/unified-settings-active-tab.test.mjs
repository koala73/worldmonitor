import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const settingsSrc = readFileSync(
  resolve(__dirname, '../src/components/UnifiedSettings.ts'),
  'utf8',
);

// UnifiedSettings pulls in the full settings UI graph, so exercise the real
// open() method against a small stateful harness. This is the same extraction
// pattern used by search-open-state-machine.test.mjs for app-level UI methods.
function extractOpen() {
  const signature = 'public open(';
  const start = settingsSrc.indexOf(signature);
  assert.ok(start >= 0, 'UnifiedSettings.open must remain a public method');

  const parenStart = start + signature.length - 1;
  let parenDepth = 0;
  let parenEnd = -1;
  for (let i = parenStart; i < settingsSrc.length; i++) {
    const char = settingsSrc[i];
    if (char === '(') parenDepth++;
    else if (char === ')') {
      parenDepth--;
      if (parenDepth === 0) {
        parenEnd = i;
        break;
      }
    }
  }
  assert.ok(parenEnd > parenStart, 'UnifiedSettings.open parameters must be balanced');

  const braceStart = settingsSrc.indexOf('{', parenEnd);
  let braceDepth = 0;
  let end = -1;
  for (let i = braceStart; i < settingsSrc.length; i++) {
    const char = settingsSrc[i];
    if (char === '{') braceDepth++;
    else if (char === '}') {
      braceDepth--;
      if (braceDepth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert.ok(end > braceStart, 'UnifiedSettings.open body must be balanced');

  const methodSrc = settingsSrc.slice(start, end).replace(/^public\s+/, '');
  const js = ts.transpileModule(
    `class __UnifiedSettingsOpenHarness { ${methodSrc} }`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.None,
      },
    },
  ).outputText;

  // eslint-disable-next-line no-new-func
  return new Function(
    'getEntitlementState',
    'getEntitlementVerificationStatus',
    'hasFeature',
    'onEntitlementChange',
    'onEntitlementVerificationChange',
    'onSubscriptionChange',
    'getSubscription',
    'getAuthState',
    'setTrustedHtml',
    'trustedHtml',
    'track',
    'isMobileDevice',
    'overlayHistory',
    `${js}\nreturn __UnifiedSettingsOpenHarness;`,
  );
}

let mcpAccess = false;
const Harness = extractOpen()(
  () => ({ planKey: mcpAccess ? 'pro_monthly' : 'free' }),
  () => 'ready',
  (feature) => feature === 'mcpAccess' && mcpAccess,
  () => () => {},
  () => () => {},
  () => () => {},
  () => null,
  () => ({ user: null }),
  () => {},
  (value) => value,
  () => {},
  () => false,
  { open() {}, replace() {} },
);

/**
 * What the stubbed sourceSelectionSignature() returns, so the baseline open()
 * records is identifiable rather than merely non-undefined.
 */
const STUB_SOURCE_SIGNATURE = 'stub-source-signature';

function makeInstance(initialTab = 'settings') {
  const instance = new Harness();
  instance.activeTab = initialTab;
  instance.resetPanelDraft = () => {};
  // The real one reads config.getDisabledSources(), which this harness has no
  // config for. Kept observable rather than a bare no-op so the baseline
  // open() takes for #6380 stays asserted below.
  instance.sourceSelectionSignature = () => STUB_SOURCE_SIGNATURE;
  // Mirrors the real field initializer. open() snapshots only from null, so a
  // harness left at undefined would model a state the class never has.
  instance.sourceSelectionBaseline = null;
  instance.renderedTabs = [];
  instance.render = function render() {
    this.renderedTabs.push(this.activeTab);
  };
  instance.overlay = {
    classList: { add() {} },
    querySelector() { return null; },
  };
  instance.escapeHandler = () => {};
  instance.unsubscribeEntitlement = null;
  instance.unsubscribeEntitlementVerification = null;
  instance.unsubscribeSubscription = null;
  instance.businessSeatsSection = { load() {} };
  return instance;
}

describe('UnifiedSettings.open active-tab availability (#5611)', () => {
  beforeEach(() => {
    mcpAccess = false;
    globalThis.localStorage = {
      getItem: () => null,
      setItem() {},
      removeItem() {},
      clear() {},
      key: () => null,
      length: 0,
    };
    globalThis.document = {
      addEventListener() {},
      removeEventListener() {},
    };
  });

  it('falls back to Settings when explicitly opened to MCP Clients without access', () => {
    const instance = makeInstance();

    instance.open('mcp-clients');

    assert.equal(instance.activeTab, 'settings');
    assert.deepEqual(instance.renderedTabs, ['settings']);
  });

  it('clears a sticky MCP Clients tab when access was lost between opens', () => {
    const instance = makeInstance('mcp-clients');

    instance.open();

    assert.equal(instance.activeTab, 'settings');
    assert.deepEqual(instance.renderedTabs, ['settings']);
  });

  it('preserves MCP Clients when the tab is available', () => {
    mcpAccess = true;
    const instance = makeInstance();

    instance.open('mcp-clients');

    assert.equal(instance.activeTab, 'mcp-clients');
    assert.deepEqual(instance.renderedTabs, ['mcp-clients']);
  });

  it('does not clamp tabs that are always rendered', () => {
    const instance = makeInstance();

    instance.open('api-keys');

    assert.equal(instance.activeTab, 'api-keys');
    assert.deepEqual(instance.renderedTabs, ['api-keys']);
  });

  // Sources apply on click with no Save step, and teardownSettings decides
  // whether to tell the host to reload by comparing against the set as it was
  // when the overlay opened (#6380). Without that snapshot the comparison has
  // nothing to compare to and every close either always reloads or never does.
  it('snapshots the source selection so a change can be detected at close (#6380)', () => {
    const instance = makeInstance();
    assert.equal(instance.sourceSelectionBaseline, null);

    instance.open();

    assert.equal(instance.sourceSelectionBaseline, STUB_SOURCE_SIGNATURE);
  });

  // open() is re-entrant on an already-open overlay. Re-snapshotting there
  // would adopt a source change made earlier in the session as the baseline,
  // so close() would see no movement and never ask the host to reload.
  it('keeps the first snapshot when open() is re-entered mid-session (#6380)', () => {
    const instance = makeInstance();
    instance.open();
    instance.sourceSelectionSignature = () => 'moved-since-open';

    instance.open('api-keys');

    assert.equal(instance.sourceSelectionBaseline, STUB_SOURCE_SIGNATURE);
  });
});
