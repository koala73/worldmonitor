import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openStoryModal, closeStoryModal } from '@/components/StoryModal';
import type { StoryData } from '@/services/story-data';
const pending = vi.hoisted(() => [] as Array<{resolve:(canvas: HTMLCanvasElement)=>void;reject:(e:Error)=>void}>);
vi.mock('@/services/story-renderer', () => ({ renderStoryToCanvas: () => new Promise((resolve,reject)=>pending.push({resolve,reject})) }));
vi.mock('@/services/i18n', () => ({ t: (key: string) => key }));
const data = (name:string): StoryData => ({countryCode:name,countryName:name,cii:null,news:[],theater:null,markets:[],threats:{critical:0,high:0,medium:0,categories:[]},signals:{protests:0,militaryFlights:0,militaryVessels:0,outages:0,gpsJammingHexes:0},convergence:null});
const canvas = () => ({toDataURL:()=> 'data:image/png;base64,aGk='}) as HTMLCanvasElement;
beforeEach(()=>{pending.length=0;vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{callback(0);return 1;});});
afterEach(()=>{closeStoryModal();vi.unstubAllGlobals();});
it('old render cannot replace the reopened story image',async()=>{
 openStoryModal(data('Old'));await vi.waitFor(()=>expect(pending).toHaveLength(1));
 closeStoryModal();openStoryModal(data('New'));await vi.waitFor(()=>expect(pending).toHaveLength(2));
 pending[1]!.resolve(canvas());await vi.waitFor(()=>expect(document.querySelector('img')?.alt).toBe('New Intelligence Story'));
 pending[0]!.resolve(canvas());await Promise.resolve();await Promise.resolve();
 expect(document.querySelector('img')?.alt).toBe('New Intelligence Story');
});
it('old failure cannot replace the reopened story content',async()=>{
 openStoryModal(data('Old'));await vi.waitFor(()=>expect(pending).toHaveLength(1));
 openStoryModal(data('New'));await vi.waitFor(()=>expect(pending).toHaveLength(2));
 pending[0]!.reject(new Error('old render'));await Promise.resolve();await Promise.resolve();
 expect(document.querySelector('.story-error')).toBeNull();
 pending[1]!.resolve(canvas());await vi.waitFor(()=>expect(document.querySelector('img')?.alt).toBe('New Intelligence Story'));
});
