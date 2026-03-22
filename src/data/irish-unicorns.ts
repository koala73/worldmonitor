/**
 * Irish Unicorns and High-Growth Companies Data
 *
 * Local Irish tech companies that have achieved unicorn status ($1B+ valuation)
 * or significant growth/exits. Distinct from multinational EMEA HQs.
 */

export interface IrishUnicorn {
  id: string;
  name: string;
  location: string;
  lat: number;
  lng: number;
  category: 'unicorn' | 'high-growth' | 'emerging';
  sector: string;
  founded: number;
  employees?: number;
  valuation?: string;
  status?: string;
  description?: string;
  website?: string;
}

/**
 * Irish unicorns and high-growth tech companies
 */
export const IRISH_UNICORNS: IrishUnicorn[] = [
  // Unicorns ($1B+ valuation)
  {
    id: 'intercom',
    name: 'Intercom',
    location: 'Dublin',
    lat: 53.3467,
    lng: -6.2389,
    category: 'unicorn',
    sector: 'SaaS',
    founded: 2011,
    employees: 800,
    valuation: '$1.3B',
    description:
      'Customer communication platform used by 25,000+ businesses worldwide. Founded by Irish entrepreneurs.',
    website: 'https://www.intercom.com',
  },
  {
    id: 'flipdish',
    name: 'Flipdish',
    location: 'Dublin',
    lat: 53.3423,
    lng: -6.2412,
    category: 'unicorn',
    sector: 'FoodTech',
    founded: 2015,
    employees: 500,
    valuation: '$1.2B',
    description: 'Digital ordering platform for restaurants, used by 10,000+ venues.',
    website: 'https://www.flipdish.com',
  },

  // High-Growth / Major Exits
  {
    id: 'fenergo',
    name: 'Fenergo',
    location: 'Dublin',
    lat: 53.3445,
    lng: -6.2378,
    category: 'high-growth',
    sector: 'FinTech',
    founded: 2009,
    employees: 1000,
    valuation: '$800M',
    description: 'Client lifecycle management for financial institutions. Serves 90+ global banks.',
    website: 'https://www.fenergo.com',
  },
  {
    id: 'workvivo',
    name: 'Workvivo',
    location: 'Cork',
    lat: 51.8978,
    lng: -8.4756,
    category: 'high-growth',
    sector: 'HR Tech',
    founded: 2017,
    employees: 200,
    status: 'Acquired by Zoom (€500M+, 2023)',
    description: "Employee experience platform, one of Ireland's biggest tech exits.",
    website: 'https://www.workvivo.com',
  },
  {
    id: 'letsgetchecked',
    name: 'LetsGetChecked',
    location: 'Dublin',
    lat: 53.3489,
    lng: -6.2356,
    category: 'high-growth',
    sector: 'HealthTech',
    founded: 2015,
    employees: 700,
    valuation: '$800M',
    description: 'At-home health testing and virtual care platform.',
    website: 'https://www.letsgetchecked.com',
  },
  {
    id: 'teamwork',
    name: 'Teamwork',
    location: 'Cork',
    lat: 51.8989,
    lng: -8.4767,
    category: 'high-growth',
    sector: 'Project Management',
    founded: 2007,
    employees: 400,
    valuation: '$200M+ ARR',
    description: 'Project management software for client work, bootstrapped to profitability.',
    website: 'https://www.teamwork.com',
  },
  {
    id: 'cartrawler',
    name: 'CarTrawler',
    location: 'Dublin',
    lat: 53.3456,
    lng: -6.2422,
    category: 'high-growth',
    sector: 'TravelTech',
    founded: 2004,
    employees: 500,
    valuation: '$1B+ revenue',
    description: 'B2B car rental platform powering ground transportation for airlines and OTAs.',
    website: 'https://www.cartrawler.com',
  },

  // Emerging Stars
  {
    id: 'tines',
    name: 'Tines',
    location: 'Dublin',
    lat: 53.3445,
    lng: -6.2367,
    category: 'emerging',
    sector: 'Security',
    founded: 2018,
    employees: 200,
    valuation: '$300M+',
    status: 'Series B',
    description: 'No-code security automation platform for enterprise SOC teams.',
    website: 'https://www.tines.com',
  },
  {
    id: 'wayflyer',
    name: 'Wayflyer',
    location: 'Dublin',
    lat: 53.3423,
    lng: -6.2378,
    category: 'emerging',
    sector: 'FinTech',
    founded: 2019,
    employees: 300,
    valuation: '$1.6B (peak)',
    status: 'Series B',
    description: 'Revenue-based financing for ecommerce businesses.',
    website: 'https://www.wayflyer.com',
  },
  {
    id: 'cubic-telecom',
    name: 'Cubic Telecom',
    location: 'Dublin',
    lat: 53.3478,
    lng: -6.2389,
    category: 'high-growth',
    sector: 'IoT/Connectivity',
    founded: 2009,
    employees: 350,
    valuation: '$500M+',
    description: 'Connectivity platform for automotive and IoT, partners with Audi, VW, BMW.',
    website: 'https://www.cubictelecom.com',
  },
];
