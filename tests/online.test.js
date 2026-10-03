import test from 'node:test';
import assert from 'node:assert/strict';
process.env.TURN_MS = '300';
const { start, periodOf } = await import('../server/server.js');

function client(port) {
  const ws = new WebSocket('ws://localhost:' + port), inbox = [], waiters = [];
  ws.onmessage = e => { const m = JSON.parse(e.data); const i = waiters.findIndex(w => w.pred(m)); if (i >= 0) waiters.splice(i, 1)[0].res(m); else inbox.push(m); };
  const open = new Promise(r => { ws.onopen = r; });
  const next = (pred = () => true) => new Promise(res => { const i = inbox.findIndex(pred); if (i >= 0) res(inbox.splice(i, 1)[0]); else waiters.push({ pred, res }); });
  return { ws, open, next, send: o => ws.send(JSON.stringify(o)) };
}

test('сутки меняются в 14:00 по Москве (11:00 UTC)', () => {
  assert.equal(periodOf(Date.UTC(2026, 9, 3, 10, 59, 59)) + 1, periodOf(Date.UTC(2026, 9, 3, 11, 0, 0)));
  assert.equal(periodOf(Date.UTC(2026, 9, 3, 11, 0, 0)), periodOf(Date.UTC(2026, 9, 4, 10, 59, 59)));
});

test('100 крышек раз в сутки, комнаты: открытые в списке, приватные нет, ставка и рейтинг', async () => {
  const server = await start(0), port = server.address().port;
  const a = client(port), b = client(port), c = client(port);
  await Promise.all([a.open, b.open, c.open]);

  a.send({ t: 'hello', pid: 'A1', name: 'Алиса' });
  const me1 = await a.next(m => m.t == 'me');
  assert.equal(me1.claimed, true); assert.equal(me1.bal, 100); assert.equal(me1.name, 'Алиса');
  a.send({ t: 'hello', pid: 'A1', name: 'Алиса' });
  const me2 = await a.next(m => m.t == 'me');
  assert.equal(me2.claimed, false); assert.equal(me2.bal, 100);
  b.send({ t: 'hello', pid: 'B1', name: 'Боб' }); await b.next(m => m.t == 'me');

  a.send({ t: 'create', pid: 'A1', bet: 50, priv: true });
  const priv = await a.next(m => m.t == 'room');
  b.send({ t: 'list', pid: 'B1' });
  assert.equal((await b.next(m => m.t == 'rooms')).rooms.some(r => r.code == priv.code), false);   // приватная скрыта
  a.send({ t: 'create', pid: 'A1', bet: 50 });                            // вторую комнату создать нельзя
  assert.match((await a.next(m => m.t == 'err')).msg, /уже есть комната/);
  a.send({ t: 'leave' }); await a.next(m => m.t == 'left');
  a.send({ t: 'create', pid: 'A1', bet: 50 });
  const pub = await a.next(m => m.t == 'room');
  b.send({ t: 'list', pid: 'B1' });
  const found = (await b.next(m => m.t == 'rooms')).rooms.find(r => r.code == pub.code);
  assert.ok(found); assert.equal(found.bet, 50); assert.equal(found.name, 'Алиса');

  c.send({ t: 'join', pid: 'C1', code: pub.code });                      // у C нет крышек
  assert.match((await c.next(m => m.t == 'err')).msg, /Не хватает крышек/);

  b.send({ t: 'join', pid: 'B1', code: pub.code });
  await a.next(m => m.t == 'state'); await b.next(m => m.t == 'state');
  // никто не ходит: первым по таймеру проигрывает A, значит Боб забирает ставку
  const mb = await b.next(m => m.t == 'me' && m.delta !== undefined), ma = await a.next(m => m.t == 'me' && m.delta !== undefined);
  assert.equal(mb.delta, 50); assert.equal(mb.bal, 150); assert.equal(ma.delta, -50); assert.equal(ma.bal, 50);
  assert.equal(mb.w, 1);

  b.send({ t: 'lb', pid: 'B1' });
  assert.equal((await b.next(m => m.t == 'lb')).w, 1);

  for (const x of [a, b, c]) x.ws.close();
  server.close(); server.closeAllConnections?.();
});

