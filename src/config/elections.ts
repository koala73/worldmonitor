/**
 * Global Election Calendar - 2026/2027
 * Used to boost CII scores when elections approach and detect instability risks
 * 
 * Election proximity triggers:
 * - 30 days: Add to "upcoming events" awareness
 * - 7 days: Boost country news correlation sensitivity  
 * - 1 day / Election day: Maximum CII boost
 * 
 * Significance levels:
 * - high: Presidential/national elections in major powers or conflict-prone regions
 * - medium: Parliamentary elections or elections in stable democracies
 * - low: Local elections or low-impact referendums
 */

export type ElectionType = 'presidential' | 'parliamentary' | 'referendum' | 'local' | 'legislative';

export type ElectionSignificance = 'high' | 'medium' | 'low';

export interface Election {
  /** Country name */
  country: string;
  /** ISO 3166-1 alpha-2 country code */
  countryCode: string;
  /** Type of election */
  type: ElectionType;
  /** Election date */
  date: Date;
  /** Geopolitical significance */
  significance: ElectionSignificance;
  /** Additional context or risk factors */
  notes?: string;
}

/**
 * Global elections for 2026 and 2027
 * Sources: IFES, NDI, various news sources
 */
export const ELECTIONS_2026_2027: Election[] = [
  // ============== 2026 ==============
  
  // Q1 2026
  {
    country: 'Iran',
    countryCode: 'IR',
    type: 'presidential',
    date: new Date('2026-06-18'),
    significance: 'high',
    notes: 'Supreme Leader succession tensions; regional proxy conflicts',
  },
  {
    country: 'Mexico',
    countryCode: 'MX',
    type: 'legislative',
    date: new Date('2026-06-07'),
    significance: 'medium',
    notes: 'Mid-term legislative elections; cartel violence monitoring',
  },
  {
    country: 'Philippines',
    countryCode: 'PH',
    type: 'legislative',
    date: new Date('2026-05-11'),
    significance: 'medium',
    notes: 'Mid-term elections; South China Sea tensions',
  },
  {
    country: 'Colombia',
    countryCode: 'CO',
    type: 'legislative',
    date: new Date('2026-03-08'),
    significance: 'medium',
    notes: 'Congressional elections; peace process implications',
  },

  // Q2 2026
  {
    country: 'Brazil',
    countryCode: 'BR',
    type: 'presidential',
    date: new Date('2026-10-04'),
    significance: 'high',
    notes: 'Presidential election; potential political polarization',
  },
  {
    country: 'Australia',
    countryCode: 'AU',
    type: 'parliamentary',
    date: new Date('2026-05-21'),
    significance: 'medium',
    notes: 'Federal election; AUKUS and China policy implications',
  },

  // Q3-Q4 2026
  {
    country: 'United States',
    countryCode: 'US',
    type: 'legislative',
    date: new Date('2026-11-03'),
    significance: 'high',
    notes: 'Midterm elections; House and Senate races; political polarization',
  },
  {
    country: 'Japan',
    countryCode: 'JP',
    type: 'parliamentary',
    date: new Date('2026-07-25'),
    significance: 'medium',
    notes: 'Upper House election; defense policy and Taiwan stance',
  },
  {
    country: 'South Korea',
    countryCode: 'KR',
    type: 'local',
    date: new Date('2026-06-03'),
    significance: 'low',
    notes: 'Local elections; North Korea policy gauge',
  },
  {
    country: 'Czech Republic',
    countryCode: 'CZ',
    type: 'parliamentary',
    date: new Date('2026-10-15'),
    significance: 'medium',
    notes: 'Legislative elections; EU and NATO alignment',
  },
  {
    country: 'Georgia',
    countryCode: 'GE',
    type: 'presidential',
    date: new Date('2026-10-26'),
    significance: 'high',
    notes: 'Presidential election; Russia tensions; EU aspirations',
  },
  {
    country: 'Kazakhstan',
    countryCode: 'KZ',
    type: 'parliamentary',
    date: new Date('2026-03-19'),
    significance: 'medium',
    notes: 'Parliamentary elections; Russia-China balancing act',
  },

  // ============== 2027 ==============
  
  // Q1 2027
  {
    country: 'Germany',
    countryCode: 'DE',
    type: 'parliamentary',
    date: new Date('2027-09-26'),
    significance: 'high',
    notes: 'Federal election; EU leadership, energy policy, defense spending',
  },
  {
    country: 'France',
    countryCode: 'FR',
    type: 'presidential',
    date: new Date('2027-04-23'),
    significance: 'high',
    notes: 'Presidential election; EU leadership, NATO commitment, far-right dynamics',
  },
  {
    country: 'France',
    countryCode: 'FR',
    type: 'presidential',
    date: new Date('2027-05-07'),
    significance: 'high',
    notes: 'Presidential runoff (if needed); second round',
  },
  {
    country: 'South Korea',
    countryCode: 'KR',
    type: 'presidential',
    date: new Date('2027-03-09'),
    significance: 'high',
    notes: 'Presidential election; North Korea policy; US alliance',
  },
  {
    country: 'India',
    countryCode: 'IN',
    type: 'parliamentary',
    date: new Date('2027-05-01'),
    significance: 'high',
    notes: 'General election; world\'s largest democracy; regional power dynamics',
  },

  // Q2-Q3 2027
  {
    country: 'United Kingdom',
    countryCode: 'GB',
    type: 'parliamentary',
    date: new Date('2027-12-17'),
    significance: 'high',
    notes: 'Expected by December 2027; NATO, Ukraine support, trade policy',
  },
  {
    country: 'Kenya',
    countryCode: 'KE',
    type: 'presidential',
    date: new Date('2027-08-09'),
    significance: 'medium',
    notes: 'Presidential election; East Africa stability; election violence history',
  },
  {
    country: 'Argentina',
    countryCode: 'AR',
    type: 'legislative',
    date: new Date('2027-10-24'),
    significance: 'medium',
    notes: 'Legislative elections; economic policy direction',
  },
  {
    country: 'Norway',
    countryCode: 'NO',
    type: 'parliamentary',
    date: new Date('2027-09-13'),
    significance: 'low',
    notes: 'Parliamentary election; Arctic policy, NATO Northern Flank',
  },
  {
    country: 'Angola',
    countryCode: 'AO',
    type: 'presidential',
    date: new Date('2027-08-24'),
    significance: 'medium',
    notes: 'Presidential election; oil economy; Africa regional influence',
  },
  {
    country: 'Rwanda',
    countryCode: 'RW',
    type: 'presidential',
    date: new Date('2027-07-15'),
    significance: 'medium',
    notes: 'Presidential election; DRC tensions; regional stability',
  },
  {
    country: 'Liberia',
    countryCode: 'LR',
    type: 'presidential',
    date: new Date('2027-10-12'),
    significance: 'medium',
    notes: 'Presidential election; West Africa stability',
  },
  {
    country: 'Chile',
    countryCode: 'CL',
    type: 'presidential',
    date: new Date('2027-11-21'),
    significance: 'medium',
    notes: 'Presidential election; lithium policy; regional dynamics',
  },
  {
    country: 'Iran',
    countryCode: 'IR',
    type: 'legislative',
    date: new Date('2027-03-01'),
    significance: 'medium',
    notes: 'Parliamentary elections; reformist vs hardliner dynamics',
  },
];

