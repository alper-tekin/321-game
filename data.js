// Futbol verisini yükler, iki kulübün ortak oyuncularını bulur ve yazılan cevabı kontrol eder.

import fs from 'node:fs';
import { normalize, closeEnough } from './public/normalize.js';

export function loadData(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const clubs = raw.clubs;
  const players = raw.players.map((p) => ({ ...p, keys: playerKeys(p) }));

  const clubIndex = new Map(clubs.map((c, i) => [c.id, i]));
  const clubPlayers = clubs.map(() => []);
  players.forEach((p, i) => p.clubs.forEach((c) => clubPlayers[c].push(i)));

  // Tam isimle hızlı arama (yanlış cevaplarda "bu oyuncu orada oynamamış" diyebilmek için)
  // Oyuncular popülerliğe göre sıralı olduğundan aynı isimde ilk kayıt en bilineni olur.
  const byName = new Map();
  players.forEach((p, i) => {
    for (const full of p.keys.full) if (!byName.has(full)) byName.set(full, i);
  });
  players.forEach((p, i) => {
    for (const s of p.keys.surnames) if (!byName.has(s)) byName.set(s, i);
  });

  return {
    builtAt: raw.builtAt,
    clubs,
    players,

    commonPlayers(a, b) {
      if (a === b) return clubPlayers[a].slice();
      const set = new Set(clubPlayers[a]);
      return clubPlayers[b].filter((i) => set.has(i)); // oyuncular popülerliğe göre sıralı geliyor
    },

    // Cevabı, geçerli cevaplar arasında arar. Bulursa oyuncu indeksini döner.
    match(text, candidates) {
      const input = normalize(text);
      if (input.length < 3) return -1;
      const tokens = input.split(' ');
      for (const i of candidates) {
        if (keysMatch(input, tokens, players[i].keys)) return i;
      }
      return -1;
    },

    lookup(text) {
      const i = byName.get(normalize(text));
      return i === undefined ? -1 : i;
    },

    clubIndexOf(id) {
      return clubIndex.get(id) ?? -1;
    },

    clubName(i) {
      return clubs[i]?.name;
    },
  };
}

function playerKeys(p) {
  const names = [p.name, ...p.aliases].map(normalize).filter(Boolean);
  // Parantezli açıklamaları at: "Alex (footballer, born 1977)" gibi
  const full = new Set(names.map((n) => n.replace(/\s+(footballer|futbolcu|born|dogumlu).*$/, '')));
  const tokenSets = [...full].map((n) => n.split(' '));
  const surnames = new Set(tokenSets.filter((t) => t.length > 1).map((t) => t[t.length - 1]));
  return { full: [...full], tokenSets, surnames: [...surnames] };
}

function keysMatch(input, tokens, keys) {
  const compact = input.replace(/ /g, '');
  for (const full of keys.full) {
    if (closeEnough(input, full) || compact === full.replace(/ /g, '')) return true;
  }
  if (tokens.length === 1) {
    // Tek kelime: soyadı olmalı ("Sneijder", "Icardi")
    return input.length >= 3 && keys.surnames.some((s) => closeEnough(input, s));
  }
  // Birden çok kelime: her kelime ismin bir parçası olmalı ("Cristiano Ronaldo")
  return keys.tokenSets.some((nameTokens) =>
    tokens.every((t) => nameTokens.some((n) => closeEnough(t, n)))
  );
}
