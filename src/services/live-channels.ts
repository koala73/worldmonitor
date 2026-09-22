import { SITE_VARIANT } from '@/config/variant';
import { STORAGE_KEYS } from '@/config/variants/base';
import { LIVE_NEWS_SOURCES, type LiveNewsSlotId } from '@/config/live-video-sources';
import { CHANNEL_ID, type LiveVideoSource } from '@/services/live-video/model';
import { loadFromStorage, saveToStorage } from '@/utils';

export interface LiveChannel {
  id: string;
  name: string;
  handle?: string; // YouTube handle, shown in channel management; playback never looks it up
  hlsUrl?: string; // user-added https HLS stream
  videoId?: string; // user-added YouTube video
  channelId?: string; // user-added YouTube channel (UC…); plays whatever the channel has live
  geoAvailability?: string[]; // ISO 3166-1 alpha-2 codes; undefined = available everywhere
}

/** A built-in channel. Its id names the catalog slot in src/config/live-video-sources.ts that holds its streams. */
export interface BuiltinLiveChannel extends LiveChannel {
  id: LiveNewsSlotId;
}

// Full variant: World news channels (24/7 live streams)
const FULL_LIVE_CHANNELS: BuiltinLiveChannel[] = [
  { id: 'bloomberg', name: 'Bloomberg', handle: '@markets' },
  { id: 'sky', name: 'SkyNews', handle: '@SkyNews' },
  { id: 'euronews', name: 'Euronews', handle: '@euronews' },
  { id: 'dw', name: 'DW', handle: '@DWNews' },
  { id: 'cnn', name: 'CNN', handle: '@CNN' },
  { id: 'france24', name: 'France 24', handle: '@FRANCE24' },
  { id: 'alarabiya', name: 'AlArabiya', handle: '@AlArabiya' },
  { id: 'aljazeera', name: 'AlJazeera', handle: '@AlJazeeraEnglish' },
];

// Tech variant: Tech & business channels
const TECH_LIVE_CHANNELS: BuiltinLiveChannel[] = [
  { id: 'bloomberg', name: 'Bloomberg', handle: '@markets' },
  { id: 'yahoo', name: 'Yahoo Finance', handle: '@YahooFinance' },
  { id: 'nasa', name: 'Sen Space Live', handle: '@NASA' },
];

