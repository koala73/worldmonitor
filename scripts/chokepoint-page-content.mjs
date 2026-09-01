// Hand-authored crawlable copy for /chokepoints/* pages. Kept out of the
// browser bundle (the registry in src/config/ stays numeric). Every analysis
// paragraph is waterway-specific so the 13 pages do not share the pre-rewrite
// template skeleton (#7461). EIA oil figures are derived from the committed
// 2023 World Oil Transit Chokepoints table shared with
// scripts/seed-chokepoint-baselines.mjs.

import { buildEiaOilTransitBaselines } from './chokepoint-eia-baselines.mjs';

export const CHOKEPOINT_PAGE_CONTENT_PATH = 'scripts/chokepoint-page-content.mjs';

// Committed observation dates for Dataset temporalCoverage and <time datetime>
// stamps. Docker corpus builds exclude `.git`, so gitFileLastmod() is null
// there; these dates keep Hormuz-class pages dated without repository history.
// Bump when the corresponding src/config file's data actually changes.
export const CHOKEPOINT_REGISTRY_OBSERVED_AT = '2026-04-09';
export const TRADE_ROUTES_OBSERVED_AT = '2026-03-14';

export const EIA_OIL_TRANSIT_BASELINES = buildEiaOilTransitBaselines();

export const CHOKEPOINT_CONTENT = {
  suez: {
    region: 'Mediterranean ↔ Red Sea',
    glossarySlug: 'suez-canal',
    blurb:
      'The Suez Canal is the artificial waterway linking the Mediterranean and the Red Sea, giving shipping the shortest route between Europe and Asia without rounding Africa. Its southern approach runs through Bab el-Mandeb, so a blockage or a Red Sea security threat that reroutes traffic around the Cape of Good Hope adds days of transit and materially raises freight costs.',
    whyHeading: 'What happens to Europe–Asia shipping if the Suez Canal is blocked?',
    analysis: [
      'Opened as a sea-level canal across the Isthmus of Suez, this cut is not a natural strait: it is an engineered slot whose banks, locks-free channel, and convoy system set a hard daily capacity. A grounded boxship in a single-lane reach can halt both directions, which is why Ever Given in March 2021 remains the canonical illustration. World Monitor treats Suez as one of four energy-shock-model waterways because oil and LNG that already cleared Hormuz and Bab el-Mandeb still have to pass here to reach the Mediterranean and Northwest Europe.',
      'The modelled corridor set is container-heavy: China → Europe (Suez), China → US East Coast (Suez), Singapore → Mediterranean, and India → Europe, plus the energy legs Persian Gulf → Europe (Oil) and Qatar LNG → Europe. Those are the routes that become Cape sailings when the canal or its Red Sea approach is unsafe. The Cape alternative is modelled on the Cape of Good Hope page as Asia → Europe (Cape Route); it is longer, not theoretical, and it is not a row in this canal’s waypoint table.',
    ],
    alternative:
      'When Suez is closed or the southern approach is too risky, operators send Europe–Asia loops around the Cape of Good Hope and still re-enter the Mediterranean through Gibraltar. That is extra distance and bunker burn, not a second canal. SUMED pipeline capacity can move some Gulf crude from the Red Sea to the Mediterranean, but it does not carry containers or LNG, so most of the modelled Suez book has no pipeline substitute.',
    faqs: [
      {
        question: 'Is the Suez Canal a natural strait?',
        answer: 'No. It is an excavated sea-level canal between Port Said and Suez. Capacity is an operational limit (convoys, beam, and draft), not a coastline width.',
      },
      {
        question: 'Does World Monitor model an energy shock for Suez?',
        answer: 'Yes. Suez is one of the four shock-model chokepoints. The EIA 2023 World Oil Transit Chokepoints series records 7.6 million barrels a day on the combined Suez Canal / SUMED row.',
      },
    ],
  },
  malacca_strait: {
    region: 'Indian Ocean ↔ South China Sea',
    glossarySlug: 'strait-of-malacca',
    whyHeading: 'Why is the Strait of Malacca East Asia’s default energy and container gate?',
    blurb:
      'The Strait of Malacca runs between the Malay Peninsula and Sumatra, linking the Indian Ocean to the South China Sea and the Pacific. It is one of the busiest shipping lanes in the world and the main artery for energy and container flows into East Asia, where the alternatives are longer and lower-capacity.',
    analysis: [
      'Malacca is the shallow, crowded funnel between the Indian Ocean and the South China Sea. Very large crude carriers that exceed the strait’s draft often continue via Lombok or Makassar instead, which is why Lombok exists in this same 13-waterway set as a deep-water relief valve rather than as a modelled corridor duplicate. For the ships that do fit, there is no cheaper East Asia approach from the west.',
      'World Monitor maps seven modelled routes onto this waypoint: the two Suez-bound China–Europe and China–US East Coast container loops, Persian Gulf → Asia (Oil) at 15M+ bpd, Qatar LNG → Asia, India → SE Asia, China → Africa, and the CPEC Route. Energy shock modelling is enabled here because an interruption does not merely slow boxes; it reroutes Gulf barrels that already committed to the Malacca–Singapore lane.',
    ],
    alternative:
      'The deep-water detour is Lombok Strait (and, for some bulk, Makassar). Those passages add distance and still rejoin the same East Asian port ranges. They do not create a second 17-million-barrel-a-day oil lane. The EIA 2023 Malacca baseline of 17.2 million barrels a day is the committed energy scale for this waterway, second only to Hormuz in that series.',
    faqs: [
      {
        question: 'Can the largest tankers use the Strait of Malacca?',
        answer: 'Not always. Draft limits push the largest crude carriers toward Lombok or Makassar. Malacca remains the default for most container and many energy movements into East Asia.',
      },
      {
        question: 'Does World Monitor model an energy shock for Malacca?',
        answer: 'Yes. Malacca is shock-model supported. The EIA 2023 World Oil Transit Chokepoints row for the Strait of Malacca is 17.2 million barrels a day.',
      },
    ],
  },
  hormuz_strait: {
    region: 'Persian Gulf ↔ Gulf of Oman',
    glossarySlug: 'strait-of-hormuz',
    whyHeading: 'Why is the Strait of Hormuz the most watched energy chokepoint?',
    blurb:
      'The Strait of Hormuz is the narrow waterway connecting the Persian Gulf to the Gulf of Oman and the open ocean. It is the single most closely watched energy chokepoint on Earth: about 20% of the world’s seaborne crude oil — and a large share of LNG — has no alternative route out of the Gulf.',
    analysis: [
      'Hormuz is the only maritime exit for most Persian Gulf oil and for Qatar’s LNG. Pipelines that bypass the strait exist, but they do not replace the seaborne export system. That is the geographic fact behind the monitoring intensity: a closure is not a longer voyage, it is missing barrels until stocks and spare production elsewhere respond.',
      'The modelled book is entirely energy: Persian Gulf → Asia (Oil) at 15M+ bpd, Persian Gulf → Europe (Oil) at 6.5M+ bpd, Qatar LNG → Europe, Qatar LNG → Asia, and Persian Gulf → Americas (Cape Route). Asia is the largest oil leg; Europe’s oil and LNG still have to clear Bab el-Mandeb and Suez after Hormuz. The Cape energy leg is the Americas alternative that never uses Suez.',
    ],
    alternative:
      'There is no second strait out of the Gulf. Overland bypass pipelines can move a fraction of crude to the Red Sea or Gulf of Oman, but they do not carry the LNG that Ras Laffan loads, and they do not recreate the 21.0 million barrels a day in the EIA 2023 World Oil Transit Chokepoints Hormuz row. World Monitor therefore enables the energy shock model on this waterway and keeps a dedicated transit research report in /research/.',
    faqs: [
      {
        question: 'Is there a sea route that avoids the Strait of Hormuz?',
        answer: 'No. Gulf exports that leave by ship must use Hormuz. Bypass pipelines move some crude overland; they are not a second seaborne strait and they do not move Qatar’s LNG.',
      },
      {
        question: 'Does World Monitor model an energy shock for Hormuz?',
        answer: 'Yes. Hormuz is shock-model supported. The committed EIA 2023 baseline is 21.0 million barrels a day, the largest row in that seven-waterway series.',
      },
    ],
  },
  bab_el_mandeb: {
    region: 'Red Sea ↔ Gulf of Aden',
    whyHeading: 'Why do Suez sailings also have to clear Bab el-Mandeb?',
    blurb:
      'Bab el-Mandeb is the strait between the Horn of Africa and the Arabian Peninsula that connects the Red Sea to the Gulf of Aden and the Indian Ocean. Every ship using the Suez Canal route also transits Bab el-Mandeb, so attacks or instability here push traffic onto the far longer Cape of Good Hope route.',
    analysis: [
      'Bab el-Mandeb is the southern gate of the Red Sea. A Suez booking is a two-strait product: Mediterranean–Red Sea at Suez, Red Sea–Gulf of Aden here. Security incidents off Yemen therefore show up as Cape rerouting even when the canal itself is physically open. World Monitor keeps a bounded Red Sea security crisis tracker for that reason; this page is the waterway reference, not that tracker.',
      'The modelled routes are the same Suez-dependent set: China → Europe, China → US East Coast (Suez), Persian Gulf → Europe (Oil), Qatar LNG → Europe, Singapore → Mediterranean, and India → Europe. Gulf–Asia oil and LNG that turn east after Hormuz do not need Bab el-Mandeb; the Europe-bound energy and the Asia–Europe container loops do.',
    ],
    alternative:
      'The operational substitute is the Cape of Good Hope, modelled on that waterway’s page as Asia → Europe (Cape Route) and as the Americas energy Cape leg. That substitute adds thousands of nautical miles. It does not require a second Red Sea strait. The EIA 2023 Bab el-Mandeb baseline is 6.2 million barrels a day; shock modelling is enabled because those barrels sit on the same Suez-bound energy legs.',
    faqs: [
      {
        question: 'Can a ship use Suez without using Bab el-Mandeb?',
        answer: 'Not on a voyage between the Indian Ocean and the Mediterranean. The Red Sea has one southern gate. Intra-Red Sea moves are a different geography.',
      },
      {
        question: 'Does World Monitor model an energy shock for Bab el-Mandeb?',
        answer: 'Yes. It is one of the four shock-model chokepoints. The EIA 2023 World Oil Transit Chokepoints baseline is 6.2 million barrels a day.',
      },
    ],
  },
  panama: {
    region: 'Atlantic ↔ Pacific',
    whyHeading: 'Why can drought close the Panama Canal when both oceans are open?',
    blurb:
      'The Panama Canal cuts across the Isthmus of Panama to link the Atlantic and Pacific oceans, saving vessels the long voyage around South America. Its lock system depends on freshwater from Gatún Lake, so drought can throttle daily transits and reshape Asia–US East Coast routing.',
    analysis: [
      'Panama is a lock canal, not a sea-level cut. Each lockage spends Gatún Lake freshwater. In a dry season the authority rationing is daily slots and draft, not a wartime closure. That is a different failure mode from Hormuz or Bab el-Mandeb: the oceans stay open while the engineered shortcut shrinks. World Monitor does not attach the energy shock model here; the committed EIA 2023 Panama baseline is 0.9 million barrels a day, an order of magnitude below Hormuz.',
      'Only two modelled corridors use this waypoint: China → US East Coast (Panama) at 8M+ TEU/year, and Panama Transit at 14K+ transits/year between Colon and Balboa. The competing Asia–US East Coast product is China → US East Coast (Suez), waypointed on the Suez page rather than in this canal’s table. When Panama slots tighten, that Suez (or Cape) option is the documented substitute, not a second Central American canal.',
    ],
    alternative:
      'Ships that miss a Panama slot go around Cape Horn, use the US intermodal landbridge, or take the Suez/Cape eastbound product waypointed on the Suez page, not in this canal’s two-row table. None of those recreate the freshwater lock system. Drought rationing therefore shows up first as fewer daily transits and shallower permitted draft, which is why the live pulse on this page can publish a calm disruption score while still withholding an unsupplied AIS day-count.',
    faqs: [
      {
        question: 'Is Panama an energy chokepoint like Hormuz?',
        answer: 'No. World Monitor does not enable the energy shock model on Panama. The EIA 2023 oil-transit baseline is 0.9 million barrels a day, versus 21.0 at Hormuz. Panama’s distinctive risk is lock freshwater, not a missing sea exit.',
      },
      {
        question: 'Which modelled routes use the Panama Canal?',
        answer: 'China → US East Coast (Panama) and the local Panama Transit corridor. The Suez-routed China → US East Coast product is the documented alternative; it is waypointed on the Suez page, not in this canal’s two-row table.',
      },
    ],
  },
  taiwan_strait: {
    region: 'East China Sea ↔ South China Sea',
    whyHeading: 'Why does military tension in the Taiwan Strait hit containers first?',
    blurb:
      'The Taiwan Strait separates Taiwan from mainland China and carries a large share of the container traffic moving between North Asia and the rest of the world. Its strategic sensitivity makes any military tension here a first-order risk to global shipping and the semiconductor supply chain.',
    analysis: [
      'This is a wide, busy shelf sea, not a lock canal. The monitoring case is political-military, not draft. North Asia–world container schedules that hug the Chinese coast use this corridor; a firing-line or exclusion zone would shove them east of Taiwan into the Philippine Sea at the cost of time and weather exposure, not a missing ocean.',
      'World Monitor maps two modelled container routes here: China → US West Coast at 24M+ TEU/year, and Intra-Asia Container at 30M+ TEU/year. There is no EIA oil-transit baseline and no energy shock model. The semiconductor story is about the island’s industry and the ships that serve it, not about a 21-million-barrel oil lane.',
    ],
    alternative:
      'The geographic substitute is to steam east of Taiwan rather than through the strait. That is extra miles on already long trans-Pacific and intra-Asia loops, and it does not move fabrication plants. Unlike Cape rerouting for Suez, this detour stays in the same ocean and still depends on the same origin and destination ports.',
    faqs: [
      {
        question: 'Does World Monitor treat the Taiwan Strait as an oil chokepoint?',
        answer: 'No. There is no EIA oil-transit baseline and no energy shock model on this waterway. The modelled exposure is container: China → US West Coast and Intra-Asia Container.',
      },
      {
        question: 'Is the Taiwan Strait as narrow as Hormuz?',
        answer: 'No. It is a broad shelf sea between the island and the mainland. The risk is exclusion and military signalling, not a one-mile-wide geographic cork.',
      },
    ],
  },
  cape_of_good_hope: {
    region: 'Atlantic ↔ Indian Ocean',
    whyHeading: 'When is the Cape of Good Hope a chokepoint rather than just a longer road?',
    blurb:
      'The Cape of Good Hope is the deep-water route around the southern tip of Africa. It has no canal tolls and no width limits, which makes it the default fallback when the Suez–Bab el-Mandeb corridor is disrupted — at the cost of thousands of extra nautical miles and days of transit.',
    analysis: [
      'The Cape is open ocean with no lock and no strait cork. World Monitor still lists it among the 13 because it is the overflow valve that prices Suez risk. When Red Sea security collapses, this is where the AIS density moves. Treating it as a monitored waterway lets the live pulse and the modelled table name the same fallback instead of leaving “ships went the long way” as a footnote.',
      'Three modelled corridors use this waypoint: Brazil → China (Bulk) at 350M+ tonnes/year, Persian Gulf → Americas (Cape Route) at 2M+ bpd, and Asia → Europe (Cape Route) at 5M+ TEU/year. The bulk Brazil–China leg is a structural Cape user, not a Suez refugee. The other two are explicit Suez alternatives already cross-linked from Hormuz, Bab el-Mandeb, and Suez pages.',
    ],
    alternative:
      'The Cape is the alternative. Weather, bunker, and pirate-risk off West Africa are the frictions, not a second African canal. There is no EIA oil-transit baseline and no energy shock model; a Cape “closure” would be a storm or a port strike, not a missing geographic gap.',
    faqs: [
      {
        question: 'Why monitor an open-ocean cape as a chokepoint?',
        answer: 'Because it is the documented Suez/Bab el-Mandeb overflow and a structural Brazil–China bulk lane. The 13-waterway set is about optionality, not only narrowness.',
      },
      {
        question: 'Does the Cape have an EIA oil baseline?',
        answer: 'No. World Monitor does not attach an EIA World Oil Transit Chokepoints row or an energy shock model to the Cape of Good Hope.',
      },
    ],
  },
  gibraltar: {
    region: 'Atlantic ↔ Mediterranean',
    whyHeading: 'Why does every Suez–Europe loop still have to use Gibraltar?',
    blurb:
      'The Strait of Gibraltar is the roughly 14-km-wide gateway between the Atlantic Ocean and the Mediterranean Sea. Every cargo moving between the Mediterranean and the wider ocean — including Suez-bound Europe–Asia traffic — passes through it.',
    analysis: [
      'Gibraltar is the Atlantic door of the Mediterranean. Suez delivers Asia–Europe cargo into the eastern Mediterranean; to reach the Atlantic ranges (Rotterdam, the US East Coast via Suez, West Africa) that cargo still exits here. Intra-Mediterranean trades never need it. That split is why Gibraltar appears on Gulf–Europe oil, Singapore–Mediterranean, India–Europe, and Asia–Europe (Cape Route) but not on purely Asian legs.',
      'Four modelled routes use this waypoint: Persian Gulf → Europe (Oil), Singapore → Mediterranean, India → Europe, and Asia → Europe (Cape Route). The Cape loop still re-enters Europe’s Atlantic approaches and is therefore in this set even when it skipped Suez. There is no EIA oil-transit baseline and no energy shock model; the oil that does pass is already attributed to Hormuz/Suez/Bab el-Mandeb in that series.',
    ],
    alternative:
      'There is no second sea gate between the Atlantic and the Mediterranean. The overland options are pipeline and rail across Iberia or the Maghreb, which do not move the container loops. A Gibraltar closure would trap Mediterranean shipping inside the basin the way a Bosporus closure traps the Black Sea, at a much larger cargo scale.',
    faqs: [
      {
        question: 'Do Cape of Good Hope sailings still use Gibraltar?',
        answer: 'Europe-bound Cape loops that discharge in the Mediterranean or transit to Mediterranean hubs still use Gibraltar. Pure Atlantic European discharge can avoid it.',
      },
      {
        question: 'Is Gibraltar shock-modelled?',
        answer: 'No. World Monitor does not enable the energy shock model here and does not assign an EIA 2023 oil-transit baseline to Gibraltar.',
      },
    ],
  },
  bosphorus: {
    region: 'Black Sea ↔ Sea of Marmara',
    whyHeading: 'Why can the Montreux Convention close the Bosporus to more than grain?',
    blurb:
      'The Bosporus Strait runs through Istanbul to connect the Black Sea to the Sea of Marmara and, via the Dardanelles, the Mediterranean. It is the sole maritime outlet for Black Sea grain and Russian oil exports, and passage through it is governed by the Montreux Convention.',
    analysis: [
      'The Bosporus is a city strait: a winding, current-scoured channel through Istanbul with no practical second mouth. Together with the Dardanelles it is the Turkish Straits. World Monitor’s registry id is bosphorus; the EIA 2023 series labels the same baseline Turkish Straits at 2.9 million barrels a day. Legal control is the Montreux Convention, which is a peacetime and wartime passage regime, not a lock schedule.',
      'Only one modelled corridor uses this waypoint: Russia → Mediterranean (Oil) at 140M+ tonnes/year from Novorossiysk to Piraeus. Grain and other Black Sea bulk are operationally in the same geographic cork even when they are not a separate row in TRADE_ROUTES. There is no energy shock model on this waterway; the oil baseline exists, but the four-waterway shock set is Hormuz, Malacca, Suez, and Bab el-Mandeb.',
    ],
    alternative:
      'There is no second sea exit from the Black Sea. Overland and pipeline routes can move some oil and grain, but they do not recreate a Mediterranean tanker arrival. A Montreux restriction or a blocked channel therefore isolates Black Sea ports rather than adding days the way a Suez diversion does.',
    faqs: [
      {
        question: 'Is the Bosporus the same as the EIA “Turkish Straits” row?',
        answer: 'World Monitor maps its bosphorus registry id to the EIA Turkish Straits baseline of 2.9 million barrels a day (2023). That EIA label covers the Bosporus–Dardanelles pair, not Istanbul alone.',
      },
      {
        question: 'Does World Monitor model an energy shock for the Bosporus?',
        answer: 'No. Shock modelling is limited to four waterways. The Bosporus still has a committed EIA oil baseline and a modelled Russia → Mediterranean oil corridor.',
      },
    ],
  },
  korea_strait: {
    region: 'East China Sea ↔ Sea of Japan',
    whyHeading: 'Why watch the Korea Strait if no modelled trade corridor is mapped?',
    blurb:
      'The Korea Strait lies between the Korean Peninsula and the Japanese islands, linking the East China Sea to the Sea of Japan. It is a key passage for North Asian container and energy traffic and a closely watched naval corridor.',
    analysis: [
      'The Korea Strait (with the Western Channel / Tsushima) is the door between the East China Sea and the Sea of Japan / East Sea. Busan, Kitakyushu, and the Russian Far East lanes all feel this geography. World Monitor has not yet attached a TRADE_ROUTES waypoint here, so this page is a strategic-waterway reference whose corridor table has no mapped rows. That is a registry gap, not a claim that nothing sails.',
      'There is no EIA oil-transit baseline and no energy shock model. Intra-Asia Container in the trade-route table uses Taiwan Strait, not this id. Readers should not infer zero traffic from an empty modelled table; they should infer that this waterway is monitored for disruption and AIS while its corridor book is still unmapped.',
    ],
    alternative:
      'Ships can use the Tsugaru or Soya straits to enter the Sea of Japan from the Pacific, which is a different, weather-heavy detour around Japan rather than a second Korea Strait. Those options do not replace Busan–westbound density.',
    faqs: [
      {
        question: 'Why is the Korea Strait in the 13-waterway set without routes?',
        answer: 'Because it is a canonical monitored waterway in CHOKEPOINT_REGISTRY. Modelled TRADE_ROUTES waypoints have not been attached yet. The live pulse can still publish disruption and withhold an unsupplied transit count.',
      },
      {
        question: 'Is this the same as the Intra-Asia Container route?',
        answer: 'No. Intra-Asia Container is waypointed at the Taiwan Strait. The Korea Strait page is a separate strategic reference.',
      },
    ],
  },
  dover_strait: {
    region: 'English Channel ↔ North Sea',
    whyHeading: 'Why is Dover among the busiest lanes if World Monitor maps no corridor row?',
    blurb:
      'The Strait of Dover is the narrowest point of the English Channel, connecting it to the North Sea. It is one of the busiest shipping lanes in the world, funnelling North Sea and Baltic traffic past the coasts of England and France.',
    analysis: [
      'Dover is a TSS-controlled bottleneck between the North Sea and the Atlantic approaches, not a canal. Ferry, short-sea, and deep-sea north–south European traffic share a narrow, tidal lane. World Monitor tracks it as a strategic waterway reference: it is not currently mapped to one of the modelled trade-route corridors, but vessel traffic and disruption signals are still monitored on the live map.',
      'The EIA 2023 series does not publish a “Dover” row. World Monitor’s energy-flow seeder maps this registry id to the Danish Straits baseline of 3.0 million barrels a day — the broader Baltic–North Sea passage set, not a Dover-only meter. Shock modelling is off. Readers should not treat 3.0 million barrels a day as a Dover throughput claim.',
    ],
    alternative:
      'Deep-sea ships can in principle use the longer Scotland–Norway gap, but that is not how the North Sea–Atlantic container and energy pattern is scheduled. The Channel is the short road; Dover is where it pinches.',
    faqs: [
      {
        question: 'Does World Monitor publish modelled TEU or bpd through Dover?',
        answer: 'No modelled TRADE_ROUTES waypoint uses dover_strait, so the corridor table on this page has no mapped rows. That is not a zero-traffic claim.',
      },
      {
        question: 'Why does methodology mention 3.0 million barrels a day near Dover?',
        answer: 'The EIA 2023 Danish Straits baseline (3.0 million barrels a day) is joined to this registry id for energy-flow seeding. It is the Baltic–North Sea passage set, not a Dover-only observation.',
      },
    ],
  },
  kerch_strait: {
    region: 'Black Sea ↔ Sea of Azov',
    whyHeading: 'Why does control of the Kerch Strait gate Azov-basin trade?',
    blurb:
      'The Kerch Strait connects the Black Sea to the Sea of Azov and is the only sea route to the Azov ports of Ukraine and Russia. It has been a repeated flashpoint in the Russia–Ukraine conflict, where control of the strait directly gates Azov-basin trade.',
    analysis: [
      'Kerch is a shallow, bridged strait. Since the Kerch Bridge opened, air draft and security screening sit on top of the geographic cork. Mariupol, Berdyansk, and the Russian Azov ports are Azov-basin ports; they do not have a second sea mouth. A blocked or heavily inspected Kerch Strait is therefore a port shutdown for that basin, not a Cape-style detour.',
      'World Monitor maps no TRADE_ROUTES waypoint here. The modelled Russia → Mediterranean oil corridor uses the Bosporus from Novorossiysk, a Black Sea port west of Kerch, so that row does not speak for Azov. There is no EIA oil-transit baseline and no energy shock model. This page exists because the registry treats Kerch as a conflict-sensitive waterway, not because a TEU corridor has been encoded.',
    ],
    alternative:
      'There is no maritime alternative into the Sea of Azov. Overland and river options (Don, rail) move some bulk but do not recreate an Azov seaport call. That is closer to Bosporus-style isolation than to Suez-style extra days.',
    faqs: [
      {
        question: 'Is Kerch on the Russia → Mediterranean oil route?',
        answer: 'No. That modelled corridor waypoints the Bosporus from Novorossiysk. Kerch gates the Sea of Azov, a different basin.',
      },
      {
        question: 'Why does this page’s corridor table have no mapped rows?',
        answer: 'No TRADE_ROUTES entry lists kerch_strait as a waypoint. Kerch is tracked as a strategic waterway reference; disruption signals can still appear in the live pulse.',
      },
    ],
  },
  lombok_strait: {
    region: 'Indian Ocean ↔ Java Sea',
    whyHeading: 'When do ships choose Lombok instead of Malacca?',
    blurb:
      'The Lombok Strait, between Bali and Lombok, is a deep-water alternative to the Malacca–Singapore route. It is favoured by the largest, deepest-draft bulk carriers and serves as a relief valve when Malacca is congested or disrupted.',
    analysis: [
      'Lombok is deep and relatively uncluttered compared with Malacca–Singapore. Very large crude and ore carriers that cannot take Malacca’s draft come this way (often with Makassar) between the Indian Ocean and East Asian discharge ranges. World Monitor therefore lists it next to Malacca even though no TRADE_ROUTES waypoint currently points here: it is the documented overflow, not a second copy of the 17.2 million-barrel Malacca baseline.',
      'There is no EIA oil-transit baseline on Lombok itself and no energy shock model. The energy shock stays on Malacca. An empty modelled table means the corridor book has not yet encoded Lombok legs; it does not mean VLCC captains stopped using the strait.',
    ],
    alternative:
      'The primary lane remains Malacca for ships that fit. Sunda Strait is a third Indonesian option but is shallower and more constrained than Lombok. When Malacca is the problem, Lombok is the deep-water answer this registry names.',
    faqs: [
      {
        question: 'Is Lombok a substitute for the entire Malacca oil lane?',
        answer: 'No. It is the deep-draft relief valve. The EIA 2023 oil-transit baseline of 17.2 million barrels a day sits on Malacca, not on Lombok.',
      },
      {
        question: 'Why is the modelled route table empty?',
        answer: 'No TRADE_ROUTES waypoint uses lombok_strait yet. The page remains a strategic-waterway reference with live disruption monitoring.',
      },
    ],
  },
};
