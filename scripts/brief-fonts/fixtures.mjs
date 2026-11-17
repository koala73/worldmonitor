// Sample briefs that exercise every part of the magazine layout: cover, digest pages, light and
// dark story pages, every threat level, the public share view and the share button. The `intl`
// brief carries the scripts and symbols news copy can contain, so every subset file is used.
import { renderBriefMagazine } from '../../server/_shared/brief-render.js';
import { BRIEF_ENVELOPE_VERSION, BRIEF_LOCALIZED_ENVELOPE_VERSION } from '../../shared/brief-envelope.js';

const PROBE = '† ‡ non‑breaking ‐ hyphen ‒ figure ― bar 10\u2009000 thin, 5\u202F% narrow, zero\u200Bwidth, fig\u2007ure, soft\u00ADhyphen, word\u2060joiner, 5′ 6″, 1⁄2, ‹a› «b», • ‰ ℓ № € ₹ ₿ ₺ ₴ ₦ ₩ ₪ ₫ ¤ ¢ £ ¥ § ¶ © ® ™ ° ± × ÷ µ ‐‑‒–—―';
const longText = (sentence, count) => Array.from({ length: count }, () => sentence).join(' ');

function story(overrides = {}) {
  return {
    category: 'Energy',
    country: 'IR',
    threatLevel: 'high',
    headline: 'Iran keeps the Strait of Hormuz open while insurers reprice Gulf transit risk.',
    description: 'Tehran signalled that commercial shipping can keep moving through Hormuz, but tanker premiums remain elevated.',
    source: 'Multiple wires',
    sourceUrl: 'https://example.com/hormuz-open',
    clusterId: 'cluster-energy-hormuz-001',
    whyMatters: 'Hormuz carries roughly a fifth of global seaborne oil, so a stability signal can move energy prices faster than diplomatic statements.',
    ...overrides,
  };
}

function envelope(stories, digest = {}) {
  return {
    version: BRIEF_ENVELOPE_VERSION,
    issuedAt: 1_700_000_000_000,
    data: {
      user: { name: 'Elie', tz: 'UTC' },
      issue: '27.05',
      date: '2026-05-27',
      dateLong: '27 May 2026',
      digest: {
        greeting: 'Good evening.',
        lead: longText('The most important development today is not a single flashpoint but a widening pressure band across shipping, energy, and infrastructure risk.', 2),
        numbers: { clusters: 278, multiSource: 21, surfaced: stories.length },
        threads: [
          { tag: 'Energy', teaser: 'Shipping, insurance, and refinery margin signals are moving together.' },
          { tag: 'Cyber', teaser: 'Infrastructure operators are tightening access controls after fresh intrusion reports.' },
          { tag: 'Maritime', teaser: 'Port congestion and war-risk pricing are becoming the same operating story.' },
        ],
        signals: [
          'Whether war-risk premiums fall faster than freight backlogs clear.',
          'Whether operators report fresh disruptions in the next 24 hours.',
        ],
        ...digest,
      },
      stories,
    },
  };
}

const english = envelope([
  story({ threatLevel: 'critical', category: 'Security', country: 'US / CA' }),
  story({ category: 'Diplomacy', country: 'IL / LB', threatLevel: 'medium', clusterId: 'c2' }),
  story({ category: 'Markets', country: 'US', threatLevel: 'low', clusterId: 'c3' }),
]);

const international = envelope([
  story({
    headline: 'Zelenskyy meets Erdoğan in Kraków as Łódź and Gdańsk brace — “no retreat”',
    description: 'Ministers in Bucureşti, Plzeň and Győr said the €4.2 bn package (±3%) covers 1½ years; Düsseldorf’s Société Générale desk called it “très sérieux”… Ørsted, Æon and Ålesund notes followed.',
    source: 'Reuters · Agence France‑Presse',
    clusterId: 'i1',
  }),
  story({
    headline: 'Đà Nẵng and Hải Phòng ports reopen after typhoon',
    description: 'Vietnamese officials in Thừa Thiên Huế said cargo resumed; Москва and Київ issued statements, while Αθήνα monitored Θεσσαλονίκη.',
    category: 'Maritime', country: 'VN', threatLevel: 'medium', clusterId: 'i2',
    whyMatters: 'Temperatures hit 38°C × 3 days; 2,000 km² affected — ™, ®, ©, ‰ and № markers appear in wire copy.',
  }),
  story({
    headline: 'Новые санкции: Россия и Україна',
    description: 'Ελληνικά κείμενα και кириллица в одном абзаце; Ѣ, Ґ, Ӂ and Ա-free extended Cyrillic: Ҕ Ӑ.',
    category: 'Diplomacy', country: 'RU / UA', threatLevel: 'high', clusterId: 'i3', source: 'ТАСС / Καθημερινή',
  }),
  // Punctuation, spaces and symbols that sit in a font's unicode-range without a glyph, or in two files' ranges.
  story({ headline: PROBE, description: PROBE, whyMatters: PROBE, source: PROBE, category: 'Cyber', country: 'FR', threatLevel: 'low', clusterId: 'i4' }),
], {
  greeting: 'Bonsoir — guten Abend.',
  signals: ['Whether São Paulo’s €-denominated bonds rally ≥ 2%.', 'Whether İstanbul and Ağrı report new tremors.'],
});

