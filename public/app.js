import { normalize } from './normalize.js';

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
const connEl = document.getElementById('conn');

let ws = null;
let state = null;       // sunucudan gelen oda durumu
let clockOffset = 0;    // sunucu saati - yerel saat
let screenKey = null;   // ekran değişmediyse input'ları silmemek için
let clubs = [];         // [{i, name, country, keys}]
let playerNames = [];   // isim önerileri: popülerlik sırasıyla tüm oyuncu isimleri
let playerKeys = null;  // playerNames'in normalize edilmiş hâli (ilk kullanımda hesaplanır)
const seenGuesses = new Set(); // sadece yeni tahminler animasyonla gelsin

// İsim kalıcı (localStorage); oda bilgisi sekmeye özel (sessionStorage), böylece aynı tarayıcıda iki sekme iki ayrı oyuncu olabilir
const storage = (area) => ({
  get(k) { try { return window[area].getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? window[area].removeItem(k) : window[area].setItem(k, v); } catch {} },
});
const store = storage('localStorage');
const session = storage('sessionStorage');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel) => app.querySelector(sel);

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

// ---------- Bağlantı ----------

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    connEl.hidden = true;
    const code = session.get('room');
    const token = session.get('token');
    if (code && token) send({ t: 'rejoin', code, token });
  };
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = () => {
    if (state) connEl.hidden = false;
    setTimeout(connect, 1200);
  };
}

function send(msg) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
  else toast('Bağlantı bekleniyor…');
}

function onMessage(msg) {
  switch (msg.t) {
    case 'joined':
      session.set('room', msg.code);
      session.set('token', msg.token);
      history.replaceState(null, '', '/');
      break;
    case 'rejoinFailed':
    case 'left':
      session.set('room', null);
      session.set('token', null);
      state = null;
      render();
      break;
    case 'state':
      clockOffset = msg.state.now - Date.now();
      const prev = state;
      state = msg.state;
      render(prev);
      break;
    case 'error':
      toast(msg.msg);
      break;
  }
}

const serverNow = () => Date.now() + clockOffset;

// ---------- Ortak parçalar ----------

const me = () => state.players.find((p) => p.id === state.you);
const rival = () => state.players.find((p) => p.id !== state.you);

function scoreboard() {
  const a = me(), b = rival();
  return `
    <div class="scoreboard">
      <div class="sb-player">
        <span class="sb-name me">${esc(a.name)} (sen)</span>
        <span class="sb-score">${a.score}</span>
      </div>
      <div class="sb-mid">Tur ${state.round}<br>${state.target} puana</div>
      <div class="sb-player right">
        <span class="sb-name rival">${esc(b?.name ?? '—')}</span>
        <span class="sb-score">${b?.score ?? 0}</span>
        ${b && !b.online ? '<span class="offline">bağlantı yok</span>' : ''}
      </div>
    </div>`;
}

const timerBar = () => `<div class="timer" id="timer"><i></i></div>`;

// ---------- Ekranlar ----------

function render(prev) {
  const key = state ? `${state.phase}:${state.round}` : 'home';
  const same = key === screenKey;
  screenKey = key;

  if (!state) return same ? null : renderHome();
  const screens = { lobby: renderLobby, pick: renderPick, countdown: renderCountdown, guess: renderGuess, result: renderResult, over: renderResult };
  screens[state.phase](same, prev);
}

