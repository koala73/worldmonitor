/**
 * Owned maritime logistics workspace.
 *
 * It deliberately consumes only same-origin Maritime/SupplyChain/Shipping
 * contracts. A missing relay produces an explicit empty state; it never falls
 * back to a static fleet, a globally cached candidate subset, inferred cargo,
 * or an iframe of a provider map.
 */

import { PRIMARY_BRAND } from '@/config/brand';
import {
  MaritimeServiceClient,
  type GetVesselSnapshotResponse,
  type ListNavigationalWarningsResponse,
  type SnapshotCandidateReport,
} from '@/generated/client/worldmonitor/maritime/v1/service_client';
import {
  ShippingV2ServiceClient,
  type RouteIntelligenceResponse,
} from '@/generated/client/worldmonitor/shipping/v2/service_client';
import {
  SupplyChainServiceClient,
  type GetChokepointStatusResponse,
} from '@/generated/client/worldmonitor/supply_chain/v1/service_client';
import { premiumFetch } from '@/services/premium-fetch';
import { getRpcBaseUrl, rpcFetch } from '@/services/rpc-client';
import {
  MARITIME_FOCUS_AREAS,
  maritimeFocusArea,
  maritimeLogisticsUrl,
  selectVerifiedAisReports,
  type MaritimeFocusArea,
} from './maritime-logistics-route';
import './maritime-logistics.css';

const maritimeClient = new MaritimeServiceClient(getRpcBaseUrl(), { fetch: rpcFetch });
const supplyChainClient = new SupplyChainServiceClient(getRpcBaseUrl(), { fetch: rpcFetch });
// routeIntelligence is premium. premiumFetch attaches the signed-in Clerk
// bearer or server-issued WM key when present and otherwise fails closed; a
// plain rpcFetch would let the generated fallback turn a 401 into silent empty
// route intelligence for legitimate Pro sessions.
const shippingClient = new ShippingV2ServiceClient(getRpcBaseUrl(), { fetch: premiumFetch });

const SNAPSHOT_STALE_SECONDS = 6 * 60;

type WorkspaceState = {
  focus: MaritimeFocusArea;
  loading: boolean;
  snapshot?: GetVesselSnapshotResponse;
  chokepoints?: GetChokepointStatusResponse;
  warnings?: ListNavigationalWarningsResponse;
  selectedMmsi: string | null;
  routeLoading: boolean;
  route?: RouteIntelligenceResponse;
  routeError: string | null;
};

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, className: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const node = element('button', className, label);
  node.type = 'button';
  node.disabled = disabled;
  node.addEventListener('click', onClick);
  return node;
}

function formatUtc(timestamp: number | string | undefined): string {
  const numeric = typeof timestamp === 'string' ? Date.parse(timestamp) : Number(timestamp);
  if (!Number.isFinite(numeric) || numeric <= 0) return '未提供';
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC', timeZoneName: 'short',
  }).format(new Date(numeric));
}

function formatNumber(value: number | undefined, fallback = '未提供'): string {
  return Number.isFinite(value) ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value as number) : fallback;
}

function snapshotAgeSeconds(snapshot: GetVesselSnapshotResponse | undefined): number | null {
  const observedAt = Number(snapshot?.fetchedAt);
  if (!Number.isFinite(observedAt) || observedAt <= 0) return null;
  return Math.max(0, Math.floor((Date.now() - observedAt) / 1000));
}

function snapshotStatus(snapshot: GetVesselSnapshotResponse | undefined): { label: string; className: string; detail: string } {
  if (!snapshot?.dataAvailable || !snapshot.snapshot) {
    return {
      label: '未收到可验证 AIS 快照', className: 'maritime-logistics__status maritime-logistics__status--warn',
      detail: '服务端没有返回任何可验证的 AIS 船位；这不能证明海上没有船舶。请在后端中继配置 WS_RELAY_URL、AISSTREAM_API_KEY 与中继认证，密钥不得进入浏览器、聊天或 Git。',
    };
  }
  const age = snapshotAgeSeconds(snapshot);
  if (!snapshot.snapshot.status?.connected) {
    return {
      label: 'AIS Relay 已降级', className: 'maritime-logistics__status maritime-logistics__status--stale',
      detail: '返回的是最近的服务端快照，但中继未报告上游连接。任何位置都必须按其各自报文时间阅读，不能作为当前航迹。',
    };
  }
  if (age === null || age > SNAPSHOT_STALE_SECONDS) {
    return {
      label: 'AIS 快照已过期', className: 'maritime-logistics__status maritime-logistics__status--stale',
      detail: '快照年龄超过 6 分钟或没有有效抓取时间，页面不将其称作实时数据。',
    };
  }
  return {
    label: '已观测 AIS Relay 快照', className: 'maritime-logistics__status',
    detail: `该状态仅说明服务端转发的 AIS 快照年龄约 ${age} 秒。AISStream 为 beta、无 SLA；页面不以此承诺交易级实时性。`,
  };
}

