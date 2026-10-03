// Сервер Каравана: комнаты, быстрый поиск, проверка ходов, таймер хода, раздача клиента.
// Без зависимостей: WebSocket (RFC 6455) реализован здесь же. Запуск: node server/server.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { newGame, play, viewFor } from '../shared/rules.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css', '.md': 'text/plain;charset=utf-8' };
const PUBLIC = ['index.html', 'shared', 'art'];
const TURN_MS = Number(process.env.TURN_MS) || 90000;

// ---------- WebSocket ----------
const frame = (op, buf) => {
  const n = buf.length; let h;
  if (n < 126) h = Buffer.from([0x80 | op, n]);
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([h, buf]);
};
function wsAttach(sock, onText, onClose) {
  let buf = Buffer.alloc(0), frag = [];
  sock.on('data', d => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 15, fin = buf[0] & 128, masked = buf[1] & 128;
      let len = buf[1] & 127, off = 2;
      if (len == 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len == 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 65536 || !masked) return sock.destroy();
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4), pl = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) pl[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      if (op == 8) { sock.end(frame(8, Buffer.alloc(0))); return; }
      if (op == 9) { sock.write(frame(10, pl)); continue; }
      if (op == 1 || op == 0) { if (op == 1) frag = []; frag.push(pl); if (fin) { const t = Buffer.concat(frag).toString(); frag = []; onText(t); } }
    }
  });
  sock.on('close', onClose);
  sock.on('error', () => {});
}

// ---------- Вход через Telegram Mini App ----------
// Если задан TELEGRAM_BOT_TOKEN, игрок определяется только по подписанным данным Telegram (initData):
// подделать чужой id нельзя, очистка браузера не даёт новых крышек. Без токена работает старый вход по ключу браузера.
export function verifyInitData(initData, token = process.env.TELEGRAM_BOT_TOKEN, now = Date.now()) {
  try {
    if (!token || !initData) return null;
    const p = new URLSearchParams(String(initData)), hash = p.get('hash');
    if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
    p.delete('hash');
    const str = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => k + '=' + v).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
    const calc = crypto.createHmac('sha256', secret).update(str).digest();
    if (!crypto.timingSafeEqual(calc, Buffer.from(hash, 'hex'))) return null;
    const age = now / 1000 - Number(p.get('auth_date'));
    if (!(age < 86400)) return null; // данные старше суток не принимаем
    const u = JSON.parse(p.get('user'));
    return u && Number.isInteger(u.id) ? u : null;
  } catch { return null; }
}

