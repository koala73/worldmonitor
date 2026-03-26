/**
 * Ireland Data Centers Data
 *
 * Static data for major cloud and data center facilities in Ireland.
 * Ireland hosts ~25% of EU data center capacity.
 */

/**
 * Data center type classification for color coding on the map:
 * - cloud: Cloud service providers (AWS, Azure, Google Cloud, Oracle) - Blue #3B82F6
 * - colocation: Colocation/hosting providers (Equinix, Digital Realty, Servecentric) - Purple #8B5CF6
 * - tech: Tech company owned (Meta, Apple) - Orange #F97316
 * - telecom: Telecom operators (Eir, BT Ireland) - Green #10B981
 */
export type DataCenterType = 'cloud' | 'colocation' | 'tech' | 'telecom';

export interface IrelandDataCenter {
  id: string;
  name: string;
  operator: string;
  type: DataCenterType;
  location: string;
  lat: number;
  lng: number;
  capacity?: string;
  status: 'operational' | 'under-construction' | 'planned';
  description?: string;
  website?: string;
}

/**
 * Color mapping for data center types (used in DeckGLMap.ts)
 */
export const DATA_CENTER_COLORS: Record<DataCenterType, [number, number, number]> = {
  cloud: [59, 130, 246],     // Blue #3B82F6
  colocation: [139, 92, 246], // Purple #8B5CF6
  tech: [249, 115, 22],       // Orange #F97316
  telecom: [16, 185, 129],    // Green #10B981
};

/**
 * Type labels for Legend and Popup display
 */
export const DATA_CENTER_TYPE_LABELS: Record<DataCenterType, string> = {
  cloud: 'Cloud Provider',
  colocation: 'Colocation',
  tech: 'Tech Company',
  telecom: 'Telecom',
};

/**
 * Major data center facilities in Ireland (~25 facilities)
 */
