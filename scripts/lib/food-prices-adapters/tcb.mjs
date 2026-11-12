import { htmlElements, isoDate, plainText } from '../food-prices.mjs';

const INDEX = 'https://tcb.gov.bd/pages/daily-rmps';
// tcb.gov.bd sends its leaf certificate without the intermediate. Pinning the public
// Sectigo DV R36 intermediate (chains to Sectigo Root R46, valid to 2036-03-21) lets
// Node complete the chain with normal verification.
export const ca = [`-----BEGIN CERTIFICATE-----
MIIGTDCCBDSgAwIBAgIQOXpmzCdWNi4NqofKbqvjsTANBgkqhkiG9w0BAQwFADBf
MQswCQYDVQQGEwJHQjEYMBYGA1UEChMPU2VjdGlnbyBMaW1pdGVkMTYwNAYDVQQD
Ey1TZWN0aWdvIFB1YmxpYyBTZXJ2ZXIgQXV0aGVudGljYXRpb24gUm9vdCBSNDYw
HhcNMjEwMzIyMDAwMDAwWhcNMzYwMzIxMjM1OTU5WjBgMQswCQYDVQQGEwJHQjEY
MBYGA1UEChMPU2VjdGlnbyBMaW1pdGVkMTcwNQYDVQQDEy5TZWN0aWdvIFB1Ymxp
YyBTZXJ2ZXIgQXV0aGVudGljYXRpb24gQ0EgRFYgUjM2MIIBojANBgkqhkiG9w0B
AQEFAAOCAY8AMIIBigKCAYEAljZf2HIz7+SPUPQCQObZYcrxLTHYdf1ZtMRe7Yeq
RPSwygz16qJ9cAWtWNTcuICc++p8Dct7zNGxCpqmEtqifO7NvuB5dEVexXn9RFFH
12Hm+NtPRQgXIFjx6MSJcNWuVO3XGE57L1mHlcQYj+g4hny90aFh2SCZCDEVkAja
EMMfYPKuCjHuuF+bzHFb/9gV8P9+ekcHENF2nR1efGWSKwnfG5RawlkaQDpRtZTm
M64TIsv/r7cyFO4nSjs1jLdXYdz5q3a4L0NoabZfbdxVb+CUEHfB0bpulZQtH1Rv
38e/lIdP7OTTIlZh6OYL6NhxP8So0/sht/4J9mqIGxRFc0/pC8suja+wcIUna0HB
pXKfXTKpzgis+zmXDL06ASJf5E4A2/m+Hp6b84sfPAwQ766rI65mh50S0Di9E3Pn
2WcaJc+PILsBmYpgtmgWTR9eV9otfKRUBfzHUHcVgarub/XluEpRlTtZudU5xbFN
xx/DgMrXLUAPaI60fZ6wA+PTAgMBAAGjggGBMIIBfTAfBgNVHSMEGDAWgBRWc1hk
lfmSGrASKgRieaFAFYghSTAdBgNVHQ4EFgQUaMASFhgOr872h6YyV6NGUV3LBycw
DgYDVR0PAQH/BAQDAgGGMBIGA1UdEwEB/wQIMAYBAf8CAQAwHQYDVR0lBBYwFAYI
KwYBBQUHAwEGCCsGAQUFBwMCMBsGA1UdIAQUMBIwBgYEVR0gADAIBgZngQwBAgEw
VAYDVR0fBE0wSzBJoEegRYZDaHR0cDovL2NybC5zZWN0aWdvLmNvbS9TZWN0aWdv
UHVibGljU2VydmVyQXV0aGVudGljYXRpb25Sb290UjQ2LmNybDCBhAYIKwYBBQUH
AQEEeDB2ME8GCCsGAQUFBzAChkNodHRwOi8vY3J0LnNlY3RpZ28uY29tL1NlY3Rp
Z29QdWJsaWNTZXJ2ZXJBdXRoZW50aWNhdGlvblJvb3RSNDYucDdjMCMGCCsGAQUF
BzABhhdodHRwOi8vb2NzcC5zZWN0aWdvLmNvbTANBgkqhkiG9w0BAQwFAAOCAgEA
YtOC9Fy+TqECFw40IospI92kLGgoSZGPOSQXMBqmsGWZUQ7rux7cj1du6d9rD6C8
ze1B2eQjkrGkIL/OF1s7vSmgYVafsRoZd/IHUrkoQvX8FZwUsmPu7amgBfaY3g+d
q1x0jNGKb6I6Bzdl6LgMD9qxp+3i7GQOnd9J8LFSietY6Z4jUBzVoOoz8iAU84OF
h2HhAuiPw1ai0VnY38RTI+8kepGWVfGxfBWzwH9uIjeooIeaosVFvE8cmYUB4TSH
5dUyD0jHct2+8ceKEtIoFU/FfHq/mDaVnvcDCZXtIgitdMFQdMZaVehmObyhRdDD
4NQCs0gaI9AAgFj4L9QtkARzhQLNyRf87Kln+YU0lgCGr9HLg3rGO8q+Y4ppLsOd
unQZ6ZxPNGIfOApbPVf5hCe58EZwiWdHIMn9lPP6+F404y8NNugbQixBber+x536
WrZhFZLjEkhp7fFXf9r32rNPfb74X/U90Bdy4lzp3+X1ukh1BuMxA/EEhDoTOS3l
7ABvc7BYSQubQ2490OcdkIzUh3ZwDrakMVrbaTxUM2p24N6dB+ns2zptWCva6jzW
r8IWKIMxzxLPv5Kt3ePKcUdvkBU/smqujSczTzzSjIoR5QqQA6lN1ZRSnuHIWCvh
JEltkYnTAH41QJ6SAWO66GrrUESwN/cgZzL4JLEqz1Y=
-----END CERTIFICATE-----`];