function createMetric(label: string, value: string): HTMLElement {
  const card = element('div', 'maritime-logistics__metric');
  card.append(element('span', undefined, label), element('strong', undefined, value));
  return card;
}

function normalizedPercent(value: number, min: number, max: number): string {
  if (!Number.isFinite(value) || max <= min) return '50%';
  return `${Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100))}%`;
}

function renderVesselMap(
  state: WorkspaceState,
  reports: readonly SnapshotCandidateReport[],
  onSelect: (mmsi: string) => void,
): HTMLElement {
  const map = element('div', 'maritime-logistics__map');
  map.append(element('div', 'maritime-logistics__map-label', `${state.focus.label} · 严格 bbox ${state.focus.swLat}, ${state.focus.swLon} → ${state.focus.neLat}, ${state.focus.neLon}`));
  if (reports.length === 0) {
    map.append(element('div', 'maritime-logistics__map-empty', state.snapshot?.dataAvailable
      ? '此严格 bbox 的响应中没有通过 MMSI、坐标与报文时间校验的单船报告；页面不以其他海区或示例船补齐。'
      : '未收到可验证 AIS 快照，因此不渲染随机船、固定船或历史示例船。'));
    return map;
  }
  for (const report of reports) {
    const dot = button(
      '',
      'maritime-logistics__vessel-dot',
      () => onSelect(report.mmsi),
    );
    dot.style.left = normalizedPercent(report.lon, state.focus.swLon, state.focus.neLon);
    dot.style.top = `${100 - Number.parseFloat(normalizedPercent(report.lat, state.focus.swLat, state.focus.neLat))}%`;
    dot.setAttribute('aria-label', `选择 MMSI ${report.mmsi}，最后 AIS 报文 ${formatUtc(report.timestamp)}`);
    dot.title = `${report.name || '未命名船舶'} · MMSI ${report.mmsi}`;
    map.append(dot);
  }
  return map;
}

function renderVesselTable(reports: readonly SnapshotCandidateReport[], selectedMmsi: string | null, onSelect: (mmsi: string) => void): HTMLElement {
  const wrap = element('div', 'maritime-logistics__table-wrap');
  const table = element('table');
  const head = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const label of ['船舶 / MMSI', '经纬度', '速度 / 航向', 'AIS 船型代码', '最后报文（UTC）']) {
    headerRow.append(element('th', undefined, label));
  }
  head.append(headerRow);
  table.append(head);
  const body = document.createElement('tbody');
  for (const report of reports) {
    const row = document.createElement('tr');
    if (report.mmsi === selectedMmsi) row.className = 'maritime-logistics__selected-row';
    row.tabIndex = 0;
    row.addEventListener('click', () => onSelect(report.mmsi));
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onSelect(report.mmsi);
      }
    });
    row.append(
      element('td', undefined, `${report.name || '未提供船名'}\nMMSI ${report.mmsi}`),
      element('td', undefined, `${report.lat.toFixed(5)}, ${report.lon.toFixed(5)}`),
      element('td', undefined, `${formatNumber(report.speed)} kn / ${formatNumber(report.course)}°；艏向 ${formatNumber(report.heading)}°`),
      element('td', undefined, report.shipType ? String(report.shipType) : '未提供'),
      element('td', undefined, formatUtc(report.timestamp)),
    );
    body.append(row);
  }
  table.append(body);
  wrap.append(table);
  return wrap;
}

