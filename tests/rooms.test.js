import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
process.env.LEAVE_MS = '150';
const { start } = await import('../server/server.js');

function client(port) {
  const ws = new WebSocket('ws://localhost:' + port), inbox = [], waiters = [];
  ws.onmessage = e => { const m = JSON.parse(e.data); const i = waiters.findIndex(w => w.pred(m)); if (i >= 0) waiters.splice(i, 1)[0].res(m); else inbox.push(m); };
  const open = new Promise(r => { ws.onopen = r; });
  const next = (pred = () => true) => new Promise(res => { const i = inbox.findIndex(pred); if (i >= 0) res(inbox.splice(i, 1)[0]); else waiters.push({ pred, res }); });
  return { ws, open, next, send: o => ws.send(JSON.stringify(o)) };
}
const stop = (server, ...cs) => { cs.forEach(c => c.ws.close()); server.close(); server.closeAllConnections?.(); };
const hello = async (c, pid) => { c.send({ t: 'hello', pid, name: pid }); await c.next(m => m.t == 'me'); };
const pause = ms => new Promise(r => setTimeout(r, ms));

test('один в комнате вышел из приложения: комната сразу пропадает из списка и из памяти', async () => {
  const server = await start(0), port = server.address().port, a = client(port), b = client(port);
  await Promise.all([a.open, b.open]); await hello(a, 'R1'); await hello(b, 'R2');
  a.send({ t: 'create', bet: 0 }); const r = await a.next(m => m.t == 'room');
  a.ws.close(); await pause(50);
  b.send({ t: 'list' }); assert.equal((await b.next(m => m.t == 'rooms')).rooms.some(x => x.code == r.code), false);
  b.send({ t: 'join', code: r.code }); assert.match((await b.next(m => m.t == 'err')).msg, /не найдена/);
  stop(server, b);
});

test('вдвоём: вышедший из приложения проигрывает, ставка уходит сопернику, комната удаляется', async () => {
  const server = await start(0), port = server.address().port, a = client(port), b = client(port);
  await Promise.all([a.open, b.open]); await hello(a, 'Q1'); await hello(b, 'Q2');
  a.send({ t: 'create', bet: 50 }); const r = await a.next(m => m.t == 'room');
  b.send({ t: 'join', code: r.code }); await b.next(m => m.t == 'state');
  a.ws.close();
  assert.equal((await b.next(m => m.t == 'opp')).online, false);
  const st = await b.next(m => m.t == 'state' && m.view.over);
  assert.equal(st.view.winner, 0); assert.equal(st.view.last.t, 'leave');
  const me = await b.next(m => m.t == 'me' && m.delta !== undefined); assert.equal(me.delta, 50); assert.equal(me.bal, 150);
  b.send({ t: 'join', code: r.code }); assert.match((await b.next(m => m.t == 'err')).msg, /не найдена/);
  stop(server, b);
});

test('вернулся до конца ожидания: партия продолжается', async () => {
  const server = await start(0), port = server.address().port, a = client(port), b = client(port);
  await Promise.all([a.open, b.open]); await hello(a, 'W1'); await hello(b, 'W2');
  a.send({ t: 'create', bet: 0 }); const r = await a.next(m => m.t == 'room');
  b.send({ t: 'join', code: r.code }); await b.next(m => m.t == 'state');
  a.ws.close(); await b.next(m => m.t == 'opp');
  const a2 = client(port); await a2.open; await hello(a2, 'W1');
  a2.send({ t: 'join', code: r.code }); const st = await a2.next(m => m.t == 'state');
  assert.equal(st.view.over, false);
  await pause(300); b.send({ t: 'list' }); await b.next(m => m.t == 'rooms'); // комната жива
  a2.send({ t: 'leave' }); assert.match((await a2.next(m => m.t == 'err')).msg, /посреди партии/);
  stop(server, a2, b);
});

test('один игрок не может создать много комнат (в т.ч. из второй вкладки)', async () => {
  const server = await start(0), port = server.address().port, a = client(port), a2 = client(port);
  await Promise.all([a.open, a2.open]); await hello(a, 'M1'); await hello(a2, 'M1');
  a.send({ t: 'create', bet: 0 }); const r = await a.next(m => m.t == 'room');
  a.send({ t: 'create', bet: 0 }); assert.match((await a.next(m => m.t == 'err')).msg, /уже есть комната/);
  a2.send({ t: 'create', bet: 0, priv: true }); assert.match((await a2.next(m => m.t == 'err')).msg, new RegExp(r.code));
  a.send({ t: 'leave' }); await a.next(m => m.t == 'left');
  a.send({ t: 'create', bet: 0 }); await a.next(m => m.t == 'room'); // после выхода можно снова
  stop(server, a, a2);
});

test('музыка: список из art/music и Range-запросы', async () => {
  fs.writeFileSync('art/music/_тест трек.mp3', Buffer.from('0123456789'));
  const server = await start(0), port = server.address().port;
  try {
    const list = await (await fetch(`http://localhost:${port}/music`)).json();
    const t = list.find(x => x.name == '_тест трек'); assert.ok(t);
    const full = await fetch(`http://localhost:${port}/${t.url}`);
    assert.equal(full.headers.get('content-type'), 'audio/mpeg'); assert.equal(await full.text(), '0123456789');
    const part = await fetch(`http://localhost:${port}/${t.url}`, { headers: { Range: 'bytes=2-4' } });
    assert.equal(part.status, 206); assert.equal(await part.text(), '234'); assert.equal(part.headers.get('content-range'), 'bytes 2-4/10');
  } finally { fs.unlinkSync('art/music/_тест трек.mp3'); server.close(); server.closeAllConnections?.(); }
});
