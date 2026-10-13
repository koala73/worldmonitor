import assert from 'node:assert/strict';
import { test } from '@playwright/test';
import { createChannelOAuthState, callbackMatchesBrowser } from '../server/_shared/channel-oauth-state.ts';
import bindHandler from '../api/channel-oauth-bind.ts';

const api = 'https://api.worldmonitor.app';
for (const provider of ['slack', 'discord']) {
  for (const origin of ['https://tech.worldmonitor.app', 'https://worldmonitor-git-review-eliewm.vercel.app']) {
    test(`${provider} binds a top-level popup from ${origin}`, async ({ browser }) => {
      const savedEnv = { url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN };
      const originalFetch = globalThis.fetch;
      process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
      process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
      try {
        const context = await browser.newContext();
        const store = new Map();
        let flow;
        let callbackMatches;
        let postedSecret = '';
        globalThis.fetch = async (url, init = {}) => {
          if (String(url).includes('/get/')) return Response.json({ result: store.get(decodeURIComponent(new URL(String(url)).pathname.slice(5))) ?? null });
          const [, , , key, value] = JSON.parse(String(init.body));
          const matches = store.get(key) === value;
          if (matches) store.delete(key);
          return Response.json({ result: matches ? 1 : 0 });
        };
        await context.route('**/*', async route => {
          const r = route.request();
          const u = new URL(r.url());
          if (u.pathname.endsWith('/oauth/start')) {
            const stateToken = 's'.repeat(27);
            const binding = await createChannelOAuthState(provider, new Request(r.url(), { method: 'POST', headers: await r.allHeaders() }), 'test-user');
            flow = JSON.parse(binding.record);
            const providerUrl = `${provider === 'slack' ? 'https://slack.com/oauth/v2/authorize' : 'https://discord.com/oauth2/authorize'}?state=${stateToken}`;
            store.set(`wm:${provider}:oauth:launch:${stateToken}`, JSON.stringify({ ...flow, oauthUrl: providerUrl }));
            await route.fulfill({ headers: {
              'Content-Type': 'application/json', 'Set-Cookie': binding.setCookie,
              'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true',
            }, body: JSON.stringify({ url: `${api}/api/channel-oauth-bind?provider=${provider}&state=${stateToken}`, token: binding.bindValue }) });
          } else if (u.pathname === '/api/channel-oauth-bind') {
            postedSecret = r.postData() ?? '';
            const response = await bindHandler(new Request(r.url(), { method: r.method(), headers: await r.allHeaders(), ...(r.postData() ? { body: r.postData() } : {}) }));
            await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
          } else if (u.hostname === `${provider}.com`) {
            assert.ok(!r.url().includes(new URLSearchParams(postedSecret).get('token')));
            await route.fulfill({ contentType: 'text/html', body: `<meta http-equiv="refresh" content="0;url=${api}/api/${provider}/oauth/callback">` });
          } else if (u.pathname.endsWith('/oauth/callback')) {
            callbackMatches = await callbackMatchesBrowser(provider, new Request(r.url(), { headers: await r.allHeaders() }), flow);
            await route.fulfill({ contentType: 'text/html', body: `<script>window.opener.postMessage({type:'connected'},${JSON.stringify(flow.openerOrigin)});</script><p>Connected</p>` });
          } else {
            await route.fulfill({ contentType: 'text/html', headers: { 'Content-Security-Policy': `default-src 'none'; connect-src ${api}; script-src 'unsafe-inline'; form-action 'self' ${api}` }, body: `<button id="connect">Connect</button><script>window.addEventListener('message',e=>{if(e.data.type==='connected')document.body.dataset.connected='true'});document.querySelector('button').onclick=async()=>{const popup=window.open('','oauth');const launch=await fetch('${api}/api/${provider}/oauth/start',{method:'POST',credentials:'include'}).then(r=>r.json());const f=popup.document.createElement('form');f.method='POST';f.action=launch.url;const input=popup.document.createElement('input');input.type='hidden';input.name='token';input.value=launch.token;f.append(input);popup.document.body.append(f);f.submit();};</script>` });
          }
        });
        const page = await context.newPage();
        await page.goto(origin);
        const popupEvent = page.waitForEvent('popup');
        await page.locator('#connect').click();
        const popup = await popupEvent;
        await popup.waitForURL('**/oauth/callback');
        await page.waitForFunction(() => document.body.dataset.connected === 'true');
        assert.equal(callbackMatches, true);
        assert.equal(flow.openerOrigin, origin);
        assert.equal(store.size, 0);
        await context.close();
      } finally {
        globalThis.fetch = originalFetch;
        if (savedEnv.url === undefined) delete process.env.UPSTASH_REDIS_REST_URL; else process.env.UPSTASH_REDIS_REST_URL = savedEnv.url;
        if (savedEnv.token === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN; else process.env.UPSTASH_REDIS_REST_TOKEN = savedEnv.token;
      }
    });
  }
}
