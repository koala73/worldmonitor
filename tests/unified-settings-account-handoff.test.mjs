import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const settingsSource = readFileSync(
  resolve(root, 'src/components/UnifiedSettings.ts'),
  'utf8',
);
const seatsSource = readFileSync(
  resolve(root, 'src/components/BusinessSeatsSection.ts'),
  'utf8',
);

function extractMethod(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `expected method ${signature}`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced method ${signature}`);
}

function transpileHarness(methods, dependencies = []) {
  const js = ts.transpileModule(
    `class Harness { ${methods.join('\n')} }`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.None,
      },
    },
  ).outputText;
  // eslint-disable-next-line no-new-func
  return new Function(...dependencies, `${js}\nreturn Harness;`);
}

describe('UnifiedSettings account handoff', () => {
  it('synchronously clears every account-owned cache and invalidates old requests', async () => {
    let currentUserId = 'A';
    let resolveKeys = () => {};
    const keysResult = new Promise((resolve) => {
      resolveKeys = resolve;
    });
    const Harness = transpileHarness(
      [
        extractMethod(settingsSource, 'private handleAccountIdentityChange('),
        extractMethod(settingsSource, 'private captureAccountRequest('),
        extractMethod(settingsSource, 'private isAccountRequestCurrent('),
        extractMethod(settingsSource, 'private async loadApiKeys('),
      ],
      ['getAuthState', 'listApiKeys'],
    )(
      () => ({ user: currentUserId ? { id: currentUserId } : null }),
      () => keysResult,
    );
    const instance = new Harness();
    const renders = [];
    let seatsReset = 0;
    instance.accountUserId = 'A';
    instance.accountDataGeneration = 4;
    instance.accountEntitlementRefreshPending = false;
    instance.apiKeys = [{ id: 'key-a' }];
    instance.apiKeysLoading = false;
    instance.apiKeysError = 'A error';
    instance.newlyCreatedKey = 'wm_a_plaintext';
    instance.planLimitNotices = [{ _id: 'notice-a' }];
    instance.planLimitNoticesLoading = true;
    instance.mcpClients = [{ id: 'client-a' }];
    instance.mcpClientsLoading = true;
    instance.mcpClientsError = 'A error';
    instance.mcpQuota = { used: 41, limit: 50, resetsAt: 'tomorrow' };
    instance.stopMcpQuotaPolling = () => {};
    instance.businessSeatsSection = {
      resetForAccountChange: () => {
        seatsReset += 1;
      },
    };
    instance.overlay = { classList: { contains: () => true } };
    instance.render = (loadAccountData) => renders.push(loadAccountData);
    let listRenders = 0;
    instance.renderApiKeysList = () => {
      listRenders += 1;
    };

    const requestA = instance.captureAccountRequest();
    const loadA = instance.loadApiKeys();
    currentUserId = 'B';
    instance.handleAccountIdentityChange('B');
    resolveKeys([{ id: 'late-key-a', name: 'A secret' }]);
    await loadA;

    assert.equal(instance.accountDataGeneration, 5);
    assert.equal(instance.accountEntitlementRefreshPending, true);
    assert.deepEqual(instance.apiKeys, []);
    assert.equal(instance.apiKeysLoading, false);
    assert.equal(instance.apiKeysError, '');
    assert.equal(instance.newlyCreatedKey, null);
    assert.deepEqual(instance.planLimitNotices, []);
    assert.equal(instance.planLimitNoticesLoading, false);
    assert.deepEqual(instance.mcpClients, []);
    assert.equal(instance.mcpClientsLoading, false);
    assert.equal(instance.mcpClientsError, '');
    assert.equal(instance.mcpQuota, null);
    assert.equal(seatsReset, 1);
    assert.deepEqual(renders, [false], 'the synchronous rerender must suppress account loads');
    assert.equal(listRenders, 1, 'A settlement must not render after B clears the surface');
    assert.equal(instance.isAccountRequestCurrent(requestA), false);
  });

  it('generation-guards every account-scoped async settings path', () => {
    const guardedMethods = [
      'loadPlanLimitNotices',
      'handleAcknowledgePlanLimitNotice',
      'loadApiKeys',
      'handleCreateApiKey',
      'handleRevokeApiKey',
      'loadMcpClients',
      'refreshMcpQuota',
      'handleRevokeMcpClient',
    ];
    for (const method of guardedMethods) {
      const body = extractMethod(settingsSource, `private async ${method}(`);
      assert.match(body, /captureAccountRequest\(\)/, `${method} must capture the initiating account`);
      assert.match(body, /isAccountRequestCurrent\(request\)/, `${method} must discard stale settlement`);
    }
  });
});

describe('BusinessSeatsSection account handoff', () => {
  it('drops an A seat list that settles after the section resets for B', async () => {
    let resolveList = () => {};
    const listResult = new Promise((resolve) => {
      resolveList = resolve;
    });
    const Harness = transpileHarness(
      [
        extractMethod(seatsSource, 'resetForAccountChange('),
        extractMethod(seatsSource, 'async load('),
      ],
      ['listBusinessSeats'],
    )(() => listResult);
    const instance = new Harness();
    let renders = 0;
    instance.accountGeneration = 0;
    instance.seats = [];
    instance.loading = false;
    instance.error = '';
    instance.ownerDomain = null;
    instance.ownerIsCorporateDomain = true;
    instance.removingGrantIds = new Set();
    instance.renderInPlace = () => {
      renders += 1;
    };

    const loadA = instance.load();
    instance.resetForAccountChange();
    resolveList({
      businessSubscriptionId: 'sub-a',
      ownerDomain: 'a.example',
      ownerIsCorporateDomain: true,
      seats: [{ grantId: 'grant-a', inviteeEmail: 'secret@a.example' }],
    });
    await loadA;

    assert.deepEqual(instance.seats, []);
    assert.equal(instance.ownerDomain, null);
    assert.equal(instance.loading, false);
    assert.equal(renders, 1, 'only the B reset may render; A settlement stays inert');
  });
});
