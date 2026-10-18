import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { Window } from 'happy-dom';

const source = readFileSync(new URL('../src/plugin-country-main.ts', import.meta.url), 'utf8');
const downloadExports = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/utils/country-text-download.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports: downloadExports, TextEncoder });
const sectionErrors = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/services/country-brief-error.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports: sectionErrors });
const file = ts.createSourceFile('plugin-country-main.ts', source, ts.ScriptTarget.Latest, true);
const mount = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'mountPlugin');
assert.ok(mount?.body);
const functions = ['request', 'snapshot', 'scheduleContext', 'contextTarget', 'renderConnection', 'publishContext', 'clearDeniedRawSignals', 'open', 'start'];
const selected = mount.body.statements.filter(node => ts.isFunctionDeclaration(node) && functions.includes(node.name?.text));
for (const name of ['request', 'snapshot', 'scheduleContext']) assert.ok(selected.some(node => node.name.text === name));
const send = mount.body.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(file) === 'send'));
assert.ok(send);
const helpers = file.statements.slice(0, file.statements.indexOf(mount)).filter(node => !ts.isImportDeclaration(node) && !ts.isExpressionStatement(node)).map(node => node.getText(file));
const diagnosticNames = ['connection', 'contextGeneration', 'contextClosed', 'contextStatus', 'negotiationState', 'initialization'];
const diagnosticDeclarations = mount.body.statements.filter(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(item => diagnosticNames.includes(item.name.getText(file))));
const listener = mount.body.statements.find(node => ts.isExpressionStatement(node) && node.getText(file).startsWith("window.addEventListener('message'"));
const receiver = listener.expression.arguments[1].body.statements.slice(0, 3).map(node => node.getText(file)).join('\n');
const observer = mount.body.statements.filter(node => node.getText(file).startsWith('const mutation =') || node.getText(file).startsWith('mutation.observe(') || node.getText(file).startsWith('panel.onClose(') || node.getText(file).startsWith("window.addEventListener('pagehide'"));
const startupFailure = mount.body.statements.find(node => node.getText(file).startsWith('void start().catch')).expression.expression.arguments[0].getText(file);
const program = ts.transpileModule([...helpers, send.getText(file), ...diagnosticDeclarations.map(node => node.getText(file)), ...selected.map(node => node.getText(file)), ...observer.map(node => node.getText(file)), `this.api = { snapshot, scheduleContext, request, boundedChinaContext, start, open, receive(event) { ${receiver} }, startupFailure: ${startupFailure} };`].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const groups = [{"id":"macro","title":"Macro Signals","state":"PARTIAL","line":538,"signals":[{"label":"Industrial Value Added (YoY)","value":"5.2 %","observedAt":"2026-08","publishedAt":"2026-09-16T02:00:00.000Z","sourceAsCaptured":"National Bureau of Statistics of China · official government","sourceUrlAsCaptured":"stats.gov.cn/english/PressRelease/202609/t20260917_1965348.html"},{"label":"Fixed-Asset Investment (YoY)","value":"-7.2 %","observedAt":"2026-08","publishedAt":"2026-09-16T02:00:00.000Z","sourceAsCaptured":"National Bureau of Statistics of China · official government","sourceUrlAsCaptured":"stats.gov.cn/english/PressRelease/202609/t20260916_1965343.html"},{"label":"Real Estate Development Investment (YoY)","value":"-19.9 %","observedAt":"2026-08","publishedAt":"2026-09-16T02:00:00.000Z","sourceAsCaptured":"National Bureau of Statistics of China · official government","sourceUrlAsCaptured":"stats.gov.cn/english/PressRelease/202609/t20260916_1965342.html"},{"label":"Foreign-Exchange Reserves","value":"34383 USD 100 million","observedAt":"2026-08","publishedAt":"2026-09-07","sourceAsCaptured":"State Administration of Foreign Exchange · official government","sourceUrlAsCaptured":"safe.gov.cn/safe/2026/0907/27859.html"}],"reasonAsCaptured":"7 signals failed the launch/provenance boundary."},{"id":"policy-enforcement","title":"Policy & Enforcement","state":"PARTIAL","line":571,"signals":[{"label":"市场监管总局关于发布《国家统一推行自愿性认证制度管理办法（试行）》的公告","value":"SAMR · final_rule · unknown","publishedAt":"2026-09-30","translationState":"not translated","sourceAsCaptured":"State Administration for Market Regulation · official government","sourceUrlAsCaptured":"samr.gov.cn/zw/zfxxgk/fdzdgknr/rzjgs/art/2026/art_c739f36a509440eeb44dd56513f5aeef.html"},{"label":"商务部办公厅关于做好2027年度汽车和摩托车出口许可申报工作的通知","value":"MOFCOM · announcement_guidance · announced","publishedAt":"2026-09-30","translationState":"not translated","sourceAsCaptured":"Ministry of Commerce · official government","sourceUrlAsCaptured":"mofcom.gov.cn/zcfb/zc/art/2026/art_c7ac10d2deaa489dbf6346461785c65c.html"},{"label":"四部门关于开展2026年度享受增值税加计抵减政策的集成电路企业清单制定工作的通知","value":"MIIT · announcement_guidance · announced","publishedAt":"2026-09-30","translationState":"not translated","sourceAsCaptured":"Ministry of Industry and Information Technology · official government","sourceUrlAsCaptured":"miit.gov.cn/zwgk/zcwj/wjfb/tz/art/2026/art_7d2e760b4be94217b8f55caec840b30d.html"},{"label":"市场监管总局关于发布《饼干生产许可审查细则（2026版）》的公告","value":"SAMR · announcement_guidance · announced","publishedAt":"2026-09-29","effectiveAt":"2027-01-01","translationState":"not translated","sourceAsCaptured":"State Administration for Market Regulation · official government","sourceUrlAsCaptured":"samr.gov.cn/zw/zfxxgk/fdzdgknr/spscs/art/2026/art_b8afbb7e06e048aebb9f93f50737565f.html"}],"reasonAsCaptured":null},{"id":"cross-strait-activity","title":"Cross-Strait Activity","state":"AVAILABLE","line":604,"signals":[{"label":"taiwan-mnd activity","value":"plaAircraftSorties: 0 · planShips: 8 · officialShips: 8","observedAt":"2026-10-05T22:00:00.000Z","publishedAt":"2026-10-06","translationState":"not translated","sourceAsCaptured":"Taiwan Ministry of National Defense · official government","sourceUrlAsCaptured":"mnd.gov.tw/en/News/PLAAct/87922"},{"label":"taiwan-mnd activity","value":"plaAircraftSorties: 0 · planShips: 8 · officialShips: 9","observedAt":"2026-10-04T22:00:00.000Z","publishedAt":"2026-10-05","translationState":"not translated","sourceAsCaptured":"Taiwan Ministry of National Defense · official government","sourceUrlAsCaptured":"mnd.gov.tw/en/News/PLAAct/87913"},{"label":"taiwan-mnd activity","value":"plaAircraftSorties: 0 · planShips: 7 · officialShips: 8","observedAt":"2026-10-03T22:00:00.000Z","publishedAt":"2026-10-04","translationState":"not translated","sourceAsCaptured":"Taiwan Ministry of National Defense · official government","sourceUrlAsCaptured":"mnd.gov.tw/en/News/PLAAct/87905"},{"label":"taiwan-mnd activity","value":"plaAircraftSorties: 5 · planShips: 6 · officialShips: 7 · adizEntries: 2","observedAt":"2026-10-02T22:00:00.000Z","publishedAt":"2026-10-03","translationState":"not translated","sourceAsCaptured":"Taiwan Ministry of National Defense · official government","sourceUrlAsCaptured":"mnd.gov.tw/en/News/PLAAct/87903"}],"reasonAsCaptured":null},{"id":"corporate-disclosures","title":"Corporate Disclosures","state":"UNAVAILABLE","line":640,"signals":[],"reasonAsCaptured":"healthy_quiet_window: Healthy exchange queries contained no qualifying disclosure events."},{"id":"corridor-conditions","title":"Corridor Conditions","state":"PARTIAL","line":645,"signals":[{"label":"Yangtze River Delta · port","value":"partial","observedAt":"2026-09-30T00:02:51.316Z","effectiveAt":"2026-09-30T00:02:51.316Z","sourceAsCaptured":"WorldMonitor derived output · derived output"},{"label":"Yangtze River Delta · aviation","value":"available","observedAt":"2026-10-06T16:32:29.855Z","effectiveAt":"2026-10-06T16:32:29.855Z","sourceAsCaptured":"WorldMonitor derived output · derived output"},{"label":"Yangtze River Delta · hazard","value":"available","observedAt":"2026-10-06T16:32:04.270Z","effectiveAt":"2026-10-06T16:32:04.270Z","sourceAsCaptured":"WorldMonitor derived output · derived output"},{"label":"Yangtze River Delta · power_energy","value":"available","observedAt":"2026-05","effectiveAt":"2026-05","sourceAsCaptured":"WorldMonitor derived output · derived output"}],"reasonAsCaptured":null},{"id":"activity-nowcast","title":"Activity Nowcast","state":"AVAILABLE","line":669,"signals":[{"label":"Official activity versus independent proxies","value":"mixed_signals · medium confidence","observedAt":"2026-10-06T16:18:32.279Z","effectiveAt":"2026-10-06T16:18:32.279Z","sourceAsCaptured":"WorldMonitor China Activity Nowcast · derived output"}],"reasonAsCaptured":null}];
const ids = groups.map(group => group.id);
const windows = [];
afterEach(async () => { await Promise.all(windows.splice(0).map(win => win.happyDOM.close())); });

function harness({ country = 'CN', visible = true, capability = true } = {}) {
  const win = new Window({ url: 'https://worldmonitor.app/' });
  windows.push(win);
  const doc = win.document;
  const chrome = doc.createElement('main');
  chrome.id = 'countryRoot';
  chrome.innerHTML = '<form id="countryControls"><input name="country"></form><div id="countryStatus"></div><button id="deep-dive-close"></button>';
  doc.body.append(chrome);
  const root = doc.createElement('div');
  root.id = 'country-deep-dive-panel';
  root.innerHTML = '<div class="cdp-shell" data-brief-topic="all"><article data-brief-section="china" data-brief-coverage="partial"><h3>China Country Snapshot</h3><div class="cdp-card-body"><div class="cdp-china-summary-grid"></div></div></article></div>';
  doc.body.append(root);
  const grid = root.querySelector('.cdp-china-summary-grid');
  for (const group of groups) {
    const section = doc.createElement('section');
    section.className = 'cdp-china-summary-group cdp-china-summary-group--' + group.state.toLowerCase();
    section.dataset.groupId = group.id;
    const heading = doc.createElement('h4');
    heading.className = 'cdp-china-summary-title';
    heading.textContent = group.title;
    const label = doc.createElement('span');
    label.className = 'cdp-china-summary-state';
    label.textContent = group.state;
    section.append(heading, label);
    for (const signal of group.signals) {
      const item = doc.createElement('div');
      item.className = 'cdp-china-summary-signal';
      const name = doc.createElement('div');
      name.className = 'cdp-china-summary-signal-label';
      name.textContent = signal.label;
      item.append(name);
      for (const key of ['value', 'observedAt', 'publishedAt', 'effectiveAt', 'translationState']) {
        if (!signal[key]) continue;
        const field = doc.createElement('div');
        field.textContent = signal[key];
        item.append(field);
      }
      const anchor = doc.createElement('a');
      anchor.className = 'cdp-china-summary-source-link';
      anchor.setAttribute('href', 'https://' + signal.sourceUrlAsCaptured);
      anchor.textContent = signal.sourceAsCaptured;
      item.append(anchor);
      section.append(item);
    }
    if (group.reasonAsCaptured) {
      const reason = doc.createElement('div');
      reason.className = group.signals.length ? 'cdp-china-summary-note' : 'cdp-china-summary-empty';
      reason.textContent = group.reasonAsCaptured;
      section.append(reason);
    }
    grid.append(section);
  }
  const state = { country, visible, name: country === 'CN' ? 'China' : 'Germany', atlas: null };
  const messages = [];
  win.parent.postMessage = message => messages.push(message);
  const timers = new Map();
  let timerId = 0;
  const context = vm.createContext({
    window: win, document: doc, TextEncoder, URL, console, AbortController, crypto,
    MutationObserver: win.MutationObserver, ResizeObserver: class { observe() {} disconnect() {} },
    modelContextRoot: root, translate: key => key.split('.').at(-1),
    status: doc.getElementById('countryStatus'), input: doc.querySelector('input'),
    panel: { getCode: () => state.country, getName: () => state.name, isVisible: () => state.visible, getAtlasSelection: () => state.atlas, getSignalCounts: () => null, getQualifiedCountrySignals: () => null, clearQualifiedCountrySignals() {}, onClose: callback => { state.close = callback; }, hide: () => { state.visible = false; } },
    ready: true, toolsAvailable: false, linksAvailable: false, queuedView: undefined, openRequest: undefined,
    admissions: new Map(), assessments: new Map(), assessmentTimes: new Map(), coverages: new Map(),
    source: { clearLoadedData() {} }, controller: { dispose() {} }, timeline: undefined, signalSlots: undefined,
    countryViewSchema: { parse: value => value }, panelAdmissionSchema: { safeParse: () => ({ success: false }) },
    resolveCountryCode: value => value, getCountryNameByCode: value => value,
    call: () => new Promise(() => {}), initI18n: async () => {},
    admission: undefined, signalCoverage: null, revision: 7, modelContextRevision: 7, nextId: 123, pending: new Map(), modelContext: capability, contextTimer: undefined,
    CHINA_DECISION_SIGNAL_GROUP_IDS: ids,
    CHINA_DECISION_SIGNAL_GROUP_MANIFEST: ids.map(groupId => ({ groupId })),
    CHINA_DECISION_SIGNAL_MAX_ITEMS_PER_GROUP: 4,
    BRIEF_TOPICS: { all: 'All', overview: 'Overview' },
    COUNTRY_EXPORT_REQUEST_BYTES: 65536, CountryDownloadRequestError: Error,
    hostSupportsCountryDownload: downloadExports.hostSupportsCountryDownload,
    CountrySectionError: sectionErrors.CountrySectionError,
    briefSectionState: ({ body }) => body.querySelector('.cdp-pro-locked, [data-brief-state="locked"]') ? 'locked' : body.querySelector('.cdp-loading-inline') ? 'loading' : body.querySelector('[data-brief-state="unavailable"]') ? 'unavailable' : 'ready',
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay, requestId: delay === 30000 ? context.nextId - 1 : undefined }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(program, context);
  function publish() {
    const before = messages.length;
    context.api.scheduleContext();
    for (const [id, timer] of [...timers]) if (timer.delay === 200) { timers.delete(id); timer.fn(); }
    const message = messages.slice(before).findLast(item => item.method === 'ui/update-model-context');
    return message ? { message, snapshot: JSON.parse(message.params.content[0].text), bytes: new TextEncoder().encode(JSON.stringify(message)).length } : null;
  }
  const drain = async () => { await Promise.resolve(); await new Promise(resolve => setImmediate(resolve)); };
  const receive = (id, result = {}, error, sender = win.parent) => context.api.receive({ source: sender, data: { jsonrpc: '2.0', id, ...(error ? { error } : { result }) } });
  async function initialize(result = { protocolVersion: '2026-01-26', hostCapabilities: { downloadFile: {}, updateModelContext: {} } }) {
    const started = context.api.start();
    await drain();
    const message = messages.findLast(item => item.method === 'ui/initialize');
    receive(message.id, result);
    await started;
    return message;
  }
  const expire = id => { const timer = [...timers.entries()].find(([, item]) => item.delay === 30000 && item.requestId === id); assert.ok(timer, 'Existing request deadline'); timers.delete(timer[0]); timer[1].fn(); };
  return { win, doc, root, state, messages, context, publish, timers, drain, receive, initialize, expire, details: () => doc.getElementById('countryConnection'), teardown: () => win.dispatchEvent(new win.Event('pagehide')) };
}


const controlledSecurityBase = {
  countryCode: 'CN', countryName: 'China', revision: 7, topic: 'security',
  usage: { used: 2, limit: 50, remaining: 48 },
  sections: ['assessment', 'factors', 'facts', 'china', 'signals', 'timeline', 'news', 'military', 'sanctions', 'economic', 'housing', 'debt', 'flows', 'tariffs', 'trade', 'scenario', 'products', 'markets', 'energy', 'maritime', 'commodities', 'food', 'infrastructure', 'demographics'].map(section => {
    const visible = ['china', 'signals', 'timeline', 'news', 'military', 'sanctions', 'infrastructure'].includes(section);
    return { section, state: 'ready', visible, renderedText: `${section} controlled fixture text. `.repeat(100).slice(0, section === 'china' ? 2000 : visible ? 500 : 1300) };
  }),
};
const syntheticChinaGroups = [{"id":"macro","title":"Macro Signals","state":"partial","reason":"","renderedText":"Macro Signals\nPARTIAL\nSynthetic industrial activity\n3.1 %\nAs of: 2024-01\nPublished: 2024-02-16\nSource: Synthetic public observation\nSynthetic fixed investment\n-2.0 %\nAs of: 2024-01\nPublished: 2024-02-16\nSource: Synthetic public observation\nSynthetic property activity\n0.7 %\nAs of: 2024-01\nPublished: 2024-02-16\nSource: Synthetic public observation\nSynthetic reserves\n30000 USD 100 million\nAs of: 2024-01\nPublished: 2024-02-16\nSource: Synthetic public observation\n","links":[{"itemIndex":0,"itemLabel":"Synthetic industrial activity","label":"Synthetic public observation","url":"https://example.test/china/macro/1"},{"itemIndex":1,"itemLabel":"Synthetic fixed investment","label":"Synthetic public observation","url":"https://example.test/china/macro/2"},{"itemIndex":2,"itemLabel":"Synthetic property activity","label":"Synthetic public observation","url":"https://example.test/china/macro/3"},{"itemIndex":3,"itemLabel":"Synthetic reserves","label":"Synthetic public observation","url":"https://example.test/china/macro/4"}]},{"id":"policy-enforcement","title":"Policy & Enforcement","state":"partial","reason":"","renderedText":"Policy & Enforcement\nPARTIAL\n示例政策 1\nannouncement_guidance · unknown\nAs of: 2024-01\nPublished: 2024-02-16\nTranslation: not translated\nSource: Synthetic public observation\n示例政策 2\nannouncement_guidance · unknown\nAs of: 2024-01\nPublished: 2024-02-16\nTranslation: not translated\nSource: Synthetic public observation\n示例政策 3\nannouncement_guidance · unknown\nAs of: 2024-01\nPublished: 2024-02-16\nTranslation: not translated\nSource: Synthetic public observation\n示例政策 4\nannouncement_guidance · unknown\nAs of: 2024-01\nPublished: 2024-02-16\nTranslation: not translated\nSource: Synthetic public observation\n","links":[{"itemIndex":0,"itemLabel":"示例政策 1","label":"Synthetic public observation","url":"https://example.test/china/policy-enforcement/1"},{"itemIndex":1,"itemLabel":"示例政策 2","label":"Synthetic public observation","url":"https://example.test/china/policy-enforcement/2"},{"itemIndex":2,"itemLabel":"示例政策 3","label":"Synthetic public observation","url":"https://example.test/china/policy-enforcement/3"},{"itemIndex":3,"itemLabel":"示例政策 4","label":"Synthetic public observation","url":"https://example.test/china/policy-enforcement/4"}]},{"id":"cross-strait-activity","title":"Cross-Strait Activity","state":"available","reason":"","renderedText":"Cross-Strait Activity\nAVAILABLE\nSynthetic activity day 1\nplaAircraftSorties: 7 · planShips: 3\nAs of: 2024-01\nPublished: 2024-02-16\nTranslation: not translated\nSource: Synthetic public observation\nSynthetic activity day 2\nplaAircraftSorties: 0 · planShips: 3\nAs of: 2024-01\nPublished: 2024-02-16\nTranslation: not translated\nSource: Synthetic public observation\nSynthetic activity day 3\nplaAircraftSorties: 0 · planShips: 3\nAs of: 2024-01\nPublished: 2024-02-16\nTranslation: not translated\nSource: Synthetic public observation\nSynthetic activity day 4\nplaAircraftSorties: 0 · planShips: 3\nAs of: 2024-01\nPublished: 2024-02-16\nTranslation: not translated\nSource: Synthetic public observation\n","links":[{"itemIndex":0,"itemLabel":"Synthetic activity day 1","label":"Synthetic public observation","url":"https://example.test/china/cross-strait-activity/1"},{"itemIndex":1,"itemLabel":"Synthetic activity day 2","label":"Synthetic public observation","url":"https://example.test/china/cross-strait-activity/2"},{"itemIndex":2,"itemLabel":"Synthetic activity day 3","label":"Synthetic public observation","url":"https://example.test/china/cross-strait-activity/3"},{"itemIndex":3,"itemLabel":"Synthetic activity day 4","label":"Synthetic public observation","url":"https://example.test/china/cross-strait-activity/4"}]},{"id":"corporate-disclosures","title":"Corporate Disclosures","state":"unavailable","reason":"healthy_quiet_window: Healthy exchange queries contained no qualifying disclosure events.","renderedText":"","links":[]},{"id":"corridor-conditions","title":"Corridor Conditions","state":"partial","reason":"","renderedText":"Corridor Conditions\nPARTIAL\nSynthetic region · port\npartial\nAs of: 2024-01\nPublished: 2024-02-16\nEffective: 2024-02-16\nSource: Synthetic derived output\nSynthetic region · aviation\navailable\nAs of: 2024-01\nPublished: 2024-02-16\nEffective: 2024-02-16\nSource: Synthetic derived output\nSynthetic region · hazard\navailable\nAs of: 2024-01\nPublished: 2024-02-16\nEffective: 2024-02-16\nSource: Synthetic derived output\nSynthetic region · power_energy\navailable\nAs of: 2024-01\nPublished: 2024-02-16\nEffective: 2024-02-16\nSource: Synthetic derived output\n","links":[]},{"id":"activity-nowcast","title":"Activity Nowcast","state":"available","reason":"","renderedText":"Activity Nowcast\nAVAILABLE\nSynthetic official activity versus proxies\nmixed_signals · medium confidence\nAs of: 2024-01\nPublished: 2024-02-16\nEffective: 2024-02-16\nSource: Synthetic derived output\n","links":[]}];

function syntheticChinaView() {
  const view = harness();
  for (const captured of syntheticChinaGroups) {
    const node = view.root.querySelector(`[data-group-id="${captured.id}"]`);
    node.className = 'cdp-china-summary-group cdp-china-summary-group--' + captured.state;
    node.querySelector('.cdp-china-summary-state').textContent = captured.state;
    const reason = node.querySelector('.cdp-china-summary-note, .cdp-china-summary-empty');
    if (reason) reason.textContent = captured.reason;
    Object.defineProperty(node, 'innerText', { configurable: true, value: captured.renderedText });
    if (captured.links.length) {
      node.querySelectorAll('.cdp-china-summary-signal').forEach(item => item.remove());
      for (const link of captured.links) {
        const item = view.doc.createElement('div');
        item.className = 'cdp-china-summary-signal';
        const label = view.doc.createElement('div');
        label.className = 'cdp-china-summary-signal-label';
        label.textContent = link.itemLabel;
        const anchor = view.doc.createElement('a');
        anchor.className = 'cdp-china-summary-source-link';
        anchor.textContent = link.label;
        anchor.setAttribute('href', link.url);
        item.append(label, anchor);
        node.append(item);
      }
    } else {
      node.querySelectorAll('.cdp-china-summary-source-link').forEach(anchor => anchor.remove());
    }
  }
  return view;
}

test('inactive Security section text cannot crowd out the current China groups', () => {
  const view = syntheticChinaView();
  const base = structuredClone(controlledSecurityBase);
  const result = view.context.api.boundedChinaContext(base, view.root, 123);
  const bytes = new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 123, method: 'ui/update-model-context', params: { content: [{ type: 'text', text: JSON.stringify(result) }] } })).length;
  assert.ok(bytes <= 32768);
  for (const captured of syntheticChinaGroups) {
    const group = result.china.groups.find(item => item.id === captured.id);
    assert.equal(group.state, captured.state);
    assert.equal(group.reason, captured.reason);
    assert.equal(group.renderedText, captured.renderedText, captured.id + ': current rendered fields lost');
    assert.equal(group.renderedTruncated, false);
    assert.deepEqual(Array.from(group.links, link => link.url), captured.links.map(link => link.url));
    assert.equal(group.omittedItemCount, 0);
    assert.equal(group.omittedLinkCount, 0);
  }
  assert.equal(result.usage.remaining, 48);
  assert.equal(result.revision, controlledSecurityBase.revision);
  assert.equal(result.sections.length, controlledSecurityBase.sections.length);
  for (const section of result.sections) {
    const original = controlledSecurityBase.sections.find(item => item.section === section.section);
    assert.equal(section.state, original.state);
    assert.equal(section.visible, original.visible);
    if (original.visible) assert.equal(section.renderedText, original.renderedText);
    else if (section.renderedText !== original.renderedText) {
      assert.equal(section.renderedText, '');
      assert.equal(section.renderedTruncated, true);
      assert.ok(section.renderedOriginalCharacterCount >= original.renderedText.length);
    }
  }
});
test('inactive text eviction preserves older omission metadata and unspecified visibility', () => {
  const view = syntheticChinaView();
  const base = structuredClone(controlledSecurityBase);
  const commodities = base.sections.find(section => section.section === 'commodities');
  commodities.renderedOriginalCharacterCount = 9000;
  commodities.renderedTruncated = true;
  commodities.invalidUnicode = true;
  const empty = base.sections.find(section => section.section === 'energy');
  empty.renderedText = '';
  empty.renderedOriginalCharacterCount = 12000;
  empty.renderedTruncated = true;
  empty.invalidUnicode = true;
  const unspecified = base.sections.find(section => section.section === 'demographics');
  delete unspecified.visible;
  const expectedEmpty = { ...empty };
  const expectedUnspecified = { ...unspecified };
  const result = view.context.api.boundedChinaContext(base, view.root, 123);
  const actualCommodities = result.sections.find(section => section.section === 'commodities');
  assert.equal(actualCommodities.renderedText, '');
  assert.equal(actualCommodities.renderedOriginalCharacterCount, 9000);
  assert.equal(actualCommodities.renderedTruncated, true);
  assert.equal(actualCommodities.invalidUnicode, true);
  assert.equal(JSON.stringify(result.sections.find(section => section.section === 'energy')), JSON.stringify(expectedEmpty));
  assert.equal(JSON.stringify(result.sections.find(section => section.section === 'demographics')), JSON.stringify(expectedUnspecified));
});

