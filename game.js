// Oda ve tur mantığı. Sunucu tek doğruluk kaynağıdır; istemcilere her değişiklikte oda durumu gönderilir.

import crypto from 'node:crypto';

const PICK_MS = 20_000;
const COUNTDOWN_MS = 3_000;
const GUESS_MS = 15_000;
const GUESS_COOLDOWN_MS = 600;
const ROOM_IDLE_MS = 15 * 60_000;
const MAX_PLAYERS = 2;
const SHOWN_ANSWERS = 20;

export class GameServer {
  constructor(data) {
    this.data = data;
    this.rooms = new Map();
    this.recentMatches = []; // giriş ekranındaki "Son maçlar" listesi (yalnızca biten maçlar)
    setInterval(() => this.cleanup(), 60_000).unref();
  }

  recordMatch(match) {
    this.recentMatches.unshift(match);
    if (this.recentMatches.length > 15) this.recentMatches.length = 15;
  }

  handle(conn, msg) {
    try {
      switch (msg.t) {
        case 'create': return this.create(conn, msg);
        case 'join': return this.join(conn, msg);
        case 'rejoin': return this.rejoin(conn, msg);
      }
      const room = conn.room;
      const player = conn.player;
      if (!room || !player) return send(conn, { t: 'error', msg: 'Önce bir odaya katıl.' });
      room.lastActive = Date.now();
      switch (msg.t) {
        case 'start': return room.start(player, msg);
        case 'pick': return room.pick(player, msg.club);
        case 'pickCountry': return room.pickCountry(player, msg.country);
        case 'guess': return room.guess(player, msg.text);
        case 'accept': return room.accept(player, msg.guessId);
        case 'next': return room.ready(player);
        case 'leave': return this.leave(conn);
      }
    } catch (err) {
      console.error(err);
      send(conn, { t: 'error', msg: 'Sunucu hatası.' });
    }
  }

  create(conn, { name }) {
    name = cleanName(name);
    if (!name) return send(conn, { t: 'error', msg: 'Bir isim yaz.' });
    let code;
    do code = String(Math.floor(1000 + Math.random() * 9000));
    while (this.rooms.has(code));
    const room = new Room(code, this.data, (m) => this.recordMatch(m));
    this.rooms.set(code, room);
    this.attach(conn, room, room.addPlayer(name));
  }

  join(conn, { code, name }) {
    name = cleanName(name);
    const room = this.rooms.get(String(code || '').trim());
    if (!name) return send(conn, { t: 'error', msg: 'Bir isim yaz.' });
    if (!room) return send(conn, { t: 'error', msg: 'Bu kodla bir oda yok.' });
    if (room.players.length >= MAX_PLAYERS) return send(conn, { t: 'error', msg: 'Oda dolu.' });
    if (room.phase !== 'lobby') return send(conn, { t: 'error', msg: 'Oyun başlamış.' });
    this.attach(conn, room, room.addPlayer(name));
  }

  rejoin(conn, { code, token }) {
    const room = this.rooms.get(String(code || ''));
    const player = room?.players.find((p) => p.token === token);
    if (!player) return send(conn, { t: 'rejoinFailed' });
    if (player.conn && player.conn !== conn) player.conn.close?.();
    this.attach(conn, room, player);
  }

  attach(conn, room, player) {
    player.conn = conn;
    conn.room = room;
    conn.player = player;
    send(conn, { t: 'joined', code: room.code, token: player.token, you: player.id });
    room.broadcast();
  }

  leave(conn) {
    const { room, player } = conn;
    if (!room || !player) return;
    room.removePlayer(player);
    conn.room = conn.player = null;
    send(conn, { t: 'left' });
    if (room.players.length === 0) this.deleteRoom(room);
  }

  disconnected(conn) {
    const { room, player } = conn;
    if (!room || !player || player.conn !== conn) return;
    player.conn = null;
    if (room.phase === 'lobby' && room.players.length > 1 && player !== room.players[0]) {
      room.removePlayer(player);
    } else {
      room.broadcast();
    }
  }

  deleteRoom(room) {
    room.clearTimer();
    this.rooms.delete(room.code);
  }

  cleanup() {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      const anyone = room.players.some((p) => p.conn);
      if (!anyone && now - room.lastActive > ROOM_IDLE_MS) this.deleteRoom(room);
    }
  }
}