// Optional channels users can add from the "Available Channels" tab UI
// Includes default channels so they appear in the grid for toggle on/off
export const OPTIONAL_LIVE_CHANNELS: BuiltinLiveChannel[] = [
  // North America (defaults first)
  { id: 'bloomberg', name: 'Bloomberg', handle: '@markets' },
  { id: 'yahoo', name: 'Yahoo Finance', handle: '@YahooFinance' },
  { id: 'cnn', name: 'CNN', handle: '@CNN' },
  { id: 'fox-news', name: 'Fox News', handle: '@FoxNews' },
  { id: 'newsmax', name: 'Newsmax', handle: '@NEWSMAX' },
  { id: 'abc-news', name: 'ABC News', handle: '@ABCNews' },
  { id: 'cbs-news', name: 'CBS News', handle: '@CBSNews' },
  { id: 'nbc-news', name: 'NBC News', handle: '@NBCNews' },
  { id: 'cbc-news', name: 'CBC News', handle: '@CBCNews' },
  { id: 'ctv-news', name: 'CTV News' },
  { id: 'reuters-tv', name: 'Reuters TV' },
  { id: 'nasa', name: 'Sen Space Live', handle: '@NASA' },
  // Europe (defaults first)
  { id: 'sky', name: 'SkyNews', handle: '@SkyNews' },
  { id: 'euronews', name: 'Euronews', handle: '@euronews' },
  { id: 'dw', name: 'DW', handle: '@DWNews' },
  { id: 'france24', name: 'France 24', handle: '@FRANCE24' },
  { id: 'bbc-news', name: 'BBC News', handle: '@BBCNews', geoAvailability: ['GB'] },
  { id: 'gb-news', name: 'GB News' },
  { id: 'the-guardian', name: 'The Guardian' },
  { id: 'france24-en', name: 'France 24 English', handle: '@France24_en' },
  { id: 'rtve', name: 'RTVE 24H', handle: '@RTVENoticias' },
  { id: 'phoenix', name: 'Phoenix', geoAvailability: ['DE', 'AT', 'CH'] },
  { id: 'rtp3', name: 'RTP3', geoAvailability: ['PT', 'BR'] },
  { id: 'trt-haber', name: 'TRT Haber', handle: '@trthaber' },
  { id: 'ntv-turkey', name: 'NTV', handle: '@NTV' },
  { id: 'cnn-turk', name: 'CNN TURK', handle: '@cnnturk' },
  { id: 'tv-rain', name: 'TV Rain', handle: '@tvrain' },
  { id: 'rt', name: 'RT' },
  { id: 'tvp-info', name: 'TVP Info', handle: '@tvpinfo' },
  { id: 'telewizja-republika', name: 'Telewizja Republika', handle: '@Telewizja_Republika' },
  // Latin America & Portuguese
  { id: 'cnn-brasil', name: 'CNN Brasil', handle: '@CNNbrasil' },
  { id: 'jovem-pan', name: 'Jovem Pan News', handle: '@jovempannews' },
  { id: 'record-news', name: 'Record News', handle: '@RecordNews' },
  { id: 'band-jornalismo', name: 'Band Jornalismo', handle: '@BandJornalismo' },
  { id: 'tn-argentina', name: 'TN (Todo Noticias)', handle: '@todonoticias' },
  { id: 'c5n', name: 'C5N', handle: '@c5n' },
  { id: 'milenio', name: 'MILENIO', handle: '@MILENIO' },
  { id: 'noticias-caracol', name: 'Noticias Caracol', handle: '@NoticiasCaracol' },
  { id: 'ntn24', name: 'NTN24', handle: '@NTN24' },
  { id: 't13', name: 'T13', handle: '@Teletrece' },
  { id: 'dw-espanol', name: 'DW Español' },
  { id: 'rt-espanol', name: 'RT Español' },
  { id: 'cgtn-espanol', name: 'CGTN Español' },
  // Asia
  { id: 'tbs-news', name: 'TBS NEWS DIG', handle: '@tbsnewsdig' },
  { id: 'ann-news', name: 'ANN News', handle: '@ANNnewsCH' },
  { id: 'ntv-news', name: 'NTV News (Japan)', handle: '@ntv_news' },
  { id: 'cti-news', name: 'CTI News (Taiwan)', handle: '@中天新聞CtiNews' },
  { id: 'wion', name: 'WION', handle: '@WION' },
  { id: 'ndtv', name: 'NDTV 24x7', handle: '@NDTV' },
  { id: 'cgtn', name: 'CGTN' },
  { id: 'cna-asia', name: 'CNA (NewsAsia)', handle: '@channelnewsasia' },
  { id: 'nhk-world', name: 'NHK World Japan', handle: '@NHKWORLDJAPAN' },
  { id: 'arirang-news', name: 'Arirang News', handle: '@ArirangCoKrArirangNEWS' },
  { id: 'india-today', name: 'India Today', handle: '@indiatoday' },
  { id: 'abp-news', name: 'ABP News', handle: '@ABPNews' },
  // Middle East (defaults first)
  { id: 'alarabiya', name: 'AlArabiya', handle: '@AlArabiya' },
  { id: 'aljazeera', name: 'AlJazeera', handle: '@AlJazeeraEnglish' },
  { id: 'al-hadath', name: 'Al Hadath', handle: '@AlHadath' },
  { id: 'sky-news-arabia', name: 'Sky News Arabia', handle: '@skynewsarabia' },
  { id: 'trt-world', name: 'TRT World', handle: '@TRTWorld' },
  { id: 'iran-intl', name: 'Iran International', handle: '@IranIntl' },
  { id: 'cgtn-arabic', name: 'CGTN Arabic', handle: '@CGTNArabic' },
  { id: 'kan-11', name: 'Kan 11', handle: '@KAN11NEWS' },
  { id: 'i24-news', name: 'i24NEWS (Israel)', handle: '@i24NEWS_HE' },
  { id: 'asharq-news', name: 'Asharq News', handle: '@asharqnews' },
  { id: 'aljazeera-arabic', name: 'AlJazeera Arabic', handle: '@AljazeeraChannel' },
  { id: 'aljazeera-mubasher', name: 'Al Jazeera Mubasher' },
  { id: 'alarabiya-business', name: 'Al Arabiya Business' },
  { id: 'al-qahera-news', name: 'Al Qahera News' },
  { id: 'press-tv', name: 'Press TV' },
  { id: 'dw-arabic', name: 'DW Arabic' },
  { id: 'rt-arabic', name: 'RT Arabic' },
  { id: 'rudaw', name: 'Rudaw' },
  // Africa
  { id: 'africanews', name: 'Africanews', handle: '@africanews' },
  { id: 'channels-tv', name: 'Channels TV', handle: '@ChannelsTelevision' },
  { id: 'ktn-news', name: 'KTN News', handle: '@ktnnews_kenya' },
  { id: 'enca', name: 'eNCA', handle: '@encanews' },
  { id: 'sabc-news', name: 'SABC News', handle: '@SABCDigitalNews' },
  { id: 'arise-news', name: 'Arise News', handle: '@AriseNewsChannel' },
  // Europe (additional)
  { id: 'welt', name: 'WELT', handle: '@WELTVideoTV', geoAvailability: ['DE', 'AT', 'CH'] },
  { id: 'tagesschau24', name: 'Tagesschau24', handle: '@tagesschau' },
  { id: 'euronews-fr', name: 'Euronews FR', handle: '@euronewsfr' },
  { id: 'euronews-gr', name: 'Euronews GR', handle: '@euronewsgr' },
  { id: 'skai-tv', name: 'SKAI TV', handle: '@skaitv' },
  { id: 'ert-news', name: 'ERT News', handle: '@ertgr' },
  { id: 'france24-fr', name: 'France 24 FR', handle: '@France24_fr' },
  { id: 'france-info', name: 'France Info', handle: '@franceinfo' },
  { id: 'bfmtv', name: 'BFMTV', handle: '@BFMTV' },
  { id: 'tv5monde-info', name: 'TV5 Monde Info', handle: '@TV5MONDEInfo', geoAvailability: ['FR', 'BE', 'CH', 'CA'] },
  { id: 'nrk1', name: 'NRK1', handle: '@nrk', geoAvailability: ['NO'] },
  { id: 'aljazeera-balkans', name: 'Al Jazeera Balkans', handle: '@AlJazeeraBalkans' },
  // Oceania
  { id: 'abc-news-au', name: 'ABC News Australia', handle: '@abcnewsaustralia' },
];

