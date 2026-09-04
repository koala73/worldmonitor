// Publisher-origin country for the public /sources/ catalog.
//
// A source's origin country is where the publisher or issuing government
// lives — not the set of countries it reports on. Coverage geography is
// attached separately from named feed declarations. International
// organizations and global platforms are classified as null and shown as
// "International".
//
// Closed world: every catalog provider must resolve. Government suffixes and
// real ccTLDs infer automatically. Generic or vanity TLDs need an explicit
// override so a new .com source cannot ship without a country decision.

export const INTERNATIONAL_FILTER = 'intl';

// Keep this module runtime-neutral: it is consumed by both Node corpus scripts
// and the Vercel Edge MCP registry. JSON import attributes and node:fs are not
// portable across those two bundle paths.
const ISO2_CODES = new Set((
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BR BS BT BW BY BZ ' +
  'CA CD CF CG CH CI CK CL CM CN CO CR CU CV CW CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET EU FI FJ FK FM ' +
  'FO FR GA GB GD GE GG GH GI GL GM GN GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT ' +
  'JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML ' +
  'MM MN MO MP MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN ' +
  'PR PS PT PW PY QA RO RS RU RW SA SB SC SD SE SG SH SI SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH ' +
  'TJ TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE ZA ZM ZW'
).split(' '));

const REGION_NAMES = new Intl.DisplayNames(['en'], { type: 'region' });

// ccTLDs used as generic product domains. Do not infer a country from these.
const VANITY_CC_TLDS = new Set([
  'ai', 'am', 'cc', 'cf', 'cm', 'co', 'fm', 'ga', 'gd', 'gg', 'gl', 'gq',
  'io', 'is', 'ly', 'me', 'ml', 'mn', 'nu', 'rs', 'sh', 'so', 'tk', 'to', 'tv',
  'vc', 'ws', 'zw',
]);

const GENERIC_TLDS = new Set([
  'aero', 'app', 'arpa', 'asia', 'biz', 'blog', 'cloud', 'coop', 'dev',
  'edu', 'events', 'example', 'gov', 'info', 'int', 'invalid', 'jobs',
  'live', 'local', 'mil', 'mobi', 'museum', 'name', 'net', 'news', 'online',
  'onion', 'org', 'pro', 'site', 'space', 'tech', 'tel', 'test', 'watch',
  'world', 'xxx', 'xyz',
]);

const INTERNATIONAL_HOST_SUFFIXES = [
  '.fao.org',
  '.gdacs.org',
  '.humdata.org',
  '.iaea.org',
  '.icao.int',
  '.iea.org',
  '.ilo.org',
  '.imf.org',
  '.opec.org',
  '.reliefweb.int',
  '.un.org',
  '.undp.org',
  '.unep.org',
  '.unesco.org',
  '.unhcr.org',
  '.who.int',
  '.worldbank.org',
  '.wto.org',
];

