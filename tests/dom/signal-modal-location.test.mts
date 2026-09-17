import { afterEach, expect, it, vi } from 'vitest';
import { SignalModal } from '@/components/SignalModal';
import { surgeAlertToSignal } from '../../shared/analysis-military-surge';
vi.mock('@/services/i18n',()=>({t:(key:string)=>key}));
afterEach(()=>{document.body.replaceChildren();});
it.each([[25,45],[0,45],[25,0]])('renders producer location %s,%s and sends it to map callback',(lat,lon)=>{
 const signal=surgeAlertToSignal({id:'fixture',theater:{id:'test',name:'Fixture theater',baseIds:[],centerLat:lat,centerLon:lon},type:'airlift',currentCount:6,baselineCount:2,surgeMultiple:3,aircraftTypes:new Map([['airlift',6]]),nearbyBases:[],firstDetected:new Date(),lastUpdated:new Date()});
 const modal=new SignalModal();const click=vi.fn();modal.setLocationClickHandler(click);modal.showSignal(signal);
 const button=document.querySelector<HTMLButtonElement>('.location-link');
 expect(button).not.toBeNull();expect(button?.textContent).toContain('Fixture theater');button!.click();
 expect(click).toHaveBeenCalledWith(lat,lon);modal.hide();
});
