import { expect, it, vi } from 'vitest';
import { TechEventsPanel } from '@/components/TechEventsPanel';
vi.mock('@/services/bootstrap',()=>({getHydratedData:()=>({events:[{id:'fixture',title:'Fixture conference',type:'conference',startDate:new Date(Date.now()+86400000).toISOString(),endDate:new Date(Date.now()+172800000).toISOString(),location:'Equator',coords:{lat:0,lng:45,virtual:false},url:'',description:''}],conferenceCount:1})}));
vi.mock('@/services/i18n',()=>({t:(key:string)=>key,getLocale:()=> 'en'}));
it('location button invokes the registered map action with zero latitude',()=>{
 const panel=new TechEventsPanel('events');document.body.append(panel.getElement());
 const onLocation=vi.fn();
 Object.assign(panel,{onLocationRequest:onLocation});
 const button=panel.getElement().querySelector<HTMLButtonElement>('.event-map-link');
 expect(button).not.toBeNull();button!.click();expect(onLocation).toHaveBeenCalledWith(0,45);
 panel.destroy();
});