// Host → ISO 3166-1 alpha-2, 'EU', or null (international).
// Only hosts that cannot be inferred from a real ccTLD or government suffix.
const HOST_ORIGINS = Object.freeze({
  // Editorial hosts used by site-scoped news searches. These are catalogued
  // as publishers in their own right; the shared search endpoint is a
  // separate provider.
  '36kr.com': 'CN',
  'a16z.com': 'US',
  'actuniger.com': 'NE',
  'angellist.com': 'US',
  'annahar.com': 'LB',
  'apnews.com': 'US',
  'arabianbusiness.com': 'AE',
  'arabnews.com': 'SA',
  'arctictoday.com': 'US',
  'armenpress.am': 'AM',
  'armscontrol.org': 'US',
  'asia.nikkei.com': 'JP',
  'ayibopost.com': 'HT',
  'bangkokpost.com': 'TH',
  'bellingcat.com': 'NL',
  'bihus.info': 'UA',
  'binance.com': null,
  'bloomberg.com': 'US',
  'carnegieendowment.org': 'US',
  'chathamhouse.org': 'GB',
  'citinewsroom.com': 'GH',
  'cnas.org': 'US',
  'cnn.com': 'US',
  'coinbase.com': 'US',
  'cp24.com': 'CA',
  'dhakatribune.com': 'BD',
  'dlnews.com': 'GB',
  'dw.com': 'DE',
  'eff.org': 'US',
  'english.alarabiya.net': 'SA',
  'english.enabbaladi.net': 'SY',
  'euractiv.com': 'BE',
  'euromaidanpress.com': 'UA',
  'fas.org': 'US',
  'fxempire.com': 'IL',
  'geo.tv': 'PK',
  'gmfus.org': 'US',
  'haaretz.com': 'IL',
  'hiiraan.com': 'CA',
  'interfax.com': 'RU',
  'investing.com': 'IL',
  'iranintl.com': 'GB',
  'janes.com': 'GB',
  'jin10.com': 'CN',
  'kitco.com': 'CA',
  'kyivindependent.com': 'UA',
  'lorientlejour.com': 'LB',
  'lowyinstitute.org': 'AU',
  'madamasr.com': 'EG',
  'marketwatch.com': 'US',
  'messari.io': 'US',
  'mining-journal.com': 'GB',
  'miningweekly.com': 'ZA',
  'montrealgazette.com': 'CA',
  'nti.org': 'US',
  'oecd.org': null,
  'oko.press': 'PL',
  'oglobo.globo.com': 'BR',
  'pajhwok.com': 'AF',
  'prnewswire.com': 'US',
  'renaissancecapital.com': 'US',
  'reuters.com': 'GB',
  'rferl.org': 'US',
  'rudaw.net': 'IQ',
  'rusi.org': 'GB',
  'slidstvo.info': 'UA',
  'spglobal.com': 'US',
  'suspilne.media': 'UA',
  'taipeitimes.com': 'TW',
  'tass.com': 'RU',
  'theblock.co': 'US',
  'thebulletin.org': 'US',
  'thedailystar.net': 'BD',
  'theguardianpostcameroon.com': 'CM',
  'theinformation.com': 'US',
  'thejakartapost.com': 'ID',
  'thenextweb.com': 'NL',
  'tvp.info': 'PL',
  'ukrinform.net': 'UA',
  'understandingwar.org': 'US',
  'wilsoncenter.org': 'US',
  'wublockchain.com': 'CN',
  'xinhuanet.com': 'CN',
  'yemenonline.info': 'YE',
  'zerkalo.io': 'BY',
  'acleddata.com': 'US',
  'adsb.lol': 'NL',
  'api.adsb.lol': 'NL',
  'aerotime.aero': 'LT',
  'agentskills.io': 'US',
  // Validated crisis-desk direct publishers (#6813-#6830).
  'airinfoagadez.com': 'NE',
  'amu.tv': 'AF',
  'efectococuyo.com': 'VE',
  'havanatimes.org': 'CU',
  'lefaso.net': 'BF',
  'libyaherald.com': 'LY',
  'nation.africa': 'KE',
  'sanaacenter.org': 'YE',
  'syriadirect.org': 'SY',
  'tchadinfos.com': 'TD',
  'www.14ymedio.com': 'CU',
  'www.972mag.com': 'IL',
  'www.alwihdainfo.com': 'TD',
  'www.caracaschronicles.com': 'VE',
  'www.egyptindependent.com': 'EG',
  'www.haitilibre.com': 'HT',
  'www.naharnet.com': 'LB',
  'www.radiondekeluka.org': 'CF',
  'www.studiotamani.org': 'ML',
  'airlinegeeks.com': 'US',
  'airplanes.live': null,
  'api.airplanes.live': null,
  'api.cloudflare.com': 'US',
  'radar.cloudflare.com': 'US',
  'api.abuseipdb.com': 'US',
  'api.alternative.me': null,
  'api.aviationstack.com': 'GB',
  'api.coingecko.com': 'MY',
  'api.coinpaprika.com': 'PL',
  'api.elections.kalshi.com': 'US',
  'api.exa.ai': 'US',
  'api.firecrawl.dev': 'US',
  'api.gdeltproject.org': 'US',
  'api.github.com': null,
  'api.hyperliquid.xyz': 'US',
  'api.openaq.org': 'US',
  'api.opensanctions.org': 'DE',
  'api.ossinsight.io': 'CN',
  'api.planespotters.net': 'DE',
  'api.rainviewer.com': 'US',
  'api.safecast.org': 'JP',
  'api.scrapecreators.com': 'US',
  'api.search.brave.com': 'US',
  'api.spdrgoldshares.com': 'US',
  'api.stlouisfed.org': 'US',
  'api.telegram.org': 'AE',
  'api.travelpayouts.com': 'CY',
  'api.tzevaadom.co.il': 'IL',
  'api.waqi.info': 'CN',
  'api.windy.com': 'CZ',
  'api.x.com': 'US',
  'archive-api.open-meteo.com': 'DE',
  'asharq.com': 'SA',
  'asharqbusiness.com': 'SA',
  'astanatimes.com': 'KZ',
  'atbackend.sipri.org': 'SE',
  'auth.opensky-network.org': 'CH',
  'azure.status.microsoft': 'US',
  'balkaninsight.com': 'BA',
  'bitcoinmagazine.com': 'US',
  'bitbucket.status.atlassian.com': 'AU',
  'bothsidesofthetable.com': 'US',
  'breakingdefense.com': 'US',
  'budgetlab.yale.edu': 'US',
  'calgaryherald.com': 'CA',
  'celestrak.org': 'US',
  'chainwire.org': 'US',
  'changelog.com': 'US',
  'climate.copernicus.eu': 'EU',
  'cointelegraph.com': 'US',
  'collisionconf.com': 'CA',
  'confluence.status.atlassian.com': 'AU',
  'conservationoptimism.org': 'GB',
  'contxto.com': 'MX',
  'correctiv.org': 'DE',
  'corridorrisk.io': null,
  'cryptoslate.com': 'US',
  'customer-api.wingbits.com': 'NO',
  'dailytrust.com': 'NG',
  'decrypt.co': 'US',
  'dev.events': 'US',
  'dev.to': 'US',
  'devops.com': 'US',
  'dfrlab.org': 'US',
  'discordstatus.com': 'US',
  'disrupt-africa.com': 'ZA',
  'e00-elmundo.uecdn.es': 'ES',
  'earth-search.aws.element84.com': 'US',
  'ecs-api.wingbits.com': 'NO',
  'edmontonjournal.com': 'CA',
  'en.mehrnews.com': 'IR',
  'en.wikipedia.org': null,
  'eurasianet.org': null,
  'export.arxiv.org': 'US',
  'feed.businesswire.com': 'US',
  'feed.infoq.com': 'US',
  'feeds.abcnews.com': 'US',
  'feeds.arstechnica.com': 'US',
  'feeds.content.dowjones.io': 'US',
  'feeds.elpais.com': 'ES',
  'feeds.feedburner.com': 'US',
  'feeds.finra.org': 'US',
  'feeds.folha.uol.com.br': 'BR',
  'feeds.megaphone.fm': 'US',
  'feeds.nbcnews.com': 'US',
  'feeds.news24.com': 'ZA',
  'feeds.npr.org': 'US',
  'financialpost.com': 'CA',
  'finnhub.io': 'US',
  'foreignpolicy.com': 'US',
  'fr.africanews.com': null,
  'freeipapi.com': null,
  'gain.nd.edu': 'US',
  'gcaptain.com': 'US',
  'gtaupdate.com': 'CA',
  'geospatial-usace.opendata.arcgis.com': 'US',
  'ghoapi.azureedge.net': null,
  'github.blog': null,
  'globalenergymonitor.org': 'US',
  'globalinitiative.net': 'CH',
  'goldsilverworlds.com': 'BE',
  'gpsjam.org': 'US',
  'greatergood.berkeley.edu': 'US',
  'hacker-news.firebaseio.com': 'US',
  'health.aws.amazon.com': 'US',
  'hnrss.org': 'US',
  'humanprogress.org': 'US',
  'inc42.com': 'IN',
  'indianexpress.com': 'IN',
  'insightcrime.org': 'US',
  'ipinfo.io': 'US',
  'islandtimes.org': 'PW',
  'jam-news.net': 'GE',
  'jamestown.org': 'US',
  'japantoday.com': 'JP',
  'jira-software.status.atlassian.com': 'AU',
  'kalshi.com': 'US',
  'kr-asia.com': 'SG',
  'krebsonsecurity.com': 'US',
  'lavca.org': 'US',
  'linearstatus.com': 'US',
  // The Lobsters domain is a .rs domain hack; the publisher is operated from
  // Chicago, not Serbia.
  'lobste.rs': 'US',
  'meduza.io': 'RU',
  'mempool.space': null,
  'mexiconewsdaily.com': 'MX',
  'moxie.foxbusiness.com': 'US',
  'moxie.foxnews.com': 'US',
  'mshibanami.github.io': 'US',
  'nationalpost.com': 'CA',
  'news.crunchbase.com': 'US',
  'news.google.com': 'US',
  'news.mit.edu': 'US',
  'news.mongabay.com': 'US',
  'news.ycombinator.com': 'US',
  'nominatim.openstreetmap.org': null,
  'oauth.reddit.com': 'US',
  'oc-media.org': 'GE',
  'oilprice.com': 'CA',
  'onemileatatime.com': 'US',
  'opensky-network.org': 'CH',
  'ottawacitizen.com': 'CA',
  'otx.alienvault.com': 'US',
  'outbreaknewstoday.com': 'US',
  'ourworldindata.org': 'GB',
  'owid-public.owid.io': 'GB',
  'patents.google.com': 'US',
  'phys.org': 'GB',
  'pitchbook.com': 'US',
  'polymarket.com': 'US',
  'pro-api.coingecko.com': 'MY',
  'production.dataviz.cnn.io': 'US',
  'public.govdelivery.com': 'US',
  'publicacionexterna.azurewebsites.net': 'MX',
  'qevdnlpgjxpwusesmtpx.supabase.co': 'US',
  'query.wikidata.org': null,
  'query1.finance.yahoo.com': 'US',
  'railway.instatus.com': 'US',
  'raw.githubusercontent.com': null,
  'reasonstobecheerful.world': 'US',
  'responsiblestatecraft.org': 'US',
  'restcountries.com': null,
  'review.firstround.com': 'US',
  'rss.art19.com': 'US',
  'rss.dw.com': 'DE',
  'rss.libsyn.com': 'US',
  'rss.politico.com': 'US',
  'rsf.org': 'FR',
  'schema.org': 'US',
  'seekingalpha.com': 'US',
  'serpapi.com': 'US',
  'services.arcgis.com': 'CA',
  'services7.arcgis.com': 'US',
  'services9.arcgis.com': 'US',
  'simpleflying.com': 'GB',
  'singularityhub.com': 'US',
  'slack-status.com': 'US',
  'stats.bis.org': 'CH',
  'status.circleci.com': 'US',
  'status.claude.com': 'US',
  'status.cloud.google.com': 'US',
  'status.datadoghq.com': 'US',
  'status.digitalocean.com': 'US',
  'status.gitlab.com': 'US',
  'status.npmjs.org': 'US',
  'status.openai.com': 'US',
  'status.render.com': 'US',
  'status.sentry.io': 'US',
  'status.stripe.com': 'US',
  'status.supabase.com': 'US',
  'status.twilio.com': 'US',
  'storage.googleapis.com': 'GB',
  'stratechery.com': 'US',
  'taskandpurpose.com': 'US',
  'tech.eu': 'EU',
  'techcabal.com': 'NG',
  'techcrunch.com': 'US',
  'thebetterindia.com': 'IN',
  'thedefiant.io': 'US',
  'thediplomat.com': 'US',
  'thehill.com': 'US',
  'thenewstack.io': 'US',
  'thepointsguy.com': 'US',
  'theprovince.com': 'CA',
  'thesentry.org': 'US',
  'thinkglobalhealth.github.io': 'US',
  'timesca.com': null,
  'timesofindia.indiatimes.com': 'IN',
  'trumpstruth.org': 'US',
  'unchainedcrypto.com': 'US',
  'vancouversun.com': 'CA',
  'venturebeat.com': 'US',
  'viewfromthewing.com': 'US',
  'vnexpress.net': 'VN',
  'vsquare.org': 'PL',
  'wabi-europe-north-b-api.analysis.windows.net': 'US',
  'warontherocks.com': 'US',
  'web.archive.org': 'US',
  'websummit.com': 'IE',
  'www.a16z.news': 'US',
  'www.aaii.com': 'US',
  'www.aaronsw.com': 'US',
  'www.abc.net.au': 'AU',
  'www.africanews.com': null,
  'www.aajtak.in': 'IN',
  'www.alarabiya.net': 'SA',
  'www.aljazeera.com': 'QA',
  'www.aljazeera.net': 'QA',
  'www.alphavantage.co': 'US',
  'www.amarujala.com': 'IN',
  'www.asahi.com': 'JP',
  'www.atlanticcouncil.org': 'US',
  'www.aviationpros.com': 'US',
  'www.aviationweek.com': 'US',
  'www.axios.com': 'US',
  'api.axios.com': 'US',
  'www.barchart.com': 'US',
  'www.bbc.com': 'GB',
  'www.businessinsider.com': 'US',
  'www.carbonbrief.org': 'GB',
  'www.cbinsights.com': 'US',
  'www.cbsnews.com': 'US',
  'www.channelnewsasia.com': 'SG',
  'www.channelstv.com': 'NG',
  'www.chosun.com': 'KR',
  'www.clarin.com': 'AR',
  'www.climatecentral.org': 'US',
  'www.cloudflarestatus.com': 'US',
  'www.cnbc.com': 'US',
  'www.coindesk.com': 'US',
  'www.crisisgroup.org': 'BE',
  'www.csis.org': 'US',
  'www.dabangasudan.org': 'SD',
  'www.dailygood.org': 'US',
  'www.dailysabah.com': 'TR',
  'www.darkreading.com': 'US',
  'www.dawn.com': 'PK',
  'www.defensenews.com': 'US',
  'www.defenseone.com': 'US',
  'www.dockerstatus.com': 'US',
  'www.eltiempo.com': 'CO',
  'www.eluniverso.com': 'EC',
  'www.engadget.com': 'US',
  'www.ethiopia-insight.com': 'ET',
  'www.eu-startups.com': 'EU',
  'www.euronews.com': null,
  'de.euronews.com': null,
  'es.euronews.com': null,
  'fr.euronews.com': null,
  'gr.euronews.com': null,
  'it.euronews.com': null,
  'pt.euronews.com': null,
  'ru.euronews.com': null,
  'www.fatf-gafi.org': null,
  'www.flightglobal.com': 'GB',
  'www.foreignaffairs.com': 'US',
  'www.fpri.org': 'US',
  'www.france24.com': 'FR',
  'www.ft.com': 'GB',
  'www.fwdstart.me': 'US',
  'www.githubstatus.com': null,
  'www.gitex.com': 'AE',
  'www.globenewswire.com': 'US',
  'www.goldseek.com': 'US',
  'www.good.is': 'US',
  'www.goodgoodgood.co': 'US',
  'www.goodnewsnetwork.org': 'US',
  'www.google.com': 'US',
  'www.handelsblatt.com': 'DE',
  'www.handybulk.com': 'GB',
  'www.iaea.org': null,
  'www.iea.org': null,
  'www.ifswf.org': null,
  'www.infobae.com': 'AR',
  'www.irrawaddy.com': 'MM',
  'www.jeuneafrique.com': 'FR',
  'www.jodidata.org': null,
  'www.jpost.com': 'IL',
  'www.lasillavacia.com': 'CO',
  'www.ledevoir.com': 'CA',
  'www.lennysnewsletter.com': 'US',
  'www.lighthousereports.com': 'NL',
  'www.livescience.com': 'US',
  'www.militarytimes.com': 'US',
  'www.mining.com': 'CA',
  'www.mining-technology.com': 'GB',
  'www.myjoyonline.com': 'GH',
  'www.nature.com': 'GB',
  'www.netlifystatus.com': 'US',
  'www.newscientist.com': 'GB',
  'www.newyorkfed.org': 'US',
  'www.nfx.com': 'US',
  'www.northernminer.com': 'CA',
  'www.notion-status.com': 'US',
  'www.occrp.org': null,
  'www.opec.org': null,
  'www.optimistdaily.com': 'US',
  'www.oryxspioenkop.com': 'NL',
  'www.pbs.org': 'US',
  'www.pizzint.watch': 'US',
  'www.positive.news': 'GB',
  'www.premiumtimesng.com': 'NG',
  'www.producthunt.com': 'US',
  'www.radiookapi.net': 'CD',
  'www.radiotamazuj.org': 'SS',
  'www.rand.org': 'US',
  'www.ransomware.live': 'FR',
  'www.rappler.com': 'PH',
  'www.reddit.com': 'US',
  'www.replicatestatus.com': 'US',
  'www.rigzone.com': 'US',
  'www.rt.com': 'RU',
  'www.saastr.com': 'US',
  'www.schneier.com': 'US',
  'www.sciencedaily.com': 'US',
  'www.scmp.com': 'HK',
  'www.semianalysis.com': 'US',
  'www.sequoiacap.com': 'US',
  'www.shareable.net': 'US',
  'www.silverseek.com': 'US',
  'www.spdrgoldshares.com': 'US',
  'www.stimson.org': 'US',
  'www.submarinecablemap.com': 'US',
  'www.sunnyskyz.com': 'US',
  'www.swfinstitute.org': 'US',
  'www.techinasia.com': 'SG',
  'www.techmeme.com': 'US',
  'www.techstars.com': 'US',
  'www.technologyreview.com': 'US',
  'www.theglobeandmail.com': 'CA',
  'www.theguardian.com': 'GB',
  'www.thehindu.com': 'IN',
  'www.themoscowtimes.com': 'RU',
  'www.thenationalnews.com': 'AE',
  'www.thereporterethiopia.com': 'ET',
  'www.thestar.com': 'CA',
  'www.theverge.com': 'US',
  'www.thisdaylive.com': 'NG',
  'www.token2049.com': 'SG',
  'www.tomshardware.com': 'US',
  'www.twz.com': 'US',
  'www.upworthy.com': 'US',
  'www.vanguardngr.com': 'NG',
  'www.vercel-status.com': 'US',
  'www.visionofhumanity.org': 'AU',
  'www.windy.com': 'CZ',
  'www.winnipegfreepress.com': 'CA',
  'www.wired.com': 'US',
  'www.ycombinator.com': 'US',
  'www.yesmagazine.org': 'US',
  'www.ynetnews.com': 'IL',
  'www.zdnet.com': 'US',
  'www.zoomstatus.com': 'US',
  'arxiv.org': 'US',
  'fc.yahoo.com': 'US',
  'finance.yahoo.com': 'US',
  'news.usni.org': 'US',
  'sifted.eu': 'EU',
  'your-app.convex.site': 'US',
  'yourstory.com': 'IN',
  'gamma-api.polymarket.com': 'US',
  'noaadata.apps.nsidc.org': 'US',
});

