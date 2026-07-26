export const CHINA_CORRIDOR_SIGNAL_FAMILIES = [
  'port',
  'aviation',
  'hazard',
  'power_energy',
  'strategic_industry',
  'trade',
] as const;

export type ChinaCorridorSignalFamily = (typeof CHINA_CORRIDOR_SIGNAL_FAMILIES)[number];

export const CHINA_LOGISTICS_CORRIDOR_IDS = [
  'china-yangtze-river-delta',
  'china-greater-bay-area',
  'china-bohai-rim',
  'china-western-land-sea-corridor',
] as const;

export type ChinaLogisticsCorridorId = (typeof CHINA_LOGISTICS_CORRIDOR_IDS)[number];

export const CHINA_CORRIDOR_NODE_TYPES = [
  'port',
  'airport',
  'crossing',
  'industrial',
] as const;

export type ChinaCorridorNodeType = (typeof CHINA_CORRIDOR_NODE_TYPES)[number];

export interface ChinaCorridorPoint {
  lat: number;
  lon: number;
}

export interface ChinaCorridorNode extends ChinaCorridorPoint {
  id: string;
  name: string;
  type: ChinaCorridorNodeType;
  sourceOwner: string;
  sourceSelector?: Readonly<{
    family: ChinaCorridorSignalFamily;
    id: string;
  }>;
}

export interface ChinaCorridorSourceSelector {
  family: ChinaCorridorSignalFamily;
  id: string;
}

export interface ChinaLogisticsCorridor {
  id: ChinaLogisticsCorridorId;
  name: string;
  description: string;
  boundary: readonly ChinaCorridorPoint[];
  nodes: readonly ChinaCorridorNode[];
  signalFamilies: readonly ChinaCorridorSignalFamily[];
  sourceSelectors: readonly ChinaCorridorSourceSelector[];
}

const allSignalFamilies = [...CHINA_CORRIDOR_SIGNAL_FAMILIES] as const;

function node(
  id: string,
  name: string,
  type: ChinaCorridorNodeType,
  lat: number,
  lon: number,
  sourceOwner: string,
  sourceSelector?: ChinaCorridorNode['sourceSelector'],
): ChinaCorridorNode {
  return { id: `china-node:${id}`, name, type, lat, lon, sourceOwner, sourceSelector };
}

function selectorsFromNodes(nodes: readonly ChinaCorridorNode[]): ChinaCorridorSourceSelector[] {
  return nodes.flatMap((item) => item.sourceSelector ? [item.sourceSelector] : []);
}

function corridor(
  definition: Omit<ChinaLogisticsCorridor, 'signalFamilies' | 'sourceSelectors'> & {
    sourceSelectors?: readonly ChinaCorridorSourceSelector[];
  },
): ChinaLogisticsCorridor {
  const sourceSelectors = [
    ...selectorsFromNodes(definition.nodes),
    ...(definition.sourceSelectors ?? []),
  ];
  return Object.freeze({
    ...definition,
    signalFamilies: allSignalFamilies,
    sourceSelectors: Object.freeze(sourceSelectors),
  });
}

const yrdNodes = [
  node('yrd-port-shanghai', 'Shanghai', 'port', 31.1918, 121.6442, 'IMF PortWatch', { family: 'port', id: 'port1188' }),
  node('yrd-port-yangshan', 'Shanghai Yangshan', 'port', 30.6151, 122.0748, 'IMF PortWatch', { family: 'port', id: 'port2027' }),
  node('yrd-port-ningbo', 'Ningbo', 'port', 29.9208, 121.8818, 'IMF PortWatch', { family: 'port', id: 'port824' }),
  node('yrd-port-zhoushan', 'Zhoushan', 'port', 30.0564, 122.1008, 'IMF PortWatch', { family: 'port', id: 'port1429' }),
  node('yrd-port-taicang', 'Suzhou Taicang', 'port', 31.65, 121.2, 'IMF PortWatch', { family: 'port', id: 'port1253' }),
  node('yrd-port-nanjing', 'Nanjing', 'port', 32.08, 118.77, 'IMF PortWatch', { family: 'port', id: 'port2020' }),
  node('yrd-airport-pvg', 'Shanghai Pudong International', 'airport', 31.1443, 121.8083, 'AviationStack', { family: 'aviation', id: 'PVG' }),
  node('yrd-industry-shanghai', 'Shanghai advanced manufacturing cluster', 'industrial', 31.2304, 121.4737, 'Reviewed WorldMonitor configuration'),
  node('yrd-industry-suzhou', 'Suzhou industrial cluster', 'industrial', 31.2989, 120.5853, 'Reviewed WorldMonitor configuration'),
  node('yrd-industry-ningbo', 'Ningbo-Zhoushan industrial cluster', 'industrial', 29.8683, 121.5440, 'Reviewed WorldMonitor configuration'),
] as const;

