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
];