function renderChokepoints(data: GetChokepointStatusResponse | undefined): HTMLElement {
  const panel = element('section', 'maritime-logistics__panel');
  panel.append(element('h2', undefined, '咽喉点与 PortWatch/供应链状态'));
  panel.append(element('p', 'maritime-logistics__panel-subtitle', '此处是 WorldMonitor 供应链/PortWatch 资料的状态面板，不是单船 AIS 点位，也不被标成逐秒港口吞吐。'));
  if (!data || data.upstreamUnavailable) {
    panel.append(element('p', 'maritime-logistics__notice maritime-logistics__notice--critical', '未收到可验证的咽喉点/PortWatch 上游状态；不以零拥堵、零等待或样例港口数据代替。'));
    return panel;
  }
  const list = element('ul', 'maritime-logistics__list');
  for (const point of data.chokepoints.slice(0, 8)) {
    const transit = point.transitSummary;
    const item = element('li');
    item.append(element('strong', undefined, `${point.name} · ${point.status || '状态未提供'}`));
    item.append(element('small', undefined, `中断分数 ${formatNumber(point.disruptionScore)}；拥堵 ${point.congestionLevel || '未提供'}；告警 ${formatNumber(point.activeWarnings, '未提供')}`));
    item.append(element('small', undefined, transit?.dataAvailable
      ? `过境计数：今日 ${formatNumber(transit.todayTotal)}；方法/来源取决于上游数据集。`
      : '未提供可验证过境汇总；不显示为 0。'));
    list.append(item);
  }
  panel.append(list, element('p', 'maritime-logistics__notice', `上游组装时间：${data.fetchedAt || '未提供'}。`));
  return panel;
}

function renderWarnings(data: ListNavigationalWarningsResponse | undefined): HTMLElement {
  const panel = element('section', 'maritime-logistics__panel');
  panel.append(element('h2', undefined, '航行警告'));
  panel.append(element('p', 'maritime-logistics__panel-subtitle', '仅显示同源 Maritime v1 返回的 NGA/权威机构警告；没有返回时不制造事件。'));
  if (!data?.warnings.length) {
    panel.append(element('p', 'maritime-logistics__notice', '未收到可验证航行警告。该空状态不代表海域没有风险。'));
    return panel;
  }
  const list = element('ul', 'maritime-logistics__list');
  for (const warning of data.warnings.slice(0, 8)) {
    const item = element('li');
    item.append(element('strong', undefined, warning.title || warning.id));
    item.append(element('small', undefined, `${warning.authority || '权威机构未提供'} · ${warning.area || '区域未提供'} · ${formatUtc(warning.issuedAt)}`));
    if (warning.text) item.append(element('small', undefined, warning.text.slice(0, 260)));
    list.append(item);
  }
  panel.append(list);
  return panel;
}

function renderRouteIntelligence(state: WorkspaceState, onSubmit: (form: HTMLFormElement) => void): HTMLElement {
  const panel = element('section', 'maritime-logistics__panel maritime-logistics__wide');
  panel.append(element('h2', undefined, '航线情报（模型/注册表，不是船舶实际轨迹）'));
  panel.append(element('p', 'maritime-logistics__panel-subtitle', '按起讫国、货类和 HS2 查询 WorldMonitor Shipping v2 的咽喉点暴露与绕行选项。它不能证明某一艘船、某票货物、生产地或最终买家。'));
  const form = element('form', 'maritime-logistics__route-form');
  const fields: Array<{ name: string; label: string; value: string; options?: string[] }> = [
    { name: 'fromIso2', label: '始发国 ISO2', value: 'CN' },
    { name: 'toIso2', label: '目的国 ISO2', value: 'US' },
    { name: 'cargoType', label: '货类', value: 'container', options: ['container', 'tanker', 'bulk', 'roro'] },
    { name: 'hs2', label: 'HS2', value: '85' },
  ];
  for (const field of fields) {
    const label = element('label', 'maritime-logistics__field', field.label);
    let control: HTMLInputElement | HTMLSelectElement;
    if (field.options) {
      const select = document.createElement('select');
      select.name = field.name;
      for (const optionValue of field.options) {
        const option = document.createElement('option');
        option.value = optionValue;
        option.textContent = optionValue;
        option.selected = optionValue === field.value;
        select.append(option);
      }
      control = select;
    } else {
      const input = document.createElement('input');
      input.name = field.name;
      input.value = field.value;
      input.maxLength = field.name === 'hs2' ? 2 : 2;
      input.autocomplete = 'off';
      control = input;
    }
    label.append(control);
    form.append(label);
  }
  const submit = button(state.routeLoading ? '查询中…' : '查询航线', 'maritime-logistics__button', () => {}, state.routeLoading);
  submit.type = 'submit';
  form.append(submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    onSubmit(form);
  });
  panel.append(form);
  const result = element('div', 'maritime-logistics__route-result');
  if (state.routeError) {
    result.textContent = state.routeError;
  } else if (!state.route) {
    result.textContent = '尚未查询。没有授权/可验证响应时，本区不会生成模拟航线或货物流结论。';
  } else {
    result.append(element('strong', undefined, `${state.route.fromIso2} → ${state.route.toIso2} · 主路径 ${state.route.primaryRouteId || '未提供'}`));
    const list = document.createElement('ul');
    for (const exposure of state.route.chokepointExposures) {
      list.append(element('li', undefined, `${exposure.chokepointName}：注册表暴露 ${exposure.exposurePct}%`));
    }
    for (const bypass of state.route.bypassOptions) {
      list.append(element('li', undefined, `${bypass.name}：估计增加 ${bypass.addedTransitDays} 天，成本倍率 ${bypass.addedCostMultiplier}（模型绕行选项）`));
    }
    result.append(list, element('small', undefined, state.route.fetchedAt ? `组装时间：${state.route.fetchedAt}` : '未提供可验证上游组装时间。'));
  }
  panel.append(result);
  return panel;
}