const gbaNodes = [
  node('gba-port-shekou', 'Shekou Shenzhen', 'port', 22.47, 113.90, 'IMF PortWatch', { family: 'port', id: 'port1189' }),
  node('gba-port-yantian', 'Yantian', 'port', 22.58, 114.27, 'IMF PortWatch', { family: 'port', id: 'port1414' }),
  node('gba-port-mawan', 'Mawan', 'port', 22.49, 113.87, 'IMF PortWatch', { family: 'port', id: 'port2028' }),
  node('gba-port-dachan-bay', 'Dachan Bay', 'port', 22.55, 113.80, 'IMF PortWatch', { family: 'port', id: 'port2029' }),
  node('gba-port-qianhai-bay', 'Qianhai Bay', 'port', 22.53, 113.89, 'IMF PortWatch', { family: 'port', id: 'port2030' }),
  node('gba-port-nansha', 'Guangzhou Nansha', 'port', 22.63, 113.67, 'IMF PortWatch', { family: 'port', id: 'port425' }),
  node('gba-port-huangpu', 'Guangzhou Huangpu', 'port', 23.10, 113.46, 'IMF PortWatch', { family: 'port', id: 'port2401' }),
  node('gba-port-zhuhai', 'Zhuhai', 'port', 22.27, 113.58, 'IMF PortWatch', { family: 'port', id: 'port2112' }),
  node('gba-port-hong-kong', 'Hong Kong', 'port', 22.3351, 114.0967, 'IMF PortWatch', { family: 'port', id: 'port474' }),
  node('gba-airport-can', 'Guangzhou Baiyun International', 'airport', 23.3924, 113.2988, 'AviationStack', { family: 'aviation', id: 'CAN' }),
  node('gba-airport-szx', 'Shenzhen Bao’an International', 'airport', 22.6393, 113.8107, 'AviationStack', { family: 'aviation', id: 'SZX' }),
  node('gba-airport-hkg', 'Hong Kong International', 'airport', 22.3080, 113.9185, 'AviationStack', { family: 'aviation', id: 'HKG' }),
  node('gba-industry-shenzhen', 'Shenzhen technology manufacturing cluster', 'industrial', 22.5431, 114.0579, 'Reviewed WorldMonitor configuration'),
  node('gba-industry-guangzhou', 'Guangzhou-Foshan industrial cluster', 'industrial', 23.1291, 113.2644, 'Reviewed WorldMonitor configuration'),
  node('gba-industry-hong-kong', 'Hong Kong trade and finance gateway', 'industrial', 22.3193, 114.1694, 'Reviewed WorldMonitor configuration'),
] as const;

