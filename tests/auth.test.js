import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';

const TOKEN = '123456:TEST-TOKEN';
process.env.TELEGRAM_BOT_TOKEN = TOKEN;
const { start, setTgCall, signSession, verifySession } = await import('../server/server.js');

const sent = [];
setTgCall(async (method, payload) => { sent.push({ method, ...payload }); return { ok: true }; });
const WH = crypto.createHash('sha256').update('caravan-webhook:' + TOKEN).digest('hex');
const tick = () => new Promise(r => setTimeout(r, 40));
const post = (port, path, body, headers = {}) => fetch(`http://localhost:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const tgStart = (port, text, from = { id: 555, first_name: 'Вася', language_code: 'ru' }, secret = WH) =>
  post(port, '/tg/webhook', { update_id: 1, message: { text, from, chat: { id: from.id, type: 'private' } } }, { 'x-telegram-bot-api-secret-token': secret });
const begin = async port => (await post(port, '/auth/start', {})).json();
const poll = async (port, p) => (await post(port, '/auth/poll', { poll: p })).json();
const stop = server => { server.close(); server.closeAllConnections?.(); };

// Минимальный WebSocket-клиент (чтобы тест работал и без глобального WebSocket).
function wsClient(port) {
  const inbox = [], waiters = []; let buf = Buffer.alloc(0), sock;
  const push = m => { const i = waiters.findIndex(w => w.pred(m)); if (i >= 0) waiters.splice(i, 1)[0].res(m); else inbox.push(m); };
  const onData = d => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      let len = buf[1] & 127, off = 2;
      if (len == 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len == 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) return;
      const op = buf[0] & 15, pl = buf.subarray(off, off + len); buf = buf.subarray(off + len);
      if (op == 1) push(JSON.parse(pl.toString()));
    }
  };
  const open = new Promise((resolve, reject) => {
    const req = http.request({ port, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' } });
    req.on('upgrade', (res, s, head) => { sock = s; s.on('data', onData); s.on('error', () => {}); if (head.length) onData(head); resolve(); });
    req.on('error', reject); req.end();
  });
  const next = (pred = () => true) => new Promise(res => { const i = inbox.findIndex(pred); if (i >= 0) res(inbox.splice(i, 1)[0]); else waiters.push({ pred, res }); });
  const send = o => {
    const p = Buffer.from(JSON.stringify(o)), mask = crypto.randomBytes(4), m = Buffer.from(p);
    const h = p.length < 126 ? Buffer.from([0x81, 0x80 | p.length]) : Buffer.from([0x81, 0x80 | 126, p.length >> 8, p.length & 255]);
    for (let i = 0; i < m.length; i++) m[i] ^= mask[i & 3];
    sock.write(Buffer.concat([h, mask, m]));
  };
  return { open, next, send, close: () => sock && sock.destroy() };
}

test('вход через бота: код → /start у бота → опрос → сессия (один раз)', async () => {
  const server = await start(0), port = server.address().port;
  try {
    const a = await begin(port);
    assert.ok(a.code && a.poll && a.code !== a.poll);
    assert.equal(a.link, `https://t.me/my_caravan_bot?start=${a.code}`);
    assert.deepEqual(await poll(port, a.poll), { status: 'pending' });

    assert.equal((await tgStart(port, '/start ' + a.code)).status, 200);
    await tick();
    const ok = await poll(port, a.poll);
    assert.equal(ok.status, 'ok'); assert.equal(ok.name, 'Вася');
    assert.deepEqual(verifySession(ok.session), { id: 555, n: 'Вася' });

    assert.deepEqual(await poll(port, a.poll), { status: 'expired' });  // сессия выдаётся один раз
  } finally { stop(server); }
});

test('вход: знать один код недостаточно, нужен секрет приложения (poll)', async () => {
  const server = await start(0), port = server.address().port;
  try {
    const a = await begin(port);
    await tgStart(port, '/start ' + a.code); await tick();
    assert.deepEqual(await poll(port, a.code), { status: 'expired' });                         // код вместо секрета
    assert.deepEqual(await poll(port, 'x'.repeat(43)), { status: 'expired' });                 // чужой секрет
    assert.equal((await poll(port, a.poll)).status, 'ok');                                     // настоящий секрет
    assert.equal((await fetch(`http://localhost:${port}/auth/start`)).status, 405);            // только POST
  } finally { stop(server); }
});

test('webhook: без секрета Telegram запрос отклоняется и вход не подтверждается', async () => {
  const server = await start(0), port = server.address().port;
  try {
    const a = await begin(port);
    assert.equal((await tgStart(port, '/start ' + a.code, undefined, 'wrong-secret')).status, 401);
    assert.equal((await post(port, '/tg/webhook', { message: {} })).status, 401);
    await tick();
    assert.deepEqual(await poll(port, a.poll), { status: 'pending' });
  } finally { stop(server); }
});