class Room {
  constructor(code, data, onMatchEnd = null) {
    this.code = code;
    this.data = data;
    this.onMatchEnd = onMatchEnd;
    this.players = [];
    this.mode = 'classic'; // classic (takım + takım) | country (takım + ülke)
    this.used = new Set(); // bu maçta seçilmiş kulüpler (indeks); iki oyuncu için ortak kilit
    this.usedCountries = new Set(); // bu maçta seçilmiş ülkeler (kimlik); ülke modu kilidi
    this.phase = 'lobby'; // lobby | pick | countdown | guess | result | over
    this.target = 5;
    this.round = 0;
    this.deadline = null;
    this.timer = null;
    this.lastActive = Date.now();
    this.nextId = 1;
    this.resetRound();
  }

  resetRound() {
    this.picks = new Map(); // playerId -> kulüp indeksi
    this.countryPicks = new Map(); // playerId -> ülke kimliği (ülke modu)
    this.answers = [];
    this.guesses = [];
    this.roundWinner = null;
    this.winningGuess = null;
    this.endReason = null;
  }

  addPlayer(name) {
    const player = {
      id: this.nextId++,
      name,
      token: crypto.randomBytes(16).toString('hex'),
      score: 0,
      ready: false,
      lastGuessAt: 0,
      conn: null,
    };
    this.players.push(player);
    return player;
  }

  removePlayer(player) {
    this.players = this.players.filter((p) => p !== player);
    if (this.phase !== 'lobby') {
      this.clearTimer();
      this.phase = 'lobby';
      this.players.forEach((p) => { p.score = 0; p.ready = false; });
      this.used.clear();
      this.usedCountries.clear();
      this.resetRound();
    }
    this.broadcast();
  }

  opponent(player) {
    return this.players.find((p) => p !== player);
  }

  start(player, { target, mode }) {
    if (this.phase !== 'lobby' && this.phase !== 'over') return;
    if (this.players.length < 2) return send(player.conn, { t: 'error', msg: 'Rakip bekleniyor.' });
    if ([3, 5, 7, 10].includes(target)) this.target = target;
    if (mode === 'country' || mode === 'classic') this.mode = mode;
    this.players.forEach((p) => { p.score = 0; });
    this.used.clear(); // yeni maç: kilitler sıfırlanır
    this.usedCountries.clear();
    this.round = 0;
    this.startPick();
  }

  // Ülke modunda roller turlar boyunca sırayla değişir: bir tur bir oyuncu takım seçer,
  // sonraki tur öbürü. Klasik modda herkes takım seçer.
  clubPicker() {
    return this.mode === 'country' ? this.players[(this.round - 1 + this.players.length) % this.players.length] : null;
  }

  pickKind(player) {
    if (this.mode !== 'country') return 'club';
    return this.clubPicker() === player ? 'club' : 'country';
  }

  bothPicked() {
    return this.players.every((p) => (this.pickKind(p) === 'club' ? this.picks.has(p.id) : this.countryPicks.has(p.id)));
  }

  startPick() {
    this.resetRound();
    this.round++;
    this.players.forEach((p) => { p.ready = false; });
    this.setPhase('pick', PICK_MS, () => this.autoPick());
  }

  pick(player, clubId) {
    if (this.phase !== 'pick') return;
    if (this.pickKind(player) !== 'club') return send(player.conn, { t: 'error', msg: 'Bu turda sen ülke seçeceksin.' });
    const club = this.data.clubIndexOf(clubId);
    if (club < 0) return send(player.conn, { t: 'error', msg: 'Takım bulunamadı, sayfayı yenile.' });
    if (this.used.has(club)) return send(player.conn, { t: 'error', msg: 'Bu takım bu maçta zaten seçildi.' });
    this.picks.set(player.id, club);
    if (this.bothPicked()) this.startCountdown();
    else this.broadcast();
  }

  pickCountry(player, countryId) {
    if (this.phase !== 'pick') return;
    if (this.pickKind(player) !== 'country') return send(player.conn, { t: 'error', msg: 'Bu turda sen takım seçeceksin.' });
    if (!this.data.countryName(countryId)) return send(player.conn, { t: 'error', msg: 'Ülke bulunamadı, sayfayı yenile.' });
    if (this.usedCountries.has(countryId)) return send(player.conn, { t: 'error', msg: 'Bu ülke bu maçta zaten seçildi.' });
    this.countryPicks.set(player.id, countryId);
    if (this.bothPicked()) this.startCountdown();
    else this.broadcast();
  }

