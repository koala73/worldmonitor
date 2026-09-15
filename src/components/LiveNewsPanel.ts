import { Panel } from './Panel';
import { isDesktopRuntime } from '@/services/runtime';
import { t } from '../services/i18n';
import { createFocusTrap } from '@/utils/focus-trap';
import { loadFromStorage, saveToStorage } from '@/utils';
import { STORAGE_KEYS, SITE_VARIANT } from '@/config';
import { LIVE_NEWS_SOURCES } from '@/config/live-video-sources';

import { getActiveLiveMedia, playAllLiveMedia, registerLiveMediaStarter, releaseLiveMediaPlayback, requestLiveMediaPlayback, stopLiveMediaPlayback, unregisterLiveMediaStarter, type LiveMediaStopReason } from '@/services/live-media-controller';
import { getLiveStreamsAlwaysOn, subscribeLiveStreamsAlwaysOnChange } from '@/services/live-stream-settings';
import { subscribeLiveMediaIdle } from '@/services/live-media-idle';
import { LIVE_VIDEO_TIMING, type LiveVideoSource, type OfflineReason } from '@/services/live-video/model';
import { openLiveVideo, type LiveVideoSession, type LiveVideoState } from '@/services/live-video/session';
import { track } from '@/services/analytics';
import { createLiveMediaIdleNotice, trackLiveMediaIdleStop } from './live-media-idle-notice';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';


export interface LiveChannel {
  id: string;
  name: string;
  handle?: string; // YouTube handle, shown in channel management; playback never looks it up
  hlsUrl?: string; // user-added https HLS stream
  videoId?: string; // user-added YouTube video
  channelId?: string; // user-added YouTube channel (UC…); plays whatever the channel has live
  geoAvailability?: string[]; // ISO 3166-1 alpha-2 codes; undefined = available everywhere
}

// The streams each built-in channel plays live in src/config/live-video-sources.ts.

