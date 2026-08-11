/**
 * Reviewed registry for the China factory explorer.
 *
 * A registry entry is not a trade flow.  `OBSERVED_OFFICIAL` is limited to the
 * publisher's statement that a cluster/product exists; a value-bearing trade
 * display additionally needs a same-filter UN Comtrade or lawful customs
 * response.  Entries without a reviewed HS mapping remain reference-only.
 */

export const CHINA_FACTORY_EVIDENCE_LEVELS = [
  'OBSERVED_OFFICIAL',
  'MODELLED_ESTIMATE',
  'BILL_OF_LADING_OBSERVED',
  'UNVERIFIED',
] as const;

export type ChinaFactoryEvidenceLevel = (typeof CHINA_FACTORY_EVIDENCE_LEVELS)[number];

export type ChinaFactorySource = Readonly<{
  publisher: string;
  title: string;
  url: string;
  publishedAt: string | null;
}>;

export type ChinaFactoryHsMapping = Readonly<{
  hs2: string;
  label: string;
  evidence: ChinaFactoryEvidenceLevel;
  source: ChinaFactorySource;
}>;

export type ChinaFactoryCluster = Readonly<{
  id: string;
  name: string;
  province: string;
  city: string;
  countyOrDistrict: string;
  productDescription: string;
  clusterEvidence: ChinaFactoryEvidenceLevel;
  source: ChinaFactorySource;
  hsMappings: readonly ChinaFactoryHsMapping[];
  statisticsEligible: boolean;
  statisticsEligibilityReason: string;
}>;

const MIIT_2024_SOURCE: ChinaFactorySource = {
  publisher: '中华人民共和国工业和信息化部',
  title: '工业和信息化部关于2024年度中小企业特色产业集群名单的通告',
  url: 'https://www.miit.gov.cn/zwgk/zcwj/wjfb/tg/art/2024/art_b83397048d374b0d8c51603f6385d7fa.html?app=mb',
  publishedAt: '2024-09-20',
};

const HS64_SOURCE: ChinaFactorySource = {
  publisher: 'United Nations Statistics Division',
  title: 'HS 2012 classification detail, code 64: Footwear; gaiters and the like; parts of such articles',
  url: 'https://unstats.un.org/unsd/classifications/Econ/Structure/Detail/EN/32/64',
  publishedAt: null,
};

const footwearHs2: readonly ChinaFactoryHsMapping[] = [{
  hs2: '64',
  label: 'Footwear; gaiters and the like; parts of such articles',
  evidence: 'OBSERVED_OFFICIAL',
  source: HS64_SOURCE,
}];

function officialReference(
  id: string,
  province: string,
  city: string,
  countyOrDistrict: string,
  name: string,
  productDescription: string,
): ChinaFactoryCluster {
  return {
    id,
    name,
    province,
    city,
    countyOrDistrict,
    productDescription,
    clusterEvidence: 'OBSERVED_OFFICIAL',
    source: MIIT_2024_SOURCE,
    hsMappings: [],
    statisticsEligible: false,
    statisticsEligibilityReason: '官方名录证实集群名称，但尚无逐项审核的 HS 映射证据；不得显示该集群的贸易金额、重量、目的国或港口推断。',
  };
}

/**
 * The 20 reference entries preserve only the published MIIT cluster wording
 * and administrative label.  They are intentionally excluded from numerical
 * statistics until an import supplies reviewed HS evidence.
 */
