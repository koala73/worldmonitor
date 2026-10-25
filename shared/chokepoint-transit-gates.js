// Gate areas for counting chokepoint transits from AIS positions.
//
// A transit is a vessel seen in a gate on one side of the narrows and later in
// a gate on the other side. Each side's circles span the shipping lanes and
// keep clear of the nearby ports and anchorages, so port calls, anchorage
// moves and ferries that stay on one side are not counted. The earlier counter
// recorded any vessel leaving a single wide circle: the Hormuz circle (radius
// 2 degrees) took in Dubai, Fujairah and Bandar Abbas and published 38
// "transits" on 2026-10-22, when IMF PortWatch and independent AIS counts
// showed about 4.
//
// Circles are [lat, lon, radiusDegrees]. Keys are the relay's chokepoint names.
export const CHOKEPOINT_TRANSIT_GATES = Object.freeze({
  // Persian Gulf side west of the Quoin islands; Gulf of Oman side east of
  // Musandam. Larak, Bandar Abbas, Khasab, Dibba and Fujairah lie outside both.
  'Strait of Hormuz': { a: [[26.45, 55.95, 0.25]], b: [[26.2, 56.85, 0.3]] },
  // The canal itself north of Ismailia and south of the Great Bitter Lake, so
  // ships waiting off Port Said, in the lakes or at Suez are not in a gate.
  'Suez Canal': { a: [[30.95, 32.31, 0.12]], b: [[30.15, 32.57, 0.12]] },
  // Red Sea side between Assab and Mocha; Gulf of Aden side east of Perim.
  'Bab el-Mandeb Strait': { a: [[13.0, 43.1, 0.25]], b: [[12.3, 43.75, 0.3]] },
  // Gatun Lake above the Gatun locks; Culebra Cut above Pedro Miguel. The
  // Colon and Balboa anchorages lie outside both.
  'Panama Canal': { a: [[9.22, -79.88, 0.07]], b: [[9.02, -79.62, 0.06]] },
  // North-west of Port Klang; south-east of Melaka.
  'Malacca Strait': { a: [[3.6, 100.6, 0.4]], b: [[1.55, 102.85, 0.3]] },
  // Between Pingtan and Hsinchu; between Xiamen and Penghu.
  'Taiwan Strait': { a: [[25.2, 120.3, 0.35]], b: [[23.9, 119.0, 0.35]] },
  // Off Cape Point; south of Cape Agulhas. Cape Town and Mossel Bay lie outside.
  'Cape of Good Hope': { a: [[-34.5, 17.8, 0.5]], b: [[-35.2, 20.5, 0.6]] },
  // Atlantic side west of Tarifa and Tangier; Mediterranean side east of
  // Gibraltar and Ceuta, so the Algeciras, Tangier and Ceuta ferries stay out.
  'Gibraltar Strait': { a: [[35.95, -6.15, 0.2]], b: [[36.0, -5.0, 0.2]] },
  // Black Sea entrance; the strait between Arnavutkoy and Cengelkoy, north of
  // the Kabatas-Uskudar ferry crossings.
  'Bosporus Strait': { a: [[41.2, 29.11, 0.05]], b: [[41.065, 29.05, 0.02]] },
  // Two channels either side of Tsushima: East China Sea approaches, then the
  // Sea of Japan approaches. Busan, Fukuoka and Shimonoseki lie outside.
  'Korea Strait': {
    a: [[34.2, 128.5, 0.35], [33.7, 129.5, 0.35]],
    b: [[35.0, 129.6, 0.3], [34.3, 130.3, 0.35]],
  },
  // The traffic separation scheme south-west of Dover; the North Sea side
  // north-east of Calais. The Dover-Calais ferries never reach the first gate.
  'Dover Strait': { a: [[50.82, 1.25, 0.2]], b: [[51.2, 1.75, 0.2]] },
  // Sea of Azov entrance; Black Sea entrance. Kerch and Kavkaz ports lie outside.
  'Kerch Strait': { a: [[45.45, 36.6, 0.06]], b: [[45.08, 36.45, 0.08]] },
  // North and south mouths; the Bali-Lombok ferry route passes between them.
  'Lombok Strait': { a: [[-8.35, 115.88, 0.12]], b: [[-9.0, 115.75, 0.15]] },
});