test('fitting China context leaves inactive section text and metadata unchanged', () => {
  const view = syntheticChinaView();
  const base = structuredClone(controlledSecurityBase);
  base.sections = base.sections.filter(section => ['china', 'products', 'energy'].includes(section.section));
  const products = base.sections.find(section => section.section === 'products');
  products.renderedOriginalCharacterCount = 9000;
  products.renderedTruncated = true;
  products.invalidUnicode = true;
  const before = JSON.stringify(base.sections);
  const result = view.context.api.boundedChinaContext(base, view.root, 123);
  assert.equal(JSON.stringify(result.sections), before);
  assert.ok(result.china.groups.every(group => !group.renderedTruncated));
  assert.equal(result.china.groups.reduce((count, group) => count + group.links.length, 0), 12);
});

function commodityCard(view) {
  const card = view.doc.createElement('article');
  card.dataset.briefSection = 'commodities';
  card.dataset.briefCoverage = 'partial';
  card.innerHTML = '<h3>Commodity vulnerability</h3><div class="cdp-card-body"><p>' + 'Visible preceding content. '.repeat(100) + '</p></div>';
  view.root.querySelector('.cdp-shell').append(card);
  return card;
}

function commodityRow(view, card, { open = true, hidden = false, label = 'Barley' } = {}) {
  const row = view.doc.createElement('details');
  row.className = 'cdp-vulnerability-row';
  row.open = open;
  row.hidden = hidden;
  row.innerHTML = `<summary class="cdp-vulnerability-summary"><span class="cdp-vulnerability-commodity">${label}</span><span class="cdp-vulnerability-state">Current</span><span class="cdp-vulnerability-score">90.1</span></summary><div class="cdp-vulnerability-components"><div class="cdp-vulnerability-component"><span class="cdp-vulnerability-component-label">Concentration</span><strong class="cdp-vulnerability-component-value">99%</strong><span class="cdp-vulnerability-component-detail">import mirror only</span></div><div class="cdp-vulnerability-component"><span class="cdp-vulnerability-component-label">Transit</span><strong class="cdp-vulnerability-component-value">85%</strong><span class="cdp-vulnerability-component-detail">Taiwan Strait, Panama Canal</span></div><div class="cdp-vulnerability-component"><span class="cdp-vulnerability-component-label">Buffer</span><strong class="cdp-vulnerability-component-value">71%</strong><span class="cdp-vulnerability-component-detail">known</span></div></div><div class="cdp-vulnerability-reasons">transit_status_uncovered · source_import_mirror_only</div><div class="cdp-vulnerability-sources"><a class="cdp-vulnerability-source" href="https://example.com/concentration">Concentration source</a><a class="cdp-vulnerability-source" href="https://example.com/transit">Transit source</a><a class="cdp-vulnerability-source" href="https://example.com/buffer">Buffer source</a></div>`;
  card.querySelector('.cdp-card-body').append(row);
  return row;
}