// Keys are the published Bengali names with whitespace removed. null = non-food rows the report also carries.
const ITEMS = {
  'চালসুগন্ধী(পোলাও)': 'Rice (aromatic, polao)',
  'চালসরু(নাজির/মিনিকেট)': 'Rice (fine, Nazirshail/Miniket)',
  'চাল(মাঝারী)পাইজাম/আটাশ': 'Rice (medium, Pajam/BR-28)',
  'চাল(মোটা)/স্বর্ণা/চায়নাইরি': 'Rice (coarse, Swarna/China IRRI)',
  'আটাসাদা(খোলা)': 'Wheat flour (atta, loose)',
  'আটা(প্যাকেট)': 'Wheat flour (atta, packet)',
  'ময়দা(খোলা)': 'Refined flour (maida, loose)',
  'ময়দা(প্যাকেট)': 'Refined flour (maida, packet)',
  'সয়াবিনতেল(লুজ)': 'Soybean oil (loose)',
  'সয়াবিনতেল(বোতল)': 'Soybean oil (bottled)',
  'পামঅয়েল(লুজ)': 'Palm oil (loose)',
  'সুপারপামঅয়েল(লুজ)': 'Super palm oil (loose)',
  'পামঅয়েল(সুপার)': 'Palm oil (super)',
  'রাইসব্রানতেল(বোতল)': 'Rice bran oil (bottled)',
  'মশুরডাল(বড়দানা)': 'Lentils (masur, large grain)',
  'মশুরডাল(মাঝারীদানা)': 'Lentils (masur, medium grain)',
  'মশূরডাল(মাঝারীদানা)': 'Lentils (masur, medium grain)',
  'মশুরডাল(ছোটদানা)': 'Lentils (masur, small grain)',
  'মুগডাল(মানভেদে)': 'Mung dal (by quality)',
  'এ্যাংকরডাল': 'Anchor dal (yellow split peas)',
  'ছোলা(মানভেদে)': 'Chickpeas (by quality)',
  'আলু(নতুন/পুরাতন)': 'Potato (new/old)',
  'আলু(মানভেদে)': 'Potato (by quality)',
  'পিঁয়াজ(দেশী)': 'Onion (local)',
  'পিঁয়াজ(দেশী)(নতুন/পুরাতন)': 'Onion (local, new/old)',
  'পিঁয়াজ(আমদানি)': 'Onion (imported)',
  'রসুন(দেশী)': 'Garlic (local)',
  'রসুন(আমদানি)': 'Garlic (imported)',
  'শুকনামরিচ(দেশী)': 'Dried chilli (local)',
  'শুকনামরিচ(আমদানি)': 'Dried chilli (imported)',
  'হলুদ(দেশী)': 'Turmeric (local)',
  'হলুদ(আমদানি)': 'Turmeric (imported)',
  'আদা(দেশী)': 'Ginger (local)',
  'আদা(আমদানি)': 'Ginger (imported)',
  'জিরা': 'Cumin',
  'দারুচিনি': 'Cinnamon',
  'লবঙ্গ': 'Cloves',
  'এলাচ(ছোট)': 'Cardamom (small)',
  'ধনে': 'Coriander seed',
  'তেজপাতা': 'Bay leaf',
  'রুই': 'Rohu fish (rui)',
  'ইলিশ': 'Hilsa fish',
  'গরু': 'Beef',
  'খাসী': 'Goat meat',
  'মুরগী(ব্রয়লার)': 'Chicken (broiler)',
  'মুরগী(দেশী)': 'Chicken (local)',
  'ডানো': 'Milk powder (Dano)',
  'ডিপ্লোমা(নিউজিল্যান্ড)': 'Milk powder (Diploma, New Zealand)',
  'ফ্রেশ': 'Milk powder (Fresh)',
  'মার্কস': 'Milk powder (Marks)',
  'চিনি': 'Sugar',
  'খেজুর(সাধারণমানের)': 'Dates (regular quality)',
  'লবণ(প্যাঃ)আয়োডিনযুক্ত': 'Salt (iodized, packet)',
  'লবণ(প্যাঃ)আয়োডিনযুক্ত(মানভেদে)': 'Salt (iodized, packet, by quality)',
  'লেবু': 'Lemon',
  'কাঁচামরিচ': 'Green chilli',
  'বেগুন': 'Eggplant',
  'শসা': 'Cucumber',
  'ডিম(ফার্ম)': 'Eggs (farm)',
  'লেখারকাগজ(সাদা)': null,
  'এম,এসরড(৬০গ্রেড)': null,
  'এম,এসরড(৪০গ্রেড)': null,
};
const UNITS = { 'প্রতিকেজি': 'kg', 'প্রতিকেজিপ্যাঃ': 'kg packet', 'প্রতিলিটার': 'litre', 'প্রতিহালি': 'hali (4 pieces)' };

