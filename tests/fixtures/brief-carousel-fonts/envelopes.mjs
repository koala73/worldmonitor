// Carousel fixture briefs, one per script the carousel must draw.
// generate.mts subsets the committed fonts to exactly this text.

const BASE = {
  issuedAt: 1_780_000_000_000,
  data: {
    user: { name: 'Reader', tz: 'UTC' },
    issue: '27.05',
    date: '2026-05-27',
    digest: { lead: 'Lead.', numbers: { clusters: 1, multiSource: 1, surfaced: 1 }, signals: [] },
  },
};

function localized(lang, { dateLong, greeting, threads, story }) {
  return {
    version: 5,
    lang,
    issuedAt: BASE.issuedAt,
    data: {
      ...BASE.data,
      dateLong,
      digest: { ...BASE.data.digest, greeting, threads },
      stories: [{
        category: story.category,
        country: 'IR',
        threatLevel: 'high',
        headline: story.headline,
        description: story.headline,
        source: 'Reuters',
        sourceUrl: 'https://example.com/1',
        clusterId: 'cluster-1',
        whyMatters: story.headline,
      }],
    },
  };
}

export const CAROUSEL_FIXTURES = {
  en: {
    version: 4,
    issuedAt: BASE.issuedAt,
    data: {
      ...BASE.data,
      dateLong: '27 May 2026',
      digest: {
        ...BASE.data.digest,
        greeting: 'Good evening',
        threads: [{ tag: 'Energy', teaser: 'Shipping, insurance and refinery margins move together.' }],
      },
      stories: [{
        category: 'Energy', country: 'IR', threatLevel: 'high',
        headline: 'Iran keeps the Strait of Hormuz open while insurers reprice Gulf transit risk',
        description: 'd', source: 'Reuters', sourceUrl: 'https://example.com/1', clusterId: 'cluster-1', whyMatters: 'w',
      }],
    },
  },
  fr: localized('fr', {
    dateLong: '27 mai 2026',
    greeting: 'Bonsoir',
    threads: [{ tag: 'Énergie', teaser: 'Fret, assurance et marges de raffinage évoluent ensemble.' }],
    story: { category: 'Énergie', headline: 'L’Iran maintient le détroit d’Ormuz ouvert tandis que les assureurs réévaluent le risque' },
  }),
  ru: localized('ru', {
    dateLong: '27 мая 2026',
    greeting: 'Добрый вечер',
    threads: [{ tag: 'Энергетика', teaser: 'Фрахт, страхование и маржа переработки движутся вместе.' }],
    story: { category: 'Энергетика', headline: 'Иран оставляет Ормузский пролив открытым, страховщики пересматривают риски' },
  }),
  el: localized('el', {
    dateLong: '27 Μαΐου 2026',
    greeting: 'Καλησπέρα',
    threads: [{ tag: 'Ενέργεια', teaser: 'Ναύλοι, ασφάλιστρα και περιθώρια διύλισης κινούνται μαζί.' }],
    story: { category: 'Ενέργεια', headline: 'Το Ιράν κρατά ανοιχτά τα Στενά του Ορμούζ ενώ οι ασφαλιστές επανεκτιμούν τον κίνδυνο' },
  }),
  ja: localized('ja', {
    dateLong: '2026年5月27日',
    greeting: 'こんばんは',
    threads: [{ tag: 'エネルギー', teaser: '運賃、保険、精製マージンが連動して動いている。' }],
    story: { category: 'エネルギー', headline: 'イランはホルムズ海峡を開放したまま、保険会社は湾岸通航リスクを再評価している。海運各社は迂回航路の検討を続け、原油価格は神経質な値動きとなっている' },
  }),
  zh: localized('zh', {
    dateLong: '2026年5月27日',
    greeting: '晚上好',
    threads: [{ tag: '能源', teaser: '运费、保险和炼油利润同步变动。' }],
    story: { category: '能源', headline: '伊朗保持霍尔木兹海峡开放，保险公司重新评估海湾航运风险，航运公司继续考虑绕行航线，油价波动加剧，市场静待局势进一步明朗' },
  }),
  ko: localized('ko', {
    dateLong: '2026년 5월 27일',
    greeting: '좋은 저녁입니다',
    threads: [{ tag: '에너지', teaser: '운임, 보험, 정제 마진이 함께 움직이고 있다.' }],
    story: { category: '에너지', headline: '이란이 호르무즈 해협을 개방한 가운데 보험사들이 걸프 통항 위험을 재평가하고 있다' },
  }),
  hi: localized('hi', {
    dateLong: '27 मई 2026',
    greeting: 'शुभ संध्या',
    threads: [{ tag: 'ऊर्जा', teaser: 'माल ढुलाई, बीमा और रिफ़ाइनरी मार्जिन साथ-साथ बदल रहे हैं।' }],
    story: { category: 'ऊर्जा', headline: 'ईरान ने होर्मुज़ जलडमरूमध्य खुला रखा, बीमाकर्ता खाड़ी पारगमन जोखिम का पुनर्मूल्यांकन कर रहे हैं' },
  }),
  th: localized('th', {
    dateLong: '27 พฤษภาคม 2026',
    greeting: 'สวัสดีตอนเย็น',
    threads: [{ tag: 'พลังงาน', teaser: 'ค่าระวาง ประกันภัย และค่าการกลั่นเคลื่อนไหวไปพร้อมกัน' }],
    story: { category: 'พลังงาน', headline: 'อิหร่านเปิดช่องแคบฮอร์มุซไว้ ขณะที่บริษัทประกันประเมินความเสี่ยงการเดินเรือในอ่าวใหม่' },
  }),
  ar: localized('ar', {
    dateLong: '27 مايو 2026',
    greeting: 'مساء الخير',
    threads: [{ tag: 'الطاقة', teaser: 'الشحن والتأمين وهوامش التكرير تتحرك معًا.' }],
    story: { category: 'الطاقة', headline: 'إيران تبقي مضيق هرمز مفتوحًا بينما تعيد شركات التأمين تسعير مخاطر العبور في الخليج' },
  }),
};
