/**
 * Owned China factory explorer.
 *
 * It never turns a cluster registry into a shipment ledger.  A numeric trade
 * table can appear only from the existing same-origin Comtrade contract and is
 * always labelled China-level, product/period filtered official statistics.
 */

import { PRIMARY_BRAND } from '@/config/brand';
import { fetchComtradeFlows, type ComtradeFlowRecord } from '@/services/trade';
import {
  CHINA_FACTORY_CLUSTERS,
  chinaFactoryClusterById,
  type ChinaFactoryCluster,
  type ChinaFactorySource,
} from '../../../shared/china-factory-clusters';
import {
  chinaFactoryFiltersFromSearch,
  chinaFactoryUrl,
  selectObservedChinaFactoryTrade,
  type ChinaFactoryFilters,
  type ChinaFactoryTradeRecord,
} from './china-factory-route';
import './china-factory.css';

type ChinaFactoryState = {
  filters: ChinaFactoryFilters;
  loading: boolean;
  records: readonly ComtradeFlowRecord[];
  fetchedAt: string;
  upstreamUnavailable: boolean;
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, onClick: () => void, className = 'china-factory__button'): HTMLButtonElement {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

function formatNumber(value: number, maximumFractionDigits = 0): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits }).format(value);
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  }).format(value);
}

function sourceLink(source: ChinaFactorySource): HTMLAnchorElement {
  const link = el('a', 'china-factory__source', `${source.publisher} · ${source.publishedAt ?? '发布日期未提供'}`);
  link.href = source.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.title = source.title;
  return link;
}

function evidenceBadge(value: string): HTMLElement {
  const badge = el('span', 'china-factory__badge', value);
  badge.dataset.evidence = value;
  return badge;
}

function asTradeRecords(records: readonly ComtradeFlowRecord[]): ChinaFactoryTradeRecord[] {
  return records.map((record) => ({
    reporterCode: record.reporterCode,
    partnerCode: record.partnerCode,
    partnerName: record.partnerName,
    cmdCode: record.cmdCode,
    cmdDesc: record.cmdDesc,
    year: record.year,
    tradeValueUsd: record.tradeValueUsd,
    netWeightKg: record.netWeightKg,
  }));
}

function createSourceCard(cluster: ChinaFactoryCluster): HTMLElement {
  const panel = el('section', 'china-factory__panel');
  panel.append(el('h2', undefined, '产业集群事实与 HS 映射'));
  panel.append(el('p', 'china-factory__subtle', '“官方观察”只确认来源所陈述的产业集群/产品信息；它不等于该地当期出口额、实际装港、船名或买方。'));
  const details = el('dl', 'china-factory__details');
  const add = (label: string, value: string) => {
    details.append(el('dt', undefined, label), el('dd', undefined, value));
  };
  add('行政区划', `${cluster.province} / ${cluster.city} / ${cluster.countyOrDistrict}`);
  add('产品表述', cluster.productDescription);
  add('统计资格', cluster.statisticsEligible ? '可尝试查询同一筛选条件下的国家级官方贸易统计' : '仅参考名录；未审核 HS 映射，不显示数值统计');
  panel.append(details, evidenceBadge(cluster.clusterEvidence), sourceLink(cluster.source));
  const mapping = el('div', 'china-factory__mappings');
  if (cluster.hsMappings.length === 0) {
    mapping.append(el('p', 'china-factory__notice', cluster.statisticsEligibilityReason));
  } else {
    mapping.append(el('h3', undefined, 'HS 映射证据'));
    for (const item of cluster.hsMappings) {
      const row = el('div', 'china-factory__mapping');
      row.append(evidenceBadge(item.evidence), el('strong', undefined, `HS${item.hs2} · ${item.label}`), sourceLink(item.source));
      mapping.append(row);
    }
    mapping.append(el('p', 'china-factory__notice', cluster.statisticsEligibilityReason));
  }
  panel.append(mapping);
  return panel;
}