// Provider-level overrides win when the host is a CDN, cloud, or shared
// platform that would otherwise point at the wrong country.
const PROVIDER_ORIGINS = Object.freeze({
  'B.C. Evacuation Orders and Alerts': 'CA',
  'Toronto Police Service': 'CA',
  'Toronto Police Service Open Data': 'CA',
  'GTA Update': 'CA',
  'Ember electricity data': 'GB',
  'Fast Company': 'US',
  'Mexico Energy Regulatory Commission (CRE)': 'MX',
  NDTV: 'IN',
  'Our World in Data': 'GB',
  'The Hacker News': 'IN',
  'World Health Organization (WHO)': null,
});

function normalizeHost(host) {
  return String(host || '').trim().toLowerCase();
}

function hasOwn(map, key) {
  return Object.prototype.hasOwnProperty.call(map, key);
}

export function inferOriginFromHost(host) {
  const lower = normalizeHost(host);
  if (!lower) return undefined;

  if (lower.endsWith('.usembassy.gov') || lower.endsWith('.gov') || lower.endsWith('.mil') || lower.endsWith('.fed.us')) {
    return 'US';
  }
  if (lower.endsWith('.edu')) return 'US';
  if (/\.(?:gov|service\.gov)\.uk$/.test(lower) || lower.endsWith('.ac.uk') || lower.endsWith('.co.uk') || lower.endsWith('.org.uk')) {
    return 'GB';
  }
  if (lower.endsWith('.gov.au') || lower.endsWith('.net.au') || lower.endsWith('.com.au') || lower.endsWith('.org.au') || lower.endsWith('.edu.au')) {
    return 'AU';
  }
  if (lower.endsWith('.gc.ca') || lower.endsWith('.canada.ca') || lower.endsWith('.statcan.gc.ca')) {
    return 'CA';
  }
  if (lower.endsWith('.gov.cn') || lower.endsWith('.com.cn') || lower.endsWith('.net.cn') || lower.endsWith('.org.cn') || lower.endsWith('.edu.cn') || lower.endsWith('.ac.cn')) {
    return 'CN';
  }
  if (lower.endsWith('.gov.tw')) return 'TW';
  if (lower.endsWith('.gov.hk')) return 'HK';
  if (lower.endsWith('.gov.my')) return 'MY';
  if (lower.endsWith('.gob.mx')) return 'MX';
  if (lower.endsWith('.gob.es')) return 'ES';
  if (lower.endsWith('.govt.nz') || lower.endsWith('.co.nz')) return 'NZ';
  if (lower.endsWith('.gov.br') || lower.endsWith('.com.br')) return 'BR';
  if (lower.endsWith('.europa.eu')) return 'EU';
  if (lower.endsWith('.gov.il') || lower.endsWith('.co.il')) return 'IL';
  if (lower.endsWith('.co.kr') || lower.endsWith('.go.kr')) return 'KR';
  if (lower.endsWith('.com.tr')) return 'TR';
  if (
    INTERNATIONAL_HOST_SUFFIXES.some((suffix) => lower === suffix.slice(1) || lower.endsWith(suffix))
    || lower.endsWith('.int')
  ) {
    return null;
  }

  const tld = lower.split('.').at(-1);
  if (!tld || GENERIC_TLDS.has(tld) || VANITY_CC_TLDS.has(tld)) return undefined;
  if (tld === 'uk') return 'GB';
  if (tld === 'eu') return 'EU';
  const iso2 = tld.toUpperCase();
  return ISO2_CODES.has(iso2) ? iso2 : undefined;
}

