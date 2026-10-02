import test from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../server/server.js';
import { moves } from '../shared/rules.js';

function client(port) {
  const ws = new WebSocket('ws://localhost:' + port), inbox = [], waiters = [];
  ws.onmessage = e => { const m = JSON.parse(e.data); const i = waiters.findIndex(w => w.pred(m)); if (i >= 0) waiters.splice(i, 1)[0].res(m); else inbox.push(m); };
  const open = new Promise(r => { ws.onopen = r; });
  const next = (pred = () => true) => new Promise(res => { const i = inbox.findIndex(pred); if (i >= 0) res(inbox.splice(i, 1)[0]); else waiters.push({ pred, res }); });
  return { ws, open, next, send: o => ws.send(JSON.stringify(o)) };
}

test('создание комнаты, вход, ход, скрытие рук, отказ чужому ходу', async () => {
  const server = await start(0), port = server.address().port;
  const a = client(port), b = client(port);
  await Promise.all([a.open, b.open]);

  a.send({ t: 'create', pid: 'A' });
  const room = await a.next(m => m.t == 'room');
  assert.match(room.code, /^[A-Z]{4}$/);

  b.send({ t: 'join', code: room.code.toLowerCase(), pid: 'B' });
  const sa = await a.next(m => m.t == 'state'), sb = await b.next(m => m.t == 'state');
  assert.equal(sa.view.turn, 0); assert.equal(sb.view.turn, 1);
  assert.equal(sa.view.hand[0].length, 8); assert.ok(sb.view.hand[1].every(x => x === 0));

  b.send({ t: 'move', m: moves(sb.view, 0)[0] || { t: 'dc', h: 0 } });   // ход не в очередь
  assert.equal((await b.next(m => m.t == 'err')).msg, 'Сейчас не твой ход');

  a.send({ t: 'move', m: moves(sa.view, 0)[0] });
  const sa2 = await a.next(m => m.t == 'state'), sb2 = await b.next(m => m.t == 'state');
  assert.equal(sa2.view.car[0].filter(k => k.cards.length).length, 1);
  assert.equal(sb2.view.car[1].filter(k => k.cards.length).length, 1);   // у B это караван соперника
  assert.equal(sb2.view.turn, 0);

  a.ws.close(); b.ws.close(); server.close(); server.closeAllConnections?.();
});

test('быстрый поиск и переподключение', async () => {
  const server = await start(0), port = server.address().port;
  const a = client(port), b = client(port);
  await Promise.all([a.open, b.open]);
  a.send({ t: 'queue', pid: 'A' }); assert.equal((await a.next()).t, 'queued');
  b.send({ t: 'queue', pid: 'B' });
  const ra = await a.next(m => m.t == 'room'); await b.next(m => m.t == 'state');
  a.ws.close();
  const a2 = client(port); await a2.open;
  a2.send({ t: 'join', code: ra.code, pid: 'A' });
  const s = await a2.next(m => m.t == 'state');
  assert.equal(s.seat, ra.seat); assert.equal(s.view.hand[0].length, 8);
  a2.ws.close(); b.ws.close(); server.close(); server.closeAllConnections?.();
});

test('таймер хода: просрочка = поражение', async () => {
  process.env.TURN_MS = '150';
  const mod = await import('../server/server.js?short');
  const server = await mod.start(0), port = server.address().port;
  const a = client(port), b = client(port); await Promise.all([a.open, b.open]);
  a.send({ t: 'create', pid: 'A' }); const r = await a.next(m => m.t == 'room');
  b.send({ t: 'join', code: r.code, pid: 'B' });
  await a.next(m => m.t == 'state');
  const end = await a.next(m => m.t == 'state' && m.view.over);
  assert.equal(end.view.winner, 1);
  a.ws.close(); b.ws.close(); server.close(); server.closeAllConnections?.();
  delete process.env.TURN_MS;
});