  // Süre biterse seçmeyen oyuncuya, bu maçta kullanılmamış popüler seçeneklerden rastgele biri verilir
  autoPick() {
    for (const p of this.players) {
      if (this.pickKind(p) === 'club') {
        if (this.picks.has(p.id)) continue;
        const taken = new Set(this.picks.values()); // bu turda zaten seçilenler (aynı takım çakışmasın)
        const popular = Math.min(80, this.data.clubs.length);
        let pool = [];
        for (let i = 0; i < popular; i++) if (!this.used.has(i) && !taken.has(i)) pool.push(i);
        if (!pool.length) for (let i = popular; i < this.data.clubs.length; i++) if (!this.used.has(i) && !taken.has(i)) pool.push(i);
        if (!pool.length) pool = [0]; // teorik: her şey kullanılmışsa
        const idx = pool[Math.floor(Math.random() * pool.length)];
        this.picks.set(p.id, idx);
        taken.add(idx);
      } else {
        if (this.countryPicks.has(p.id)) continue;
        const popular = this.data.countries.slice(0, 40); // oyuncu sayısına göre en popüler ülkeler
        let pool = popular.filter((c) => !this.usedCountries.has(c.id));
        if (!pool.length) pool = this.data.countries.filter((c) => !this.usedCountries.has(c.id));
        if (!pool.length) pool = this.data.countries; // teorik: her şey kullanılmışsa
        this.countryPicks.set(p.id, pool[Math.floor(Math.random() * pool.length)].id);
      }
    }
    this.startCountdown();
  }

  startCountdown() {
    if (this.mode === 'country') {
      const clubPicker = this.clubPicker();
      const countryPicker = this.opponent(clubPicker);
      const club = this.picks.get(clubPicker.id);
      const country = this.countryPicks.get(countryPicker.id);
      // Seçimler açıklandı: bu maçta bir daha hiç kimse seçemesin (iptal edilen tur yakmaz)
      this.used.add(club);
      this.usedCountries.add(country);
      this.answers = this.data.clubCountryPlayers(club, country);
    } else {
      const [a, b] = this.players.map((p) => this.picks.get(p.id));
      // İki oyuncu aynı takımı seçtiyse tur anlamsız olur: iptal edip yeni turdan devam
      if (a === b) return this.endRound(null, 'sameClub');
      // Seçimler açıklandı: bu maçta bir daha hiç kimse seçemesin (iptal edilen tur yakmaz)
      this.players.forEach((p) => this.used.add(this.picks.get(p.id)));
      this.answers = this.data.commonPlayers(a, b);
    }
    this.setPhase('countdown', COUNTDOWN_MS, () => {
      if (this.answers.length === 0) this.endRound(null, 'noCommon');
      else this.setPhase('guess', GUESS_MS, () => this.endRound(null, 'timeout'));
    });
  }

  guess(player, text) {
    if (this.phase !== 'guess') return;
    text = String(text || '').trim().slice(0, 60);
    if (!text) return;
    const now = Date.now();
    if (now - player.lastGuessAt < GUESS_COOLDOWN_MS) return;
    player.lastGuessAt = now;

    const hit = this.data.match(text, this.answers);
    const g = { id: this.nextId++, by: player.id, text, ok: hit >= 0, player: hit, note: null };
    if (hit < 0) {
      const known = this.data.lookup(text);
      const p = known >= 0 ? this.data.players[known] : null;
      if (this.mode === 'country') {
        const clubPicker = this.clubPicker();
        const club = this.picks.get(clubPicker.id);
        const country = this.countryPicks.get(this.opponent(clubPicker).id);
        const noClub = p && !p.clubs.includes(club);
        const noCountry = p && !(p.countries ?? []).includes(country);
        if (noClub && noCountry) g.note = `${p.name} ${this.data.clubName(club)} forması giymemiş ve ${this.data.countryName(country)} vatandaşı da değil.`;
        else if (noClub) g.note = `${p.name} verilere göre ${this.data.clubName(club)} formasını giymemiş.`;
        else if (noCountry) g.note = `${p.name} ${this.data.countryName(country)} vatandaşı değil.`;
        else if (p && !p.countries?.length) g.note = `${p.name}'in uyruk bilgisi veride yok.`;
        else g.note = 'Bu isim bu takım ve ülke kombinasyonuna uyan oyuncular arasında yok.';
      } else {
        const missing = p
          ? [...new Set(this.players.map((pl) => this.picks.get(pl.id)).filter((c) => !p.clubs.includes(c)))]
          : [];
        if (missing.length) {
          g.note = `${p.name} verilere göre ${missing.map((c) => this.data.clubName(c)).join(' ve ')} formasını giymemiş.`;
        } else {
          g.note = 'Bu isim bu iki takımın ortak oyuncuları arasında yok.';
        }
      }
    }
    this.guesses.push(g);
    if (g.ok) this.endRound(player, 'correct', g);
    else this.broadcast();
  }