export function resolveHostOrigin(host) {
  const lower = normalizeHost(host);
  if (hasOwn(HOST_ORIGINS, lower)) return HOST_ORIGINS[lower];
  const wwwAlias = lower.startsWith('www.') ? lower.slice(4) : `www.${lower}`;
  if (hasOwn(HOST_ORIGINS, wwwAlias)) return HOST_ORIGINS[wwwAlias];
  return inferOriginFromHost(lower);
}

export function resolveSourceOrigin({ provider, hosts = [] } = {}) {
  if (hasOwn(PROVIDER_ORIGINS, provider)) return PROVIDER_ORIGINS[provider];

  const resolved = (hosts.length > 0 ? hosts : [provider]).map((host) => resolveHostOrigin(host));
  const missing = resolved.some((code) => code === undefined);
  if (missing) {
    throw new Error(`Source provider needs a catalog origin country: ${provider}`);
  }

  const unique = new Set(resolved.map((code) => code ?? INTERNATIONAL_FILTER));
  if (unique.size !== 1) {
    throw new Error(`Source provider has conflicting origin countries: ${provider}`);
  }

  const code = [...unique][0];
  return code === INTERNATIONAL_FILTER ? null : code;
}

const ORIGIN_LABEL_OVERRIDES = Object.freeze({
  EU: 'European Union',
  HK: 'Hong Kong',
});

