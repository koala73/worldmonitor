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
    'hasFeature',
    'onEntitlementChange',
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
  (feature) => feature === 'mcpAccess' && mcpAccess,
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

function makeInstance(initialTab = 'settings') {
  const instance = new Harness();
  instance.activeTab = initialTab;
  instance.resetPanelDraft = () => {};
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
  instance.unsubscribeSubscription = null;
  instance.entitlementReady = false;
  instance.entitlementReadyTimer = null;
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
});
