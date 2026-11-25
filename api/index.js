'use strict';

const crypto = require('node:crypto');
const { neon } = require('@neondatabase/serverless');

const TYPES = new Set(['short', 'long', 'radio', 'checkbox', 'select', 'date']);
const CHOICE = new Set(['radio', 'checkbox', 'select']);
const PNG_PREFIX = 'data:image/png;base64,';
const COOKIE_NAME = 'formtanda_session';
const SESSION_SECONDS = 12 * 60 * 60;
let schemaReady;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function checkedForm(body) {
  const { title, fields } = body;
  const description = body.description ?? '';
  const active = body.active ?? true;
  if (typeof title !== 'string' || !title.trim() || title.length > 200 || typeof description !== 'string' || description.length > 5000 || typeof active !== 'boolean') {
    throw new HttpError(400, 'Judul/deskripsi tidak valid.');
  }
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > 100) throw new HttpError(400, 'Tambahkan 1–100 pertanyaan.');

  const seen = new Set();
  const cleanFields = fields.map((field) => {
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
  return { title: title.trim(), description, fields: cleanFields, active };
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
  return { answers, signature: encoded };
}

function createSql() {
  if (!process.env.DATABASE_URL) throw new HttpError(500, 'DATABASE_URL belum diatur pada environment aplikasi.');
  return neon(process.env.DATABASE_URL);
}

async function ensureSchema(sql) {
  if (!schemaReady) {
    schemaReady = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS forms (
        id varchar(24) PRIMARY KEY,
        title varchar(200) NOT NULL,
        description text NOT NULL DEFAULT '',
        fields jsonb NOT NULL,
        active boolean NOT NULL DEFAULT true,
        revision integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS responses (
        id varchar(24) PRIMARY KEY,
        form_id varchar(24) NOT NULL REFERENCES forms(id),
        created timestamptz NOT NULL,
        snapshot jsonb NOT NULL,
        answers jsonb NOT NULL,
        signature text NOT NULL,
        submission_token varchar(64)
      )`;
      await sql`ALTER TABLE responses ADD COLUMN IF NOT EXISTS submission_token varchar(64)`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS responses_form_submission_token_idx ON responses(form_id, submission_token)`;
    })().catch((error) => {
      schemaReady = undefined;
      throw error;
    });
  }
  return schemaReady;
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((part) => part.trim().split(/=(.*)/s).slice(0, 2)).filter((part) => part.length === 2));
}

function validSession(req) {
  const secret = process.env.FORMTANDA_PASSWORD;
  if (!secret) return false;
  const token = cookies(req)[COOKIE_NAME];
  if (!token) return false;
  const [issuedAt, signature, extra] = token.split('.');
  if (!issuedAt || !signature || extra !== undefined || !/^\d+$/.test(issuedAt)) return false;
  const timestamp = Number(issuedAt);
  const now = Math.floor(Date.now() / 1000);
  if (timestamp > now + 60 || now - timestamp > SESSION_SECONDS) return false;
  const expected = crypto.createHmac('sha256', secret).update(issuedAt).digest();
  let actual;
  try {
    actual = Buffer.from(signature, 'base64url');
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function requireAdmin(req) {
  if (!validSession(req)) throw new HttpError(401, 'Silakan masukkan password terlebih dahulu.');
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

function send(res, status, data, headers = {}) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data));
  res.statusCode = status;
  res.setHeader('Content-Type', Buffer.isBuffer(data) ? 'image/png' : 'application/json; charset=utf-8');
  res.setHeader('Content-Length', payload.length);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.end(payload);
}

async function readBody(req) {
  let body = req.body;
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      throw new HttpError(400, 'Data tidak valid.');
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Data tidak valid.');
  if (Buffer.byteLength(JSON.stringify(body)) > 2200000) throw new HttpError(413, 'Ukuran data terlalu besar.');
  return body;
}