test('open commodity details retain individual displayed components beyond the legacy prefix', () => {
  const view = harness({ country: 'CA' });
  const card = commodityCard(view);
  commodityRow(view, card);
  const result = view.publish();
  const details = result.snapshot.openCommodityDetails;
  assert.ok(details, 'Current open commodity details must be attached');
  assert.equal(details.countryCode, 'CA');
  assert.equal(details.revision, 7);
  assert.equal(details.totalOpenRowCount, 1);
  assert.equal(details.rows[0].commodity, 'Barley');
  assert.equal(details.rows[0].scoreText, '90.1');
  assert.equal(details.rows[0].stateText, 'Current');
  assert.deepEqual(details.rows[0].components.map(item => [item.componentIndex, item.label, item.valueText, item.detailText]), [[0, 'Concentration', '99%', 'import mirror only'], [1, 'Transit', '85%', 'Taiwan Strait, Panama Canal'], [2, 'Buffer', '71%', 'known']]);
  assert.equal(details.rows[0].caveatsText, 'transit_status_uncovered · source_import_mirror_only');
  assert.deepEqual(details.rows[0].sourceLinks.map(item => [item.sourceIndex, item.label, item.url]), [[0, 'Concentration source', 'https://example.com/concentration'], [1, 'Transit source', 'https://example.com/transit'], [2, 'Buffer source', 'https://example.com/buffer']]);
  const legacy = result.snapshot.sections.find(item => item.section === 'commodities').renderedText;
  assert.equal(legacy.length, 2000);
  assert.equal(legacy.includes('import mirror only'), false);
});

