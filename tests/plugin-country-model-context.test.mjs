import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { Window } from 'happy-dom';

const source = readFileSync(new URL('../src/plugin-country-main.ts', import.meta.url), 'utf8');
const file = ts.createSourceFile('plugin-country-main.ts', source, ts.ScriptTarget.Latest, true);
const mount = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'mountPlugin');
assert.ok(mount?.body);
const functions = ['request', 'snapshot', 'scheduleContext'];
const selected = mount.body.statements.filter(node => ts.isFunctionDeclaration(node) && functions.includes(node.name?.text));
assert.equal(selected.length, 3);
const send = mount.body.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(file) === 'send'));
assert.ok(send);
const helpers = file.statements.slice(0, file.statements.indexOf(mount)).filter(node => !ts.isImportDeclaration(node) && !ts.isExpressionStatement(node)).map(node => node.getText(file));
const program = ts.transpileModule([...helpers, send.getText(file), ...selected.map(node => node.getText(file)), 'this.api = { snapshot, scheduleContext, request };'].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const groups = [{"id":"macro","title":"Macro Signals","state":"PARTIAL","line":538,"signals":[{"label":"Industrial Value Added (YoY)","value":"5.2 %","observedAt":"2026-08","publishedAt":"2026-09-16T02:00:00.000Z","sourceAsCaptured":"National Bureau of Statistics of China · official government","sourceUrlAsCaptured":"stats.gov.cn/english/PressRelease/202609/t20260917_1965348.html"},{"label":"Fixed-Asset Investment (YoY)","value":"-7.2 %","observedAt":"2026-08","publishedAt":"2026-09-16T02:00:00.000Z","sourceAsCaptured":"National Bureau of Statistics of China · official government","sourceUrlAsCaptured":"stats.gov.cn/english/PressRelease/202609/t20260916_1965343.html"},{"label":"Real Estate Development Investment (YoY)","value":"-19.9 %","observedAt":"2026-08","publishedAt":"2026-09-16T02:00:00.000Z","sourceAsCaptured":"National Bureau of Statistics of China · official government","sourceUrlAsCaptured":"stats.gov.cn/english/PressRelease/202609/t20260916_1965342.html"},{"label":"Foreign-Exchange Reserves","value":"34383 USD 100 million","observedAt":"2026-08","publishedAt":"2026-09-07","sourceAsCaptured":"State Administration of Foreign Exchange · official government","sourceUrlAsCaptured":"safe.gov.cn/safe/2026/0907/27859.html"}],"reasonAsCaptured":"7 signals failed the launch/provenance boundary."},{"id":"policy-enforcement","title":"Policy & Enforcement","state":"PARTIAL","line":571,"signals":[{"label":"市场监管总局关于发布《国家统一推行自愿性认证制度管理办法（试行）》的公告","value":"SAMR · final_rule · unknown","publishedAt":"2026-09-30","translationState":"not translated","sourceAsCaptured":"State Administration for Market Regulation · official government","sourceUrlAsCaptured":"samr.gov.cn/zw/zfxxgk/fdzdgknr/rzjgs/art/2026/art_c739f36a509440eeb44dd56513f5aeef.html"},{"label":"商务部办公厅关于做好2027年度汽车和摩托车出口许可申报工作的通知","value":"MOFCOM · announcement_guidance · announced","publishedAt":"2026-09-30","translationState":"not translated","sourceAsCaptured":"Ministry of Commerce · official government","sourceUrlAsCaptured":"mofcom.gov.cn/zcfb/zc/art/2026/art_c7ac10d2deaa489dbf6346461785c65c.html"},{"label":"四部门关于开展2026年度享受增值税加计抵减政策的集成电路企业清单制定工作的通知","value":"MIIT · announcement_guidance · announced","publishedAt":"2026-09-30","translationState":"not translated","sourceAsCaptured":"Ministry of Industry and Information Technology · official government","sourceUrlAsCaptured":"miit.gov.cn/zwgk/zcwj/wjfb/tz/art/2026/art_7d2e760b4be94217b8f55caec840b30d.html"},{"label":"市场监管总局关于发布《饼干生产许可审查细则（2026版）》的公告","value":"SAMR · announcement_guidance · announced","publishedAt":"2026-09-29","effectiveAt":"2027-01-01","translationState":"not translated","sourceAsCaptured":"State Administration for Market Regulation · official government","sourceUrlAsCaptured":"samr.gov.cn/zw/zfxxgk/fdzdgknr/spscs/art/2026/art_b8afbb7e06e048aebb9f93f50737565f.html"}],"reasonAsCaptured":null},{"id":"cross-strait-activity","title":"Cross-Strait Activity","state":"AVAILABLE","line":604,"signals":[{"label":"taiwan-mnd activity","value":"plaAircraftSorties: 0 · planShips: 8 · officialShips: 8","observedAt":"2026-10-05T22:00:00.000Z","publishedAt":"2026-10-06","translationState":"not translated","sourceAsCaptured":"Taiwan Ministry of National Defense · official government","sourceUrlAsCaptured":"mnd.gov.tw/en/News/PLAAct/87922"},{"label":"taiwan-mnd activity","value":"plaAircraftSorties: 0 · planShips: 8 · officialShips: 9","observedAt":"2026-10-04T22:00:00.000Z","publishedAt":"2026-10-05","translationState":"not translated","sourceAsCaptured":"Taiwan Ministry of National Defense · official government","sourceUrlAsCaptured":"mnd.gov.tw/en/News/PLAAct/87913"},{"label":"taiwan-mnd activity","value":"plaAircraftSorties: 0 · planShips: 7 · officialShips: 8","observedAt":"2026-10-03T22:00:00.000Z","publishedAt":"2026-10-04","translationState":"not translated","sourceAsCaptured":"Taiwan Ministry of National Defense · official government","sourceUrlAsCaptured":"mnd.gov.tw/en/News/PLAAct/87905"},{"label":"taiwan-mnd activity","value":"plaAircraftSorties: 5 · planShips: 6 · officialShips: 7 · adizEntries: 2","observedAt":"2026-10-02T22:00:00.000Z","publishedAt":"2026-10-03","translationState":"not translated","sourceAsCaptured":"Taiwan Ministry of National Defense · official government","sourceUrlAsCaptured":"mnd.gov.tw/en/News/PLAAct/87903"}],"reasonAsCaptured":null},{"id":"corporate-disclosures","title":"Corporate Disclosures","state":"UNAVAILABLE","line":640,"signals":[],"reasonAsCaptured":"healthy_quiet_window: Healthy exchange queries contained no qualifying disclosure events."},{"id":"corridor-conditions","title":"Corridor Conditions","state":"PARTIAL","line":645,"signals":[{"label":"Yangtze River Delta · port","value":"partial","observedAt":"2026-09-30T00:02:51.316Z","effectiveAt":"2026-09-30T00:02:51.316Z","sourceAsCaptured":"WorldMonitor derived output · derived output"},{"label":"Yangtze River Delta · aviation","value":"available","observedAt":"2026-10-06T16:32:29.855Z","effectiveAt":"2026-10-06T16:32:29.855Z","sourceAsCaptured":"WorldMonitor derived output · derived output"},{"label":"Yangtze River Delta · hazard","value":"available","observedAt":"2026-10-06T16:32:04.270Z","effectiveAt":"2026-10-06T16:32:04.270Z","sourceAsCaptured":"WorldMonitor derived output · derived output"},{"label":"Yangtze River Delta · power_energy","value":"available","observedAt":"2026-05","effectiveAt":"2026-05","sourceAsCaptured":"WorldMonitor derived output · derived output"}],"reasonAsCaptured":null},{"id":"activity-nowcast","title":"Activity Nowcast","state":"AVAILABLE","line":669,"signals":[{"label":"Official activity versus independent proxies","value":"mixed_signals · medium confidence","observedAt":"2026-10-06T16:18:32.279Z","effectiveAt":"2026-10-06T16:18:32.279Z","sourceAsCaptured":"WorldMonitor China Activity Nowcast · derived output"}],"reasonAsCaptured":null}];
const ids = groups.map(group => group.id);
const windows = [];
afterEach(async () => { await Promise.all(windows.splice(0).map(win => win.happyDOM.close())); });

function harness({ country = 'CN', visible = true, capability = true } = {}) {
  const win = new Window({ url: 'https://worldmonitor.app/' });
  windows.push(win);
  const doc = win.document;
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
    window: win, document: doc, TextEncoder, URL, console,
    modelContextRoot: root, translate: key => key.split('.').at(-1),
    panel: { getCode: () => state.country, getName: () => state.name, isVisible: () => state.visible, getAtlasSelection: () => state.atlas, getSignalCounts: () => null },
    admission: undefined, signalCoverage: null, revision: 7, modelContextRevision: 7, nextId: 123, pending: new Map(), modelContext: capability, contextTimer: undefined,
    CHINA_DECISION_SIGNAL_GROUP_IDS: ids,
    CHINA_DECISION_SIGNAL_GROUP_MANIFEST: ids.map(groupId => ({ groupId })),
    CHINA_DECISION_SIGNAL_MAX_ITEMS_PER_GROUP: 4,
    BRIEF_TOPICS: { all: 'All', overview: 'Overview' },
    COUNTRY_EXPORT_REQUEST_BYTES: 65536, CountryDownloadRequestError: Error,
    briefSectionState: ({ body }) => body.querySelector('.cdp-pro-locked, [data-brief-state="locked"]') ? 'locked' : body.querySelector('.cdp-loading-inline') ? 'loading' : body.querySelector('[data-brief-state="unavailable"]') ? 'unavailable' : 'ready',
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(program, context);
  function publish() {
    context.api.scheduleContext();
    for (const [id, timer] of [...timers]) if (timer.delay === 200) { timers.delete(id); timer.fn(); }
    const message = messages.at(-1);
    return message ? { message, snapshot: JSON.parse(message.params.content[0].text), bytes: new TextEncoder().encode(JSON.stringify(message)).length } : null;
  }
  return { win, doc, root, state, messages, context, publish };
}

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
  await assert.rejects(view.context.api.request('ui/update-model-context', { content: [{ type: 'text', text: JSON.stringify({ countryCode: 'CN', china: { groups: [] }, hostile: '中'.repeat(40000) }) }] }));
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
