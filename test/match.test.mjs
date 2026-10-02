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
