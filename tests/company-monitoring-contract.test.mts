import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  COMPANY_MONITORING_CURSOR_VERSION,
  COMPANY_MONITORING_LIMITS,
  COMPANY_MONITORING_RPC_SCOPES,
  assertCompanyClaimBudget,
  assertCompanyMonitoringAccountContext,
  assertCompanyMonitoringPayloadSize,
  assertCoverageObservation,
  assertLifecycleTransition,
  assertLogicalId,
  assertOpaqueCursorShape,
  normalizeCompanyClaimInput,
  normalizeCompanyImportBatch,
  normalizeCompanyImportRow,
  normalizeCoverageFilters,
  normalizeImpactDirectionFilters,
  normalizeImpactLifecycleFilters,
  normalizeMonitoredCompanyLifecycleFilters,
  validateConfidenceAxes,
  validateCursorClaims,
  verifyOpaqueCursor,
} from '../shared/company-monitoring-contract.ts';
import { COMPANY_MONITORING_ROLLOUT_FLAGS } from '../convex/config/productCatalog.ts';
import {
  ENDPOINT_RATE_POLICIES,
  FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED,
} from '../server/_shared/rate-limit.ts';
import {
  GENERATED_MESSAGE_RULES,
  GENERATED_REQUEST_TYPES,
} from '../src/generated/server/request_validation.ts';

const root = resolve(import.meta.dirname, '..');

describe('Company Monitoring RPC contract', () => {
  it('keeps the self-contained Edge API-key scope mirror in contract parity', () => {
    const apiKeySource = readFileSync(resolve(root, 'api/_user-api-key.js'), 'utf8');
    const declaration = apiKeySource.match(
      /const COMPANY_MONITORING_SCOPES = new Set\(\[([^\]]+)]\);/,
    );
    assert.ok(declaration, 'Edge API-key scope mirror must remain a literal Set declaration');
    const edgeScopes = [...declaration[1]!.matchAll(/'([^']+)'/g)]
      .map((match) => match[1])
      .sort();
    const contractScopes = [...new Set(Object.values(COMPANY_MONITORING_RPC_SCOPES))].sort();
    assert.deepEqual(edgeScopes, contractScopes);
  });

  it('defines the exact ten account-scoped RPCs with independent read/write scopes', () => {
    assert.deepEqual(COMPANY_MONITORING_RPC_SCOPES, {
      CreateMonitoredCompany: 'company_monitoring:write',
      UpdateMonitoredCompany: 'company_monitoring:write',
      SetMonitoredCompanyState: 'company_monitoring:write',
      ImportMonitoredCompanyBatch: 'company_monitoring:write',
      ListMonitoredCompanies: 'company_monitoring:read',
      ListCompanyEventImpacts: 'company_monitoring:read',
      ListCompanyEventChanges: 'company_monitoring:read',
      GetCompanyMaterialEvent: 'company_monitoring:read',
      GetCompanyCoverage: 'company_monitoring:read',
      GetCompanyMonitoringStatus: 'company_monitoring:read',
    });

    const service = readFileSync(
      resolve(root, 'proto/worldmonitor/company_monitoring/v1/service.proto'),
      'utf8',
    );
    const rpcNames = [...service.matchAll(/\brpc\s+(\w+)\s*\(/g)].map((match) => match[1]);
    assert.deepEqual(rpcNames, Object.keys(COMPANY_MONITORING_RPC_SCOPES));
    assert.doesNotMatch(service, /\b(account_id|owner_account_id)\b/);

    const generatedCallbacks = rpcNames.map((rpc) => `${rpc[0].toLowerCase()}${rpc.slice(1)}`);
    const generatedServer = readFileSync(
      resolve(root, 'src/generated/server/worldmonitor/company_monitoring/v1/service_server.ts'),
      'utf8',
    );
    for (const callback of generatedCallbacks) {
      assert.match(
        generatedServer,
        new RegExp(`handler\\.${callback}\\(`),
        `${callback} must be recognized by the generated service router`,
      );
    }
    for (const callback of generatedCallbacks.filter((name) => name !== 'getCompanyMonitoringStatus')) {
      assert.match(
        GENERATED_REQUEST_TYPES[callback as keyof typeof GENERATED_REQUEST_TYPES] ?? '',
        /^worldmonitor\.company_monitoring\.v1\./,
        `${callback} must be recognized by the generated gateway request validator`,
      );
    }
  });

  it('keeps deferred product surfaces out of the service and generated OpenAPI', () => {
    const service = readFileSync(
      resolve(root, 'proto/worldmonitor/company_monitoring/v1/service.proto'),
      'utf8',
    );
    const openapi = JSON.parse(readFileSync(
      resolve(root, 'docs/api/CompanyMonitoringService.openapi.json'),
      'utf8',
    ));
    const schemaSurface = Object.entries(openapi.components?.schemas ?? {}).flatMap(
      ([schemaName, schema]) => [schemaName, ...Object.keys((schema as { properties?: object }).properties ?? {})],
    );
    const operationSurface = Object.entries(openapi.paths ?? {}).flatMap(([path, methods]) => [
      path,
      ...Object.values(methods as Record<string, { operationId?: string }>)
        .map((operation) => operation.operationId)
        .filter(Boolean),
    ]);
    const publicContract = `${service}\n${schemaSurface.join('\n')}\n${operationSurface.join('\n')}`;

    for (const deferred of [
      'mcp',
      'transfer',
      'feedback',
      'run_history',
      'revision_history',
      'historical_revision',
      'webhook',
    ]) {
      assert.doesNotMatch(publicContract, new RegExp(deferred, 'i'), deferred);
    }
  });
});

