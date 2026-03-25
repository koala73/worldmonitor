/**
 * Ireland Universities Data
 *
 * Major universities and research institutions in Ireland.
 * Includes QS World Rankings and student population data.
 */

export interface IrelandUniversity {
  id: string;
  name: string;
  fullName: string;
  location: string;
  lat: number;
  lng: number;
  ranking?: number; // QS World Ranking
  students?: number;
  founded: number;
  specialties?: string[];
  website: string;
  description?: string;
}

/**
 * Major universities in Ireland
 */
export const IRELAND_UNIVERSITIES: IrelandUniversity[] = [
  {
    id: 'trinity-college-dublin',
    name: 'Trinity College Dublin',
    fullName: 'The University of Dublin, Trinity College',
    location: 'Dublin',
    lat: 53.3438,
    lng: -6.2546,
    ranking: 81,
    students: 18000,
    founded: 1592,
    specialties: ['Computer Science', 'Engineering', 'Business', 'AI Research'],
    website: 'https://www.tcd.ie',
    description:
      "Ireland's oldest and most prestigious university. World-renowned research in computer science and AI.",
  },
  {
    id: 'university-college-dublin',
    name: 'University College Dublin',
    fullName: 'University College Dublin',
    location: 'Dublin',
    lat: 53.3088,
    lng: -6.2274,
    ranking: 171,
    students: 33000,
    founded: 1854,
    specialties: ['Business', 'Engineering', 'Medicine', 'AI & Data Science'],
    website: 'https://www.ucd.ie',
    description:
      "Ireland's largest university. Strong research programs in AI, data science, and business.",
  },
  {
    id: 'dublin-city-university',
    name: 'Dublin City University',
    fullName: 'Dublin City University',
    location: 'Dublin',
    lat: 53.3856,
    lng: -6.2568,
    ranking: 436,
    students: 17000,
    founded: 1989,
    specialties: ['Engineering', 'Computer Science', 'Business', 'Entrepreneurship'],
    website: 'https://www.dcu.ie',
    description:
      'Modern research university with strong industry links. Home to ADAPT Centre for AI research.',
  },
  {
    id: 'maynooth-university',
    name: 'Maynooth University',
    fullName: 'National University of Ireland, Maynooth',
    location: 'Maynooth',
    lat: 53.3817,
    lng: -6.5983,
    ranking: 700,
    students: 13000,
    founded: 1997,
    specialties: ['Humanities', 'Science', 'Engineering'],
    website: 'https://www.maynoothuniversity.ie',
    description:
      'Historic campus with roots dating to 1795. Strong programs in science and humanities.',
  },
  {
    id: 'university-college-cork',
    name: 'University College Cork',
    fullName: 'University College Cork',
    location: 'Cork',
    lat: 51.8936,
    lng: -8.4908,
    ranking: 292,
    students: 21000,
    founded: 1845,
    specialties: ['Medicine', 'Engineering', 'Food Science', 'AI Research'],
    website: 'https://www.ucc.ie',
    description:
      "Munster's leading research university. Excellence in medicine, food science, and sustainability.",
  },
  {
    id: 'university-of-galway',
    name: 'University of Galway',
    fullName: 'University of Galway (National University of Ireland, Galway)',
    location: 'Galway',
    lat: 53.2794,
    lng: -9.0628,
    ranking: 289,
    students: 18000,
    founded: 1845,
    specialties: ['Medicine', 'Engineering', 'Marine Science', 'AI'],
    website: 'https://www.universityofgalway.ie',
    description:
      "West of Ireland's research university. Strong in marine science, biomedical engineering, and AI.",
  },
  {
    id: 'university-of-limerick',
    name: 'University of Limerick',
    fullName: 'University of Limerick',
    location: 'Limerick',
    lat: 52.6741,
    lng: -8.5738,
    ranking: 431,
    students: 16000,
    founded: 1972,
    specialties: ['Engineering', 'Business', 'Sports Science', 'Software'],
    website: 'https://www.ul.ie',
    description:
      'Modern campus university. Home to Lero, the Irish Software Research Centre.',
  },
  {
    id: 'tu-dublin',
    name: 'TU Dublin',
    fullName: 'Technological University Dublin',
    location: 'Dublin',
    lat: 53.3556,
    lng: -6.2753,
    students: 28000,
    founded: 2019,
    specialties: ['Applied Technology', 'Engineering', 'Architecture', 'Business'],
    website: 'https://www.tudublin.ie',
    description:
      "Ireland's first technological university. Formed from merger of three institutes of technology.",
  },
  {
    id: 'rcsi',
    name: 'RCSI',
    fullName: 'RCSI University of Medicine and Health Sciences',
    location: 'Dublin',
    lat: 53.3387,
    lng: -6.2582,
    students: 3500,
    founded: 1784,
    specialties: ['Medicine', 'Surgery', 'Nursing', 'Pharmacy'],
    website: 'https://www.rcsi.com',
    description:
      'Leading medical university. Global Top 250 in medicine with campuses worldwide.',
  },
];