// ---------- Игроки, крышки, рейтинг ----------
// «Сутки» начинаются в 14:00 по Москве (UTC+3, без перехода на летнее время): в это время
// начисляются ежедневные крышки и обновляется таблица рейтинга (итоги прошедших суток).
const BETS = [0, 10, 50, 100, 250, 500], DAILY = 100, TOP = 10;
const SHIFT = (3 - 14) * 3600e3, DAY = 86400e3;
export const periodOf = (t = Date.now()) => Math.floor((t + SHIFT) / DAY);
const periodStart = p => p * DAY - SHIFT;
let data = { users: {}, cur: periodOf(), board: { period: null, rows: [] } };
let dirty = false, saveT = null;
const FILE = process.env.DATA_FILE, UP_URL = process.env.UPSTASH_REDIS_REST_URL, UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const upstash = cmd => fetch(UP_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + UP_TOKEN }, body: JSON.stringify(cmd) }).then(r => r.json());
async function load() {
  try {
    if (UP_URL) { const j = await upstash(['GET', 'caravan']); if (j.result) data = JSON.parse(j.result); }
    else if (FILE && fs.existsSync(FILE)) data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) { console.error('Не удалось загрузить данные:', e.message); }
  roll();
}
async function persist() {
  dirty = false; const txt = JSON.stringify(data);
  try {
    if (UP_URL) await upstash(['SET', 'caravan', txt]);
    else if (FILE) { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, txt); }
  } catch (e) { console.error('Не удалось сохранить данные:', e.message); dirty = true; }
}
function save() { dirty = true; if (saveT) return; saveT = setTimeout(() => { saveT = null; if (dirty) persist(); }, 15000); saveT.unref?.(); }
export const flush = () => (dirty ? persist() : Promise.resolve());
function roll() { // новые сутки: фиксируем рейтинг прошедших суток
  const cur = periodOf();
  if (cur === data.cur) return;
  const rows = Object.values(data.users).filter(u => u.wp === data.cur && u.w > 0).sort((a, b) => b.w - a.w).slice(0, TOP).map(u => ({ n: u.n, w: u.w }));
  data.board = { period: data.cur, rows }; data.cur = cur; save();
}
// ---------- Статистика онлайна ----------
// По календарным дням МСК, хранится 30 дней (вместе с остальными данными). Просмотр: /stats?key=STATS_KEY
const conns = new Set();
const dayKey = (t = Date.now()) => new Date(t + 3 * 3600e3).toISOString().slice(0, 10);
const onlineNow = () => { const s = new Set(); for (const c of conns) if (c.pid && !c.sock.destroyed) s.add(c.pid); return s.size; };
function stat() {
  const st = (data.stats ||= {}), k = dayKey();
  const d = (st[k] ||= { dau: 0, fresh: 0, games: 0, peak: 0 });
  const keys = Object.keys(st).sort(); while (keys.length > 30) delete st[keys.shift()];
  return d;
}
function seen(u, isNew) {
  const d = stat(), k = dayKey();
  if (u.seen !== k) { u.seen = k; d.dau++; if (isNew) d.fresh++; save(); }
  const n = onlineNow(); if (n > d.peak) { d.peak = n; save(); }
}
function statsPage(json) {
  const d = stat(), st = data.stats;
  const live = { online: onlineNow(), inGame: [...rooms.values()].filter(r => r.game && !r.game.over).length * 2, openRooms: [...rooms.values()].filter(r => !r.priv && !r.game && r.players[0]?.conn && !r.players[1]).length, rooms: rooms.size, searching: waiting ? 1 : 0, totalPlayers: Object.keys(data.users).length };
  const days = Object.keys(st).sort().reverse().map(k => ({ day: k, ...st[k] }));
  if (json) return JSON.stringify({ live, today: { day: dayKey(), ...d }, days }, null, 1);
  const L = [['Онлайн сейчас', live.online], ['В партиях (игроков)', live.inGame], ['Открытых комнат', live.openRooms], ['Всего комнат', live.rooms], ['Ищут соперника', live.searching], ['Игроков за всё время', live.totalPlayers]];
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="30"><title>Караван: статистика</title>
<style>body{font:15px system-ui;background:#1b140d;color:#f0dcae;max-width:640px;margin:20px auto;padding:0 12px}h2{color:#f0a830}table{border-collapse:collapse;width:100%;margin-bottom:18px}td,th{border-bottom:1px solid #f0a83033;padding:6px;text-align:right}td:first-child,th:first-child{text-align:left}</style>
<h2>Сейчас</h2><table>${L.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</table>
<h2>По дням (МСК)</h2><table><tr><th>День</th><th>Игроков</th><th>Новых</th><th>Партий</th><th>Пик онлайна</th></tr>${days.map(x => `<tr><td>${x.day}</td><td>${x.dau}</td><td>${x.fresh}</td><td>${x.games}</td><td>${x.peak}</td></tr>`).join('')}</table>
<p style="opacity:.6">Обновляется каждые 30 секунд. «Игроков» = уникальных за день. Пик онлайна считается с момента запуска сервера в этот день и при входах.</p>`;
}
const cleanName = x => String(x || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16);
function user(pid, name) {
  roll();
  const u = data.users[pid] ||= { n: 'Игрок', bal: 0, claim: -1, wp: -1, w: 0 };
  const n = cleanName(name); if (n) u.n = n;
  return u;
}
const winsOf = u => (u.wp === data.cur ? u.w : 0);
const meInfo = u => ({ name: u.n, bal: u.bal, w: winsOf(u), next: periodStart(data.cur + 1) });
function claimDaily(u) { if (u.claim === data.cur) return false; u.claim = data.cur; u.bal += DAILY; save(); return true; }
function settle(room) { // итог партии: победа в рейтинг, ставка переходит победителю
  const g = room.game;
  if (!g || !g.over || room.settled) return;
  room.settled = true;
  const w = g.winner, wp = room.players[w], lp = room.players[1 - w];
  if (!wp || !lp || wp.pid === lp.pid) return;
  const wu = user(wp.pid), lu = user(lp.pid);
  stat().games++;
  if (wu.wp !== data.cur) { wu.wp = data.cur; wu.w = 0; }
  wu.w++;
  const amt = Math.min(room.bet || 0, lu.bal); wu.bal += amt; lu.bal -= amt; save();
  send(wp.conn, { t: 'me', ...meInfo(wu), delta: amt }); send(lp.conn, { t: 'me', ...meInfo(lu), delta: -amt });
}

// ---------- Комнаты ----------
const rooms = new Map();
let waiting = null;
const send = (conn, obj) => { if (conn && !conn.sock.destroyed) conn.sock.write(frame(1, Buffer.from(JSON.stringify(obj)))); };
const newCode = () => {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let c;
  do { c = Array.from({ length: 4 }, () => A[crypto.randomInt(A.length)]).join(''); } while (rooms.has(c));
  return c;
};
function pushState(room) {
  room.players.forEach((pl, seat) => {
    if (!pl || !pl.conn || !room.game) return;
    send(pl.conn, { t: 'state', code: room.code, seat, view: viewFor(room.game, seat), deadline: room.deadline, opp: !!room.players[1 - seat]?.conn });
  });
}
function armTimer(room) {
  clearTimeout(room.timer);
  if (room.game.over) { room.deadline = 0; return; }
  room.deadline = Date.now() + TURN_MS;
  room.timer = setTimeout(() => { // не успел сходить — проигрыш
    const g = room.game; g.over = true; g.winner = 1 - g.turn; g.last = { p: g.turn, t: 'timeout' };
    room.deadline = 0; settle(room); pushState(room);
  }, TURN_MS);
  room.timer.unref?.();
}
function startGame(room) { room.game = newGame(); room.settled = false; armTimer(room); }
function makeRoom(code) { const room = { code, players: [null, null], game: null, timer: null, deadline: 0, touched: Date.now(), priv: false, bet: 0, name: '' }; rooms.set(code, room); return room; }
function seatIn(room, seat, pid, conn) {
  room.players[seat] = { pid, conn }; conn.room = room; conn.seat = seat; conn.pid = pid;
}

function handle(conn, raw) {
  let m; try { m = JSON.parse(raw); } catch { return; }
  if (!m || typeof m !== 'object') return;
  const tgOn = !!process.env.TELEGRAM_BOT_TOKEN;
  let pid = tgOn ? conn.pid : String(m.pid || conn.pid || '').slice(0, 64); // с Telegram id из сообщения игнорируется
  const err = msg => send(conn, { t: 'err', msg });
  if (m.t == 'hello') {
    if (tgOn) {
      const tu = verifyInitData(m.initData);
      if (!tu) return err('Открой игру через Telegram (мини-приложение бота)');
      pid = 'tg' + tu.id;
      if (!String(m.name || '').trim()) m.name = tu.first_name || tu.username;
    }
    if (!pid) return;
    conn.pid = pid; const isNew = !data.users[pid], u = user(pid, m.name), claimed = claimDaily(u); seen(u, isNew);
    send(conn, { t: 'me', ...meInfo(u), claimed, daily: DAILY });
  } else if (m.t == 'lb') {
    roll(); const u = pid ? user(pid) : null, b = data.board;
    send(conn, { t: 'lb', rows: b.rows, from: b.period == null ? null : periodStart(b.period), to: b.period == null ? null : periodStart(b.period + 1), next: periodStart(data.cur + 1), w: u ? winsOf(u) : 0 });
  } else if (m.t == 'list') {
    const list = [...rooms.values()].filter(r => !r.priv && !r.game && r.players[0]?.conn && !r.players[1])
      .sort((a, b) => b.touched - a.touched).slice(0, 20).map(r => ({ code: r.code, name: r.name, bet: r.bet }));
    send(conn, { t: 'rooms', rooms: list });
  } else if (m.t == 'create') {
    if (!pid) return err('Нет идентификатора');
    const bet = BETS.includes(m.bet) ? m.bet : 0, u = user(pid);
    if (u.bal < bet) return err('Не хватает крышек для такой ставки');
    const room = makeRoom(newCode()); room.priv = !!m.priv; room.bet = bet; room.name = u.n; seatIn(room, 0, pid, conn);
    send(conn, { t: 'room', code: room.code, seat: 0 });
  } else if (m.t == 'join') {
    const room = rooms.get(String(m.code || '').toUpperCase());
    if (!pid) return err('Нет идентификатора');
    if (!room) return err('Комната не найдена');
    let seat = room.players.findIndex(x => x && x.pid == pid);
    if (seat < 0) {
      seat = room.players.findIndex(x => !x); if (seat < 0) return err('Комната занята');
      if (room.bet > 0 && user(pid).bal < room.bet) return err('Не хватает крышек: ставка ' + room.bet);
    }
    seatIn(room, seat, pid, conn); room.touched = Date.now();
    send(conn, { t: 'room', code: room.code, seat });
    if (room.players[0] && room.players[1] && !room.game) startGame(room);
    pushState(room);
    if (room.game) room.players.forEach((pl, s) => { if (s != seat) send(pl?.conn, { t: 'opp', online: true }); });
  } else if (m.t == 'queue') {
    if (!pid) return err('Нет идентификатора');
    if (waiting && waiting.conn !== conn && !waiting.conn.sock.destroyed) {
      const room = makeRoom(newCode());
      seatIn(room, 0, waiting.pid, waiting.conn); seatIn(room, 1, pid, conn); waiting = null;
      room.players.forEach((pl, seat) => send(pl.conn, { t: 'room', code: room.code, seat }));
      startGame(room); pushState(room);
    } else { waiting = { pid, conn }; send(conn, { t: 'queued' }); }
  } else if (m.t == 'move') {
    const room = conn.room;
    if (!room || !room.game) return err('Игра не начата');
    let mv = m.m;
    if (mv && mv.t == 'face') mv = { ...mv, tp: mv.tp === 0 ? conn.seat : 1 - conn.seat }; // из «вида игрока» в настоящие места
    const e = play(room.game, conn.seat, mv);
    if (e) return err(e);
    room.touched = Date.now(); armTimer(room); settle(room); pushState(room);
  }
}

function onClose(conn) {
  if (waiting && waiting.conn === conn) waiting = null;
  const room = conn.room;
  if (!room) return;
  const pl = room.players[conn.seat];
  if (pl && pl.conn === conn) { pl.conn = null; send(room.players[1 - conn.seat]?.conn, { t: 'opp', online: false }); }
}

// ---------- HTTP ----------
function serveStatic(req, res) {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p == '/health') { res.writeHead(200); return res.end('ok'); }
  if (p == '/stats') { // закрыто ключом; без STATS_KEY страница отключена
    const key = process.env.STATS_KEY, got = new URL(req.url, 'http://x').searchParams.get('key') || '';
    const h = s => crypto.createHash('sha256').update(s).digest();
    if (!key || !crypto.timingSafeEqual(h(key), h(got))) { res.writeHead(404); return res.end('Not found'); }
    const json = new URL(req.url, 'http://x').searchParams.get('json') == '1';
    res.writeHead(200, { 'Content-Type': json ? 'application/json' : 'text/html;charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(statsPage(json));
  }
  if (p == '/') p = '/index.html';
  const rel = path.normalize(p).replace(/^[/\\]+/, '');
  const full = path.join(ROOT, rel);
  if (!full.startsWith(ROOT + path.sep) || !PUBLIC.includes(rel.split(path.sep)[0])) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(full, (e, data) => {
    if (e) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

export async function start(port = process.env.PORT || 3000) {
  await load();
  const server = http.createServer(serveStatic);
  server.on('upgrade', (req, sock) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) return sock.destroy();
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
      crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64') + '\r\n\r\n');
    const conn = { sock, room: null, seat: -1, pid: '' };
    conns.add(conn);
    wsAttach(sock, t => handle(conn, t), () => { conns.delete(conn); onClose(conn); });
  });
  const sweep = setInterval(() => { // чистим старые комнаты
    for (const [c, r] of rooms) if (Date.now() - r.touched > 3600e3) { clearTimeout(r.timer); rooms.delete(c); }
  }, 60000);
  sweep.unref();
  const ticker = setInterval(roll, 30000); ticker.unref();
  server.on('close', () => { clearInterval(sweep); clearInterval(ticker); for (const r of rooms.values()) clearTimeout(r.timer); rooms.clear(); waiting = null; });
  return new Promise(res => server.listen(port, () => res(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  start().then(s => console.log('Караван: http://localhost:' + s.address().port));
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => flush().finally(() => process.exit(0)));
}
