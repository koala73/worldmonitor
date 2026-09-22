// Live video sources: the owner's edit point for the Live Webcams wall and the Live News channels.
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
//   npm run live-video:check -- --slot live-news/cnn
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

/**
 * Live News, keyed by channel id (the channel's name and handle live in LiveNewsPanel.ts). The
 * broadcaster's own HLS stream comes first where one exists, then a verified live video, then the
 * channel's live embed where YouTube allows it. A channel with [] is hidden from Available channels.
 */
export const LIVE_NEWS_SOURCES = {
  bloomberg: [
    'https://bloomberg.com/media-manifest/streams/us.m3u8',
    'https://www.youtube.com/watch?v=QB5BNdBFujE',
    'https://www.youtube.com/channel/UCIALMKvObZNtJ6AmdCLP7Lg',
  ],
  sky: [
    'https://linear901-oo-hls0-prd-gtm.delivery.skycdp.com/17501/sde-fast-skynews/master.m3u8',
    'https://www.youtube.com/watch?v=xDWQ3LkccY8',
  ],
  // Euronews' own YouTube live comes first. The HLS entry is a third-party test endpoint whose
  // playlist reads live but played no frames in Chrome (2026-09-14); it is kept deliberately as the
  // second option.
  euronews: [
    'https://www.youtube.com/watch?v=pykpO5kQJ98',
    'https://dash4.antik.sk/live/test_euronews/playlist.m3u8',
  ],
  dw: [
    'https://dwamdstream103.akamaized.net/hls/live/2015526/dwstream103/master.m3u8',
    'https://www.youtube.com/watch?v=LuKwFajn37U',
    'https://www.youtube.com/channel/UCknLrEdhRCp1aegoMqRaCZg',
  ],
  cnn: ['https://www.youtube.com/watch?v=GotlA1KKWoo'],
  france24: [
    'https://amg00106-france24-france24-samsunguk-qvpp8.amagi.tv/playlist/amg00106-france24-france24-samsunguk/playlist.m3u8',
    'https://www.youtube.com/watch?v=HvZt-nh9sGg',
  ],
  alarabiya: [
    'https://live.alarabiya.net/alarabiapublish/alarabiya.smil/playlist.m3u8',
    'https://www.youtube.com/watch?v=n7eQejkXbnM',
  ],
  aljazeera: [
    'https://live-hls-apps-aje-fa.getaj.net/AJE/index.m3u8',
    'https://www.youtube.com/watch?v=gCNeDWCI0vo',
    'https://www.youtube.com/channel/UCNye-wNBqNL5ZzHSJj3l8Bg',
  ],
  yahoo: ['https://www.youtube.com/watch?v=KQp-e_XQnDE'],
  nasa: ['https://www.youtube.com/watch?v=fO9e9jnhYK8'],
  'fox-news': ['https://247preview.foxnews.com/hls/live/2020027/fncv3preview/primary.m3u8'],
  newsmax: [],
  // abc-news, nbc-news, ctv-news and reuters-tv: their HLS hosts no longer resolve (2026-09-14).
  'abc-news': [],
  'cbs-news': ['https://cbsn-us.cbsnstream.cbsnews.com/out/v1/55a8648e8f134e82a470f83d562deeca/master.m3u8'],
  'nbc-news': [],
  // cbcnewshd-f.akamaihd.net returned HTTP 404 (2026-09-14).
  'cbc-news': [],
  'ctv-news': [],
  'reuters-tv': [],
  // UK-only: 403 outside the UK.
  'bbc-news': ['https://vs-hls-push-uk.live.fastly.md.bbci.co.uk/x=4/i=urn:bbc:pips:service:bbc_news_channel_hd/iptv_hd_abr_v1.m3u8'],
  'gb-news': ['https://live-gbnews.simplestreamcdn.com/live5/gbnews/bitrate1.isml/manifest.m3u8'],
  // Its HLS host no longer resolves (2026-09-14).
  'the-guardian': [],
  // The same English stream as france24, for people who add it by this name.
  'france24-en': ['https://www.youtube.com/watch?v=HvZt-nh9sGg'],
  rtve: [],
  phoenix: ['https://zdf-hls-19.akamaized.net/hls/live/2016502/de/veryhigh/master.m3u8'],
  rtp3: ['https://streaming-live.rtp.pt/livetvhlsDVR/rtpnHDdvr.smil/playlist.m3u8?DVR='],
  'trt-haber': [],
  'ntv-turkey': ['https://www.youtube.com/watch?v=pqq5c6k70kk'],
  'cnn-turk': [],
  'tv-rain': [],
  rt: ['https://rt-glb.rttv.com/dvr/rtnews/playlist.m3u8'],
  'tvp-info': ['https://www.youtube.com/watch?v=3jKb-uThfrg'],
  'telewizja-republika': ['https://www.youtube.com/watch?v=dzntyCTgJMQ'],
  'cnn-brasil': [],
  'jovem-pan': [],
  'record-news': ['https://stream.ads.ottera.tv/playlist.m3u8?network_id=2116'],
  'band-jornalismo': [],
  'tn-argentina': ['https://www.youtube.com/watch?v=cb12KmMMDJA'],
  c5n: [],
  milenio: [],
  'noticias-caracol': [],
  ntn24: [],
  t13: [],
  'dw-espanol': ['https://dwamdstream104.akamaized.net/hls/live/2015530/dwstream104/stream04/streamPlaylist.m3u8'],
  'rt-espanol': ['https://rt-esp.rttv.com/dvr/rtesp/playlist.m3u8'],
  'cgtn-espanol': ['https://news.cgtn.com/resource/live/espanol/cgtn-e.m3u8'],
  'tbs-news': [],
  'ann-news': [],
  'ntv-news': [],
  'cti-news': [],
  wion: [],
  ndtv: ['https://ndtvindiaelemarchana.akamaized.net/hls/live/2003679/ndtvindia/master.m3u8'],
  cgtn: ['https://news.cgtn.com/resource/live/english/cgtn-news.m3u8'],
  'cna-asia': ['https://www.youtube.com/watch?v=XWq5kBlakcQ'],
  // nhk-world and abp-news: their HLS hosts no longer resolve (2026-09-14).
  'nhk-world': [],
  'arirang-news': ['https://amdlive-ch01-ctnd-com.akamaized.net/arirang_1ch/smil:arirang_1ch.smil/playlist.m3u8'],
  'india-today': [
    'https://indiatodaylive.akamaized.net/hls/live/2014320/indiatoday/indiatodaylive/playlist.m3u8',
    'https://www.youtube.com/watch?v=sYZtOFzM78M',
  ],
  'abp-news': [],
  'al-hadath': ['https://av.alarabiya.net/alarabiapublish/alhadath.smil/playlist.m3u8'],
  'sky-news-arabia': ['https://live-stream.skynewsarabia.com/c-horizontal-channel/horizontal-stream/index.m3u8'],
  'trt-world': ['https://tv-trtworld.medya.trt.com.tr/master.m3u8'],
  'iran-intl': [],
  'cgtn-arabic': ['https://news.cgtn.com/resource/live/arabic/cgtn-a.m3u8'],
  'kan-11': ['https://kan11.media.kan.org.il/hls/live/2024514/2024514/master.m3u8'],
  'i24-news': ['https://bcovlive-a.akamaihd.net/6e3dd61ac4c34d6f8fb9698b565b9f50/eu-central-1/5377161796001/playlist-all_dvr.m3u8'],
  'asharq-news': ['https://www.youtube.com/watch?v=f6VpkfV7m4Y'],
  'aljazeera-arabic': [
    'https://live-hls-web-aja.getaj.net/AJA/index.m3u8',
    'https://www.youtube.com/watch?v=bNyUyrR0PHo',
  ],
  'aljazeera-mubasher': ['https://live-hls-web-ajm.getaj.net/AJM/index.m3u8'],
  'alarabiya-business': ['https://live.alarabiya.net/alarabiapublish/aswaaq.smil/playlist.m3u8'],
  'al-qahera-news': ['https://bcovlive-a.akamaihd.net/d30cbb3350af4cb7a6e05b9eb1bfd850/eu-west-1/6057955906001/playlist.m3u8'],
  'press-tv': ['https://cdnlive.presstv.ir/cdnlive/smil:cdnlive.smil/playlist.m3u8'],
  'dw-arabic': ['https://dwamdstream103.akamaized.net/hls/live/2015526/dwstream103/index.m3u8'],
  'rt-arabic': ['https://rt-arb.rttv.com/dvr/rtarab/playlist.m3u8'],
  rudaw: ['https://svs.itworkscdn.net/rudawlive/rudawlive.smil/playlist.m3u8'],
  africanews: [],
  'channels-tv': [],
  'ktn-news': [],
  enca: [],
  'sabc-news': [
    'https://sabconetanw.cdn.mangomolo.com/news/smil:news.stream.smil/chunklist_b250000_t64MjQwcA==.m3u8',
    'https://sabconetanw.cdn.mangomolo.com/news/smil:news.stream.smil/playlist.m3u8',
  ],
  'arise-news': ['https://liveedge-arisenews.visioncdn.com/live-hls/arisenews/arisenews/arisenews_web/master.m3u8'],
  welt: [],
  tagesschau24: ['https://tagesschau.akamaized.net/hls/live/2020115/tagesschau/tagesschau_1/master.m3u8'],
  'euronews-fr': ['https://www.youtube.com/watch?v=NiRIbKwAejk'],
  'euronews-gr': [],
  'skai-tv': [],
  'ert-news': ['https://ertflix.ascdn.broadpeak.io/ertlive/ertnews/default/index.m3u8'],
  'france24-fr': ['https://www.youtube.com/watch?v=a47ckXKZjxI'],
  'france-info': [],
  bfmtv: [],
  'tv5monde-info': ['https://ott.tv5monde.com/Content/HLS/Live/channel(info)/index.m3u8'],
  nrk1: ['https://nrk-nrk1.akamaized.net/21/0/hls/nrk_1/playlist.m3u8'],
  'aljazeera-balkans': ['https://live-hls-web-ajb.getaj.net/AJB/index.m3u8'],
  'abc-news-au': [
    'https://abc-iview-mediapackagestreams-2.akamaized.net/out/v1/6e1cc6d25ec0480ea099a5399d73bc4b/index.m3u8',
    'https://www.youtube.com/watch?v=vOTiJkg1voo',
  ],
} as const satisfies Record<string, readonly string[]>;

export type LiveNewsSlotId = keyof typeof LIVE_NEWS_SOURCES;

/** Two channel embeds that are reliably live. If both fail, the audit reports broken probing, not rot. */
export const AUDIT_CANARIES = [
  'https://www.youtube.com/channel/UCNye-wNBqNL5ZzHSJj3l8Bg',
  'https://www.youtube.com/channel/UCknLrEdhRCp1aegoMqRaCZg',
] as const;
