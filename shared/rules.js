// Правила Каравана. Чистые функции без DOM и сети: работают и в браузере, и на сервере.
// Карта: {r: 1..13 (A, 2..10, J=11, Q=12, K=13), 0 = джокер; s: 0♠ 1♥ 2♦ 3♣}.
// Запись в караване: {c: карта, att: [картинки сверху], s: текущая масть}.
export const isN = c => c.r >= 1 && c.r <= 10;

export function shuffle(a, rnd = Math.random) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
export function mkDeck(rnd) {
  const d = [];
  for (let s = 0; s < 4; s++) for (let r = 1; r <= 13; r++) d.push({ r, s });
  d.push({ r: 0, s: 0 }, { r: 0, s: 1 });
  return shuffle(d, rnd);
}
export const cv = k => k.cards.reduce((a, e) => a + e.c.r * 2 ** e.att.filter(x => x.r == 13).length, 0);

// Своя колода: минимум 30 карт, одну и ту же карту можно взять не больше MAX_SETS раз (по разу из каждого набора).
export const MAX_SETS = 3;
export function validDeck(d) {
  if (!Array.isArray(d) || d.length < 30 || d.length > 54 * MAX_SETS) return false;
  const n = {};
  for (const c of d) {
    if (!c || !Number.isInteger(c.r) || !Number.isInteger(c.s) || c.r < 0 || c.r > 13 || c.s < 0 || c.s > 3) return false;
    if (c.r == 0 && c.s > 1) return false;
    const k = c.r + ',' + c.s; n[k] = (n[k] || 0) + 1;
    if (n[k] > MAX_SETS) return false;
  }
  return true;
}

// decks: необязательно, [колода0, колода1]; null/отсутствует — стандартная колода из 54 карт.
export function newGame(rnd = Math.random, decks = null) {
  const mine = p => {
    const d = decks && decks[p];
    if (!d) return mkDeck(rnd);
    if (!validDeck(d)) throw new Error('Некорректная колода');
    return shuffle(d.map(c => ({ r: c.r, s: c.s })), rnd);
  };
  const st = {
    deck: [mine(0), mine(1)], hand: [[], []],
    car: [0, 1].map(() => [0, 1, 2].map(() => ({ cards: [], dir: 0 }))),
    open: [3, 3], turn: 0, over: false, winner: null, last: null,
  };
  for (let p = 0; p < 2; p++) for (let i = 0; i < 8; i++) st.hand[p].push(st.deck[p].pop());
  return st;
}

// Можно ли положить число c на караван k.
export function legal(k, c) {
  const t = k.cards[k.cards.length - 1];
  if (!t) return true;
  if (c.r == t.c.r) return false;
  if (!k.dir || t.s == c.s) return true;
  return k.dir > 0 ? c.r > t.c.r : c.r < t.c.r;
}

// Все допустимые ходы игрока p.
export function moves(st, p) {
  const h = st.hand[p], o = [];
  if (st.open[p] > 0) {
    h.forEach((c, x) => { if (isN(c)) st.car[p].forEach((k, i) => { if (!k.cards.length) o.push({ t: 'num', h: x, i }); }); });
    if (o.length) return o;
    h.forEach((c, x) => o.push({ t: 'dc', h: x }));
    return o;
  }
  h.forEach((c, x) => {
    if (isN(c)) st.car[p].forEach((k, i) => { if (legal(k, c)) o.push({ t: 'num', h: x, i }); });
    else [0, 1].forEach(tp => st.car[tp].forEach((k, ti) => k.cards.forEach((e, ei) => o.push({ t: 'face', h: x, tp, ti, ei }))));
    o.push({ t: 'dc', h: x });
  });
  st.car[p].forEach((k, i) => { if (k.cards.length) o.push({ t: 'dcar', i }); });
  return o;
}

// Применить ход без проверок (проверяет play).
export function applyMove(st, p, m) {
  const h = st.hand[p];
  if (m.t == 'dcar') st.car[p][m.i] = { cards: [], dir: 0 };
  else if (m.t == 'dc') h.splice(m.h, 1);
  else {
    const c = h.splice(m.h, 1)[0];
    if (m.t == 'num') {
      const k = st.car[p][m.i], t = k.cards[k.cards.length - 1];
      if (t && !k.dir) k.dir = c.r > t.c.r ? 1 : -1;
      k.cards.push({ c, att: [], s: c.s });
      if (st.open[p] > 0) st.open[p]--;
    } else {
      const k = st.car[m.tp][m.ti], e = k.cards[m.ei];
      if (c.r == 11) k.cards.splice(m.ei, 1);                                   // валет
      else if (c.r == 12) { e.att.push(c); k.dir *= -1; k.cards[k.cards.length - 1].s = c.s; } // дама
      else if (c.r == 13) e.att.push(c);                                         // король
      else {                                                                     // джокер
        e.att.push(c);
        const ace = e.c.r == 1, v = ace ? e.c.s : e.c.r;
        st.car.forEach(cs => cs.forEach(kk => { kk.cards = kk.cards.filter(x => x === e || (ace ? x.c.s : x.c.r) != v); }));
      }
      st.car.forEach(cs => cs.forEach(kk => { if (kk.cards.length < 2) kk.dir = 0; }));
    }
  }
  if (m.t != 'dcar' && st.deck[p].length) h.push(st.deck[p].pop()); // роспуск каравана без добора
}

// Результат по парам караванов: out[i] = 0/1 (кто выиграл пару) или -1.
export function status(st) {
  const out = [], w = [0, 0];
  for (let i = 0; i < 3; i++) {
    const a = cv(st.car[0][i]), b = cv(st.car[1][i]), sa = a >= 21 && a <= 26, sb = b >= 21 && b <= 26;
    let r = -1;
    if (sa && (!sb || a > b)) r = 0; else if (sb && (!sa || b > a)) r = 1;
    out.push(r); if (r >= 0) w[r]++;
  }
  return { out, w, res: w[0] + w[1] };
}

const FIELDS = ['t', 'h', 'i', 'tp', 'ti', 'ei'];
const same = (a, b) => FIELDS.every(f => a[f] === b[f]);

// Единственная точка входа для хода: возвращает текст ошибки или null.
export function play(st, p, m) {
  if (st.over) return 'Игра окончена';
  if (st.turn !== p) return 'Сейчас не твой ход';
  if (!m || typeof m !== 'object' || !moves(st, p).some(x => same(x, m))) return 'Так нельзя';
  applyMove(st, p, m);
  st.last = { p, t: m.t };
  const s = status(st);
  if (s.res == 3) { st.over = true; st.winner = s.w[0] > s.w[1] ? 0 : 1; return null; }
  const q = 1 - p;
  if (!st.hand[q].length) { st.over = true; st.winner = p; return null; } // у соперника кончились карты
  st.turn = q;
  return null;
}

// Что видит игрок p: он всегда «0», соперник «1». Чужие карты и колоды скрыты.
export function viewFor(st, p) {
  const q = 1 - p, cp = x => JSON.parse(JSON.stringify(x));
  return {
    hand: [cp(st.hand[p]), new Array(st.hand[q].length).fill(0)],
    deck: [st.deck[p].length, st.deck[q].length],
    car: [cp(st.car[p]), cp(st.car[q])],
    open: [st.open[p], st.open[q]],
    turn: st.turn == p ? 0 : 1,
    over: st.over,
    winner: st.winner == null ? null : (st.winner == p ? 0 : 1),
    last: st.last ? { who: st.last.p == p ? 0 : 1, t: st.last.t } : null,
  };
}
