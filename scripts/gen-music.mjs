// Делает music.json из файлов art/music (для хостинга без сервера, например GitHub Pages).
// Запуск: node scripts/gen-music.mjs [папка_для_music.json]  (по умолчанию — корень проекта)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] || ROOT);
const AUDIO = /\.(mp3|ogg|m4a|wav|opus|flac)$/i;
let list = [];
try {
  list = fs.readdirSync(path.join(ROOT, 'art', 'music')).filter(f => AUDIO.test(f)).sort()
    .map(f => ({ name: f.replace(/\.[^.]+$/, ''), url: 'art/music/' + encodeURIComponent(f) }));
} catch {}
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'music.json'), JSON.stringify(list));
console.log(`music.json: ${list.length} трек(ов) → ${path.join(OUT, 'music.json')}`);