export const IRELAND_DATA_CENTERS: IrelandDataCenter[] = [
  // ========================================
  // ☁️ Cloud Providers (Blue)
  // ========================================

  // Google Cloud
  {
    id: 'google-grange-castle',
    name: 'Google Grange Castle',
    operator: 'Google Cloud',
    type: 'cloud',
    location: 'Clondalkin, Dublin',
    lat: 53.3122,
    lng: -6.3972,
    capacity: '100 MW+',
    status: 'operational',
    description:
      "One of Google's largest European data centers, supporting Google Cloud, YouTube, and Search.",
    website: 'https://www.google.com/about/datacenters/locations/dublin/',
  },
  {
    id: 'google-profile-park',
    name: 'Google Profile Park',
    operator: 'Google Cloud',
    type: 'cloud',
    location: 'Clondalkin, Dublin',
    lat: 53.3175,
    lng: -6.4038,
    status: 'operational',
    description: 'Expansion campus for Google Cloud services in Ireland.',
  },

  // Microsoft Azure
  {
    id: 'microsoft-dublin-dc1',
    name: 'Microsoft Azure Dublin DC1',
    operator: 'Microsoft Azure',
    type: 'cloud',
    location: 'Grange Castle, Dublin',
    lat: 53.3089,
    lng: -6.3989,
    capacity: '80 MW+',
    status: 'operational',
    description:
      'Primary Azure region for Western Europe, supporting Microsoft 365, Azure, and Xbox Live.',
    website: 'https://azure.microsoft.com/explore/global-infrastructure/',
  },
  {
    id: 'microsoft-dublin-dc2',
    name: 'Microsoft Azure Dublin DC2',
    operator: 'Microsoft Azure',
    type: 'cloud',
    location: 'Profile Park, Dublin',
    lat: 53.3156,
    lng: -6.4012,
    status: 'operational',
    description: 'Secondary Azure facility for North Europe region redundancy.',
  },

  // Amazon AWS
  {
    id: 'aws-dublin-az1',
    name: 'AWS eu-west-1a',
    operator: 'Amazon Web Services',
    type: 'cloud',
    location: 'Tallaght, Dublin',
    lat: 53.2859,
    lng: -6.3733,
    status: 'operational',
    description: 'Primary AWS availability zone for eu-west-1 (Ireland) region.',
    website: 'https://aws.amazon.com/about-aws/global-infrastructure/',
  },
  {
    id: 'aws-dublin-az2',
    name: 'AWS eu-west-1b',
    operator: 'Amazon Web Services',
    type: 'cloud',
    location: 'Profile Park, Dublin',
    lat: 53.3145,
    lng: -6.4025,
    status: 'operational',
    description: 'Secondary AWS availability zone for eu-west-1 region.',
  },
  {
    id: 'aws-dublin-az3',
    name: 'AWS eu-west-1c',
    operator: 'Amazon Web Services',
    type: 'cloud',
    location: 'Grange Castle, Dublin',
    lat: 53.3102,
    lng: -6.3955,
    status: 'operational',
    description: 'Third AWS availability zone for eu-west-1 region.',
  },

  // Oracle Cloud
  {
    id: 'oracle-cloud-dublin',
    name: 'Oracle Cloud Dublin',
    operator: 'Oracle Cloud',
    type: 'cloud',
    location: 'Dublin',
    lat: 53.3498,
    lng: -6.2603,
    status: 'operational',
    description: 'Oracle Cloud Infrastructure (OCI) eu-dublin-1 region.',
    website: 'https://www.oracle.com/cloud/cloud-regions/',
  },

  // ========================================
  // 🏢 Colocation Providers (Purple)
  // ========================================

  // Equinix
  {
    id: 'equinix-db1',
    name: 'Equinix DB1',
    operator: 'Equinix',
    type: 'colocation',
    location: 'Blanchardstown, Dublin',
    lat: 53.3889,
    lng: -6.3778,
    capacity: '20 MW',
    status: 'operational',
    description:
      "Carrier-neutral colocation facility, part of Equinix's global interconnection platform.",
    website: 'https://www.equinix.com/data-centers/europe-colocation/ireland-colocation/',
  },
  {
    id: 'equinix-db2',
    name: 'Equinix DB2',
    operator: 'Equinix',
    type: 'colocation',
    location: 'Kilcarbery, Dublin',
    lat: 53.3445,
    lng: -6.3889,
    capacity: '15 MW',
    status: 'operational',
    description: 'Second Equinix colocation facility in Dublin.',
  },
  {
    id: 'equinix-db3',
    name: 'Equinix DB3',
    operator: 'Equinix',
    type: 'colocation',
    location: 'Profile Park, Dublin',
    lat: 53.3167,
    lng: -6.4022,
    capacity: '12 MW',
    status: 'operational',
    description: 'Third Equinix facility in Dublin, focused on cloud on-ramp services.',
  },

  // Digital Realty
  {
    id: 'digital-realty-dub1',
    name: 'Digital Realty DUB10',
    operator: 'Digital Realty',
    type: 'colocation',
    location: 'Clonshaugh, Dublin',
    lat: 53.3956,
    lng: -6.2178,
    capacity: '25 MW',
    status: 'operational',
    description: 'Enterprise-grade colocation and interconnection services.',
    website: 'https://www.digitalrealty.com/data-centers/emea/dublin',
  },
  {
    id: 'digital-realty-dub2',
    name: 'Digital Realty DUB11',
    operator: 'Digital Realty',
    type: 'colocation',
    location: 'Profile Park, Dublin',
    lat: 53.3178,
    lng: -6.4045,
    capacity: '20 MW',
    status: 'operational',
    description: 'Second Digital Realty facility in Dublin.',
  },

  // Servecentric
  {
    id: 'servecentric-blanchardstown',
    name: 'Servecentric Blanchardstown',
    operator: 'Servecentric',
    type: 'colocation',
    location: 'Blanchardstown, Dublin 15',
    lat: 53.3912,
    lng: -6.3745,
    capacity: '10 MW',
    status: 'operational',
    description: 'Irish colocation provider offering managed hosting and cloud services.',
    website: 'https://www.servecentric.com/',
  },

  // EdgeConnex
  {
    id: 'edgeconnex-dublin',
    name: 'EdgeConneX Dublin',
    operator: 'EdgeConneX',
    type: 'colocation',
    location: 'Clonshaugh, Dublin',
    lat: 53.3945,
    lng: -6.2195,
    capacity: '15 MW',
    status: 'operational',
    description: 'Edge data center provider offering low-latency colocation.',
    website: 'https://www.edgeconnex.com/',
  },

  // CyrusOne
  {
    id: 'cyrusone-dublin',
    name: 'CyrusOne Dublin',
    operator: 'CyrusOne',
    type: 'colocation',
    location: 'Profile Park, Dublin',
    lat: 53.3189,
    lng: -6.4055,
    capacity: '18 MW',
    status: 'operational',
    description: 'Enterprise colocation with high-density power and cooling.',
    website: 'https://cyrusone.com/',
  },

  // Vantage
  {
    id: 'vantage-dublin',
    name: 'Vantage Dublin',
    operator: 'Vantage Data Centers',
    type: 'colocation',
    location: 'Profile Park, Dublin',
    lat: 53.3195,
    lng: -6.4068,
    capacity: '20 MW',
    status: 'operational',
    description: 'Hyperscale colocation provider serving enterprise and cloud customers.',
    website: 'https://vantage-dc.com/',
  },

  // ========================================
  // 📱 Tech Company Owned (Orange)
  // ========================================

  // Meta/Facebook
  {
    id: 'meta-clonee',
    name: 'Meta Clonee Data Center',
    operator: 'Meta (Facebook)',
    type: 'tech',
    location: 'Clonee, Co. Meath',
    lat: 53.4119,
    lng: -6.4447,
    capacity: '150 MW+',
    status: 'operational',
    description:
      "Meta's first international data center, serving Facebook, Instagram, and WhatsApp for EMEA.",
    website: 'https://datacenters.fb.com/locations/clonee/',
  },

  // Apple
  {
    id: 'apple-athenry',
    name: 'Apple Athenry Data Center',
    operator: 'Apple',
    type: 'tech',
    location: 'Athenry, Co. Galway',
    lat: 53.2967,
    lng: -8.7512,
    capacity: '200 MW (planned)',
    status: 'under-construction',
    description: 'Apple iCloud data center for European customers (project resumed).',
    website: 'https://www.apple.com/environment/',
  },

  // ========================================
  // 📡 Telecom Operators (Green)
  // ========================================

  // Eir
  {
    id: 'eir-parkwest',
    name: 'Eir Park West',
    operator: 'Eir',
    type: 'telecom',
    location: 'Park West, Dublin 12',
    lat: 53.3378,
    lng: -6.3912,
    status: 'operational',
    description: "Ireland's largest telecom operator data center, backbone of national network.",
    website: 'https://www.eir.ie/business/',
  },
  {
    id: 'eir-citywest',
    name: 'Eir Citywest',
    operator: 'Eir',
    type: 'telecom',
    location: 'Citywest, Dublin 24',
    lat: 53.2845,
    lng: -6.4123,
    status: 'operational',
    description: 'Secondary Eir facility for network redundancy and enterprise services.',
  },

  // BT Ireland
  {
    id: 'bt-ireland-dublin',
    name: 'BT Ireland Dublin',
    operator: 'BT Ireland',
    type: 'telecom',
    location: 'Grand Canal, Dublin 4',
    lat: 53.3389,
    lng: -6.2356,
    status: 'operational',
    description: 'BT enterprise services data center supporting multinational customers.',
    website: 'https://www.btireland.com/',
  },

  // GlobalConnect
  {
    id: 'globalconnect-dublin',
    name: 'GlobalConnect Dublin',
    operator: 'GlobalConnect',
    type: 'telecom',
    location: 'Clonshaugh, Dublin',
    lat: 53.3967,
    lng: -6.2189,
    status: 'operational',
    description: 'Nordic telecom provider with fiber connectivity to mainland Europe.',
    website: 'https://globalconnect.com/',
  },
];