export function sourceOriginLabel(code) {
  if (!code) return 'International';
  if (hasOwn(ORIGIN_LABEL_OVERRIDES, code)) return ORIGIN_LABEL_OVERRIDES[code];
  return REGION_NAMES.of(code) || code;
}

export function sourceOriginFilterValue(code) {
  return (code || INTERNATIONAL_FILTER).toLowerCase();
}

export function catalogCountryOptions(sourceCatalog) {
  const codes = new Set();
  let hasInternational = false;
  for (const provider of sourceCatalog) {
    if (provider.originCountry) codes.add(provider.originCountry);
    else hasInternational = true;
  }

  const options = [...codes]
    .map((code) => ({ code: sourceOriginFilterValue(code), name: sourceOriginLabel(code) }))
    .sort((left, right) => left.name.localeCompare(right.name, 'en', { sensitivity: 'base' }));

  if (hasInternational) {
    options.unshift({ code: INTERNATIONAL_FILTER, name: 'International' });
  }
  return options;
}

export function catalogCoverageCountryOptions(sourceCatalog) {
  const codes = new Set();
  for (const provider of sourceCatalog) {
    for (const code of provider.coveredCountries || []) {
      if (code) codes.add(code);
    }
  }
  return [...codes]
    .map((code) => ({ code: sourceOriginFilterValue(code), name: sourceOriginLabel(code) }))
    .sort((left, right) => left.name.localeCompare(right.name, 'en', { sensitivity: 'base' }));
}

export function assertKnownOriginCode(code, label) {
  if (code == null) return;
  if (!ISO2_CODES.has(code)) {
    throw new Error(`${label} uses unknown origin country "${code}"`);
  }
}

for (const [host, code] of Object.entries(HOST_ORIGINS)) {
  assertKnownOriginCode(code, `source-origin host ${host}`);
}
for (const [provider, code] of Object.entries(PROVIDER_ORIGINS)) {
  assertKnownOriginCode(code, `source-origin provider ${provider}`);
}