const _REGION_ENTRIES: { key: string; labelKey: string; channelIds: string[] }[] = [
  { key: 'na', labelKey: 'components.liveNews.regionNorthAmerica', channelIds: ['bloomberg', 'yahoo', 'cnn', 'fox-news', 'newsmax', 'abc-news', 'cbs-news', 'nbc-news', 'cbc-news', 'ctv-news', 'reuters-tv', 'nasa'] },
  { key: 'eu', labelKey: 'components.liveNews.regionEurope', channelIds: ['sky', 'euronews', 'dw', 'france24', 'bbc-news', 'gb-news', 'the-guardian', 'france24-en', 'phoenix', 'rtp3', 'welt', 'rtve', 'trt-haber', 'ntv-turkey', 'cnn-turk', 'tv-rain', 'rt', 'tvp-info', 'telewizja-republika', 'tagesschau24', 'euronews-fr', 'euronews-gr', 'skai-tv', 'ert-news', 'france24-fr', 'france-info', 'bfmtv', 'tv5monde-info', 'nrk1', 'aljazeera-balkans'] },
  { key: 'latam', labelKey: 'components.liveNews.regionLatinAmerica', channelIds: ['cnn-brasil', 'jovem-pan', 'record-news', 'band-jornalismo', 'tn-argentina', 'c5n', 'milenio', 'noticias-caracol', 'ntn24', 't13', 'dw-espanol', 'rt-espanol', 'cgtn-espanol'] },
  { key: 'asia', labelKey: 'components.liveNews.regionAsia', channelIds: ['tbs-news', 'ann-news', 'ntv-news', 'cti-news', 'cgtn', 'wion', 'ndtv', 'cna-asia', 'nhk-world', 'arirang-news', 'india-today', 'abp-news'] },
  { key: 'me', labelKey: 'components.liveNews.regionMiddleEast', channelIds: ['alarabiya', 'aljazeera', 'al-hadath', 'sky-news-arabia', 'trt-world', 'iran-intl', 'press-tv', 'cgtn-arabic', 'kan-11', 'i24-news', 'asharq-news', 'aljazeera-arabic', 'aljazeera-mubasher', 'alarabiya-business', 'al-qahera-news', 'dw-arabic', 'rt-arabic', 'rudaw'] },
  { key: 'africa', labelKey: 'components.liveNews.regionAfrica', channelIds: ['africanews', 'channels-tv', 'ktn-news', 'enca', 'sabc-news', 'arise-news'] },
  { key: 'oc', labelKey: 'components.liveNews.regionOceania', channelIds: ['abc-news-au'] },
];
export const OPTIONAL_CHANNEL_REGIONS: { key: string; labelKey: string; channelIds: string[] }[] = [
  ..._REGION_ENTRIES,
];