export const CHINA_FACTORY_REFERENCE_CLUSTERS: readonly ChinaFactoryCluster[] = [
  officialReference('miit-2024-haidian-robotics', '北京市', '北京市', '海淀区', '海淀区机器人产业集群', '机器人产业'),
  officialReference('miit-2024-miyun-measurement', '北京市', '北京市', '密云区', '密云区测控装备产业集群', '测控装备'),
  officialReference('miit-2024-shunyi-aviation', '北京市', '北京市', '顺义区', '顺义区航空装备配套产业集群', '航空装备配套'),
  officialReference('miit-2024-xiqing-energy-equipment', '天津市', '天津市', '西青区', '西青区能源矿产装备产业集群', '能源矿产装备'),
  officialReference('miit-2024-lubei-robotics', '河北省', '唐山市', '路北区', '路北区智能特种机器人产业集群', '智能特种机器人'),
  officialReference('miit-2024-anguo-herbal-medicine', '河北省', '保定市', '安国市', '安国市中药材精深加工产业集群', '中药材精深加工'),
  officialReference('miit-2024-xuanhua-geotechnical', '河北省', '张家口市', '宣化区', '宣化区岩土工程装备产业集群', '岩土工程装备'),
  officialReference('miit-2024-cixian-chemical-material', '河北省', '邯郸市', '磁县', '磁县循环化工新材料产业集群', '循环化工新材料'),
  officialReference('miit-2024-ningjin-cable', '河北省', '邢台市', '宁晋县', '宁晋县中低压及新能源电线电缆产业集群', '中低压及新能源电线电缆'),
  officialReference('miit-2024-zaoqiang-fiberglass', '河北省', '衡水市', '枣强县', '枣强县玻璃纤维增强复合材料产业集群', '玻璃纤维增强复合材料'),
  officialReference('miit-2024-dingxiang-flange', '山西省', '忻州市', '定襄县', '定襄县法兰锻造产业集群', '法兰锻造'),
  officialReference('miit-2024-qingshan-pv', '内蒙古自治区', '包头市', '青山区', '青山区光伏装备产业集群', '光伏装备'),
  officialReference('miit-2024-taihe-alloy', '辽宁省', '锦州市', '太和区', '太和区特种合金产业集群', '特种合金'),
  officialReference('miit-2024-pingfang-aviation', '黑龙江省', '哈尔滨市', '平房区', '平房区航空配套产业集群', '航空配套'),
  officialReference('miit-2024-xuhui-testing', '上海市', '上海市', '徐汇区', '徐汇区检验检测认证产业集群', '检验检测认证'),
  officialReference('miit-2024-pudong-chip', '上海市', '上海市', '浦东新区', '浦东新区高端通用芯片设计产业集群', '高端通用芯片设计'),
  officialReference('miit-2024-minhang-space-info', '上海市', '上海市', '闵行区', '闵行区空间信息产业集群', '空间信息'),
  officialReference('miit-2024-fengxian-cosmetics', '上海市', '上海市', '奉贤区', '奉贤区化妆品产业集群', '化妆品'),
  officialReference('miit-2024-songjiang-satellite', '上海市', '上海市', '松江区', '松江区卫星互联网产业集群', '卫星互联网'),
  officialReference('miit-2024-wuxi-mems', '江苏省', '无锡市', '新吴区', '无锡市新吴区物联网微机电系统传感器产业集群', '物联网微机电系统传感器'),
] as const;

export const CHINA_FACTORY_REVIEWED_CLUSTERS: readonly ChinaFactoryCluster[] = [
  {
    id: 'huidong-womens-footwear',
    name: '广东惠州惠东县女鞋产业集群',
    province: '广东省',
    city: '惠州市',
    countyOrDistrict: '惠东县',
    productDescription: '女鞋（官方工作报告中的“惠东女鞋产业集群”表述）',
    clusterEvidence: 'OBSERVED_OFFICIAL',
    source: {
      publisher: '惠州市惠东县人民政府办公室',
      title: '2020年惠东县政府工作报告',
      url: 'https://www.huidong.gov.cn/gkmlpt/content/3/3899/mpost_3899559.html',
      publishedAt: '2020-06-05',
    },
    hsMappings: footwearHs2,
    statisticsEligible: true,
    statisticsEligibilityReason: '集群事实与 HS2 章节映射均有来源；任何贸易值仍只能来自同一产品/期间的国家级 Comtrade 或用户合法导入数据，不能归因到惠东县单票货物。',
  },
  {
    id: 'putian-licheng-sports-footwear',
    name: '福建莆田荔城区运动休闲鞋产业集群',
    province: '福建省',
    city: '莆田市',
    countyOrDistrict: '荔城区',
    productDescription: '运动休闲鞋（官方投资促进平台对特色产业集群的表述）',
    clusterEvidence: 'OBSERVED_OFFICIAL',
    source: {
      publisher: '福建省投资促进中心',
      title: '聚力做好“一双鞋”——莆田荔城区持续推动鞋业产业高质量发展擦亮“金名片”',
      url: 'https://fdi.swt.fujian.gov.cn/show-22624.html',
      publishedAt: '2025-02-06',
    },
    hsMappings: footwearHs2,
    statisticsEligible: true,
    statisticsEligibilityReason: '集群事实与 HS2 章节映射均有来源；任何贸易值仍只能来自同一产品/期间的国家级 Comtrade 或用户合法导入数据，不能归因到荔城区单票货物。',
  },
] as const;

export const CHINA_FACTORY_CLUSTERS: readonly ChinaFactoryCluster[] = Object.freeze([
  ...CHINA_FACTORY_REVIEWED_CLUSTERS,
  ...CHINA_FACTORY_REFERENCE_CLUSTERS,
]);

export const DEFAULT_CHINA_FACTORY_CLUSTER_ID = 'huidong-womens-footwear';

export function chinaFactoryClusterById(raw: string | null | undefined): ChinaFactoryCluster {
  const id = String(raw ?? '').trim();
  return CHINA_FACTORY_CLUSTERS.find((cluster) => cluster.id === id)
    ?? CHINA_FACTORY_CLUSTERS.find((cluster) => cluster.id === DEFAULT_CHINA_FACTORY_CLUSTER_ID)!;
}

export function chinaFactoryClustersForHs2(hs2: string): readonly ChinaFactoryCluster[] {
  const normalized = String(hs2 ?? '').trim();
  return CHINA_FACTORY_CLUSTERS.filter((cluster) => cluster.hsMappings.some((mapping) => mapping.hs2 === normalized));
}
