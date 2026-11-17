# Country news feed coverage — 17 November 2026

The target is at least four selectable source feeds per country. This review covers the 193 UN member states, Palestine, Vatican City, Taiwan, and Kosovo. Dependencies and overseas territories are not counted as separate countries.

## Result

- 197 countries have four configured source choices.
- New entries in this dated audit: 617. Every addition is opt-in in every interface language.
- 482 additions are country-focused newsrooms, including local-language and exile publishers. 135 are publisher-scoped international country feeds.
- International feeds fill documented local gaps. These entries do not represent additional domestic newsrooms.
- 368 additions use native publisher RSS/Atom; the others use publisher-scoped Google News RSS.
- 52 additions had no item within the default four-day display window at the audit time. They remain usable feeds, but may show no recent headline until the publisher reports again. These are marked † below.

## Selection and limits

Prioritize established national newsrooms, public-service broadcasters, investigative nonprofit outlets, and independent exile reporting. Use country-specific Reuters, AP, BBC, Guardian, or Al Jazeera feeds where local coverage is insufficient. International country feeds are scoped to one publisher and an explicit country query; they do not represent new local publishers.

Ownership and editorial independence are separate from transport availability. State-owned outlets carry an explicit state-affiliation label and a lower source tier; their reports need independent corroboration. Multiple desks of a publisher share its family, including the international country feeds and RFE/RL language services. The count is of selectable feeds, not independent owners. N1/Danas, RJRGLEANER, Guardian Media in Trinidad and Tobago, and Alpha Media Holdings each share a corroboration family across their brands.

