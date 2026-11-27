'use strict';

const crypto = require('node:crypto');
const { neon } = require('@neondatabase/serverless');

const TYPES = new Set(['short', 'long', 'radio', 'checkbox', 'select', 'date', 'image', 'description']);
const CHOICE = new Set(['radio', 'checkbox', 'select']);
const PNG_PREFIX = 'data:image/png;base64,';
const COOKIE_NAME = 'formtanda_session';
const SESSION_SECONDS = 12 * 60 * 60;
const MAX_PAGES = 10;
const MAX_ANSWER_IMAGES = 10;
const MAX_BODY = 4200000;
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 1048576;
const MAX_PENDING_ATTACHMENTS = 1000;
const FILE_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  csv: 'text/csv',
  zip: 'application/zip',
};
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
  const adminTitle = body.adminTitle ?? '';
  if (typeof adminTitle !== 'string' || adminTitle.trim().length > 200) throw new HttpError(400, 'Nama formulir (admin) terlalu panjang atau tidak valid.');
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
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id) || seen.has(id) || typeof label !== 'string' || !label.trim() || label.length > 5000 || !TYPES.has(type) || typeof required !== 'boolean') {
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
    const page = field.page ?? 0;
    if (!Number.isInteger(page) || page < 0 || page >= MAX_PAGES) throw new HttpError(400, `Halaman tidak valid (maksimal ${MAX_PAGES} halaman).`);
    const pageTitle = typeof field.pageTitle === 'string' ? field.pageTitle.trim().slice(0, 200) : '';
    const pageDescription = typeof field.pageDescription === 'string' ? field.pageDescription.slice(0, 5000) : '';
    let image = field.image;
    if (image !== undefined && image !== null && image !== '') {
      if (typeof image !== 'string' || !(/^[a-f0-9]{24}$/.test(image) || (image.startsWith('data:image/') && image.length <= 700000))) throw new HttpError(400, 'Gambar pertanyaan tidak valid atau terlalu besar.');
    } else {
      image = undefined;
    }
    return { id, label: label.trim(), type, required: type === 'description' ? false : required, options, page, ...(image ? { image } : {}), ...(pageTitle ? { pageTitle } : {}), ...(pageDescription.trim() ? { pageDescription } : {}) };
  });
  const pageNumbers = cleanFields.map((field) => field.page);
  const pageCount = Math.max(...pageNumbers) + 1;
  for (let i = 0; i < pageNumbers.length; i += 1) {
    if (i > 0 && pageNumbers[i] < pageNumbers[i - 1]) throw new HttpError(400, 'Urutan halaman tidak valid.');
  }
  for (let page = 0; page < pageCount; page += 1) {
    if (!pageNumbers.includes(page)) throw new HttpError(400, `Halaman ${page + 1} belum punya pertanyaan.`);
  }
  return { title: title.trim(), adminTitle: adminTitle.trim(), description, fields: cleanFields, active };
}

