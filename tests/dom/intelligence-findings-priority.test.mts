import { afterEach, expect, it, vi } from 'vitest';
import { IntelligenceFindingsBadge } from '@/components/IntelligenceGapBadge';
import type { UnifiedAlert } from '@/services/cross-module-integration';
const source = vi.hoisted(() => ({ alerts: [] as UnifiedAlert[] }));
vi.mock('@/services/correlation', () => ({ getRecentSignals: () => [] }));
vi.mock('@/services/cross-module-integration', () => ({ getRecentAlerts: () => source.alerts }));
vi.mock('@/services/breaking-news-alerts', () => ({ getAlertSettings: () => ({enabled:false}), updateAlertSettings: vi.fn() }));
vi.mock('@/services/analytics', () => ({ trackFindingClicked: vi.fn() }));
vi.mock('@/services/i18n', () => ({ t: (key:string) => key }));
let badge: IntelligenceFindingsBadge;
afterEach(()=>{badge?.destroy();document.body.replaceChildren();localStorage.clear();});
it.each(['low','medium','high','critical'] as const)('keeps %s alert priority consistent in badge and dropdown',async priority=>{
 document.body.innerHTML='<div class="header-right"></div>';
 source.alerts=[{id:'fixture',type:'cii_spike',priority,title:'Fixture alert',summary:'Controlled severity',components:{},countries:[],timestamp:new Date()}];
 badge=new IntelligenceFindingsBadge();await badge.update();
 const high=priority==='high'||priority==='critical';
 expect(document.querySelector('.intel-findings-badge')?.classList.contains('status-high')).toBe(high);
 expect(document.querySelector('.findings-badge')?.classList.contains(priority==='critical'?'critical':high?'high':'moderate')).toBe(true);
});
