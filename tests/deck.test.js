import test from 'node:test';
import assert from 'node:assert/strict';
import { newGame, validDeck, mkDeck } from '../shared/rules.js';
const mk = n => Array.from({ length: n }, (_, i) => ({ r: 1 + i % 13, s: Math.floor(i / 13) % 4 }));
test('колода: минимум 30 карт', () => { assert.ok(validDeck(mk(30))); assert.ok(!validDeck(mk(29))); });
test('колода: не больше 3 копий одной карты, джокеры только 0/1', () => {
  const d = mk(30).concat(Array(4).fill({ r: 5, s: 0 })); assert.ok(!validDeck(d));
  assert.ok(!validDeck(mk(30).concat({ r: 0, s: 2 }))); assert.ok(validDeck(mk(30).concat({ r: 0, s: 1 })));
});
test('своя колода используется в игре, у соперника стандартная', () => {
  const st = newGame(Math.random, [mk(30), null]);
  assert.equal(st.deck[0].length + st.hand[0].length, 30); assert.equal(st.deck[1].length + st.hand[1].length, 54);
});
test('некорректная колода отклоняется', () => assert.throws(() => newGame(Math.random, [mk(10), null])));
