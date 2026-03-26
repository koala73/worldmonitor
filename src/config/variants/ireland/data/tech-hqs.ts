/**
 * Ireland Tech HQs Data
 *
 * Major multinational tech companies with EMEA headquarters in Ireland.
 * Ireland hosts EMEA HQs for Google, Meta, Apple, Microsoft, and many others.
 */

export interface IrelandTechHQ {
  id: string;
  company: string;
  type: 'emea-hq' | 'european-hq' | 'intl-hq';
  location: string;
  lat: number;
  lng: number;
  employees?: number;
  address?: string;
  founded?: number;
  website?: string;
  description?: string;
}

/**
 * Major tech company EMEA headquarters in Ireland
 */
export const IRELAND_TECH_HQS: IrelandTechHQ[] = [
  // Big Tech
  {
    id: 'google-emea',
    company: 'Google',
    type: 'emea-hq',
    location: 'Dublin',
    lat: 53.3389,
    lng: -6.2492,
    employees: 8000,
    address: 'Gordon House, Barrow Street, Dublin 4',
    founded: 2003,
    website: 'https://about.google/locations/dublin/',
    description:
      "Google's EMEA headquarters, home to engineering, sales, and operations for Europe, Middle East, and Africa.",
  },
  {
    id: 'meta-ireland',
    company: 'Meta (Facebook)',
    type: 'intl-hq',
    location: 'Dublin',
    lat: 53.3456,
    lng: -6.2389,
    employees: 5000,
    address: 'Grand Canal Square, Dublin 2',
    founded: 2008,
    website: 'https://www.meta.com/ie/',
    description:
      "Meta's international headquarters, managing Facebook, Instagram, WhatsApp for EMEA markets.",
  },
  {
    id: 'apple-cork',
    company: 'Apple',
    type: 'emea-hq',
    location: 'Cork',
    lat: 51.8831,
    lng: -8.4878,
    employees: 6000,
    address: 'Hollyhill Industrial Estate, Cork',
    founded: 1980,
    website: 'https://www.apple.com/ie/',
    description:
      "Apple's first operations outside the US, now EMEA headquarters for manufacturing and operations.",
  },
  {
    id: 'microsoft-dublin',
    company: 'Microsoft',
    type: 'emea-hq',
    location: 'Dublin',
    lat: 53.2778,
    lng: -6.3514,
    employees: 2500,
    address: 'South County Business Park, Dublin 18',
    founded: 1985,
    website: 'https://www.microsoft.com/en-ie/',
    description:
      "Microsoft's EMEA operations center, supporting Azure, Office 365, and Xbox services.",
  },
  {
    id: 'linkedin-dublin',
    company: 'LinkedIn',
    type: 'emea-hq',
    location: 'Dublin',
    lat: 53.3467,
    lng: -6.2378,
    employees: 1200,
    address: 'Gardner House, Wilton Place, Dublin 2',
    founded: 2010,
    website: 'https://www.linkedin.com/',
    description: "LinkedIn's EMEA headquarters, supporting professional networking across Europe.",
  },

  // Fintech
  {
    id: 'stripe-dublin',
    company: 'Stripe',
    type: 'emea-hq',
    location: 'Dublin',
    lat: 53.3456,
    lng: -6.2411,
    employees: 1000,
    address: 'The One Building, Grand Canal Street',
    founded: 2011,
    website: 'https://stripe.com/ie',
    description:
      "Stripe's European headquarters, managing payment infrastructure for millions of businesses.",
  },
  {
    id: 'paypal-dublin',
    company: 'PayPal',
    type: 'european-hq',
    location: 'Dublin',
    lat: 53.3456,
    lng: -6.2444,
    employees: 2000,
    address: 'Ballycoolin Business Park, Dublin 15',
    founded: 2003,
    website: 'https://www.paypal.com/ie/',
    description: "PayPal's European headquarters, processing billions in payments annually.",
  },

  // SaaS & Enterprise
  {
    id: 'salesforce-dublin',
    company: 'Salesforce',
    type: 'emea-hq',
    location: 'Dublin',
    lat: 53.3434,
    lng: -6.2401,
    employees: 1500,
    address: 'Spencer Place, Spencer Dock, Dublin 1',
    founded: 2000,
    website: 'https://www.salesforce.com/ie/',
    description: "Salesforce's EMEA headquarters, supporting enterprise CRM across Europe.",
  },
  {
    id: 'hubspot-dublin',
    company: 'HubSpot',
    type: 'emea-hq',
    location: 'Dublin',
    lat: 53.3478,
    lng: -6.2356,
    employees: 1500,
    address: 'One Dockland Central, Guild Street, Dublin 1',
    founded: 2013,
    website: 'https://www.hubspot.com/',
    description: "HubSpot's EMEA headquarters, providing marketing and sales software.",
  },
  {
    id: 'zendesk-dublin',
    company: 'Zendesk',
    type: 'emea-hq',
    location: 'Dublin',
    lat: 53.3423,
    lng: -6.2412,
    employees: 500,
    address: '55 Charlemont Place, Dublin 2',
    founded: 2012,
    website: 'https://www.zendesk.com/',
    description: "Zendesk's EMEA headquarters for customer service software.",
  },

  // Consumer Tech
  {
    id: 'airbnb-dublin',
    company: 'Airbnb',
    type: 'emea-hq',
    location: 'Dublin',
    lat: 53.3423,
    lng: -6.2367,
    employees: 800,
    address: '8 Hanover Quay, Dublin 2',
    founded: 2012,
    website: 'https://www.airbnb.ie/',
    description:
      "Airbnb's EMEA headquarters, managing accommodation marketplace across Europe and beyond.",
  },
  {
    id: 'dropbox-dublin',
    company: 'Dropbox',
    type: 'emea-hq',
    location: 'Dublin',
    lat: 53.3445,
    lng: -6.2378,
    employees: 400,
    address: 'One Park Place, Hatch Street, Dublin 2',
    founded: 2011,
    website: 'https://www.dropbox.com/',
    description: "Dropbox's EMEA headquarters for cloud storage services.",
  },

  // Telecom & Networking
  {
    id: 'cisco-dublin',
    company: 'Cisco',
    type: 'emea-hq',
    location: 'Dublin',
    lat: 53.3389,
    lng: -6.2412,
    employees: 1500,
    address: 'Harcourt Centre, Dublin 2',
    founded: 2000,
    website: 'https://www.cisco.com/c/en_ie/',
    description:
      "Cisco's EMEA Operations Center, supporting networking and cybersecurity solutions across Europe, Middle East, and Africa.",
  },
  {
    id: 'ericsson-athlone',
    company: 'Ericsson',
    type: 'european-hq',
    location: 'Athlone',
    lat: 53.4239,
    lng: -7.9407,
    employees: 500,
    address: 'Athlone Business Park, Athlone, Co. Westmeath',
    founded: 1998,
    website: 'https://www.ericsson.com/en/about-us/company-facts/ericsson-worldwide/ireland',
    description:
      "Ericsson's Ireland R&D Center, focusing on 5G technology, telecom software, and network solutions.",
  },

  // Monitoring & Observability
  {
    id: 'datadog-dublin',
    company: 'Datadog',
    type: 'emea-hq',
    location: 'Dublin',
    lat: 53.3430,
    lng: -6.2390,
    employees: 200,
    address: "56 John Rogerson's Quay, Grand Canal Dock, Dublin 2",
    founded: 2010,
    website: 'https://www.datadoghq.com',
    description:
      'Cloud monitoring and observability platform. EMEA headquarters managing enterprise customers across Europe.',
  },
  {
    id: 'dynatrace-dublin',
    company: 'Dynatrace',
    type: 'emea-hq',
    location: 'Dublin',
    lat: 53.3515,
    lng: -6.2495,
    employees: 150,
    address: '25 North Wall Quay, IFSC, Dublin 1',
    founded: 2005,
    website: 'https://www.dynatrace.com',
    description:
      'AI-powered application performance monitoring and observability platform for enterprise cloud environments.',
  },
  {
    id: 'splunk-galway',
    company: 'Splunk',
    type: 'european-hq',
    location: 'Galway',
    lat: 53.2667,
    lng: -8.9333,
    employees: 100,
    address: 'Oranmore Business Park, Oranmore, Co. Galway',
    founded: 2003,
    website: 'https://www.splunk.com',
    description:
      'Data analytics and observability platform. Ireland office (now part of Cisco) supporting EMEA operations.',
  },

  // Enterprise Software
  {
    id: 'servicenow-dublin',
    company: 'ServiceNow',
    type: 'emea-hq',
    location: 'Dublin',
    lat: 53.3413,
    lng: -6.2603,
    employees: 600,
    address: '60 Dawson Street, Dublin 2',
    founded: 2004,
    website: 'https://www.servicenow.com',
    description:
      'Enterprise IT service management and digital workflow platform. EMEA headquarters and Centre of Excellence.',
  },
  {
    id: 'workday-dublin',
    company: 'Workday',
    type: 'emea-hq',
    location: 'Dublin',
    lat: 53.3394,
    lng: -6.2594,
    employees: 250,
    address: 'College Square, Dublin 2',
    founded: 2005,
    website: 'https://www.workday.com',
    description:
      'Enterprise cloud applications for HR, finance, and planning. EMEA operations center.',
  },
  {
    id: 'sap-dublin',
    company: 'SAP',
    type: 'emea-hq',
    location: 'Dublin',
    lat: 53.3378,
    lng: -6.2712,
    employees: 1000,
    address: 'Citywest Business Campus, Dublin 24',
    founded: 1972,
    website: 'https://www.sap.com',
    description:
      'Enterprise software giant. Ireland hub for ERP, cloud solutions, and EMEA regional operations.',
  },
  {
    id: 'oracle-dublin',
    company: 'Oracle',
    type: 'emea-hq',
    location: 'Dublin',
    lat: 53.3067,
    lng: -6.2207,
    employees: 2000,
    address: 'Oracle EMEA Campus, East Point Business Park, Dublin 3',
    founded: 1977,
    website: 'https://www.oracle.com',
    description:
      'Database and cloud infrastructure leader. EMEA headquarters managing enterprise operations across the region.',
  },

  // Financial Data
  {
    id: 'bloomberg-dublin',
    company: 'Bloomberg',
    type: 'european-hq',
    location: 'Dublin',
    lat: 53.3330,
    lng: -6.2630,
    employees: 150,
    address: "One Charlemont Square, Saint Kevin's, Dublin 2",
    founded: 1981,
    website: 'https://www.bloomberg.com',
    description:
      'Global financial data and news provider. Dublin office supporting Bloomberg Terminal and data services for EMEA.',
  },
];