function renderHome() {
  const params = new URLSearchParams(location.search);
  const invited = params.get('oda') || '';
  app.innerHTML = `
    <div class="logo">3<span>·</span>2<span>·</span>1</div>
    <p class="tagline">Geri sayımdan sonra ikiniz de bir takım söylüyorsunuz.<br>
      <b>İki takımda da oynamış</b> bir futbolcuyu ilk yazan puanı alır.</p>
    <div class="card stack">
      <div>
        <label for="name">Adın</label>
        <input id="name" maxlength="16" autocomplete="nickname" placeholder="Adın" value="${esc(store.get('name') || '')}">
      </div>
      ${invited ? '' : '<button class="primary full" id="create">Oda kur</button><div class="divider">ya da odaya katıl</div>'}
      <div class="row">
        <input id="code" class="code" inputmode="numeric" maxlength="4" placeholder="Kod" value="${esc(invited)}">
        <button class="${invited ? 'primary' : ''}" id="join">Katıl</button>
      </div>
    </div>`;

  const name = () => {
    const v = $('#name').value.trim();
    if (!v) { toast('Önce adını yaz.'); $('#name').focus(); return null; }
    store.set('name', v);
    return v;
  };
  $('#create')?.addEventListener('click', () => { const n = name(); if (n) send({ t: 'create', name: n }); });
  $('#join').addEventListener('click', () => {
    const n = name();
    const code = $('#code').value.trim();
    if (!n) return;
    if (!/^\d{4}$/.test(code)) return toast('4 haneli oda kodunu yaz.');
    send({ t: 'join', code, name: n });
  });
  $('#code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#join').click(); });
}

function renderLobby() {
  const isHost = state.host === state.you;
  const full = state.players.length >= 2;
  const link = `${location.origin}/?oda=${state.code}`;
  app.innerHTML = `
    <div class="card stack center">
      <p class="muted">Oda kodu</p>
      <div class="room-code">${state.code}</div>
      <button class="full" id="share">Davet linkini paylaş</button>
    </div>
    <div class="card stack">
      <h3>Oyuncular</h3>
      <div class="player-list">
        ${state.players.map((p) => `
          <div class="player-chip"><span class="dot ${p.online ? '' : 'off'}"></span>
            ${esc(p.name)}${p.id === state.you ? ' <span class="muted">(sen)</span>' : ''}${p.id === state.host ? ' <span class="muted small">· kurucu</span>' : ''}
          </div>`).join('')}
        ${full ? '' : '<div class="player-chip waiting"><span class="spinner"></span> Rakip bekleniyor…</div>'}
      </div>
    </div>
    ${isHost ? `
      <div class="card stack">
        <div>
          <label for="target">Kaç puanda biter?</label>
          <select id="target">${[3, 5, 7, 10].map((n) => `<option ${n === state.target ? 'selected' : ''}>${n}</option>`).join('')}</select>
        </div>
        <button class="primary full" id="start" ${full ? '' : 'disabled'}>Başla</button>
      </div>` : `<p class="center muted">${full ? 'Kurucunun oyunu başlatması bekleniyor…' : ''}</p>`}
    <div class="grow"></div>
    <button class="link" id="leave">Odadan çık</button>`;

  $('#share').addEventListener('click', async () => {
    try {
      if (navigator.share) await navigator.share({ title: '3-2-1 Futbol', text: `Oda kodu: ${state.code}`, url: link });
      else { await navigator.clipboard.writeText(link); toast('Link kopyalandı'); }
    } catch {}
  });
  $('#start')?.addEventListener('click', () => send({ t: 'start', target: Number($('#target').value) }));
  $('#leave').addEventListener('click', leave);
}