/**
 * CII boost values based on election proximity
 * Applied to country instability index when elections approach
 */
export const ELECTION_CII_BOOST = {
  /** 30+ days out - awareness only, minimal boost */
  awareness: 2,
  /** 7-30 days out - elevated monitoring */
  elevated: 5,
  /** 1-7 days out - high alert */
  imminent: 10,
  /** Election day - maximum sensitivity */
  electionDay: 15,
  /** Post-election (3 days after) - result uncertainty */
  postElection: 8,
} as const;

/**
 * Significance multipliers for CII boost
 */
export const SIGNIFICANCE_MULTIPLIER: Record<ElectionSignificance, number> = {
  high: 1.0,
  medium: 0.6,
  low: 0.3,
};

/**
 * Calculate days until/since an election
 * Negative values mean the election has passed
 */
export function getDaysUntilElection(election: Election): number {
  const now = new Date();
  const diff = election.date.getTime() - now.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

/**
 * Get CII boost for a country based on upcoming elections
 * Returns the highest applicable boost if multiple elections
 */
export function getElectionCIIBoost(countryCode: string): number {
  const countryElections = ELECTIONS_2026_2027.filter(
    e => e.countryCode === countryCode
  );

  if (countryElections.length === 0) return 0;

  let maxBoost = 0;

  for (const election of countryElections) {
    const days = getDaysUntilElection(election);
    const sigMultiplier = SIGNIFICANCE_MULTIPLIER[election.significance];
    
    let rawBoost = 0;
    
    if (days === 0) {
      // Election day
      rawBoost = ELECTION_CII_BOOST.electionDay;
    } else if (days < 0 && days >= -3) {
      // Post-election uncertainty (up to 3 days after)
      rawBoost = ELECTION_CII_BOOST.postElection;
    } else if (days > 0 && days <= 7) {
      // Imminent (1-7 days)
      rawBoost = ELECTION_CII_BOOST.imminent;
    } else if (days > 7 && days <= 30) {
      // Elevated (7-30 days)
      rawBoost = ELECTION_CII_BOOST.elevated;
    } else if (days > 30 && days <= 60) {
      // Awareness (30-60 days)
      rawBoost = ELECTION_CII_BOOST.awareness;
    }

    const boost = Math.round(rawBoost * sigMultiplier);
    if (boost > maxBoost) {
      maxBoost = boost;
    }
  }

  return maxBoost;
}

/**
 * Get upcoming elections within a time window
 * @param days Number of days to look ahead (default 90)
 */
export function getUpcomingElections(days: number = 90): Election[] {
  const now = new Date();
  const cutoff = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  return ELECTIONS_2026_2027
    .filter(e => e.date >= now && e.date <= cutoff)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}

/**
 * Get elections for a specific country
 */
export function getCountryElections(countryCode: string): Election[] {
  return ELECTIONS_2026_2027
    .filter(e => e.countryCode === countryCode)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}

/**
 * Get election proximity status for display
 */
export type ElectionProximity = 'election-day' | 'imminent' | 'elevated' | 'awareness' | 'none';

export function getElectionProximity(countryCode: string): { 
  proximity: ElectionProximity; 
  election: Election | null;
  daysUntil: number | null;
} {
  const elections = getCountryElections(countryCode);
  
  for (const election of elections) {
    const days = getDaysUntilElection(election);
    
    if (days === 0) {
      return { proximity: 'election-day', election, daysUntil: 0 };
    } else if (days > 0 && days <= 7) {
      return { proximity: 'imminent', election, daysUntil: days };
    } else if (days > 7 && days <= 30) {
      return { proximity: 'elevated', election, daysUntil: days };
    } else if (days > 30 && days <= 60) {
      return { proximity: 'awareness', election, daysUntil: days };
    }
  }

  return { proximity: 'none', election: null, daysUntil: null };
}

/**
 * Format election for display
 */
export function formatElectionLabel(election: Election): string {
  const typeLabels: Record<ElectionType, string> = {
    presidential: 'Presidential',
    parliamentary: 'Parliamentary',
    legislative: 'Legislative',
    referendum: 'Referendum',
    local: 'Local',
  };
  return `${election.country} ${typeLabels[election.type]} Election`;
}

/**
 * Get all elections sorted by date
 */
export function getAllElectionsSorted(): Election[] {
  return [...ELECTIONS_2026_2027].sort((a, b) => a.date.getTime() - b.date.getTime());
}
