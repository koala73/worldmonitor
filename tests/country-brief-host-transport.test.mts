import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createHostCountryFetch, CountrySectionError } from '../src/services/country-brief-host-transport';
import { IntelligenceServiceClient } from '../src/generated/client/worldmonitor/intelligence/v1/service_client';
import { ScorecardServiceClient } from '../src/generated/client/worldmonitor/scorecard/v1/service_client';
import { ResilienceServiceClient } from '../src/generated/client/worldmonitor/resilience/v1/service_client';
import { SupplyChainServiceClient } from '../src/generated/client/worldmonitor/supply_chain/v1/service_client';

it('uses generated country query names without passing browser credentials to the host', async () => {
  const calls: Array<{ name: string; args: any }> = [];
  const fetch = createHostCountryFetch(async (name, args: any) => {
    calls.push({ name, args });
    return { state: 'ready', section: args.section, value: { unavailable: true }, retrievedAt: '2026-10-01T00:00:00.000Z' };
  });
  const score = new ScorecardServiceClient('https://www.worldmonitor.app', { fetch, defaultHeaders: { Authorization: 'must-not-leave-frame' } });
  const resilience = new ResilienceServiceClient('https://www.worldmonitor.app', { fetch });
  const supply = new SupplyChainServiceClient('https://www.worldmonitor.app', { fetch });
  await score.getFiveFactorScorecard({ countryCode: 'US' });
  await resilience.getFoodStocks({ countryCode: 'WORLD', commodity: '' });
  await supply.getMultiSectorCostShock({ iso2: 'US', chokepointId: 'hormuz', closureDays: 30 });
  await supply.getBypassOptions({ chokepointId: 'hormuz', cargoType: 'container', closurePct: 100 });
  assert.deepEqual(calls.map(call => call.args), [
    { section: 'factors', arguments: { countryCode: 'US' } },
    { section: 'food', arguments: { countryCode: 'WORLD', commodity: '' } },
    { section: 'cost', arguments: { iso2: 'US', chokepointId: 'hormuz', closureDays: 30 } },
    { section: 'bypass', arguments: { chokepointId: 'hormuz', cargoType: 'container', closurePct: 100 } },
  ]);
  assert.ok(calls.every(call => call.name === 'get_country_brief_section'));
  assert.doesNotMatch(JSON.stringify(calls), /must-not-leave-frame|Authorization/);
});

it('rejects arbitrary routes, origins, parameters and methods before asking the host', async () => {
  let calls = 0;
  const fetch = createHostCountryFetch(async () => { calls++; return {}; });
  for (const url of [
    'https://attacker.example/api/intelligence/v1/get-country-facts?country_code=US',
    'https://www.worldmonitor.app/api/admin/delete',
    'https://www.worldmonitor.app/api/bootstrap?keys=privateAccounts',
    'https://www.worldmonitor.app/api/intelligence/v1/get-country-facts?country_code=US&url=https://attacker.example',
  ]) await assert.rejects(fetch(url));
  await assert.rejects(fetch('https://www.worldmonitor.app/api/intelligence/v1/get-country-facts?country_code=US', { method: 'POST' }));
  await assert.rejects(fetch(new Request('https://www.worldmonitor.app/api/intelligence/v1/get-country-facts?country_code=US', { method: 'POST' })));
  assert.equal(calls, 0);
});

it('preserves denial and rejects a section identity mismatch', async () => {
  const url = 'https://www.worldmonitor.app/api/intelligence/v1/get-country-facts?country_code=US';
  const denied = createHostCountryFetch(async () => ({ state: 'locked', section: 'facts', reason: 'Access denied' }));
  await assert.rejects(denied(url), (error: unknown) => error instanceof CountrySectionError && error.state === 'locked');
  const mixed = createHostCountryFetch(async () => ({ state: 'ready', section: 'energy', value: {}, retrievedAt: '2026-10-01T00:00:00.000Z' }));
  await assert.rejects(mixed(url), /identity mismatch/);
  const wrongCountry = createHostCountryFetch(async () => ({ state: 'ready', section: 'facts', value: { countryCode: 'JP' }, retrievedAt: '2026-10-01T00:00:00.000Z' }));
  await assert.rejects(wrongCountry(url), /Country identity mismatch/);
});

it('bounds active calls and removes aborted queued work without occupying a slot', async () => {
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const release: Array<() => void> = [];
  const fetch = createHostCountryFetch(async (_name, args: any) => {
    calls++; active++; maximum = Math.max(maximum, active);
    await new Promise<void>(resolve => release.push(resolve));
    active--;
    return { state: 'ready', section: args.section, value: {}, retrievedAt: '2026-10-01T00:00:00.000Z' };
  });
  const url = 'https://www.worldmonitor.app/api/intelligence/v1/get-country-facts?country_code=US';
  const first = [fetch(url), fetch(url), fetch(url)];
  const controller = new AbortController();
  const fourth = fetch(url, { signal: controller.signal });
  const cancelled = assert.rejects(fourth);
  const fifth = fetch(url);
  controller.abort();
  await cancelled;
  assert.equal(calls, 3);
  release.shift()!();
  await first[0];
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls, 4);
  while (release.length) release.shift()!();
  await Promise.all([...first, fifth]);
  assert.equal(maximum, 3);
});

it('retains a zero baseline omitted by generated query serialization', async () => {
  const calls: object[] = [];
  const fetch = createHostCountryFetch(async (_name, args: any) => {
    calls.push(args);
    return { state: 'ready', section: args.section, value: {}, retrievedAt: '2026-10-01T00:00:00.000Z' };
  });
  const client = new IntelligenceServiceClient('https://www.worldmonitor.app', { fetch });
  await client.computeEnergyShockScenario({ countryCode: 'US', chokepointId: 'hormuz_strait', disruptionPct: 0, fuelMode: 'gas' });
  assert.deepEqual(calls, [{ section: 'scenario', arguments: { country_code: 'US', chokepoint_id: 'hormuz_strait', disruption_pct: 0, fuel_mode: 'gas' } }]);
});