const DEFAULT_LIVE_CHANNELS = SITE_VARIANT === 'tech' ? TECH_LIVE_CHANNELS : SITE_VARIANT === 'happy' ? [] : FULL_LIVE_CHANNELS;

/** Default channel list for the current variant (for restore in channel management). */
export function getDefaultLiveChannels(): LiveChannel[] {
  return [...DEFAULT_LIVE_CHANNELS];
}

export const BUILTIN_IDS = new Set<string>([
  ...FULL_LIVE_CHANNELS.map((c) => c.id),
  ...TECH_LIVE_CHANNELS.map((c) => c.id),
  ...OPTIONAL_LIVE_CHANNELS.map((c) => c.id),
]);

/** The built-in channel arrays are typed with catalog slot ids, so every id in BUILTIN_IDS names a slot. */
function isBuiltinId(id: string): id is LiveNewsSlotId {
  return BUILTIN_IDS.has(id);
}

/** The one entry a user-added channel plays: its stream, channel, video, or (saved before channel URLs) handle. */
export function customChannelEntry(channel: LiveChannel): string | null {
  if (channel.hlsUrl) return channel.hlsUrl;
  if (channel.channelId) return `https://www.youtube.com/channel/${channel.channelId}`;
  if (channel.videoId) return `https://www.youtube.com/watch?v=${channel.videoId}`;
  return channel.handle ?? null;
}

/** What the live video session tries for a channel, in order. */
export function liveVideoSourceFor(channel: LiveChannel): LiveVideoSource {
  if (isBuiltinId(channel.id)) {
    return { slot: `live-news/${channel.id}`, entries: LIVE_NEWS_SOURCES[channel.id], origin: 'builtin' };
  }
  const entry = customChannelEntry(channel);
  // Per-channel slot so failure memory does not bleed across custom streams.
  return { slot: `live-news/${channel.id}`, entries: entry ? [entry] : [], origin: 'custom' };
}

/** A built-in channel with no configured stream has nothing to play, so channel management hides it. */
export function hasBuiltinStreams(channel: BuiltinLiveChannel): boolean {
  return LIVE_NEWS_SOURCES[channel.id].length > 0;
}

/** Returns playable optional channels filtered by user country. Channels without geoAvailability pass through. */
export function getFilteredOptionalChannels(userCountry: string | null): LiveChannel[] {
  const playable = OPTIONAL_LIVE_CHANNELS.filter(hasBuiltinStreams);
  if (!userCountry) return playable;
  const uc = userCountry.toUpperCase();
  return playable.filter((c) => !c.geoAvailability || c.geoAvailability.includes(uc));
}

/** Returns region entries with unplayable and geo-restricted channel IDs removed for the user's country. */
export function getFilteredChannelRegions(userCountry: string | null): typeof OPTIONAL_CHANNEL_REGIONS {
  const allowedIds = new Set(getFilteredOptionalChannels(userCountry).map((c) => c.id));
  return OPTIONAL_CHANNEL_REGIONS.map((r) => ({
    ...r,
    channelIds: r.channelIds.filter((id) => allowedIds.has(id)),
  }));
}

