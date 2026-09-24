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
//
// A daily audit (.github/workflows/live-video-source-audit.yml) keeps one GitHub issue, "Live video
// sources: slots needing a replacement": each slot with nothing live, and each empty slot viewers
// would see, with where it shows and why. Empty slots the dashboard hides are listed separately and
// never keep the issue open. To fix a slot, check a candidate with the first command above, paste the
// line it prints after `paste:` into that slot's list below, and the next run drops the slot from the
// issue. The issue closes itself once no slot needs attention.
//
// A channel entry also opts the slot into live video refresh. The audit reads the channel's /live page and
// checks the video the channel has live right now instead of the channel embed; when that video is missing
// from the slot and a pinned video sits ahead of the channel, the issue shows it under "Live now", ready to
// paste over the dead pinned entry. The dashboard refresh (#8545, in progress) tries a resolved video
// immediately before the channel entry that produced it, so entries ahead of the channel keep priority; until
// it ships, the dashboard plays the channel embed. For a broadcaster that restarts its stream under
// a new id, list only the channel, with no pinned id. Do not list a channel whose featured live is another
// stream (a side camera, a press conference, a replay): the resolved video would be that stream.
// The seed-live-video-resolved cron reads its channel list from
// scripts/shared/live-video-refresh-channels.generated.json: after adding, moving or removing a channel entry,
// run `npm run sync:live-video-channels` (CI fails until the generated list matches this file).

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
  // No official city or port cam exists, so these are established webcam operators: ZeroEight on South
  // Beach, World Live Cams on Sunny Isles, Ryan Rea on PortMiami. nPGlLfGX6SA failed with player error 150
  // (2026-09-23, #8545).
  miami: [
    'https://www.youtube.com/watch?v=WT69M210Z18',
    'https://www.youtube.com/watch?v=bi7B4EmyHHs',
    'https://www.youtube.com/watch?v=4fzzp0XVPoA',
  ],
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
  // The first HLS comes from newsmaxtv.com's player and may be the Newsmax2 feed; the YouTube video is
  // Newsmax2 on @NewsmaxTV (2026-09-24, #8545).
  newsmax: [
    'https://n1ctsota.akamaized.net/hls/live/2113880/Live_1/index.m3u8',
    'https://nmxlive.akamaized.net/hls/live/529965/Live_1/index.m3u8',
    'https://www.youtube.com/watch?v=RNNFrG4KbH0',
  ],
  // abc-news, nbc-news, ctv-news and reuters-tv: their HLS hosts no longer resolve (2026-09-14).
  // ABC News Live and NBC News NOW play through their channel embeds (2026-09-24, #8545).
  'abc-news': ['https://www.youtube.com/channel/UCBi2mrWuNuyYy4gbM6fU18Q'],
  'cbs-news': ['https://cbsn-us.cbsnstream.cbsnews.com/out/v1/55a8648e8f134e82a470f83d562deeca/master.m3u8'],
  'nbc-news': ['https://www.youtube.com/channel/UCeY0bbntWzzVIaj2z3QigXg'],
  // cbcnewshd-f.akamaihd.net returned HTTP 404 (2026-09-14). CBC restarts its stream under new ids, so only
  // the channel is listed: the audit resolves its live video, since the channel embed fails with player error 150.
  'cbc-news': ['https://www.youtube.com/channel/UCuFFtHWoLl5fauMMD5Ww2jA'],
  // CTV News streams only in authenticated Canadian apps (2026-09-23, #8545).
  'ctv-news': [],
  // No 24/7 live Reuters publishes itself; the old wurl FAST hosts no longer resolve (2026-09-23, #8545).
  'reuters-tv': [],
  // UK-only: 403 outside the UK.
  'bbc-news': ['https://vs-hls-push-uk.live.fastly.md.bbci.co.uk/x=4/i=urn:bbc:pips:service:bbc_news_channel_hd/iptv_hd_abr_v1.m3u8'],
  'gb-news': ['https://live-gbnews.simplestreamcdn.com/live5/gbnews/bitrate1.isml/manifest.m3u8'],
  // Its HLS host no longer resolves (2026-09-14), and The Guardian has no 24/7 live channel
  // (2026-09-23, #8545).
  'the-guardian': [],
  // The same English stream as france24, for people who add it by this name.
  'france24-en': ['https://www.youtube.com/watch?v=HvZt-nh9sGg'],
  rtve: ['https://rtvelivestream.rtve.es/rtvesec/24h/24h_main_dvr.m3u8'],
  phoenix: ['https://zdf-hls-19.akamaized.net/hls/live/2016502/de/veryhigh/master.m3u8'],
  rtp3: ['https://streaming-live.rtp.pt/livetvhlsDVR/rtpnHDdvr.smil/playlist.m3u8?DVR='],
  'trt-haber': [
    'https://tv-trthaber.medya.trt.com.tr/master.m3u8',
    'https://www.youtube.com/channel/UCBgTP2LOFVPmq15W-RH-WXA',
  ],
  'ntv-turkey': ['https://www.youtube.com/watch?v=pqq5c6k70kk'],
  // The official HLS is referer- or token-gated (403). CNN TÜRK restarts and retitles its "CANLI HABER" live,
  // so only the channel is listed (its embed fails with player error 150; the audit resolves the live video).
  'cnn-turk': ['https://www.youtube.com/channel/UCV6zcRug6Hqp1UX_FdyUeBg'],
  // Only scheduled shows, no 24/7 live (2026-09-23, #8545).
  'tv-rain': [],
  rt: ['https://rt-glb.rttv.com/dvr/rtnews/playlist.m3u8'],
  'tvp-info': ['https://www.youtube.com/watch?v=3jKb-uThfrg'],
  'telewizja-republika': ['https://www.youtube.com/watch?v=dzntyCTgJMQ'],
  // CNN Brasil runs each show as its own dated live video, so only the channel is listed; its embed fails with
  // player error 150, and the audit resolves the running show (2026-09-24, #8545).
  'cnn-brasil': ['https://www.youtube.com/channel/UCvdwhh_fDyWccR42-rReZLw'],
  // The channel's running live (eTz4XgOQaAE) is a street camera on Avenida Paulista, not the news channel;
  // its news shows are scheduled dated videos (2026-09-24, #8545).
  'jovem-pan': [],
  // The ottera.tv entry returned HTTP 400 (2026-09-23, #8545).
  'record-news': ['https://www.youtube.com/channel/UCuiLR4p6wQ3xLEm15pEn1Xw'],
  // No reachable live found (2026-09-23, #8545).
  'band-jornalismo': [],
  'tn-argentina': ['https://www.youtube.com/watch?v=cb12KmMMDJA'],
  c5n: ['https://www.youtube.com/channel/UCFgk2Q2mVO1BklRQhSv6p0w'],
  // The channel embed fails with player error 150, so this is the running live video; its id changes when
  // Milenio restarts the stream. The channel is not listed: its featured live was "Más Milenio", not this
  // news stream (2026-09-24, #8545).
  milenio: ['https://www.youtube.com/watch?v=oPy8a-TCjzA'],
  // noticias-caracol and t13 restart their streams under new ids, so only the channel is listed; their embeds
  // fail with player error 150, and the audit resolves the live video (2026-09-24, #8545).
  'noticias-caracol': ['https://www.youtube.com/channel/UC2Xq2PK-got3Rtz9ZJ32hLQ'],
  ntn24: ['https://www.youtube.com/channel/UCEJs1fTF3KszRJGxJY14VrA'],
  t13: ['https://www.youtube.com/channel/UCsRnhjcUCR78Q3Ud6OXCTNg'],
  'dw-espanol': ['https://dwamdstream104.akamaized.net/hls/live/2015530/dwstream104/stream04/streamPlaylist.m3u8'],
  'rt-espanol': ['https://rt-esp.rttv.com/dvr/rtesp/playlist.m3u8'],
  // news.cgtn.com no longer resolves (2026-09-23, #8545).
  'cgtn-espanol': ['https://www.youtube.com/channel/UCd94YCD7yp6d-YZSRYWyeFA'],
  // tbs-news, ann-news and ntv-news: each broadcaster's 24h live video. ANN's and NTV's channel embeds
  // resolve to other lives (a press-conference replay, an airport cam) (2026-09-24, #8545).
  'tbs-news': ['https://www.youtube.com/watch?v=Anr15FA9OCI'],
  'ann-news': ['https://www.youtube.com/watch?v=coYw-eVU0Ks'],
  'ntv-news': ['https://www.youtube.com/watch?v=t9kwjZBLI-A'],
  // Fragile: the channel embed fails with player error 150, and CTi runs each news block as its own dated
  // live video, so this one ends within hours (2026-09-24, #8545). The channel is not listed: its /live page
  // featured the next scheduled block (upcoming) while this one played.
  'cti-news': ['https://www.youtube.com/watch?v=-YExqG4Llcw'],
  // The channel embed fails with player error 150; its id changes when WION restarts the stream. The channel
  // is not listed: its featured live was an event stream, not the 24/7 news (2026-09-24, #8545).
  wion: ['https://www.youtube.com/watch?v=X-7LAkvfA5s'],
  ndtv: ['https://ndtvindiaelemarchana.akamaized.net/hls/live/2003679/ndtvindia/master.m3u8'],
  // news.cgtn.com no longer resolves; the HLS is now on english-livebkali.cgtn.com. The channel embed fails
  // with player error 150, so the second entry is CGTN's 24/7 video (2026-09-24, #8545).
  cgtn: [
    'https://english-livebkali.cgtn.com/live/encgtn.m3u8',
    'https://www.youtube.com/watch?v=0i7n3r01L2U',
  ],
  'cna-asia': ['https://www.youtube.com/watch?v=XWq5kBlakcQ'],
  // nhk-world and abp-news: their HLS hosts no longer resolve (2026-09-14). NHK's HLS is now on
  // nhkworld.jp (2026-09-24, #8545).
  'nhk-world': [
    'https://masterpl.hls.nhkworld.jp/hls/w/live/master.m3u8',
    'https://www.youtube.com/channel/UCSPEjw8F2nQDtmUKPFNF7_A',
  ],
  'arirang-news': ['https://amdlive-ch01-ctnd-com.akamaized.net/arirang_1ch/smil:arirang_1ch.smil/playlist.m3u8'],
  'india-today': [
    'https://indiatodaylive.akamaized.net/hls/live/2014320/indiatoday/indiatodaylive/playlist.m3u8',
    'https://www.youtube.com/watch?v=sYZtOFzM78M',
  ],
  // ABP retitles and restarts its running live, so only the channel is listed; its embed fails with player
  // error 150, and the audit resolves the live video (2026-09-24, #8545).
  'abp-news': ['https://www.youtube.com/channel/UCRWFSbif-RFENbBrSiez1DA'],
  'al-hadath': ['https://av.alarabiya.net/alarabiapublish/alhadath.smil/playlist.m3u8'],
  'sky-news-arabia': ['https://live-stream.skynewsarabia.com/c-horizontal-channel/horizontal-stream/index.m3u8'],
  'trt-world': ['https://tv-trtworld.medya.trt.com.tr/master.m3u8'],
  // The HLS comes from iranintl.com's player (2026-09-24, #8545).
  'iran-intl': [
    'https://live.livetvstream.co.uk/LS-63503-4/index.m3u8',
    'https://www.youtube.com/watch?v=5JDxjsAVaGk',
  ],
  // news.cgtn.com no longer resolves (2026-09-23, #8545).
  'cgtn-arabic': ['https://www.youtube.com/channel/UCQmJk0ErE_FiorcLBsDKORA'],
  // Kan's own kancdn space on MedOne, an Israeli CDN; kan11.media.kan.org.il refused connections
  // (2026-09-23, #8545).
  'kan-11': ['https://kancdn.medonecdn.net/livehls/oil/kancdn-live/live/kan11/live.livx/playlist.m3u8'],
  // The Brightcove entry returned 503; i24news.tv's own player uses this immergo host (2026-09-24, #8545).
  'i24-news': ['https://i24newshebrew-cdn.encoders.immergo.tv/master.m3u8'],
  'asharq-news': ['https://www.youtube.com/watch?v=f6VpkfV7m4Y'],
  'aljazeera-arabic': [
    'https://live-hls-web-aja.getaj.net/AJA/index.m3u8',
    'https://www.youtube.com/watch?v=bNyUyrR0PHo',
  ],
  'aljazeera-mubasher': ['https://live-hls-web-ajm.getaj.net/AJM/index.m3u8'],
  'alarabiya-business': ['https://live.alarabiya.net/alarabiapublish/aswaaq.smil/playlist.m3u8'],
  // The Brightcove entry returned 503; alqaheranews.net links to and embeds this channel (2026-09-24, #8545).
  'al-qahera-news': ['https://www.youtube.com/channel/UCktyejXTxWaKfrgp1Oq7CMQ'],
  // cdnlive.presstv.ir served 502 behind a broken certificate chain; presstv.ir's own player loads this
  // manifest (2026-09-24, #8545).
  'press-tv': ['https://live.presstv.co.uk/hls/presstv.m3u8'],
  'dw-arabic': ['https://dwamdstream103.akamaized.net/hls/live/2015526/dwstream103/index.m3u8'],
  'rt-arabic': ['https://rt-arb.rttv.com/dvr/rtarab/playlist.m3u8'],
  // The itworkscdn entry stopped serving an HLS playlist; the HLS is now on rudaw.net (2026-09-24, #8545).
  rudaw: [
    'https://live.rudaw.net/hls/rudaw-tv/master.m3u8',
    'https://www.youtube.com/channel/UCAUHoE2Ykw0sguyi5AjhrjQ',
  ],
  africanews: ['https://www.youtube.com/channel/UC1_E8NeF5QHY2dtdLRBCCLA'],
  // Channels restarts its stream under new ids, so only the channel is listed; its embed fails with player
  // error 150, and the audit resolves the live video (2026-09-24, #8545).
  'channels-tv': ['https://www.youtube.com/channel/UCEXGDNclvmg6RW0vipJYsTQ'],
  'ktn-news': ['https://www.youtube.com/channel/UCKVsdeoHExltrWMuK0hOWmg'],
  // No reachable live found (2026-09-23, #8545).
  enca: [],
  'sabc-news': [
    'https://sabconetanw.cdn.mangomolo.com/news/smil:news.stream.smil/chunklist_b250000_t64MjQwcA==.m3u8',
    'https://sabconetanw.cdn.mangomolo.com/news/smil:news.stream.smil/playlist.m3u8',
  ],
  // The visioncdn HLS host no longer resolves (2026-09-23, #8545).
  'arise-news': ['https://www.youtube.com/channel/UCyEJX-kSj0kOOCS7Qlq2G7g'],
  // The official HLS returns 401; the channel embed plays outside DE/AT/CH (2026-09-24, #8545).
  welt: ['https://www.youtube.com/channel/UCZMsvbAhhRblVGXmEXW8TSA'],
  tagesschau24: ['https://tagesschau.akamaized.net/hls/live/2020115/tagesschau/tagesschau_1/master.m3u8'],
  'euronews-fr': ['https://www.youtube.com/watch?v=NiRIbKwAejk'],
  'euronews-gr': ['https://www.youtube.com/channel/UC8HJZNfDPoySgW9DN3YGNaA'],
  // Embedded on skai.gr/tv/live (2026-09-24, #8545).
  'skai-tv': ['https://skai-live.siliconweb.com/media/cambria4/index.m3u8'],
  // ERT's own space on Broadpeak, the old entry's vendor; the ertflix entry returned HTTP 404 (#8545).
  'ert-news': ['https://ert-ucdn.broadpeak-aas.com/bpk-tv/ERTNews/default/index.m3u8'],
  'france24-fr': ['https://www.youtube.com/watch?v=a47ckXKZjxI'],
  // franceinfo restarts its stream under new ids, so only the channel is listed; its embed fails with player
  // error 150, and the audit resolves the live video (2026-09-24, #8545).
  'france-info': ['https://www.youtube.com/channel/UCO6K_kkdP-lnSCiO3tPx7WA'],
  // The HLS is embedded on bfmtv.com. The channel embed currently plays BFM2, not the main feed
  // (2026-09-24, #8545).
  bfmtv: [
    'https://live-cdn-stream-euw1.bfmtv.bct.nextradiotv.com/master.m3u8',
    'https://www.youtube.com/channel/UCXwDLMDV86ldKoFVc_g8P0g',
  ],
  'tv5monde-info': ['https://ott.tv5monde.com/Content/HLS/Live/channel(info)/index.m3u8'],
  nrk1: ['https://nrk-nrk1.akamaized.net/21/0/hls/nrk_1/playlist.m3u8'],
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
