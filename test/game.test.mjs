import test from 'node:test';
import assert from 'node:assert/strict';
import { GameServer } from '../game.js';

// Sahte WebSocket bağlantısı: sunucunun gönderdiği mesajları yakalar
function conn() {
  return {
    readyState: 1,
    sent: [],
    room: null,
    player: null,
    send(raw) { this.sent.push(JSON.parse(raw)); },
    close() {},
  };
}

// game.js'in kullandığı arayüzün en küçük sahte veri kümesi
const data = {
  clubs: [
    { id: 'gala', name: 'Galatasaray', country: 'Türkiye', logo: 'https://upload.wikimedia.org/gala.png' },
    { id: 'fb', name: 'Fenerbahçe', country: 'Türkiye' },
  ],
  countries: [
    { id: 'tr', name: 'Türkiye', pop: 10 },
    { id: 'nl', name: 'Hollanda', pop: 5 },
  ],
  // 0: Galatasaray'da oynamış Türk oyuncu; Fenerbahçe'de oynamamış
  players: [{ name: 'Test Oyuncu', clubs: [0], countries: ['tr'] }],
  clubIndexOf: (id) => (id === 'gala' ? 0 : id === 'fb' ? 1 : -1),
  countryName: (id) => data.countries.find((c) => c.id === id)?.name,
  // Galatasaray + Türkiye -> [0]; diğer kombinasyonlar boş
  clubCountryPlayers: (club, country) => (club === 0 && country === 'tr' ? [0] : []),
  commonPlayers: () => [],
  clubName: (i) => data.clubs[i]?.name,
  lookup: (text) => (text === 'Test Oyuncu' ? 0 : -1),
  match: (text, answers) => {
    const k = data.lookup(text);
    return k >= 0 && answers.includes(k) ? k : -1;
  },
};

const lastState = (c) => c.sent.filter((m) => m.t === 'state').pop().state;

function twoPlayerRoom() {
  const game = new GameServer(data);
  const a = conn(), b = conn();
  game.handle(a, { t: 'create', name: 'Alper' });
  const code = a.sent.find((m) => m.t === 'joined').code;
  game.handle(b, { t: 'join', code, name: 'Bora' });
  game.handle(a, { t: 'start', target: 3 });
  return { game, a, b, code };
}

test('iki oyuncu aynı takımı seçerse tur iptal olur', () => {
  const { game, a, b } = twoPlayerRoom();
  game.handle(a, { t: 'pick', club: 'gala' });
  game.handle(b, { t: 'pick', club: 'gala' });
  const state = lastState(a);
  assert.equal(state.phase, 'result');
  assert.equal(state.result.reason, 'sameClub');
  assert.equal(state.result.winner, null);
  assert.ok(state.players.every((p) => p.score === 0), 'kimse puan almamalı');
  // Seçimler açılmış olmalı ki oyuncular neden iptal edildiğini görsün
  assert.ok(state.players.every((p) => p.club?.name === 'Galatasaray'));
  // Logo URL'si seçim bilgisiyle istemciye iletilmeli
  assert.ok(state.players.every((p) => p.club?.logo === 'https://upload.wikimedia.org/gala.png'));
});

test('farklı takımlar seçilirse tur normal akışta devam eder', () => {
  const { game, a, b, code } = twoPlayerRoom();
  game.handle(a, { t: 'pick', club: 'gala' });
  game.handle(b, { t: 'pick', club: 'fb' });
  const state = lastState(a);
  assert.equal(state.phase, 'countdown');
  assert.notEqual(state.result?.reason, 'sameClub');
  // Logosu olmayan kulüpte logo null olarak iletilmeli (rakibin kendi görünümünden bakılır;
  // geri sayımda rakibin seçimi karşı taraftan görünmez)
  assert.equal(lastState(b).players.find((p) => p.id === b.player.id).club.logo, null);
  game.rooms.get(code).clearTimer(); // askıda kalan geri sayım zamanlayıcısını kapat
});

test('bir takım maç içinde toplam en fazla bir kere seçilebilir', () => {
  const { game, a, b, code } = twoPlayerRoom();
  game.handle(a, { t: 'pick', club: 'gala' });
  game.handle(b, { t: 'pick', club: 'fb' });
  const room = game.rooms.get(code);
  room.clearTimer(); // 3 sn geri sayımı durdur
  assert.deepEqual(lastState(a).usedClubs, ['gala', 'fb']);
  room.endRound(null, 'timeout'); // turu bitir
  game.handle(a, { t: 'next' });
  game.handle(b, { t: 'next' });
  // seçilen takımı ne seçen oyuncu ne rakip tekrar seçebilir
  game.handle(a, { t: 'pick', club: 'gala' });
  assert.equal(a.sent.filter((m) => m.t === 'error').pop().msg, 'Bu takım bu maçta zaten seçildi.');
  game.handle(b, { t: 'pick', club: 'fb' });
  assert.equal(b.sent.filter((m) => m.t === 'error').pop().msg, 'Bu takım bu maçta zaten seçildi.');
  room.clearTimer();
});

test('biten maç son maçlar listesine düşer', () => {
  const { game, a, b, code } = twoPlayerRoom();
  const room = game.rooms.get(code);
  room.clearTimer();
  room.endRound(room.players[0], 'correct'); // 1-0
  room.endRound(room.players[0], 'correct'); // 2-0
  room.endRound(room.players[0], 'correct'); // 3-0 -> maç bitti
  assert.equal(room.phase, 'over');
  assert.equal(game.recentMatches.length, 1);
  const m = game.recentMatches[0];
  assert.deepEqual(m.players.map((p) => p.name), ['Alper', 'Bora']);
  assert.deepEqual(m.players.map((p) => p.score), [3, 0]);
  assert.ok(m.at <= Date.now());
  // tekrar endRound çağrısı maçı ikinci kez kaydetmez
  room.endRound(room.players[0], 'correct');
  assert.equal(game.recentMatches.length, 1);
});

