import { isInRankableUniverse } from '../../resilience/v1/_rankable-universe';

export type ScorecardBlocPreset = 'USMCA' | 'EU27' | 'BRICS' | 'GCC' | 'ASEAN' | 'NATO';
export type ScorecardBlocSelection = { id: string; label: string; members: string[] };

// Membership checked against official organization pages on 2026-08-29.
// ASEAN includes Timor-Leste (member since 2025), and BRICS follows the
// official 11-member list, including Saudi Arabia and Indonesia.
export const SCORECARD_BLOC_PRESETS: Record<ScorecardBlocPreset, ScorecardBlocSelection> = {
  USMCA: { id: 'USMCA', label: 'USMCA', members: ['CA', 'MX', 'US'] },
  EU27: {
    id: 'EU27',
    label: 'European Union',
    members: ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'],
  },
  BRICS: { id: 'BRICS', label: 'BRICS', members: ['BR', 'RU', 'IN', 'CN', 'ZA', 'SA', 'EG', 'AE', 'ET', 'ID', 'IR'] },
  GCC: { id: 'GCC', label: 'Gulf Cooperation Council', members: ['AE', 'BH', 'KW', 'OM', 'QA', 'SA'] },
  ASEAN: { id: 'ASEAN', label: 'ASEAN', members: ['BN', 'KH', 'ID', 'LA', 'MY', 'MM', 'PH', 'SG', 'TH', 'TL', 'VN'] },
  NATO: {
    id: 'NATO',
    label: 'NATO',
    members: ['AL', 'BE', 'BG', 'CA', 'HR', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IS', 'IT', 'LV', 'LT', 'LU', 'ME', 'NL', 'MK', 'NO', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'TR', 'GB', 'US'],
  },
};

export function resolveBlocSelection(input: { preset?: string; members?: string[] }): ScorecardBlocSelection {
  const preset = String(input.preset || '').trim();
  const members = Array.isArray(input.members) ? input.members : [];
  if (Boolean(preset) === (members.length > 0)) {
    throw new Error('Select exactly one scorecard bloc preset or custom member list.');
  }
  if (preset) {
    if (!(preset in SCORECARD_BLOC_PRESETS)) throw new Error(`Unknown scorecard bloc preset: ${preset}`);
    return SCORECARD_BLOC_PRESETS[preset as ScorecardBlocPreset];
  }
  if (members.length < 2 || members.length > 30) throw new Error('Custom scorecard blocs require 2-30 members.');
  if (members.some((member) => !/^[A-Z]{2}$/.test(member))) {
    throw new Error('Custom scorecard bloc members must be uppercase ISO-2 codes.');
  }
  if (new Set(members).size !== members.length) throw new Error('Custom scorecard bloc members must be unique.');
  if (members.some((member) => !isInRankableUniverse(member))) {
    throw new Error('Custom scorecard bloc members must belong to the public rankable country universe.');
  }
  const sorted = [...members].sort();
  return { id: `custom:${sorted.join('-')}`, label: sorted.join(' + '), members: sorted };
}
