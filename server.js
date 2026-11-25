'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const TYPES = new Set(['short', 'long', 'radio', 'checkbox', 'select', 'date']);
const CHOICE = new Set(['radio', 'checkbox', 'select']);
const PNG_PREFIX = 'data:image/png;base64,';

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

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function checkedForm(body) {
  const title = body.title;
  const description = body.description ?? '';
  const fields = body.fields;
  const active = body.active ?? true;
  if (typeof title !== 'string' || !title.trim() || title.length > 200 || typeof description !== 'string' || description.length > 5000 || typeof active !== 'boolean') {
    throw new HttpError(400, 'Judul/deskripsi tidak valid.');
  }
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > 100) throw new HttpError(400, 'Tambahkan 1–100 pertanyaan.');

  const seen = new Set();
  const clean = fields.map((field) => {
    if (!field || typeof field !== 'object' || Array.isArray(field)) throw new HttpError(400, 'Pertanyaan tidak valid.');
    const { id, label, type, required } = field;
    let options = field.options ?? [];
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id) || seen.has(id) || typeof label !== 'string' || !label.trim() || label.length > 500 || !TYPES.has(type) || typeof required !== 'boolean') {
      throw new HttpError(400, 'Periksa judul dan jenis pertanyaan.');
    }
    seen.add(id);
    if (CHOICE.has(type)) {
      if (!Array.isArray(options) || options.length < 2 || options.length > 100 || options.some((option) => typeof option !== 'string' || !option.trim() || option.length > 300) || new Set(options).size !== options.length) {
        throw new HttpError(400, 'Pertanyaan pilihan perlu minimal dua opsi unik.');
      }
    } else {
      options = [];
    }
    return { id, label: label.trim(), type, required, options };
  });
  return { title: title.trim(), description, fields: clean, active };
}

