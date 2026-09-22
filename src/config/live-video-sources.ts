// Live video sources: the owner's edit point for the Live Webcams wall.
//
// An entry can be any of:
//   - a YouTube watch, live, embed or youtu.be URL, or a bare 11-character video id
//   - a channel URL, youtube.com/channel/UC... (plays whatever that channel has live right now)
//   - an https .m3u8 stream URL
// Entries are tried in order until one is verified live. Dead, ended and unembeddable entries are
// skipped and never shown as live. An empty list [] means the slot needs a feed: the dashboard
// hides it and the audit lists it.
//
// Check a candidate before pasting it:
//   npm run live-video:check -- https://www.youtube.com/watch?v=...
// Check what a slot plays today, or every slot:
//   npm run live-video:check -- --slot webcams/kyiv
//   npm run live-video:check -- --all

export const WEBCAM_SOURCES = {
  jerusalem: ['https://www.youtube.com/watch?v=zp6LNSoq000'],
  'middle-east': ['https://www.youtube.com/watch?v=AkqGOcpDvZU'],
  'tel-aviv': [],
  // The broadcaster's own channel stream; ju3cuAIc1i4 began failing with player error 150 (#8284).
  mecca: ['https://www.youtube.com/watch?v=eC4LfEVxvKg'],
  istanbul: ['https://www.youtube.com/watch?v=bbVe5h7X3uw'],
  medina: ['https://www.youtube.com/watch?v=naaOMgZbIHQ'],
  // MTV Lebanon News' channel embed (youtube.com/channel/UC9_XmAwE5szLHF76FjMylaw) returned player
  // error 150 on 2026-09-15; paste it back once the checker reports it live.
  'beirut-mtv': [],
  // Rotates through Kyiv, Odesa, Kharkiv, Kramatorsk, Sloviansk, Donetsk and Dnipro.
  kyiv: ['https://www.youtube.com/watch?v=e2gC37ILQmk'],
  paris: ['https://www.youtube.com/watch?v=-xzg3wujOVM'],
  'st-petersburg': ['https://www.youtube.com/watch?v=CjtIYbmVfck'],
  london: ['https://www.youtube.com/watch?v=zMCea32gpmg'],
  washington: ['https://www.youtube.com/watch?v=oDCAAfOSqvA'],
  'new-york': ['https://www.youtube.com/watch?v=JQ_jwk_7OVE', 'https://www.youtube.com/watch?v=VGnFLdQW39A'],
  'los-angeles': ['https://www.youtube.com/watch?v=EO_1LWqsCNE'],
  miami: ['https://www.youtube.com/watch?v=nPGlLfGX6SA'],
  taipei: ['https://www.youtube.com/watch?v=z_fY1pj1VBw'],
  shanghai: ['https://www.youtube.com/watch?v=Z-g8M1QGKbg'],
  tokyo: ['https://www.youtube.com/watch?v=_k-5U7IeK8g'],
  seoul: ['https://www.youtube.com/watch?v=vk5BHoDxXf0'],
  sydney: ['https://www.youtube.com/watch?v=5uZa3-RMFos'],
  'iss-earth': ['https://www.youtube.com/watch?v=M3HKLzjvKPc'],
  // NASA's official "Live High-Definition Views from the International Space Station".
  'nasa-live': ['https://www.youtube.com/watch?v=awQzjn72bI0'],
  // NASASpaceflight's Starbase Live, then its Space Coast Live. Dream Trips' ISS stream
  // (0FBiyFpV__g) was requested but does not allow embedding (player error 150, 2026-09-15).
  'space-x': ['https://www.youtube.com/watch?v=mhJRzQsLZGg', 'https://www.youtube.com/watch?v=Jm8wRjD3xVA'],
  'space-walk': ['https://www.youtube.com/watch?v=fO9e9jnhYK8'],
} as const satisfies Record<string, readonly string[]>;

export type WebcamSlotId = keyof typeof WEBCAM_SOURCES;

/** The "all regions" wall: the first four slots here that have entries. A filled hotspot slot moves back to the front. */
export const WEBCAM_GRID_PRIORITY = [
  'jerusalem', 'middle-east', 'kyiv', 'washington',
  'taipei', 'tel-aviv', 'beirut-mtv', 'mecca', 'istanbul', 'medina', 'st-petersburg', 'tokyo', 'los-angeles', 'sydney', 'iss-earth',
] as const satisfies readonly WebcamSlotId[];

/** Two channel embeds that are reliably live. If both fail, the audit reports broken probing, not rot. */
export const AUDIT_CANARIES = [
  'https://www.youtube.com/channel/UCNye-wNBqNL5ZzHSJj3l8Bg',
  'https://www.youtube.com/channel/UCknLrEdhRCp1aegoMqRaCZg',
] as const;
