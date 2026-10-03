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
    { id: 'gala', name: 'Galatasaray', country: 'Türkiye' },
    { id: 'fb', name: 'Fenerbahçe', country: 'Türkiye' },
  ],
  players: [],
  clubIndexOf: (id) => (id === 'gala' ? 0 : id === 'fb' ? 1 : -1),
  commonPlayers: () => [],
  clubName: (i) => data.clubs[i]?.name,
  match: () => -1,
  lookup: () => -1,
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
});

test('farklı takımlar seçilirse tur normal akışta devam eder', () => {
  const { game, a, b, code } = twoPlayerRoom();
  game.handle(a, { t: 'pick', club: 'gala' });
  game.handle(b, { t: 'pick', club: 'fb' });
  const state = lastState(a);
  assert.equal(state.phase, 'countdown');
  assert.notEqual(state.result?.reason, 'sameClub');
  game.rooms.get(code).clearTimer(); // askıda kalan geri sayım zamanlayıcısını kapat
});

test('bir takım maç içinde oyuncu başına en fazla bir kere seçilebilir', () => {
  const { game, a, b, code } = twoPlayerRoom();
  game.handle(a, { t: 'pick', club: 'gala' });
  game.handle(b, { t: 'pick', club: 'fb' });
  const room = game.rooms.get(code);
  room.clearTimer(); // 3 sn geri sayımı durdur
  assert.deepEqual(lastState(a).usedClubs, ['gala']);
  room.endRound(null, 'timeout'); // turu bitir
  game.handle(a, { t: 'next' });
  game.handle(b, { t: 'next' });
  // aynı takımı tekrar seçemez
  game.handle(a, { t: 'pick', club: 'gala' });
  assert.equal(a.sent.filter((m) => m.t === 'error').pop().msg, 'Bu takımı bu maçta zaten seçtin.');
  // rakip hâlâ seçebilir (kilit oyuncu başına)
  game.handle(b, { t: 'pick', club: 'gala' });
  assert.equal(b.sent.filter((m) => m.t === 'error').pop(), undefined);
  room.clearTimer();
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