test('commodity DOM ordinals survive closed and hidden rows, sources and components', () => {
  const view = harness({ country: 'CA' });
  const card = commodityCard(view);
  Object.defineProperty(card, 'innerText', { get: () => 'Legacy prefix' });
  commodityRow(view, card, { open: false, label: 'Closed' });
  const first = commodityRow(view, card);
  commodityRow(view, card, { hidden: true, label: 'Hidden' });
  commodityRow(view, card, { label: 'Wheat' });
  const hiddenSource = first.querySelectorAll('a')[1];
  hiddenSource.hidden = true;
  Object.defineProperty(hiddenSource, 'innerText', { configurable: true, get() { throw new Error('Hidden source text read'); } });
  const originalAttribute = hiddenSource.getAttribute.bind(hiddenSource);
  hiddenSource.getAttribute = name => { if (name === 'href') throw new Error('Hidden source URL read'); return originalAttribute(name); };
  const hiddenComponent = first.querySelectorAll('.cdp-vulnerability-component')[1];
  hiddenComponent.hidden = true;
  Object.defineProperty(hiddenComponent, 'innerText', { get() { throw new Error('Hidden component read'); } });
  const extraComponent = hiddenComponent.cloneNode(true);
  extraComponent.hidden = false;
  first.querySelector('.cdp-vulnerability-components').append(extraComponent);
  for (let index = 3; index < 5; index++) {
    const anchor = view.doc.createElement('a');
    anchor.className = 'cdp-vulnerability-source';
    anchor.href = index === 3 ? 'javascript:bad()' : 'https://example.com/fifth';
    anchor.textContent = 'Source ' + index;
    first.querySelector('.cdp-vulnerability-sources').append(anchor);
  }
  const details = view.publish().snapshot.openCommodityDetails;
  assert.equal(details.totalOpenRowCount, 2);
  assert.equal(details.omittedRowCount, 0);
  assert.deepEqual(details.rows.map(row => row.rowIndex), [1, 3]);
  const row = details.rows[0];
  assert.deepEqual(row.sourceLinks.map(link => link.sourceIndex), [0, 1, 2, 3]);
  assert.deepEqual(row.sourceLinks[1], { sourceIndex: 1, omittedReason: 'hidden' });
  assert.equal(row.sourceLinks[3].urlOmittedReason, 'invalid-url');
  assert.equal(row.sourceLinks[3].url, undefined);
  assert.equal(row.totalSourceCount, 5);
  assert.equal(row.omittedSourceCount, 1);
  assert.deepEqual(row.sourceLinks.filter(link => typeof link.url === 'string').map(link => new URL(link.url).href), ['https://example.com/concentration', 'https://example.com/buffer']);
  assert.deepEqual(row.components[1], { componentIndex: 1, omittedReason: 'hidden' });
  assert.equal(row.components[2].valueText, '71%');
  assert.equal(row.omittedComponentCount, 1);
  hiddenSource.hidden = false;
  hiddenSource.getAttribute = originalAttribute;
  Object.defineProperty(hiddenSource, 'innerText', { configurable: true, value: 'Invalid source' });
  hiddenSource.setAttribute('href', 'javascript:bad()');
  const invalidGap = view.publish().snapshot.openCommodityDetails.rows[0].sourceLinks;
  assert.deepEqual(invalidGap.map(link => link.sourceIndex), [0, 1, 2, 3]);
  assert.equal(invalidGap[1].label, 'Invalid source');
  assert.equal(invalidGap[1].urlOmittedReason, 'invalid-url');
  assert.equal(invalidGap[2].url, 'https://example.com/buffer');
});