function createObservedTradePanel(state: ChinaFactoryState, cluster: ChinaFactoryCluster): HTMLElement {
  const panel = el('section', 'china-factory__panel china-factory__panel--wide');
  panel.append(el('h2', undefined, '目的国排行：同筛选条件的国家级官方统计'));
  panel.append(el('p', 'china-factory__subtle', `筛选统一为：中国 reporter 156、HS${state.filters.hs2}、${state.filters.period}。即使返回数值，它也是中国层面统计，不能归因于 ${cluster.countyOrDistrict}、某个出口港或具体船货。`));
  if (!cluster.statisticsEligible) {
    panel.append(el('p', 'china-factory__notice', '当前集群缺少已审核 HS 映射，因此本页拒绝把任意全国贸易数据拼接到该集群。'));
    return panel;
  }
  if (state.loading) {
    panel.append(el('p', 'china-factory__notice', '正在请求同源 Comtrade 统计；在得到可验证响应前不显示任何数字。'));
    return panel;
  }
  const flows = selectObservedChinaFactoryTrade(asTradeRecords(state.records), state.filters);
  if (state.upstreamUnavailable || flows.length === 0) {
    panel.append(el('p', 'china-factory__notice', state.upstreamUnavailable
      ? '当前没有可验证的 Comtrade 缓存/上游响应；不以零金额、样例国家或历史数组代替。'
      : '没有与该产品/年份同时匹配的可验证国家级统计；不跨期、跨 HS 或跨 reporter 补齐。'));
    return panel;
  }
  const table = document.createElement('table');
  const head = document.createElement('thead');
  const row = document.createElement('tr');
  for (const label of ['目的国', 'HS 商品', '统计年', '贸易金额（USD）', '净重（kg）']) row.append(el('th', undefined, label));
  head.append(row);
  table.append(head);
  const body = document.createElement('tbody');
  for (const flow of flows.slice(0, 20)) {
    const item = document.createElement('tr');
    item.append(
      el('td', undefined, flow.partnerName || flow.partnerCode),
      el('td', undefined, `${flow.cmdCode} · ${flow.cmdDesc}`),
      el('td', undefined, String(flow.year)),
      el('td', undefined, formatUsd(flow.tradeValueUsd)),
      el('td', undefined, Number.isFinite(flow.netWeightKg) ? formatNumber(flow.netWeightKg) : '未提供'),
    );
    body.append(item);
  }
  table.append(body);
  panel.append(table, el('p', 'china-factory__notice', state.fetchedAt ? `上游/缓存抓取时间：${state.fetchedAt}` : '上游未提供可验证抓取时间。'));
  return panel;
}

function createPortAndShipmentBoundary(cluster: ChinaFactoryCluster): HTMLElement {
  const panel = el('section', 'china-factory__panel');
  panel.append(el('h2', undefined, '出口港与逐票链路边界'));
  panel.append(el('p', 'china-factory__subtle', '本版没有把“离产业集群最近的港口”伪装成实际出口港，也不会生成船名、箱号、提单、收发货人或完整转运链。'));
  panel.append(evidenceBadge('MODELLED_ESTIMATE'));
  panel.append(el('p', 'china-factory__notice', `没有与 ${cluster.name}、产品、期间共同覆盖的合法港口/提单数据时，可能出口港排名不计算。未来模型估计必须保存输入、方法版本、置信度、误差和输出时间。`));
  panel.append(evidenceBadge('BILL_OF_LADING_OBSERVED'));
  panel.append(el('p', 'china-factory__notice', '商业提单 Provider 尚未配置；本页不显示任何具体船舶或单票货物事实。'));
  return panel;
}

function createMapBoundary(): HTMLElement {
  const panel = el('section', 'china-factory__panel');
  panel.append(el('h2', undefined, '中国地图与行政区划边界'));
  panel.append(el('p', 'china-factory__subtle', '本阶段提供省→市→区县的可审计文本筛选。未经单独审计的行政区划 geometry 不在此页绘制，避免把未验证或敏感边界当作官方制图。'));
  panel.append(el('div', 'china-factory__map-boundary', '未装载经审计的行政边界图层；不会以装饰性地图替代合法边界数据。'));
  return panel;
}

function downloadCurrentView(state: ChinaFactoryState): void {
  const cluster = chinaFactoryClusterById(state.filters.clusterId);
  const rows = selectObservedChinaFactoryTrade(asTradeRecords(state.records), state.filters);
  const header = ['evidence_level', 'cluster_id', 'period', 'hs2', 'reporter_code', 'partner_code', 'partner_name', 'cmd_code', 'trade_value_usd', 'net_weight_kg'];
  const values = rows.map((flow) => [
    'OBSERVED_OFFICIAL', cluster.id, state.filters.period, state.filters.hs2,
    flow.reporterCode, flow.partnerCode, flow.partnerName, flow.cmdCode,
    String(flow.tradeValueUsd), String(flow.netWeightKg),
  ]);
  if (values.length === 0) values.push([
    'NO_VALUE_BEARING_RECORD', cluster.id, state.filters.period, state.filters.hs2,
    '', '', '', '', '', '',
  ]);
  const encode = (cells: readonly string[]) => cells.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(',');
  const blob = new Blob([[encode(header), ...values.map(encode)].join('\n') + '\n'], { type: 'text/csv;charset=utf-8' });
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = `china-factory-${cluster.id}-${state.filters.period}-hs${state.filters.hs2}.csv`;
  link.click();
  URL.revokeObjectURL(href);
}