// Localized (v5) briefs: one per language whose locl forms or diacritics the subsets must cover.
// Category tags are uppercased by the CSS, so Turkish i/ı/İ and Greek tonos go through text-transform.
const LOCALIZED = {
  fr: { greeting: 'Bonsoir.', category: 'Énergie', headline: 'L’Iran maintient le détroit d’Ormuz ouvert pendant que les assureurs réévaluent le risque.', description: 'Téhéran a indiqué que les navires marchands peuvent continuer à transiter ; les primes des pétroliers restent élevées à Château-Gontier et à Besançon.', whyMatters: 'Ormuz achemine près d’un cinquième du pétrole maritime mondial : œuvre, cœur, déjà, naïf, Noël.' },
  de: { greeting: 'Guten Abend.', category: 'Außenpolitik', headline: 'Iran hält die Straße von Hormus offen, während Versicherer das Risiko neu bewerten.', description: 'Teheran signalisierte, dass Handelsschiffe weiterfahren dürfen; die Prämien für Öltanker bleiben in Düsseldorf und Lübeck hoch.', whyMatters: 'Über Hormus läuft etwa ein Fünftel des weltweiten Seeöls – größere Schwankungen sind möglich, Grüße aus Göttingen.' },
  es: { greeting: 'Buenas noches.', category: 'Energía', headline: 'Irán mantiene abierto el estrecho de Ormuz mientras las aseguradoras recalculan el riesgo.', description: '¿Podrán seguir navegando los petroleros? Teherán señaló que sí; las primas siguen altas en Cádiz y A Coruña.', whyMatters: 'Por Ormuz pasa cerca de una quinta parte del petróleo marítimo mundial: año, niño, pingüino.' },
  pl: { greeting: 'Dobry wieczór.', category: 'Bezpieczeństwo', headline: 'Iran utrzymuje otwartą cieśninę Ormuz, a ubezpieczyciele ponownie wyceniają ryzyko.', description: 'Teheran zasygnalizował, że statki handlowe mogą płynąć dalej; składki dla tankowców w Gdańsku i Łodzi pozostają wysokie.', whyMatters: 'Przez Ormuz płynie około jednej piątej światowej ropy morskiej — źródło, żółć, gęślą jaźń.' },
  cs: { greeting: 'Dobrý večer.', category: 'Diplomacie', headline: 'Írán ponechává Hormuzský průliv otevřený, pojišťovny přeceňují riziko.', description: 'Teherán naznačil, že obchodní lodě mohou dál proplouvat; pojistné tankerů v Plzni a Českých Budějovicích zůstává vysoké.', whyMatters: 'Hormuzem proudí asi pětina světové námořní ropy: příliš žluťoučký kůň úpěl ďábelské ódy.' },
  hu: { greeting: 'Jó estét.', category: 'Gazdaság', headline: 'Irán nyitva tartja a Hormuzi-szorost, a biztosítók újraárazzák a kockázatot.', description: 'Teherán jelezte, hogy a kereskedelmi hajók továbbhaladhatnak; a tartályhajók díjai Győrben és Szőnyben magasak maradnak.', whyMatters: 'A Hormuzi-szoroson halad át a tengeri olaj ötöde: árvíztűrő tükörfúrógép.' },
  ro: { greeting: 'Bună seara.', category: 'Securitate', headline: 'Iranul menține deschisă strâmtoarea Ormuz, iar asigurătorii reevaluează riscul.', description: 'Teheranul a semnalat că navele comerciale își pot continua drumul; primele pentru petroliere rămân ridicate la Constanța și Brașov.', whyMatters: 'Prin Ormuz trece aproximativ o cincime din petrolul maritim: ștrengar, țară, înșiși, mâine, așa.' },
  tr: { greeting: 'İyi akşamlar.', category: 'İstihbarat ılımlı', headline: 'İran Hürmüz Boğazı’nı açık tutarken sigortacılar riski yeniden fiyatlıyor.', description: 'Tahran ticari gemilerin geçişe devam edebileceğini belirtti; tanker primleri İstanbul ve Iğdır’da yüksek seyrediyor.', whyMatters: 'Hürmüz, dünya deniz yoluyla taşınan petrolün yaklaşık beşte birini taşır: ılık, ışık, İzmir, iğne.' },
  vi: { greeting: 'Chào buổi tối.', category: 'Năng lượng', headline: 'Iran giữ eo biển Hormuz thông thoáng trong khi các hãng bảo hiểm định giá lại rủi ro.', description: 'Tehran cho biết tàu thương mại có thể tiếp tục di chuyển; phí bảo hiểm tàu chở dầu tại Hải Phòng và Đà Nẵng vẫn ở mức cao.', whyMatters: 'Khoảng một phần năm lượng dầu vận chuyển bằng đường biển đi qua Hormuz: Thừa Thiên Huế, Quảng Ngãi.' },
  ru: { greeting: 'Добрый вечер.', category: 'Энергетика', headline: 'Иран сохраняет Ормузский пролив открытым, страховщики пересматривают риски.', description: 'Тегеран дал понять, что торговые суда могут продолжать движение; ставки для танкеров в Новороссийске остаются высокими.', whyMatters: 'Через Ормуз проходит около пятой части мировой морской нефти: съешь же ещё этих мягких французских булок.' },
  uk: { greeting: 'Добрий вечір.', category: 'Безпека', headline: 'Іран тримає Ормузьку протоку відкритою, страховики переоцінюють ризики.', description: 'Тегеран дав зрозуміти, що торговельні судна можуть рухатися далі; ставки для танкерів в Одесі та Ізмаїлі лишаються високими.', whyMatters: 'Через Ормуз проходить близько п’ятої частини світової морської нафти: ґанок, їжак, єнот, Київ.' },
  bg: { greeting: 'Добър вечер.', category: 'Дипломация', headline: 'Иран държи Ормузкия проток отворен, докато застрахователите преоценяват риска.', description: 'Техеран сигнализира, че търговските кораби могат да продължат; вдигнати ставки, гвоздей, жълтица, змей, йод, кит, лъжица, пчела, тиква, цвят, шапка, щъркел, юнак.', whyMatters: 'През Ормуз минава около една пета от световния морски петрол: вгджзийклптцшщю във всички форми.' },
  el: { greeting: 'Καλησπέρα.', category: 'Ενέργεια', headline: 'Το Ιράν κρατά ανοιχτά τα Στενά του Ορμούζ ενώ οι ασφαλιστές επανεκτιμούν τον κίνδυνο.', description: 'Η Τεχεράνη έδειξε ότι τα εμπορικά πλοία μπορούν να συνεχίσουν· τα ασφάλιστρα για δεξαμενόπλοια στον Πειραιά παραμένουν υψηλά.', whyMatters: 'Από το Ορμούζ περνά περίπου το ένα πέμπτο του θαλάσσιου πετρελαίου: άέήίόύώ ϊϋΐΰ Ξεσκεπάζω την ψυχοφθόρα βδελυγμία.' },
};

