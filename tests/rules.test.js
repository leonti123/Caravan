import test from 'node:test';
import assert from 'node:assert/strict';
import { newGame, moves, play, applyMove, cv, legal, status, viewFor, isN } from '../shared/rules.js';

const blank = () => ({ deck: [[], []], hand: [[], []], car: [0, 1].map(() => [0, 1, 2].map(() => ({ cards: [], dir: 0 }))), open: [0, 0], turn: 0, over: false, winner: null, last: null });
const put = (st, p, i, cards, dir = 0) => { st.car[p][i] = { cards: cards.map(([r, s]) => ({ c: { r, s }, att: [], s })), dir }; };
const card = (r, s = 0) => ({ r, s });

test('направление, масть и равные значения', () => {
  const k = { cards: [{ c: card(3, 0), att: [], s: 0 }, { c: card(5, 1), att: [], s: 1 }], dir: 1 };
  assert.equal(legal(k, card(7, 2)), true);   // вверх
  assert.equal(legal(k, card(4, 2)), false);  // вниз и другая масть
  assert.equal(legal(k, card(4, 1)), true);   // та же масть, что у верхней
  assert.equal(legal(k, card(5, 2)), false);  // такое же значение подряд
});

test('начальный этап: только числа в пустые караваны', () => {
  const st = newGame();
  assert.ok(moves(st, 0).every(m => m.t == 'num' && st.hand[0][m.h] && isN(st.hand[0][m.h])));
  for (let n = 0; n < 3; n++) {
    const m = moves(st, 0).find(x => x.t == 'num');
    assert.equal(play(st, st.turn, m), null);
    const q = moves(st, st.turn).find(x => x.t == 'num');
    assert.equal(play(st, st.turn, q), null);
  }
  assert.deepEqual(st.open, [0, 0]);
  assert.ok(st.car.every(cs => cs.every(k => k.cards.length == 1)));
});

test('король удваивает, валет убирает вместе с картинками', () => {
  const st = blank(); put(st, 0, 0, [[4, 0]]);
  st.hand[0] = [card(13, 1), card(13, 2), card(11, 3)];
  applyMove(st, 0, { t: 'face', h: 0, tp: 0, ti: 0, ei: 0 }); assert.equal(cv(st.car[0][0]), 8);
  applyMove(st, 0, { t: 'face', h: 0, tp: 0, ti: 0, ei: 0 }); assert.equal(cv(st.car[0][0]), 16);
  applyMove(st, 0, { t: 'face', h: 0, tp: 0, ti: 0, ei: 0 }); assert.equal(st.car[0][0].cards.length, 0);
});

test('дама меняет направление и масть', () => {
  const st = blank(); put(st, 0, 0, [[3, 0], [6, 0]], 1);
  st.hand[0] = [card(12, 2)];
  applyMove(st, 0, { t: 'face', h: 0, tp: 0, ti: 0, ei: 0 });
  assert.equal(st.car[0][0].dir, -1);
  assert.equal(st.car[0][0].cards[1].s, 2);
});

test('джокер: на тузе убирает масть, на числе — значение', () => {
  const st = blank(); put(st, 0, 0, [[1, 1], [5, 1]], 1); put(st, 1, 0, [[9, 1]]); put(st, 1, 1, [[5, 2]]);
  st.hand[0] = [card(0, 0), card(0, 1)];
  applyMove(st, 0, { t: 'face', h: 0, tp: 0, ti: 0, ei: 0 }); // на тузе червей
  assert.deepEqual(st.car[0][0].cards.map(e => e.c.r), [1]);
  assert.equal(st.car[1][0].cards.length, 0);                  // девятка червей ушла
  assert.equal(st.car[1][1].cards.length, 1);                  // пятёрка бубен осталась
  put(st, 0, 1, [[5, 0]]);
  applyMove(st, 0, { t: 'face', h: 0, tp: 0, ti: 1, ei: 0 }); // на пятёрке пик
  assert.equal(st.car[1][1].cards.length, 0);                  // чужая пятёрка ушла
  assert.equal(st.car[0][1].cards.length, 1);                  // сама карта осталась
});

test('роспуск каравана без добора, сброс карты с добором', () => {
  const st = blank(); st.turn = 0; put(st, 0, 0, [[5, 0]]);
  st.hand[0] = [card(2, 0), card(3, 0)]; st.hand[1] = [card(4, 0)]; st.deck[0] = [card(9, 0)];
  assert.equal(play(st, 0, { t: 'dcar', i: 0 }), null);
  assert.equal(st.hand[0].length, 2); assert.equal(st.deck[0].length, 1);
  st.turn = 0;
  assert.equal(play(st, 0, { t: 'dc', h: 0 }), null);
  assert.equal(st.hand[0].length, 2); assert.equal(st.deck[0].length, 0);
});

test('пары караванов, ничья и победа', () => {
  const st = blank();
  put(st, 0, 0, [[10, 0], [8, 1], [5, 0]]);  // 23
  put(st, 1, 0, [[10, 0], [8, 1], [3, 0]]);  // 21
  put(st, 0, 1, [[9, 0], [8, 0], [5, 0]]);   // 22
  put(st, 1, 1, [[9, 1], [8, 1], [5, 1]]);   // 22 — ничья, пара не решена
  assert.deepEqual(status(st).out, [0, -1, -1]);
  put(st, 0, 2, [[10, 0], [9, 1], [6, 0]]);  // 25
  st.hand[0] = [card(5, 2), card(2, 2)]; st.hand[1] = [card(2, 0)];
  put(st, 0, 1, [[9, 0], [8, 0], [6, 0]]);   // 23 — выигрывает пару
  assert.equal(play(st, 0, { t: 'dc', h: 1 }), null);
  assert.equal(st.over, true); assert.equal(st.winner, 0);
});

test('ход не в очередь и недопустимый ход отклоняются', () => {
  const st = newGame();
  assert.equal(play(st, 1, moves(st, 1)[0]), 'Сейчас не твой ход');
  assert.equal(play(st, 0, { t: 'face', h: 0, tp: 1, ti: 0, ei: 0 }), 'Так нельзя');
});

test('вид игрока скрывает чужие карты и колоды', () => {
  const st = newGame(), v = viewFor(st, 1);
  assert.equal(v.hand[0].length, 8);
  assert.ok(v.hand[1].every(x => x === 0));
  assert.ok(v.deck.every(n => typeof n == 'number'));
  assert.equal(v.turn, 1);                       // ходит игрок 0, для игрока 1 это «соперник»
});
