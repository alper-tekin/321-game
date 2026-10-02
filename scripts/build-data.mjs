// Wikidata'dan kulüp ve oyuncu verisini çekip data/football.json dosyasına yazar.
// Kullanım: npm run build-data   (birkaç dakika sürer, ara sonuçlar scripts/.cache altında saklanır)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(ROOT, 'scripts', '.cache');
const OUT_FILE = path.join(ROOT, 'data', 'football.json');

const ENDPOINT = 'https://query.wikidata.org/sparql';
const USER_AGENT = '321-game-data-builder/1.0 (hobby football quiz)';

// Kaç dilde Wikipedia sayfası olan kulüpler alınsın
const MIN_CLUB_SITELINKS = 25;
const MIN_TURKISH_CLUB_SITELINKS = 15;
const CLUB_BATCH = 15;
const LABEL_BATCH = 300;
const LANGS = ['tr', 'en', 'mul'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sparql(query, attempt = 1) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/sparql-results+json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ query }),
  });
  if (res.ok) {
    const json = await res.json();
    return json.results.bindings;
  }
  if (attempt >= 6) throw new Error(`SPARQL hatası ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const retryAfter = Number(res.headers.get('retry-after')) || 0;
  const wait = Math.max(retryAfter * 1000, 2000 * 2 ** attempt);
  console.warn(`  ${res.status} geldi, ${Math.round(wait / 1000)} sn sonra tekrar denenecek...`);
  await sleep(wait);
  return sparql(query, attempt + 1);
}

const qid = (uri) => uri.slice(uri.lastIndexOf('/') + 1);

async function cached(name, fn) {
  const file = path.join(CACHE_DIR, `${name}.json`);
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    const data = await fn();
    await fs.writeFile(file, JSON.stringify(data));
    return data;
  }
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Wikidata'da kulüpler farklı türlerle kayıtlı: Galatasaray "futbol kulübü", Barcelona "erkek futbol takımı",
// Boca Juniors "spor kulübü" (sporu futbol). Tek sorguda birleştirmek zaman aşımına uğradığı için ayrı ayrı çekiliyor.
const CLUB_PATTERNS = [
  '?c wdt:P31 wd:Q476028.',
  '?c wdt:P31 wd:Q103229495. FILTER NOT EXISTS { ?c wdt:P31 wd:Q6979593 }',
  '?c wdt:P31 wd:Q15944511.',
  '?c wdt:P31 wd:Q847017; wdt:P641 wd:Q2736.',
];

// Milli takımlar, B/gençlik/kadın takımları oyunda seçilebilir olmasın
const EXCLUDED_CLUB_NAME = /national|milli takım|\b(II|B|C|U-?\d{2})$|castilla|^jong |kadın|women|ladies|femen|reserves|youth|primavera|atl[eè]tic$/i;

async function fetchClubs() {
  console.log('Kulüpler çekiliyor...');
  const rows = [];
  for (const pattern of CLUB_PATTERNS) {
    rows.push(...await sparql(`
      SELECT ?c ?links ?country WHERE {
        ${pattern}
        ?c wikibase:sitelinks ?links.
        FILTER(?links >= ${MIN_TURKISH_CLUB_SITELINKS})
        OPTIONAL { ?c wdt:P17 ?country. }
      }`));
    await sleep(1000);
  }
  const clubs = new Map();
  for (const r of rows) {
    const id = qid(r.c.value);
    const links = Number(r.links.value);
    const country = r.country ? qid(r.country.value) : null;
    const prev = clubs.get(id);
    if (prev) {
      if (country === 'Q43') prev.country = country;
      continue;
    }
    clubs.set(id, { id, pop: links, country });
  }
  const selected = [...clubs.values()].filter(
    (c) => c.pop >= MIN_CLUB_SITELINKS || c.country === 'Q43'
  );
  console.log(`  ${selected.length} kulüp seçildi`);
  return selected;
}

// Kimlik bazlı önbellek: { id: satırlar }. Kulüp listesi değişince sadece yeni kimlikler çekilir.
async function cachedById(name, ids, batchSize, fetchBatch) {
  const file = path.join(CACHE_DIR, `${name}.json`);
  let store = {};
  try { store = JSON.parse(await fs.readFile(file, 'utf8')); } catch {}
  const missing = ids.filter((id) => !(id in store));
  const batches = chunk(missing, batchSize);
  for (let i = 0; i < batches.length; i++) {
    const rows = await fetchBatch(batches[i]);
    for (const id of batches[i]) store[id] = [];
    for (const row of rows) store[row[0]].push(row);
    if (i % 10 === 9 || i === batches.length - 1) await fs.writeFile(file, JSON.stringify(store));
    process.stdout.write(`\r  ${i + 1}/${batches.length} grup`);
  }
  if (batches.length) console.log();
  else console.log('  hepsi önbellekte');
  return ids.flatMap((id) => store[id]);
}

// DİKKAT: wdt:P54 (truthy görünüm) burada KULLANILMAZ. Wikidata'nın SPARQL servisindeki
// truthy indeksi bazı oyuncularda NormalRank kayıtları eksik döndürüyor (örn. Q701297 Mateo
// Kovačić, Q11571 Cristiano Ronaldo Real Madrid kayıtlarıyla hiç görünmüyordu; bkz. p:P54
// statement görünümünde kayıtlar mevcut). Bu yüzden statement görünümü + rank filtresi kullanılıyor.
async function fetchMemberships(clubs) {
  console.log('Kulüp-oyuncu ilişkileri çekiliyor...');
  return cachedById('members-v2', clubs.map((c) => c.id), CLUB_BATCH, async (batch) => {
    const r = await sparql(`
      SELECT ?c ?p ?pl WHERE {
        VALUES ?c { ${batch.map((id) => `wd:${id}`).join(' ')} }
        ?p p:P54 ?st; wdt:P31 wd:Q5; wikibase:sitelinks ?pl.
        ?st ps:P54 ?c; wikibase:rank ?rank.
        FILTER(?rank != wikibase:DeprecatedRank)
      }`);
    await sleep(500);
    return r.map((x) => [qid(x.c.value), qid(x.p.value), Number(x.pl.value)]);
  });
}

async function fetchLabels(ids, kind) {
  console.log(`${kind} isimleri çekiliyor (${ids.length})...`);
  const rows = await cachedById(`labels-${kind}`, ids, LABEL_BATCH, async (batch) => {
    const r = await sparql(`
      SELECT ?x ?l ?kind WHERE {
        VALUES ?x { ${batch.map((id) => `wd:${id}`).join(' ')} }
        { ?x rdfs:label ?l. BIND("label" AS ?kind) }
        UNION
        { ?x skos:altLabel ?l. BIND("alias" AS ?kind) }
        FILTER(LANG(?l) IN (${LANGS.map((l) => `"${l}"`).join(', ')}))
      }`);
    await sleep(300);
    return r.map((x) => [qid(x.x.value), x.l.value, x.l['xml:lang'], x.kind.value]);
  });
  const labels = new Map(); // id -> { tr, en, mul, aliases:Set }
  for (const [id, text, lang, k] of rows) {
    if (!labels.has(id)) labels.set(id, { aliases: new Set() });
    const entry = labels.get(id);
    if (k === 'label') entry[lang] = text;
    else entry.aliases.add(text);
  }
  return labels;
}

function pickName(entry) {
  return entry?.tr || entry?.en || entry?.mul || null;
}

// Wikidata'nın henüz işlemediği transferler için elle düzeltmeler (data/overrides.json).
// Format: { "add": { "<oyuncu QID>": ["<kulüp QID>", ...] }, "remove": { ... } }
async function applyOverrides(clubs, playerClubs) {
  let overrides;
  try {
    overrides = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'overrides.json'), 'utf8'));
  } catch {
    return; // dosya yoksa geç
  }
  const clubIds = new Set(clubs.map((c) => c.id));
  let applied = 0;
  for (const [pid, add] of Object.entries(overrides.add ?? {})) {
    const set = playerClubs.get(pid);
    if (!set) continue; // oyuncu Wikidata verisinde hiç yoksa dokunma
    for (const cid of add) {
      if (!clubIds.has(cid)) { console.warn(`  override uyarısı: kulüp listede yok, atlandı: ${cid}`); continue; }
      if (!set.has(cid)) { set.add(cid); applied++; }
    }
  }
  for (const [pid, remove] of Object.entries(overrides.remove ?? {})) {
    const set = playerClubs.get(pid);
    if (!set) continue;
    for (const cid of remove) if (set.delete(cid)) applied++;
  }
  if (applied) console.log(`  ${applied} elle düzeltme uygulandı (overrides.json)`);
}

function aliasList(entry, name) {
  const all = new Set([entry.tr, entry.en, entry.mul, ...entry.aliases].filter(Boolean));
  all.delete(name);
  return [...all];
}

async function main() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.mkdir(path.dirname(OUT_FILE), { recursive: true });

  const allClubs = await cached('clubs-v2', fetchClubs);
  const clubLabels = await fetchLabels(allClubs.map((c) => c.id), 'kulup');
  const clubs = allClubs.filter((c) => {
    const e = clubLabels.get(c.id);
    return e && ![e.tr, e.en, e.mul].some((n) => n && EXCLUDED_CLUB_NAME.test(n));
  });
  console.log(`  ${allClubs.length - clubs.length} kulüp elendi (milli/B/gençlik/kadın), ${clubs.length} kaldı`);
  const pairs = await fetchMemberships(clubs);

  // Sadece seçili kulüplerden en az ikisinde oynamış oyuncular oyunda cevap olabilir
  const playerClubs = new Map();
  const playerPop = new Map();
  for (const [c, p, pl] of pairs) {
    if (!playerClubs.has(p)) playerClubs.set(p, new Set());
    playerClubs.get(p).add(c);
    playerPop.set(p, pl);
  }
  applyOverrides(clubs, playerClubs);
  const playerIds = [...playerClubs.keys()].filter((p) => playerClubs.get(p).size >= 2);
  console.log(`  ${playerClubs.size} oyuncu bulundu, ${playerIds.length} tanesi en az 2 kulüpte oynamış`);

  const countryIds = [...new Set(clubs.map((c) => c.country).filter(Boolean))];
  const countryLabels = await fetchLabels(countryIds, 'ulke');
  const playerLabels = await fetchLabels(playerIds, 'oyuncu');

  const outClubs = clubs
    .map((c) => {
      const entry = clubLabels.get(c.id);
      const name = pickName(entry);
      if (!name) return null;
      return {
        id: c.id,
        name,
        aliases: aliasList(entry, name),
        country: pickName(countryLabels.get(c.country)) || '',
        pop: c.pop,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.pop - a.pop);
  const clubIndex = new Map(outClubs.map((c, i) => [c.id, i]));

  const outPlayers = playerIds
    .map((p) => {
      const entry = playerLabels.get(p);
      const name = pickName(entry);
      if (!name) return null;
      const cl = [...playerClubs.get(p)].map((c) => clubIndex.get(c)).filter((i) => i !== undefined);
      if (cl.length < 2) return null;
      return { id: p, name, aliases: aliasList(entry, name), pop: playerPop.get(p), clubs: cl };
    })
    .filter(Boolean)
    .sort((a, b) => b.pop - a.pop);

  const out = { builtAt: new Date().toISOString(), clubs: outClubs, players: outPlayers };
  await fs.writeFile(OUT_FILE, JSON.stringify(out));
  const size = (await fs.stat(OUT_FILE)).size;
  console.log(`Bitti: ${outClubs.length} kulüp, ${outPlayers.length} oyuncu, ${(size / 1e6).toFixed(1)} MB -> ${OUT_FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
