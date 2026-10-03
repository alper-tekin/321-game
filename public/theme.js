// Tema seçici. Seçim localStorage'da saklanır, <html data-theme="..."> olarak uygulanır.
// index.html'deki satır içi script parlama (FOUC) olmadan ilk temayı erken uygular.

const THEMES = {
  night: { color: '#060b16' },
  retro: { color: '#f1e6cf' },
  light: { color: '#f5f6f8' },
  neon: { color: '#0b0120' },
};

const root = document.documentElement;
const btn = document.getElementById('theme-btn');
const pop = document.getElementById('theme-pop');
const meta = document.querySelector('meta[name="theme-color"]');

function currentTheme() {
  let saved = null;
  try { saved = localStorage.getItem('theme'); } catch {}
  return THEMES[saved] ? saved : 'night';
}

function apply(theme) {
  root.dataset.theme = theme;
  meta?.setAttribute('content', THEMES[theme].color); // mobil tarayıcı çubuğu uyumlu olsun
  try { localStorage.setItem('theme', theme); } catch {}
  pop?.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.set === theme));
}

function closePop() {
  pop.hidden = true;
  btn.setAttribute('aria-expanded', 'false');
}

apply(currentTheme());

btn?.addEventListener('click', (e) => {
  e.stopPropagation();
  pop.hidden = !pop.hidden;
  btn.setAttribute('aria-expanded', String(!pop.hidden));
});

pop?.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-set]');
  if (!b) return;
  apply(b.dataset.set);
  closePop();
});

// Dışına tıklanınca kapat
document.addEventListener('click', (e) => {
  if (!pop.hidden && !pop.contains(e.target) && !btn.contains(e.target)) closePop();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !pop.hidden) closePop();
});