function renderPick(same) {
  const mine = me(), other = rival();
  if (!same) {
    app.innerHTML = `
      ${scoreboard()}
      ${timerBar()}
      <div class="stack" id="pick-area"></div>
      <div class="status-line" id="rival-status"></div>`;
  }
  $('#rival-status').innerHTML = other.picked
    ? '✓ Rakip takımını seçti'
    : `<span class="spinner"></span> ${esc(other.name)} takım seçiyor…`;

  const area = $('#pick-area');
  if (mine.club) {
    area.innerHTML = `
      <div class="card picked-box">
        <p class="muted">Seçimin (rakip göremez)</p>
        <div class="club">${esc(mine.club.name)}</div>
        <p class="muted small">${esc(mine.club.country)}</p>
      </div>
      <button class="link" id="change">Değiştir</button>`;
    $('#change').addEventListener('click', () => { mine.club = null; renderPick(true); });
    return;
  }
  if ($('#club-search')) return; // arama kutusu zaten açık; yazılanı silme
  area.innerHTML = `
    <div>
      <p class="phase-title">Takımını seç</p>
      <p class="muted small">Rakibin hangi takımı seçtiğini geri sayımdan sonra göreceksin.</p>
    </div>
    <input id="club-search" placeholder="Takım ara: Galatasaray, Inter…" autocomplete="off" autocapitalize="off" spellcheck="false">
    <div class="results" id="club-results"></div>`;
  const input = $('#club-search');
  const update = () => {
    const found = searchClubs(input.value);
    $('#club-results').innerHTML = found.map((c) =>
      `<button class="club-opt" data-id="${c.id}"><span>${esc(c.name)}</span><small>${esc(c.country)}</small></button>`).join('');
  };
  input.addEventListener('input', update);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#club-results .club-opt')?.click(); });
  $('#club-results').addEventListener('click', (e) => {
    const btn = e.target.closest('.club-opt');
    if (!btn) return;
    const c = clubs.find((x) => x.id === btn.dataset.id);
    mine.club = { name: c.name, country: c.country };
    send({ t: 'pick', club: c.id });
    renderPick(true);
  });
  update();
  input.focus();
}

function searchClubs(q) {
  const n = normalize(q);
  if (!n) return clubs.slice(0, 8);
  const scored = [];
  for (const c of clubs) {
    let s = 0;
    for (const k of c.keys) {
      if (k.startsWith(n)) s = Math.max(s, 3);
      else if (k.includes(' ' + n)) s = Math.max(s, 2);
      else if (n.length >= 3 && k.includes(n)) s = Math.max(s, 1);
    }
    if (s) scored.push([s, c]);
    if (scored.length > 400) break;
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, 8).map((x) => x[1]); // aynı puanda popülerlik sırası korunur
}

// İsim önerisi araması: tüm oyuncu havuzunda (popülerlik sırası korunur).
// 3 = baştan eşleşme, 2 = kelime başlangıcı ("guler" -> "Arda Güler"), 1 = içerme.
function searchPlayers(q) {
  if (!playerNames.length) return [];
  if (!playerKeys) playerKeys = playerNames.map(normalize); // ilk kullanımda bir kere
  const n = normalize(q);
  if (n.length < 2) return [];
  const hits = [];
  for (let i = 0; i < playerKeys.length; i++) {
    const k = playerKeys[i];
    let s = 0;
    if (k.startsWith(n)) s = 3;
    else if (k.includes(' ' + n)) s = 2;
    else if (n.length >= 4 && k.includes(n)) s = 1;
    if (s) hits.push([s, i]);
  }
  hits.sort((a, b) => b[0] - a[0] || a[1] - b[1]); // aynı puanda popülerlik sırası
  return hits.slice(0, 8).map((x) => playerNames[x[1]]);
}

function renderCountdown(same) {
  if (!same) app.innerHTML = `${scoreboard()}<div class="countdown"><div class="count-num" id="count"></div></div>`;
}

function versus() {
  const a = me(), b = rival();
  return `
    <div class="versus">
      <div class="club-card me"><span class="who">${esc(a.name)}</span><span class="name">${esc(a.club?.name)}</span><span class="muted small">${esc(a.club?.country)}</span></div>
      <div class="vs">+</div>
      <div class="club-card rival"><span class="who">${esc(b.name)}</span><span class="name">${esc(b.club?.name)}</span><span class="muted small">${esc(b.club?.country)}</span></div>
    </div>`;
}

