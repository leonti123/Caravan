// Простой жадный бот: перебирает ходы и оценивает позицию. Работает и в браузере, и на сервере.
import { applyMove, moves, status, cv } from './rules.js';

const f = v => v > 26 ? -40 : v >= 21 ? 60 + v : v * 1.5;

export function evalFor(st, p) {
  const q = 1 - p, s = status(st);
  let sc = 150 * (s.w[p] - s.w[q]);
  for (let i = 0; i < 3; i++) sc += f(cv(st.car[p][i])) - f(cv(st.car[q][i]));
  if (s.res == 3) sc += s.w[p] > s.w[q] ? 1e5 : -1e5;
  return sc;
}

export function botMove(st, p, rnd = Math.random) {
  const ms = moves(st, p);
  if (!ms.length) return null;
  if (st.open[p] > 0) return ms[Math.floor(rnd() * ms.length)];
  let best = null, bs = -Infinity;
  for (const m of ms) {
    const c = structuredClone(st);
    applyMove(c, p, m);
    const sc = evalFor(c, p) + rnd() * 4 - (m.t == 'dc' ? 8 : m.t == 'dcar' ? 10 : 0);
    if (sc > bs) { bs = sc; best = m; }
  }
  return best;
}
