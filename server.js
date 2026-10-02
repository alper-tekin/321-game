import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { loadData } from './data.js';
import { GameServer } from './game.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3210;

const data = loadData(path.join(ROOT, 'data', 'football.json'));
console.log(`Veri yüklendi: ${data.clubs.length} kulüp, ${data.players.length} oyuncu (${data.builtAt})`);

// Takım seçimi için istemciye gönderilen liste. Seçim Wikidata kimliğiyle yapılır, veri yenilense de kaymaz.
const clubsJson = JSON.stringify(data.clubs.map((c) => [c.id, c.name, c.country, c.aliases]));

const game = new GameServer(data);

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/clubs') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    return res.end(clubsJson);
  }
  if (url.pathname === '/healthz') {
    res.writeHead(200);
    return res.end('ok');
  }
  const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, body) => {
    if (err) {
      res.writeHead(404);
      return res.end('Bulunamadı');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
wss.on('connection', (conn) => {
  conn.isAlive = true;
  conn.on('pong', () => { conn.isAlive = true; });
  conn.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg && typeof msg.t === 'string') game.handle(conn, msg);
  });
  conn.on('close', () => game.disconnected(conn));
});

// Kopan bağlantıları tespit et (telefon kilitlenmesi vb.)
setInterval(() => {
  for (const conn of wss.clients) {
    if (!conn.isAlive) { conn.terminate(); continue; }
    conn.isAlive = false;
    conn.ping();
  }
}, 20_000).unref();

server.listen(PORT, () => console.log(`3-2-1 oyunu çalışıyor: http://localhost:${PORT}`));