function renderGuess(same, prev) {
  if (!same) {
    app.innerHTML = `
      ${scoreboard()}
      ${versus()}
      ${timerBar()}
      <div class="guess-area">
        <form class="guess-form" id="guess-form" autocomplete="off">
          <input id="guess" placeholder="İki takımda da oynamış oyuncu…" autocomplete="off" autocapitalize="words" spellcheck="false" enterkeyhint="send">
          <button class="primary">Gönder</button>
        </form>
        <div class="suggest" id="suggest" hidden></div>
      </div>
      <div class="feed" id="feed"></div>`;

    // İsim önerileri (otomatik tamamlama). Liste tüm oyuncu havuzundan aranır,
    // geçerli cevapları ele vermez.
    const input = $('#guess');
    const sug = $('#suggest');
    let sugList = [], sugIdx = -1, sugTimer = null;

    const hideSuggest = () => {
      clearTimeout(sugTimer);
      sug.hidden = true;
      sugIdx = -1;
      sugList = [];
      sug.innerHTML = '';
    };
    const markSuggest = () => {
      [...sug.children].forEach((el, i) => el.classList.toggle('active', i === sugIdx));
      sug.children[sugIdx]?.scrollIntoView({ block: 'nearest' });
    };
    const updateSuggest = () => {
      clearTimeout(sugTimer);
      sugTimer = setTimeout(() => {
        sugList = searchPlayers(input.value);
        sugIdx = -1;
        if (!sugList.length) { sug.hidden = true; return; }
        sug.innerHTML = sugList.map((nm, i) => `<button type="button" data-i="${i}">${esc(nm)}</button>`).join('');
        sug.hidden = false;
      }, 70);
    };
    const pickSuggestion = (name) => {
      input.value = name;
      hideSuggest();
      $('#guess-form').requestSubmit();
    };

    input.addEventListener('input', updateSuggest);
    input.addEventListener('keydown', (e) => {
      if (sug.hidden || !sugList.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); sugIdx = (sugIdx + 1) % sugList.length; markSuggest(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sugIdx = (sugIdx - 1 + sugList.length) % sugList.length; markSuggest(); }
      else if (e.key === 'Enter' && sugIdx >= 0) { e.preventDefault(); pickSuggestion(sugList[sugIdx]); }
      else if (e.key === 'Escape') hideSuggest();
    });
    // Öneriye tıklarken input odağı kaymasın (mobilde klavye kaplanmasın)
    sug.addEventListener('mousedown', (e) => e.preventDefault());
    sug.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-i]');
      if (btn) pickSuggestion(sugList[Number(btn.dataset.i)]);
    });
    input.addEventListener('blur', () => setTimeout(hideSuggest, 150));

    $('#guess-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      hideSuggest();
      send({ t: 'guess', text });
      input.value = '';
      input.focus();
    });
    $('#feed').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-accept]');
      if (btn) send({ t: 'accept', guessId: Number(btn.dataset.accept) });
    });
    input.focus();
    navigator.vibrate?.(80);
  }

  const prevCount = prev?.phase === 'guess' ? prev.guesses.length : 0;
  const latest = state.guesses[state.guesses.length - 1];
  if (latest && state.guesses.length > prevCount && latest.by === state.you && !latest.ok) {
    const form = $('#guess-form');
    form.classList.remove('shake');
    void form.offsetWidth;
    form.classList.add('shake');
  }

  $('#feed').innerHTML = state.guesses.map((g) => {
    const mine = g.by === state.you;
    const who = mine ? 'Sen' : esc(rival().name);
    return `
      <div class="feed-item ${mine ? 'mine' : 'theirs'}${seenGuesses.has(g.id) ? '' : ' new'}">
        <div class="top">
          <span><span class="who">${who}</span> · <span class="txt">${esc(g.text)}</span></span>
          ${mine ? '' : `<button data-accept="${g.id}" title="Bu cevabı doğru say, puan rakibe gitsin">Doğru say</button>`}
        </div>
        ${mine && g.note ? `<div class="note">${esc(g.note)}</div>` : ''}
      </div>`;
  }).join('');
  state.guesses.forEach((g) => seenGuesses.add(g.id));
}