// Full variant: World news channels (24/7 live streams)
const FULL_LIVE_CHANNELS: LiveChannel[] = [
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
const TECH_LIVE_CHANNELS: LiveChannel[] = [
  { id: 'bloomberg', name: 'Bloomberg', handle: '@markets' },
  { id: 'yahoo', name: 'Yahoo Finance', handle: '@YahooFinance' },
  { id: 'nasa', name: 'Sen Space Live', handle: '@NASA' },
];

// Optional channels users can add from the "Available Channels" tab UI
// Includes default channels so they appear in the grid for toggle on/off
export const OPTIONAL_LIVE_CHANNELS: LiveChannel[] = [
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
  { id: 'bbc-news', name: 'BBC News', handle: '@BBCNews' },
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

export const BUILTIN_IDS = new Set([
  ...FULL_LIVE_CHANNELS.map((c) => c.id),
  ...TECH_LIVE_CHANNELS.map((c) => c.id),
  ...OPTIONAL_LIVE_CHANNELS.map((c) => c.id),
]);

function builtinEntries(channelId: string): readonly string[] {
  return (LIVE_NEWS_SOURCES as Record<string, readonly string[]>)[channelId] ?? [];
}

/** The one entry a user-added channel plays: its stream, channel, video, or (saved before channel URLs) handle. */
export function customChannelEntry(channel: LiveChannel): string | null {
  if (channel.hlsUrl) return channel.hlsUrl;
  if (channel.channelId) return `https://www.youtube.com/channel/${channel.channelId}`;
  if (channel.videoId) return `https://www.youtube.com/watch?v=${channel.videoId}`;
  return channel.handle ?? null;
}

/** What the live video session tries for a channel, in order. */
function liveVideoSourceFor(channel: LiveChannel): LiveVideoSource {
  if (BUILTIN_IDS.has(channel.id)) {
    return { slot: `live-news/${channel.id}`, entries: builtinEntries(channel.id), origin: 'builtin' };
  }
  const entry = customChannelEntry(channel);
  // Per-channel slot so failure memory does not bleed across custom streams.
  return { slot: `live-news/${channel.id}`, entries: entry ? [entry] : [], origin: 'custom' };
}

/** A built-in channel with no configured stream has nothing to play, so channel management hides it. */
function hasBuiltinStreams(channel: LiveChannel): boolean {
  return builtinEntries(channel.id).length > 0;
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
}

/**
 * Keeps only what playback reads. The saved fields decide the kind, not the id: before channel URLs a
 * handle was saved as custom-<handle>, so @hls-news carries the prefix a stream id uses today.
 */
function customChannelFromStorage(stored: StoredCustomChannel): LiveChannel | null {
  const { id } = stored;
  if (!id) return null;
  const name = stored.name || stored.handle || id;
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

function offlineReasonText(reason: OfflineReason, name: string): string {
  switch (reason) {
    case 'embed-blocked': return t('components.liveNews.embedBlocked', { name });
    case 'unavailable': return t('components.liveNews.unavailable', { name });
    case 'no-entries': return t('components.liveNews.noStream', { name });
    case 'needs-channel-url': return t('components.liveNews.needsChannelUrl', { name });
    case 'insecure-url': return t('components.liveNews.insecureStream', { name });
    case 'not-live':
    case 'stream-ended': return t('components.liveNews.notLive', { name });
  }
}

function actionButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'offline-retry';
  button.textContent = label;
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return button;
}

function youtubeLink(watchUrl: string): HTMLAnchorElement {
  const link = document.createElement('a');
  link.className = 'offline-retry';
  link.href = watchUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = t('components.liveNews.openOnYouTube') || 'Open on YouTube';
  link.addEventListener('click', (e) => e.stopPropagation());
  return link;
}

/**
 * An explicit start (a channel click, Retry, the header play button) explains an offline channel.
 * An implicit one (play-all, auto-play, Resume) moves on to the next channel instead.
 */
type PlaybackOrigin = 'explicit' | 'implicit';

export class LiveNewsPanel extends Panel {
  private channels: LiveChannel[] = [];
  private activeChannel!: LiveChannel;
  private channelSwitcher: HTMLElement | null = null;
  private isMuted = true;
  private isPlaying = false;
  private idleStoppedAfterMs: number | null = null;
  private muteBtn: HTMLButtonElement | null = null;
  private fullscreenBtn: HTMLButtonElement | null = null;
  private isFullscreen = false;
  private liveBtn: HTMLButtonElement | null = null;
  private readonly boundVisibilityHandler = () => {
    if (document.hidden) stopLiveMediaPlayback('live-news', 'hidden');
    else this.startAlwaysOnPlaybackIfVisible();
  };
  private alwaysOn = getLiveStreamsAlwaysOn();
  private unsubscribeStreamSettings: (() => void) | null = null;
  private unsubscribeIdle: (() => void) | null = null;

  // One verified live session for the active channel. Callbacks from a replaced session carry a stale generation.
  private videoSession: LiveVideoSession | null = null;
  private videoPhase: LiveVideoState['phase'] | null = null;
  private playerContainer: HTMLDivElement | null = null;
  private playerGeneration = 0;
  private playbackOrigin: PlaybackOrigin = 'implicit';
  // Channels an implicit start already found offline, so it never skips in a circle.
  private skippedChannelIds = new Set<string>();
  // When each channel was last found offline. Implicit starts and "Play next channel" pass over it meanwhile.
  private offlineAt = new Map<string, number>();
  private suppressChannelClick = false;

  private deferredInit = false;
  private lazyObserver: IntersectionObserver | null = null;
  private idleCallbackId: number | ReturnType<typeof setTimeout> | null = null;
  // Play-all cascade: start this panel's channel, but never start a disabled or collapsed panel.
  private readonly boundPlayAllStarter = () => {
    if (this.canHostLiveMedia()) this.triggerInit();
  };

  constructor() {
    super({ id: 'live-news', title: t('panels.liveNews'), className: 'panel-wide', closable: true, collapsible: true });
    this.insertLiveCountBadge(OPTIONAL_LIVE_CHANNELS.filter(hasBuiltinStreams).length);
    this.channels = loadChannelsFromStorage();
    if (this.channels.length === 0) this.channels = getDefaultLiveChannels();
    const savedChannelId = loadFromStorage<string>(STORAGE_KEYS.activeChannel, '');
    const savedChannel = savedChannelId ? this.channels.find(c => c.id === savedChannelId) : null;
    this.activeChannel = savedChannel ?? this.channels[0]!;
    this.createLiveButton();
    this.createMuteButton();
    this.createChannelSwitcher();
    this.renderPlaceholder();
    this.setupLazyInit();
    document.addEventListener('visibilitychange', this.boundVisibilityHandler);
    this.unsubscribeIdle = subscribeLiveMediaIdle((idleAfterMs) => this.stopForIdle(idleAfterMs));
    this.unsubscribeStreamSettings = subscribeLiveStreamsAlwaysOnChange((alwaysOn) => {
      this.alwaysOn = alwaysOn;
      if (!alwaysOn) {
        // Cancel any pending lazy-init so leaving always-on cannot auto-start playback without intent.
        // Anything already playing keeps running — feeds coexist; the idle stop still applies.
        if (this.lazyObserver) { this.lazyObserver.disconnect(); this.lazyObserver = null; }
        if (this.idleCallbackId !== null) {
          if ('cancelIdleCallback' in window) (window as any).cancelIdleCallback(this.idleCallbackId);
          else clearTimeout(this.idleCallbackId as ReturnType<typeof setTimeout>);
          this.idleCallbackId = null;
        }
      }
      if (alwaysOn && !this.deferredInit && this.isPanelVisible()) {
        this.startAlwaysOnPlaybackIfVisible();
      } else if (alwaysOn && !this.deferredInit && !this.lazyObserver) {
        this.setupLazyInit();
      }
    });
    registerLiveMediaStarter('live-news', this.boundPlayAllStarter);
    document.addEventListener('keydown', this.boundFullscreenEscHandler);
  }

  private isPanelVisible(): boolean {
    if (!this.element.isConnected) return false;
    const rect = this.element.getBoundingClientRect();
    return rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth;
  }

  private renderPlaceholder(): void {
    this.deferredInit = false;
    this.playerContainer = null;
    if (this.idleStoppedAfterMs !== null) {
      this.setContentNodes(createLiveMediaIdleNotice({
        panel: 'live-news',
        heading: this.getChannelDisplayName(this.activeChannel),
        idleAfterMs: this.idleStoppedAfterMs,
      }));
      return;
    }
    const container = document.createElement('div');
    container.className = 'live-news-placeholder live-media-shell';

    const status = document.createElement('div');
    status.className = 'live-media-shell-status';
    const dot = document.createElement('span');
    dot.className = 'live-media-shell-dot';
    const statusText = document.createElement('span');
    statusText.textContent = t('components.liveNews.readyStatus') || 'Ready when you are';
    status.append(dot, statusText);

    const label = document.createElement('div');
    label.className = 'live-media-shell-title';
    label.textContent = this.getChannelDisplayName(this.activeChannel);

    const playBtn = document.createElement('button');
    playBtn.className = 'offline-retry';
    playBtn.textContent = t('components.liveNews.playLiveFeed') || 'Play live feed';
    playBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      playAllLiveMedia();
    });

    container.appendChild(status);
    container.appendChild(label);
    container.appendChild(playBtn);
    container.addEventListener('click', () => playAllLiveMedia());
    this.setContentNodes(container);
  }

  private setupLazyInit(): void {
    this.lazyObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some(e => e.isIntersecting)) {
          this.lazyObserver?.disconnect();
          this.lazyObserver = null;
          // An idle stop ends only through Resume or Play; scrolling back into view is neither.
          if (!this.alwaysOn || this.idleStoppedAfterMs !== null) return;
          if ('requestIdleCallback' in window) {
            this.idleCallbackId = (window as any).requestIdleCallback(
              () => { this.idleCallbackId = null; this.triggerInit(); },
              { timeout: 1000 },
            );
          } else {
            this.idleCallbackId = setTimeout(() => { this.idleCallbackId = null; this.triggerInit(); }, 1000);
          }
        }
      },
      { threshold: 0.1 },
    );
    this.lazyObserver.observe(this.element);
  }

  private triggerInit(): void {
    if (this.deferredInit) return;
    this.deferredInit = true;
    if (this.lazyObserver) { this.lazyObserver.disconnect(); this.lazyObserver = null; }
    if (this.idleCallbackId !== null) {
      if ('cancelIdleCallback' in window) (window as any).cancelIdleCallback(this.idleCallbackId);
      else clearTimeout(this.idleCallbackId as ReturnType<typeof setTimeout>);
      this.idleCallbackId = null;
    }
    this.beginPlayback('implicit');
  }

  /** Starts the active channel. The origin decides what an offline channel does: explain itself, or hand over. */
  private beginPlayback(origin: PlaybackOrigin): void {
    this.playbackOrigin = origin;
    this.skippedChannelIds.clear();
    this.requestPlaybackForActiveChannel();
  }

  private requestPlaybackForActiveChannel(): void {
    const streamId = this.activeChannel.id;
    requestLiveMediaPlayback(
      'live-news',
      streamId,
      () => this.startPlaybackForActiveChannel(),
      (reason) => this.stopPlaybackFromController(reason),
    );
  }

  private hasPlaybackIntent(): boolean {
    return this.deferredInit ||
      this.isPlaying ||
      this.videoSession !== null ||
      this.ownsLiveNewsMedia() ||
      (this.idleStoppedAfterMs === null && this.alwaysOn && !document.hidden && this.isPanelVisible());
  }

  private ownsLiveMediaForChannel(channelId: string): boolean {
    const activeMedia = getActiveLiveMedia('live-news');
    return activeMedia?.panelId === 'live-news' && activeMedia.streamId === channelId;
  }

  private ownsActiveLiveMedia(): boolean {
    return this.ownsLiveMediaForChannel(this.activeChannel.id);
  }

  private ownsLiveNewsMedia(): boolean {
    return getActiveLiveMedia('live-news')?.panelId === 'live-news';
  }

  private startAlwaysOnPlaybackIfVisible(): void {
    if (!this.alwaysOn || document.hidden || !this.element.isConnected || !this.isPanelVisible()) return;
    // An idle stop ends only through Resume or Play, so autoplay must not restart it on tab return.
    if (this.idleStoppedAfterMs !== null || this.ownsActiveLiveMedia()) return;
    this.beginPlayback('implicit');
  }

  private startPlaybackForActiveChannel(): void {
    this.isPlaying = true;
    this.idleStoppedAfterMs = null;
    this.updateLiveIndicator();
    this.renderPlayer();
  }

  private stopPlaybackFromController(reason: LiveMediaStopReason): void {
    this.isPlaying = false;
    if (reason !== 'idle') this.idleStoppedAfterMs = null;
    this.updateLiveIndicator();
    this.clearChannelLoadingState();
    this.destroyPlayer();
    // Skip DOM work on a detached panel; destroy() already runs destroyPlayer().
    if (this.element.isConnected) this.renderPlaceholder();
  }

  private saveChannels(): void {
    saveChannelsToStorage(this.channels);
  }

  private stopForIdle(idleAfterMs: number): void {
    if (this.isFullscreen || !this.isPlaying || !getActiveLiveMedia('live-news')) return;
    this.idleStoppedAfterMs = idleAfterMs;
    trackLiveMediaIdleStop('live-news', idleAfterMs);
    stopLiveMediaPlayback('live-news', 'idle');
  }

  private destroyPlayer(): void {
    this.playerGeneration += 1;
    this.videoSession?.destroy();
    this.videoSession = null;
    this.videoPhase = null;
    this.playerContainer = null;
  }

  private createLiveButton(): void {
    this.liveBtn = document.createElement('button');
    this.liveBtn.className = 'live-mute-btn';
    this.liveBtn.title = 'Toggle playback';
    this.updateLiveIndicator();
    this.liveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.togglePlayback();
    });
  }

  private updateLiveIndicator(): void {
    if (!this.liveBtn) return;
    setTrustedHtml(this.liveBtn, trustedHtml(this.isPlaying
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>', "legacy direct innerHTML migration"));
  }

  private togglePlayback(): void {
    if (this.isPlaying || this.videoSession) {
      stopLiveMediaPlayback('live-news', 'user-paused');
      return;
    }

    this.beginPlayback('explicit');
  }

  private createMuteButton(): void {
    this.muteBtn = document.createElement('button');
    this.muteBtn.className = 'live-mute-btn';
    this.muteBtn.title = 'Toggle sound';
    this.updateMuteIcon();
    this.muteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleMute();
    });

    const header = this.element.querySelector('.panel-header');
    if (this.liveBtn) header?.appendChild(this.liveBtn);
    header?.appendChild(this.muteBtn);

    this.createFullscreenButton();
  }

  private createFullscreenButton(): void {
    this.fullscreenBtn = document.createElement('button');
    this.fullscreenBtn.className = 'live-mute-btn';
    this.fullscreenBtn.title = 'Fullscreen';
    setTrustedHtml(this.fullscreenBtn, trustedHtml('<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>', "legacy direct innerHTML migration"));
    this.fullscreenBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      track('live-news-fullscreen', { entering: !this.isFullscreen });
      this.setFullscreen(!this.isFullscreen);
    });
    const header = this.element.querySelector('.panel-header');
    header?.appendChild(this.fullscreenBtn);
  }

  public override supportsFullscreen(): boolean {
    return true;
  }

  public override isFullscreenActive(): boolean {
    return this.isFullscreen;
  }

  public override setFullscreen(fullscreen: boolean): boolean {
    if (this.isFullscreen === fullscreen) return true;
    this.isFullscreen = fullscreen;
    this.element.classList.toggle('live-news-fullscreen', this.isFullscreen);
    document.body.classList.toggle('live-news-fullscreen-active', this.isFullscreen);

    if (this.fullscreenBtn) {
      this.fullscreenBtn.title = this.isFullscreen ? 'Exit fullscreen' : 'Fullscreen';
      setTrustedHtml(this.fullscreenBtn, trustedHtml(this.isFullscreen
        ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/><path d="M3 21l7-7"/></svg>'
        : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>', "legacy direct innerHTML migration"));
    }
    return true;
  }

  private boundFullscreenEscHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.isFullscreen) this.setFullscreen(false);
  };

  private updateMuteIcon(): void {
    if (!this.muteBtn) return;
    setTrustedHtml(this.muteBtn, trustedHtml(this.isMuted
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>', "legacy direct innerHTML migration"));
    this.muteBtn.classList.toggle('unmuted', !this.isMuted);
  }

  private toggleMute(): void {
    this.isMuted = !this.isMuted;
    this.updateMuteIcon();
    this.videoSession?.setMuted(this.isMuted);
  }

  private getChannelDisplayName(channel: LiveChannel): string {
    return channel.name;
  }

  /** Creates a single channel tab button with click and drag handlers. */
  private createChannelButton(channel: LiveChannel): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = `live-channel-btn ${channel.id === this.activeChannel.id ? 'active' : ''}`;
    btn.setAttribute('aria-pressed', String(channel.id === this.activeChannel.id));
    btn.dataset.channelId = channel.id;

    btn.textContent = this.getChannelDisplayName(channel);

    btn.style.cursor = 'grab';
    // Keyboard parity for the mouse drag reorder in createChannelSwitcher:
    // arrows move the focused channel one slot and persist through the same
    // applyChannelOrderFromDom path a completed drag uses.
    btn.addEventListener('keydown', (e) => {
      const back = e.key === 'ArrowLeft';
      const fwd = e.key === 'ArrowRight';
      if (!back && !fwd) return;
      const sibling = back ? btn.previousElementSibling : btn.nextElementSibling;
      if (!(sibling instanceof HTMLElement) || !sibling.classList.contains('live-channel-btn')) return;
      e.preventDefault();
      btn.parentElement?.insertBefore(btn, back ? sibling : sibling.nextElementSibling);
      this.applyChannelOrderFromDom();
      btn.focus();
    });
    btn.addEventListener('click', (e) => {
      if (this.suppressChannelClick) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      e.preventDefault();
      // A connecting channel keeps focus (it is never disabled), so its repeat clicks are ignored here.
      if (btn.getAttribute('aria-busy') === 'true') return;
      this.switchChannel(channel);
    });
    return btn;
  }

  private createChannelSwitcher(): void {
    this.channelSwitcher = document.createElement('div');
    this.channelSwitcher.className = 'live-news-switcher';

    for (const channel of this.channels) {
      this.channelSwitcher.appendChild(this.createChannelButton(channel));
    }

    // Mouse-based drag reorder (works in WKWebView/Tauri)
    let dragging: HTMLElement | null = null;
    let dragStarted = false;
    let startX = 0;
    const THRESHOLD = 6;

    this.channelSwitcher.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const btn = (e.target as HTMLElement).closest('.live-channel-btn') as HTMLElement | null;
      if (!btn) return;
      this.suppressChannelClick = false;
      dragging = btn;
      dragStarted = false;
      startX = e.clientX;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging || !this.channelSwitcher) return;
      if (!dragStarted) {
        if (Math.abs(e.clientX - startX) < THRESHOLD) return;
        dragStarted = true;
        dragging.classList.add('live-channel-dragging');
      }
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.live-channel-btn') as HTMLElement | null;
      if (!target || target === dragging) return;
      const all = Array.from(this.channelSwitcher!.querySelectorAll('.live-channel-btn'));
      const idx = all.indexOf(dragging);
      const targetIdx = all.indexOf(target);
      if (idx === -1 || targetIdx === -1) return;
      if (idx < targetIdx) {
        target.parentElement?.insertBefore(dragging, target.nextSibling);
      } else {
        target.parentElement?.insertBefore(dragging, target);
      }
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      if (dragStarted) {
        dragging.classList.remove('live-channel-dragging');
        this.applyChannelOrderFromDom();
        this.suppressChannelClick = true;
        setTimeout(() => {
          this.suppressChannelClick = false;
        }, 0);
      }
      dragging = null;
      dragStarted = false;
    });

    const toolbar = document.createElement('div');
    toolbar.className = 'live-news-toolbar';
    toolbar.appendChild(this.channelSwitcher);
    this.createManageButton(toolbar);
    this.element.insertBefore(toolbar, this.content);
  }

  private createManageButton(toolbar: HTMLElement): void {
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'live-news-settings-btn';
    openBtn.title = t('components.liveNews.channelSettings') ?? 'Channel Settings';
    setTrustedHtml(openBtn, trustedHtml('<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>', "legacy direct innerHTML migration"));
    openBtn.addEventListener('click', () => {
      this.openChannelManagementModal();
    });
    toolbar.appendChild(openBtn);
  }

  private openChannelManagementModal(): void {
    const existing = document.querySelector('.live-channels-modal-overlay');
    if (existing) return;

    const overlay = document.createElement('div');
    overlay.className = 'live-channels-modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', t('components.liveNews.manage') ?? 'Manage channels');

    const modal = document.createElement('div');
    modal.className = 'live-channels-modal';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'live-channels-modal-close';
    closeBtn.setAttribute('aria-label', t('common.close') ?? 'Close');
    setTrustedHtml(closeBtn, trustedHtml('&times;', "legacy direct innerHTML migration"));

    const container = document.createElement('div');

    modal.appendChild(closeBtn);
    modal.appendChild(container);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    requestAnimationFrame(() => overlay.classList.add('active'));

    import('@/live-channels-window').then(async ({ initLiveChannelsWindow }) => {
      await initLiveChannelsWindow(container);
    }).catch(console.error);

    const close = () => {
      focusTrap.deactivate();
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      this.refreshChannelsFromStorage();
    };
    const focusTrap = createFocusTrap(overlay);
    focusTrap.activate();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    document.addEventListener('keydown', onKey);
  }

  private refreshChannelSwitcher(): void {
    if (!this.channelSwitcher) return;
    setTrustedHtml(this.channelSwitcher, trustedHtml('', "legacy direct innerHTML migration"));
    for (const channel of this.channels) {
      this.channelSwitcher.appendChild(this.createChannelButton(channel));
    }
  }

  private applyChannelOrderFromDom(): void {
    if (!this.channelSwitcher) return;
    const ids = Array.from(this.channelSwitcher.querySelectorAll<HTMLElement>('.live-channel-btn'))
      .map((el) => el.dataset.channelId)
      .filter((id): id is string => !!id);
    const orderMap = new Map(this.channels.map((c) => [c.id, c]));
    this.channels = ids.map((id) => orderMap.get(id)).filter((c): c is LiveChannel => !!c);
    this.saveChannels();
  }

  private resetChannelButtonLoading(btn: HTMLElement): void {
    btn.classList.remove('loading');
    btn.removeAttribute('aria-busy');
    btn.removeAttribute('aria-disabled');
  }

  // Clear every channel button, not only `.loading`. Success used to drop the
  // spinner class while leaving aria-busy set, and a later switch could strip
  // `.loading` from a still-busy predecessor.
  private clearChannelLoadingState(): void {
    this.channelSwitcher?.querySelectorAll('.live-channel-btn').forEach(btn => {
      this.resetChannelButtonLoading(btn as HTMLElement);
    });
  }

  private markChannelButtonLoading(channelId: string): void {
    this.clearChannelLoadingState();
    this.channelSwitcher?.querySelectorAll('.live-channel-btn').forEach(btn => {
      const btnEl = btn as HTMLElement;
      if (btnEl.dataset.channelId !== channelId) return;
      btnEl.classList.add('loading');
      // CSS blocks the pointer during load (pointer-events: none). Announce the
      // same to keyboard/AT without `disabled`, which would drop focus to <body>
      // for the whole connection; the click handler ignores a busy button.
      btnEl.setAttribute('aria-busy', 'true');
      btnEl.setAttribute('aria-disabled', 'true');
    });
  }

  private markActiveChannelButton(channelId: string): void {
    this.channelSwitcher?.querySelectorAll('.live-channel-btn').forEach(btn => {
      const btnEl = btn as HTMLElement;
      const isActive = btnEl.dataset.channelId === channelId;
      btnEl.classList.toggle('active', isActive);
      btnEl.setAttribute('aria-pressed', String(isActive));
    });
  }

  private setChannelOffline(channelId: string, offline: boolean): void {
    this.channelSwitcher?.querySelectorAll<HTMLElement>('.live-channel-btn').forEach(btn => {
      if (btn.dataset.channelId === channelId) btn.classList.toggle('offline', offline);
    });
  }

  /** Keep switcher offline marks aligned with failure memory (do not wipe on a no-intent switch). */
  private syncOfflineButtonMarks(): void {
    this.channelSwitcher?.querySelectorAll<HTMLElement>('.live-channel-btn').forEach(btn => {
      const id = btn.dataset.channelId;
      if (id) btn.classList.toggle('offline', this.isKnownOffline(id));
    });
  }

  private switchChannel(channel: LiveChannel): void {
    if (channel.id === this.activeChannel.id) return;

    this.activeChannel = channel;
    saveToStorage(STORAGE_KEYS.activeChannel, channel.id);
    const shouldStartMedia = this.hasPlaybackIntent();
    this.markActiveChannelButton(channel.id);

    if (!shouldStartMedia) {
      this.clearChannelLoadingState();
      this.syncOfflineButtonMarks();
      this.renderPlaceholder();
      return;
    }

    this.beginPlayback('explicit');
    // Busy until this channel's session settles on a verdict (onVideoState) or playback stops.
    if (this.videoPhase === 'connecting') this.markChannelButtonLoading(channel.id);
  }

  private isKnownOffline(channelId: string): boolean {
    const offlineAt = this.offlineAt.get(channelId);
    return offlineAt !== undefined && Date.now() - offlineAt < LIVE_VIDEO_TIMING.failureMemoryMs;
  }

  /** The next channel after `from` in the switcher order that `accept` allows, wrapping around. */
  private nextChannel(from: LiveChannel, accept: (channel: LiveChannel) => boolean): LiveChannel | null {
    const start = this.channels.findIndex((channel) => channel.id === from.id);
    for (let step = 1; step < this.channels.length + (start === -1 ? 1 : 0); step++) {
      const candidate = this.channels[(start + step) % this.channels.length]!;
      if (candidate.id !== from.id && accept(candidate)) return candidate;
    }
    return null;
  }

  private showOfflineMessage(channel: LiveChannel, reason: OfflineReason = 'not-live', watchUrl: string | null = null): void {
    this.destroyPlayer();
    // Nothing is playing, so the header button offers play rather than pause.
    this.isPlaying = false;
    this.updateLiveIndicator();

    const card = document.createElement('div');
    card.className = 'live-offline live-offline-compact';
    card.setAttribute('role', 'status');

    const icon = document.createElement('div');
    icon.className = 'offline-icon';
    icon.textContent = '📺';

    const text = document.createElement('div');
    text.className = 'offline-text';
    text.textContent = offlineReasonText(reason, this.getChannelDisplayName(channel));

    const actions = document.createElement('div');
    actions.className = 'live-offline-actions';
    if (reason === 'needs-channel-url' || reason === 'insecure-url') {
      actions.appendChild(actionButton(t('components.liveNews.manage') || 'Manage channels', () => this.openChannelManagementModal()));
    } else if (reason !== 'no-entries') {
      // switchChannel no-ops when the id is already active, so retry re-requests playback for the current stream.
      const retry = actionButton(t('common.retry') || 'Retry', () => this.beginPlayback('explicit'));
      retry.dataset.liveRetry = '';
      actions.appendChild(retry);
    }
    const next = this.nextChannel(channel, (candidate) => !this.isKnownOffline(candidate.id));
    if (next) actions.appendChild(actionButton(t('components.liveNews.playNextChannel') || 'Play next channel', () => this.switchChannel(next)));
    if (watchUrl) actions.appendChild(youtubeLink(watchUrl));

    card.append(icon, text, actions);
    // #6557: a terminal offline state is authoritative content.
    this.setContentNodes(card);
  }

  private renderPlayer(): void {
    this.destroyPlayer();
    const generation = ++this.playerGeneration;
    const isCurrent = () => generation === this.playerGeneration;
    const channel = this.activeChannel;
    const container = this.ensurePlayerContainer();
    const session = openLiveVideo(container, {
      source: liveVideoSourceFor(channel),
      autoplay: true,
      muted: this.isMuted,
      presentation: { title: `${this.getChannelDisplayName(channel)} live feed`, className: 'live-news-media', controls: true },
      onState: (state) => {
        if (isCurrent()) this.onVideoState(channel, state);
      },
      onMutedChange: (muted) => {
        if (!isCurrent()) return;
        this.isMuted = muted;
        this.updateMuteIcon();
      },
      onPlayingChange: (playing) => {
        // The viewer paused or resumed from the player's own controls; the idle stop leaves a paused stream alone.
        if (!isCurrent() || this.isPlaying === playing) return;
        this.isPlaying = playing;
        this.updateLiveIndicator();
      },
    });
    // The first state arrives synchronously, and an offline one may already have moved playback on.
    if (isCurrent()) this.videoSession = session;
    else session.destroy();
  }

  private ensurePlayerContainer(): HTMLDivElement {
    this.deferredInit = true;
    const container = document.createElement('div');
    container.className = 'live-news-player';
    this.playerContainer = container;
    this.setContentNodes(container);
    return container;
  }

  private onVideoState(channel: LiveChannel, state: LiveVideoState): void {
    this.videoPhase = state.phase;
    if (state.phase !== 'connecting') this.clearChannelLoadingState();
    switch (state.phase) {
      case 'connecting':
        this.showPlayerStatus('cover', t('components.liveNews.connecting', { name: this.getChannelDisplayName(channel) }));
        return;
      case 'live':
        this.offlineAt.delete(channel.id);
        this.skippedChannelIds.clear();
        this.setChannelOffline(channel.id, false);
        this.showPlayerStatus(null);
        return;
      case 'recording':
        this.setChannelOffline(channel.id, false);
        this.showPlayerStatus('chip', t('components.liveNews.recording'));
        return;
      case 'unverified':
        this.showPlayerStatus('chip', t('components.liveNews.unverified'), state.watchUrl);
        return;
      case 'offline':
        this.handleChannelOffline(channel, state.reason, state.watchUrl);
    }
  }

  /** A cover over the player while it connects, a corner chip for a disclosed state, or nothing once live. */
  private showPlayerStatus(kind: 'cover' | 'chip' | null, text = '', watchUrl: string | null = null): void {
    const container = this.playerContainer;
    if (!container) return;
    container.querySelector('.live-news-status')?.remove();
    if (!kind) return;

    const status = document.createElement('div');
    status.className = `live-news-status live-news-status--${kind}`;
    status.setAttribute('role', 'status');
    const label = document.createElement('span');
    label.textContent = text;
    status.appendChild(label);
    if (watchUrl) {
      status.appendChild(actionButton(t('components.liveNews.signInToYouTube') || 'Sign in to YouTube', () => void this.openYouTubeSignIn()));
      status.appendChild(youtubeLink(watchUrl));
    }
    container.appendChild(status);
  }

  private handleChannelOffline(channel: LiveChannel, reason: OfflineReason, watchUrl: string | null): void {
    this.offlineAt.set(channel.id, Date.now());
    this.setChannelOffline(channel.id, true);
    if (this.playbackOrigin === 'implicit') {
      this.skippedChannelIds.add(channel.id);
      const next = this.nextChannel(channel, (candidate) => !this.skippedChannelIds.has(candidate.id) && !this.isKnownOffline(candidate.id));
      if (next) {
        this.playChannelWithoutSaving(next);
        return;
      }
    }
    this.showOfflineMessage(channel, reason, watchUrl);
  }

  /** Moves an implicit start on to another channel without making it the saved choice. */
  private playChannelWithoutSaving(channel: LiveChannel): void {
    this.activeChannel = channel;
    this.markActiveChannelButton(channel.id);
    this.requestPlaybackForActiveChannel();
  }

  private async openYouTubeSignIn(): Promise<void> {
    const youtubeLoginUrl = 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https://www.youtube.com/';
    if (isDesktopRuntime()) {
      try {
        const { tryInvokeTauri } = await import('@/services/tauri-bridge');
        await tryInvokeTauri('open_youtube_login');
      } catch {
        window.open(youtubeLoginUrl, '_blank', 'noopener,noreferrer');
      }
    } else {
      window.open(youtubeLoginUrl, '_blank', 'noopener,noreferrer');
    }
  }

  public refresh(): void {
    this.videoSession?.setMuted(this.isMuted);
  }

  /** Reload channel list from storage (e.g. after edit in separate channel management window). */
  public refreshChannelsFromStorage(): void {
    this.channels = loadChannelsFromStorage();
    if (this.channels.length === 0) this.channels = getDefaultLiveChannels();
    this.refreshChannelSwitcher();
    const current = this.channels.find((c) => c.id === this.activeChannel.id);
    if (!current) {
      // The active channel was removed. switchChannel ignores the channel it already holds, so hand it
      // the replacement instead of assigning it first; it stops the removed channel and saves the new one.
      const next = this.channels[0];
      if (next) this.switchChannel(next);
      return;
    }
    // An edit can keep the id and change what plays (a custom stream URL). Hold the edited channel, and
    // move a running session onto its new source; a stopped channel plays the new source next time.
    const sourceChanged = liveVideoSourceFor(current).entries.join('\n') !== liveVideoSourceFor(this.activeChannel).entries.join('\n');
    this.activeChannel = current;
    if (sourceChanged && this.videoSession) this.renderPlayer();
  }

  public stopLiveMediaForClose(): void {
    const wasIdleStopped = this.idleStoppedAfterMs !== null;
    this.idleStoppedAfterMs = null;
    stopLiveMediaPlayback('live-news', 'destroyed');
    if (wasIdleStopped || this.videoSession) {
      this.isPlaying = false;
      this.updateLiveIndicator();
      this.destroyPlayer();
      this.renderPlaceholder();
    }
  }

  public resumeLiveMediaForShow(): void {
    if (!this.alwaysOn) return;
    if (this.isPanelVisible()) {
      this.startAlwaysOnPlaybackIfVisible();
    } else if (!this.lazyObserver) {
      this.setupLazyInit();
    }
  }

  public destroy(): void {
    unregisterLiveMediaStarter('live-news', this.boundPlayAllStarter);
    releaseLiveMediaPlayback('live-news');
    this.destroyPlayer();
    this.unsubscribeStreamSettings?.();
    this.unsubscribeStreamSettings = null;
    this.unsubscribeIdle?.();
    this.unsubscribeIdle = null;

    if (this.lazyObserver) { this.lazyObserver.disconnect(); this.lazyObserver = null; }
    if (this.idleCallbackId !== null) {
      if ('cancelIdleCallback' in window) (window as any).cancelIdleCallback(this.idleCallbackId);
      else clearTimeout(this.idleCallbackId as ReturnType<typeof setTimeout>);
      this.idleCallbackId = null;
    }

    document.removeEventListener('visibilitychange', this.boundVisibilityHandler);
    document.removeEventListener('keydown', this.boundFullscreenEscHandler);
    if (this.isFullscreen) this.setFullscreen(false);

    super.destroy();
  }
}