const bohaiNodes = [
  node('bohai-port-qingdao', 'Qingdao', 'port', 36.07, 120.32, 'IMF PortWatch', { family: 'port', id: 'port1069' }),
  node('bohai-port-tianjin', 'Tianjin Xin Gang', 'port', 38.98, 117.75, 'IMF PortWatch', { family: 'port', id: 'port1297' }),
  node('bohai-port-qinhuangdao', 'Qinhuangdao', 'port', 39.91, 119.60, 'IMF PortWatch', { family: 'port', id: 'port1072' }),
  node('bohai-port-tangshan', 'Tangshan Jingtang', 'port', 39.22, 119.00, 'IMF PortWatch', { family: 'port', id: 'port1266' }),
  node('bohai-port-shougang', 'Shougang Jingtang', 'port', 39.20, 119.00, 'IMF PortWatch', { family: 'port', id: 'port1195' }),
  node('bohai-port-dalian', 'Dalian', 'port', 38.92, 121.64, 'IMF PortWatch', { family: 'port', id: 'port273' }),
  node('bohai-port-huanghua', 'Huanghua', 'port', 38.32, 117.87, 'IMF PortWatch', { family: 'port', id: 'port154' }),
  node('bohai-airport-pek', 'Beijing Capital International', 'airport', 40.0799, 116.6031, 'AviationStack', { family: 'aviation', id: 'PEK' }),
  node('bohai-industry-beijing-tianjin', 'Beijing-Tianjin industrial cluster', 'industrial', 39.50, 117.20, 'Reviewed WorldMonitor configuration'),
  node('bohai-industry-shandong', 'Shandong manufacturing cluster', 'industrial', 36.6512, 117.1201, 'Reviewed WorldMonitor configuration'),
  node('bohai-industry-liaoning', 'Liaoning heavy-industry cluster', 'industrial', 41.8057, 123.4315, 'Reviewed WorldMonitor configuration'),
] as const;

const westernNodes = [
  node('western-port-qinzhou', 'Qinzhou', 'port', 21.6788, 108.6383, 'IMF PortWatch', { family: 'port', id: 'port1071' }),
  node('western-port-fangcheng', 'Fangcheng', 'port', 21.6142, 108.3643, 'IMF PortWatch', { family: 'port', id: 'port339' }),
  node('western-port-beibu-gulf', 'Guangxi Beibu Gulf Port', 'port', 21.5109, 109.5385, 'IMF PortWatch', { family: 'port', id: 'port424' }),
  node('western-airport-ctu', 'Chengdu Shuangliu International', 'airport', 30.5785, 103.9471, 'AviationStack', { family: 'aviation', id: 'CTU' }),
  node('western-airport-kmg', 'Kunming Changshui International', 'airport', 25.1019, 102.9292, 'AviationStack', { family: 'aviation', id: 'KMG' }),
  node('western-airport-urc', 'Ürümqi Diwopu International', 'airport', 43.9071, 87.4742, 'AviationStack', { family: 'aviation', id: 'URC' }),
  node('western-crossing-khorgos', 'Khorgos land crossing', 'crossing', 44.2140, 80.4100, 'Reviewed WorldMonitor configuration'),
  node('western-crossing-alashankou', 'Alashankou land crossing', 'crossing', 45.1700, 82.5700, 'Reviewed WorldMonitor configuration'),
  node('western-crossing-pingxiang', 'Pingxiang land crossing', 'crossing', 22.1080, 106.7560, 'Reviewed WorldMonitor configuration'),
  node('western-industry-chengdu', 'Chengdu manufacturing cluster', 'industrial', 30.5728, 104.0668, 'Reviewed WorldMonitor configuration'),
  node('western-industry-chongqing', 'Chongqing manufacturing cluster', 'industrial', 29.5630, 106.5516, 'Reviewed WorldMonitor configuration'),
  node('western-industry-urumqi', 'Ürümqi western logistics hub', 'industrial', 43.8256, 87.6168, 'Reviewed WorldMonitor configuration'),
] as const;