function renderResult() {
  const r = state.result;
  const a = me(), b = rival();
  const over = state.phase === 'over';
  const iWon = r.winner === state.you;
  const winnerName = r.winner ? state.players.find((p) => p.id === r.winner)?.name : null;

  let cls = 'none', title, sub = '';
  if (r.reason === 'sameClub') {
    title = 'Aynı takım!';
    sub = 'İkiniz de aynı takımı seçtiniz, tur iptal. Yeni turda farklı takımlar seçin.';
  } else if (r.reason === 'noCommon') {
    title = 'Ortak oyuncu yok';
    sub = 'Verilere göre bu iki takımda birden oynamış futbolcu bulunamadı. Tur geçersiz.';
  } else if (r.reason === 'timeout') {
    title = 'Süre doldu';
    sub = 'Kimse bulamadı.';
  } else {
    cls = iWon ? 'win' : 'lose';
    title = iWon ? 'Sen buldun! +1' : `${esc(winnerName)} buldu`;
    const said = r.guess?.player ? r.guess.player.name : r.guess?.text;
    sub = r.reason === 'accepted' ? `“${esc(r.guess.text)}” rakip tarafından kabul edildi.` : `Cevap: <b>${esc(said)}</b>`;
  }
  if (over) {
    const champ = a.score > (b?.score ?? 0);
    cls = champ ? 'win' : 'lose';
    title = champ ? '🏆 Maçı kazandın!' : `🏆 ${esc(b.name)} kazandı`;
    sub = `Son tur: ${sub}`;
  }

  const hitName = r.guess?.player?.name;
  app.innerHTML = `
    ${scoreboard()}
    ${a.club ? versus() : ''}
    <div class="banner ${cls}"><h2>${title}</h2><p>${sub}</p></div>
    ${r.total ? `
      <div class="card stack">
        <h3>Doğru cevaplar <span class="muted small">(${r.total} oyuncu${r.total > r.answers.length ? `, en bilinen ${r.answers.length}` : ''})</span></h3>
        <div class="answer-list">${r.answers.map((n) => `<span class="${n === hitName ? 'hit' : ''}">${esc(n)}</span>`).join('')}</div>
      </div>` : ''}
    <div class="grow"></div>
    ${over
      ? (state.host === state.you
          ? '<button class="primary full" id="again">Rövanş</button>'
          : '<p class="center muted">Kurucu rövanşı başlatabilir.</p>')
      : `<button class="primary full" id="next" ${a.ready ? 'disabled' : ''}>${a.ready ? 'Rakip bekleniyor…' : 'Sonraki tur'}</button>`}
    <button class="link" id="leave">Odadan çık</button>`;

  $('#next')?.addEventListener('click', () => send({ t: 'next' }));
  $('#again')?.addEventListener('click', () => send({ t: 'start', target: state.target }));
  $('#leave').addEventListener('click', leave);
}

function leave() {
  if (!confirm('Odadan çıkmak istediğine emin misin?')) return;
  send({ t: 'leave' });
}

// ---------- Sayaçlar ----------

let lastCount = null;
function tick() {
  if (state?.deadline) {
    const left = state.deadline - serverNow();
    const bar = document.querySelector('#timer');
    if (bar) {
      const total = state.phase === 'pick' ? 20000 : 60000;
      bar.firstElementChild.style.transform = `scaleX(${Math.max(0, Math.min(1, left / total))})`;
      bar.classList.toggle('low', left < 10000);
    }
    const count = document.querySelector('#count');
    if (count) {
      const n = Math.max(1, Math.ceil(left / 1000));
      if (n !== lastCount) {
        lastCount = n;
        count.textContent = n;
        count.style.animation = 'none';
        void count.offsetWidth;
        count.style.animation = '';
        navigator.vibrate?.(30);
      }
    } else lastCount = null;
  }
  requestAnimationFrame(tick);
}

// ---------- Başlat ----------

async function loadClubs() {
  const res = await fetch('/api/clubs', { cache: 'no-cache' });
  const raw = await res.json();
  clubs = raw.map(([id, name, country, aliases]) => ({
    id, name, country,
    keys: [...new Set([name, ...aliases].map(normalize))],
  }));
}

async function loadPlayers() {
  const res = await fetch('/api/players', { cache: 'no-cache' });
  playerNames = await res.json();
}

render();
loadClubs().catch(() => toast('Takım listesi yüklenemedi.'));
loadPlayers().catch(() => {}); // öneri listesi yüklenmezse sessizce devam et
connect();
requestAnimationFrame(tick);
