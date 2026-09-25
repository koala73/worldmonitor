import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { WIDGET_RESERVE_LUA } from '../api/_widget-quota.js';
import { quotaStore } from './widget-quota-fixture.mjs';
const source = readFileSync(
  new URL('../docker/redis-rest-proxy.mjs', import.meta.url),
  'utf8',
);
const command = [
  'EVAL',
  WIDGET_RESERVE_LUA,
  1,
  'widget:quota:v1',
  '2026-09-10',
  `user:${'a'.repeat(64)}`,
  'pro',
  'paid',
  100,
];
async function fixture() {
  const ledger = quotaStore(1000);
  let handler,
    sends = 0;
  const sendCommand = async (cmd) => {
    sends++;
    assert.equal(cmd[1], WIDGET_RESERVE_LUA);
    return ledger.run(cmd.slice(4));
  };
  const client = {
    on() {},
    async connect() {},
    sendCommand,
    multi() {
      const commands = [];
      return {
        addCommand(cmd) {
          commands.push(cmd);
        },
        exec: async () => Promise.all(commands.map(sendCommand)),
      };
    },
  };
  const code = source.replace(/^#!.*\n/, '').replace(/^import .*;\n/gm, '');
  const context = vm.createContext({
    process: { env: { SRH_TOKEN: 'synthetic-token' } },
    crypto,
    Buffer,
    URL,
    console: { log() {}, warn() {}, error() {} },
    createClient: () => client,
    http: {
      createServer(fn) {
        handler = fn;
        return { listen() {} };
      },
    },
  });
  await vm.runInContext(`(async()=>{${code}\n})()`, context);
  async function post(path, body) {
    const req = new EventEmitter();
    Object.assign(req, {
      method: 'POST',
      url: path,
      headers: { authorization: 'Bearer synthetic-token' },
      socket: { remoteAddress: 'fixture' },
    });
    const res = {
      status: 0,
      setHeader() {},
      writeHead(status) {
        this.status = status;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    const pending = handler(req, res);
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
    await pending;
    return res;
  }
  return { post, ledger, sends: () => sends };
}
test('canonical widget script executes through single and pipeline proxy handlers', async () => {
  for (const path of ['/', '/pipeline']) {
    const f = await fixture();
    const response = await f.post(path, path === '/' ? command : [command]);
    assert.equal(response.status, 200);
    assert.deepEqual(
      path === '/' ? response.body.result : response.body[0].result,
      [200, 0],
    );
    assert.equal(f.sends(), 1);
    assert.equal(f.ledger.store.get('spent'), '100');
  }
});
test('altered Lua, arbitrary EVAL, wrong keys/arguments, and standalone TIME never reach Redis', async () => {
  const bad = [['EVAL', 'return 1', 0], ['TIME'], [...command]];
  bad[2][1] += '\n';
  for (const [index, value] of [
    [2, 2],
    [3, 'other:key'],
    [4, 'unknown-tariff'],
    [5, 'globalLimit'],
    [6, 'enterprise'],
    [7, 'reset'],
    [8, -1],
    [8, 0],
    [8, 'NaN'],
  ]) {
    const copy = [...command];
    copy[index] = value;
    bad.push(copy);
  }
  for (const path of ['/', '/pipeline', '/multi-exec']) {
    const f = await fixture();
    for (const cmd of bad) {
      const response = await f.post(path, path === '/' ? cmd : [cmd]);
      assert.match(JSON.stringify(response.body), /Command not allowed/);
    }
    assert.equal(f.sends(), 0);
    assert.equal(f.ledger.store.get('spent'), '0');
  }
});
