import type { SavedPlace } from './saved-places';
import type { ResolvedCommsPlan } from './comms-plan';

export type CommsReferenceKind = 'scanner' | 'repeater' | 'gmrs' | 'mesh' | 'ptt';

export interface CommsDirectoryLink {
  id: string;
  kind: CommsReferenceKind;
  provider: string;
  label: string;
  url: string;
  note: string;
}

function buildNote(place: SavedPlace, suffix: string): string {
  return `${suffix} for ${place.name}.`;
}

export function getCommsDirectoryLinks(place: SavedPlace, plan?: ResolvedCommsPlan | null): CommsDirectoryLink[] {
  const travelLike = place.tags.includes('travel') || place.tags.includes('bugout');
  const homeLike = place.tags.includes('home') || place.tags.includes('family');
  const hasMeshStep = plan?.fallbackSteps.some((step) => step.kind === 'mesh') ?? false;

  const links: CommsDirectoryLink[] = [
    {
      id: 'broadcastify',
      kind: 'scanner',
      provider: 'Broadcastify',
      label: 'Scanner Directory',
      url: 'https://www.broadcastify.com/listen/',
      note: buildNote(place, 'Start here for public-safety scanner coverage'),
    },
    {
      id: 'repeaterbook',
      kind: 'repeater',
      provider: 'RepeaterBook',
      label: 'Repeater Directory',
      url: 'https://www.repeaterbook.com/index.php/en-us/',
      note: buildNote(place, 'Use this to find nearby ham repeaters'),
    },
    {
      id: 'mygmrs',
      kind: 'gmrs',
      provider: 'myGMRS',
      label: 'GMRS Repeater Map',
      url: 'https://mygmrs.com/map/#/',
      note: buildNote(place, 'Use this to identify nearby GMRS coverage'),
    },
    {
      id: 'zello',
      kind: 'ptt',
      provider: 'Zello',
      label: 'Channel Sharing Guide',
      url: 'https://support.zello.com/hc/en-us/articles/230746587-Sharing-Channels',
      note: buildNote(place, homeLike ? 'Use this to coordinate family push-to-talk channels' : 'Use this to stand up a fast push-to-talk fallback'),
    },
    {
      id: 'meshtastic',
      kind: 'mesh',
      provider: 'Meshtastic',
      label: 'Mesh Radio Primer',
      url: 'https://meshtastic.org/docs/introduction/',
      note: buildNote(place, hasMeshStep || travelLike ? 'Use this when you need off-grid mesh coverage' : 'Use this if your plan needs an off-grid mesh fallback'),
    },
  ];

  if (!travelLike) return links;

  return [
    links[1]!,
    links[2]!,
    links[4]!,
    links[0]!,
    links[3]!,
  ];
}
