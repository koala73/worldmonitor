import { SITE_VARIANT } from '@/config/variant';
import { STORAGE_KEYS } from '@/config/variants/base';
import { loadFromStorage, saveToStorage } from '@/utils';

export interface LiveChannel {
  id: string;
  name: string;
  handle?: string; // YouTube channel handle (e.g., @bloomberg) - optional for HLS streams
  fallbackVideoId?: string; // Fallback if no live stream detected
  videoId?: string; // Dynamically fetched live video ID
  isLive?: boolean;
  hlsUrl?: string; // HLS manifest URL for native <video> playback (desktop)
  useFallbackOnly?: boolean; // Skip auto-detection, always use fallback
  geoAvailability?: string[]; // ISO 3166-1 alpha-2 codes; undefined = available everywhere
}


// Full variant: World news channels (24/7 live streams)
const FULL_LIVE_CHANNELS: LiveChannel[] = [
  { id: 'bloomberg', name: 'Bloomberg', handle: '@markets', fallbackVideoId: 'QB5BNdBFujE' },
  { id: 'sky', name: 'SkyNews', handle: '@SkyNews', fallbackVideoId: 'xDWQ3LkccY8' },
  { id: 'euronews', name: 'Euronews', handle: '@euronews', fallbackVideoId: 'pykpO5kQJ98' },
  { id: 'dw', name: 'DW', handle: '@DWNews', fallbackVideoId: 'LuKwFajn37U' },
  { id: 'cnn', name: 'CNN', handle: '@CNN', fallbackVideoId: 'GotlA1KKWoo' },
  { id: 'france24', name: 'France 24', handle: '@FRANCE24', fallbackVideoId: 'HvZt-nh9sGg' },
  { id: 'alarabiya', name: 'AlArabiya', handle: '@AlArabiya', fallbackVideoId: 'n7eQejkXbnM', useFallbackOnly: true },
  { id: 'aljazeera', name: 'AlJazeera', handle: '@AlJazeeraEnglish', fallbackVideoId: 'gCNeDWCI0vo', useFallbackOnly: true },
];

// Tech variant: Tech & business channels
const TECH_LIVE_CHANNELS: LiveChannel[] = [
  { id: 'bloomberg', name: 'Bloomberg', handle: '@markets', fallbackVideoId: 'QB5BNdBFujE' },
  { id: 'yahoo', name: 'Yahoo Finance', handle: '@YahooFinance', fallbackVideoId: 'KQp-e_XQnDE' },
  { id: 'nasa', name: 'Sen Space Live', handle: '@NASA', fallbackVideoId: 'fO9e9jnhYK8', useFallbackOnly: true },
];

