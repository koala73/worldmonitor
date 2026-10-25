# Submarine cable gaps vs TeleGeography

Generated 2026-10-20 by `node scripts/check-submarine-cable-gaps.mjs --out scripts/data/submarine-cable-gaps.md`.
Source: https://www.submarinecablemap.com/api/v3/cable/all.json (+ per-cable detail). Curated list: 98 cables. TeleGeography: 712 cables.
Missing in-service cables landing in 2+ countries: 235. Sorted by country count, then length.
To add one: append its slug to CABLE_REGIONS in scripts/seed-submarine-cables.mjs and mirror the seeded entry in src/config/geo-map.ts.

| Slug | Name | RFS | Length | Countries |
| --- | --- | --- | --- | --- |
| southern-caribbean-fiber | Southern Caribbean Fiber | 2006 | 3,000 km | Antigua and Barbuda, Barbados, Dominica, Grenada, Guadeloupe, Martinique, Montserrat, Saint Barthélemy, Saint Kitts and Nevis, Saint Lucia, Saint Martin, Saint Vincent and the Grenadines, Trinidad and Tobago, United States, Virgin Islands (U.S.) |
| medusa-submarine-cable-system | Medusa Submarine Cable System | 2026 | 8,760 km | Algeria, Cyprus, Egypt, France, Greece, Italy, Libya, Malta, Morocco, Portugal, Spain, Syria, Tunisia |
| eastern-caribbean-fiber-system-ecfs | Eastern Caribbean Fiber System (ECFS) | 1995 | 1,335 km | Anguilla, Antigua and Barbuda, Barbados, Dominica, Grenada, Guadeloupe, Martinique, Saint Kitts and Nevis, Saint Lucia, Saint Vincent and the Grenadines, Sint Maarten, Trinidad and Tobago, Virgin Islands (U.K.) |
| pacific-caribbean-cable-system-pccs | Pacific Caribbean Cable System (PCCS) | 2015 | 6,163 km | Aruba, Colombia, Curaçao, Ecuador, Panama, United States, Virgin Islands (U.K.) |
| tpu | TPU | 2026 | 13,470 km | Guam, Northern Mariana Islands, Philippines, Taiwan, United States |
| maroc-telecom-west-africa | Maroc Telecom West Africa | 2021 | 8,600 km | Benin, Côte d'Ivoire, Gabon, Morocco, Togo |
| mednautilus-submarine-system | MedNautilus Submarine System | 2001 | 7,000 km | Cyprus, Greece, Israel, Italy, Turkey |
| global-caribbean-network-gcn | Global Caribbean Network (GCN) | 2006 | 890 km | Guadeloupe, Saint Barthélemy, Saint Martin, United States, Virgin Islands (U.S.) |
| flag-north-asia-loopreach-north-asia-loop | FLAG North Asia Loop/REACH North Asia Loop | 2001 | 9,504 km | China, Japan, South Korea, Taiwan |
| south-pacific-cable-system-spcsmistral | South Pacific Cable System (SPCS)/Mistral | 2021 | 7,300 km | Chile, Ecuador, Guatemala, Peru |
| tata-tgn-intra-asia-tgn-ia | Tata TGN-Intra Asia (TGN-IA) | 2009 | 6,700 km | China, Philippines, Singapore, Vietnam |
| sea-h2x | SEA-H2X | 2026 | 5,746 km | China, Philippines, Singapore, Thailand |
| manatua | Manatua | 2020 | 3,634 km | Cook Islands, French Polynesia, Niue, Samoa |
| meltingpot-indianoceanic-submarine-system-metiss | Meltingpot Indianoceanic Submarine System (METISS) | 2021 | 3,200 km | Madagascar, Mauritius, Réunion, South Africa |
| deep-blue-one | Deep Blue One | 2024 | 2,250 km | French Guiana, Guyana, Suriname, Trinidad and Tobago |
| saba-statia-cable-system-sscs | Saba, Statia Cable System (SSCS) | 2013 | 198 km | Bonaire, Sint Eustatius and Saba, Saint Barthélemy, Saint Kitts and Nevis, Sint Maarten |
| tata-tgn-pacific | Tata TGN-Pacific | 2002 | 22,300 km | Guam, Japan, United States |
| glo-1 | Glo-1 | 2010 | 9,800 km | Ghana, Nigeria, United Kingdom |
| pipe-pacific-cable-1-ppc-1 | PIPE Pacific Cable-1 (PPC-1) | 2009 | 6,900 km | Australia, Guam, Papua New Guinea |
| coral-sea-cable-system-cs | Coral Sea Cable System (CS²) | 2020 | 4,700 km | Australia, Papua New Guinea, Solomon Islands |
| exa-express | EXA Express | 2015 | 4,600 km | Canada, Ireland, United Kingdom |
| hawk | Hawk | 2011 | 3,400 km | Cyprus, Egypt, France |
| hantru1-cable-system | HANTRU1 Cable System | 2010 | 2,917 km | Guam, Marshall Islands, Micronesia |
| colombia-florida-express-cfx-1 | Colombia-Florida Express (CFX-1) | 2008 | 2,438 km | Colombia, Jamaica, United States |
| maya-1-2 | Maya-1.2 | 2026 | 2,386 km | Cayman Islands, Honduras, United States |
| east-micronesia-cable-system-emcs | East Micronesia Cable System (EMCS) | 2026 | 2,250 km | Kiribati, Micronesia, Nauru |
| tannat | Tannat | 2018 | 2,000 km | Argentina, Brazil, Uruguay |
| alba-1 | ALBA-1 | 2012 | 1,860 km | Cuba, Jamaica, Venezuela |
| east-west-cable-ewc | East-West Cable (EWC) | 2011 | 1,705 km | Dominican Republic, Jamaica, Virgin Islands (U.K.) |
| tui-samoa | Tui-Samoa | 2018 | 1,693 km | Fiji, Samoa, Wallis and Futuna |
| medloop | Medloop | 2023 | 1,360 km | France, Italy, Spain |
| malaysia-cambodia-thailand-mct-cable | Malaysia-Cambodia-Thailand (MCT) Cable | 2017 | 1,300 km | Cambodia, Malaysia, Thailand |
| transworld-tw1 | Transworld (TW1) | 2006 | 1,300 km | Oman, Pakistan, United Arab Emirates |
| suriname-guyana-submarine-cable-system-sg-scs | Suriname-Guyana Submarine Cable System (SG-SCS) | 2010 | 1,249 km | Guyana, Suriname, Trinidad and Tobago |
| fibralink | Fibralink | 2006 | 1,102 km | Dominican Republic, Haiti, Jamaica |
| baltic-sea-submarine-cable | Baltic Sea Submarine Cable | 2000 | 1,042 km | Estonia, Finland, Sweden |
| thailand-indonesia-singapore-tis | Thailand-Indonesia-Singapore (TIS) | 2003 | 968 km | Indonesia, Singapore, Thailand |
| kafos | KAFOS | 1997 | 538 km | Bulgaria, Romania, Turkey |
| globalconnect-aurora | GlobalConnect Aurora | 2024 | 500 km | Denmark, Germany, Sweden |
| adria-1 | Adria-1 | 1996 | 440 km | Albania, Croatia, Greece |
| high-capacity-undersea-guernsey-optical-fibre-hugo | High-capacity Undersea Guernsey Optical-fibre (HUGO) | 2007 | 425 km | France, Guernsey, United Kingdom |
| sint-maarten-puerto-rico-network-one-smpr-1 | Sint Maarten Puerto Rico Network One (SMPR-1) | 2004 | 375 km | Saint Martin, Sint Maarten, United States |
| havhingstenceltixconnect-2-cc-2 | Havhingsten/CeltixConnect-2 (CC-2) | 2022 | 301 km | Ireland, Isle of Man, United Kingdom |
| seax-1 | SEAX-1 | 2018 | 250 km | Indonesia, Malaysia, Singapore |
| ingrid | INGRID | 2004 | 64 km | France, Guernsey, Jersey |
| juno | JUNO | 2025 | 11,710 km | Japan, United States |
| telstra-endeavour | Telstra Endeavour | 2008 | 9,125 km | Australia, United States |
| mid-atlantic-crossing-mac | Mid-Atlantic Crossing (MAC) | 2000 | 7,500 km | United States, Virgin Islands (U.S.) |
| anjana | Anjana | 2026 | 7,121 km | Spain, United States |
| yellow | Yellow | 2000 | 7,001 km | United Kingdom, United States |
| aec-1 | AEC-1 | 2016 | 5,521 km | Ireland, United States |
| indonesia-global-gateway-igg-system | Indonesia Global Gateway (IGG) System | 2018 | 5,300 km | Indonesia, Singapore |
| honotua | Honotua | 2010 | 4,805 km | French Polynesia, United States |
| guam-okinawa-kyushu-incheon-goki | Guam Okinawa Kyushu Incheon (GOKI) | 2013 | 4,244 km | Guam, Japan |
| i2i-cable-network-i2icn | i2i Cable Network (i2icn) | 2002 | 3,200 km | India, Singapore |
| t3 | T3 | 2023 | 3,200 km | Mauritius, South Africa |
| tata-tgn-tata-indicom | Tata TGN-Tata Indicom | 2004 | 3,175 km | India, Singapore |
| bahamas-domestic-submarine-network-bdsni | Bahamas Domestic Submarine Network (BDSNi) | 2006 | 2,735 km | Bahamas, Haiti |
| lower-indian-ocean-network-2-lion2 | Lower Indian Ocean Network 2 (LION2) | 2012 | 2,700 km | Kenya, Mayotte |
| japan-guam-australia-north-jga-n | Japan-Guam-Australia North (JGA-N) | 2020 | 2,600 km | Guam, Japan |
| arimao | ARIMAO | 2023 | 2,470 km | Cuba, Martinique |
| jonah | Jonah | 2012 | 2,297 km | Israel, Italy |
| tasman-global-access-tga-cable | Tasman Global Access (TGA) Cable | 2017 | 2,288 km | Australia, New Zealand |
| umo | UMO | 2023 | 2,227 km | Myanmar, Singapore |
| gondwana-1 | Gondwana-1 | 2008 | 2,151 km | Australia, New Caledonia |
| seychelles-to-east-africa-system-seas | Seychelles to East Africa System (SEAS) | 2012 | 1,930 km | Seychelles, Tanzania |
| canalink | Canalink | 2011 | 1,835 km | Morocco, Spain |
| russia-japan-cable-network-rjcn | Russia-Japan Cable Network (RJCN) | 2008 | 1,800 km | Japan, Russia |
| iris | IRIS | 2023 | 1,770 km | Iceland, Ireland |
| tampnet-south | Tampnet South | 1999 | 1,751 km | Norway, United Kingdom |
| tampnet-north | Tampnet North | 1999 | 1,751 km | Norway, United Kingdom |
| kanawa | Kanawa | 2019 | 1,746 km | French Guiana, Martinique |
| caribbean-bermuda-u-s-cbus | Caribbean-Bermuda U.S. (CBUS) | 2009 | 1,700 km | Bermuda, Virgin Islands (U.K.) |
| atlas-offshore | Atlas Offshore | 2007 | 1,634 km | France, Morocco |
| gtmo-1 | GTMO-1 | 2016 | 1,528 km | Cuba, United States |
| gondwana-2picot-2 | Gondwana-2/Picot-2 | 2022 | 1,515 km | Fiji, New Caledonia |
| gemini-bermuda | Gemini Bermuda | 2007 | 1,501 km | Bermuda, United States |
| gulf2africa-g2a | Gulf2Africa (G2A) | 2017 | 1,500 km | Oman, Somalia |
| gtmo-pr | GTMO-PR | 2019 | 1,400 km | Cuba, United States |
| panam-south | PanAm South | 1999 | 1,340 km | Ecuador, Panama |
| jakabare | JAKABARE | 2009 | 1,330 km | Indonesia, Singapore |
| med-cable-network | Med Cable Network | 2005 | 1,300 km | Algeria, France |
| interchange-cable-network-1-icn1 | Interchange Cable Network 1 (ICN1) | 2014 | 1,259 km | Fiji, Vanuatu |
| caucasus-cable-system | Caucasus Cable System | 2008 | 1,200 km | Bulgaria, Georgia |
| cayman-jamaica-fiber-system-cjfs | Cayman-Jamaica Fiber System (CJFS) | 1997 | 1,197 km | Cayman Islands, Jamaica |
| rising-8 | RISING 8 | 2026 | 1,104 km | Indonesia, Singapore |
| bahamas-internet-cable-system-bics | Bahamas Internet Cable System (BICS) | 2001 | 1,100 km | Bahamas, United States |
| nigeria-cameroon-submarine-cable-system-ncscs | Nigeria Cameroon Submarine Cable System (NCSCS) | 2015 | 1,100 km | Cameroon, Nigeria |
| ec-link | EC Link | 2007 | 1,078 km | Curaçao, Trinidad and Tobago |
| matrix-cable-system | Matrix Cable System | 2008 | 1,055 km | Indonesia, Singapore |
| jakarta-bangka-bintan-batam-singapore-b3js | Jakarta-Bangka-Bintan-Batam-Singapore (B3JS) | 2012 | 1,031 km | Indonesia, Singapore |
| east-west-submarine-cable-system | East-West Submarine Cable System | 2004 | 950 km | Indonesia, Malaysia |
| maldives-sri-lanka-cable-msc | Maldives Sri Lanka Cable (MSC) | 2021 | 863 km | Maldives, Sri Lanka |
| dhiraagu-slt-submarine-cable-network | Dhiraagu-SLT Submarine Cable Network | 2007 | 850 km | Maldives, Sri Lanka |
| tonga-cable | Tonga Cable | 2013 | 827 km | Fiji, Tonga |
| aletar | Aletar | 1997 | 787 km | Egypt, Syria |
| x-link-submarine-cable | X-Link Submarine Cable | 2019 | 775 km | Barbados, Guyana |
| oran-valencia-orval | Oran-Valencia (ORVAL) | 2020 | 770 km | Algeria, Spain |
| batam-sarawak-internet-cable-system-basics | Batam Sarawak Internet Cable System (BaSICS) | 2021 | 762 km | Indonesia, Malaysia |
| jakarta-bangka-batam-singapore-b2js | Jakarta-Bangka-Batam-Singapore (B2JS) | 2013 | 759 km | Indonesia, Singapore |
| norfest | Norfest | 2023 | 749 km | Norway, Sweden |
| senegal-horn-of-africa-regional-express-share-cable | Senegal Horn of Africa Regional Express (SHARE) Cable | 2023 | 720 km | Cape Verde, Senegal |
| oteglobe-kokkini-bari | OTEGLOBE Kokkini-Bari | 2004 | 700 km | Greece, Italy |
| antillas-1 | Antillas 1 | 1997 | 601 km | Dominican Republic, United States |
| hokkaido-sakhalin-cable-system-hscs | Hokkaido-Sakhalin Cable System (HSCS) | 2008 | 570 km | Japan, Russia |
| italy-libya | Italy-Libya | 1998 | 570 km | Italy, Libya |
| sto-hel-one | STO-HEL-One | 2008 | 560 km | Finland, Sweden |
| concerto | Concerto | 1999 | 550 km | Netherlands, United Kingdom |
| bcs-north---phase-1 | BCS North - Phase 1 | 1998 | 513 km | Finland, Sweden |
| korea-japan-cable-network-kjcn | Korea-Japan Cable Network (KJCN) | 2002 | 500 km | Japan, South Korea |
| pan-european-crossing-uk-ireland | Pan European Crossing (UK-Ireland) | 2000 | 495 km | Ireland, United Kingdom |
| bahamas-2 | Bahamas 2 | 1997 | 476 km | Bahamas, United States |
| georgia-russia | Georgia-Russia | 2000 | 433 km | Georgia, Russia |
| silphium | Silphium | 2013 | 425 km | Greece, Libya |
| fly-lion3 | FLY-LION3 | 2019 | 400 km | Comoros, Mayotte |
| nordbalt | NordBalt | 2016 | 400 km | Lithuania, Sweden |
| pishgaman-oman-iran-poi-network | Pishgaman Oman Iran (POI) Network | 2012 | 400 km | Iran, Oman |
| sweden-latvia | Sweden-Latvia | 2005 | 391 km | Latvia, Sweden |
| batam-dumai-melaka-bdm | Batam Dumai Melaka (BDM) | 2009 | 353 km | Indonesia, Malaysia |
| exelera-north | Exelera North | 2012 | 345 km | Cyprus, Israel |
| saudi-arabia-sudan-1-sas-1 | Saudi Arabia-Sudan-1 (SAS-1) | 2003 | 333 km | Saudi Arabia, Sudan |
| saudi-arabia-sudan-2-sas-2 | Saudi Arabia-Sudan-2 (SAS-2) | 2011 | 330 km | Saudi Arabia, Sudan |
| bharat-lanka-cable-system | Bharat Lanka Cable System | 2006 | 325 km | India, Sri Lanka |
| ionian | Ionian | 2023 | 320 km | Greece, Italy |
| cobracable | COBRAcable | 2019 | 304 km | Denmark, Netherlands |
| latvia-sweden-1-lv-se-1 | Latvia-Sweden 1 (LV-SE 1) | 1994 | 304 km | Latvia, Sweden |
| ceiba-2 | Ceiba-2 | 2017 | 290 km | Cameroon, Equatorial Guinea |
| go-1-mediterranean-cable-system | GO-1 Mediterranean Cable System | 2008 | 290 km | Italy, Malta |
| bcs-north---phase-2 | BCS North - Phase 2 | 2000 | 280 km | Finland, Russia |
| atisa | Atisa | 2017 | 279 km | Guam, Northern Mariana Islands |
| aden-djibouti | Aden-Djibouti | 1994 | 269 km | Djibouti, Yemen |
| mariana-guam-cable | Mariana-Guam Cable | 1997 | 268 km | Guam, Northern Mariana Islands |
| unisur | Unisur | 1995 | 265 km | Argentina, Uruguay |
| pgascom | PGASCOM | 2010 | 264 km | Indonesia, Singapore |
| ultramar-ge | Ultramar GE | 2023 | 263 km | Equatorial Guinea, Sao Tome and Principe |
| avassa | Avassa | 2016 | 260 km | Comoros, Mayotte |
| epic-malta-sicily-cable-system-emscs | Epic Malta-Sicily Cable System (EMSCS) | 2004 | 260 km | Italy, Malta |
| taiwan-strait-express-1-tse-1 | Taiwan Strait Express-1 (TSE-1) | 2013 | 260 km | China, Taiwan |
| bicentenario | Bicentenario | 2011 | 250 km | Argentina, Uruguay |
| samoa-american-samoa-sas | Samoa-American Samoa (SAS) | 2009 | 250 km | American Samoa, Samoa |
| esat-2 | ESAT-2 | 2000 | 245 km | Ireland, United Kingdom |
| italy-albania | Italy-Albania | 1997 | 240 km | Albania, Italy |
| sweden-estonia-ee-s-1 | Sweden-Estonia (EE-S 1) | 1995 | 240 km | Estonia, Sweden |
| ugarit | UGARIT | 1995 | 239 km | Cyprus, Syria |
| italy-malta | Italy-Malta | 1994 | 238 km | Italy, Malta |
| uk-channel-islands-8 | UK-Channel Islands-8 | 1994 | 237 km | Jersey, United Kingdom |
| solas | Solas | 1999 | 232 km | Ireland, United Kingdom |
| cadmos | CADMOS | 1995 | 230 km | Cyprus, Lebanon |
| italy-croatia | Italy-Croatia | 1994 | 230 km | Croatia, Italy |
| caribbean-regional-communications-infrastructure-program-carcip | Caribbean Regional Communications Infrastructure Program (CARCIP) | 2019 | 225 km | Grenada, Saint Vincent and the Grenadines |
| rockabill | Rockabill | 2019 | 221 km | Ireland, United Kingdom |
| sirius-south | Sirius South | 1999 | 219 km | Ireland, United Kingdom |
| bcs-east-west-interlink | BCS East-West Interlink | 1997 | 218 km | Lithuania, Sweden |
| americas-ii-west | Americas-II West | 2000 | 217 km | United States, Virgin Islands (U.S.) |
| turcyos-2 | Turcyos-2 | 2011 | 213 km | Cyprus, Turkey |
| scylla | Scylla | 2021 | 204 km | Netherlands, United Kingdom |
| circe-north | Circe North | 1999 | 203 km | Netherlands, United Kingdom |
| st-pierre-and-miquelon-cable | St. Pierre and Miquelon Cable | 2018 | 200 km | Canada, Saint Pierre and Miquelon |
| ulysses-2 | Ulysses 2 | 1997 | 199 km | Netherlands, United Kingdom |
| geo-eirgrid | Geo-Eirgrid | 2012 | 187 km | Ireland, United Kingdom |
| hannibal-system | HANNIBAL System | 2009 | 178 km | Italy, Tunisia |
| didon | Didon | 2014 | 170 km | Italy, Tunisia |
| skagenfiber-west | Skagenfiber West | 2020 | 170 km | Denmark, Norway |
| italy-greece-1-ig-1 | Italy-Greece 1 (IG-1) | 1995 | 169 km | Greece, Italy |
| ketchcan1-submarine-fiber-cable-system | KetchCan1 Submarine Fiber Cable System | 2020 | 167 km | Canada, United States |
| italy-monaco | Italy-Monaco | 1995 | 162 km | Italy, Monaco |
| dumai-melaka-cable-system-dmcs | Dumai-Melaka Cable System (DMCS) | 2005 | 159 km | Indonesia, Malaysia |
| farland-north | Farland North | 1998 | 150 km | Netherlands, United Kingdom |
| crosschannel-fibre | CrossChannel Fibre | 2021 | 149 km | France, United Kingdom |
| antigua-st-kitts | Antigua-St.Kitts | 1995 | 141 km | Antigua and Barbuda, Saint Kitts and Nevis |
| qe-south | Q&E South | 2026 | 141 km | France, United Kingdom |
| american-1 | AmeriCan-1 | 1999 | 140 km | Canada, United States |
| skagerrak-4 | Skagerrak 4 | 2014 | 137 km | Denmark, Norway |
| berytar | BERYTAR | 1997 | 134 km | Lebanon, Syria |
| celtixconnect-1-cc-1 | CeltixConnect-1 (CC-1) | 2012 | 131 km | Ireland, United Kingdom |
| uk-channel-islands-7 | UK-Channel Islands-7 | 1994 | 124 km | Guernsey, United Kingdom |
| alonso-de-ojeda | Alonso de Ojeda | 1999 | 122 km | Aruba, Curaçao |
| emerald-bridge-fibres | Emerald Bridge Fibres | 2012 | 120 km | Ireland, United Kingdom |
| havsil | Havsil | 2022 | 120 km | Denmark, Norway |
| pan-european-crossing-uk-belgium | Pan European Crossing (UK-Belgium) | 1999 | 117 km | Belgium, United Kingdom |
| circe-south | Circe South | 1999 | 115 km | France, United Kingdom |
| est-tet | Est-Tet | 1994 | 113 km | Morocco, Spain |
| lanis-1 | Lanis-1 | 1992 | 113 km | Isle of Man, United Kingdom |
| qe-north | Q&E North | 2025 | 112 km | Belgium, United Kingdom |
| tangerine | Tangerine | 2000 | 112 km | Belgium, United Kingdom |
| turcyos-1 | Turcyos-1 | 1993 | 110 km | Cyprus, Turkey |
| trans-adriatic-express-tae | Trans Adriatic Express (TAE) | 2023 | 106 km | Albania, Italy |
| finland-estonia-3-eesf-3 | Finland-Estonia 3 (EESF-3) | 1994 | 104 km | Estonia, Finland |
| qatar-u-a-e-submarine-cable-system | Qatar-U.A.E. Submarine Cable System | 2004 | 100 km | Qatar, United Arab Emirates |
| finland-estonia-2-eesf-2 | Finland-Estonia 2 (EESF-2) | 1992 | 98 km | Estonia, Finland |
| bcs-east | BCS East | 1995 | 97 km | Latvia, Lithuania |
| melita-1 | Melita 1 | 2009 | 97 km | Italy, Malta |
| globalconnect-2-gc2 | GlobalConnect 2 (GC2) | 2001 | 95 km | Denmark, Sweden |
| malta-italy-interconnector | Malta-Italy Interconnector | 2015 | 95 km | Italy, Malta |
| botnia | Botnia | 1994 | 93 km | Finland, Sweden |
| jerry-newton | Jerry Newton | 2007 | 88 km | Bonaire, Sint Eustatius and Saba, Curaçao |
| amerigo-vespucci | Amerigo Vespucci | 1999 | 87 km | Curaçao, Netherlands |
| bt-mt-1 | BT-MT-1 | 1990 | 80 km | Isle of Man, United Kingdom |
| kattegat-2 | Kattegat 2 | 2001 | 75 km | Denmark, Sweden |
| batam-singapore-cable-system-bscs | Batam Singapore Cable System (BSCS) | 2009 | 73 km | Indonesia, Singapore |
| moratelindo-international-cable-system-1-mic-1 | Moratelindo International Cable System-1 (MIC-1) | 2008 | 70 km | Indonesia, Singapore |
| lanis-2 | Lanis-2 | 1992 | 67 km | Isle of Man, United Kingdom |
| batam-rengit-cable-system-brcs | Batam-Rengit Cable System (BRCS) | 2007 | 64 km | Indonesia, Malaysia |
| crosslake-fibre | Crosslake Fibre | 2019 | 59 km | Canada, United States |
| manx-northern-ireland | Manx-Northern Ireland | 2000 | 59 km | Isle of Man, United Kingdom |
| labuan-brunei-submarine-cable | Labuan-Brunei Submarine Cable | 2017 | 52 km | Brunei, Malaysia |
| lake-albert-1 | Lake Albert 1 | 2019 | 51 km | Congo, Dem. Rep., Uganda |
| kerch-strait-cable | Kerch Strait Cable | 2014 | 46 km | Russia, Ukraine |
| elektra-globalconnect-1-gc1 | Elektra-GlobalConnect 1 (GC1) | 2000 | 44 km | Denmark, Germany |
| lake-albert-2 | Lake Albert 2 | 2020 | 44 km | Congo, Dem. Rep., Uganda |
| globalconnect-kpn | GlobalConnect-KPN | 2006 | 43 km | Denmark, Germany |
| guernsey-jersey-4 | Guernsey-Jersey-4 | 1994 | 36 km | Guernsey, Jersey |
| danica-north | Danica North | 1998 | 25 km | Denmark, Sweden |
| cross-straits-cable-network-cscn | Cross-Straits Cable Network (CSCN) | 2012 | 21 km | China, Taiwan |
| scandinavian-ring-south | Scandinavian Ring South | 2000 | 21 km | Denmark, Sweden |
| fehmarn-blt | Fehmarn Bält | 2000 | 20 km | Denmark, Germany |
| energy-bridge-cable | Energy Bridge Cable | 2017 | 13 km | Russia, Ukraine |
| taba-aqaba | Taba-Aqaba | 1998 | 13 km | Egypt, Jordan |
| denmark-sweden-17 | Denmark-Sweden 17 | 1994 | 11 km | Denmark, Sweden |
| scandinavian-ring-north | Scandinavian Ring North | 2000 | 5 km | Denmark, Sweden |
| channel-islands-9-liberty-submarine-cable | Channel Islands-9 Liberty Submarine Cable | 2008 |  | Guernsey, United Kingdom |
| coral-bridge | Coral Bridge | 2025 |  | Egypt, Jordan |
| denmark-sweden-18 | Denmark-Sweden 18 | 1996 |  | Denmark, Sweden |
| e-llan | E-LLAN | 2007 |  | Isle of Man, United Kingdom |
| e-finest | E-FINEST | 2019 |  | Estonia, Finland |
| eastern-light-sweden-finland-i | Eastern Light Sweden-Finland I | 2019 |  | Finland, Sweden |
| energinet-laeso-varberg | Energinet Laeso-Varberg | 2011 |  | Denmark, Sweden |
| finland-estonia-connection-1-fec-1 | Finland Estonia Connection 1 (FEC-1) | 2000 |  | Estonia, Finland |
| finland-estonia-connection-2-fec-2 | Finland Estonia Connection 2 (FEC-2) | 2000 |  | Estonia, Finland |
| germany-denmark-3 | Germany-Denmark 3 | 2000 |  | Denmark, Germany |
| globalconnect-denmark-sweden | GlobalConnect Denmark-Sweden | 1994 |  | Denmark, Sweden |
| iceni | Iceni | 2024 |  | Netherlands, United Kingdom |
| mercator | Mercator | 2023 |  | Belgium, United Kingdom |
| sarco | SARCO | 2006 |  | France, Italy |
| zeus | Zeus | 2022 |  | Netherlands, United Kingdom |
