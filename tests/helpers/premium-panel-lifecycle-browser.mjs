import { build } from 'esbuild';
import { resolve } from 'node:path';

/** Real panel/DOM code with controlled identity, RPC and stream boundaries. */
export async function buildPremiumPanelLifecycleBrowser() {
  const stubs = new Map([
    ['services/i18n', `export const t = (key) => key;`],
    ['services/runtime', `export const isDesktopRuntime = () => false;`],
    ['services/tauri-bridge', `export const invokeTauri = async () => null;`],
    ['services/analytics', `export const trackPanelResized = () => {}; export const trackAnalystControlAction = () => {}; export const trackBriefThreadOpen = () => {};`],
    ['services/ai-flow-settings', `export const getAiFlowSettings = () => ({badgeAnimation: false});`],
    ['services/runtime-config', `export const getSecretState = () => ({present: true});`],
    ['services/panel-gating', `
      export const PanelGateReason = { NONE:'none', ANONYMOUS:'anonymous', FREE_TIER:'free_tier' };
      export const hasPremiumAccess = () => window.fixture.access;
      export const readClientEntitlementBelief = () => ({entitlementTier:1, authRole:'pro'});
    `],
    ['services/auth-state', `
      export const getAuthState = () => ({user: window.fixture.owner ? {id:window.fixture.owner,role:'pro'} : null,isPending:false});
      export const subscribeAuthState = (cb) => {window.fixture.authListeners.push(cb); cb(getAuthState()); return () => {};};
    `],
    ['services/clerk', `export const getClerkToken = async () => window.fixture.owner; export const clearClerkTokenCache = () => {};`],
    ['services/entitlements', `export const getEntitlementState = () => null;`],
    ['services/referral', `export const getReferralProfile = async () => null;`],
    ['services/premium-fetch', `export const premiumFetch = (...args) => window.fixture.fetch(...args);`],
    ['services/rpc-client', `export const createLazyClient = (factory) => factory; export const getRpcBaseUrl = () => '';`],
    ['services/generated-rpc-clients', `export class IntelligenceServiceClient { deductSituation(...args) { return window.fixture.deduct(...args); } }`],
    ['services/analysis-framework-store', `export const getActiveFrameworkForPanel = () => null;`],
    ['components/FrameworkSelector', `export class FrameworkSelector { el = document.createElement('div'); destroy() {} }`],
  ]);
  const result = await build({
    stdin: {
      contents: `
        import { ChatAnalystPanel } from './src/components/ChatAnalystPanel';
        import { DeductionPanel } from './src/components/DeductionPanel';
        import { Panel } from './src/components/Panel';
        import { LatestBriefPanel } from './src/components/LatestBriefPanel';
        window.fixture = {
          owner: 'test-A', access: true, authListeners: [], briefs: [], requests: [], pending: [], deductions: [], actions: [],
          fetch(url, init) {
            this.requests.push(JSON.parse(init.body));
            return new Promise(resolve => this.pending.push({resolve, signal:init.signal}));
          },
          deduct(request, options) { return new Promise(resolve => this.deductions.push({request, resolve, signal:options?.signal})); },
        };
        window.fetch = (url, init) => new Promise(resolve => window.fixture.briefs.push({resolve,signal:init.signal}));
        const brief = new LatestBriefPanel();
        const chat = new ChatAnalystPanel();
        const deduction = new DeductionPanel();
        const shared = new Panel({id:'shared-market',title:'Shared market control'});
        shared.getElement().querySelector('.panel-content').textContent = 'Shared market fixture';
        const panels = [chat, deduction, shared, brief];
        for (const panel of panels) { document.querySelector('main').append(panel.getElement()); panel.notifyConnected(); }
        Object.assign(window.fixture, { chat, deduction, shared, brief,
          scope(owner, access) {
            document.querySelector('h1').textContent = 'Controlled test identity: '+(owner ?? 'signed out')+' - '+(access ? 'access granted' : 'access revoked');
            const previousOwner = this.owner;
            this.owner = owner; this.access = access;
            if (owner !== previousOwner) for (const cb of this.authListeners) cb({user:owner ? {id:owner,role:'pro'} : null,isPending:false});
            for (const panel of panels) {
              panel.syncAccountScope(owner, access);
              if (access) panel.unlockPanel();
              else panel.showGatedCta(owner ? 'free_tier' : 'anonymous', () => {});
            }
          },
          finish(index, text) {
            this.pending[index].resolve(new Response('data: '+JSON.stringify({delta:text})+'\\n'+'data: {"done":true}\\n'));
          },
        });
        window.fixture.scope('test-A', true);
      `,
      resolveDir: resolve('.'),
      sourcefile: 'premium-panel-lifecycle-browser.ts',
      loader: 'ts',
    },
    bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022',
    define: { 'import.meta.env': '{}' },
    plugins: [{name:'controlled-boundaries', setup(api) {
      api.onResolve({filter:/.*/}, args => {
        const key = args.path.replace(/^@\//, '').replace(/^\.\.\//, '').replace(/^\.\//, 'components/');
        return stubs.has(key) ? {path:key,namespace:'fixture'} : null;
      });
      api.onLoad({filter:/.*/,namespace:'fixture'}, args => ({contents:stubs.get(args.path),loader:'js'}));
    }}],
  });
  return result.outputFiles[0].text;
}
