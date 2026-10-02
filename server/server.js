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
    room.deadline = 0; pushState(room);
  }, TURN_MS);
  room.timer.unref?.();
}
function startGame(room) { room.game = newGame(); armTimer(room); }
function makeRoom(code) { const room = { code, players: [null, null], game: null, timer: null, deadline: 0, touched: Date.now() }; rooms.set(code, room); return room; }
function seatIn(room, seat, pid, conn) {
  room.players[seat] = { pid, conn }; conn.room = room; conn.seat = seat; conn.pid = pid;
}

function handle(conn, raw) {
  let m; try { m = JSON.parse(raw); } catch { return; }
  if (!m || typeof m !== 'object') return;
  const pid = String(m.pid || conn.pid || '').slice(0, 64);
  const err = msg => send(conn, { t: 'err', msg });
  if (m.t == 'create') {
    if (!pid) return err('Нет идентификатора');
    const room = makeRoom(newCode()); seatIn(room, 0, pid, conn);
    send(conn, { t: 'room', code: room.code, seat: 0 });
  } else if (m.t == 'join') {
    const room = rooms.get(String(m.code || '').toUpperCase());
    if (!pid) return err('Нет идентификатора');
    if (!room) return err('Комната не найдена');
    let seat = room.players.findIndex(x => x && x.pid == pid);
    if (seat < 0) { seat = room.players.findIndex(x => !x); if (seat < 0) return err('Комната занята'); }
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
    room.touched = Date.now(); armTimer(room); pushState(room);
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

export function start(port = process.env.PORT || 3000) {
  const server = http.createServer(serveStatic);
  server.on('upgrade', (req, sock) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) return sock.destroy();
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
      crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64') + '\r\n\r\n');
    const conn = { sock, room: null, seat: -1, pid: '' };
    wsAttach(sock, t => handle(conn, t), () => onClose(conn));
  });
  const sweep = setInterval(() => { // чистим старые комнаты
    for (const [c, r] of rooms) if (Date.now() - r.touched > 3600e3) { clearTimeout(r.timer); rooms.delete(c); }
  }, 60000);
  sweep.unref();
  server.on('close', () => { clearInterval(sweep); for (const r of rooms.values()) clearTimeout(r.timer); rooms.clear(); waiting = null; });
  return new Promise(res => server.listen(port, () => res(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  start().then(s => console.log('Караван: http://localhost:' + s.address().port));
}