describe('Company Monitoring owner-fence environment contract', () => {
  it('documents fail-closed feature operations and the strict rotation sequence', () => {
    const envExample = readFileSync(resolve(root, '.env.example'), 'utf8');
    const block = envExample.match(
      /# REQUIRED before enabling Company Monitoring feature operations[\s\S]+?(?=\n# Dodo Payments business ID)/,
    )?.[0];
    assert.ok(block, 'owner-fence environment block must remain documented');
    const prose = block
      .replace(/^# ?/gm, '')
      .replace(/\s+/g, ' ');

    assert.match(
      prose,
      /REQUIRED.+Company Monitoring feature operations.+Convex deployment/i,
    );
    assert.match(
      prose,
      /Missing,.+blank,.+whitespace-padded,.+malformed.+fails closed/i,
    );
    assert.match(
      prose,
      /Company Monitoring provisioning.+terminal operations throw/i,
    );
    assert.match(
      prose,
      /Entitlement writes are independent and continue because they perform no Company Monitoring work/i,
    );
    assert.doesNotMatch(
      prose,
      /logged.+skips (?:account-root )?synchronization/i,
    );
    assert.match(prose, /independent secret-manager entries/i);

    assert.match(block, /^# COMPANY_MONITORING_OWNER_FENCE_PREVIOUS_SECRETS=$/m);
    assert.doesNotMatch(block, /^COMPANY_MONITORING_OWNER_FENCE_PREVIOUS_SECRETS=/m);
    assert.match(prose, /variable ABSENT, not blank, until the first rotation/i);
    assert.match(
      prose,
      /strict comma-separated secrets:.+no whitespace,.+blank entries,.+trailing comma,.+duplicate historical entries/i,
    );
    assert.match(prose, /current secret may appear once; append it only once/i);
    assert.match(
      prose,
      /pre-stage the old key.+deploy,.+verify it is discoverable/i,
    );
    assert.match(prose, /hide a deleted-owner tombstone.+allow a fresh entitled root/i);
    assert.match(prose, /ACCOUNT_OWNER_FENCE_CONFLICT.+manual data repair/i);
  });
});

describe('Company Monitoring limits and rollout controls', () => {
  it('publishes explicit bounded limits', () => {
    assert.deepEqual(COMPANY_MONITORING_LIMITS, {
      maxCompaniesPerAccount: 500,
      maxRequestBytes: 262_144,
      maxImportBatchBytes: 262_144,
      maxImportRows: 100,
      maxImportRowBytes: 8_192,
      maxClientImportIdBytes: 64,
      maxNameBytes: 256,
      maxCustomerReferenceBytes: 128,
      maxAliasBytes: 256,
      maxDomainBytes: 253,
      maxIdentifierBytes: 512,
      maxXHandleBytes: 15,
      maxXHandleInputBytes: 16,
      maxXAccountIdBytes: 32,
      maxLocationBytes: 256,
      maxAliases: 20,
      maxDomains: 10,
      maxIdentifiers: 20,
      maxXHandles: 5,
      maxLocations: 20,
      maxClaimsPerCompany: 81,
      maxEvidenceReferences: 20,
      maxPageSize: 100,
      maxCursorBytes: 2_048,
      maxCursorTtlMs: 86_400_000,
      maxCursorClockSkewMs: 60_000,
    });
  });

  it('keeps the hand-written limits equal to the proto-derived validator rules', () => {
    // The assertion above only proves the TS constant matches a copy of itself. These
    // helpers are what a future handler calls, while the wire is enforced by the
    // generated table — so widening a proto limit without updating the constant would
    // leave the normalizer rejecting requests the API accepts, with the suite green.
    // GENERATED_MESSAGE_RULES is regenerated from the proto on every `make generate`,
    // so it cannot drift independently.
    const rules = GENERATED_MESSAGE_RULES as Record<
      string,
      { fields: Record<string, { stringMaxBytes?: number; stringMinLen?: number; repeatedMaxItems?: number; numberLte?: number }> }
    >;
    const field = (message: string, name: string) => {
      const rule = rules[`worldmonitor.company_monitoring.v1.${message}`]?.fields?.[name];
      assert.ok(rule, `${message}.${name} missing from the generated validation table`);
      return rule;
    };

    const input = 'MonitoredCompanyInput';
    assert.equal(field(input, 'name').stringMaxBytes, COMPANY_MONITORING_LIMITS.maxNameBytes);
    assert.equal(field(input, 'customerReference').stringMaxBytes, COMPANY_MONITORING_LIMITS.maxCustomerReferenceBytes);
    assert.equal(field(input, 'aliases').stringMaxBytes, COMPANY_MONITORING_LIMITS.maxAliasBytes);
    assert.equal(field(input, 'aliases').repeatedMaxItems, COMPANY_MONITORING_LIMITS.maxAliases);
    assert.equal(field(input, 'domains').stringMaxBytes, COMPANY_MONITORING_LIMITS.maxDomainBytes);
    assert.equal(field(input, 'domains').repeatedMaxItems, COMPANY_MONITORING_LIMITS.maxDomains);
    assert.equal(field(input, 'identifiers').stringMaxBytes, COMPANY_MONITORING_LIMITS.maxIdentifierBytes);
    assert.equal(field(input, 'identifiers').repeatedMaxItems, COMPANY_MONITORING_LIMITS.maxIdentifiers);
    assert.equal(field(input, 'xHandles').stringMaxBytes, COMPANY_MONITORING_LIMITS.maxXHandleInputBytes);
    assert.equal(field(input, 'xHandles').repeatedMaxItems, COMPANY_MONITORING_LIMITS.maxXHandles);
    assert.equal(field(input, 'locations').stringMaxBytes, COMPANY_MONITORING_LIMITS.maxLocationBytes);
    assert.equal(field(input, 'locations').repeatedMaxItems, COMPANY_MONITORING_LIMITS.maxLocations);

    const batch = 'ImportMonitoredCompanyBatchRequest';
    assert.equal(field(batch, 'rows').repeatedMaxItems, COMPANY_MONITORING_LIMITS.maxImportRows);
    assert.equal(field(batch, 'clientImportId').stringMaxBytes, COMPANY_MONITORING_LIMITS.maxClientImportIdBytes);

    assert.equal(
      field('ListMonitoredCompaniesRequest', 'cursor').stringMaxBytes,
      COMPANY_MONITORING_LIMITS.maxCursorBytes,
    );
    assert.equal(
      field('ListMonitoredCompaniesRequest', 'pageSize').numberLte,
      COMPANY_MONITORING_LIMITS.maxPageSize,
    );
  });

  it('keeps the OpenAPI injector constants equal to the proto-derived validator rules', async () => {
    // The injector hand-copies each item constraint out of the .proto because
    // protoc-gen-openapiv3 emits them wrongly, and its own suite compares the generated
    // spec to those same literals — injector output against injector input. Anchor them
    // to GENERATED_MESSAGE_RULES, which IS regenerated from the proto every
    // `make generate`, so a proto edit the injector did not follow fails here.
    // (Lives in this .mts suite because the injector's own suite is plain .mjs and
    // cannot import the generated TypeScript.)
    const { COMPANY_MONITORING_OPENAPI_ITEM_CONTRACTS } = await import(
      '../scripts/openapi-inject-company-monitoring-contract.mjs'
    );
    const rules = GENERATED_MESSAGE_RULES as Record<
      string,
      { fields: Record<string, { stringPattern?: string; stringMinLen?: number; stringMaxBytes?: number }> }
    >;

    let checked = 0;
    for (const [schemaName, propertyName, contract] of COMPANY_MONITORING_OPENAPI_ITEM_CONTRACTS as Array<
      [string, string, Record<string, unknown>]
    >) {
      const rule = rules[`worldmonitor.company_monitoring.v1.${schemaName}`]?.fields?.[propertyName];
      if (!rule) continue; // query-only shapes are covered by the injector's own suite
      checked += 1;
      if (contract.pattern !== undefined) {
        assert.equal(contract.pattern, rule.stringPattern, `${schemaName}.${propertyName} pattern drifted from the proto`);
      }
      if (contract.minLength !== undefined) {
        assert.equal(contract.minLength, rule.stringMinLen, `${schemaName}.${propertyName} minLength drifted from the proto`);
      }
      if (contract['x-max-utf8-bytes'] !== undefined) {
        assert.equal(
          contract['x-max-utf8-bytes'],
          rule.stringMaxBytes,
          `${schemaName}.${propertyName} byte ceiling drifted from the proto`,
        );
      }
    }
    assert.ok(checked > 0, 'expected at least one injector contract to map onto a generated rule');
  });

  it('keeps the filter vocabularies identical between the normalizers and the published patterns', async () => {
    // The accepted-alias vocabulary is written twice: as *_BY_INPUT maps backing the
    // normalizers, and as a regex alternation in the OpenAPI injector. Nothing compared
    // them, so adding a value to the proto enum could leave the spec advertising a
    // filter the runtime rejects (or the runtime accepting one the spec never documents).
    // Expand the published pattern and require exact set equality with what the
    // normalizer actually accepts, in BOTH directions.
    const { COMPANY_MONITORING_OPENAPI_QUERY_ITEM_CONTRACTS } = await import(
      '../scripts/openapi-inject-company-monitoring-contract.mjs'
    );

    // `^(?:a|b|PREFIX_(?:X|Y))$` -> ['a', 'b', 'PREFIX_X', 'PREFIX_Y']
    const expand = (pattern: string): string[] => {
      const body = pattern.replace(/^\^\(\?:/, '').replace(/\)\$$/, '');
      const parts: string[] = [];
      let depth = 0;
      let current = '';
      for (let i = 0; i < body.length; i += 1) {
        const ch = body[i];
        if (ch === '(') depth += 1;
        if (ch === ')') depth -= 1;
        if (ch === '|' && depth === 0) { parts.push(current); current = ''; continue; }
        current += ch;
      }
      parts.push(current);
      return parts.flatMap((part) => {
        const nested = part.match(/^(.*)\(\?:(.*)\)$/);
        if (!nested) return [part];
        return nested[2].split('|').map((suffix) => `${nested[1]}${suffix}`);
      });
    };

    const normalizers: Record<string, (values: readonly string[]) => string[]> = {
      '/api/company-monitoring/v1/list-monitored-companies|lifecycle': normalizeMonitoredCompanyLifecycleFilters,
      '/api/company-monitoring/v1/list-monitored-companies|coverage': normalizeCoverageFilters,
      '/api/company-monitoring/v1/list-company-event-impacts|direction': normalizeImpactDirectionFilters,
      '/api/company-monitoring/v1/list-company-event-impacts|lifecycle': normalizeImpactLifecycleFilters,
    };

    let compared = 0;
    for (const [path, parameterName, contract] of COMPANY_MONITORING_OPENAPI_QUERY_ITEM_CONTRACTS as Array<
      [string, string, { pattern?: string }]
    >) {
      const normalize = normalizers[`${path}|${parameterName}`];
      if (!normalize || !contract.pattern) continue;
      compared += 1;

      const published = expand(contract.pattern);
      assert.ok(published.length >= 3, `${parameterName}: pattern expansion looks wrong (${published.length})`);

      // Every value the spec advertises must be accepted by the runtime normalizer.
      for (const value of published) {
        assert.doesNotThrow(
          () => normalize([value]),
          `${path} ${parameterName}: spec advertises "${value}" but the normalizer rejects it`,
        );
      }
      // And the normalizer must accept nothing the spec does not advertise.
      for (const value of ['definitely_not_a_state', 'ACTIVE', 'active ', '__proto__']) {
        if (published.includes(value)) continue;
        assert.throws(
          () => normalize([value]),
          `${path} ${parameterName}: normalizer accepts "${value}" which the published pattern rejects`,
        );
      }
    }
    assert.equal(compared, 4, 'expected all four filter vocabularies to be cross-checked');
  });

  it('keeps every provider and product surface independently dark', () => {
    assert.deepEqual(COMPANY_MONITORING_ROLLOUT_FLAGS, {
      exaProvider: false,
      xProvider: false,
      publication: false,
      restWrites: false,
      ui: false,
      alerts: false,
    });
  });

  it('pre-classifies every dark mutation route as fail-closed', () => {
    const expectedPolicies = {
      '/api/company-monitoring/v1/create-monitored-company': { limit: 30, window: '60 s' },
      '/api/company-monitoring/v1/update-monitored-company': { limit: 30, window: '60 s' },
      '/api/company-monitoring/v1/set-monitored-company-state': { limit: 30, window: '60 s' },
      '/api/company-monitoring/v1/import-monitored-company-batch': { limit: 10, window: '60 s' },
    };
    for (const [path, policy] of Object.entries(expectedPolicies)) {
      assert.deepEqual(ENDPOINT_RATE_POLICIES[path], policy);
      assert.ok(path in FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED);
    }
  });

  it('rejects oversized request bodies before parsing downstream content', () => {
    assert.doesNotThrow(() => assertCompanyMonitoringPayloadSize(262_144));
    assert.throws(
      () => assertCompanyMonitoringPayloadSize(262_145),
      /request exceeds 262144 bytes/,
    );
  });
});

describe('Company Monitoring import normalization', () => {
  it('normalizes the replay tuple before a fingerprint can be computed', () => {
    const normalized = normalizeCompanyImportRow({
      clientImportId: ' import-001 ',
      ordinal: 0,
      name: '  Example   Holdings  ',
      domicileCountry: 'us',
      aliases: [' Example Holdings ', 'Example  Holdings', 'EXAMPLE GROUP'],
      domains: ['WWW.Example.COM.', 'example.com'],
      identifiers: [' GB-123 ', 'GB-123'],
      xHandles: ['@ExampleCo', 'exampleco'],
      locations: [' London ', 'London'],
      customerReference: ' portfolio-7 ',
    });

    assert.deepEqual(normalized, {
      contractVersion: 'cm-import-v1',
      clientImportId: 'import-001',
      ordinal: 0,
      name: 'Example Holdings',
      domicileCountry: 'US',
      aliases: ['EXAMPLE GROUP', 'Example Holdings'],
      domains: ['example.com'],
      identifiers: ['GB-123'],
      xHandles: ['exampleco'],
      locations: ['London'],
      customerReference: 'portfolio-7',
    });

    assert.equal(normalizeCompanyImportRow({
      clientImportId: 'wire-enum',
      ordinal: 0,
      name: 'Wire Company',
      domicileCountry: 'DOMICILE_COUNTRY_GB',
    }).domicileCountry, 'GB');
  });

  it('rejects invalid domiciles, malformed claims, controls, ordinals, and row/list limits', () => {
    const valid = {
      clientImportId: 'import-001',
      ordinal: 0,
      name: 'Example Holdings',
      domicileCountry: 'US',
    } as const;

    assert.throws(
      () => normalizeCompanyImportRow({ ...valid, domicileCountry: 'CA' }),
      /domicileCountry must be US or GB/,
    );
    assert.throws(
      () => normalizeCompanyImportRow({ ...valid, name: 'Example\u0000Holdings' }),
      /control characters/,
    );
    for (const control of ['\u0085', '\u00ad', '\u200b', '\u202e']) {
      assert.throws(
        () => normalizeCompanyImportRow({ ...valid, name: `Example${control}Holdings` }),
        /control characters/,
      );
    }
    assert.throws(
      () => normalizeCompanyImportRow({ ...valid, domains: ['https://example.com/path'] }),
      /invalid domain/,
    );
    assert.throws(
      () => normalizeCompanyImportRow({ ...valid, xHandles: ['not-a-handle!'] }),
      /invalid X handle/,
    );
    assert.throws(
      () => normalizeCompanyImportRow({ ...valid, ordinal: 100 }),
      /ordinal must be between 0 and 99/,
    );
    assert.throws(
      () => normalizeCompanyImportRow({ ...valid, name: 'a'.repeat(257) }),
      /name exceeds 256 bytes/,
    );
    assert.throws(
      () => normalizeCompanyImportRow({ ...valid, aliases: Array.from({ length: 21 }, (_, i) => `A${i}`) }),
      /aliases exceeds 20 items/,
    );
  });

  it('enforces row count and encoded batch/row byte limits', () => {
    const rows = Array.from({ length: 101 }, (_, ordinal) => ({
      clientImportId: 'import-001',
      ordinal,
      name: `Company ${ordinal}`,
      domicileCountry: 'GB',
    }));
    assert.throws(() => normalizeCompanyImportBatch(rows), /batch exceeds 100 rows/);

    assert.throws(
      () => normalizeCompanyImportRow({
        clientImportId: 'import-001',
        ordinal: 0,
        name: 'Example Holdings',
        domicileCountry: 'GB',
        identifiers: Array.from({ length: 20 }, (_, index) => 'x'.repeat(430) + index),
      }),
      /row exceeds 8192 bytes/,
    );
  });

  it('requires one import identity and contiguous unique ordinals', () => {
    const row = {
      clientImportId: 'import-001',
      name: 'Example Holdings',
      domicileCountry: 'US',
    };
    assert.throws(
      () => normalizeCompanyImportBatch([
        { ...row, ordinal: 0 },
        { ...row, clientImportId: 'import-002', ordinal: 1 },
      ]),
      /share one clientImportId/,
    );
    assert.throws(
      () => normalizeCompanyImportBatch([{ ...row, ordinal: 0 }, { ...row, ordinal: 0 }]),
      /ordinals must be contiguous/,
    );
    assert.throws(
      () => normalizeCompanyImportBatch([{ ...row, ordinal: 0 }, { ...row, ordinal: 2 }]),
      /ordinals must be contiguous/,
    );
  });

  it('normalizes NFC before import dedupe and fingerprints', () => {
    const normalized = normalizeCompanyImportRow({
      clientImportId: 'unicode',
      ordinal: 0,
      name: 'Café Group',
      domicileCountry: 'US',
      aliases: ['Cafe\u0301 Group', 'Café Group'],
    });
    assert.deepEqual(normalized.aliases, ['Café Group']);
  });
});

describe('Company Monitoring identity, confidence, and lifecycle invariants', () => {
  it('requires server-derived account context and namespaced logical IDs', () => {
    assert.equal(
      assertCompanyMonitoringAccountContext({ ownerAccountId: 'account_internal_123' }),
      'account_internal_123',
    );
    assert.throws(() => assertCompanyMonitoringAccountContext(undefined), /account context is required/);
    assert.throws(
      () => assertCompanyMonitoringAccountContext({ ownerAccountId: '' }),
      /account context is required/,
    );

    assert.doesNotThrow(() => assertLogicalId('company', 'cm_company_01JNZB2Y7K4F6W8P9Q0R1S2T3V'));
    assert.doesNotThrow(() => assertLogicalId('event', 'cm_event_01JNZB2Y7K4F6W8P9Q0R1S2T3V'));
    assert.doesNotThrow(() => assertLogicalId('impact', 'cm_impact_01JNZB2Y7K4F6W8P9Q0R1S2T3V'));
    assert.doesNotThrow(() => assertLogicalId('evidence', 'cm_evidence_01JNZB2Y7K4F6W8P9Q0R1S2T3V'));
    assert.throws(() => assertLogicalId('company', 'jx7f9acb2f'), /invalid company logical ID/);
  });

  it('keeps the three confidence axes independent and overall equal to their minimum', () => {
    assert.deepEqual(
      validateConfidenceAxes({
        attribution: 0.99,
        occurrenceTruth: 0.91,
        materialImpact: 0.83,
        overall: 0.83,
      }),
      { attribution: 0.99, occurrenceTruth: 0.91, materialImpact: 0.83, overall: 0.83 },
    );
    assert.throws(
      () => validateConfidenceAxes({
        attribution: 1.01,
        occurrenceTruth: 0.9,
        materialImpact: 0.8,
        overall: 0.8,
      }),
      /attribution must be between 0 and 1/,
    );
    assert.throws(
      () => validateConfidenceAxes({
        attribution: 0.9,
        occurrenceTruth: 0.8,
        materialImpact: 0.7,
        overall: 0.8,
      }),
      /overall must equal the minimum confidence axis/,
    );
  });

  it('allows corrections and retractions but keeps terminal states terminal', () => {
    assert.doesNotThrow(() => assertLifecycleTransition('impact', 'admitted', 'corrected'));
    assert.doesNotThrow(() => assertLifecycleTransition('impact', 'corrected', 'retracted'));
    assert.throws(
      () => assertLifecycleTransition('impact', 'retracted', 'admitted'),
      /invalid lifecycle transition: retracted -> admitted/,
    );
    assert.throws(
      () => assertLifecycleTransition('company', 'removed', 'active'),
      /invalid lifecycle transition: removed -> active/,
    );
    assert.throws(
      () => assertLifecycleTransition('company', '__proto__', 'active'),
      /invalid company lifecycle state: __proto__/,
    );
  });

  it('treats a set to the current state as a no-op success, not an error', () => {
    // SetMonitoredCompanyState is a *set*: the natural caller is a reconciliation loop
    // ("ensure every company is active"), which would otherwise error on every
    // already-correct row. The published route carries an Idempotency-Key contract, but
    // a plain retry — or one past the 24h window — re-enters the state machine.
    assert.doesNotThrow(() => assertLifecycleTransition('company', 'active', 'active'));
    assert.doesNotThrow(() => assertLifecycleTransition('company', 'paused', 'paused'));
    assert.doesNotThrow(() => assertLifecycleTransition('company', 'removed', 'removed'));
  });

  it('validates against the named machine, never the union of both', () => {
    // 'active' is a company state and 'corrected' an impact state. Inferring the machine
    // from the from-state made cross-machine calls pass by accident whenever the two
    // vocabularies happened not to collide.
    assert.throws(
      () => assertLifecycleTransition('impact', 'active', 'paused'),
      /invalid impact lifecycle state: active/,
    );
    assert.throws(
      () => assertLifecycleTransition('company', 'corrected', 'retracted'),
      /invalid company lifecycle state: corrected/,
    );
  });

  it('rejects inherited keys in the claim and filter vocabularies', () => {
    // The suite's original hostile-key probe pointed at assertLifecycleTransition, which
    // is Map-backed and was already immune. These two lookups are plain object literals,
    // where a truthiness check accepted `__proto__`/`constructor` and returned a
    // non-string that silently violated the declared return type.
    for (const hostile of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      assert.throws(
        () => normalizeCompanyClaimInput({ type: hostile as never, value: 'anything' }),
        /company claim type is invalid/,
        `claim type ${hostile} must be rejected`,
      );
      assert.throws(
        () => normalizeMonitoredCompanyLifecycleFilters([hostile]),
        /lifecycles contains an unsupported value/,
        `lifecycle filter ${hostile} must be rejected`,
      );
      assert.throws(
        () => normalizeCoverageFilters([hostile]),
        /coverageStates contains an unsupported value/,
        `coverage filter ${hostile} must be rejected`,
      );
    }
  });

  it('normalizes typed claims and enforces the aggregate claim budget', () => {
    assert.deepEqual(
      normalizeCompanyClaimInput({ type: 'COMPANY_CLAIM_TYPE_DOMAIN', value: 'WWW.Example.COM.' }),
      { type: 'domain', value: 'example.com' },
    );
    assert.deepEqual(
      normalizeCompanyClaimInput({ type: 'x_handle', value: '@WorldMonitor' }),
      { type: 'x_handle', value: 'worldmonitor' },
    );
    assert.throws(
      () => normalizeCompanyClaimInput({ type: 'COMPANY_CLAIM_TYPE_UNSPECIFIED', value: 'x' }),
      /claim type is invalid/,
    );
    assert.throws(
      () => normalizeCompanyClaimInput({ type: 'domain', value: 'https://example.com' }),
      /invalid domain/,
    );
    assert.throws(
      () => normalizeCompanyClaimInput({ type: 'x_account_id', value: 'not-numeric' }),
      /invalid X account ID/,
    );
    assert.doesNotThrow(() => assertCompanyClaimBudget({
      currentCount: 75,
      addedCount: 6,
      removedCount: 0,
    }));
    assert.throws(
      () => assertCompanyClaimBudget({ currentCount: 81, addedCount: 1, removedCount: 0 }),
      /company claims exceed 81/,
    );
  });

  it('canonicalizes list filters before hashing them into cursors', () => {
    assert.deepEqual(
      normalizeMonitoredCompanyLifecycleFilters(['MONITORED_COMPANY_LIFECYCLE_PAUSED', 'active']),
      ['active', 'paused'],
    );
    assert.deepEqual(
      normalizeCoverageFilters(['COMPANY_COVERAGE_STATE_ADEQUATE', 'partial']),
      ['adequate', 'partial'],
    );
    assert.deepEqual(
      normalizeImpactLifecycleFilters(['MATERIAL_IMPACT_LIFECYCLE_RETRACTED']),
      ['retracted'],
    );
    assert.deepEqual(
      normalizeImpactDirectionFilters(['MATERIAL_IMPACT_DIRECTION_MIXED', 'positive']),
      ['mixed', 'positive'],
    );
    assert.throws(() => normalizeCoverageFilters(['Adequate']), /unsupported value/);
  });
});

describe('Company Monitoring coverage and cursor invariants', () => {
  it('never conflates incomplete coverage with a trustworthy quiet observation', () => {
    assert.doesNotThrow(() => assertCoverageObservation({
      coverage: 'adequate',
      observation: 'no_events_observed',
      providers: [
        { provider: 'exa', state: 'complete', capped: false, fresh: true },
        { provider: 'x', state: 'complete', capped: false, fresh: true },
      ],
      assessmentReady: true,
    }));
    assert.doesNotThrow(() => assertCoverageObservation({
      coverage: 'partial',
      observation: 'events_observed',
      providers: [{ provider: 'exa', state: 'partial', capped: true, fresh: true }],
      assessmentReady: false,
    }));
    assert.throws(
      () => assertCoverageObservation({
        coverage: 'partial',
        observation: 'no_events_observed',
        providers: [{ provider: 'exa', state: 'partial', capped: true, fresh: true }],
        assessmentReady: false,
      }),
      /no_events_observed requires adequate, complete, uncapped, fresh coverage/,
    );
    assert.throws(
      () => assertCoverageObservation({
        coverage: 'unknown_state',
        observation: 'unknown',
        providers: [],
        assessmentReady: false,
      } as never),
      /coverage state is invalid/,
    );
    assert.throws(
      () => assertCoverageObservation({
        coverage: 'adequate',
        observation: 'events_observed',
        providers: [{ provider: 'exa', state: 'complete', capped: false, fresh: true }],
        assessmentReady: true,
      }),
      /adequate coverage requires complete, uncapped, fresh provider assessment/,
    );
  });

  it('binds signed opaque cursors to version, account, filters, mode, expiry, and generation', () => {
    const claims = {
      version: COMPANY_MONITORING_CURSOR_VERSION,
      ownerAccountId: 'account_internal_123',
      filterHash: 'a'.repeat(64),
      surface: 'ListCompanyEventChanges' as const,
      mode: 'poll' as const,
      issuedAt: 1_800_000_000_000,
      expiresAt: 1_800_003_600_000,
      snapshotGeneration: 7,
      snapshotAsOf: '2026-08-05T00:00:00.000Z',
      watermark: '2026-08-05T00:00:00.000Z',
      changedAt: '2026-08-05T01:00:00.000Z',
      impactId: 'cm_impact_01JNZB2Y7K4F6W8P9Q0R1S2T3V',
    };
    const expected = {
      ownerAccountId: claims.ownerAccountId,
      filterHash: claims.filterHash,
      surface: claims.surface,
      mode: claims.mode,
      snapshotGeneration: claims.snapshotGeneration,
      nowMs: claims.issuedAt + 1,
    };
    assert.deepEqual(validateCursorClaims(claims, expected), claims);

    assert.throws(
      () => validateCursorClaims({ ...claims, version: 2 }, expected),
      /unsupported cursor version/,
    );
    assert.throws(
      () => validateCursorClaims({ ...claims, mode: 'history' } as never, expected),
      /unsupported cursor mode/,
    );
    assert.throws(
      () => validateCursorClaims({ ...claims, ownerAccountId: '' }, expected),
      /account context is required/,
    );
    assert.throws(
      () => validateCursorClaims({ ...claims, expiresAt: claims.issuedAt }, expected),
      /cursor expiry must follow issue time/,
    );
    assert.throws(
      () => validateCursorClaims(claims, { ...expected, nowMs: claims.expiresAt }),
      /cursor has expired/,
    );
    assert.throws(
      () => validateCursorClaims(claims, { ...expected, ownerAccountId: 'other_account' }),
      /cursor account binding does not match/,
    );
    assert.throws(
      () => validateCursorClaims(claims, { ...expected, filterHash: 'b'.repeat(64) }),
      /cursor filter binding does not match/,
    );
    assert.throws(
      () => validateCursorClaims(claims, { ...expected, surface: 'ListCompanyEventImpacts' }),
      /cursor surface binding does not match/,
    );
    assert.throws(
      () => validateCursorClaims(claims, { ...expected, mode: 'snapshot' }),
      /cursor mode binding does not match/,
    );
    assert.throws(
      () => validateCursorClaims(claims, { ...expected, snapshotGeneration: 8 }),
      /requires a new snapshot/,
    );
    assert.throws(
      () => validateCursorClaims({
        ...claims,
        expiresAt: claims.issuedAt + COMPANY_MONITORING_LIMITS.maxCursorTtlMs + 1,
      }, expected),
      /cursor lifetime exceeds/,
    );
    assert.throws(
      () => validateCursorClaims({ ...claims, changedAt: undefined }, expected),
      /changedAt and impactId must be present together/,
    );
  });

  it('requires a versioned payload plus a verified fixed-size signature', async () => {
    const token = `cmc1.${'a'.repeat(32)}.${'b'.repeat(43)}`;
    assert.equal(assertOpaqueCursorShape(token), token);
    assert.throws(() => assertOpaqueCursorShape(`cmc2.${'a'.repeat(32)}.${'b'.repeat(43)}`), /unsupported cursor envelope/);
    assert.throws(() => assertOpaqueCursorShape(`cmc1.${'a'.repeat(32)}.unsigned`), /signed opaque cursor/);

    const claims = {
      version: COMPANY_MONITORING_CURSOR_VERSION,
      ownerAccountId: 'account_internal_123',
      filterHash: 'a'.repeat(64),
      surface: 'ListCompanyEventChanges' as const,
      mode: 'poll' as const,
      issuedAt: 1_800_000_000_000,
      expiresAt: 1_800_003_600_000,
      snapshotGeneration: 7,
      snapshotAsOf: '2026-08-05T00:00:00.000Z',
      watermark: '2026-08-05T00:00:00.000Z',
    };
    const expected = {
      ownerAccountId: claims.ownerAccountId,
      filterHash: claims.filterHash,
      surface: claims.surface,
      mode: claims.mode,
      snapshotGeneration: claims.snapshotGeneration,
      nowMs: claims.issuedAt + 1,
    };
    assert.deepEqual(await verifyOpaqueCursor(token, {
      expected,
      verifySignature: (signedPayload, signature) => (
        signedPayload === `cmc1.${'a'.repeat(32)}` && signature === 'b'.repeat(43)
      ),
      decodePayload: () => claims,
    }), claims);
    await assert.rejects(
      verifyOpaqueCursor(token, {
        expected,
        verifySignature: () => false,
        decodePayload: () => claims,
      }),
      /cursor signature is invalid/,
    );
  });

  it('exposes a signed poll cursor rather than a mutable raw watermark', () => {
    const openapi = JSON.parse(readFileSync(
      resolve(root, 'docs/api/CompanyMonitoringService.openapi.json'),
      'utf8',
    ));
    const snapshot = openapi.components.schemas.SnapshotBoundary;
    assert.ok(snapshot.properties.pollCursor);
    assert.equal(snapshot.properties.pollingWatermark, undefined);
  });
});