const ascii = value => value.replace(/[০-৯]/g, digit => String(digit.charCodeAt(0) - 0x09e6));
const text = value => value?.richText ? value.richText.map(part => part.text).join('') : value instanceof Date ? value.toISOString() : String(value ?? '');
const key = value => text(value).replace(/\s+/g, '').normalize('NFC');
const starts = (value, prefix) => key(value).startsWith(prefix.normalize('NFC'));
const ITEM_NAMES = new Map(Object.entries(ITEMS).map(([name, item]) => [name.normalize('NFC'), item]));
const UNIT_NAMES = new Map(Object.entries(UNITS).map(([name, unit]) => [name.normalize('NFC'), unit]));
const dmy = value => {
  const match = /(\d{2})-(\d{2})-(\d{4})/.exec(ascii(value));
  return match ? isoDate(match[3], match[2], match[1]) : '';
};
const cellDate = value => value instanceof Date ? value.toISOString().slice(0, 10) : /^\d{4}-\d{2}-\d{2}/.test(text(value)) ? text(value).slice(0, 10) : '';
const amount = value => {
  const number = typeof value === 'number' ? value : /^\d+(?:\.\d+)?$/.test(text(value).trim()) ? Number(text(value).trim()) : NaN;
  return Number.isFinite(number) && number > 0 ? number : null;
};
const unitOf = value => {
  const unit = ascii(key(value));
  if (UNIT_NAMES.has(unit)) return UNIT_NAMES.get(unit);
  const match = /^(\d+)(লিটার|কেজি|গ্রাম)$/.exec(unit);
  return match ? `${match[1]} ${{ 'লিটার': 'litre', 'কেজি': 'kg', 'গ্রাম': 'g' }[match[2]]}` : '';
};