function render(root: HTMLElement, state: ChinaFactoryState): void {
  root.replaceChildren();
  const cluster = chinaFactoryClusterById(state.filters.clusterId);
  const page = el('main', 'china-factory');
  const shell = el('div', 'china-factory__shell');
  const header = el('header', 'china-factory__header');
  const title = el('div');
  title.append(el('p', 'china-factory__eyebrow', PRIMARY_BRAND), el('h1', undefined, '中国世界工厂 · 产业集群与贸易证据'));
  const actions = el('div', 'china-factory__actions');
  const home = el('a', 'china-factory__button', '返回全球地图');
  home.href = '/';
  actions.append(button('下载当前视图 CSV', () => downloadCurrentView(state)), home);
  header.append(title, actions);
  shell.append(header);

  const truth = el('section', 'china-factory__truth');
  truth.append(
    el('strong', undefined, '真实性规则'),
    el('p', undefined, '官方集群资料、国家级贸易统计、模型估计和商业提单是四类不同证据。本页不从 AIS、港口距离或新闻相关性推断某镇货物装上某船。'),
  );
  shell.append(truth);

  const form = el('form', 'china-factory__filters');
  const clusterLabel = el('label', undefined, '产业集群');
  const clusterSelect = document.createElement('select');
  clusterSelect.name = 'cluster';
  for (const optionCluster of CHINA_FACTORY_CLUSTERS) {
    const option = document.createElement('option');
    option.value = optionCluster.id;
    option.textContent = `${optionCluster.name}${optionCluster.statisticsEligible ? '' : '（仅名录，不统计）'}`;
    option.selected = optionCluster.id === cluster.id;
    clusterSelect.append(option);
  }
  clusterLabel.append(clusterSelect);
  const periodLabel = el('label', undefined, '统计年');
  const periodInput = document.createElement('input');
  periodInput.name = 'period';
  periodInput.value = state.filters.period;
  periodInput.inputMode = 'numeric';
  periodInput.pattern = '20[0-9]{2}';
  periodInput.maxLength = 4;
  periodLabel.append(periodInput);
  const hsLabel = el('label', undefined, 'HS2');
  const hsInput = document.createElement('input');
  hsInput.name = 'hs2';
  hsInput.value = state.filters.hs2;
  hsInput.inputMode = 'numeric';
  hsInput.pattern = '[0-9]{2}';
  hsInput.maxLength = 2;
  hsLabel.append(hsInput);
  const submit = button('应用同一筛选条件', () => {});
  submit.type = 'submit';
  form.append(clusterLabel, periodLabel, hsLabel, submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = new FormData(form);
    const url = chinaFactoryUrl({
      clusterId: String(values.get('cluster') ?? ''),
      period: String(values.get('period') ?? ''),
      hs2: String(values.get('hs2') ?? ''),
    });
    history.pushState({}, '', url);
    state.filters = chinaFactoryFiltersFromSearch(location.search);
    void load(root, state);
  });
  shell.append(form);

  const grid = el('div', 'china-factory__grid');
  grid.append(createSourceCard(cluster), createMapBoundary(), createPortAndShipmentBoundary(cluster));
  shell.append(grid, createObservedTradePanel(state, cluster));
  const footer = el('footer', 'china-factory__footer', `当前筛选：${cluster.name} / ${state.filters.period} / HS${state.filters.hs2}。所有数值面板使用同一筛选条件；没有可验证记录时保持为空。`);
  shell.append(footer);
  page.append(shell);
  root.append(page);
}

async function load(root: HTMLElement, state: ChinaFactoryState): Promise<void> {
  state.loading = true;
  render(root, state);
  const response = await fetchComtradeFlows();
  state.records = response.flows;
  state.fetchedAt = response.fetchedAt;
  state.upstreamUnavailable = response.upstreamUnavailable;
  state.loading = false;
  render(root, state);
}

export async function initChinaFactoryWorkspace(rootId = 'app'): Promise<void> {
  const root = document.getElementById(rootId);
  if (!root) throw new Error(`China factory root #${rootId} was not found.`);
  const state: ChinaFactoryState = {
    filters: chinaFactoryFiltersFromSearch(location.search),
    loading: false,
    records: [],
    fetchedAt: '',
    upstreamUnavailable: false,
  };
  window.addEventListener('popstate', () => {
    state.filters = chinaFactoryFiltersFromSearch(location.search);
    void load(root, state);
  });
  await load(root, state);
}
