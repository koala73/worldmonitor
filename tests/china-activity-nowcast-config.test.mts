import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('China activity nowcast production registration (#5579)', () => {
  it('registers the panel, loader, refresh cadence, command, and lazy chunk', () => {
    const panels = read('src/config/panels.ts');
    const base = read('src/config/variants/base.ts');
    const app = read('src/App.ts');
    const loader = read('src/app/data-loader.ts');
    const layout = read('src/app/panel-layout.ts');
    const commands = read('src/config/commands.ts');
    const vite = read('vite.config.ts');

    assert.match(panels, /'china-activity-nowcast': \{ name: 'China Activity Nowcast', enabled: true/);
    assert.match(panels, /'china-corridors', 'china-activity-nowcast'/);
    assert.match(base, /chinaActivityNowcast: 15 \* 60 \* 1000/);
    assert.match(app, /primeTask\('chinaActivityNowcast', \(\) => this\.dataLoader\.loadChinaActivityNowcast\(\)\)/);
    assert.match(app, /scheduleRefresh\('chinaActivityNowcast'/);
    assert.match(loader, /async loadChinaActivityNowcast\(\): Promise<void>/);
    assert.match(loader, /shouldLoad\('china-activity-nowcast'\)/);
    assert.match(layout, /lazyDefaultPanel\(\s*'china-activity-nowcast'/);
    assert.match(commands, /id: 'panel:china-activity-nowcast'/);
    assert.match(vite, /ChinaActivityNowcast: 'panels-economy'/);
  });

  it('registers the generated public RPC and a bounded gateway cache tier', () => {
    const proto = read('proto/worldmonitor/economic/v1/service.proto');
    const handler = read('server/worldmonitor/economic/v1/handler.ts');
    const gateway = read('server/gateway.ts');
    const client = read('src/generated/client/worldmonitor/economic/v1/service_client.ts');
    const server = read('src/generated/server/worldmonitor/economic/v1/service_server.ts');
    const openapi = read('docs/api/EconomicService.openapi.yaml');

    assert.match(proto, /rpc GetChinaActivityNowcast/);
    assert.match(handler, /getChinaActivityNowcast/);
    assert.match(gateway, /'\/api\/economic\/v1\/get-china-activity-nowcast': 'medium'/);
    assert.match(client, /async getChinaActivityNowcast/);
    assert.match(server, /handler\.getChinaActivityNowcast/);
    assert.match(openapi, /\/api\/economic\/v1\/get-china-activity-nowcast:/);
  });
});
