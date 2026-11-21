import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { headlineInOtherLanguage } = createRequire(import.meta.url)('../scripts/lib/headline-language.cjs');

describe('headlineInOtherLanguage', () => {
  it('recognises the headlines that reached English subscribers', () => {
    for (const title of [
      'Tankskip truffet av ukjent objekt i Hormuzstredet',
      'Atak na Ukrainę, naruszenie polskiej przestrzeni powietrznej. Co się działo godzina po godzinie',
      'Así fue la inusual ejecución en Texas que duró 63 minutos: súplicas, dolor y una larga espera',
      'Bundestag stimmt für die Wehrpflicht und gegen Ausnahmen',
      'هجمات إيران على السفن.. وقائع بحرية تناقض روايات "الحرس الثوري"',
      'Rimini Street將於2027年1月14日在紐約市舉辦「投資者日」活動',
      'Атака на Київ: що відомо',
    ]) assert.equal(headlineInOtherLanguage(title), true, title);
  });

  it('never calls an English headline foreign', () => {
    for (const title of [
      'Russian missile hits Poland',
      'Two tankers attacked in Hormuz strait: maritime agency',
      'Rio de Janeiro mayor backs Lula da Silva',
      'Hayat Tahrir al-Sham and al-Shabaab named in UN report',
      'Tour de France: Van der Poel wins in Le Havre',
      "Côte d'Ivoire's Ouattara meets Médecins Sans Frontières",
      'POSCO secures three-year lithium supply deal with CATL - Mining.com.au',
      'Shafaq News..Iraq confirms forces will enter Jurf Al-Sakhr - شفق نيوز',
      '𝐎𝐟𝐟𝐢𝐜𝐢𝐚𝐥𝐬 𝐟𝐫𝐨𝐦 𝐭𝐡𝐞 𝐊𝐞𝐧𝐲𝐚 𝐑𝐚𝐢𝐥𝐰𝐚𝐲𝐬 𝐂𝐨𝐫𝐩𝐨𝐫𝐚𝐭𝐢𝐨𝐧 𝐦𝐞𝐞𝐭 𝐚 𝐔𝐊 𝐝𝐞𝐥𝐞𝐠𝐚𝐭𝐢𝐨𝐧',
      '^TWII: -10% decline',
      'I was there when the dam broke, says survivor',
      "Trump: 'I've got 'em'",
      'We’ve seen it; they’re done',
      '',
    ]) assert.equal(headlineInOtherLanguage(title), false, title);
    assert.equal(headlineInOtherLanguage(undefined), false);
  });

  it('reads one long unbroken word in linear time', () => {
    const started = performance.now();
    assert.equal(headlineInOtherLanguage('a'.repeat(200_000)), false);
    assert.ok(performance.now() - started < 500, 'a publisher-controlled title must not stall the relay');
  });
});
