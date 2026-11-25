'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = __dirname;

function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

function sendJson(res, status, data) {
  const payload = Buffer.from(JSON.stringify(data));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length, 'Cache-Control': 'no-store' });
  res.end(payload);
}

async function readJsonBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2200000) throw Object.assign(new Error('Ukuran data terlalu besar.'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Data tidak valid.'), { status: 400 });
  }
}

async function start() {
  loadEnv();
  const apiHandler = require('./api/index.js');
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html' || /^\/f\/[a-f0-9]{24}$/.test(pathname))) {
      const file = path.join(ROOT, 'index.html');
      const html = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length, 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    if (!pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Halaman tidak ditemukan.' });
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') req.body = await readJsonBody(req);
      await apiHandler(req, res);
    } catch (error) {
      sendJson(res, error.status || 500, { error: error.status ? error.message : 'Kesalahan server.' });
      if (!error.status) console.error('Development server error:', error);
    }
  });
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, '127.0.0.1', () => console.log(`FormTanda berjalan di http://127.0.0.1:${port}.`));
}

if (require.main === module) start().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

module.exports = { loadEnv };