test('close, panel/card gates and disconnected current root remove commodity projection', () => {
  for (const mode of ['close', 'panel', 'hidden', 'css', 'summary', 'locked', 'loading', 'unavailable', 'detached', 'pending-revision']) {
    const view = harness({ country: 'CA' });
    const card = commodityCard(view);
    const row = commodityRow(view, card);
    assert.ok(view.publish().snapshot.openCommodityDetails);
    if (mode === 'close') row.open = false;
    if (mode === 'panel') view.state.visible = false;
    if (mode === 'pending-revision') view.context.revision++;
    if (mode === 'hidden') card.hidden = true;
    if (mode === 'css') card.style.display = 'none';
    if (mode === 'summary') row.querySelector('summary').hidden = true;
    if (['locked', 'loading', 'unavailable'].includes(mode)) {
      const gate = view.doc.createElement('div');
      if (mode === 'locked') gate.className = 'cdp-pro-locked';
      if (mode === 'loading') gate.className = 'cdp-loading-inline';
      if (mode === 'unavailable') gate.dataset.briefState = 'unavailable';
      card.querySelector('.cdp-card-body').append(gate);
    }
    if (mode === 'detached') { const historical = view.root.cloneNode(true); view.root.remove(); view.doc.body.append(historical); }
    assert.equal(view.publish().snapshot.openCommodityDetails, undefined, mode);
  }
  const disabled = harness({ country: 'CA', capability: false });
  commodityRow(disabled, commodityCard(disabled));
  assert.equal(disabled.publish(), null);
});

test('commodity literal zero/unknown and valid URL identities survive Unicode and whole-URL omissions', () => {
  const view = harness({ country: 'CA' });
  const row = commodityRow(view, commodityCard(view));
  const values = row.querySelectorAll('.cdp-vulnerability-component-value');
  values[0].textContent = '0%';
  values[1].textContent = 'unknown';
  row.querySelector('.cdp-vulnerability-commodity').textContent = '中😀"\\\n'.repeat(200);
  const sources = row.querySelectorAll('a');
  sources[0].href = 'https://example.com/' + '中😀'.repeat(1000);
  sources[1].setAttribute('href', 'https://example.com/\uD800');
  sources[2].setAttribute('href', 'https://example.com/space path');
  const details = view.publish().snapshot.openCommodityDetails;
  assert.equal(details.rows[0].components[0].valueText, '0%');
  assert.equal(details.rows[0].components[1].valueText, 'unknown');
  assert.ok(details.rows[0].commodityTruncated);
  assert.ok(new TextEncoder().encode(JSON.stringify(details.rows[0].commodity)).length <= 256);
  assert.equal(details.rows[0].commodityInvalidUnicode, false);
  assert.deepEqual(details.rows[0].sourceLinks.map(source => source.urlOmittedReason), ['url-size', 'invalidUnicode', 'invalid-url']);
  assert.ok(details.rows[0].sourceLinks.every(source => source.url === undefined));
});

test('commodity packing reserves row/source ordinals and bounds the added actual outer RPC', () => {
  for (const country of ['CA', 'CN']) {
    const view = harness({ country });
    const card = commodityCard(view);
    for (let index = 0; index < 12; index++) {
      const row = commodityRow(view, card, { label: '中😀"\\\n'.repeat(60) });
      for (const detail of row.querySelectorAll('.cdp-vulnerability-component-detail, .cdp-vulnerability-reasons')) detail.textContent = '中😀"\\\n'.repeat(3000);
    }
    const result = view.publish();
    const details = result.snapshot.openCommodityDetails;
    assert.equal(details.totalOpenRowCount, 12);
    assert.equal(details.omittedRowCount, 2);
    const without = structuredClone(result.message);
    const base = JSON.parse(without.params.content[0].text);
    delete base.openCommodityDetails;
    without.params.content[0].text = JSON.stringify(base);
    const delta = result.bytes - new TextEncoder().encode(JSON.stringify(without)).length;
    assert.ok(delta <= 8192, country + ': added bytes ' + delta);
    if (details.state === 'not-supplied') assert.deepEqual(details.rows, []);
    else {
      assert.deepEqual(details.rows.map(row => row.rowIndex), Array.from({ length: 10 }, (_, index) => index));
      for (const row of details.rows) assert.deepEqual(row.sourceLinks.map(source => source.sourceIndex), [0, 1, 2]);
    }
    if (country === 'CN') { assert.ok(result.bytes <= 32768); assert.deepEqual(result.snapshot.china.groups.map(group => group.id), ids); }
  }
});

test('attached China context keeps all six current groups beyond the old 2000-character card prefix', () => {
  const view = harness();
  const result = view.publish();
  assert.equal(result.message.method, 'ui/update-model-context');
  assert.equal(result.message.id, 123);
  assert.equal(result.snapshot.sections[0].renderedText.length, 2000);
  assert.deepEqual(result.snapshot.china?.groups.map(group => group.id), ids, 'Expected all six China group identities in the attached context');
  assert.ok(result.bytes <= 32768);
  for (const expected of groups) {
    const actual = result.snapshot.china.groups.find(group => group.id === expected.id);
    assert.equal(actual.reason, expected.reasonAsCaptured ?? '');
    assert.equal(actual.state, expected.state.toLowerCase());
    for (const signal of expected.signals) for (const key of ['label', 'value', 'observedAt', 'publishedAt', 'effectiveAt', 'translationState']) if (signal[key]) assert.ok(actual.renderedText.includes(signal[key]), expected.id + ': missing ' + key);
    assert.deepEqual(actual.links.map(link => [link.itemIndex, link.url]), expected.signals.map((signal, itemIndex) => [itemIndex, 'https://' + signal.sourceUrlAsCaptured]));
  }
  const corridor = result.snapshot.china.groups.find(group => group.id === 'corridor-conditions');
  assert.ok(corridor.renderedText.includes('2026-10-06T16:32:29.855Z'));
  assert.ok(corridor.renderedText.includes('2026-10-06T16:32:04.270Z'));
  assert.equal(corridor.renderedText.includes('2026-10-03T22:00:00.000Z'), false);
});