test('бот отвечает пользователю на его языке; повторный и неизвестный код не работают', async () => {
  const server = await start(0), port = server.address().port;
  try {
    sent.length = 0;
    const a = await begin(port);
    await tgStart(port, '/start ' + a.code); await tick();
    assert.match(sent.at(-1).text, /Ты вошёл в Караван/); assert.equal(sent.at(-1).chat_id, 555);

    await tgStart(port, '/start ' + a.code, { id: 999, first_name: 'Хакер', language_code: 'en' }); await tick();   // код уже использован
    assert.match(sent.at(-1).text, /expired/);
    assert.equal((await poll(port, a.poll)).name, 'Вася');                                                         // не перехвачен

    await tgStart(port, '/start нет-такого', { id: 1, first_name: 'Z', language_code: 'ru' }); await tick();
    assert.match(sent.at(-1).text, /устарела/);
    await tgStart(port, '/start', { id: 1, first_name: 'Z', language_code: 'en' }); await tick();
    assert.match(sent.at(-1).text, /Caravan game bot/);

    const n = sent.length;
    await tgStart(port, 'привет', { id: 1, first_name: 'Z' }); await tick();
    assert.equal(sent.length, n);                                                                                  // чужие сообщения игнорируются
  } finally { stop(server); }
});

test('сессия: подделка, чужой ключ и срок действия', () => {
  const s = signSession({ id: 42, n: 'Ян' }, 1000);
  assert.deepEqual(verifySession(s, 1001), { id: 42, n: 'Ян' });
  assert.equal(verifySession(s, 1000 + 61 * 86400e3), null);                       // протухла
  const [v, body, mac] = s.split('.');
  const forged = Buffer.from(JSON.stringify({ id: 43, n: 'Ян', exp: Date.now() + 1e9 })).toString('base64url');
  assert.equal(verifySession(`${v}.${forged}.${mac}`), null);                       // подменён id
  assert.equal(verifySession(`${v}.${body}.${mac.slice(0, -2)}AA`), null);          // испорчена подпись
  for (const bad of ['', 'a.b', null, undefined, 'v1..']) assert.equal(verifySession(bad), null);
  process.env.TELEGRAM_BOT_TOKEN = 'другой:токен';
  try { assert.equal(verifySession(s, 1001), null); } finally { process.env.TELEGRAM_BOT_TOKEN = TOKEN; }  // ключ зависит от токена
});

test('hello по сессии даёт тот же аккаунт, что и мини-апп (initData)', async () => {
  const server = await start(0), port = server.address().port;
  const app = wsClient(port), mini = wsClient(port), bad = wsClient(port);
  await Promise.all([app.open, mini.open, bad.open]);
  const sign = fields => {
    const p = new URLSearchParams(fields);
    const str = [...p.entries()].sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, v]) => k + '=' + v).join('\n');
    p.set('hash', crypto.createHmac('sha256', crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest()).update(str).digest('hex'));
    return p.toString();
  };
  try {
    app.send({ t: 'hello', session: signSession({ id: 777, n: 'Нати' }) });
    const m1 = await app.next(m => m.t == 'me');
    assert.equal(m1.claimed, true); assert.equal(m1.bal, 100); assert.equal(m1.name, 'Нати');

    mini.send({ t: 'hello', pid: 'подделка', initData: sign({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 777, first_name: 'Нати' }) }) });
    const m2 = await mini.next(m => m.t == 'me');
    assert.equal(m2.claimed, false); assert.equal(m2.bal, 100); assert.equal(m2.name, 'Нати');   // тот же игрок: подарок уже получен

    bad.send({ t: 'hello', session: 'v1.xxx.yyy' });
    assert.match((await bad.next(m => m.t == 'err')).msg, /Сессия недействительна/);
    bad.send({ t: 'hello', pid: 'просто-ключ' });                                                   // без подписи вход запрещён
    assert.match((await bad.next(m => m.t == 'err')).msg, /Открой игру через Telegram/);
  } finally { app.close(); mini.close(); bad.close(); stop(server); }
});

test('без токена бота вход через бота отключён (503)', async () => {
  const server = await start(0), port = server.address().port;
  delete process.env.TELEGRAM_BOT_TOKEN;
  try { assert.equal((await post(port, '/auth/start', {})).status, 503); }
  finally { process.env.TELEGRAM_BOT_TOKEN = TOKEN; stop(server); }
});
