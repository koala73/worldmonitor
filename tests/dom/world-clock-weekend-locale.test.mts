import { afterEach, expect, it, vi } from 'vitest';
import { WorldClockPanel } from '@/components/WorldClockPanel';
const language=vi.hoisted(()=>({locale:'fr-FR'}));
vi.mock('@/services/i18n',()=>({t:(key:string)=>key,getLocale:()=>language.locale}));
let panel:WorldClockPanel;
afterEach(()=>{panel?.destroy();document.body.replaceChildren();localStorage.clear();vi.useRealTimers();});
it.each(['fr-FR','ar','ja-JP','th-TH'])('weekend closes market in %s on render and tick',locale=>{
 language.locale=locale;vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-19T14:00:00Z'));
 localStorage.setItem('worldmonitor-world-clock-cities',JSON.stringify(['new-york']));
 panel=new WorldClockPanel();document.body.append(panel.getElement());vi.advanceTimersByTime(150);
 const row=panel.getElement().querySelector('[data-city-id="new-york"]')!;
 expect(row.textContent).toContain('CLSD');
 vi.setSystemTime(new Date('2026-09-21T14:00:00Z'));vi.advanceTimersByTime(1000);expect(row.textContent).toContain('OPEN');
 vi.setSystemTime(new Date('2026-09-20T14:00:00Z'));vi.advanceTimersByTime(1000);expect(row.textContent).toContain('CLSD');
});