function pngSignature(encoded) {
  if (typeof encoded !== 'string' || encoded.length > 1500000) throw new HttpError(400, 'File cadangan tidak valid.');
  const png = Buffer.from(encoded, 'base64');
  if (png.length < 50 || png.toString('base64') !== encoded || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new HttpError(400, 'File cadangan tidak valid.');
  return encoded;
}

async function backupData(sql) {
  const forms = await sql`SELECT id, title, description, fields, active, revision FROM forms ORDER BY created_at`;
  const rows = await sql`SELECT id, form_id, created, snapshot, answers, signature, submission_token FROM responses ORDER BY created`;
  const responses = rows.map((row) => ({
    id: row.id,
    form_id: row.form_id,
    created: row.created instanceof Date ? row.created.toISOString() : row.created,
    snapshot: row.snapshot,
    answers: row.answers,
    signature: PNG_PREFIX + row.signature,
    submission_token: row.submission_token,
  }));
  return { app: 'FormTanda', version: 1, forms, responses };
}

async function handler(req, res) {
  try {
    const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
    const rewrittenPath = req.query?.path;
    const apiPath = Array.isArray(rewrittenPath) ? rewrittenPath.join('/') : rewrittenPath;
    const pathname = apiPath ? `/api/${String(apiPath).replace(/^\/+/, '')}` : url.pathname;
    if (!pathname.startsWith('/api/')) throw new HttpError(404, 'Halaman tidak ditemukan.');

    if (pathname === '/api/session' && req.method === 'GET') return send(res, 200, { admin: validSession(req) });

    if (pathname === '/api/login' && req.method === 'POST') {
      ensureOrigin(req);
      const password = process.env.FORMTANDA_PASSWORD;
      if (!password || password.length < 8) throw new HttpError(500, 'FORMTANDA_PASSWORD belum diatur pada environment aplikasi.');
      const body = await readBody(req);
      if (typeof body.password !== 'string' || body.password.length > 1000) throw new HttpError(400, 'Password tidak valid.');
      const expected = Buffer.from(password);
      const supplied = Buffer.from(body.password);
      const valid = expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
      if (!valid) throw new HttpError(401, 'Password salah.');
      const issuedAt = String(Math.floor(Date.now() / 1000));
      const signature = crypto.createHmac('sha256', password).update(issuedAt).digest('base64url');
      const secure = process.env.NODE_ENV === 'production' || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      return send(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE_NAME}=${issuedAt}.${signature}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure}` });
    }

    ensureOrigin(req);
    if (pathname === '/api/logout' && req.method === 'POST') {
      const secure = process.env.NODE_ENV === 'production' || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      return send(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}` });
    }
    const publicMatch = pathname.match(/^\/api\/public\/([a-f0-9]{24})(\/submit)?$/);
    if (publicMatch) {
      const sql = createSql();
      await ensureSchema(sql);
      const [, formId, submitPath] = publicMatch;
      const rows = await sql`SELECT id, title, description, fields, active, revision FROM forms WHERE id = ${formId} AND active = true`;
      const form = rows[0];
      if (!form) throw new HttpError(404, 'Formulir tidak tersedia atau ditutup.');
      if (req.method === 'GET' && !submitPath) return send(res, 200, form);
      if (req.method === 'POST' && submitPath) {
        const body = await readBody(req);
        if (typeof body.submissionToken !== 'string' || !/^[a-f0-9]{64}$/.test(body.submissionToken)) throw new HttpError(400, 'Token pengiriman tidak valid. Muat ulang halaman.');
        const { answers, signature } = validateResponse(form, body);
        const responseId = crypto.randomBytes(12).toString('hex');
        const created = new Date().toISOString();
        const inserted = await sql`INSERT INTO responses (id, form_id, created, snapshot, answers, signature, submission_token)
          VALUES (${responseId}, ${formId}, ${created}, ${JSON.stringify(form)}::jsonb, ${JSON.stringify(answers)}::jsonb, ${signature}, ${body.submissionToken})
          ON CONFLICT (form_id, submission_token) DO NOTHING RETURNING id`;
        if (inserted.length) return send(res, 201, { ok: true, id: inserted[0].id });
        const existing = await sql`SELECT id FROM responses WHERE form_id = ${formId} AND submission_token = ${body.submissionToken}`;
        if (!existing.length) throw new HttpError(500, 'Respons sebelumnya tidak ditemukan. Coba muat ulang halaman.');
        return send(res, 200, { ok: true, id: existing[0].id, duplicate: true });
      }
    }

    requireAdmin(req);

  const sql = createSql();
  await ensureSchema(sql);

    if (pathname === '/api/admin/forms' && req.method === 'GET') {
      const forms = await sql`SELECT f.id, f.title, f.description, f.fields, f.active, f.revision,
        (SELECT COUNT(*)::integer FROM responses r WHERE r.form_id = f.id) AS count
        FROM forms f ORDER BY f.created_at DESC`;
      return send(res, 200, forms);
    }
    if (pathname === '/api/admin/forms' && req.method === 'POST') {
      const form = checkedForm(await readBody(req));
      const id = crypto.randomBytes(12).toString('hex');
      await sql`INSERT INTO forms (id, title, description, fields, active, revision)
        VALUES (${id}, ${form.title}, ${form.description}, ${JSON.stringify(form.fields)}::jsonb, ${form.active}, 1)`;
      return send(res, 201, { id });
    }

    const formMatch = pathname.match(/^\/api\/admin\/forms\/([a-f0-9]{24})(\/responses)?$/);
    if (formMatch) {
      const [, formId, suffix] = formMatch;
      const rows = await sql`SELECT id, title, description, fields, active, revision FROM forms WHERE id = ${formId}`;
      const current = rows[0];
      if (!current) throw new HttpError(404, 'Formulir tidak ditemukan.');
      if (req.method === 'PUT' && !suffix) {
        const form = checkedForm(await readBody(req));
        await sql`UPDATE forms SET title = ${form.title}, description = ${form.description}, fields = ${JSON.stringify(form.fields)}::jsonb,
          active = ${form.active}, revision = revision + 1 WHERE id = ${formId}`;
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && suffix === '/responses') {
        const responses = await sql`SELECT id, form_id, created, snapshot, answers, signature FROM responses WHERE form_id = ${formId} ORDER BY created DESC`;
        return send(res, 200, responses.map((row) => ({
          ...row,
          created: row.created instanceof Date ? row.created.toISOString() : row.created,
          signature: PNG_PREFIX + row.signature,
        })));
      }
    }

    if (pathname === '/api/admin/backup' && req.method === 'GET') return send(res, 200, await backupData(sql));
    if (pathname === '/api/admin/restore' && req.method === 'POST') {
      const backup = await readBody(req);
      if (backup.app !== 'FormTanda' || !Array.isArray(backup.forms) || !Array.isArray(backup.responses)) throw new HttpError(400, 'File cadangan tidak valid.');
      const validatedForms = backup.forms.map((item) => {
        if (!item || typeof item.id !== 'string' || !/^[a-f0-9]{24}$/.test(item.id) || !Number.isInteger(item.revision) || item.revision < 1) throw new HttpError(400, 'File cadangan tidak valid.');
        return { id: item.id, revision: item.revision, ...checkedForm(item) };
      });
      const validatedResponses = backup.responses.map((item) => {
        if (!item || typeof item.id !== 'string' || !/^[a-f0-9]{24}$/.test(item.id) || typeof item.form_id !== 'string' || !/^[a-f0-9]{24}$/.test(item.form_id) || typeof item.created !== 'string' || !item.snapshot || !item.answers || typeof item.signature !== 'string' || !item.signature.startsWith(PNG_PREFIX)) throw new HttpError(400, 'File cadangan tidak valid.');
        if (item.submission_token != null && (typeof item.submission_token !== 'string' || !/^[a-f0-9]{64}$/.test(item.submission_token))) throw new HttpError(400, 'File cadangan tidak valid.');
        return { ...item, signature: pngSignature(item.signature.slice(PNG_PREFIX.length)) };
      });
      for (const form of validatedForms) {
        await sql`INSERT INTO forms (id, title, description, fields, active, revision)
          VALUES (${form.id}, ${form.title}, ${form.description}, ${JSON.stringify(form.fields)}::jsonb, ${form.active}, ${form.revision})
          ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, fields = EXCLUDED.fields,
          active = EXCLUDED.active, revision = EXCLUDED.revision WHERE forms.revision <= EXCLUDED.revision`;
      }
      for (const response of validatedResponses) {
        await sql`INSERT INTO responses (id, form_id, created, snapshot, answers, signature, submission_token)
          VALUES (${response.id}, ${response.form_id}, ${response.created}, ${JSON.stringify(response.snapshot)}::jsonb,
          ${JSON.stringify(response.answers)}::jsonb, ${response.signature}, ${response.submission_token ?? null}) ON CONFLICT DO NOTHING`;
      }
      return send(res, 200, { ok: true });
    }

    const signatureMatch = pathname.match(/^\/api\/admin\/signature\/([a-f0-9]{24})$/);
    if (signatureMatch && req.method === 'GET') {
      const rows = await sql`SELECT signature FROM responses WHERE id = ${signatureMatch[1]}`;
      if (rows[0]) return send(res, 200, Buffer.from(rows[0].signature, 'base64'));
    }

    throw new HttpError(404, 'Halaman tidak ditemukan.');
  } catch (error) {
    if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : 'Kesalahan server.' });
    if (!error.status) console.error('Vercel API error:', error);
  }
}

module.exports = handler;