test('closed, non-CN and capability-disabled views cannot publish retained China groups', () => {
  const view = harness();
  assert.equal(view.publish().snapshot.china.groups.length, 6);
  view.state.country = 'DE';
  assert.equal(view.publish().snapshot.china, undefined);
  view.state.country = 'CN';
  view.state.visible = false;
  assert.equal(view.publish().snapshot.china, undefined);
  const disabled = harness({ capability: false });
  assert.equal(disabled.publish(), null);
});

test('hidden and locked cards retain six descriptors with no stale content or links', () => {
  for (const mode of ['hidden', 'locked', 'loading']) {
    const view = harness();
    const card = view.root.querySelector('[data-brief-section="china"]');
    if (mode === 'hidden') card.hidden = true;
    else { const gate = view.doc.createElement('div'); gate.className = mode === 'locked' ? 'cdp-pro-locked' : 'cdp-loading-inline'; card.querySelector('.cdp-card-body').append(gate); }
    const result = view.publish();
    assert.deepEqual(result.snapshot.china.groups.map(group => group.id), ids);
    assert.ok(result.snapshot.china.groups.every(group => !group.renderedText && !group.links.length));
    assert.equal(JSON.stringify(result.snapshot).includes('Industrial Value Added'), false, 'The legacy China card excerpt must not leak content through a hidden/locked/loading gate');
  }
});

test('duplicate, missing and foreign groups do not supply arbitrary old content', () => {
  const view = harness();
  const grid = view.root.querySelector('.cdp-china-summary-grid');
  grid.append(grid.firstElementChild.cloneNode(true));
  grid.querySelector('[data-group-id="activity-nowcast"]').remove();
  const foreign = view.doc.createElement('section');
  foreign.className = 'cdp-china-summary-group';
  foreign.dataset.groupId = 'foreign';
  foreign.textContent = 'NOT CURRENT EVIDENCE';
  grid.append(foreign);
  const result = view.publish().snapshot.china;
  assert.equal(result.groups.find(group => group.id === 'macro').state, 'not-supplied');
  assert.equal(result.groups.find(group => group.id === 'activity-nowcast').state, 'not-supplied');
  assert.equal(result.unexpectedGroupCount, 1);
  assert.equal(JSON.stringify(result).includes('NOT CURRENT EVIDENCE'), false);
});

test('oversized Unicode and URLs keep six descriptors, complete links, and a bounded actual envelope', () => {
  const view = harness();
  for (const section of view.root.querySelectorAll('.cdp-china-summary-group')) {
    const text = view.doc.createElement('div');
    text.textContent = ('中😀"\\\n').repeat(3000);
    section.append(text);
  }
  const anchor = view.root.querySelector('.cdp-china-summary-source-link');
  anchor.setAttribute('href', 'https://example.test/' + '中'.repeat(4000));
  view.state.name = 'x'.repeat(60000);
  view.state.atlas = { content: 'x'.repeat(60000) };
  const first = view.publish();
  assert.ok(first.bytes <= 32768, 'Actual nested JSON-RPC envelope must fit the local limit');
  assert.deepEqual(first.snapshot.china.groups.map(group => group.id), ids);
  const oversizedLink = first.snapshot.china.groups[0].links[0];
  assert.equal(oversizedLink.url, undefined);
  assert.equal(oversizedLink.urlOmittedReason, 'url-size');
  assert.ok(oversizedLink.urlOriginalByteCount > 2048);
  assert.equal(JSON.stringify(first.snapshot).includes('\\ud83d"'), false);
  const second = view.publish();
  assert.deepEqual(second.snapshot, first.snapshot);
});

test('source associations stay inside the current root and retain their original item ordinal', () => {
  const view = harness();
  const historical = view.root.querySelector('[data-brief-section="china"]').cloneNode(true);
  historical.querySelector('.cdp-china-summary-signal-label').textContent = 'HISTORICAL OUTSIDE ROOT';
  view.doc.body.append(historical);
  const item = view.root.querySelector('.cdp-china-summary-signal');
  const extra = view.doc.createElement('a');
  extra.className = 'cdp-china-summary-source-link';
  extra.href = 'https://example.test/second-anchor';
  extra.textContent = 'SECOND SOURCE';
  item.append(extra);
  const fifth = item.cloneNode(true);
  fifth.querySelector('.cdp-china-summary-signal-label').textContent = 'OMITTED FIFTH SIGNAL';
  fifth.querySelector('.cdp-china-summary-source-link').href = 'https://example.test/fifth-source';
  item.parentElement.append(fifth);
  const result = view.publish().snapshot;
  assert.equal(JSON.stringify(result.china).includes('HISTORICAL OUTSIDE ROOT'), false);
  assert.equal(JSON.stringify(result.china).includes('second-anchor'), false);
  assert.equal(JSON.stringify(result).includes('OMITTED FIFTH SIGNAL'), false);
  assert.equal(JSON.stringify(result).includes('fifth-source'), false);
  const macro = result.china.groups.find(group => group.id === 'macro');
  assert.deepEqual(macro.links.map(link => link.itemIndex), [0, 1, 2, 3]);
  assert.ok(macro.omittedAnchorCount >= 1);
  assert.equal(macro.omittedItemCount, 1);
});

test('invalid and loading group states and detached roots cannot expose retained China text', () => {
  for (const mode of ['invalid', 'loading', 'detached']) {
    const view = harness();
    const macro = view.root.querySelector('[data-group-id="macro"]');
    if (mode === 'detached') {
      const historical = view.root.cloneNode(true);
      view.doc.body.append(historical);
      view.root.remove();
    } else {
      macro.className = 'cdp-china-summary-group cdp-china-summary-group--' + (mode === 'invalid' ? 'bogus' : mode);
      macro.querySelector('.cdp-china-summary-state').textContent = mode;
    }
    const result = view.publish().snapshot;
    assert.equal(JSON.stringify(result).includes('Industrial Value Added'), false);
    assert.equal(result.china.groups[0].renderedText, '');
    assert.deepEqual(result.china.groups[0].links, []);
  }
});

test('ill-formed Unicode is explicitly omitted and valid scalar boundaries remain intact', () => {
  const view = harness();
  const policy = view.root.querySelector('[data-group-id="policy-enforcement"]');
  policy.querySelector('.cdp-china-summary-signal-label').textContent = 'bad\uD800';
  const anchor = policy.querySelector('.cdp-china-summary-source-link');
  anchor.setAttribute('href', 'https://example.test/bad\uDC00');
  const cross = view.root.querySelector('[data-group-id="cross-strait-activity"]');
  cross.append(view.doc.createTextNode('a'.repeat(1999) + '😀'));
  const result = view.publish();
  assert.ok(result.bytes <= 32768);
  assert.match(JSON.stringify(result.snapshot), /invalidUnicode/);
  function scalarStrings(value) {
    if (typeof value === 'string') {
      for (let index = 0; index < value.length; index++) {
        const unit = value.charCodeAt(index);
        if (unit >= 0xD800 && unit <= 0xDBFF) {
          const next = value.charCodeAt(++index);
          assert.ok(next >= 0xDC00 && next <= 0xDFFF, 'No lone high surrogate in sent context');
        } else assert.ok(unit < 0xDC00 || unit > 0xDFFF, 'No lone low surrogate in sent context');
      }
    } else if (Array.isArray(value)) value.forEach(scalarStrings);
    else if (value && typeof value === 'object') Object.values(value).forEach(scalarStrings);
  }
  scalarStrings(result.snapshot);
});

test('the final request guard rejects an oversized actual CN context envelope before postMessage', async () => {
  const view = harness();
  const before = view.messages.length;
  await assert.rejects(view.context.api.request('ui/update-model-context', { content: [{ type: 'text', text: JSON.stringify({ countryCode: 'CN', china: { groups: [] }, hostile: '中'.repeat(40000) }) }] }), error => error.kind === 'local-limit');
  assert.equal(view.messages.length, before);
});

