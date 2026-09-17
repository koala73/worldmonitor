import assert from 'node:assert/strict';
import { test, type Browser, type Page } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { buildPremiumPanelLifecycleBrowser } from '../tests/helpers/premium-panel-lifecycle-browser.mjs';

let browser: Browser;
let bundle: string;
test.beforeAll(async ({browser: suppliedBrowser}) => {
  bundle = await buildPremiumPanelLifecycleBrowser();
  browser = suppliedBrowser;
});


async function pageFixture(): Promise<Page> {
  const page = await browser.newPage({viewport:{width:1280,height:900}});
  // Serve an origin so production panel-storage can use localStorage.
  await page.route('http://panel.test/**', route => route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><meta charset="utf-8"></head><body><h1>Account lifecycle - controlled test identities</h1><main></main></body></html>`}));
  await page.goto('http://panel.test/');
  await page.addStyleTag({content: readFileSync('src/styles/main.css','utf8')});
  await page.addStyleTag({content: readFileSync('src/styles/panels.css','utf8')});
  await page.addStyleTag({content: 'body{background:#111827;color:#e5e7eb;font:14px Arial;margin:24px}main{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:20px}.panel{min-width:0;box-sizing:border-box;border:1px solid #556176;min-height:260px;padding:14px}.panel-content{min-height:220px}textarea,input{background:#1f2937;color:#fff}button{cursor:pointer}'});
  await page.addScriptTag({content:bundle});
  return page;
}

// Test-only fixture methods expose controlled boundary responses, not production state setters.
async function scope(page: Page, owner: string | null, access: boolean) {
  await page.evaluate(({owner,access}) => (window as any).fixture.scope(owner,access), {owner,access});
}
async function send(page: Page, text: string) {
  await page.locator('.chat-analyst-input').fill(text);
  await page.locator('[data-action="send"]').click();
}
async function finish(page: Page, index: number, text: string) {
  await page.evaluate(({index,text}) => (window as any).fixture.finish(index,text), {index,text});
  await page.waitForFunction(() => !(window as any).fixture.chat.isStreaming);
}

test('account switch clears private transcript/draft, preserves shared data and sends no A history', async () => {
  const page = await pageFixture();
  try {
    await send(page, 'Private A prompt');
    await finish(page, 0, 'Private A answer');
    await page.locator('.chat-analyst-input').fill('Private A draft');
    await page.locator('.deduction-input').fill('Private A deduction');
    await page.locator('.deduction-geo-input').fill('Private A location');
    await scope(page, 'test-A', true);
    assert.equal(await page.locator('.chat-analyst-input').inputValue(), 'Private A draft');
    assert.match(await page.locator('.chat-analyst-messages').innerText(), /Private A answer/);
    const evidence = process.env.PANEL_LIFECYCLE_EVIDENCE;
    if (evidence) { mkdirSync(evidence,{recursive:true}); await page.screenshot({path:`${evidence}/account-a.png`,fullPage:true}); }
    await scope(page, 'test-B', true);
    assert.equal(await page.locator('.chat-analyst-input').inputValue(), '');
    assert.equal(await page.locator('.deduction-input').inputValue(), '');
    assert.equal(await page.locator('.deduction-geo-input').inputValue(), '');
    assert.doesNotMatch(await page.locator('main').innerText(), /Private A/);
    assert.match(await page.locator('main').innerText(), /Shared market fixture/);
    if (evidence) await page.screenshot({path:`${evidence}/account-b.png`,fullPage:true});
    await send(page, 'B prompt');
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.requests[1].history), []);
    await finish(page,1,'B answer');
  } finally { await page.close(); }
});

test('revocation scrubs retained snapshot and regrant keeps constructor controls usable', async () => {
  const page = await pageFixture();
  try {
    await send(page,'A secret'); await finish(page,0,'A result');
    await page.locator('.deduction-input').fill('A hypothetical');
    await page.locator('.deduction-submit-btn').click();
    await page.evaluate(() => (window as any).fixture.deductions[0].resolve({analysis:'A deduction result'}));
    await page.waitForFunction(() => document.querySelector('.deduction-result')?.textContent?.includes('A deduction result'));
    await scope(page,'test-A',false);
    const evidence = process.env.PANEL_LIFECYCLE_EVIDENCE;
    if (evidence) await page.screenshot({path:`${evidence}/revoked.png`,fullPage:true});
    await scope(page,'test-A',true);
    assert.equal(await page.locator('.deduction-input').inputValue(),'');
    assert.equal(await page.locator('.deduction-result').innerText(),'');
    assert.doesNotMatch(await page.locator('.chat-analyst-messages').innerText(),/A secret|A result/);
    assert.match(await page.locator('main').innerText(),/Shared market fixture/);
    await send(page,'Fresh request');
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.requests[1].history),[]);
    await finish(page,1,'Fresh answer');
    await page.locator('.deduction-input').fill('Fresh deduction');
    await page.locator('.deduction-submit-btn').click();
    assert.equal(await page.evaluate(() => (window as any).fixture.deductions.length),2);
  } finally { await page.close(); }
});

test('late chat response cannot repopulate history or unlock a newer request', async () => {
  const page = await pageFixture();
  try {
    await send(page,'A pending');
    await scope(page,'test-B',true);
    assert.equal(await page.evaluate(() => (window as any).fixture.pending[0].signal.aborted),true);
    await send(page,'B pending');
    // The test transport deliberately ignores abort and resolves A late.
    await page.evaluate(() => (window as any).fixture.finish(0,'A late private answer'));
    await page.waitForTimeout(30);
    assert.equal(await page.locator('[data-action="send"]').isDisabled(),true);
    assert.doesNotMatch(await page.locator('main').innerText(),/A late/);
    await finish(page,1,'B answer');
    await send(page,'B follow-up');
    const history = await page.evaluate(() => (window as any).fixture.requests[2].history);
    assert.deepEqual(history,[{role:'user',content:'B pending'},{role:'assistant',content:'B answer'}]);
  } finally { await page.close(); }
});

test('late deduction reply after revoke/regrant cannot overwrite a new request', async () => {
  const page = await pageFixture();
  try {
    await page.locator('.deduction-input').fill('A pending deduction');
    await page.locator('.deduction-submit-btn').click();
    await scope(page,'test-A',false); await scope(page,'test-A',true);
    assert.equal(await page.evaluate(() => (window as any).fixture.deductions[0].signal.aborted),true);
    await page.locator('.deduction-input').fill('New deduction');
    await page.locator('.deduction-submit-btn').click();
    await page.evaluate(() => (window as any).fixture.deductions[0].resolve({analysis:'Old private result'}));
    await page.waitForTimeout(30);
    assert.doesNotMatch(await page.locator('.deduction-result').innerText(),/Old private/);
    assert.equal(await page.locator('.deduction-submit-btn').isDisabled(),true);
    await page.evaluate(() => (window as any).fixture.deductions[1].resolve({analysis:'New result'}));
    await page.waitForFunction(() => document.querySelector('.deduction-result')?.textContent?.includes('New result'));
    await scope(page,null,false); await scope(page,'test-B',true);
    assert.equal(await page.locator('.deduction-result').innerText(),'');
  } finally { await page.close(); }
});

test('a delayed stream chunk cannot execute A dashboard actions in B', async () => {
  const page = await pageFixture();
  try {
    await send(page,'A stream');
    await page.evaluate(() => {
      const f = (window as any).fixture;
      f.chat.setDashboardControlEnabled(true);
      f.chat.setDashboardActionHandler((action: unknown) => { f.actions.push(action); return {status:'applied'}; });
      f.pending[0].resolve(new Response(new ReadableStream({start(c) {f.stream=c;}})));
    });
    await page.waitForTimeout(30);
    await scope(page,'test-B',true);
    await page.evaluate(() => {
      const f=(window as any).fixture;
      f.stream.enqueue(new TextEncoder().encode('data: {"action":{"type":"open_panel","panelId":"forecast","label":"A action"}}\ndata: {"delta":"A stream secret"}\ndata: {"done":true}\n'));
    });
    await page.waitForTimeout(30);
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.actions),[]);
    assert.doesNotMatch(await page.locator('main').innerText(),/A stream secret/);
    await send(page,'B request');
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.requests[1].history),[]);
  } finally { await page.close(); }
});

test('layout binds account scope before lock or restore on every gating pass', () => {
  const source=readFileSync('src/app/panel-layout.ts','utf8');
  const body=source.slice(source.indexOf('  private updatePanelGating('),source.indexOf('  async renderLayout('));
  const binding=body.indexOf('.syncAccountScope(state.user?.id ?? null, reason === PanelGateReason.NONE)');
  assert.ok(binding >= 0);
  assert.ok(binding < body.indexOf('.unlockPanel()'));
  assert.ok(binding < body.indexOf('.showGatedCta(reason, onAction)'));
});


test('Brief clears old signed links and rejects an aborted reply after regrant', async () => {
  const page = await pageFixture();
  try {
    await page.waitForFunction(() => (window as any).fixture.briefs.length === 1);
    await page.evaluate(() => (window as any).fixture.briefs[0].resolve(Response.json({
      status:'ready', issueDate:'2026-09-16', dateLong:'September 16, 2026',
      greeting:'Private A brief', threadCount:1, magazineUrl:'https://example.test/private-a',
    })));
    await page.waitForFunction(() => document.querySelector('a[href="https://example.test/private-a"]'));
    await scope(page,'test-A',false);
    await scope(page,'test-A',true);
    assert.equal(await page.locator('a[href="https://example.test/private-a"]').count(),0);
    await page.waitForFunction(() => (window as any).fixture.briefs.length === 2);
    await scope(page,'test-A',false); await scope(page,'test-A',true);
    await page.evaluate(() => (window as any).fixture.briefs[1].resolve(Response.json({
      status:'ready', issueDate:'2026-09-16', dateLong:'September 16, 2026',
      greeting:'Stale revoked brief', threadCount:1, magazineUrl:'https://example.test/stale',
    })));
    await page.waitForFunction(() => (window as any).fixture.briefs.length === 3);
    assert.equal(await page.locator('a[href="https://example.test/stale"]').count(),0);
    await page.evaluate(() => (window as any).fixture.briefs[2].resolve(Response.json({
      status:'ready', issueDate:'2026-09-16', dateLong:'September 16, 2026',
      greeting:'Current A brief', threadCount:1, magazineUrl:'https://example.test/current-a',
    })));
    await page.waitForFunction(() => document.querySelector('a[href="https://example.test/current-a"]'));
    await scope(page,'test-B',true);
    assert.equal(await page.locator('a[href="https://example.test/current-a"]').count(),0);
  } finally { await page.close(); }
});