export interface StoredLiveChannels {
  order: string[];
  custom?: LiveChannel[];
  /** Display name overrides for built-in channels (and custom). */
  displayNameOverrides?: Record<string, string>;
}

/** A custom channel as any version of channel management saved it. */
interface StoredCustomChannel {
  id?: string;
  name?: string;
  handle?: string;
  hlsUrl?: string;
  videoId?: string;
  channelId?: string;
  /** How older versions saved a user-added video. */
  fallbackVideoId?: string;
  /** Older versions set this on user-added videos (handle '@video') and streams, never on a handle channel. */
  useFallbackOnly?: boolean;
}

/**
 * Keeps only what playback reads. The saved fields decide the kind, not the id: before channel URLs a
 * handle was saved as custom-<handle>, so @hls-news carries the prefix a stream id uses today.
 */
function customChannelFromStorage(stored: StoredCustomChannel): LiveChannel | null {
  const { id } = stored;
  if (!id) return null;
  const name = stored.name || stored.handle || id;
  // A /channel/UC… URL was saved as the handle '@UC…', and that channel id still plays.
  const legacyChannelId = stored.handle?.replace(/^@/, '');
  if (legacyChannelId && CHANNEL_ID.test(legacyChannelId)) return { id, name, channelId: legacyChannelId };
  // A handle channel first: older versions also saved the video or YouTube manifest they last scraped for it,
  // which would now play frozen. Its live video cannot be looked up, so playback asks for a channel URL.
  if (stored.handle && stored.handle !== '@video' && !stored.useFallbackOnly) return { id, name, handle: stored.handle };
  if (stored.hlsUrl) return { id, name, hlsUrl: stored.hlsUrl };
  const videoId = stored.videoId ?? stored.fallbackVideoId;
  if (videoId) return { id, name, videoId };
  if (stored.channelId) return { id, name, channelId: stored.channelId };
  // Saved as a handle alone. Its live video cannot be looked up, so playback asks for a channel URL.
  return stored.handle ? { id, name, handle: stored.handle } : null;
}

const DEFAULT_STORED: StoredLiveChannels = {
  order: DEFAULT_LIVE_CHANNELS.map((c) => c.id),
};

export function loadChannelsFromStorage(): LiveChannel[] {
  const stored = loadFromStorage<StoredLiveChannels>(STORAGE_KEYS.liveChannels, DEFAULT_STORED);
  const order = stored.order?.length ? stored.order : DEFAULT_STORED.order;
  const channelMap = new Map<string, LiveChannel>();
  for (const c of FULL_LIVE_CHANNELS) channelMap.set(c.id, { ...c });
  for (const c of TECH_LIVE_CHANNELS) channelMap.set(c.id, { ...c });
  for (const c of OPTIONAL_LIVE_CHANNELS) channelMap.set(c.id, { ...c });
  for (const c of (stored.custom ?? []) as StoredCustomChannel[]) {
    const channel = customChannelFromStorage(c);
    if (channel) channelMap.set(channel.id, channel);
  }
  const overrides = stored.displayNameOverrides ?? {};
  for (const [id, name] of Object.entries(overrides)) {
    const ch = channelMap.get(id);
    if (ch) ch.name = name;
  }
  const result: LiveChannel[] = [];
  for (const id of order) {
    const ch = channelMap.get(id);
    if (ch) result.push(ch);
  }
  return result;
}

export function saveChannelsToStorage(channels: LiveChannel[]): void {
  const order = channels.map((c) => c.id);
  const custom = channels.filter((c) => !BUILTIN_IDS.has(c.id));
  const builtinNames = new Map<string, string>();
  for (const c of [...FULL_LIVE_CHANNELS, ...TECH_LIVE_CHANNELS, ...OPTIONAL_LIVE_CHANNELS]) builtinNames.set(c.id, c.name);
  const displayNameOverrides: Record<string, string> = {};
  for (const c of channels) {
    if (builtinNames.has(c.id) && c.name !== builtinNames.get(c.id)) {
      displayNameOverrides[c.id] = c.name;
    }
  }
  saveToStorage(STORAGE_KEYS.liveChannels, { order, custom, displayNameOverrides });
}