function renderWorkspace(root: HTMLElement, state: WorkspaceState): void {
  root.replaceChildren();
  const shell = element('main', 'maritime-logistics');
  const content = element('div', 'maritime-logistics__shell');
  const header = element('header', 'maritime-logistics__header');
  const titleBlock = element('div');
  titleBlock.append(
    element('p', 'maritime-logistics__eyebrow', PRIMARY_BRAND),
    element('h1', undefined, '海运物流 · 可验证 AIS 与航运证据'),
  );
  const actions = element('div', 'maritime-logistics__header-actions');
  const refresh = button(state.loading ? '刷新中…' : '刷新当前海区', 'maritime-logistics__button', () => void loadWorkspace(root, state), state.loading);
  const home = element('a', 'maritime-logistics__link', '返回全球地图');
  home.href = '/';
  actions.append(refresh, home);
  header.append(titleBlock, actions);
  content.append(header);

  const status = snapshotStatus(state.snapshot);
  const reality = element('section', 'maritime-logistics__reality');
  const realityText = element('div');
  realityText.append(element('strong', undefined, '数据真实性边界'));
  realityText.append(element('p', undefined, status.detail));
  reality.append(realityText, element('span', status.className, status.label));
  content.append(reality);

  const focusNav = element('nav', 'maritime-logistics__focuses');
  focusNav.setAttribute('aria-label', 'AIS 观测海区');
  for (const focus of MARITIME_FOCUS_AREAS) {
    const focusButton = button(focus.label, 'maritime-logistics__focus', () => {
      state.focus = focus;
      state.selectedMmsi = null;
      history.pushState({}, '', maritimeLogisticsUrl(focus.id));
      void loadWorkspace(root, state);
    });
    focusButton.setAttribute('aria-pressed', String(focus.id === state.focus.id));
    focusButton.title = `${focus.description}；严格 bbox 请求`;
    focusNav.append(focusButton);
  }
  content.append(focusNav);

  const reports = selectVerifiedAisReports(state.snapshot?.snapshot?.candidateReports, state.focus);
  const grid = element('div', 'maritime-logistics__grid');
  const mapPanel = element('section', 'maritime-logistics__panel');
  mapPanel.append(element('h2', undefined, `${state.focus.label} · AIS 船位`));
  mapPanel.append(element('p', 'maritime-logistics__panel-subtitle', '仅绘制本次 bbox 响应内、MMSI/坐标/报文时间均有效的 AIS 报告；船型和目的地不能证明货物。'));
  const selectMmsi = (mmsi: string) => {
    state.selectedMmsi = mmsi;
    renderWorkspace(root, state);
  };
  mapPanel.append(renderVesselMap(state, reports, selectMmsi));
  grid.append(mapPanel);

  const healthPanel = element('aside', 'maritime-logistics__panel');
  healthPanel.append(element('h2', undefined, '中继健康与观测范围'));
  healthPanel.append(element('p', 'maritime-logistics__panel-subtitle', '显示服务端快照与本次渲染数量，而非把空响应解释成零船舶。'));
  const metrics = element('div', 'maritime-logistics__metrics');
  metrics.append(
    createMetric('Relay 上游连接', state.snapshot?.snapshot?.status?.connected ? '已报告连接' : '未报告连接'),
    createMetric('中继跟踪船舶', formatNumber(state.snapshot?.snapshot?.status?.vessels)),
    createMetric('中继处理报文', formatNumber(state.snapshot?.snapshot?.status?.messages)),
    createMetric('当前 bbox 已渲染', String(reports.length)),
    createMetric('快照抓取（UTC）', formatUtc(state.snapshot?.fetchedAt)),
    createMetric('快照年龄', snapshotAgeSeconds(state.snapshot) === null ? '未提供' : `${snapshotAgeSeconds(state.snapshot)} 秒`),
  );
  healthPanel.append(metrics);
  healthPanel.append(element('p', 'maritime-logistics__notice maritime-logistics__notice--critical', 'AIS 可证明：广播位置、航向/航速及报文里自报字段。AIS 不能单独证明：船上货物、生产地、货值、买家、实际卸货港或具体提单。'));
  grid.append(healthPanel);
  content.append(grid);

  const vesselPanel = element('section', 'maritime-logistics__panel maritime-logistics__wide');
  vesselPanel.append(element('h2', undefined, `已验证单船报告（${reports.length}）`));
  vesselPanel.append(element('p', 'maritime-logistics__panel-subtitle', '目的地、ETA 和吃水只有在当前 API 明确提供时才能显示；当前 Maritime v1 单船契约未返回这些字段，所以页面明确不猜测。'));
  if (reports.length) vesselPanel.append(renderVesselTable(reports, state.selectedMmsi, selectMmsi));
  else vesselPanel.append(element('p', 'maritime-logistics__notice', '没有可显示的已验证单船报告。'));
  content.append(vesselPanel);

  const lower = element('div', 'maritime-logistics__lower');
  lower.append(renderChokepoints(state.chokepoints), renderWarnings(state.warnings));
  content.append(lower, renderRouteIntelligence(state, (form) => void queryRoute(root, state, form)));
  content.append(element('footer', 'maritime-logistics__footer', '数据来源路径：WorldMonitor Maritime v1、AIS Relay、Supply Chain/PortWatch 与 Shipping v2。每一层的时间、范围与方法不同；页面不会用 AIS 推断货物，也不会把 PortWatch/模型估计标为逐秒船位。'));
  shell.append(content);
  root.append(shell);
}