function validateResponse(form, body) {
  if (body.revision !== form.revision) throw new HttpError(400, 'Formulir berubah. Muat ulang halaman lalu isi kembali.');
  if (!body.answers || typeof body.answers !== 'object' || Array.isArray(body.answers)) throw new HttpError(400, 'Jawaban tidak valid.');
  const answers = {};
  for (const field of form.fields) {
    let value = body.answers[field.id] ?? (field.type === 'checkbox' ? [] : '');
    if (field.type === 'checkbox') {
      if (!Array.isArray(value) || value.some((option) => typeof option !== 'string' || !field.options.includes(option)) || new Set(value).size !== value.length) throw new HttpError(400, 'Pilihan tidak valid.');
    } else {
      if (typeof value !== 'string' || value.length > 10000) throw new HttpError(400, 'Jawaban terlalu panjang atau tidak valid.');
      value = value.trim();
      if (value && (field.type === 'radio' || field.type === 'select') && !field.options.includes(value)) throw new HttpError(400, 'Pilihan tidak valid.');
      if (value && field.type === 'date') {
        const date = new Date(`${value}T00:00:00.000Z`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new HttpError(400, 'Tanggal tidak valid.');
      }
    }
    if (field.required && !value.length) throw new HttpError(400, `Wajib diisi: ${field.label}`);
    answers[field.id] = value;
  }

  const signature = body.signature;
  if (typeof signature !== 'string' || !signature.startsWith(PNG_PREFIX) || signature.length > 1500000) throw new HttpError(400, 'Tanda tangan wajib diisi dan harus berupa PNG.');
  const encoded = signature.slice(PNG_PREFIX.length);
  const png = Buffer.from(encoded, 'base64');
  if (png.length < 50 || png.toString('base64') !== encoded || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new HttpError(400, 'Tanda tangan tidak valid.');
  return { answers, png };
}

function createServer(options = {}) {
  const password = options.password ?? process.env.FORMTANDA_PASSWORD;
  if (typeof password !== 'string' || password.length < 8) throw new Error('Set FORMTANDA_PASSWORD (minimal 8 karakter) di environment atau file .env.');
  const databasePath = options.databasePath ?? process.env.FORMTANDA_DB_PATH ?? path.join(ROOT, 'data.sqlite3');
  fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS forms (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      fields TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS responses (
      id TEXT PRIMARY KEY,
      form_id TEXT NOT NULL,
      created TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      answers TEXT NOT NULL,
      signature BLOB NOT NULL
    );
  `);

  const sessions = new Map();
  const cookieName = 'formtanda_session';
  const formSelect = db.prepare('SELECT id, title, description, fields, active, revision FROM forms WHERE id = ?');
  const getForm = (id) => {
    const row = formSelect.get(id);
    return row && { ...row, fields: JSON.parse(row.fields), active: Boolean(row.active) };
  };
  const parseCookies = (header = '') => Object.fromEntries(header.split(';').map((part) => part.trim().split(/=(.*)/s).slice(0, 2)).filter((part) => part.length === 2));
  const sessionToken = (req) => parseCookies(req.headers.cookie)[cookieName];
  const isAdmin = (req) => {
    const token = sessionToken(req);
    const expiry = sessions.get(token);
    if (!expiry) return false;
    if (expiry <= Date.now()) {
      sessions.delete(token);
      return false;
    }
    return true;
  };

  function send(res, status, data, headers = {}) {
    const isBuffer = Buffer.isBuffer(data);
    const payload = isBuffer ? data : Buffer.from(JSON.stringify(data));
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': payload.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      ...headers,
    });
    res.end(payload);
  }

  function sendIndex(res) {
    const file = path.join(ROOT, 'index.html');
    if (!fs.existsSync(file)) throw new HttpError(500, 'File index.html tidak ditemukan.');
    const html = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': html.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    });
    res.end(html);
  }

  async function readBody(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2200000) throw new HttpError(413, 'Ukuran data terlalu besar.');
      chunks.push(chunk);
    }
    if (!size) throw new HttpError(400, 'Data tidak valid.');
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid body');
      return body;
    } catch {
      throw new HttpError(400, 'Data tidak valid.');
    }
  }

  function ensureOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return;
    try {
      if (new URL(origin).host !== req.headers.host) throw new Error('origin mismatch');
    } catch {
      throw new HttpError(403, 'Origin tidak diizinkan.');
    }
  }

  function requireAdmin(req) {
    if (!isAdmin(req)) throw new HttpError(401, 'Silakan masukkan password terlebih dahulu.');
  }

  function backupData() {
    const forms = db.prepare('SELECT * FROM forms ORDER BY rowid').all().map((row) => getForm(row.id));
    const responses = db.prepare('SELECT id, form_id, created, snapshot, answers, signature FROM responses ORDER BY rowid').all().map((row) => ({
      id: row.id,
      form_id: row.form_id,
      created: row.created,
      snapshot: JSON.parse(row.snapshot),
      answers: JSON.parse(row.answers),
      signature: PNG_PREFIX + row.signature.toString('base64'),
    }));
    return { app: 'FormTanda', version: 1, forms, responses };
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html' || /^\/f\/[a-f0-9]{24}$/.test(pathname))) return sendIndex(res);

      if (pathname === '/api/session' && req.method === 'GET') return send(res, 200, { admin: isAdmin(req) });
      if (pathname === '/api/login' && req.method === 'POST') {
        ensureOrigin(req);
        const body = await readBody(req);
        if (typeof body.password !== 'string' || body.password.length > 1000) throw new HttpError(400, 'Password tidak valid.');
        const expected = Buffer.from(password);
        const supplied = Buffer.from(body.password);
        const valid = expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
        if (!valid) throw new HttpError(401, 'Password salah.');
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, Date.now() + 12 * 60 * 60 * 1000);
        const secure = process.env.NODE_ENV === 'production' || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
        return send(res, 200, { ok: true }, { 'Set-Cookie': `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure}` });
      }

      if (pathname.startsWith('/api/')) {
        ensureOrigin(req);
        if (pathname === '/api/logout' && req.method === 'POST') {
          const token = sessionToken(req);
          sessions.delete(token);
          return send(res, 200, { ok: true }, { 'Set-Cookie': `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
        }
        requireAdmin(req);

        const publicMatch = pathname.match(/^\/api\/public\/([a-f0-9]{24})(\/submit)?$/);
        if (publicMatch) {
          const [, formId, submitPath] = publicMatch;
          const form = db.prepare('SELECT * FROM forms WHERE id = ? AND active = 1').get(formId);
          if (!form) throw new HttpError(404, 'Formulir tidak tersedia atau ditutup.');
          const decoded = { ...form, fields: JSON.parse(form.fields), active: Boolean(form.active) };
          if (req.method === 'GET' && !submitPath) return send(res, 200, decoded);
          if (req.method === 'POST' && submitPath) {
            const body = await readBody(req);
            const { answers, png } = validateResponse(decoded, body);
            const responseId = crypto.randomBytes(12).toString('hex');
            db.prepare('INSERT INTO responses (id, form_id, created, snapshot, answers, signature) VALUES (?, ?, ?, ?, ?, ?)').run(
              responseId,
              formId,
              new Date().toISOString(),
              JSON.stringify(decoded),
              JSON.stringify(answers),
              png,
            );
            return send(res, 201, { ok: true, id: responseId });
          }
        }

        if (pathname === '/api/admin/forms' && req.method === 'GET') {
          const forms = db.prepare(`SELECT f.*, (SELECT COUNT(*) FROM responses r WHERE r.form_id = f.id) AS count
            FROM forms f ORDER BY f.rowid DESC`).all();
          return send(res, 200, forms.map((row) => ({ ...getForm(row.id), count: row.count })));
        }
        if (pathname === '/api/admin/forms' && req.method === 'POST') {
          const form = checkedForm(await readBody(req));
          const id = crypto.randomBytes(12).toString('hex');
          db.prepare('INSERT INTO forms (id, title, description, fields, active, revision) VALUES (?, ?, ?, ?, ?, 1)').run(id, form.title, form.description, JSON.stringify(form.fields), Number(form.active));
          return send(res, 201, { id });
        }

        const formMatch = pathname.match(/^\/api\/admin\/forms\/([a-f0-9]{24})(\/responses)?$/);
        if (formMatch) {
          const [, formId, suffix] = formMatch;
          const current = getForm(formId);
          if (!current) throw new HttpError(404, 'Formulir tidak ditemukan.');
          if (req.method === 'PUT' && !suffix) {
            const form = checkedForm(await readBody(req));
            db.prepare('UPDATE forms SET title = ?, description = ?, fields = ?, active = ?, revision = revision + 1 WHERE id = ?').run(form.title, form.description, JSON.stringify(form.fields), Number(form.active), formId);
            return send(res, 200, { ok: true });
          }
          if (req.method === 'GET' && suffix === '/responses') {
            const rows = db.prepare('SELECT id, form_id, created, snapshot, answers, signature FROM responses WHERE form_id = ? ORDER BY rowid DESC').all(formId);
            return send(res, 200, rows.map((row) => ({
              id: row.id,
              form_id: row.form_id,
              created: row.created,
              snapshot: JSON.parse(row.snapshot),
              answers: JSON.parse(row.answers),
              signature: PNG_PREFIX + row.signature.toString('base64'),
            })));
          }
        }

        if (pathname === '/api/admin/backup' && req.method === 'GET') return send(res, 200, backupData());
        if (pathname === '/api/admin/restore' && req.method === 'POST') {
          const backup = await readBody(req);
          if (backup.app !== 'FormTanda' || !Array.isArray(backup.forms) || !Array.isArray(backup.responses)) throw new HttpError(400, 'File cadangan tidak valid.');
          db.exec('BEGIN');
          try {
            const saveForm = db.prepare(`INSERT INTO forms (id, title, description, fields, active, revision) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET title=excluded.title, description=excluded.description, fields=excluded.fields, active=excluded.active, revision=excluded.revision`);
            for (const item of backup.forms) {
              if (!item || typeof item.id !== 'string' || !/^[a-f0-9]{24}$/.test(item.id) || !Number.isInteger(item.revision) || item.revision < 1) throw new HttpError(400, 'File cadangan tidak valid.');
              const form = checkedForm(item);
              const existing = getForm(item.id);
              if (!existing || item.revision >= existing.revision) saveForm.run(item.id, form.title, form.description, JSON.stringify(form.fields), Number(form.active), item.revision);
            }
            const saveResponse = db.prepare('INSERT OR IGNORE INTO responses (id, form_id, created, snapshot, answers, signature) VALUES (?, ?, ?, ?, ?, ?)');
            for (const item of backup.responses) {
              if (!item || typeof item.id !== 'string' || !/^[a-f0-9]{24}$/.test(item.id) || typeof item.form_id !== 'string' || !/^[a-f0-9]{24}$/.test(item.form_id) || typeof item.created !== 'string' || !item.snapshot || !item.answers || typeof item.signature !== 'string' || !item.signature.startsWith(PNG_PREFIX)) throw new HttpError(400, 'File cadangan tidak valid.');
              const encoded = item.signature.slice(PNG_PREFIX.length);
              const png = Buffer.from(encoded, 'base64');
              if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new HttpError(400, 'File cadangan tidak valid.');
              saveResponse.run(item.id, item.form_id, item.created, JSON.stringify(item.snapshot), JSON.stringify(item.answers), png);
            }
            db.exec('COMMIT');
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
          return send(res, 200, { ok: true });
        }

        const signatureMatch = pathname.match(/^\/api\/admin\/signature\/([a-f0-9]{24})$/);
        if (signatureMatch && req.method === 'GET') {
          const row = db.prepare('SELECT signature FROM responses WHERE id = ?').get(signatureMatch[1]);
          if (row) return send(res, 200, row.signature, { 'Content-Type': 'image/png' });
        }
      }

      throw new HttpError(404, 'Halaman tidak ditemukan.');
    } catch (error) {
      if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : 'Kesalahan server.' });
      if (!error.status) console.error('Server error:', error);
    }
  });

  server.on('close', () => db.close());
  return server;
}

if (require.main === module) {
  loadEnv();
  const server = createServer();
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
  server.listen(port, host, () => console.log(`FormTanda berjalan di http://${host}:${port}.`));
}

module.exports = { createServer, checkedForm, validateResponse, loadEnv };