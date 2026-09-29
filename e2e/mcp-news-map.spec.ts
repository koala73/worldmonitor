import { test, expect } from '@playwright/test';
import { NEWS_INTELLIGENCE_APP_HTML } from '../api/mcp/ui/news-intelligence-app';
type HostCall = { id?: number; method?: string; params?: { url?: string } };
type FixtureWindow = Window & { calls: HostCall[] };

const payload = { cached_at: '2026-09-29T19:00:00Z', stale: false, data: { insights: { topStories: [
{ primaryTitle: 'Ports review shipping schedules as trade routes shift', primarySource: 'Example Wire', category: 'economy', countryCode: 'US', primaryLink: 'https://example.com/news', memberTitles: ['Port operators publish updated schedules'], sourceProvenance: { summary: 'Fixture source. No live provider request.' } },
{ primaryTitle: 'Energy ministers meet to discuss winter supply', primarySource: 'Example News', category: 'energy', countryCode: 'DE', primaryLink: 'https://example.com/energy', sourceProvenance: { summary: 'Fixture source. No live provider request.' } },
{ primaryTitle: 'New research partnership announced in Tokyo', primarySource: 'Example Science', category: 'science', countryCode: 'JP', primaryLink: 'https://example.com/science' }
] } } };
const host = `<html><body style="margin:0;background:#0b1220"><iframe title="WorldMonitor plugin" style="border:0;width:100%;height:900px" sandbox="allow-scripts"></iframe><script>
const frame=document.querySelector('iframe');const calls=[];window.calls=calls;
window.addEventListener('message',e=>{if(e.source!==frame.contentWindow)return;const m=e.data;calls.push(m);const send=o=>frame.contentWindow.postMessage({jsonrpc:'2.0',...o},'*');
if(m.method==='ui/initialize') send({id:m.id,result:{hostCapabilities:{serverTools:{},openLinks:{},updateModelContext:{text:{}}},hostContext:{theme:'dark'}}});
if(m.method==='ui/notifications/initialized') send({method:'ui/notifications/tool-result',params:{structuredContent:${JSON.stringify(payload)}}});
if(m.method==='tools/call')send({id:m.id,result:{isError:true,content:[{type:'text',text:'Fixture denial'}]}});
});frame.srcdoc=${JSON.stringify(NEWS_INTELLIGENCE_APP_HTML).replace(/</g,'\\u003c')};</script></body></html>`;
test('news and maps render inside a sandbox without form permission', async ({ page }, testInfo) => {
  await page.setViewportSize({width:1200,height:900});
  await page.setContent(host);
  const app=page.frameLocator('iframe');
  await app.locator('.story').first().waitFor();
  await expect(app.locator('.story')).toHaveCount(3);
  await page.screenshot({path:testInfo.outputPath('news-maps-desktop.png'),fullPage:true});
  await app.getByRole('button',{name:'Show country'}).first().click();
  if(!await app.locator('[data-country="US"]').evaluate(e=>e.classList.contains('selected')))throw new Error('Country focus failed');
  await app.getByRole('button',{name:'Details',exact:true}).first().click();
  await app.getByRole('button',{name:'Open source',exact:true}).click();
  await page.waitForFunction(()=> (window as unknown as FixtureWindow).calls.some((m: HostCall)=>m.method==='ui/open-link'));
  const calls=await page.evaluate(()=> (window as unknown as FixtureWindow).calls);
  if(calls.filter((m: HostCall)=>m.method==='tools/call').length!==0)throw new Error('Initial render refetched data');
  if(!calls.some((m: HostCall)=>m.method==='ui/open-link'&&m.params?.url==='https://example.com/news'))throw new Error('Source link failed');
  await app.getByRole('button',{name:'Close details'}).click();
  await app.getByLabel('Source',{exact:true}).fill('Example Wire');
  await app.getByRole('button',{name:'Apply filters'}).click();
  await app.getByRole('status').filter({hasText:'denied'}).waitFor();
  await expect(app.locator('.story')).toHaveCount(3);
  await page.setViewportSize({width:390,height:1000});
  await page.screenshot({path:testInfo.outputPath('news-maps-mobile.png'),fullPage:true});
});