export const CHINA_LOGISTICS_CORRIDORS: readonly ChinaLogisticsCorridor[] = Object.freeze([
  corridor({
    id: 'china-yangtze-river-delta',
    name: 'Yangtze River Delta',
    description: 'Reviewed coastal logistics corridor joining Shanghai, Jiangsu, and Zhejiang port, aviation, and advanced-manufacturing nodes.',
    boundary: Object.freeze([
      { lat: 28.4, lon: 118.2 },
      { lat: 28.4, lon: 123.2 },
      { lat: 33.4, lon: 123.2 },
      { lat: 33.4, lon: 118.2 },
      { lat: 28.4, lon: 118.2 },
    ]),
    nodes: yrdNodes,
  }),
  corridor({
    id: 'china-greater-bay-area',
    name: 'Greater Bay Area',
    description: 'Reviewed Pearl River Delta corridor connecting Guangdong, Hong Kong, and Macao-facing port, airport, and industrial gateways.',
    boundary: Object.freeze([
      { lat: 20.5, lon: 111.5 },
      { lat: 20.5, lon: 115.8 },
      { lat: 24.8, lon: 115.8 },
      { lat: 24.8, lon: 111.5 },
      { lat: 20.5, lon: 111.5 },
    ]),
    nodes: gbaNodes,
    sourceSelectors: [{ family: 'hazard', id: 'hazard:hko-warnings' }],
  }),
  corridor({
    id: 'china-bohai-rim',
    name: 'Bohai Rim',
    description: 'Reviewed northern maritime-industrial corridor spanning Beijing-Tianjin, Hebei, Shandong, Liaoning, and their major gateways.',
    boundary: Object.freeze([
      { lat: 35.5, lon: 116.0 },
      { lat: 35.5, lon: 123.5 },
      { lat: 42.2, lon: 123.5 },
      { lat: 42.2, lon: 116.0 },
      { lat: 35.5, lon: 116.0 },
    ]),
    nodes: bohaiNodes,
  }),
  corridor({
    id: 'china-western-land-sea-corridor',
    name: 'Western Land-Sea Corridor',
    description: 'Reviewed western corridor linking inland manufacturing hubs, Xinjiang land crossings, and Guangxi gateways to regional and maritime routes.',
    boundary: Object.freeze([
      { lat: 20.4, lon: 106.2 },
      { lat: 20.4, lon: 110.4 },
      { lat: 32.5, lon: 110.4 },
      { lat: 47.0, lon: 91.0 },
      { lat: 47.0, lon: 78.5 },
      { lat: 41.0, lon: 78.5 },
      { lat: 27.0, lon: 99.7 },
      { lat: 22.0, lon: 105.8 },
      { lat: 20.4, lon: 106.2 },
    ]),
    nodes: westernNodes,
  }),
]);

const NATIONAL_SOURCE_SELECTORS: readonly ChinaCorridorSourceSelector[] = Object.freeze([
  { family: 'power_energy', id: 'energy:spine:v1:CN' },
  { family: 'strategic_industry', id: 'comtrade:reporter:156:strategic-products' },
  { family: 'trade', id: 'comtrade:reporter:156' },
  { family: 'trade', id: 'supply_chain:shipping:v2:CCFI' },
]);

export function findCorridorsForSourceSelector(
  family: ChinaCorridorSignalFamily,
  selectorId: string,
): ChinaLogisticsCorridorId[] {
  if (NATIONAL_SOURCE_SELECTORS.some((selector) =>
    selector.family === family && selector.id === selectorId)) {
    return [...CHINA_LOGISTICS_CORRIDOR_IDS];
  }
  return CHINA_LOGISTICS_CORRIDORS
    .filter((item) => item.sourceSelectors.some((selector) =>
      selector.family === family && selector.id === selectorId))
    .map((item) => item.id);
}

function pointOnSegment(point: ChinaCorridorPoint, a: ChinaCorridorPoint, b: ChinaCorridorPoint): boolean {
  if (a.lat === b.lat && a.lon === b.lon) {
    return point.lat === a.lat && point.lon === a.lon;
  }
  const cross = (point.lon - a.lon) * (b.lat - a.lat) - (point.lat - a.lat) * (b.lon - a.lon);
  if (Math.abs(cross) > 1e-9) return false;
  const dot = (point.lon - a.lon) * (b.lon - a.lon) + (point.lat - a.lat) * (b.lat - a.lat);
  if (dot < 0) return false;
  const squaredLength = (b.lon - a.lon) ** 2 + (b.lat - a.lat) ** 2;
  return dot <= squaredLength;
}

function pointInPolygon(point: ChinaCorridorPoint, polygon: readonly ChinaCorridorPoint[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index];
    const b = polygon[previous];
    if (!a || !b) continue;
    if (pointOnSegment(point, a, b)) return true;
    const intersects = (a.lat > point.lat) !== (b.lat > point.lat)
      && point.lon < ((b.lon - a.lon) * (point.lat - a.lat)) / (b.lat - a.lat) + a.lon;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function resolveCorridorForPoint(point: ChinaCorridorPoint): ChinaLogisticsCorridorId | null {
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return null;
  const matches = CHINA_LOGISTICS_CORRIDORS.filter((item) => pointInPolygon(point, item.boundary));
  return matches.length === 1 ? matches[0]?.id ?? null : null;
}
