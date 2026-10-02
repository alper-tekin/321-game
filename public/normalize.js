// Hem sunucu hem tarayıcı tarafından kullanılan isim normalleştirme.
// "Hakan Şükür", "HAKAN SUKUR", "hakan şukur" -> "hakan sukur"

const SPECIAL = { ß: 'ss', ø: 'o', æ: 'ae', œ: 'oe', đ: 'd', ð: 'd', ł: 'l', þ: 'th', ı: 'i' };

export function normalize(text) {
  return String(text)
    .replace(/[İIı]/g, 'i')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[ßøæœđðłþı]/g, (ch) => SPECIAL[ch])
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// Uzun kelimelerde küçük yazım hatalarına izin ver
export function tolerance(len) {
  if (len >= 9) return 2;
  if (len >= 5) return 1;
  return 0;
}

export function closeEnough(input, target) {
  if (input === target) return true;
  const tol = tolerance(Math.min(input.length, target.length));
  return tol > 0 && Math.abs(input.length - target.length) <= tol && levenshtein(input, target) <= tol;
}