export function parseTcbIndex(html) {
  return html.split(/<tr\b/i).flatMap(row => {
    const url = /href=["'](https:\/\/objectstorage\.[^"']+\.xlsx)["']/i.exec(row)?.[1];
    const cells = htmlElements(row, ['td']);
    const cell = column => cells.find(([open]) => new RegExp(`data-column=["']${column}["']`, 'i').test(open))?.[1] ?? '';
    const date = dmy(cell('publish_date'));
    const title = plainText(cell('title'));
    return url && date && /দৈনিক খুচরা বাজার দর/.test(title) ? [{ url, date }] : [];
  });
}

export function parseTcb(sheets, onUnknown = () => {}) {
  const rows = sheets?.[0];
  if (!rows?.length) throw new Error('tcb workbook format changed: no worksheet');
  const end = rows.findIndex(row => starts(row[0], 'যেসকলবাজারহতে'));
  const headers = rows.slice(0, Math.max(end, 0)).flatMap((row, i) => starts(row[0], 'পণ্যেরনাম') && starts(row[2], 'অদ্যকারমূল্য') ? [i] : []);
  if (!headers.length || end < 0) throw new Error('tcb workbook format changed: header or market line missing');
  const memo = rows.slice(0, headers[0]).map(row => dmy(text(row.find(cell => /তারিখঃ/.test(text(cell)))))).find(Boolean) ?? '';
  const dates = headers.map(i => cellDate(rows[i + 1]?.[2]));
  for (const i of headers) {
    if (!starts(rows[i + 2]?.[2], 'সর্বনিম্ন') || !starts(rows[i + 2]?.[3], 'সর্ব্বোচ্চ')) throw new Error('tcb workbook format changed: low/high columns moved');
  }
  const date = memo || dates[0];
  if (!date || dates.some(value => value !== date)) throw new Error('tcb workbook format changed: report date mismatch');
  const result = [];
  for (let i = headers[0] + 3; i < end; i++) {
    const row = rows[i] ?? [];
    const name = key(row[0]);
    if (headers.some(header => i >= header && i <= header + 2) || !name || !key(row[1])) continue;
    const item = ITEM_NAMES.get(name);
    const unit = unitOf(row[1]);
    if (item === null) continue;
    if (item === undefined || !unit) { onUnknown(`${text(row[0]).trim()} / ${text(row[1]).trim()}`); continue; }
    for (const [suffix, value] of [[' (low)', row[2]], [' (high)', row[3]]]) {
      const price = amount(value);
      if (price !== null) result.push({ item: item + suffix, market: 'Dhaka', marketType: 'retail', unit, currency: 'BDT', date, price, origin: '' });
    }
  }
  if (result.length < 40) throw new Error('tcb workbook format changed: too few priced items');
  return result;
}

export async function collect(ctx) {
  const today = ctx.dated(ctx.now, 0);
  let index;
  try { index = await ctx.get(INDEX); } catch (error) {
    ctx.warn(`index unavailable (${error.message}); retrying with trailing slash`);
    index = await ctx.get(`${INDEX}/`);
  }
  const reports = parseTcbIndex(index).filter(report => report.date <= today);
  const latest = reports[0];
  if (!latest) throw new Error('tcb has no report links');
  const priorDate = ctx.dated(new Date(`${latest.date}T00:00:00Z`), -7);
  if (!reports.some(report => report.date === priorDate) && reports.at(-1).date > priorDate) {
    try { reports.push(...parseTcbIndex(await ctx.get(`${INDEX}?page=2`))); } catch (error) { ctx.warn(`index page 2 unavailable: ${error.message}`); }
  }
  const prior = reports.find(report => report.date === priorDate);
  const observations = [];
  const refreshedReports = [];
  for (const report of [latest, prior].filter(Boolean)) {
    try {
      const rows = parseTcb(await ctx.readWorkbook(await ctx.get(report.url, { binary: true })), name => ctx.warn(`unmapped item ${name}`));
      if (rows.some(row => row.date !== report.date)) throw new Error('tcb report date mismatch');
      observations.push(...rows);
      refreshedReports.push({ date: report.date });
    } catch (error) {
      if (report === latest) throw error;
      ctx.warn(`prior-week report unavailable: ${error.message}`);
    }
  }
  if (!prior) ctx.warn(`no report dated ${priorDate}`);
  return { observations, contexts: [], refreshedReports, reportUrl: latest.url };
}