  // Rakip, reddedilen bir cevabı doğru kabul ederse puan cevabı yazana gider
  accept(player, guessId) {
    if (this.phase !== 'guess') return;
    const g = this.guesses.find((x) => x.id === guessId);
    if (!g || g.ok || g.by === player.id) return;
    g.accepted = true;
    this.endRound(this.players.find((p) => p.id === g.by), 'accepted', g);
  }

  endRound(winner, reason, guess = null) {
    this.roundWinner = winner?.id ?? null;
    this.winningGuess = guess;
    this.endReason = reason;
    if (winner) winner.score++;
    const champion = this.players.find((p) => p.score >= this.target);
    if (champion && this.phase !== 'over') {
      // Maç bitti: giriş ekranındaki "Son maçlar" listesi için kaydet
      this.onMatchEnd?.({
        players: this.players.map((p) => ({ name: p.name, score: p.score })),
        at: Date.now(),
      });
    }
    this.setPhase(champion ? 'over' : 'result', null);
  }

  ready(player) {
    if (this.phase !== 'result') return;
    player.ready = true;
    if (this.players.every((p) => p.ready)) this.startPick();
    else this.broadcast();
  }

  setPhase(phase, ms, onTimeout) {
    this.clearTimer();
    this.phase = phase;
    this.deadline = ms ? Date.now() + ms : null;
    if (ms) this.timer = setTimeout(onTimeout, ms);
    this.broadcast();
  }

  clearTimer() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  broadcast() {
    for (const p of this.players) if (p.conn) send(p.conn, { t: 'state', state: this.view(p) });
  }

  // Oyuncuya özel görünüm: rakibin seçimi sayaç bitene kadar gizli
  view(me) {
    const revealed = !['lobby', 'pick', 'countdown'].includes(this.phase);
    const data = this.data;
    const playerInfo = (i) => (i >= 0 ? { name: data.players[i].name, id: data.players[i].id } : null);
    return {
      code: this.code,
      phase: this.phase,
      round: this.round,
      target: this.target,
      mode: this.mode,
      usedClubs: [...this.used].map((i) => data.clubs[i].id),
      usedCountries: [...this.usedCountries],
      deadline: this.deadline,
      now: Date.now(),
      you: me.id,
      host: this.players[0]?.id,
      players: this.players.map((p) => {
        const pick = this.picks.get(p.id);
        const countryPick = this.countryPicks.get(p.id);
        const kind = this.pickKind(p);
        const showPick = p === me || revealed;
        return {
          id: p.id,
          name: p.name,
          score: p.score,
          online: !!p.conn,
          ready: p.ready,
          picked: kind === 'club' ? pick !== undefined : countryPick !== undefined,
          pickKind: kind,
          club: showPick && kind === 'club' && pick !== undefined ? { i: pick, name: data.clubs[pick].name, country: data.clubs[pick].country, logo: data.clubs[pick].logo ?? null } : null,
          country: showPick && kind === 'country' && countryPick !== undefined ? { id: countryPick, name: data.countryName(countryPick) } : null,
        };
      }),
      guesses: this.guesses.map((g) => ({
        id: g.id,
        by: g.by,
        text: g.text,
        ok: g.ok,
        accepted: !!g.accepted,
        note: g.note,
      })),
      result: ['result', 'over'].includes(this.phase)
        ? {
            winner: this.roundWinner,
            reason: this.endReason,
            guess: this.winningGuess ? { text: this.winningGuess.text, player: playerInfo(this.winningGuess.player) } : null,
            total: this.answers.length,
            answers: this.answers.slice(0, SHOWN_ANSWERS).map((i) => data.players[i].name),
          }
        : null,
    };
  }
}

function cleanName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, 16);
}

function send(conn, msg) {
  if (conn && conn.readyState === 1) conn.send(JSON.stringify(msg));
}