test('aynı takım iptalinde seçimler yakılmaz', () => {
  const { game, a, b, code } = twoPlayerRoom();
  game.handle(a, { t: 'pick', club: 'gala' });
  game.handle(b, { t: 'pick', club: 'gala' }); // tur iptal
  game.handle(a, { t: 'next' });
  game.handle(b, { t: 'next' });
  game.handle(a, { t: 'pick', club: 'gala' }); // yeniden seçebilir
  assert.equal(a.sent.filter((m) => m.t === 'error').pop(), undefined);
  assert.equal(lastState(a).players.find((p) => p.id === a.player.id).picked, true);
  game.rooms.get(code).clearTimer();
});

function countryRoom() {
  const game = new GameServer(data);
  const a = conn(), b = conn();
  game.handle(a, { t: 'create', name: 'Alper' });
  const code = a.sent.find((m) => m.t === 'joined').code;
  game.handle(b, { t: 'join', code, name: 'Bora' });
  game.handle(a, { t: 'start', target: 3, mode: 'country' });
  return { game, a, b, code };
}

test('ülke modunda roller sırayla değişir, doğru cevap puan verir, kilitler işler', () => {
  const { game, a, b, code } = countryRoom();
  const room = game.rooms.get(code);
  // 1. tur: kurucu (Alper) takım seçer, Bora ülke seçer
  let s = lastState(a);
  assert.equal(s.mode, 'country');
  assert.equal(s.players.find((p) => p.id === a.player.id).pickKind, 'club');
  assert.equal(s.players.find((p) => p.id === b.player.id).pickKind, 'country');
  // rol dışı seçim reddedilir (Bora o turda ülke seçecek)
  game.handle(b, { t: 'pick', club: 'fb' });
  assert.equal(b.sent.filter((m) => m.t === 'error').pop().msg, 'Bu turda sen ülke seçeceksin.');
  game.handle(a, { t: 'pick', club: 'gala' });
  game.handle(b, { t: 'pickCountry', country: 'tr' });
  assert.equal(lastState(a).phase, 'countdown');
  room.clearTimer(); // 3 sn geri sayımı durdur
  room.setPhase('guess', 60_000, () => {}); // tahmin aşamasına geç (zamanlayıcı elle kapatılacak)
  // görünüm: takım seçenin kartı kulüp, ülke seçenin kartı ülke
  s = lastState(a);
  assert.equal(s.players.find((p) => p.id === a.player.id).club?.name, 'Galatasaray');
  assert.equal(s.players.find((p) => p.id === b.player.id).country?.name, 'Türkiye');
  // doğru tahmin: Test Oyuncu Galatasaray'da oynadı ve Türk
  game.handle(a, { t: 'guess', text: 'Test Oyuncu' });
  s = lastState(a);
  assert.equal(s.phase, 'result');
  assert.equal(s.result.winner, a.player.id);
  assert.equal(s.players.find((p) => p.id === a.player.id).score, 1);
  assert.deepEqual(s.usedClubs, ['gala']);
  assert.deepEqual(s.usedCountries, ['tr']);
  room.clearTimer();

  // 2. tur: roller değişir (Bora takım, Alper ülke)
  game.handle(a, { t: 'next' });
  game.handle(b, { t: 'next' });
  s = lastState(a);
  assert.equal(s.players.find((p) => p.id === a.player.id).pickKind, 'country');
  assert.equal(s.players.find((p) => p.id === b.player.id).pickKind, 'club');
  // kilitli takım ve ülke tekrar seçilemez
  game.handle(a, { t: 'pickCountry', country: 'tr' });
  assert.equal(a.sent.filter((m) => m.t === 'error').pop().msg, 'Bu ülke bu maçta zaten seçildi.');
  game.handle(b, { t: 'pick', club: 'gala' });
  assert.equal(b.sent.filter((m) => m.t === 'error').pop().msg, 'Bu takım bu maçta zaten seçildi.');
  room.clearTimer();
});

test('ülke modunda yanlış tahmine nedeni açıklanır', () => {
  const { game, a, b, code } = countryRoom();
  const room = game.rooms.get(code);
  game.handle(a, { t: 'pick', club: 'fb' }); // Fenerbahçe
  game.handle(b, { t: 'pickCountry', country: 'tr' });
  room.clearTimer();
  room.setPhase('guess', 60_000, () => {});
  // Test Oyuncu Fenerbahçe'de oynamadı -> kulüp notu
  game.handle(a, { t: 'guess', text: 'Test Oyuncu' });
  const g = lastState(a).guesses.find((x) => x.by === a.player.id);
  assert.equal(g.ok, false);
  assert.match(g.note, /Fenerbahçe/);
  room.clearTimer();
});

test('ülke modunda kesişim yoksa tur iptal olur', () => {
  const { game, a, b, code } = countryRoom();
  const room = game.rooms.get(code);
  game.handle(a, { t: 'pick', club: 'gala' });
  game.handle(b, { t: 'pickCountry', country: 'nl' }); // Galatasaray'da Hollandalı yok
  assert.equal(room.answers.length, 0, 'Galatasaray + Hollanda kesişimi boş olmalı');
  room.clearTimer();
  room.endRound(null, 'noCommon'); // geri sayım bitince bu yol izlenir
  const s = lastState(a);
  assert.equal(s.phase, 'result');
  assert.equal(s.result.reason, 'noCommon');
  assert.ok(s.players.every((p) => p.score === 0));
});
