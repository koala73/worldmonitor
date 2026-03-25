/**
 * Ireland AI Companies Data
 *
 * Leading AI companies with offices in Ireland.
 * Includes frontier AI labs and major AI research companies.
 */

export interface IrelandAICompany {
  id: string;
  name: string;
  type: 'ai-lab' | 'ai-research' | 'ai-product';
  location: string;
  lat: number;
  lng: number;
  employees?: number;
  address?: string;
  founded?: number;
  website?: string;
  description?: string;
  products?: string[];
}

/**
 * AI companies with Ireland offices
 */
export const IRELAND_AI_COMPANIES: IrelandAICompany[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    type: 'ai-lab',
    location: 'Dublin',
    lat: 53.3398,
    lng: -6.2392,
    employees: 200,
    address: '6th Floor, South Bank House, Barrow Street, Dublin 4',
    founded: 2021,
    website: 'https://www.anthropic.com',
    description:
      'AI safety company and creator of Claude. European headquarters focusing on research and operations.',
    products: ['Claude AI', 'Constitutional AI'],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    type: 'ai-lab',
    location: 'Dublin',
    lat: 53.3498,
    lng: -6.2503,
    employees: 100,
    address: 'The Liffey Trust Centre, 117-126 Sheriff Street Upper, Dublin 1',
    founded: 2015,
    website: 'https://openai.com',
    description:
      'Creator of ChatGPT and GPT-4. European operations and support center.',
    products: ['ChatGPT', 'GPT-4', 'DALL-E', 'Whisper'],
  },
  {
    id: 'xai',
    name: 'xAI',
    type: 'ai-lab',
    location: 'Dublin',
    lat: 53.3381,
    lng: -6.2504,
    employees: 50,
    address: 'One Cumberland Place, Fenian Street, Dublin 2',
    founded: 2023,
    website: 'https://x.ai',
    description:
      "Elon Musk's AI company, creator of Grok. Irish entity established for European operations.",
    products: ['Grok AI'],
  },
];