function validateResponse(form, body) {
  if (body.revision !== form.revision) throw new HttpError(400, 'Formulir berubah. Muat ulang halaman lalu isi kembali.');
  if (!body.answers || typeof body.answers !== 'object' || Array.isArray(body.answers)) throw new HttpError(400, 'Jawaban tidak valid.');
  const answers = {};
  const uploads = {};
  for (const field of form.fields) {
    if (field.type === 'description') continue;
    let value = body.answers[field.id] ?? (field.type === 'checkbox' ? [] : '');
    if (field.type === 'image') {
      if (typeof value !== 'string' && !Array.isArray(value)) throw new HttpError(400, 'Gambar tidak valid.');
      const list = Array.isArray(value) ? value : (value ? [value] : []);
      if (list.length > MAX_ANSWER_IMAGES) throw new HttpError(400, `Maksimal ${MAX_ANSWER_IMAGES} gambar per pertanyaan.`);
      if (list.length) uploads[field.id] = list.map((item) => parseImage(item));
      value = list.map(() => 'x');
    } else if (field.type === 'checkbox') {
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

  if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 200) throw new HttpError(400, 'Nama wajib diisi (maksimal 200 karakter).');
  const name = body.name.trim();

  if (typeof body.position !== 'string' || !body.position.trim() || body.position.trim().length > 200) throw new HttpError(400, 'Jabatan/Divisi wajib diisi (maksimal 200 karakter).');
  const position = body.position.trim();

  const pageCount = formPageCount(form);
  let signatures = body.signatures;
  if (signatures === undefined && typeof body.signature === 'string' && pageCount === 1) signatures = [body.signature];
  if (!Array.isArray(signatures) || signatures.length !== pageCount) throw new HttpError(400, 'Tanda tangan wajib diisi pada setiap halaman.');
  const encodedSignatures = signatures.map((signature, index) => {
    if (typeof signature !== 'string' || !signature.startsWith(PNG_PREFIX) || signature.length > 1500000) throw new HttpError(400, `Tanda tangan halaman ${index + 1} wajib diisi dan harus berupa PNG.`);
    const encoded = signature.slice(PNG_PREFIX.length);
    const png = Buffer.from(encoded, 'base64');
    if (png.length < 50 || png.toString('base64') !== encoded || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new HttpError(400, `Tanda tangan halaman ${index + 1} tidak valid.`);
    return encoded;
  });
  return { answers, name, position, signatures: encodedSignatures, uploads };
}

function parseImage(dataUri) {
  if (typeof dataUri !== 'string' || dataUri.length > 700000) throw new HttpError(400, 'Gambar terlalu besar (maksimal sekitar 500 KB setelah dikompres).');
  const match = dataUri.match(/^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw new HttpError(400, 'Format gambar tidak didukung (gunakan JPG atau PNG).');
  const buf = Buffer.from(match[2], 'base64');
  const jpeg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const png = buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (buf.length < 100 || (match[1] === 'image/jpeg' && !jpeg) || (match[1] === 'image/png' && !png)) throw new HttpError(400, 'File gambar tidak valid.');
  return { mime: match[1], b64: match[2] };
}

function fileExtension(name) {
  const match = /\.([a-z0-9]{1,5})$/i.exec(name);
  return match ? match[1].toLowerCase() : '';
}

function parseAttachment(form, body) {
  const field = form.fields.find((item) => item.id === body.fieldId);
  if (!field || field.type === 'description' || field.type === 'image') throw new HttpError(400, 'Pertanyaan untuk lampiran tidak valid.');
  const name = typeof body.name === 'string' ? body.name.replace(/[\u0000-\u001f\u007f\\/]/g, '').trim() : '';
  const extension = fileExtension(name);
  if (!name || name.length > 200 || !Object.hasOwn(FILE_TYPES, extension)) throw new HttpError(400, 'Nama atau jenis file tidak didukung.');
  if (typeof body.data !== 'string' || !body.data) throw new HttpError(400, 'File kosong atau tidak valid.');
  if (body.data.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4) throw new HttpError(413, 'Ukuran lampiran maksimal 1 MB.');
  const buf = Buffer.from(body.data, 'base64');
  if (!buf.length || buf.toString('base64') !== body.data) throw new HttpError(400, 'File kosong atau tidak valid.');
  if (buf.length > MAX_ATTACHMENT_BYTES) throw new HttpError(413, 'Ukuran lampiran maksimal 1 MB.');

  // Isi file harus cocok dengan ekstensinya.
  const starts = (...bytes) => buf.subarray(0, bytes.length).equals(Buffer.from(bytes));
  const jpeg = starts(0xff, 0xd8, 0xff);
  const png = starts(137, 80, 78, 71, 13, 10, 26, 10);
  const zip = starts(0x50, 0x4b);
  const ole = starts(0xd0, 0xcf, 0x11, 0xe0);
  let mime = FILE_TYPES[extension];
  let valid;
  if (mime.startsWith('image/')) {
    valid = jpeg || png;
    mime = png ? 'image/png' : 'image/jpeg';
  } else if (extension === 'pdf') valid = starts(0x25, 0x50, 0x44, 0x46);
  else if (['docx', 'xlsx', 'pptx', 'zip'].includes(extension)) valid = zip;
  else if (['doc', 'xls', 'ppt'].includes(extension)) valid = ole;
  else valid = !buf.includes(0);
  if (!valid) throw new HttpError(400, 'Isi file tidak sesuai dengan jenisnya.');
  return { fieldId: field.id, name, mime, size: buf.length, b64: body.data };
}

function requestedAttachments(form, body) {
  const input = body.attachments ?? {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Lampiran tidak valid.');
  const allowed = new Set(form.fields.filter((field) => field.type !== 'description' && field.type !== 'image').map((field) => field.id));
  const seen = new Set();
  const result = [];
  for (const [fieldId, ids] of Object.entries(input)) {
    if (!allowed.has(fieldId) || !Array.isArray(ids)) throw new HttpError(400, 'Lampiran tidak valid.');
    if (ids.length > MAX_ATTACHMENTS) throw new HttpError(400, `Maksimal ${MAX_ATTACHMENTS} lampiran per pertanyaan.`);
    for (const id of ids) {
      if (typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id) || seen.has(id)) throw new HttpError(400, 'Lampiran tidak valid.');
      seen.add(id);
      result.push({ fieldId, id });
    }
  }
  return result;
}

async function findAttachments(sql, formId, requested) {
  const result = {};
  if (!requested.length) return result;
  const ids = requested.map((item) => item.id);
  const rows = await sql`SELECT id, field_id, name, mime, size FROM attachments WHERE form_id = ${formId} AND response_id IS NULL AND jsonb_exists(${JSON.stringify(ids)}::jsonb, id)`;
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const { fieldId, id } of requested) {
    const row = byId.get(id);
    if (!row || row.field_id !== fieldId) throw new HttpError(400, 'Lampiran tidak ditemukan. Tekan Kirim sekali lagi untuk mengunggah ulang.');
    (result[fieldId] ||= []).push({ id, name: row.name, mime: row.mime, size: row.size });
  }
  return result;
}

function backupAttachments(value) {
  const result = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [fieldId, list] of Object.entries(value)) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(fieldId) || !Array.isArray(list)) throw new HttpError(400, 'File cadangan tidak valid.');
    result[fieldId] = list.map((item) => {
      if (!item || typeof item.id !== 'string' || !/^[a-f0-9]{24}$/.test(item.id) || typeof item.name !== 'string' || typeof item.mime !== 'string' || !Number.isInteger(item.size)) throw new HttpError(400, 'File cadangan tidak valid.');
      return { id: item.id, name: item.name.slice(0, 200), mime: item.mime.slice(0, 100), size: item.size };
    });
  }
  return result;
}

