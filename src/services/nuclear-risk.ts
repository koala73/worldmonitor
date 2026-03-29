/**
 * Nuclear Risk Service
 *
 * Provides static/computed nuclear risk data including the Doomsday Clock
 * position, treaty status, and a synthesized risk level based on the current
 * app mode.
 */

import { getMode } from '@/services/mode-manager';

export interface NuclearRiskData {
  doomsdayClock: {
    secondsToMidnight: number;
    lastUpdated: string;
    description: string;
  };
  riskLevel: 'low' | 'elevated' | 'high' | 'critical';
  treatyStatus: Array<{
    name: string;
    status: 'active' | 'suspended' | 'withdrawn';
    notes: string;
  }>;
  alertIndicators: string[];
}

export const CACHE_TTL_MS = 5 * 60 * 1000;

const TREATIES: NuclearRiskData['treatyStatus'] = [
  {
    name: 'New START',
    status: 'suspended',
    notes: 'Russia suspended participation in February 2023',
  },
  {
    name: 'NPT (Non-Proliferation Treaty)',
    status: 'active',
    notes: 'In force since 1970; 191 state parties',
  },
  {
    name: 'TPNW (Treaty on the Prohibition of Nuclear Weapons)',
    status: 'active',
    notes: 'US, Russia, UK, France, and China are not signatories',
  },
  {
    name: 'CTBT (Comprehensive Nuclear-Test-Ban Treaty)',
    status: 'suspended',
    notes: 'Not in force; US signed in 1996 but has not ratified',
  },
  {
    name: 'INF Treaty',
    status: 'withdrawn',
    notes: 'US withdrew in August 2019; Russia had already been in violation',
  },
];

const ALERT_INDICATORS_BY_MODE: Record<string, string[]> = {
  peace: [
    'No active nuclear alerts',
    'Strategic forces at normal readiness',
  ],
  finance: [
    'No active nuclear alerts',
    'Strategic forces at normal readiness',
    'Economic stress may increase geopolitical tensions',
  ],
  war: [
    'Elevated military activity across conflict zones',
    'Nuclear-capable states involved in active hostilities',
    'Dual-use delivery systems deployed in theater',
    'Strategic communication channels under strain',
  ],
  disaster: [
    'Disaster response straining military logistics',
    'Early-warning infrastructure under stress',
    'Communications disruptions could affect command-and-control',
  ],
  ghost: [
    'No active nuclear alerts',
    'Strategic forces at normal readiness',
  ],
};

function deriveRiskLevel(mode: string): NuclearRiskData['riskLevel'] {
  switch (mode) {
    case 'war':
      return 'high';
    case 'disaster':
      return 'elevated';
    case 'finance':
    case 'peace':
    case 'ghost':
    default:
      return 'low';
  }
}

export function getNuclearRiskData(): NuclearRiskData {
  const mode = getMode();
  return {
    doomsdayClock: {
      secondsToMidnight: 89,
      lastUpdated: 'January 2025',
      description:
        'The Bulletin of Atomic Scientists Doomsday Clock stands at 89 seconds to midnight — the closest to global catastrophe in its 77-year history.',
    },
    riskLevel: deriveRiskLevel(mode),
    treatyStatus: TREATIES,
    alertIndicators: ALERT_INDICATORS_BY_MODE[mode] ?? ALERT_INDICATORS_BY_MODE['peace']!,
  };
}