// Right-to-left briefs: their Arabic-script text falls to system fonts, so the layout pass sees dir="rtl" pages
// without asking the subsets to cover Arabic. Latin and numeric fragments stay on the brief faces.
const RTL_LOCALIZED = {
  ar: { greeting: 'مساء الخير.', category: 'الطاقة', headline: 'إيران تبقي مضيق هرمز مفتوحًا بينما تعيد شركات التأمين تسعير المخاطر.', description: 'قالت طهران إن الشحن التجاري يمكنه مواصلة العبور، لكن أقساط ناقلات النفط ما زالت مرتفعة (Reuters, AP).', whyMatters: 'يمر عبر هرمز نحو خُمس النفط المنقول بحرًا، لذا قد يحرك أي إشارة استقرار أسعار الطاقة.' },
  fa: { greeting: 'عصر بخیر.', category: 'انرژی', headline: 'ایران تنگه هرمز را باز نگه می‌دارد و بیمه‌گران ریسک را دوباره قیمت‌گذاری می‌کنند.', description: 'تهران اعلام کرد کشتیرانی تجاری می‌تواند ادامه یابد، اما حق بیمه نفتکش‌ها همچنان بالاست (Reuters, AP).', whyMatters: 'حدود یک‌پنجم نفت دریایی جهان از هرمز می‌گذرد؛ نشانه ثبات می‌تواند قیمت انرژی را جابه‌جا کند.' },
};

const localized = Object.entries({ ...LOCALIZED, ...RTL_LOCALIZED }).map(([lang, t]) => {
  const base = envelope([
    story({ category: t.category, headline: t.headline, description: t.description, whyMatters: t.whyMatters, threatLevel: 'critical', clusterId: `${lang}-1` }),
    story({ category: t.category, headline: t.description, description: t.whyMatters, whyMatters: t.headline, threatLevel: 'medium', clusterId: `${lang}-2` }),
  ], {
    greeting: t.greeting,
    lead: `${t.headline} ${t.description}`,
    threads: [{ tag: t.category, teaser: t.description }],
    signals: [t.whyMatters],
  });
  return { name: `localized-${lang}`, html: renderBriefMagazine({ ...base, version: BRIEF_LOCALIZED_ENVELOPE_VERSION, lang }) };
});

export function briefFontFixtures() {
  return [
    { name: 'english', html: renderBriefMagazine(english) },
    { name: 'international', html: renderBriefMagazine(international) },
    { name: 'public', html: renderBriefMagazine(english, { publicMode: true, refCode: 'ABC123' }) },
    { name: 'share', html: renderBriefMagazine(english, { shareUrl: 'https://www.worldmonitor.app/api/brief/public/abc', followedCountries: ['IR', 'US'] }) },
    ...localized,
  ];
}