async function storeFieldImages(sql, formId, fields) {
  const copied = new Map();
  for (const field of fields) {
    const image = field.image;
    if (!image) {
      delete field.image;
      continue;
    }
    if (image.startsWith('data:')) {
      const { mime, b64 } = parseImage(image);
      const id = crypto.randomBytes(12).toString('hex');
      await sql`INSERT INTO images (id, form_id, kind, mime, data) VALUES (${id}, ${formId}, 'question', ${mime}, ${b64})`;
      field.image = id;
      continue;
    }
    if (copied.has(image)) {
      field.image = copied.get(image);
      continue;
    }
    const rows = await sql`SELECT form_id, mime, data FROM images WHERE id = ${image} AND kind = 'question'`;
    if (!rows[0]) {
      delete field.image;
      continue;
    }
    if (rows[0].form_id !== formId) {
      const id = crypto.randomBytes(12).toString('hex');
      await sql`INSERT INTO images (id, form_id, kind, mime, data) VALUES (${id}, ${formId}, 'question', ${rows[0].mime}, ${rows[0].data})`;
      copied.set(image, id);
      field.image = id;
    }
  }
}

function formPageCount(form) {
  return Math.max(0, ...form.fields.map((field) => field.page ?? 0)) + 1;
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
        signature text NOT NULL
      )`;
      await sql`CREATE TABLE IF NOT EXISTS images (
        id varchar(24) PRIMARY KEY,
        form_id varchar(24) NOT NULL,
        kind varchar(10) NOT NULL,
        mime varchar(20) NOT NULL,
        data text NOT NULL,
        created timestamptz NOT NULL DEFAULT now()
      )`;
      await sql`CREATE INDEX IF NOT EXISTS images_form_idx ON images (form_id)`;
      await sql`ALTER TABLE forms ADD COLUMN IF NOT EXISTS admin_title varchar(200) NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE responses ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE responses ADD COLUMN IF NOT EXISTS position text NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE responses ADD COLUMN IF NOT EXISTS signatures jsonb NOT NULL DEFAULT '[]'::jsonb`;
      await sql`ALTER TABLE responses ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '{}'::jsonb`;
      await sql`CREATE TABLE IF NOT EXISTS attachments (
        id varchar(24) PRIMARY KEY,
        form_id varchar(24) NOT NULL,
        field_id varchar(80) NOT NULL,
        response_id varchar(24),
        name varchar(200) NOT NULL,
        mime varchar(100) NOT NULL,
        size integer NOT NULL,
        data text NOT NULL,
        created timestamptz NOT NULL DEFAULT now()
      )`;
      await sql`CREATE INDEX IF NOT EXISTS attachments_form_idx ON attachments (form_id)`;
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
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY) throw new HttpError(413, 'Ukuran data terlalu besar.');
  return body;
}

function pngSignature(encoded) {
  if (typeof encoded !== 'string' || encoded.length > 1500000) throw new HttpError(400, 'File cadangan tidak valid.');
  const png = Buffer.from(encoded, 'base64');
  if (png.length < 50 || png.toString('base64') !== encoded || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new HttpError(400, 'File cadangan tidak valid.');
  return encoded;
}

function publicResponse(row) {
  const list = Array.isArray(row.signatures) && row.signatures.length ? row.signatures : [row.signature];
  return {
    id: row.id,
    form_id: row.form_id,
    created: row.created instanceof Date ? row.created.toISOString() : row.created,
    snapshot: row.snapshot,
    answers: row.answers,
    name: row.name || '',
    position: row.position || '',
    signature: PNG_PREFIX + row.signature,
    signatures: list.map((item) => PNG_PREFIX + item),
    attachments: row.attachments || {},
  };
}

async function backupData(sql) {
  const forms = await sql`SELECT id, title, admin_title AS "adminTitle", description, fields, active, revision FROM forms ORDER BY created_at`;
  const rows = await sql`SELECT id, form_id, created, snapshot, answers, signature, name, position, signatures, attachments FROM responses ORDER BY created`;
  const responses = rows.map(publicResponse);
  return { app: 'FormTanda', version: 2, forms, responses };
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
    const publicImage = pathname.match(/^\/api\/public\/image\/([a-f0-9]{24})$/);
    if (publicImage && req.method === 'GET') {
      const sqlImg = createSql();
      await ensureSchema(sqlImg);
      const found = await sqlImg`SELECT mime, data FROM images WHERE id = ${publicImage[1]} AND kind = 'question'`;
      if (!found[0]) throw new HttpError(404, 'Gambar tidak ditemukan.');
      return send(res, 200, Buffer.from(found[0].data, 'base64'), { 'Content-Type': found[0].mime, 'Cache-Control': 'public, max-age=31536000, immutable' });
    }
    const publicMatch = pathname.match(/^\/api\/public\/([a-f0-9]{24})(\/submit|\/upload)?$/);
    if (publicMatch) {
      const sql = createSql();
      await ensureSchema(sql);
      const [, formId, action] = publicMatch;
      const rows = await sql`SELECT id, title, description, fields, active, revision FROM forms WHERE id = ${formId} AND active = true`;
      const form = rows[0];
      if (!form) throw new HttpError(404, 'Formulir tidak tersedia atau ditutup.');
      if (req.method === 'GET' && !action) return send(res, 200, form);
      if (req.method === 'POST' && action === '/upload') {
        const file = parseAttachment(form, await readBody(req));
        // Buang unggahan yang tidak pernah dikirim, lalu batasi tumpukan yang belum terkirim.
        await sql`DELETE FROM attachments WHERE response_id IS NULL AND created < now() - interval '24 hours'`;
        const pending = await sql`SELECT COUNT(*)::integer AS count FROM attachments WHERE form_id = ${formId} AND response_id IS NULL`;
        if (pending[0].count >= MAX_PENDING_ATTACHMENTS) throw new HttpError(429, 'Terlalu banyak unggahan tertunda. Coba lagi nanti.');
        const id = crypto.randomBytes(12).toString('hex');
        await sql`INSERT INTO attachments (id, form_id, field_id, name, mime, size, data)
          VALUES (${id}, ${formId}, ${file.fieldId}, ${file.name}, ${file.mime}, ${file.size}, ${file.b64})`;
        return send(res, 201, { id });
      }
      if (req.method === 'POST' && action === '/submit') {
        const body = await readBody(req);
        const { answers, name, position, signatures, uploads } = validateResponse(form, body);
        const requested = requestedAttachments(form, body);
        const attachments = await findAttachments(sql, formId, requested);
        const attachmentIds = JSON.stringify(requested.map((item) => item.id));
        const responseId = crypto.randomBytes(12).toString('hex');
        const created = new Date().toISOString();
        for (const [fieldId, imgs] of Object.entries(uploads)) {
          const ids = [];
          for (const img of imgs) {
            const imageId = crypto.randomBytes(12).toString('hex');
            await sql`INSERT INTO images (id, form_id, kind, mime, data) VALUES (${imageId}, ${formId}, 'answer', ${img.mime}, ${img.b64})`;
            ids.push(imageId);
          }
          answers[fieldId] = ids;
        }
        await sql`WITH saved AS (
          INSERT INTO responses (id, form_id, created, snapshot, answers, signature, name, position, signatures, attachments)
          VALUES (${responseId}, ${formId}, ${created}, ${JSON.stringify(form)}::jsonb, ${JSON.stringify(answers)}::jsonb, ${signatures[0]}, ${name}, ${position}, ${JSON.stringify(signatures)}::jsonb, ${JSON.stringify(attachments)}::jsonb)
          RETURNING id)
          UPDATE attachments SET response_id = saved.id FROM saved
          WHERE attachments.form_id = ${formId} AND attachments.response_id IS NULL AND jsonb_exists(${attachmentIds}::jsonb, attachments.id)`;
        return send(res, 201, { ok: true, id: responseId });
      }
    }

    requireAdmin(req);

    const sql = createSql();
    await ensureSchema(sql);

    if (pathname === '/api/admin/forms' && req.method === 'GET') {
      const forms = await sql`SELECT f.id, f.title, f.admin_title AS "adminTitle", f.description, f.fields, f.active, f.revision,
        (SELECT COUNT(*)::integer FROM responses r WHERE r.form_id = f.id) AS count
        FROM forms f ORDER BY f.created_at DESC`;
      return send(res, 200, forms);
    }
    if (pathname === '/api/admin/forms' && req.method === 'POST') {
      const form = checkedForm(await readBody(req));
      const id = crypto.randomBytes(12).toString('hex');
      await storeFieldImages(sql, id, form.fields);
      await sql`INSERT INTO forms (id, title, admin_title, description, fields, active, revision)
        VALUES (${id}, ${form.title}, ${form.adminTitle}, ${form.description}, ${JSON.stringify(form.fields)}::jsonb, ${form.active}, 1)`;
      return send(res, 201, { id });
    }

    const formMatch = pathname.match(/^\/api\/admin\/forms\/([a-f0-9]{24})(\/responses)?$/);
    if (formMatch) {
      const [, formId, suffix] = formMatch;
      const rows = await sql`SELECT id, title, description, fields, active, revision FROM forms WHERE id = ${formId}`;
      const current = rows[0];
      if (!current) throw new HttpError(404, 'Formulir tidak ditemukan.');
      if (req.method === 'DELETE' && !suffix) {
        await sql`WITH removed AS (DELETE FROM responses WHERE form_id = ${formId}), removed_images AS (DELETE FROM images WHERE form_id = ${formId}), removed_files AS (DELETE FROM attachments WHERE form_id = ${formId}) DELETE FROM forms WHERE id = ${formId}`;
        return send(res, 200, { ok: true });
      }
      if (req.method === 'PUT' && !suffix) {
        const form = checkedForm(await readBody(req));
        await storeFieldImages(sql, formId, form.fields);
        await sql`UPDATE forms SET title = ${form.title}, admin_title = ${form.adminTitle}, description = ${form.description}, fields = ${JSON.stringify(form.fields)}::jsonb,
          active = ${form.active}, revision = revision + 1 WHERE id = ${formId}`;
        const keep = form.fields.map((field) => field.image).filter(Boolean);
        await sql`DELETE FROM images WHERE form_id = ${formId} AND kind = 'question' AND NOT jsonb_exists(${JSON.stringify(keep)}::jsonb, id)`;
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && suffix === '/responses') {
        const responses = await sql`SELECT id, form_id, created, snapshot, answers, signature, name, position, signatures, attachments FROM responses WHERE form_id = ${formId} ORDER BY created DESC`;
        return send(res, 200, responses.map(publicResponse));
      }
    }

    const adminImage = pathname.match(/^\/api\/admin\/image\/([a-f0-9]{24})$/);
    if (adminImage && req.method === 'GET') {
      const found = await sql`SELECT mime, data FROM images WHERE id = ${adminImage[1]}`;
      if (!found[0]) throw new HttpError(404, 'Gambar tidak ditemukan.');
      return send(res, 200, Buffer.from(found[0].data, 'base64'), { 'Content-Type': found[0].mime, 'Cache-Control': 'private, max-age=3600' });
    }

    const adminFile = pathname.match(/^\/api\/admin\/attachment\/([a-f0-9]{24})$/);
    if (adminFile && req.method === 'GET') {
      const found = await sql`SELECT name, mime, data FROM attachments WHERE id = ${adminFile[1]}`;
      if (!found[0]) throw new HttpError(404, 'Lampiran tidak ditemukan.');
      const disposition = found[0].mime.startsWith('image/') ? 'inline' : 'attachment';
      const encodedName = encodeURIComponent(found[0].name.toWellFormed ? found[0].name.toWellFormed() : found[0].name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
      return send(res, 200, Buffer.from(found[0].data, 'base64'), {
        'Content-Type': found[0].mime,
        'Content-Disposition': `${disposition}; filename*=UTF-8''${encodedName}`,
        'Cache-Control': 'private, max-age=3600',
      });
    }

    if (pathname === '/api/admin/backup' && req.method === 'GET') return send(res, 200, await backupData(sql));
    if (pathname === '/api/admin/restore' && req.method === 'POST') {
      const backup = await readBody(req);
      if (backup.app !== 'FormTanda' || !Array.isArray(backup.forms) || !Array.isArray(backup.responses)) throw new HttpError(400, 'File cadangan tidak valid.');
      const validatedForms = backup.forms.map((item) => {
        if (!item || typeof item.id !== 'string' || !/^[a-f0-9]{24}$/.test(item.id) || !Number.isInteger(item.revision) || item.revision < 1) throw new HttpError(400, 'File cadangan tidak valid.');
        const cleaned = checkedForm(item);
        cleaned.fields = cleaned.fields.map((field) => (field.image && field.image.startsWith('data:') ? { ...field, image: undefined } : field));
        return { id: item.id, revision: item.revision, ...cleaned };
      });
      const validatedResponses = backup.responses.map((item) => {
        if (!item || typeof item.id !== 'string' || !/^[a-f0-9]{24}$/.test(item.id) || typeof item.form_id !== 'string' || !/^[a-f0-9]{24}$/.test(item.form_id) || typeof item.created !== 'string' || !item.snapshot || !item.answers || typeof item.signature !== 'string' || !item.signature.startsWith(PNG_PREFIX)) throw new HttpError(400, 'File cadangan tidak valid.');
        const signature = pngSignature(item.signature.slice(PNG_PREFIX.length));
        const rawList = Array.isArray(item.signatures) && item.signatures.length ? item.signatures : [item.signature];
        const signatures = rawList.map((entry) => {
          if (typeof entry !== 'string' || !entry.startsWith(PNG_PREFIX)) throw new HttpError(400, 'File cadangan tidak valid.');
          return pngSignature(entry.slice(PNG_PREFIX.length));
        });
        const name = typeof item.name === 'string' ? item.name.slice(0, 200) : '';
        const position = typeof item.position === 'string' ? item.position.slice(0, 200) : '';
        return { ...item, signature, signatures, name, position, attachments: backupAttachments(item.attachments) };
      });
      for (const form of validatedForms) {
        await sql`INSERT INTO forms (id, title, admin_title, description, fields, active, revision)
          VALUES (${form.id}, ${form.title}, ${form.adminTitle}, ${form.description}, ${JSON.stringify(form.fields)}::jsonb, ${form.active}, ${form.revision})
          ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, admin_title = EXCLUDED.admin_title, description = EXCLUDED.description, fields = EXCLUDED.fields,
          active = EXCLUDED.active, revision = EXCLUDED.revision WHERE forms.revision <= EXCLUDED.revision`;
      }
      for (const response of validatedResponses) {
        await sql`INSERT INTO responses (id, form_id, created, snapshot, answers, signature, name, position, signatures, attachments)
          VALUES (${response.id}, ${response.form_id}, ${response.created}, ${JSON.stringify(response.snapshot)}::jsonb,
          ${JSON.stringify(response.answers)}::jsonb, ${response.signature}, ${response.name}, ${response.position}, ${JSON.stringify(response.signatures)}::jsonb, ${JSON.stringify(response.attachments)}::jsonb) ON CONFLICT (id) DO NOTHING`;
      }
      return send(res, 200, { ok: true });
    }

    const signatureMatch = pathname.match(/^\/api\/admin\/signature\/([a-f0-9]{24})(?:\/(\d{1,2}))?$/);
    if (signatureMatch && req.method === 'GET') {
      const rows = await sql`SELECT signature, signatures FROM responses WHERE id = ${signatureMatch[1]}`;
      const page = Number(signatureMatch[2] || 0);
      const list = rows[0] && Array.isArray(rows[0].signatures) && rows[0].signatures.length ? rows[0].signatures : rows[0] ? [rows[0].signature] : [];
      if (list[page]) return send(res, 200, Buffer.from(list[page], 'base64'));
    }

    throw new HttpError(404, 'Halaman tidak ditemukan.');
  } catch (error) {
    if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : 'Kesalahan server.' });
    if (!error.status) console.error('Vercel API error:', error);
  }
}

module.exports = handler;