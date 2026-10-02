# Curated country coverage: 2026-09-13

Related: [issue #7748](https://github.com/koala73/worldmonitor/issues/7748).

## Baseline

This audit uses the committed [2026-09-09 snapshot](../snapshots/crawlable-live-pulse-2026-09-09.json), not a new production capture. Its 196 country records contain 72 eligible and published briefs. Of the 124 remaining records, 123 have no curated headline: 96 have enough publisher families but fail the curated-source gate, 16 also fail the two-publisher floor, and 11 have no grounding. Haiti has a curated source but fails the publisher floor.

Counts come from `countries[*].developments.headlines`: a row with `origin != "country-index"` is curated. Region labels come from `shared/iso2-to-region.json`; its east-asia group includes Pacific states, and its Europe group includes Central Asia. The table below lists every country without a curated row.

| Region | Countries without curated reporting |
|---|---:|
| east-asia | 23 |
| europe | 32 |
| latam | 21 |
| mena | 7 |
| south-asia | 2 |
| sub-saharan-africa | 38 |

The most common existing index source labels are: `riotimesonline.com` (16 countries), `allafrica.com` (13 countries), `english.news.cn` (9 countries), `africa-newsroom.com` (6 countries), `trend.az` (6 countries), `miragenews.com` (4 countries), `novinite.com` (4 countries), `blueprint.ng` (4 countries). These labels describe captured sources, not an editorial endorsement. Index articles remain index articles; adding a feed does not relabel old index rows as curated.

## Scoped acquisition change

Add five regional RSS feeds from Guardian and France 24, and connect the existing France 24 LatAm and Mexico News Daily browser feeds to the full server digest. Place them near the start of their server categories so the category-fair scheduler can fetch them before the global deadline. Add matching tiers, source types, ownership/risk declarations and publisher-family labels. Regional desks have no country-local geography credit. Each publisher remains one family across its editions.

No publisher floor, citation check, feed/category cap, ranking rule, content-age rule, brief generator or frozen snapshot changes.

## Public-feed evidence

The seven URLs returned HTTP 200 and RSS on 2026-09-13. The real `parseRssXml` parser accepted five items per feed (35 total). Applying the digest default 96-hour age limit leaves 29 items. The real `selectCountryHeadlines` matcher identifies six countries with fresh candidates that had no curated row in the baseline: Algeria, Grenada, Jamaica, Malaysia, Uganda and Vanuatu. Palau also matched the raw feed, but its sampled article failed the age limit and is excluded from this fresh count.

| Feed | RSS URL | Parsed / fresh items | Fresh matches in baseline gap |
|---|---|---:|---|
| Guardian Africa | [RSS](https://www.theguardian.com/world/africa/rss) | 5 / 5 | UG |
| Guardian Caribbean | [RSS](https://www.theguardian.com/world/caribbean/rss) | 5 / 3 | GD, JM |
| Guardian Pacific | [RSS](https://www.theguardian.com/world/pacific-islands/rss) | 5 / 1 | VU |
| France 24 Africa | [RSS](https://www.france24.com/en/africa/rss) | 5 / 5 | DZ, UG |
| France 24 Asia Pacific | [RSS](https://www.france24.com/en/asia-pacific/rss) | 5 / 5 | MY |
| France 24 LatAm | [RSS](https://www.france24.com/en/americas/rss) | 5 / 5 | None in this sample |
| Mexico News Daily | [RSS](https://mexiconewsdaily.com/feed/) | 5 / 5 | None in this sample |

These are acquisition and matching observations. They do not measure the final digest ranking/cap, brief generation, a new frozen snapshot, deployed behavior or a production coverage increase. The feed probe is newer than the baseline; combining them is not a new coherent snapshot.

The five new browser sources are opt-in. A one-time local migration and cloud preference schema 9 add them to existing non-empty disabled-source lists. The rollout history includes this feed wave so earlier default migrations keep their original fingerprints. Empty or malformed lists retain the existing migration policy; completed migrations preserve later source choices.

## Verification and acceptance boundary

Controlled RSS tests exercise the registered server feeds, English scheduling, RSS allowlisting, browser parity, parsing, country matching, source metadata and publisher-family counting. They retain both thin-grounding and uncurated-grounding failure cases. Feed, provenance, development, preference migration, source-cap and cloud-sync tests pass; freeze/corpus suites pass (218 tests). Browser and API typechecks and boundary lint pass. Sources settings browser checks cover live apply and a returning Pro profile that enables Guardian Pacific and reloads. Manual inspection confirmed the new entries at desktop and 390px mobile widths, and Guardian Pacific remained selected after closing and reopening Settings. Screenshots and exact-head CI results are recorded in the PR.

After an authorized deployment, inspect the first successful scheduled digest and snapshot within 24 hours. Compare `briefEligibleCount`, `briefCountryCount`, `briefMatchedCount`, `briefUncuratedGroundingCount`, per-feed statuses and `droppedCategoryCap` against the new snapshot. Check dated country headlines and absence reasons on the affected country pages. A successful feed fetch alone is not acceptance. If no fresh snapshot appears within that window, record freshness as the blocker; if feeds are fetched but their rows are consistently discarded, investigate digest selection before adding more sources. Leave #7748 open for the remaining countries.

## Country gap register

Source labels are copied from the stored snapshot. `no-grounding` rows have no captured source. The primary gate is ordered, so `thin-grounding` can also mean no curated source.

### east-asia

| Country (ISO2) | Snapshot gate | Existing grounding source labels |
|---|---|---|
| BN | thin-grounding | brudirect.com |
| FJ | uncurated-grounding | energy-storage.news, fijisun.com.fj, islandsbusiness.com, sbs.com.au, waateanews.com |
| FM | no-grounding | None |
| KH | uncurated-grounding | asianews.network, chiangraitimes.com, english.news.cn, worldcasinodirectory.com |
| KI | no-grounding | None |
| KP | uncurated-grounding | bnn-news.com, eurasiareview.com, straitstimes.com, techtimes.com, theepochtimes.com |
| LA | uncurated-grounding | english.news.cn, globaltimes.cn |
| MH | no-grounding | None |
| MM | thin-grounding | bnionline.net |
| MN | uncurated-grounding | akipress.com, english.news.cn, gasgoo.com, globaltimes.cn, koreatimes.co.kr |
| MO | thin-grounding | macaudailytimes.com.mo |
| MY | uncurated-grounding | asianews.network, channelnewsasia.com, eco-business.com, scmp.com, therakyatpost.com |
| NR | uncurated-grounding | crikey.com.au, english.wafa.ps, sana.sy |
| NZ | uncurated-grounding | nzherald.co.nz, scoop.co.nz |
| PG | uncurated-grounding | developingtelecoms.com, gavi.org, itbrief.co.nz, rnz.co.nz, thenational.com.pg |
| PW | uncurated-grounding | asiaone.com, english.news.cn, globaltimes.cn, straitstimes.com |
| SB | uncurated-grounding | abc.net.au, eurasiareview.com, rfa.org, scoop.co.nz |
| TL | uncurated-grounding | miragenews.com, webindia123.com |
| TO | uncurated-grounding | islandsbusiness.com, matangitonga.to |
| TV | no-grounding | None |
| VN | thin-grounding | vir.com.vn |
| VU | uncurated-grounding | bandt.com.au, dailypost.vu, travelweekly.com.au |
| WS | thin-grounding | samoaobserver.ws |

### europe

| Country (ISO2) | Snapshot gate | Existing grounding source labels |
|---|---|---|
| AD | thin-grounding | miragenews.com |
| AL | uncurated-grounding | aljazeera.com, arabnews.com, freemalaysiatoday.com, maritime-executive.com, scmp.com |
| AM | uncurated-grounding | arka.am, jamestown.org, news.am, novinite.com |
| AT | uncurated-grounding | hola.com, medicaldaily.com, nypost.com, perthnow.com.au, scallywagandvagabond.com |
| AZ | uncurated-grounding | en.apa.az, news.am, panorama.am |
| BA | thin-grounding | eurasiareview.com |
| BE | uncurated-grounding | blueprint.ng, compoundsemiconductor.net, energy-storage.news, gamereactor.eu, shafaqna.com |
| BG | thin-grounding | novinite.com |
| BY | uncurated-grounding | delfi.lt, iraq-businessnews.com, law.by, sb.by, yahoo.com |
| CH | uncurated-grounding | bournemouthecho.co.uk, en.apa.az, presseschleuder.com, pressnetwork.de, webpronews.com |
| CY | uncurated-grounding | cyprus-mail.com, worldcasinodirectory.com |
| CZ | uncurated-grounding | arka.am, el-balad.com, nebraskapublicmedia.org, radiokerry.ie |
| EE | uncurated-grounding | baltic-review.com, channelnewsasia.com, freemalaysiatoday.com, globalsecurity.org, miragenews.com |
| HR | uncurated-grounding | aol.co.uk, euronews.com, kclr96fm.com, luxurytravelmagazine.com, tourism-review.com |
| KG | uncurated-grounding | akipress.com, aol.co.uk, gulf-times.com, trend.az |
| LI | uncurated-grounding | catholicculture.org, theweek.com |
| LT | uncurated-grounding | baltictimes.com, cbsnews.com, finanzen.ch, news.az, rttnews.com |
| LU | thin-grounding | chronicle.lu |
| LV | uncurated-grounding | baltic-review.com, bnn-news.com, finanzen.ch, rttnews.com |
| MC | uncurated-grounding | etnow.com, international-adviser.com, monacolife.net |
| MD | uncurated-grounding | bssnews.net, civic.md, kyivpost.com, thehindu.com, undp.org |
| ME | uncurated-grounding | akipress.com, balkaninsight.com, english.news.cn |
| MK | uncurated-grounding | finanznachrichten.de, novinite.com, qatar-tribune.com, trend.az |
| NL | uncurated-grounding | curacaochronicle.com, digitimes.com, nltimes.nl, rustourismnews.com, scienceblog.com |
| RO | uncurated-grounding | romaniapress.com, rri.ro, zfenglish.com |
| RS | uncurated-grounding | archaeology.org, balkaninsight.com, dailysabah.com, euobserver.com, novinite.com |
| SI | uncurated-grounding | euronews.com, finanznachrichten.de, freightweek.org, jpost.com, middleeastmonitor.com |
| SK | uncurated-grounding | newswiretoday.com, poweronline.com, rttnews.com |
| SM | uncurated-grounding | corporatejetinvestor.com, fundsforngos.org, motogp.com |
| TJ | uncurated-grounding | miragenews.com, newscentralasia.net, trend.az |
| TM | uncurated-grounding | newscentralasia.net, tdh.gov.tm, trend.az |
| UZ | uncurated-grounding | english.news.cn, thailand-business-news.com, trend.az |

### latam

| Country (ISO2) | Snapshot gate | Existing grounding source labels |
|---|---|---|
| AG | uncurated-grounding | abstvradio.com, antiguaobserver.com, shockya.com |
| BB | uncurated-grounding | 2lt.com.au, barbadostoday.bb, smn-news.com |
| BO | uncurated-grounding | finanznachrichten.de, geo.tv, sana.sy, thehindu.com, themunicheye.com |
| BS | uncurated-grounding | butlereagle.com, dailybreeze.com, dailycamera.com, redbluffdailynews.com, republicanherald.com |
| BZ | uncurated-grounding | greaterbelize.com, lovefm.com |
| CR | uncurated-grounding | cntraveler.com, indiatimes.com, qcostarica.com, thecostaricanews.com |
| DM | no-grounding | None |
| DO | uncurated-grounding | intelligencer.ca, jamaicaobserver.com, latintimes.com, leaderpost.com, montrealgazette.com |
| EC | uncurated-grounding | maritime-executive.com, mongabay.com, prnewswire.com, proactiveinvestors.com.au, scienceblog.com |
| GD | thin-grounding | nowgrenada.com |
| GT | uncurated-grounding | rfdtv.com, riotimesonline.com, theoaklandpress.com |
| GY | uncurated-grounding | jamaica-gleaner.com, kaieteurnewsonline.com, qatar-tribune.com, riotimesonline.com |
| HN | no-grounding | None |
| JM | uncurated-grounding | jamaicaobserver.com, radiojamaicanewsonline.com |
| KN | uncurated-grounding | sknvibes.com, zizonline.com |
| LC | thin-grounding | caribjournal.com |
| PA | uncurated-grounding | galvnews.com, newsroompanama.com, wjhg.com |
| SR | thin-grounding | riotimesonline.com |
| SV | uncurated-grounding | breitbart.com, chiangraitimes.com, jamaicaplainnews.com, riotimesonline.com, sofokleous10.gr |
| TT | uncurated-grounding | newsday.co.tt, riotimesonline.com, searchlight.vc, thecaribbeancamera.com |
| VC | no-grounding | None |

### mena

| Country (ISO2) | Snapshot gate | Existing grounding source labels |
|---|---|---|
| BH | uncurated-grounding | gdnonline.com, middleeasteye.net |
| DJ | uncurated-grounding | fundsforngos.org, garoweonline.com, igad.int, riotimesonline.com |
| DZ | uncurated-grounding | allafrica.com, developingtelecoms.com, echoroukonline.com, en.apa.az, trend.az |
| KW | uncurated-grounding | dailypolitical.com, english.news.cn |
| MT | uncurated-grounding | aleteia.org, derbytelegraph.co.uk, indiatimes.com, italpress.com, moneycontrol.com |
| TN | uncurated-grounding | energy-pedia.com, journalismpakistan.com, middleeastmonitor.com, oilreviewmiddleeast.com, themunicheye.com |
| YE | uncurated-grounding | al-monitor.com, indiatimes.com, stcatharinesstandard.ca, the-messenger.com, thenationalnews.com |

### south-asia

| Country (ISO2) | Snapshot gate | Existing grounding source labels |
|---|---|---|
| LK | uncurated-grounding | chennaionline.com, idrw.org, lankanewspapers.com |
| MV | uncurated-grounding | cyprus-mail.com, hinews.cn, maldivesindependent.com, thedailymash.co.uk |

### sub-saharan-africa

| Country (ISO2) | Snapshot gate | Existing grounding source labels |
|---|---|---|
| AO | uncurated-grounding | allafrica.com, bmmagazine.co.uk |
| BF | uncurated-grounding | blueprint.ng, ghanamma.com, nigerianobservernews.com, riotimesonline.com |
| BI | uncurated-grounding | capitalfm.africa, chimpreports.com, ghafla.co.ke, riotimesonline.com |
| BJ | uncurated-grounding | blueprint.ng, dailypost.ng, leadership.ng, punchng.com |
| BW | uncurated-grounding | africa-newsroom.com, allafrica.com, equitybulls.com, sgu.edu, thepatriot.co.bw |
| CF | uncurated-grounding | allafrica.com, riotimesonline.com |
| CG | no-grounding | None |
| CI | uncurated-grounding | africanewsanalysis.com, gavi.org, moroccoworldnews.com |
| CM | uncurated-grounding | 76crimes.com, businessincameroon.com |
| CV | uncurated-grounding | brava.news, ghanaiantimes.com.gh, investmentwatchblog.com, tribuneonlineng.com, turnto10.com |
| ER | uncurated-grounding | africa-newsroom.com, outoftownblog.com, shabait.com |
| GA | thin-grounding | riotimesonline.com |
| GM | uncurated-grounding | dailymaverick.co.za, thepoint.gm, vanguardngr.com |
| GN | uncurated-grounding | mongabay.com, moroccoworldnews.com, riotimesonline.com |
| GQ | thin-grounding | channelafrica.co.za |
| GW | uncurated-grounding | medafricatimes.com, riotimesonline.com |
| KM | uncurated-grounding | blueprint.ng, technicalreviewmiddleeast.com |
| LR | thin-grounding | frontpageafricaonline.com |
| LS | uncurated-grounding | allafrica.com, english.news.cn, fundsforngos.org, riotimesonline.com, sundayexpress.co.ls |
| MG | uncurated-grounding | aol.co.uk, arynews.tv, natureworldnews.com, riotimesonline.com |
| ML | uncurated-grounding | allafrica.com, arm.com, digit.in, fonearena.com, wfp.org |
| MR | no-grounding | None |
| MU | uncurated-grounding | africa-newsroom.com, mauritiustimes.com |
| MW | thin-grounding | nyasatimes.com |
| MZ | uncurated-grounding | allafrica.com, ecr.co.za, globalpost.com |
| NA | uncurated-grounding | allafrica.com, republikein.com.na |
| NE | uncurated-grounding | africa.com, allafrica.com |
| RW | uncurated-grounding | channelafrica.co.za, omanobserver.om, theedinburghreporter.co.uk, tribtoday.com |
| SC | uncurated-grounding | africa-newsroom.com, nation.sc |
| SL | uncurated-grounding | africa-newsroom.com, allafrica.com, statehouse.gov.sl, switsalone.com |
| SN | uncurated-grounding | africa-newsroom.com, africa.com, channelafrica.co.za, cnbcafrica.com |
| SS | uncurated-grounding | english.news.cn, news.az, newvision.co.ug, radiotamazuj.org |
| ST | no-grounding | None |
| SZ | no-grounding | None |
| TG | uncurated-grounding | africanews.com, allafrica.com, riotimesonline.com, thenationonlineng.net |
| TZ | uncurated-grounding | allafrica.com, newvision.co.ug, proactiveinvestors.com, proactiveinvestors.com.au, yahoo.com |
| UG | uncurated-grounding | allafrica.com, ntv.co.ug, observer.ug, riotimesonline.com, sanews.gov.za |
| ZM | uncurated-grounding | businessday.co.za, cnbcafrica.com, times.co.zm, znbc.co.zm |