test('commodity complete caveats respect the exact added RPC boundary without a later source URL', () => {
  const view = harness({ country: 'CA' });
  const row = commodityRow(view, commodityCard(view));
  row.querySelector('.cdp-vulnerability-sources').replaceChildren();
  row.querySelector('.cdp-vulnerability-reasons').textContent = 'a'.repeat(6255);
  const result = view.publish();
  const details = result.snapshot.openCommodityDetails.rows[0];
  const without = structuredClone(result.message);
  const base = JSON.parse(without.params.content[0].text);
  delete base.openCommodityDetails;
  without.params.content[0].text = JSON.stringify(base);
  const addedBytes = result.bytes - new TextEncoder().encode(JSON.stringify(without)).length;
  assert.ok(addedBytes <= 8192, 'Actual added RPC bytes ' + addedBytes);
  assert.equal(details.sourceLinks.length, 0);
  assert.equal(details.caveatsTextOriginalByteCount, 6257);
  assert.equal(details.caveatsText.length, 6254);
  assert.equal(details.caveatsTextTruncated, true);
});

test('connection disclosure reports only negotiated public fields and the unchanged download guard', async () => {
  const values = [
    { protocolVersion: '2026-01-26', hostCapabilities: { downloadFile: {}, updateModelContext: {} } },
    { protocolVersion: '2025-11-21', hostCapabilities: { downloadFile: {} } },
    { protocolVersion: '<private-protocol>', hostCapabilities: { downloadFile: true } },
    { hostCapabilities: {} }, { protocolVersion: '2026-01-26' },
    { protocolVersion: '2026-01-26', hostCapabilities: null },
    ...[null, [], true, 'yes'].map(downloadFile => ({ protocolVersion: '2026-01-26', hostCapabilities: { downloadFile } })),
  ];
  for (const initialized of values) {
    const view = harness();
    assert.match(view.details()?.textContent ?? '', /negotiation pending/i);
    await view.initialize({ ...initialized, secret: 'PRIVATE_INIT_SENTINEL' });
    const text = view.details().textContent;
    assert.match(text, downloadExports.hostSupportsCountryDownload(initialized) ? /Download request allowed/ : /Download request unavailable/);
    if (initialized.protocolVersion === '2025-11-21') assert.match(text, /2025-11-21/);
    if (!('protocolVersion' in initialized)) assert.match(text, /protocol not supplied/i);
    if (initialized.protocolVersion === '<private-protocol>') assert.match(text, /protocol malformed/i);
    assert.equal(/PRIVATE_INIT_SENTINEL|private-protocol/.test(text), false);
    assert.equal(view.root.contains(view.details()), false);
    assert.equal(view.messages.filter(item => item.method === 'ui/download-file').length, 0);
  }
});

test('context diagnostics distinguish waiting, ACK, RPC rejection, timeout and malformed result', async () => {
  for (const outcome of ['ack', 'rpc', 'timeout', 'malformed']) {
    const view = harness();
    await view.initialize();
    view.root.querySelector('.cdp-shell').dataset.briefTopic = 'resources';
    await view.drain();
    const sent = view.publish().message;
    assert.match(view.details().textContent, /CN.*resources.*revision 7.*waiting/i);
    if (outcome === 'rpc') view.receive(sent.id, undefined, { code: -32000, message: 'PRIVATE_ERROR_SENTINEL' });
    else if (outcome === 'timeout') view.expire(sent.id);
    else view.receive(sent.id, outcome === 'malformed' ? null : { privateField: 'PRIVATE_RESULT_SENTINEL' });
    await view.drain();
    assert.match(view.details().textContent, outcome === 'ack' ? /Host acknowledged.*Model use is not confirmed/ : outcome === 'rpc' ? /Host rejected/ : outcome === 'timeout' ? /within 30 seconds/ : /unconfirmed/i);
    assert.equal(/PRIVATE_ERROR_SENTINEL|PRIVATE_RESULT_SENTINEL/.test(view.details().textContent), false);
    assert.equal(view.context.pending.size, 0);
    assert.equal(view.messages.filter(item => item.method === 'ui/update-model-context').length, 1);
  }
});

test('failed negotiation and malformed initialization remain distinct from an absent capability', async () => {
  for (const result of [null, [], true, 'private']) {
    const view = harness();
    const started = view.context.api.start().catch(view.context.api.startupFailure);
    await view.drain();
    view.receive(view.messages.find(item => item.method === 'ui/initialize').id, result);
    await started;
    assert.match(view.details().textContent, /protocol malformed/i);
    assert.match(view.details().textContent, /Host capabilities malformed/);
    assert.equal(view.details().textContent.includes('private'), false);
  }
  const view = harness();
  const started = view.context.api.start().catch(view.context.api.startupFailure);
  await view.drain();
  view.expire(view.messages.find(item => item.method === 'ui/initialize').id);
  await started;
  assert.match(view.details().textContent, /negotiation unconfirmed/i);
  assert.match(view.details().textContent, /capability not established/i);
});

test('diagnostics preserve the existing context Boolean gate for unusual capability values', async () => {
  for (const capability of [undefined, null, false, 0, {}, true, [], 'yes']) {
    const view = harness();
    await view.initialize({ protocolVersion: '2026-01-26', hostCapabilities: { updateModelContext: capability } });
    view.publish();
    assert.equal(view.messages.filter(item => item.method === 'ui/update-model-context').length, Number(Boolean(capability)));
  }
});

test('older same-revision outcomes cannot override a newer topic or its debounce window', async () => {
  for (const outcome of ['ack', 'rpc', 'timeout']) {
    const view = harness(); await view.initialize();
    const first = view.publish().message;
    view.root.querySelector('.cdp-shell').dataset.briefTopic = 'resources';
    await view.drain();
    const scheduled = view.details().textContent;
    assert.match(scheduled, /resources.*scheduled/i);
    if (outcome === 'timeout') view.expire(first.id);
    else view.receive(first.id, {}, outcome === 'rpc' ? { code: -32000, message: 'old' } : undefined);
    await view.drain();
    assert.equal(view.details().textContent, scheduled);
    const second = view.publish().message;
    view.receive(second.id); await view.drain();
    assert.match(view.details().textContent, /resources.*revision 7.*Host acknowledged/i);
    view.receive(first.id); await view.drain();
    assert.match(view.details().textContent, /resources.*Host acknowledged/i);
  }
});

test('actual open revision invalidates old outcomes during deferred admission including same-country refresh', async () => {
  for (const country of ['CA', 'CN']) for (const outcome of ['ack', 'rpc', 'timeout']) {
    const view = harness(); await view.initialize();
    const old = view.publish().message;
    void view.context.api.open({ country_code: country, refresh: true, topic: 'resources' });
    assert.equal(view.context.revision, 8);
    const pendingAdmission = view.details().textContent;
    assert.match(pendingAdmission, /superseded/i);
    assert.equal(/scheduled|waiting|acknowledged/i.test(pendingAdmission), false);
    if (outcome === 'timeout') view.expire(old.id);
    else view.receive(old.id, {}, outcome === 'rpc' ? { code: -32000, message: 'old' } : undefined);
    await view.drain();
    assert.equal(view.details().textContent, pendingAdmission);
    assert.equal(view.messages.filter(item => item.method === 'ui/update-model-context').length, 1);
  }
});

test('diagnostic invalidation preserves a queued context send during admission', async () => {
  const view = harness(); await view.initialize();
  view.context.api.scheduleContext();
  void view.context.api.open({ country_code: 'CA', refresh: true });
  const superseded = view.details().textContent;
  const timer = [...view.timers.entries()].find(([, item]) => item.delay === 200);
  view.timers.delete(timer[0]); timer[1].fn();
  const sent = view.messages.findLast(item => item.method === 'ui/update-model-context');
  assert.ok(sent, 'Existing debounce still sends');
  assert.equal(view.details().textContent, superseded);
  view.receive(sent.id); await view.drain();
  assert.equal(view.details().textContent, superseded);
});

