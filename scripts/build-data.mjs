// Wikidata'dan kulüp ve oyuncu verisini çekip data/football.json dosyasına yazar.
// Kullanım: npm run build-data   (birkaç dakika sürer, ara sonuçlar scripts/.cache altında saklanır)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { normalize } from '../public/normalize.js';

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

// ---------- Transfermarkt transfer geçmişi ----------
// Wikidata'nın P54 kulüp kayıtları son dönem transferlerinin yarısından çoğunu kaçırıyor.
// Bu yüzden dcaribou/transfermarkt-datasets (CC0) transfer tablosu ikincil kaynak olarak
// birleştirilir. Veri seti 6 Temmuz 2026'da donmuş durumda; güncellenirse önbellek dosyası
// silinip yeniden indirilir.
const TM_TRANSFERS_URL = 'https://pub-e682421888d945d684bcae8890b0ec20.r2.dev/data/transfers.csv.gz';

function parseCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

async function fetchTmTransfers() {
  const file = path.join(CACHE_DIR, 'tm-transfers.csv.gz');
  let buf;
  try {
    buf = await fs.readFile(file);
  } catch {
    console.log('  Transfermarkt veri seti indiriliyor (~5 MB)...');
    const res = await fetch(TM_TRANSFERS_URL);
    if (!res.ok) throw new Error(`indirme hatası ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(file, buf);
  }
  const raw = gunzipSync(buf).toString('utf8');
  const lines = raw.split('\n');
  const header = lines[0].split(',').map((h) => h.replace(/"/g, ''));
  const col = (name) => header.indexOf(name);
  const today = new Date().toISOString().slice(0, 10);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const v = parseCsvLine(lines[i]);
    const date = v[col('transfer_date')];
    if (!date || date > today) continue; // gelecek tarihli ön sözleşmeler sayılmaz
    out.push({
      playerId: v[col('player_id')],
      player: v[col('player_name')],
      from: v[col('from_club_name')],
      to: v[col('to_club_name')],
    });
  }
  return out;
}

// TM kulüp adları ("Bayern Munich", "Mainz") bizim kulüplerle eşlenir.
// Önce tam isim/takma ad eşleşmesi, olmazsa belirgin kelime alt kümesi eşleşmesi.
// Dönüş: kulübün Wikidata kimliği veya null. (playerClubs kulübü kimlik olarak saklar.)
const GENERIC_CLUB_TOKENS = new Set(['fc', 'cf', 'ac', 'sc', 'afc', 'cfc', 'if', 'bk', 'fk', 'sk', 'ik', 'cd', 'ud', 'sd', 'as', 'ss', 'us', 'club', 'de', 'the', 'football', 'futbol', 'spor', 'kulubu', 'calcio', 'fussball']);

function buildClubMatcher(clubs) {
  const byName = new Map();
  const tokenSets = [];
  clubs.forEach((c, i) => {
    const names = [...new Set([c.name, ...c.aliases].map(normalize).filter(Boolean))];
    for (const n of names) {
      if (!byName.has(n)) byName.set(n, new Set());
      byName.get(n).add(i);
    }
    tokenSets.push(new Set([...new Set(names.flatMap((n) => n.split(' ')))].filter((t) => !GENERIC_CLUB_TOKENS.has(t))));
  });
  return (name) => {
    const k = normalize(name);
    if (!k) return null;
    const direct = byName.get(k);
    if (direct) return direct.size === 1 ? clubs[[...direct][0]].id : null;
    const toks = [...new Set(k.split(' ').filter((t) => !GENERIC_CLUB_TOKENS.has(t)))];
    if (!toks.length) return null;
    let hit = -1;
    for (let i = 0; i < tokenSets.length; i++) {
      if (toks.every((t) => tokenSets[i].has(t))) {
        if (hit >= 0) return null; // birden fazla kulüple eşleşiyor, belirsiz
        hit = i;
      }
    }
    return hit >= 0 ? clubs[hit].id : null;
  };
}

// Önceki build'in oyuncu listesiyle isim -> kimlik eşleşmesi (ikincil kaynakları bağlamak için)
function buildPlayerMatcher(prevPlayers) {
  const byName = new Map();
  const add = (n, id) => {
    const k = normalize(n);
    if (!k) return;
    if (!byName.has(k)) byName.set(k, []);
    const arr = byName.get(k);
    if (!arr.includes(id)) arr.push(id);
  };
  for (const p of prevPlayers) for (const n of [p.name, ...p.aliases]) add(n, p.id);
  return byName;
}

async function loadPrevPlayers() {
  try {
    const prev = JSON.parse(await fs.readFile(OUT_FILE, 'utf8'));
    return prev.players ?? [];
  } catch {
    return [];
  }
}

// Transfermarkt transferlerini Wikidata verisiyle birleştirir.
// Dönüş: tm- kimlikli yeni oyuncuların isim haritası.
async function mergeTmTransfers(clubs, playerClubs, playerPop, playerByName) {
  console.log('Transfermarkt transfer geçmişi birleştiriliyor...');
  const tmNames = new Map();
  try {
    const transfers = await fetchTmTransfers();
    const matchClub = buildClubMatcher(clubs);

    const clubCache = new Map();
    const resolveClub = (name) => {
      if (!clubCache.has(name)) clubCache.set(name, matchClub(name));
      return clubCache.get(name);
    };

    // TM oyuncu kimliğine göre tüm transferleri topla
    const tmPlayers = new Map();
    for (const t of transfers) {
      if (!t.playerId || !t.player) continue;
      const from = t.from ? resolveClub(t.from) : null;
      const to = t.to ? resolveClub(t.to) : null;
      if (!from && !to) continue;
      if (!tmPlayers.has(t.playerId)) tmPlayers.set(t.playerId, { name: t.player, clubs: new Set() });
      const p = tmPlayers.get(t.playerId);
      if (from) p.clubs.add(from);
      if (to) p.clubs.add(to);
    }

    let added = 0, created = 0, ambiguous = 0;
    for (const [tmId, tp] of tmPlayers) {
      const candidates = playerByName.get(normalize(tp.name)) ?? [];
      let target = null;
      if (candidates.length === 1) target = candidates[0];
      else if (candidates.length > 1) {
        // Aynı isimde birden fazla oyuncu varsa kulüp örtüşmesiyle ayıkla
        const withOverlap = candidates.filter((id) => {
          const set = playerClubs.get(id);
          return set && [...tp.clubs].some((c) => set.has(c));
        });
        if (withOverlap.length === 1) target = withOverlap[0];
        else ambiguous++;
      }
      if (target) {
        const set = playerClubs.get(target);
        if (!set) continue;
        for (const c of tp.clubs) if (!set.has(c)) { set.add(c); added++; }
      } else if (!candidates.length && tp.clubs.size >= 2) {
        // Wikidata'da hiç bulunmayan oyuncu: en az 2 seçilebilir kulübü varsa oyuna ekle
        const id = `tm-${tmId}`;
        playerClubs.set(id, new Set(tp.clubs));
        playerPop.set(id, 0);
        tmNames.set(id, tp.name);
        created++;
      }
    }
    console.log(`  ${added} kulüp kaydı eklendi, ${created} yeni oyuncu, ${ambiguous} belirsiz isim atlandı`);
  } catch (err) {
    console.warn('  Transfermarkt birleşimi atlandı:', err.message);
  }
  return tmNames;
}

// ---------- Wikipedia güncel kadroları ----------
// Kulüplerin İngilizce Wikipedia kadro şablonları ("Template:X squad") transferlerden
// günler sonra güncellenir; Wikidata'nın eksik kaldığı güncel kayıtları buradan alınır.

const WIKI_UA = '321-game-data-builder/1.0 (hobby football quiz)';

async function wikiApi(params, attempt = 1) {
  const url = new URL('https://en.wikipedia.org/w/api.php');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('maxlag', '5');
  const res = await fetch(url, { headers: { 'User-Agent': WIKI_UA } });
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 6) throw new Error(`Wikipedia API ${res.status}`);
    const retryAfter = Number(res.headers.get('retry-after')) || 0;
    const wait = Math.max(retryAfter * 1000, 2000 * 2 ** attempt);
    console.warn(`  Wikipedia API ${res.status}, ${Math.round(wait / 1000)} sn bekleniyor...`);
    await sleep(wait);
    return wikiApi(params, attempt + 1);
  }
  if (!res.ok) throw new Error(`Wikipedia API ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`Wikipedia API: ${j.error.info}`);
  await sleep(250);
  return j;
}

async function wikidataApi(params, attempt = 1) {
  const url = new URL('https://www.wikidata.org/w/api.php');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 6) throw new Error(`Wikidata API ${res.status}`);
    const retryAfter = Number(res.headers.get('retry-after')) || 0;
    const wait = Math.max(retryAfter * 1000, 2000 * 2 ** attempt);
    console.warn(`  Wikidata API ${res.status}, ${Math.round(wait / 1000)} sn bekleniyor...`);
    await sleep(wait);
    return wikidataApi(params, attempt + 1);
  }
  if (!res.ok) throw new Error(`Wikidata API ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`Wikidata API: ${j.error.info}`);
  await sleep(200);
  return j;
}

// Sayfaların wikitext'ini 25'li gruplar halinde çeker. Dönüş: sayfa başlığı -> wikitext
async function fetchWikitexts(titles) {
  const out = new Map();
  for (const batch of chunk(titles, 25)) {
    const j = await wikiApi({
      action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main',
      format: 'json', formatversion: '2', titles: batch.join('|'),
    });
    for (const page of j.query?.pages ?? []) {
      if (page.missing) continue;
      const content = page.revisions?.[0]?.slots?.main?.content;
      if (typeof content === 'string') out.set(page.title, content);
    }
  }
  return out;
}

// Kadro satırları: {{football squad2 player|no=1|name=[[Oyuncu Adı|Kısa Ad]]}} vb.
// (bir seviye iç içe şablon toleransıyla, örn. name={{flagicon|...}} [[Oyuncu]])
const SQUAD_ROW_RE = /\{\{(?:football\s+squad2?\s+player|fs\d?\s+player)\s*\|(?:[^{}]|\{\{[^{}]*\}\})*?\}\}/gi;

function parseSquadPlayerTitles(wikitext) {
  const titles = [];
  for (const m of wikitext.matchAll(SQUAD_ROW_RE)) {
    const at = m[0].search(/\|\s*name\s*=/i);
    if (at < 0) continue;
    const link = m[0].slice(at).match(/\[\[([^\]|]+)/);
    if (!link) continue;
    const t = link[1].trim();
    if (t && !/^(file|image|category):/i.test(t)) titles.push(t);
  }
  return titles;
}

// Makalede geçilen kulübe özel kadro şablonlarını bulur ("{{Beşiktaş J.K. squad}}" gibi)
function findSquadTemplateNames(wikitext) {
  const names = new Set();
  for (const m of wikitext.matchAll(/\{\{([^{}\n]{0,150})\}\}/g)) {
    const head = m[1].split('|')[0].trim();
    if (!/\bsquad\b/i.test(head)) continue;
    if (/^(football squad2? player|fs\d? player|football squad|fs|sports roster)$/i.test(head)) continue;
    if (head.includes('=')) continue;
    names.add(head);
  }
  return [...names];
}

async function applyWikiSquads(clubs, playerClubs, playerByName) {
  console.log('Wikipedia güncel kadroları çekiliyor...');
  try {
    // Kulüp Wikidata kimliği -> İngilizce Wikipedia makale başlığı (önbellekli)
    const clubTitle = await clubWikiTitles(clubs);

    // Kulüp makalelerini çek, satır içi kadroları ve geçilen şablonları bul
    const articleTitles = clubs.map((c) => clubTitle.get(c.id)).filter(Boolean);
    console.log(`  ${articleTitles.length} kulüp makalesi okunuyor...`);
    const articles = await fetchWikitexts(articleTitles);

    const inlinePlayers = new Map(); // clubIdx -> oyuncu başlıkları
    const clubTemplate = new Map();  // clubIdx -> kadro şablonu adı
    let clubsRead = 0;
    clubs.forEach((c, i) => {
      const wikitext = clubTitle.get(c.id) ? articles.get(clubTitle.get(c.id)) : null;
      if (!wikitext) return;
      clubsRead++;
      const players = parseSquadPlayerTitles(wikitext);
      if (players.length) inlinePlayers.set(i, players);
      const tpl = findSquadTemplateNames(wikitext);
      if (tpl.length) clubTemplate.set(i, tpl[0]);
    });

    // Kadro şablonu sayfalarını çek
    const templateTitles = [...new Set([...clubTemplate.values()])];
    const templates = templateTitles.length
      ? await fetchWikitexts(templateTitles.map((t) => `Template:${t}`))
      : new Map();

    const squadPlayers = new Map();
    for (const [i, players] of inlinePlayers) squadPlayers.set(i, [...players]);
    for (const [i, tpl] of clubTemplate) {
      const rows = parseSquadPlayerTitles(templates.get(`Template:${tpl}`) ?? '');
      if (rows.length) squadPlayers.set(i, [...(squadPlayers.get(i) ?? []), ...rows]);
    }

    // Oyuncu başlıklarını kimliğe çözümle: önce isim eşleşmesi, kalanı Wikidata API'siyle
    const allTitles = new Set();
    for (const list of squadPlayers.values()) for (const t of list) allTitles.add(t);
    const titleToQid = new Map();
    const unresolved = [];
    for (const t of allTitles) {
      const candidates = playerByName.get(normalize(t));
      if (candidates?.length === 1) titleToQid.set(t, candidates[0]);
      else unresolved.push(t);
    }
    if (unresolved.length) {
      console.log(`  ${unresolved.length} oyuncu başlığı Wikidata ile çözümleniyor...`);
      const rows = await cachedById('wiki-player-qids', unresolved, 50, async (batch) => {
        const j = await wikidataApi({ action: 'wbgetentities', sites: 'enwiki', titles: batch.join('|'), props: 'info', format: 'json' });
        const byTitle = new Map();
        for (const [qid, ent] of Object.entries(j.entities ?? {})) if (ent?.title) byTitle.set(ent.title, qid);
        const norm = new Map((j.normalize ?? []).map((n) => [n.from, n.to]));
        const out = [];
        for (const t of batch) {
          const qid = byTitle.get(norm.get(t) ?? t);
          if (qid) out.push([t, qid]);
        }
        return out;
      });
      for (const [t, qid] of rows) titleToQid.set(t, qid);
    }

    let added = 0;
    for (const [clubIdx, titles] of squadPlayers) {
      const clubQid = clubs[clubIdx].id;
      for (const t of titles) {
        const qid = titleToQid.get(t);
        if (!qid || !playerClubs.has(qid)) continue;
        const set = playerClubs.get(qid);
        if (!set.has(clubQid)) { set.add(clubQid); added++; }
      }
    }
    console.log(`  ${clubsRead} kulübün kadrosu okundu, ${added} oyuncu-kulüp ilişkisi eklendi`);
  } catch (err) {
    console.warn('  Wikipedia kadro taraması atlandı:', err.message);
  }
}

// Kulüp Wikidata kimliği -> İngilizce Wikipedia makale başlığı (önbellekli, kadro taramasıyla ortak)
async function clubWikiTitles(clubs) {
  const rows = await cachedById('club-wiki-titles', clubs.map((c) => c.id), 50, async (batch) => {
    const j = await wikidataApi({ action: 'wbgetentities', ids: batch.join('|'), props: 'sitelinks', format: 'json' });
    const out = [];
    for (const [qid, ent] of Object.entries(j.entities ?? {})) {
      const t = ent?.sitelinks?.enwiki?.title;
      if (t) out.push([qid, t]);
    }
    return out;
  });
  return new Map(rows);
}

// ---------- Kulüp logoları ----------
// Kulübün İngilizce Wikipedia makalesinin sayfa görseli (neredeyse her zaman kulüp arması)
// 144 px küçük resim URL'si olarak saklanır. Görseli olmayan kulüpte logo null kalır, oyun onsuz devam eder.
async function fetchClubLogos(clubs) {
  console.log('Kulüp logoları çekiliyor...');
  try {
    const titleByQid = await clubWikiTitles(clubs);
    const logoRows = await cachedById('club-logos-v2', clubs.map((c) => c.id), 50, async (batch) => {
      const titles = batch.map((id) => titleByQid.get(id)).filter(Boolean);
      if (!titles.length) return [];
      const j = await wikiApi({
        action: 'query', prop: 'pageimages', piprop: 'thumbnail', pithumbsize: '144',
        pilicense: 'any', // varsayılan 'free' çoğu kulüp armasını (fair use) eler
        format: 'json', formatversion: '2', titles: titles.join('|'),
      });
      const urlByTitle = new Map();
      for (const page of j.query?.pages ?? []) {
        if (page.thumbnail?.source) urlByTitle.set(page.title, page.thumbnail.source);
      }
      return batch
        .filter((id) => titleByQid.has(id) && urlByTitle.has(titleByQid.get(id)))
        .map((id) => [id, urlByTitle.get(titleByQid.get(id))]);
    });
    const logos = new Map(logoRows);
    console.log(`  ${logos.size}/${clubs.length} kulüp için logo bulundu`);
    return logos;
  } catch (err) {
    console.warn('  Logo taraması atlandı:', err.message);
    return new Map();
  }
}

// ---------- Oyuncu uyrukları ----------
// Ülke modunda "takımda oynamış + ülke vatandaşı" kesişimi için Wikidata P27 (country of citizenship).
// Çift uyruklu oyuncular için birden çok ülke kaydedilir. tm- önekli oyuncular Wikidata'da olmadığından
// uyruksuz kalır; ülke modunda cevap olamazlar ama klasik modu etkilemez.
// Oyuncu uyrukları (P27) oyun için sadeleştirilir: tarihsel devletler modern haleflerine
// eşlenir (Hollanda Krallığı -> Hollanda, Alman devletleri -> Almanya…). SSCB, Çekoslovakya,
// Osmanlı gibi futbol tarihinde anlamlı olanlar olduğu gibi kalır.
const COUNTRY_FIX = {
  Q174193: 'Q145', Q21: 'Q145', Q22: 'Q145', // İngiltere/İskoçya dahil eski BK -> Birleşik Krallık
  Q29999: 'Q55', // Hollanda Krallığı -> Hollanda
  Q172579: 'Q38', // İtalya Krallığı -> İtalya
  Q713750: 'Q183', Q1206012: 'Q183', Q7318: 'Q183', Q43287: 'Q183', Q41304: 'Q183', // Alman devletleri -> Almanya
  Q832861: 'Q36704', Q191077: 'Q36704', Q15102440: 'Q36704', // Yugoslavya varyantları -> Yugoslavya
  Q154401: 'Q214', // Slovakya Cumhuriyeti -> Slovakya
  Q618399: 'Q971', Q6500954: 'Q974', // Kongo/Zaire varyantları
  Q2017684: 'Q948', Q457242: 'Q1028', // Tunus/Fas protektoraları
  Q217169: 'Q954', Q890120: 'Q954', // Rodezya -> Zimbabve
  Q15240466: 'Q229', // Britanya Kıbrısı -> Kıbrıs
  Q129286: 'Q668', Q1775277: 'Q668', // Britanya Hindistanı -> Hindistan
  Q1054923: 'Q8646', // Britanya Hong Kongu -> Hong Kong
  Q6744657: 'Q233', Q7603765: 'Q233', // Malta varyantları
  Q243610: 'Q212', Q133356: 'Q212', Q1508143: 'Q212', // Ukrayna varyantları
  Q130229: 'Q230', Q132856: 'Q399', Q2895: 'Q184', Q2184: 'Q159', // Sovyet cumhuriyetleri
  Q107258515: 'Q794', // Pehlevi İranı -> İran
  Q127861: 'Q79', Q170468: 'Q79', // Mısır Hidivliği/BAC -> Mısır
  Q45670: 'Q45', // Portekiz Krallığı
  Q171150: 'Q28', Q600018: 'Q28', // Macaristan Krallığı
};

// Aramada yazılış farklılıklarını yakalamak için el yapımı eş anlamlılar (Wikidata'dan gelmez)
const COUNTRY_ALIASES = {
  Q145: ['İngiltere', 'Britanya', 'UK', 'Büyük Britanya'],
  Q30: ['ABD', 'Amerika'],
  Q15180: ['SSCB', 'Sovyet', 'Sovyetler Birliği'],
  Q974: ['Zaire', 'Kongo Kinşasa', 'Demokratik Kongo'],
  Q971: ['Kongo Brazzaville', 'Kongo Cumhuriyeti'],
  Q878: ['BAE', 'UAE'],
};

// Oyuncunun SPOR ulusalitesi (P1532): futbolcu olarak hangi ülkeyi temsil ettiği.
// P27'den (yasal vatandaşlık) önce gelir: Kaká, Messi, Di María gibi Güney Amerikalı
// oyuncuların İtalyan/İspanyol pasaportları oyunu yanıltır; oyuncular için "İtalyan"
// denince anlaşılan şey milli takım ülkesidir. P1532'si olmayanlar (milli olmayanlar)
// P27'ye düşer.
async function fetchPlayerSportCountries(playerIds) {
  console.log('Oyuncu spor ulusaliteleri çekiliyor (P1532)...');
  const qids = playerIds.filter((id) => /^Q\d+$/.test(id));
  const rows = await cachedById('player-sport-countries-v1', qids, 400, async (batch) => {
    const r = await sparql(`
      SELECT ?p ?country WHERE {
        VALUES ?p { ${batch.map((id) => `wd:${id}`).join(' ')} }
        ?p wdt:P1532 ?country.
      }`);
    await sleep(300);
    return r.map((x) => [qid(x.p.value), qid(x.country.value)]);
  });
  const map = new Map(); // oyuncu kimliği -> Set(ülke kimliği)
  for (const [p, c] of rows) {
    if (!map.has(p)) map.set(p, new Set());
    map.get(p).add(c);
  }
  // Tarihsel devletleri modern haleflerine indir (İngiltere/İskoçya -> Birleşik Krallık dahil)
  for (const [p, set] of map) map.set(p, new Set([...set].map((c) => COUNTRY_FIX[c] ?? c)));
  console.log(`  ${map.size}/${qids.length} oyuncunun spor ulusalitesi bulundu`);
  return map;
}

async function fetchPlayerCountries(playerIds) {
  console.log('Oyuncu uyrukları çekiliyor...');
  const qids = playerIds.filter((id) => /^Q\d+$/.test(id));
  const rows = await cachedById('player-countries-v1', qids, 400, async (batch) => {
    const r = await sparql(`
      SELECT ?p ?country WHERE {
        VALUES ?p { ${batch.map((id) => `wd:${id}`).join(' ')} }
        ?p wdt:P27 ?country.
      }`);
    await sleep(300);
    return r.map((x) => [qid(x.p.value), qid(x.country.value)]);
  });
  const map = new Map(); // oyuncu kimliği -> Set(ülke kimliği)
  for (const [p, c] of rows) {
    if (!map.has(p)) map.set(p, new Set());
    map.get(p).add(c);
  }
  // Tarihsel devletleri modern haleflerine indir
  for (const [p, set] of map) map.set(p, new Set([...set].map((c) => COUNTRY_FIX[c] ?? c)));
  console.log(`  ${map.size}/${qids.length} oyuncunun uyruğu bulundu`);
  return map;
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
  const clubLogos = await fetchClubLogos(clubs);

  // Sadece seçili kulüplerden en az ikisinde oynamış oyuncular oyunda cevap olabilir
  const playerClubs = new Map();
  const playerPop = new Map();
  for (const [c, p, pl] of pairs) {
    if (!playerClubs.has(p)) playerClubs.set(p, new Set());
    playerClubs.get(p).add(c);
    playerPop.set(p, pl);
  }
  // İkincil kaynaklar: Transfermarkt transfer geçmişi + Wikipedia güncel kadroları
  // (isim eşleştirme için kulüplere isimlerini ekle; sıra playerClubs indeksleriyle aynı kalmalı)
  const namedClubs = clubs.map((c) => {
    const entry = clubLabels.get(c.id);
    const name = pickName(entry);
    return { id: c.id, name: name ?? '', aliases: entry ? aliasList(entry, name) : [] };
  });
  const prevPlayers = await loadPrevPlayers();
  const playerByName = buildPlayerMatcher(prevPlayers);
  const tmNames = await mergeTmTransfers(namedClubs, playerClubs, playerPop, playerByName);
  await applyWikiSquads(clubs, playerClubs, playerByName);
  await applyOverrides(clubs, playerClubs);
  const playerIds = [...playerClubs.keys()].filter((p) => playerClubs.get(p).size >= 2);
  console.log(`  ${playerClubs.size} oyuncu bulundu, ${playerIds.length} tanesi en az 2 kulüpte oynamış`);

  // Sadece Wikidata kimlikli oyuncular için etiket çekilir (tm- önekli olanların ismi Transfermarkt'tan gelir)
  const playerLabels = await fetchLabels(playerIds.filter((id) => /^Q\d+$/.test(id)), 'oyuncu');
  const playerCountries = await fetchPlayerCountries(playerIds);
  const playerSportCountries = await fetchPlayerSportCountries(playerIds);
  // Spor ulusalitesi (P1532) varsa o geçerli, yoksa yasal vatandaşlığa (P27) düşülür
  const effectiveCountries = new Map();
  for (const id of playerIds) {
    const set = playerSportCountries.get(id) ?? playerCountries.get(id);
    if (set && set.size) effectiveCountries.set(id, set);
  }

  // Ülke listesi: oyuncuların (etkili) ulusalitelerinden, oyuncu sayısına (popülerliğe) göre sıralı.
  // 3'ten az oyuncusu olanlar (şehir/ülke karışması, tek oyunculu ülkeler) seçilebilir listeden çıkarılır.
  const countryCount = new Map();
  for (const set of effectiveCountries.values()) for (const c of set) countryCount.set(c, (countryCount.get(c) ?? 0) + 1);
  const countryIds = [...new Set([...clubs.map((c) => c.country).filter(Boolean), ...countryCount.keys()])];
  const countryLabels = await fetchLabels(countryIds, 'ulke');
  const outCountries = [...countryCount.entries()]
    .filter(([, pop]) => pop >= 3)
    .map(([id, pop]) => {
      const name = pickName(countryLabels.get(id));
      return name ? { id, name, pop, aliases: COUNTRY_ALIASES[id] ?? [] } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.pop - a.pop);
  console.log(`  ${outCountries.length} ülke listelendi`);

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
        logo: clubLogos.get(c.id) ?? null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.pop - a.pop);
  const clubIndex = new Map(outClubs.map((c, i) => [c.id, i]));

  const outPlayers = playerIds
    .map((p) => {
      const entry = playerLabels.get(p);
      const name = pickName(entry) ?? tmNames.get(p);
      if (!name) return null;
      const cl = [...playerClubs.get(p)].map((c) => clubIndex.get(c)).filter((i) => i !== undefined);
      if (cl.length < 2) return null;
      return { id: p, name, aliases: entry ? aliasList(entry, name) : [], pop: playerPop.get(p) ?? 0, clubs: cl, countries: [...(effectiveCountries.get(p) ?? [])] };
    })
    .filter(Boolean)
    .sort((a, b) => b.pop - a.pop);

  const out = { builtAt: new Date().toISOString(), clubs: outClubs, countries: outCountries, players: outPlayers };
  await fs.writeFile(OUT_FILE, JSON.stringify(out));
  const size = (await fs.stat(OUT_FILE)).size;
  console.log(`Bitti: ${outClubs.length} kulüp, ${outPlayers.length} oyuncu, ${(size / 1e6).toFixed(1)} MB -> ${OUT_FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