There is no comparable trust ranking for all 197 countries. The [Reuters Institute country analysis](https://reutersinstitute.politics.ox.ac.uk/digital-news-report/2026/country-and-market-data) informs the preference for established newsrooms and public-service reporting in the markets it covers. Press restrictions also constrain local choices: [RSF documents the absence of independent media inside Eritrea](https://rsf.org/en/country/eritrea). This review does not turn popularity or a working RSS endpoint into an objective reliability score.

Feed verification required parseable RSS/Atom. Native feeds had dated items. Google News queries use seven-day windows for local publishers and thirty-day windows for international country coverage; 11 returned a valid but empty window and are explicitly recorded as such. Publisher-scoped Google feeds were accepted only when item source domains matched the selected publisher. Native feeds were preferred, and stale endpoints, unverified identities, broad regional substitutes, and duplicate labels were excluded. Examples include the tourism successor to Ara Andorra, the unverified Le Rénovateur directory host, and a directory that mislabeled the Croatian N1 feed as Serbian. The Serbian endpoint was verified separately. Content review also rejected casino spam in Business Bhutan, unrelated content on the former Fraternité and Le Républicain domains, and a Telefuturo program index. RÚV and Al-Sumaria now use news-item endpoints. Language labels were checked against actual headlines; mixed-language publisher feeds retain a documented primary language.

The [machine-readable review](../../shared/country-news-coverage.json) records every country, rejected candidate, publisher home country, ownership class, feed URL, verification item count, and latest item time. “Country-focused” includes domestic and exile newsrooms plus existing regional reporting used for that country; publisher domicile is not used as a substitute for coverage.

This is source availability and configuration evidence. Feed health can change. It does not prove that every source is present in a live production digest: ingestion deadlines, freshness limits, and category caps still apply. No production cache refresh or deployment was performed.

## Country matrix

Existing is the number of these selected sources already in the catalog. Country-focused and international columns describe the final four-source selection. † marks a newly added feed with no item in the four-day display window at audit time (including empty feeds).

| Country | Existing | Country-focused | International | Sources |
| --- | ---: | ---: | ---: | --- |
| Afghanistan (AF) | 2 | 4 | 0 | Pajhwok Afghan News; Etilaat Roz; Amu TV; Rukhshana Media |
| Albania (AL) | 1 | 4 | 0 | Tirana Times; Balkan Insight; Reporter.al; ABC News Albania |
| Algeria (DZ) | 0 | 3 | 1 | TSA Algérie (Tout Sur l'Algérie); El Khabar; Algérie Presse Service; Reuters — Algeria |
| Andorra (AD) | 0 | 3 | 1 | Diari d'Andorra; El Periòdic d'Andorra; Bondia; Reuters — Andorra |
| Angola (AO) | 0 | 1 | 3 | Rádio Nacional de Angola (RNA); Reuters — Angola; BBC — Angola; Guardian — Angola |
| Antigua & Barbuda (AG) | 0 | 4 | 0 | Antigua News Room; ABS TV Radio Antigua & Barbuda; Antigua.news; Antigua Observer |
| Argentina (AR) | 2 | 4 | 0 | Infobae Americas; Clarín; La Nación Argentina; Página/12 |
| Armenia (AM) | 1 | 4 | 0 | Armenpress; Hetq; EVN Report; CivilNet |
| Australia (AU) | 2 | 4 | 0 | ABC News Australia; SBS News; Sydney Morning Herald; Guardian Australia |
| Austria (AT) | 0 | 4 | 0 | ORF.at; Der Standard; Die Presse; Falter |
| Azerbaijan (AZ) | 1 | 4 | 0 | Azertag; Azadliq Radiosu (RFE/RL - Azerbaijan); Meydan TV; Turan |
| Bahamas (BS) | 0 | 4 | 0 | The Tribune; The Nassau Guardian; Eyewitness News; ZNS Bahamas |
| Bahrain (BH) | 0 | 2 | 2 | Gulf Daily News; Bahrain Mirror; Reuters — Bahrain; AP — Bahrain |
| Bangladesh (BD) | 2 | 4 | 0 | The Daily Star; Dhaka Tribune; Prothom Alo; bdnews24 |
| Barbados (BB) | 0 | 2 | 2 | Caribbean Broadcasting Corporation (CBC); Barbados Today; BBC — Barbados; Guardian — Barbados |
| Belarus (BY) | 1 | 4 | 0 | Zerkalo; Belsat TV; Nasha Niva; Euroradio |
| Belgium (BE) | 0 | 4 | 0 | VRT NWS; RTBF Info; De Standaard; Le Soir |
| Belize (BZ) | 0 | 4 | 0 | Channel 5 Belize; Love FM; Amandala †; The San Pedro Sun |
| Benin (BJ) | 0 | 3 | 1 | La Nouvelle Tribune; Reuters — Benin; Matin Libre †; ORTB Benin |
| Bhutan (BT) | 0 | 3 | 1 | Kuensel; The Bhutanese; Reuters — Bhutan; Bhutan Broadcasting Service |
| Bolivia (BO) | 0 | 2 | 2 | El Deber; Los Tiempos †; Reuters — Bolivia; Guardian — Bolivia |
| Bosnia & Herzegovina (BA) | 1 | 4 | 0 | Balkan Insight; N1 Bosna i Hercegovina; Oslobođenje; Klix.ba |
| Botswana (BW) | 0 | 3 | 1 | The Botswana Gazette; The Voice †; Mmegi; Reuters — Botswana |
| Brazil (BR) | 4 | 4 | 0 | Folha de S.Paulo; O Globo; Agência Brasil; Brazil Reports |
| Brunei (BN) | 0 | 3 | 1 | The Scoop; Borneo Bulletin; The Bruneian; Reuters — Brunei |
| Bulgaria (BG) | 1 | 3 | 1 | Dnevnik; Mediapool.bg; The Sofia Globe; Reuters — Bulgaria |
| Burkina Faso (BF) | 1 | 3 | 1 | leFaso.net; Burkina24; Studio Yafa; Reuters — Burkina Faso |
| Burundi (BI) | 0 | 3 | 1 | Iwacu; SOS Médias Burundi; Yaga Burundi; Reuters — Burundi |
| Cambodia (KH) | 0 | 4 | 0 | CamboJA News †; The Cambodia Daily; Phnom Penh Post; Kiripost |
| Cameroon (CM) | 1 | 3 | 1 | The Guardian Post; Le Jour †; CRTV (Cameroon Radio Television); Reuters — Cameroon |
| Canada (CA) | 4 | 4 | 0 | CBC News; Globe and Mail; La Presse; The Narwhal |
| Cape Verde (CV) | 0 | 4 | 0 | A Nação; Expresso das Ilhas; Inforpress; Notícias do Norte |
| Central African Republic (CF) | 1 | 2 | 2 | Radio Ndeke Luka; Corbeau News Centrafrique; Reuters — Central African Republic; BBC — Central African Republic |
| Chad (TD) | 2 | 3 | 1 | Tchadinfos; Alwihda Info; Le Pays Tchad; Reuters — Chad |
| Chile (CL) | 0 | 4 | 0 | La Tercera; BioBioChile †; Ciperchile; CNN Chile |
| China (CN) | 2 | 4 | 0 | Caixin Global; Sixth Tone; South China Morning Post; Xinhua |
| Colombia (CO) | 2 | 4 | 0 | El Tiempo; La Silla Vacía; El Espectador; La República Colombia |
| Comoros (KM) | 0 | 1 | 3 | Habari Za Comores; Reuters — Comoros; AP — Comoros †; BBC — Comoros |
| Congo - Brazzaville (CG) | 0 | 3 | 1 | Les Dépêches de Brazzaville; Journal de Brazza; CongoPage; Reuters — Congo - Brazzaville † |
| Congo - Kinshasa (CD) | 2 | 3 | 1 | Actualite.cd; Radio Okapi; Le Potentiel; Reuters — Congo - Kinshasa |
| Costa Rica (CR) | 0 | 3 | 1 | La Nación; The Tico Times; Telenoticias (Teletica); Reuters — Costa Rica |
| Croatia (HR) | 3 | 4 | 0 | N1 Croatia; Index.hr; Jutarnji list; Novi list |
| Cuba (CU) | 2 | 3 | 1 | 14ymedio; Havana Times; Diario de Cuba; Reuters — Cuba |
| Cyprus (CY) | 0 | 4 | 0 | Cyprus Mail; Phileleftheros; Politis; Cyprus News Agency |
| Czechia (CZ) | 1 | 4 | 0 | Seznam Zprávy; ČT24; Hospodářské noviny; Radio Prague International |
| Côte d’Ivoire (CI) | 0 | 3 | 1 | Linfodrome; Agence Ivoirienne de Presse (AIP); Connection Ivoirienne; BBC — Côte d’Ivoire |
| Denmark (DK) | 1 | 2 | 2 | DR Nyheder; Jyllands-Posten; Reuters — Denmark; AP — Denmark |
| Djibouti (DJ) | 0 | 3 | 1 | La Nation; La Voix de Djibouti †; RTD Djibouti †; Reuters — Djibouti |
| Dominica (DM) | 0 | 2 | 2 | Dominica News Online; Emonews †; Reuters — Dominica; AP — Dominica † |
| Dominican Republic (DO) | 0 | 3 | 1 | Diario Libre; Hoy; El Día; Reuters — Dominican Republic |
| Ecuador (EC) | 2 | 4 | 0 | Primicias; El Universo; El Comercio; Expreso † |
| Egypt (EG) | 2 | 4 | 0 | Mada Masr; Egypt Independent; Daily News Egypt; Ahram Online |
| El Salvador (SV) | 0 | 2 | 2 | El Faro; Diario Co Latino; AP — El Salvador; BBC — El Salvador |
| Equatorial Guinea (GQ) | 0 | 1 | 3 | AHORAEG Guinea Ecuatorial; Reuters — Equatorial Guinea; AP — Equatorial Guinea †; BBC — Equatorial Guinea |
| Eritrea (ER) | 0 | 2 | 2 | Awate.com; Setit †; Reuters — Eritrea; AP — Eritrea |
| Estonia (EE) | 1 | 3 | 1 | ERR News; Postimees; Äripäev; Reuters — Estonia |
| Eswatini (SZ) | 0 | 2 | 2 | Times of Eswatini; Swaziland News; AP — Eswatini; BBC — Eswatini |
| Ethiopia (ET) | 2 | 4 | 0 | The Reporter Ethiopia; Ethiopia Insight; Addis Fortune; Addis Standard |
| Fiji (FJ) | 0 | 4 | 0 | Fiji Times; Fiji Sun; FBC News; Islands Business |
| Finland (FI) | 1 | 4 | 0 | Yle News; Helsingin Sanomat; Hufvudstadsbladet; Turun Sanomat |
| France (FR) | 2 | 4 | 0 | Le Monde; France 24; Franceinfo; Libération |
| Gabon (GA) | 0 | 4 | 0 | L'Union; Gabonreview; Gabon Actu; Gabonews |
| Gambia (GM) | 0 | 4 | 0 | The Point; Foroyaa; The Standard; Malagen |
| Georgia (GE) | 3 | 4 | 0 | Civil.ge; OC Media; JAMnews; Netgazeti |
| Germany (DE) | 4 | 4 | 0 | Tagesschau; Der Spiegel; Die Zeit; Deutschlandfunk |
| Ghana (GH) | 2 | 4 | 0 | MyJoyOnline; Citi Newsroom; Graphic Online; Ghana Business News |
| Greece (GR) | 4 | 4 | 0 | Kathimerini; Naftemporiki; ERT; in.gr |
| Grenada (GD) | 0 | 3 | 1 | NOW Grenada; Grenada Broadcasting Network (GBN) †; WEE FM Radio Grenada; Reuters — Grenada |
| Guatemala (GT) | 0 | 3 | 1 | La Hora; Plaza Pública; Prensa Comunitaria; Reuters — Guatemala |
| Guinea (GN) | 0 | 3 | 1 | Guinéenews.org; Guineematin.com; Guinee7.com; Reuters — Guinea |
| Guinea-Bissau (GW) | 0 | 2 | 2 | Agência de Notícias da Guiné (ANG); O Democrata; Reuters — Guinea-Bissau; AP — Guinea-Bissau † |
| Guyana (GY) | 0 | 3 | 1 | Kaieteur News; Demerara Waves Online News; News Source Guyana; Reuters — Guyana |
| Haiti (HT) | 2 | 4 | 0 | AyiboPost; Le Nouvelliste; The Haitian Times; HaitiLibre English |
| Honduras (HN) | 0 | 3 | 1 | Proceso Digital; Criterio.hn; La Prensa Honduras †; Reuters — Honduras |
| Hungary (HU) | 4 | 4 | 0 | Telex; HVG; 444.hu; 24.hu |
| Iceland (IS) | 0 | 3 | 1 | RÚV (Ríkisútvarpið); Iceland Review; The Reykjavík Grapevine; Reuters — Iceland |
| India (IN) | 3 | 4 | 0 | The Hindu; Indian Express; NDTV; Scroll.in |
| Indonesia (ID) | 1 | 4 | 0 | Jakarta Post; Kompas; Tempo Indonesia; ANTARA News |
| Iran (IR) | 2 | 4 | 0 | BBC Persian; Iran International; Shargh Daily; Entekhab.ir |
| Iraq (IQ) | 1 | 4 | 0 | Rudaw; Al-Sumaria; Al Mada Newspaper; Shafaq News |
| Ireland (IE) | 0 | 4 | 0 | RTÉ News; The Irish Times; Irish Independent; TheJournal.ie |
| Israel (IL) | 4 | 4 | 0 | Haaretz; Times of Israel; Ynetnews; Jerusalem Post |
| Italy (IT) | 3 | 4 | 0 | ANSA; Corriere della Sera; Repubblica; Il Post |
| Jamaica (JM) | 0 | 4 | 0 | The Gleaner; Jamaica Observer; Radio Jamaica News; Jamaica Information Service (JIS) |
| Japan (JP) | 2 | 4 | 0 | Asahi Shimbun; Japan Times; NHK (日本放送協会); Japan Wire by Kyodo News |
| Jordan (JO) | 0 | 3 | 1 | The Jordan Times; Jordan News; Ammon News; Reuters — Jordan |
| Kazakhstan (KZ) | 1 | 4 | 0 | The Astana Times; Vlast.kz; Informburo.kz; Radio Azattyq |
| Kenya (KE) | 1 | 4 | 0 | Daily Nation; The Standard Kenya; Citizen TV; The Star Kenya |
| Kiribati (KI) | 0 | 0 | 4 | Reuters — Kiribati; AP — Kiribati †; BBC — Kiribati †; Guardian — Kiribati |
| Kosovo (XK) | 1 | 4 | 0 | Koha; Kallxo; Kosovo 2.0; Balkan Insight |
| Kuwait (KW) | 0 | 3 | 1 | Kuwait Times; Arab Times Kuwait; Kuwait News Agency; Reuters — Kuwait |
| Kyrgyzstan (KG) | 0 | 4 | 0 | Akipress; 24.kg; Kloop.kg; Radio Azattyk |
| Laos (LA) | 0 | 1 | 3 | Laotian Times; Reuters — Laos; BBC — Laos; Guardian — Laos |
| Latvia (LV) | 1 | 4 | 0 | LSM English; Delfi Latvia; Ir; Diena |
| Lebanon (LB) | 3 | 4 | 0 | L'Orient Today; Annahar; Naharnet Lebanon; The Public Source † |
| Lesotho (LS) | 0 | 3 | 1 | Lesotho Times; Public Eye; The Reporter Lesotho; Reuters — Lesotho |
| Liberia (LR) | 0 | 3 | 1 | FrontPage Africa; The New Dawn Liberia; Liberian Observer; Reuters — Liberia |
| Libya (LY) | 1 | 3 | 1 | Libya Herald; The Libya Observer; Al Wasat; Reuters — Libya |
| Liechtenstein (LI) | 0 | 1 | 3 | Liechtensteiner Vaterland †; AP — Liechtenstein; BBC — Liechtenstein; Guardian — Liechtenstein |
| Lithuania (LT) | 1 | 4 | 0 | LRT English; DELFI Lithuania; 15min.lt; Verslo žinios |
| Luxembourg (LU) | 0 | 4 | 0 | Luxemburger Wort; RTL Luxembourg; Le Quotidien Luxembourg †; Woxx |
| Madagascar (MG) | 0 | 4 | 0 | L'Express de Madagascar; Midi Madagasikara; Madagascar-Tribune.com; 2424.mg |
| Malawi (MW) | 0 | 4 | 0 | The Times Group Malawi; The Nation Malawi; Malawi Nyasa Times; Malawi24 |
| Malaysia (MY) | 1 | 4 | 0 | The Star (Malaysia); Malay Mail; Malaysiakini; Bernama |
| Maldives (MV) | 0 | 3 | 1 | Maldives Independent; Sun Online; Dhauru; Reuters — Maldives |
| Mali (ML) | 1 | 3 | 1 | Studio Tamani; Reuters — Mali; Journal du Mali; Sahelien.com |
| Malta (MT) | 0 | 4 | 0 | Times of Malta; MaltaToday; The Shift News; Newsbook Malta |
| Marshall Islands (MH) | 0 | 1 | 3 | The Marshall Islands Journal †; Reuters — Marshall Islands; AP — Marshall Islands; Guardian — Marshall Islands |
| Mauritania (MR) | 0 | 3 | 1 | Le Calame; Sahara Medias; Alakhbar; Reuters — Mauritania |
| Mauritius (MU) | 0 | 3 | 1 | L'Express Mauritius; Le Mauricien; Le Défi Media Group; Reuters — Mauritius |
| Mexico (MX) | 2 | 2 | 2 | Mexico News Daily; Reforma; Reuters — Mexico; AP Mexico |
| Micronesia (FM) | 0 | 0 | 4 | AP — Micronesia †; BBC — Micronesia †; Guardian — Micronesia †; Al Jazeera — Micronesia † |
| Moldova (MD) | 2 | 4 | 0 | NewsMaker; Ziarul de Gardă; TV8; Moldova 1 |
| Monaco (MC) | 0 | 3 | 1 | Monaco-Matin; Monaco Life; Monaco Tribune †; Reuters — Monaco |
| Mongolia (MN) | 0 | 4 | 0 | Montsame; News.MN †; The UB Post †; GoGo Mongolia |
| Montenegro (ME) | 1 | 2 | 2 | Vijesti; Balkan Insight; Reuters — Montenegro; AP — Montenegro |
| Morocco (MA) | 0 | 4 | 0 | TelQuel; Hespress; Morocco World News; Le Desk |
| Mozambique (MZ) | 0 | 4 | 0 | O País; Zitamar News; Carta de Moçambique; Club of Mozambique |
| Myanmar (Burma) (MM) | 1 | 2 | 2 | Irrawaddy; Myanmar Now; Reuters — Myanmar (Burma); AP — Myanmar (Burma) |
| Namibia (NA) | 0 | 3 | 1 | The Namibian; New Era; Namibia Economist; Reuters — Namibia |
| Nauru (NR) | 0 | 0 | 4 | Reuters — Nauru; AP — Nauru; BBC — Nauru †; Guardian — Nauru † |
| Nepal (NP) | 0 | 4 | 0 | The Kathmandu Post; Nepali Times; Online Khabar; Setopati |
| Netherlands (NL) | 2 | 4 | 0 | NOS Nieuws; NRC; de Volkskrant; RTL Nieuws |
| New Zealand (NZ) | 0 | 4 | 0 | RNZ; Stuff NZ; Newsroom; New Zealand Herald |
| Nicaragua (NI) | 0 | 4 | 0 | Confidencial; La Prensa Nicaragua †; Nicaragua Investiga; Divergentes |
| Niger (NE) | 2 | 4 | 0 | ActuNiger; Aïr Info; Studio Kalangou; Le Sahel |
| Nigeria (NG) | 4 | 4 | 0 | Premium Times; Channels TV; Daily Trust; ThisDay |
| North Korea (KP) | 0 | 3 | 1 | NK News; Daily NK; BBC Korean; Reuters — North Korea |
| North Macedonia (MK) | 1 | 3 | 1 | Balkan Insight; Makfax; Meta.mk; AP — North Macedonia |
| Norway (NO) | 2 | 4 | 0 | NRK; Aftenposten; TV 2; Dagsavisen |
| Oman (OM) | 1 | 4 | 0 | Oman Observer; Times of Oman; Muscat Daily; Al-Roya |
| Pakistan (PK) | 2 | 4 | 0 | Dawn; Geo News; Express Tribune; Business Recorder |
| Palau (PW) | 1 | 1 | 3 | Island Times (Palau); Reuters — Palau; AP — Palau †; Guardian — Palau † |
| Palestinian Territories (PS) | 1 | 3 | 1 | WAFA English; Al-Quds Newspaper; Palestine News Network; Reuters — Palestinian Territories |
| Panama (PA) | 0 | 2 | 2 | La Prensa; TVN Noticias; Reuters — Panama; AP — Panama † |
| Papua New Guinea (PG) | 0 | 3 | 1 | Papua New Guinea Post-Courier; The National PNG; EMTV Online; Reuters — Papua New Guinea |
| Paraguay (PY) | 0 | 1 | 3 | La Nación Paraguay †; Guardian — Paraguay; Reuters — Paraguay; AP — Paraguay |
| Peru (PE) | 0 | 4 | 0 | La República Peru; El Comercio Peru; RPP Noticias; IDL-Reporteros |
| Philippines (PH) | 1 | 4 | 0 | Rappler; Philippine Daily Inquirer; GMA News; ABS-CBN News |
| Poland (PL) | 4 | 4 | 0 | TVN24; Rzeczpospolita; Gazeta Wyborcza; OKO.press |
| Portugal (PT) | 0 | 3 | 1 | Expresso; RTP Notícias; Observador; Reuters — Portugal |
| Qatar (QA) | 1 | 4 | 0 | Al Jazeera; Doha News; Gulf Times; The Peninsula Qatar |
| Romania (RO) | 3 | 4 | 0 | Digi24; HotNews; G4Media; Recorder † |
| Russia (RU) | 3 | 4 | 0 | Meduza; Moscow Times; Novaya Gazeta Europe; The Insider |
| Rwanda (RW) | 0 | 3 | 1 | The New Times Rwanda; KT Press; Taarifa Rwanda; Reuters — Rwanda |
| Samoa (WS) | 0 | 3 | 1 | Samoa Observer; Talamua Online News; Samoa Global News; Reuters — Samoa |
| San Marino (SM) | 0 | 4 | 0 | San Marino RTV; Libertas.sm; San Marino Fixing; Giornale.sm |
| Saudi Arabia (SA) | 2 | 3 | 1 | Arab News; Saudi Gazette; Asharq News; Reuters — Saudi Arabia |
| Senegal (SN) | 1 | 4 | 0 | Le Quotidien; Agence de Presse Senegalaise (APS); Le Soleil; PressAfrik |
| Serbia (RS) | 0 | 4 | 0 | N1 Info; Danas; Insajder; KRIK |
| Seychelles (SC) | 0 | 2 | 2 | Seychelles Nation; Seychelles Broadcasting Corporation; Reuters — Seychelles; AP — Seychelles † |
| Sierra Leone (SL) | 0 | 3 | 1 | The Sierra Leone Telegraph; Awoko †; The Calabash Newspaper; Reuters — Sierra Leone |
| Singapore (SG) | 1 | 4 | 0 | CNA; Straits Times; Mothership; The Online Citizen |
| Slovakia (SK) | 0 | 4 | 0 | Sme; Denník N; Aktuality.sk; TA3 |
| Slovenia (SI) | 0 | 4 | 0 | RTV Slovenija; Delo; N1 Slovenia; 24ur.com |
| Solomon Islands (SB) | 0 | 4 | 0 | Solomon Star; Solomon Times; SIBC; Island Sun |
| Somalia (SO) | 1 | 4 | 0 | Hiiraan Online; Garowe Online; Radio Ergo; Goobjoog News |
| South Africa (ZA) | 1 | 4 | 0 | News24; Daily Maverick; Mail & Guardian; GroundUp |
| South Korea (KR) | 1 | 4 | 0 | Yonhap News; The Korea Herald; Hankyoreh; Korea Times |
| South Sudan (SS) | 1 | 4 | 0 | Radio Tamazuj; Eye Radio; Catholic Radio Network; Sudans Post |
| Spain (ES) | 2 | 4 | 0 | El País; El Mundo; elDiario.es; RTVE Noticias |
| Sri Lanka (LK) | 0 | 4 | 0 | The Island; EconomyNext; Daily Mirror Sri Lanka; News First Sri Lanka |
| St. Kitts & Nevis (KN) | 0 | 2 | 2 | The St. Kitts-Nevis Observer; WINNFM 98.9; Reuters — St. Kitts & Nevis †; AP — St. Kitts & Nevis † |
| St. Lucia (LC) | 0 | 4 | 0 | The Voice of Saint Lucia; The St Lucia Star †; St Lucia Times; DBS TV St Lucia |
| St. Vincent & Grenadines (VC) | 0 | 3 | 1 | iWitness News; St Vincent Times; NBC Radio; AP — St. Vincent & Grenadines |
| Sudan (SD) | 1 | 3 | 1 | Dabanga Sudan; Sudan Tribune; Sudan War Monitor; Reuters — Sudan |
| Suriname (SR) | 0 | 3 | 1 | De Ware Tijd; De West; Suriname Herald; AP — Suriname † |
| Sweden (SE) | 3 | 4 | 0 | SVT Nyheter; Dagens Nyheter; Svenska Dagbladet; Sveriges Radio |
| Switzerland (CH) | 0 | 4 | 0 | Schweizer Radio und Fernsehen (SRF); Le Temps; Neue Zürcher Zeitung; Tages-Anzeiger |
| Syria (SY) | 2 | 4 | 0 | Syria Direct; Enab Baladi English; Al-Jumhuriya; The Syrian Observer |
| São Tomé & Príncipe (ST) | 0 | 4 | 0 | Téla Nón; Jornal Tropical; Rádio Somos Todos Primos (RSTP); STP-Press |
| Taiwan (TW) | 3 | 4 | 0 | Focus Taiwan; Taipei Times; The Reporter; Taiwan News |
| Tajikistan (TJ) | 0 | 4 | 0 | Asia-Plus; Radio Ozodi; Avesta; Your.tj |
| Tanzania (TZ) | 0 | 4 | 0 | The Citizen Tanzania; The Chanzo; Daily News; ITV Tanzania † |
| Thailand (TH) | 1 | 4 | 0 | Bangkok Post; Matichon; Prachatai; Khaosod English |
| Timor-Leste (TL) | 0 | 3 | 1 | Tatoli; The Dili Weekly; Timor Post; Reuters — Timor-Leste |
| Togo (TG) | 0 | 3 | 1 | Togotopnews; IciLome; Togo‑Presse; Reuters — Togo |
| Tonga (TO) | 0 | 1 | 3 | Matangi Tonga †; Reuters — Tonga; AP — Tonga; BBC — Tonga |
| Trinidad & Tobago (TT) | 0 | 3 | 1 | Trinidad Express; Trinidad Guardian; CNC3; AP — Trinidad & Tobago |
| Tunisia (TN) | 0 | 4 | 0 | La Presse de Tunisie; Mosaique FM; Nawaat; Inkyfada |
| Turkmenistan (TM) | 1 | 4 | 0 | Chronicles of Turkmenistan; Turkmen.news; Radio Azatlyk; Eurasianet |
| Tuvalu (TV) | 0 | 0 | 4 | Reuters — Tuvalu; AP — Tuvalu; BBC — Tuvalu †; Guardian — Tuvalu |
| Türkiye (TR) | 1 | 4 | 0 | BBC Turkce; Cumhuriyet; BirGün; Evrensel |
| Uganda (UG) | 0 | 4 | 0 | The Monitor Uganda; The Observer; The Independent (Uganda); Uganda Radio Network (URN) † |
| Ukraine (UA) | 4 | 4 | 0 | Kyiv Independent; Ukrainska Pravda; Suspilne; ZN.UA |
| United Arab Emirates (AE) | 1 | 3 | 1 | The National; Khaleej Times; Gulf News; Reuters — United Arab Emirates |
| United Kingdom (GB) | 4 | 4 | 0 | BBC UK; Guardian World; Financial Times; Sky News |
| United States (US) | 4 | 4 | 0 | AP News; Reuters US; NPR News; PBS NewsHour |
| Uruguay (UY) | 0 | 4 | 0 | El País Uruguay; La Diaria; Brecha; MercoPress |
| Uzbekistan (UZ) | 0 | 4 | 0 | Gazeta.uz; Kun.uz; Podrobno.uz; The Tashkent Times |
| Vanuatu (VU) | 0 | 2 | 2 | Vanuatu Daily Post; VBTC Vanuatu; AP — Vanuatu †; BBC — Vanuatu † |
| Vatican City (VA) | 0 | 1 | 3 | Vatican News English; Reuters — Vatican City; AP — Vatican City; BBC — Vatican City |
| Venezuela (VE) | 2 | 4 | 0 | Efecto Cocuyo; Caracas Chronicles; El Pitazo; Tal Cual |
| Vietnam (VN) | 2 | 4 | 0 | VnExpress; Tuoi Tre News; Vietnam News; Thanh Niên |
| Yemen (YE) | 2 | 3 | 1 | Sana'a Center; Al-Ayam (الأيام); Yemen Online; Reuters — Yemen |
| Zambia (ZM) | 0 | 2 | 2 | News Diggers!; Lusaka Times; Reuters — Zambia; AP — Zambia |
| Zimbabwe (ZW) | 0 | 3 | 1 | NewsDay Zimbabwe; The Financial Gazette; The Zimbabwe Independent; Reuters — Zimbabwe |