test('Telegram: подпись initData проверяется, чужой id подделать нельзя', async () => {
  const { verifyInitData } = await import('../server/server.js');
  const crypto = await import('node:crypto');
  const TOKEN = '123456:TEST-TOKEN', now = Date.now();
  const sign = (fields, token = TOKEN) => {
    const p = new URLSearchParams(fields);
    const str = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => k + '=' + v).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
    p.set('hash', crypto.createHmac('sha256', secret).update(str).digest('hex'));
    return p.toString();
  };
  const good = sign({ auth_date: String(Math.floor(now / 1000)), user: JSON.stringify({ id: 777, first_name: 'Тг' }), query_id: 'q' });
  assert.equal(verifyInitData(good, TOKEN, now).id, 777);
  assert.equal(verifyInitData(good, 'другой-токен', now), null);                               // чужой токен
  assert.equal(verifyInitData(good.replace('777', '778'), TOKEN, now), null);                   // подменён id
  assert.equal(verifyInitData(sign({ auth_date: String(Math.floor(now / 1000) - 90000), user: '{"id":1}' }), TOKEN, now), null); // протухло
  assert.equal(verifyInitData('', TOKEN, now), null);

  process.env.TELEGRAM_BOT_TOKEN = TOKEN;
  const server = await start(0), port = server.address().port, a = client(port);
  await a.open;
  try {
    a.send({ t: 'hello', pid: 'FAKE', name: 'Хакер' });                                         // без подписи
    assert.match((await a.next(m => m.t == 'err')).msg, /Telegram/);
    a.send({ t: 'create', pid: 'FAKE', bet: 0 });                                              // pid из сообщения не принимается
    assert.match((await a.next(m => m.t == 'err')).msg, /идентификатора/);
    a.send({ t: 'hello', initData: good });
    const me = await a.next(m => m.t == 'me');
    assert.equal(me.bal, 100); assert.equal(me.name, 'Тг');
  } finally { delete process.env.TELEGRAM_BOT_TOKEN; a.ws.close(); server.close(); server.closeAllConnections?.(); }
});

test('статистика: онлайн, игроки за день, партии; доступ только по ключу', async () => {
  process.env.STATS_KEY = 'секрет';
  const server = await start(0), port = server.address().port, a = client(port);
  await a.open;
  try {
    a.send({ t: 'hello', pid: 'S1', name: 'Стат' }); await a.next(m => m.t == 'me');
    assert.equal((await fetch(`http://localhost:${port}/stats`)).status, 404);
    assert.equal((await fetch(`http://localhost:${port}/stats?key=wrong`)).status, 404);
    const j = await (await fetch(`http://localhost:${port}/stats?key=${encodeURIComponent('секрет')}&json=1`)).json();
    assert.equal(j.live.online, 1); assert.ok(j.today.dau >= 1); assert.ok(j.today.peak >= 1);
    const html = await (await fetch(`http://localhost:${port}/stats?key=${encodeURIComponent('секрет')}`)).text();
    assert.match(html, /Онлайн сейчас/);
  } finally { delete process.env.STATS_KEY; a.ws.close(); server.close(); server.closeAllConnections?.(); }
});

test('таймер: сервер шлёт остаток времени, комната знает о приватности, выход из ждущей комнаты', async () => {
  const server = await start(0), port = server.address().port;
  const a = client(port), b = client(port);
  await Promise.all([a.open, b.open]);
  try {
    a.send({ t: 'hello', pid: 'L1', name: 'А' }); await a.next(m => m.t == 'me');
    b.send({ t: 'hello', pid: 'L2', name: 'Б' }); await b.next(m => m.t == 'me');
    a.send({ t: 'create', bet: 0, priv: true });
    const r = await a.next(m => m.t == 'room');
    assert.equal(r.priv, true); assert.equal(r.bet, 0);
    // из ждущей комнаты можно выйти: она исчезает, код больше не работает
    a.send({ t: 'leave' }); await a.next(m => m.t == 'left');
    b.send({ t: 'join', code: r.code });
    assert.match((await b.next(m => m.t == 'err')).msg, /не найдена/);
    // новая комната: после входа соперника приходит остаток времени (не абсолютное время сервера)
    a.send({ t: 'create', bet: 0, priv: false });
    const r2 = await a.next(m => m.t == 'room'); assert.equal(r2.priv, false);
    b.send({ t: 'join', code: r2.code });
    const st = await b.next(m => m.t == 'state');
    assert.ok(st.left > 0 && st.left <= 300, 'left=' + st.left);
    // посреди партии выйти нельзя
    a.send({ t: 'leave' });
    assert.match((await a.next(m => m.t == 'err')).msg, /посреди партии/);
  } finally { a.ws.close(); b.ws.close(); server.close(); server.closeAllConnections?.(); }
});