test('failed admissions finish the current pending status without another context request', async () => {
  for (const country of ['CA', 'CN']) for (const failure of ['unavailable', 'locked', 'receipt', 'mismatch']) {
    const view = harness(); await view.initialize();
    const sent = view.publish().message; view.receive(sent.id); await view.drain();
    const error = new sectionErrors.CountrySectionError(failure === 'locked' ? 'locked' : 'unavailable', 'PRIVATE_ADMISSION_FAILURE');
    view.context.call = failure === 'receipt' || failure === 'mismatch'
      ? async () => ({ panelRequest: {} }) : async () => { throw error; };
    view.context.panelAdmissionSchema.parse = () => {
      if (failure === 'receipt') throw error;
      return { countryCode: 'US', expiresAt: '2099-01-01T00:00:00Z' };
    };
    await assert.rejects(view.context.api.open({ country_code: country, refresh: true, topic: 'resources' }));
    assert.match(view.details().textContent, /unconfirmed/i);
    assert.doesNotMatch(view.details().textContent, /change is pending|PRIVATE_ADMISSION_FAILURE|Host acknowledged/i);
    assert.equal(view.messages.filter(item => item.method === 'ui/update-model-context').length, 1);
    assert.equal([...view.timers.values()].filter(item => item.delay === 200).length, 0);
    assert.equal(view.context.pending.size, 0);
  }
});

test('locked same-country refresh clears loaded signals and preserves the cleanup context update', async () => {
  const view = harness({ country: 'CA' }); await view.initialize();
  const prior = view.publish().message; view.receive(prior.id); await view.drain();
  const raw = { privateSignal: 'PRIVATE_DENIED_SIGNAL' };
  const base = [{ label: 'Public base signal' }];
  const notes = ['Public military note'];
  const receipt = { countryCode: 'CA', expiresAt: '2099-01-01T00:00:00Z' };
  view.context.signalSlots = { countryCode: 'CA', base, military: undefined, militaryNotes: notes, raw };
  view.context.signalCoverage = { loaded: true };
  view.context.admission = receipt;
  view.context.admissions.set('CA', receipt);
  view.context.hydratedAt = Date.now();
  let cleared = 0;
  let usageUpdates = 0;
  let rendered;
  view.context.source.clearLoadedData = () => { cleared++; };
  view.context.showUsage = () => { usageUpdates++; };
  view.context.hasCountryGeometry = () => false;
  view.context.composeCountrySignals = (signals, country, name, military, militaryNotes, admittedRaw) => {
    assert.equal(country, 'CA');
    assert.equal(admittedRaw, null);
    return { signals, notes: militaryNotes };
  };
  view.context.panel.updateSignals = (signals, signalNotes) => { rendered = { signals, notes: signalNotes }; };
  const error = new sectionErrors.CountrySectionError('locked', 'PRIVATE_ADMISSION_FAILURE');
  view.context.call = async () => { throw error; };
  await assert.rejects(view.context.api.open({ country_code: 'CA', refresh: true }), failure => failure === error);
  assert.equal(cleared, 1);
  assert.equal(usageUpdates, 1);
  assert.equal(view.context.signalSlots.raw, null);
  assert.equal(view.context.signalCoverage, null);
  assert.equal(view.context.admissions.has('CA'), false);
  assert.equal(view.context.admission, undefined);
  assert.equal(view.context.hydratedAt, 0);
  assert.deepEqual(rendered, { signals: base, notes });
  assert.match(view.details().textContent, /scheduled/i);
  assert.doesNotMatch(view.details().textContent, /unconfirmed|change is pending|PRIVATE_/i);
  assert.equal(view.messages.filter(item => item.method === 'ui/update-model-context').length, 1);
  const queued = [...view.timers.entries()].filter(([, timer]) => timer.delay === 200);
  assert.equal(queued.length, 1);
  view.timers.delete(queued[0][0]); queued[0][1].fn();
  const sent = view.messages.findLast(item => item.method === 'ui/update-model-context');
  assert.equal(view.messages.filter(item => item.method === 'ui/update-model-context').length, 2);
  view.receive(sent.id); await view.drain();
  assert.match(view.details().textContent, /Host acknowledged/i);
});

test('an older failed admission cannot overwrite a newer intent or pagehide', async () => {
  for (const newer of ['open', 'context', 'pagehide']) {
    const view = harness(); await view.initialize();
    let reject;
    view.context.call = () => new Promise((_, failed) => { reject = failed; });
    const first = view.context.api.open({ country_code: 'CA', refresh: true });
    const rejectFirst = reject;
    if (newer === 'open') void view.context.api.open({ country_code: 'US', refresh: true });
    else if (newer === 'context') view.context.api.scheduleContext();
    else view.teardown();
    const current = view.details().textContent;
    rejectFirst(new Error('PRIVATE_OLD_ADMISSION_FAILURE'));
    await assert.rejects(first);
    assert.equal(view.details().textContent, current);
    assert.equal(view.messages.filter(item => item.method === 'ui/update-model-context').length, 0);
  }
});

test('actual preparation and serialization failures are unconfirmed with no invented request deadline', async () => {
  for (const failure of ['snapshot', 'serialization']) {
    const view = harness({ country: failure === 'serialization' ? 'CA' : 'CN' }); await view.initialize();
    if (failure === 'snapshot') view.context.panel.getSignalCounts = () => { throw new Error('China model context exceeds the local size limit.'); };
    else { const cyclic = {}; cyclic.self = cyclic; view.state.atlas = cyclic; }
    view.publish(); await view.drain();
    assert.match(view.details().textContent, /unconfirmed/i);
    assert.equal(/local size limit|acknowledged|waiting/i.test(view.details().textContent), false);
    assert.equal(view.messages.filter(item => item.method === 'ui/update-model-context').length, 0);
    assert.equal(view.context.pending.size, 0);
    assert.equal([...view.timers.values()].filter(item => item.delay === 30000).length, 0);
  }
});

test('diagnostic DOM is outside actual observation and context extraction while panel mutations still publish', async () => {
  const view = harness(); await view.initialize();
  const before = JSON.stringify(view.context.api.snapshot());
  const sent = view.publish().message;
  view.receive(sent.id); await view.drain();
  view.details().open = true;
  await view.drain();
  assert.equal([...view.timers.values()].filter(item => item.delay === 200).length, 0);
  assert.equal(JSON.stringify(view.context.api.snapshot()), before);
  assert.equal(JSON.stringify(sent).includes('Connection details'), false);
  view.root.querySelector('.cdp-shell').dataset.briefTopic = 'overview';
  await view.drain();
  const debounce = [...view.timers.entries()].filter(([, item]) => item.delay === 200);
  assert.equal(debounce.length, 1);
  view.timers.delete(debounce[0][0]); debounce[0][1].fn();
  assert.equal(view.messages.filter(item => item.method === 'ui/update-model-context').length, 2);
});

test('unsupported context, foreign replies, close and pagehide keep existing send boundaries', async () => {
  const unsupported = harness(); await unsupported.initialize({ protocolVersion: '2026-01-26', hostCapabilities: {} });
  unsupported.publish();
  assert.match(unsupported.details().textContent, /context updates unsupported/i);
  assert.equal(unsupported.messages.filter(item => item.method === 'ui/update-model-context').length, 0);
  const view = harness(); await view.initialize();
  const sent = view.publish().message;
  view.receive(sent.id, {}, undefined, {}); view.receive(sent.id + 999);
  await view.drain(); assert.match(view.details().textContent, /waiting/i);
  view.state.visible = false; view.state.close();
  view.receive(sent.id); await view.drain(); assert.match(view.details().textContent, /scheduled/i);
  const closed = view.publish().message;
  view.receive(closed.id); await view.drain(); assert.match(view.details().textContent, /Closed view.*Host acknowledged/i);
  const waiting = view.publish().message;
  view.context.api.scheduleContext(); view.teardown();
  const text = view.details().textContent;
  view.receive(waiting.id); await view.drain(); view.context.api.scheduleContext();
  assert.equal(view.context.pending.size, 0);
  assert.equal([...view.timers.values()].filter(item => item.delay === 200 || item.delay === 30000).length, 0);
  assert.equal(view.details().textContent, text);
});