async function loadWorkspace(root: HTMLElement, state: WorkspaceState): Promise<void> {
  state.loading = true;
  renderWorkspace(root, state);
  const focus = state.focus;
  const [snapshot, chokepoints, warnings] = await Promise.all([
    maritimeClient.getVesselSnapshot({
      neLat: focus.neLat, neLon: focus.neLon, swLat: focus.swLat, swLon: focus.swLon,
      includeCandidates: true, includeTankers: false,
    }).catch(() => undefined),
    supplyChainClient.getChokepointStatus({}).catch(() => undefined),
    maritimeClient.listNavigationalWarnings({ pageSize: 8, cursor: '', area: '' }).catch(() => undefined),
  ]);
  state.snapshot = snapshot;
  state.chokepoints = chokepoints;
  state.warnings = warnings;
  state.loading = false;
  renderWorkspace(root, state);
}

async function queryRoute(root: HTMLElement, state: WorkspaceState, form: HTMLFormElement): Promise<void> {
  const values = new FormData(form);
  state.routeLoading = true;
  state.routeError = null;
  renderWorkspace(root, state);
  try {
    state.route = await shippingClient.routeIntelligence({
      fromIso2: String(values.get('fromIso2') ?? '').trim().toUpperCase(),
      toIso2: String(values.get('toIso2') ?? '').trim().toUpperCase(),
      cargoType: String(values.get('cargoType') ?? '').trim().toLowerCase(),
      hs2: String(values.get('hs2') ?? '').trim(),
    });
  } catch {
    state.route = undefined;
    state.routeError = '未收到可验证的 Shipping v2 航线响应（可能未授权、未配置或上游不可用）；不生成模拟绕行或货物流结论。';
  } finally {
    state.routeLoading = false;
    renderWorkspace(root, state);
  }
}

export function initMaritimeLogistics(rootId = 'app'): void {
  const root = document.getElementById(rootId);
  if (!root) throw new Error(`Maritime logistics root #${rootId} was not found.`);
  const state: WorkspaceState = {
    focus: maritimeFocusArea(new URLSearchParams(window.location.search).get('focus')),
    loading: false,
    selectedMmsi: null,
    routeLoading: false,
    routeError: null,
  };
  window.addEventListener('popstate', () => {
    state.focus = maritimeFocusArea(new URLSearchParams(window.location.search).get('focus'));
    state.selectedMmsi = null;
    void loadWorkspace(root, state);
  });
  void loadWorkspace(root, state);
}