// Optional channels users can add from the "Available Channels" tab UI
// Includes default channels so they appear in the grid for toggle on/off
export const OPTIONAL_LIVE_CHANNELS: LiveChannel[] = [
  // North America (defaults first)
  { id: 'bloomberg', name: 'Bloomberg', handle: '@markets', fallbackVideoId: 'QB5BNdBFujE' },
  { id: 'yahoo', name: 'Yahoo Finance', handle: '@YahooFinance', fallbackVideoId: 'KQp-e_XQnDE' },
  { id: 'cnn', name: 'CNN', handle: '@CNN', fallbackVideoId: 'GotlA1KKWoo' },
  { id: 'fox-news', name: 'Fox News', handle: '@FoxNews' },
  { id: 'newsmax', name: 'Newsmax', handle: '@NEWSMAX' },
  { id: 'abc-news', name: 'ABC News', handle: '@ABCNews' },
  { id: 'cbs-news', name: 'CBS News', handle: '@CBSNews' },
  { id: 'nbc-news', name: 'NBC News', handle: '@NBCNews' },
  { id: 'cbc-news', name: 'CBC News', handle: '@CBCNews' },
  { id: 'ctv-news', name: 'CTV News', hlsUrl: 'https://pe-fa-lp02a.9c9media.com/live/News1Digi/p/hls/00000201/38ef78f479b07aa0/index/0c6a10a2/live/stream/h264/v1/3500000/manifest.m3u8', useFallbackOnly: true },
  { id: 'reuters-tv', name: 'Reuters TV', hlsUrl: 'https://reuters-reutersnow-1-eu.rakuten.wurl.tv/playlist.m3u8', useFallbackOnly: true },
  { id: 'nasa', name: 'Sen Space Live', handle: '@NASA', fallbackVideoId: 'fO9e9jnhYK8', useFallbackOnly: true },
  // Europe (defaults first)
  { id: 'sky', name: 'SkyNews', handle: '@SkyNews', fallbackVideoId: 'xDWQ3LkccY8' },
  { id: 'euronews', name: 'Euronews', handle: '@euronews', fallbackVideoId: 'pykpO5kQJ98' },
  { id: 'dw', name: 'DW', handle: '@DWNews', fallbackVideoId: 'LuKwFajn37U' },
  { id: 'france24', name: 'France 24', handle: '@FRANCE24', fallbackVideoId: 'HvZt-nh9sGg' },
  { id: 'bbc-news', name: 'BBC News', handle: '@BBCNews' },
  { id: 'gb-news', name: 'GB News', hlsUrl: 'https://live-gbnews.simplestreamcdn.com/live5/gbnews/bitrate1.isml/manifest.m3u8', useFallbackOnly: true },
  { id: 'the-guardian', name: 'The Guardian', hlsUrl: 'https://rakuten-guardian-1-ie.samsung.wurl.tv/playlist.m3u8', useFallbackOnly: true },
  { id: 'france24-en', name: 'France 24 English', handle: '@France24_en', fallbackVideoId: 'HvZt-nh9sGg' },
  { id: 'rtve', name: 'RTVE 24H', handle: '@RTVENoticias' },
  { id: 'phoenix', name: 'Phoenix', hlsUrl: 'https://zdf-hls-19.akamaized.net/hls/live/2016502/de/veryhigh/master.m3u8', useFallbackOnly: true, geoAvailability: ['DE', 'AT', 'CH'] },
  { id: 'rtp3', name: 'RTP3', hlsUrl: 'https://streaming-live.rtp.pt/livetvhlsDVR/rtpnHDdvr.smil/playlist.m3u8?DVR=', useFallbackOnly: true, geoAvailability: ['PT', 'BR'] },
  { id: 'trt-haber', name: 'TRT Haber', handle: '@trthaber' },
  { id: 'ntv-turkey', name: 'NTV', handle: '@NTV', fallbackVideoId: 'pqq5c6k70kk' },
  { id: 'cnn-turk', name: 'CNN TURK', handle: '@cnnturk' },
  { id: 'tv-rain', name: 'TV Rain', handle: '@tvrain' },
  { id: 'rt', name: 'RT', hlsUrl: 'https://rt-glb.rttv.com/dvr/rtnews/playlist.m3u8', useFallbackOnly: true },
  { id: 'tvp-info', name: 'TVP Info', handle: '@tvpinfo', fallbackVideoId: '3jKb-uThfrg' },
  { id: 'telewizja-republika', name: 'Telewizja Republika', handle: '@Telewizja_Republika', fallbackVideoId: 'dzntyCTgJMQ' },
  // Latin America & Portuguese
  { id: 'cnn-brasil', name: 'CNN Brasil', handle: '@CNNbrasil' },
  { id: 'jovem-pan', name: 'Jovem Pan News', handle: '@jovempannews' },
  { id: 'record-news', name: 'Record News', handle: '@RecordNews', hlsUrl: 'https://stream.ads.ottera.tv/playlist.m3u8?network_id=2116' },
  { id: 'band-jornalismo', name: 'Band Jornalismo', handle: '@BandJornalismo' },
  { id: 'tn-argentina', name: 'TN (Todo Noticias)', handle: '@todonoticias', fallbackVideoId: 'cb12KmMMDJA' },
  { id: 'c5n', name: 'C5N', handle: '@c5n' },
  { id: 'milenio', name: 'MILENIO', handle: '@MILENIO' },
  { id: 'noticias-caracol', name: 'Noticias Caracol', handle: '@NoticiasCaracol' },
  { id: 'ntn24', name: 'NTN24', handle: '@NTN24' },
  { id: 't13', name: 'T13', handle: '@Teletrece' },
  { id: 'dw-espanol', name: 'DW Español', hlsUrl: 'https://dwamdstream104.akamaized.net/hls/live/2015530/dwstream104/stream04/streamPlaylist.m3u8', useFallbackOnly: true },
  { id: 'rt-espanol', name: 'RT Español', hlsUrl: 'https://rt-esp.rttv.com/dvr/rtesp/playlist.m3u8', useFallbackOnly: true },
  { id: 'cgtn-espanol', name: 'CGTN Español', hlsUrl: 'https://news.cgtn.com/resource/live/espanol/cgtn-e.m3u8', useFallbackOnly: true },
  // Asia
  { id: 'tbs-news', name: 'TBS NEWS DIG', handle: '@tbsnewsdig' },
  { id: 'ann-news', name: 'ANN News', handle: '@ANNnewsCH' },
  { id: 'ntv-news', name: 'NTV News (Japan)', handle: '@ntv_news' },
  { id: 'cti-news', name: 'CTI News (Taiwan)', handle: '@中天新聞CtiNews' },
  { id: 'wion', name: 'WION', handle: '@WION' },
  { id: 'ndtv', name: 'NDTV 24x7', handle: '@NDTV' },
  { id: 'cgtn', name: 'CGTN', hlsUrl: 'https://news.cgtn.com/resource/live/english/cgtn-news.m3u8', useFallbackOnly: true },
  { id: 'cna-asia', name: 'CNA (NewsAsia)', handle: '@channelnewsasia', fallbackVideoId: 'XWq5kBlakcQ' },
  { id: 'nhk-world', name: 'NHK World Japan', handle: '@NHKWORLDJAPAN' },
  { id: 'arirang-news', name: 'Arirang News', handle: '@ArirangCoKrArirangNEWS', hlsUrl: 'https://amdlive-ch01-ctnd-com.akamaized.net/arirang_1ch/smil:arirang_1ch.smil/playlist.m3u8' },
  { id: 'india-today', name: 'India Today', handle: '@indiatoday', fallbackVideoId: 'sYZtOFzM78M' },
  { id: 'abp-news', name: 'ABP News', handle: '@ABPNews', hlsUrl: 'https://abplivetv.pc.cdn.bitgravity.com/httppush/abp_livetv/abp_abpnews/master.m3u8' },
  // Middle East (defaults first)
  { id: 'alarabiya', name: 'AlArabiya', handle: '@AlArabiya', fallbackVideoId: 'n7eQejkXbnM', useFallbackOnly: true },
  { id: 'aljazeera', name: 'AlJazeera', handle: '@AlJazeeraEnglish', fallbackVideoId: 'gCNeDWCI0vo', useFallbackOnly: true },
  { id: 'al-hadath', name: 'Al Hadath', handle: '@AlHadath' },
  { id: 'sky-news-arabia', name: 'Sky News Arabia', handle: '@skynewsarabia' },
  { id: 'trt-world', name: 'TRT World', handle: '@TRTWorld' },
  { id: 'iran-intl', name: 'Iran International', handle: '@IranIntl' },
  { id: 'cgtn-arabic', name: 'CGTN Arabic', handle: '@CGTNArabic' },
  { id: 'kan-11', name: 'Kan 11', handle: '@KAN11NEWS' },
  { id: 'i24-news', name: 'i24NEWS (Israel)', handle: '@i24NEWS_HE' },
  { id: 'asharq-news', name: 'Asharq News', handle: '@asharqnews', fallbackVideoId: 'f6VpkfV7m4Y', useFallbackOnly: true },
  { id: 'aljazeera-arabic', name: 'AlJazeera Arabic', handle: '@AljazeeraChannel', fallbackVideoId: 'bNyUyrR0PHo', useFallbackOnly: true },
  { id: 'aljazeera-mubasher', name: 'Al Jazeera Mubasher', hlsUrl: 'https://live-hls-web-ajm.getaj.net/AJM/index.m3u8', useFallbackOnly: true },
  { id: 'alarabiya-business', name: 'Al Arabiya Business', hlsUrl: 'https://live.alarabiya.net/alarabiapublish/aswaaq.smil/playlist.m3u8', useFallbackOnly: true },
  { id: 'al-qahera-news', name: 'Al Qahera News', hlsUrl: 'https://bcovlive-a.akamaihd.net/d30cbb3350af4cb7a6e05b9eb1bfd850/eu-west-1/6057955906001/playlist.m3u8', useFallbackOnly: true },
  { id: 'press-tv', name: 'Press TV', hlsUrl: 'https://cdnlive.presstv.ir/cdnlive/smil:cdnlive.smil/playlist.m3u8', useFallbackOnly: true },
  { id: 'dw-arabic', name: 'DW Arabic', hlsUrl: 'https://dwamdstream103.akamaized.net/hls/live/2015526/dwstream103/index.m3u8', useFallbackOnly: true },
  { id: 'rt-arabic', name: 'RT Arabic', hlsUrl: 'https://rt-arb.rttv.com/dvr/rtarab/playlist.m3u8', useFallbackOnly: true },
  { id: 'rudaw', name: 'Rudaw', hlsUrl: 'https://svs.itworkscdn.net/rudawlive/rudawlive.smil/playlist.m3u8', useFallbackOnly: true },
  // Africa
  { id: 'africanews', name: 'Africanews', handle: '@africanews' },
  { id: 'channels-tv', name: 'Channels TV', handle: '@ChannelsTelevision' },
  { id: 'ktn-news', name: 'KTN News', handle: '@ktnnews_kenya' },
  { id: 'enca', name: 'eNCA', handle: '@encanews' },
  { id: 'sabc-news', name: 'SABC News', handle: '@SABCDigitalNews', hlsUrl: 'https://sabconetanw.cdn.mangomolo.com/news/smil:news.stream.smil/playlist.m3u8' },
  { id: 'arise-news', name: 'Arise News', handle: '@AriseNewsChannel' },
  // Europe (additional)
  { id: 'welt', name: 'WELT', handle: '@WELTVideoTV', geoAvailability: ['DE', 'AT', 'CH'] },
  { id: 'tagesschau24', name: 'Tagesschau24', handle: '@tagesschau' },
  { id: 'euronews-fr', name: 'Euronews FR', handle: '@euronewsfr', fallbackVideoId: 'NiRIbKwAejk' },
  { id: 'euronews-gr', name: 'Euronews GR', handle: '@euronewsgr' },
  { id: 'skai-tv', name: 'SKAI TV', handle: '@skaitv' },
  { id: 'ert-news', name: 'ERT News', handle: '@ertgr', hlsUrl: 'https://ertflix.ascdn.broadpeak.io/ertlive/ertnews/default/index.m3u8', useFallbackOnly: true },
  { id: 'france24-fr', name: 'France 24 FR', handle: '@France24_fr', fallbackVideoId: 'a47ckXKZjxI' },
  { id: 'france-info', name: 'France Info', handle: '@franceinfo' },
  { id: 'bfmtv', name: 'BFMTV', handle: '@BFMTV' },
  { id: 'tv5monde-info', name: 'TV5 Monde Info', handle: '@TV5MONDEInfo', hlsUrl: 'https://ott.tv5monde.com/Content/HLS/Live/channel(info)/index.m3u8', geoAvailability: ['FR', 'BE', 'CH', 'CA'] },
  { id: 'nrk1', name: 'NRK1', handle: '@nrk', hlsUrl: 'https://nrk-nrk1.akamaized.net/21/0/hls/nrk_1/playlist.m3u8', geoAvailability: ['NO'] },
  { id: 'aljazeera-balkans', name: 'Al Jazeera Balkans', handle: '@AlJazeeraBalkans', hlsUrl: 'https://live-hls-web-ajb.getaj.net/AJB/index.m3u8' },
  // Oceania
  { id: 'abc-news-au', name: 'ABC News Australia', handle: '@abcnewsaustralia', fallbackVideoId: 'vOTiJkg1voo' },
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

/** Returns optional channels filtered by user country. Channels without geoAvailability pass through. */
export function getFilteredOptionalChannels(userCountry: string | null): LiveChannel[] {
  if (!userCountry) return OPTIONAL_LIVE_CHANNELS;
  const uc = userCountry.toUpperCase();
  return OPTIONAL_LIVE_CHANNELS.filter((c) => !c.geoAvailability || c.geoAvailability.includes(uc));
}

/** Returns region entries with geo-restricted channel IDs removed for the user's country. */
export function getFilteredChannelRegions(userCountry: string | null): typeof OPTIONAL_CHANNEL_REGIONS {
  if (!userCountry) return OPTIONAL_CHANNEL_REGIONS;
  const filtered = getFilteredOptionalChannels(userCountry);
  const allowedIds = new Set(filtered.map((c) => c.id));
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

const DEFAULT_STORED: StoredLiveChannels = {
  order: DEFAULT_LIVE_CHANNELS.map((c) => c.id),
};

export const DIRECT_HLS_MAP: Readonly<Record<string, string>> = {
  'sky': 'https://linear901-oo-hls0-prd-gtm.delivery.skycdp.com/17501/sde-fast-skynews/master.m3u8',
  'euronews': 'https://dash4.antik.sk/live/test_euronews/playlist.m3u8',
  'dw': 'https://dwamdstream103.akamaized.net/hls/live/2015526/dwstream103/master.m3u8',
  'france24': 'https://amg00106-france24-france24-samsunguk-qvpp8.amagi.tv/playlist/amg00106-france24-france24-samsunguk/playlist.m3u8',
  'alarabiya': 'https://live.alarabiya.net/alarabiapublish/alarabiya.smil/playlist.m3u8',
  'aljazeera': 'https://live-hls-apps-aje-fa.getaj.net/AJE/index.m3u8',
  'bloomberg': 'https://bloomberg.com/media-manifest/streams/us.m3u8',
  'abc-news': 'https://lnc-abc-news.tubi.video/index.m3u8',
  'nbc-news': 'https://dai2.xumo.com/amagi_hls_data_xumo1212A-xumo-nbcnewsnow/CDN/master.m3u8',
  'ndtv': 'https://ndtvindiaelemarchana.akamaized.net/hls/live/2003679/ndtvindia/master.m3u8',
  'i24-news': 'https://bcovlive-a.akamaihd.net/6e3dd61ac4c34d6f8fb9698b565b9f50/eu-central-1/5377161796001/playlist-all_dvr.m3u8',
  'cgtn-arabic': 'https://news.cgtn.com/resource/live/arabic/cgtn-a.m3u8',
  'cbs-news': 'https://cbsn-us.cbsnstream.cbsnews.com/out/v1/55a8648e8f134e82a470f83d562deeca/master.m3u8',
  'trt-world': 'https://tv-trtworld.medya.trt.com.tr/master.m3u8',
  'sky-news-arabia': 'https://live-stream.skynewsarabia.com/c-horizontal-channel/horizontal-stream/index.m3u8',
  'al-hadath': 'https://av.alarabiya.net/alarabiapublish/alhadath.smil/playlist.m3u8',
  'rt': 'https://rt-glb.rttv.com/dvr/rtnews/playlist.m3u8',
  'abc-news-au': 'https://abc-iview-mediapackagestreams-2.akamaized.net/out/v1/6e1cc6d25ec0480ea099a5399d73bc4b/index.m3u8',
  'bbc-news': 'https://vs-hls-push-uk.live.fastly.md.bbci.co.uk/x=4/i=urn:bbc:pips:service:bbc_news_channel_hd/iptv_hd_abr_v1.m3u8',
  'tagesschau24': 'https://tagesschau.akamaized.net/hls/live/2020115/tagesschau/tagesschau_1/master.m3u8',
  'india-today': 'https://indiatodaylive.akamaized.net/hls/live/2014320/indiatoday/indiatodaylive/playlist.m3u8',
  'rudaw': 'https://svs.itworkscdn.net/rudawlive/rudawlive.smil/playlist.m3u8',
  'kan-11': 'https://kan11.media.kan.org.il/hls/live/2024514/2024514/master.m3u8',
  'tv5monde-info': 'https://ott.tv5monde.com/Content/HLS/Live/channel(info)/index.m3u8',
  'arise-news': 'https://liveedge-arisenews.visioncdn.com/live-hls/arisenews/arisenews/arisenews_web/master.m3u8',
  'nhk-world': 'https://nhkwlive-ojp.akamaized.net/hls/live/2003459/nhkwlive-ojp-en/index_4M.m3u8',
  'cbc-news': 'https://cbcnewshd-f.akamaihd.net/i/cbcnews_1@8981/index_2500_av-p.m3u8',
  'record-news': 'https://stream.ads.ottera.tv/playlist.m3u8?network_id=2116',
  'abp-news': 'https://abplivetv.pc.cdn.bitgravity.com/httppush/abp_livetv/abp_abpnews/master.m3u8',
  'nrk1': 'https://nrk-nrk1.akamaized.net/21/0/hls/nrk_1/playlist.m3u8',
  'aljazeera-balkans': 'https://live-hls-web-ajb.getaj.net/AJB/index.m3u8',
  'sabc-news': 'https://sabconetanw.cdn.mangomolo.com/news/smil:news.stream.smil/chunklist_b250000_t64MjQwcA==.m3u8',
  'arirang-news': 'https://amdlive-ch01-ctnd-com.akamaized.net/arirang_1ch/smil:arirang_1ch.smil/playlist.m3u8',
  'fox-news': 'https://247preview.foxnews.com/hls/live/2020027/fncv3preview/primary.m3u8',
  'aljazeera-arabic': 'https://live-hls-web-aja.getaj.net/AJA/index.m3u8',
  'cgtn': 'https://news.cgtn.com/resource/live/english/cgtn-news.m3u8',
  'gb-news': 'https://live-gbnews.simplestreamcdn.com/live5/gbnews/bitrate1.isml/manifest.m3u8',
  'reuters-tv': 'https://reuters-reutersnow-1-eu.rakuten.wurl.tv/playlist.m3u8',
  'the-guardian': 'https://rakuten-guardian-1-ie.samsung.wurl.tv/playlist.m3u8',
  'phoenix': 'https://zdf-hls-19.akamaized.net/hls/live/2016502/de/veryhigh/master.m3u8',
  'ctv-news': 'https://pe-fa-lp02a.9c9media.com/live/News1Digi/p/hls/00000201/38ef78f479b07aa0/index/0c6a10a2/live/stream/h264/v1/3500000/manifest.m3u8',
  'al-qahera-news': 'https://bcovlive-a.akamaihd.net/d30cbb3350af4cb7a6e05b9eb1bfd850/eu-west-1/6057955906001/playlist.m3u8',
  'aljazeera-mubasher': 'https://live-hls-web-ajm.getaj.net/AJM/index.m3u8',
  'alarabiya-business': 'https://live.alarabiya.net/alarabiapublish/aswaaq.smil/playlist.m3u8',
  'rtp3': 'https://streaming-live.rtp.pt/livetvhlsDVR/rtpnHDdvr.smil/playlist.m3u8?DVR=',
  'dw-arabic': 'https://dwamdstream103.akamaized.net/hls/live/2015526/dwstream103/index.m3u8',
  'dw-espanol': 'https://dwamdstream104.akamaized.net/hls/live/2015530/dwstream104/stream04/streamPlaylist.m3u8',
  'rt-arabic': 'https://rt-arb.rttv.com/dvr/rtarab/playlist.m3u8',
  'rt-espanol': 'https://rt-esp.rttv.com/dvr/rtesp/playlist.m3u8',
  'cgtn-espanol': 'https://news.cgtn.com/resource/live/espanol/cgtn-e.m3u8',
  'press-tv': 'https://cdnlive.presstv.ir/cdnlive/smil:cdnlive.smil/playlist.m3u8',
};

if (import.meta.env.DEV) {
  const allChannels = [...FULL_LIVE_CHANNELS, ...TECH_LIVE_CHANNELS, ...OPTIONAL_LIVE_CHANNELS];
  for (const id of Object.keys(DIRECT_HLS_MAP)) {
    const ch = allChannels.find(c => c.id === id);
    if (!ch) console.error(`[LiveNews] DIRECT_HLS_MAP key '${id}' has no matching channel`);
    else if (!ch.fallbackVideoId && !ch.hlsUrl && !ch.handle) {
      console.error(`[LiveNews] Channel '${id}' in DIRECT_HLS_MAP lacks fallback (videoId/hlsUrl/handle)`);
    }
  }
}

export const BUILTIN_IDS = new Set([
  ...FULL_LIVE_CHANNELS.map((c) => c.id),
  ...TECH_LIVE_CHANNELS.map((c) => c.id),
  ...OPTIONAL_LIVE_CHANNELS.map((c) => c.id),
]);

export function loadChannelsFromStorage(): LiveChannel[] {
  const stored = loadFromStorage<StoredLiveChannels>(STORAGE_KEYS.liveChannels, DEFAULT_STORED);
  const order = stored.order?.length ? stored.order : DEFAULT_STORED.order;
  const channelMap = new Map<string, LiveChannel>();
  for (const c of FULL_LIVE_CHANNELS) channelMap.set(c.id, { ...c });
  for (const c of TECH_LIVE_CHANNELS) channelMap.set(c.id, { ...c });
  for (const c of OPTIONAL_LIVE_CHANNELS) channelMap.set(c.id, { ...c });
  for (const c of stored.custom ?? []) {
    if (c.id && (c.handle || c.hlsUrl)) channelMap.set(c.id, { ...c });
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

