// Gerçek veriyle cevap kontrolü testleri: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadData } from '../data.js';
import { normalize } from '../public/normalize.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = loadData(path.join(ROOT, 'data', 'football.json'));

function club(name) {
  const n = normalize(name);
  const i = data.clubs.findIndex((c) => normalize(c.name) === n || c.aliases.some((a) => normalize(a) === n));
  assert.ok(i >= 0, `kulüp bulunamadı: ${name}`);
  return i;
}

function accepts(a, b, text) {
  const answers = data.commonPlayers(club(a), club(b));
  return data.match(text, answers) >= 0;
}

test('normalize Türkçe karakterleri sadeleştirir', () => {
  assert.equal(normalize('Hakan ŞÜKÜR'), 'hakan sukur');
  assert.equal(normalize('İlhan Mansız'), 'ilhan mansiz');
  assert.equal(normalize('ICARDI'), 'icardi');
});

test('Galatasaray + Inter', () => {
  assert.ok(accepts('Galatasaray', 'Inter Milan', 'Sneijder'));
  assert.ok(accepts('Galatasaray', 'Inter Milan', 'Wesley Sneijder'));
  assert.ok(accepts('Galatasaray', 'Inter Milan', 'snejder'), 'küçük yazım hatası');
  assert.ok(accepts('Galatasaray', 'Inter Milan', 'hakan sukur'));
  assert.ok(accepts('Galatasaray', 'Inter Milan', 'Icardi'));
  assert.ok(!accepts('Galatasaray', 'Inter Milan', 'Drogba'));
  assert.ok(!accepts('Galatasaray', 'Inter Milan', 'Wesley'), 'sadece ön isim kabul edilmez');
});

test('Fenerbahçe + Real Madrid', () => {
  assert.ok(accepts('Fenerbahçe', 'Real Madrid', 'Roberto Carlos'));
  assert.ok(accepts('Fenerbahçe', 'Real Madrid', 'Mesut Özil'));
  assert.ok(accepts('Fenerbahçe', 'Real Madrid', 'ozil'));
});

test('Beşiktaş + Chelsea', () => {
  assert.ok(accepts('Beşiktaş', 'Chelsea', 'Quaresma'));
  assert.ok(accepts('Beşiktaş', 'Chelsea', 'Demba Ba'));
});

test('Barcelona + Inter (Eto\'o, Ibrahimović)', () => {
  assert.ok(accepts('FC Barcelona', 'Inter Milan', "Eto'o"));
  assert.ok(accepts('FC Barcelona', 'Inter Milan', 'Ibrahimovic'));
});

// Wikidata SPARQL truthy indeksindeki eksik NormalRank kayıtları yüzünden
// tamamen kaybolan oyuncular için regresyon testleri (Kovačić, Ronaldo, Di María).
test('Real Madrid + Chelsea (Kovacic)', () => {
  assert.ok(accepts('Real Madrid CF', 'Chelsea FC', 'Kovacic'));
  assert.ok(accepts('Real Madrid CF', 'Chelsea FC', 'Mateo Kovacic'));
});

test('Real Madrid + Manchester United (Cristiano Ronaldo)', () => {
  assert.ok(accepts('Real Madrid CF', 'Manchester United FC', 'Cristiano Ronaldo'));
  assert.ok(accepts('Real Madrid CF', 'Manchester United FC', 'Ronaldo'));
});

test('Real Madrid + PSG (Di María)', () => {
  assert.ok(accepts('Real Madrid CF', 'Paris Saint-Germain', 'Di Maria'));
});

// Wikidata gecikmesi düzeltmesi: Trossard'ın Beşiktaş transferi (Temmuz 2026)
// Wikidata'ya işlenmediği için data/overrides.json ile ekleniyor.
test('Beşiktaş + Arsenal (Trossard)', () => {
  assert.ok(accepts('Beşiktaş', 'Arsenal FC', 'Trossard'));
  assert.ok(accepts('Beşiktaş', 'Arsenal FC', 'Leandro Trossard'));
});

// İkincil kaynakların regresyon testleri: Wikidata'nın kaçırdığı transferler
// Transfermarkt birleşimi (tarih, 6 Temmuz 2026'ya kadar) ve Wikipedia güncel
// kadro şablonlarından geliyor.
test('Napoli + Torino (Giovanni Simeone, Transfermarkt)', () => {
  assert.ok(accepts('SSC Napoli', 'Torino FC', 'Giovanni Simeone'));
  assert.ok(accepts('SSC Napoli', 'Torino FC', 'Simeone'));
});

test('Bayern + Southampton (Daniel Peretz, Transfermarkt)', () => {
  assert.ok(accepts('FC Bayern Münih', 'Southampton FC', 'Daniel Peretz'));
  assert.ok(accepts('FC Bayern Münih', 'Southampton FC', 'Peretz'));
});

test('Beşiktaş + Leicester (Ndidi, Wikipedia kadrosu)', () => {
  assert.ok(accepts('Beşiktaş', 'Leicester City FC', 'Ndidi'));
  assert.ok(accepts('Beşiktaş', 'Leicester City FC', 'Wilfred Ndidi'));
});

// ---------- Ülke modu: takım + ülke kesişimi ----------

function country(id) {
  const c = data.countries.find((x) => x.id === id);
  assert.ok(c, `ülke bulunamadı: ${id}`);
  return c;
}

function acceptsCountry(clubName, countryId, text) {
  const answers = data.clubCountryPlayers(club(clubName), country(countryId).id);
  return data.match(text, answers) >= 0;
}

test('ülke modu: takım + uyruk kesişimi doğru çalışır', () => {
  // Sneijder Hollandalı ve Galatasaray'da oynadı
  assert.ok(acceptsCountry('Galatasaray', 'Q55', 'Sneijder'));
  // Icardi Arjantinli ve Galatasaray'da oynadı
  assert.ok(acceptsCountry('Galatasaray', 'Q414', 'Icardi'));
  // Hakan Şükür Türk ama Inter'de oynamadı; Sneijder Inter'de oynadı ama Türk değil
  assert.ok(!acceptsCountry('Galatasaray', 'Q55', 'Hakan Şükür'), 'Hakan Şükür Hollandalı değil');
  assert.ok(!acceptsCountry('Galatasaray', 'Q43', 'Sneijder'), 'Sneijder Türk değil');
  assert.ok(!acceptsCountry('Galatasaray', 'Q43', 'Quaresma'), 'Quaresma Galatasarayda oynamadı');
});

test('ülke modu: ülkeler oyuncu sayısına göre sıralı ve takma adlı', () => {
  assert.ok(data.countries.length > 100, 'yeterince ülke olmalı');
  const pops = data.countries.map((c) => c.pop);
  assert.deepEqual(pops, [...pops].sort((a, b) => b - a), 'popülerlik sırası bozulmamalı');
  // Türkçe aramada takma adlar bulunmalı
  const abd = data.countries.find((c) => c.aliases?.includes('ABD'));
  assert.equal(abd?.name, 'Amerika Birleşik Devletleri');
  const sscb = data.countries.find((c) => c.aliases?.includes('SSCB'));
  assert.ok(sscb, 'SSCB takma adı olmalı');
});
