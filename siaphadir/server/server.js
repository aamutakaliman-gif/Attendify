// SiapHadir — server absensi satuan. Tanpa dependensi: Node.js >= 22.13 (node:sqlite bawaan).
// Jalankan: node server.js   (lihat README untuk variabel lingkungan)
'use strict';
process.env.TZ ||= 'Asia/Jakarta';
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const WEB_DIR = path.resolve(process.env.WEB_DIR || path.join(__dirname, '..', 'web'));
const ORIGINS = (process.env.CORS_ORIGINS || 'https://localhost,capacitor://localhost,http://localhost').split(',').map(s => s.trim()).filter(Boolean);
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 180);
fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- database ---------- */
const db = new DatabaseSync(path.join(DATA_DIR, 'siaphadir.db'));
db.exec(`
PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS personel (
  id TEXT PRIMARY KEY, nama TEXT NOT NULL, pangkat TEXT DEFAULT '', nrp TEXT UNIQUE NOT NULL, jabatan TEXT DEFAULT '',
  urut INTEGER DEFAULT 999, aktif INTEGER DEFAULT 1, role TEXT DEFAULT 'anggota',
  pin_hash TEXT, pin_salt TEXT, must_change INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS sesi (token_hash TEXT PRIMARY KEY, pid TEXT NOT NULL REFERENCES personel(id) ON DELETE CASCADE, created INTEGER, last INTEGER);
CREATE TABLE IF NOT EXISTS absen (
  pid TEXT NOT NULL, tgl TEXT NOT NULL, k TEXT NOT NULL, ket TEXT DEFAULT '', lok TEXT DEFAULT '',
  lat REAL, lng REAL, acc REAL, jam TEXT, oleh TEXT, at INTEGER, PRIMARY KEY (pid, tgl));
CREATE TABLE IF NOT EXISTS keluar (id INTEGER PRIMARY KEY AUTOINCREMENT, pid TEXT NOT NULL, tgl TEXT NOT NULL, keluar TEXT, kembali TEXT, alasan TEXT, est TEXT);
CREATE TABLE IF NOT EXISTS biodata (pid TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER, oleh TEXT);
CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, pid TEXT, aksi TEXT, detail TEXT);
CREATE INDEX IF NOT EXISTS absen_tgl ON absen(tgl);
CREATE INDEX IF NOT EXISTS keluar_tgl ON keluar(tgl);
`);
const q = sql => db.prepare(sql);

const STATUS = ['HDR','PKT','LAP','DL','BKO','BP','DIK','LPK','CT','IZN','SKT','TK'];
const DEF_JAM = { mulai: '07:00', selesai: '15:30', hari: [1,2,3,4,5] };
const getMeta = () => {
  const m = { nama: 'Satuan', logo: '', jam: DEF_JAM, video: false };
  for (const r of q('SELECT k,v FROM meta').all()) m[r.k] = JSON.parse(r.v);
  return m;
};
const setMeta = (k, v) => q('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, JSON.stringify(v));
const log = (pid, aksi, detail='') => q('INSERT INTO log(at,pid,aksi,detail) VALUES(?,?,?,?)').run(Date.now(), pid, aksi, String(detail).slice(0, 500));

/* ---------- time helpers (server clock is the authority) ---------- */
const pad = n => String(n).padStart(2, '0');
const isoDate = d => d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());
const today = () => isoDate(new Date());
const nowHM = () => { const d = new Date(); return pad(d.getHours()) + '.' + pad(d.getMinutes()); };
const hm2min = s => { const [h, m] = String(s).split(':').map(Number); return h*60 + (m||0); };
function dutyNow(jam = getMeta().jam){
  const d = new Date(), m = d.getHours()*60 + d.getMinutes();
  return jam.hari.includes(d.getDay()) && m >= hm2min(jam.mulai) && m < hm2min(jam.selesai);
}
const validDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s+'T00:00:00'));

/* ---------- auth ---------- */
const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString('hex');
const newPin = () => String(crypto.randomInt(0, 1e6)).padStart(6, '0');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
function setPin(pid, pin, mustChange){
  const salt = crypto.randomBytes(16).toString('hex');
  q('UPDATE personel SET pin_hash=?, pin_salt=?, must_change=? WHERE id=?').run(hashPin(pin, salt), salt, mustChange ? 1 : 0, pid);
}
const fails = new Map(); // nrp -> {n, until}
function authUser(req){
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return null;
  const th = sha(h.slice(7));
  const s = q('SELECT s.pid, s.last FROM sesi s WHERE token_hash=?').get(th);
  if (!s) return null;
  if (Date.now() - s.last > SESSION_DAYS*864e5){ q('DELETE FROM sesi WHERE token_hash=?').run(th); return null; }
  const u = q('SELECT id,nama,pangkat,nrp,jabatan,role,aktif,must_change FROM personel WHERE id=?').get(s.pid);
  if (!u || !u.aktif) return null;
  if (Date.now() - s.last > 6e4) q('UPDATE sesi SET last=? WHERE token_hash=?').run(Date.now(), th);
  u.admin = u.role === 'admin';
  return u;
}

/* ---------- http helpers ---------- */
class HttpError extends Error { constructor(code, msg){ super(msg); this.code = code; } }
const bad = msg => new HttpError(400, msg);
function cors(req, res){
  const o = req.headers.origin;
  if (o && ORIGINS.includes(o)){
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  }
}
function send(res, code, obj){
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req, limit = 2e6){
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit){ reject(new HttpError(413, 'Data terlalu besar')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function json(req){
  const b = await readBody(req);
  if (!b.length) return {};
  try { return JSON.parse(b.toString('utf8')); } catch { throw bad('Format data tidak valid'); }
}
const str = (v, max = 300) => String(v ?? '').trim().slice(0, max);

/* ---------- shaping (same shape as the prototype client) ---------- */
function publicPerson(p){ return { id:p.id, nama:p.nama, pangkat:p.pangkat, nrp:p.nrp, jabatan:p.jabatan, urut:p.urut, aktif:!!p.aktif, role:p.role }; }
function stateFor(u, bln, withBio){
  if (!/^\d{4}-\d{2}$/.test(bln)) bln = today().slice(0, 7);
  const meta = getMeta();
  const personel = q('SELECT * FROM personel WHERE aktif=1 ORDER BY urut, nama').all().map(publicPerson);
  const absen = {};
  const outs = {};
  for (const k of q("SELECT * FROM keluar WHERE tgl LIKE ? ORDER BY id").all(bln + '-%')) (outs[k.pid+'|'+k.tgl] ||= []).push({ keluar:k.keluar, kembali:k.kembali||'', est:k.est||'', alasan: (u.admin || k.pid === u.id) ? k.alasan : '' });
  for (const a of q('SELECT * FROM absen WHERE tgl LIKE ?').all(bln + '-%')){
    const id = bln + '_' + a.pid;
    const v = { k:a.k, ket:a.ket, lok:a.lok, jam:a.jam, by:a.oleh, at:a.at };
    if ((u.admin || a.pid === u.id) && a.lat != null) v.gps = { lat:a.lat, lng:a.lng, acc:a.acc };
    const kel = outs[a.pid+'|'+a.tgl]; if (kel) v.kel = kel;
    (absen[id] ||= { bln, pid:a.pid })['d' + a.tgl.slice(8, 10)] = v;
  }
  const bio = {};
  const rows = !withBio ? [] : u.admin ? q('SELECT pid,data FROM biodata').all() : q('SELECT pid,data FROM biodata WHERE pid=?').all(u.id);
  for (const r of rows) bio[r.pid] = JSON.parse(r.data);
  return { me: { pid:u.id, admin:u.admin, must_change:!!u.must_change }, meta: { nama:meta.nama, logo:meta.logo, jam:meta.jam, video:!!meta.video },
           personel, absen, bio: withBio ? bio : undefined, server: { now: Date.now(), today: today(), duty: dutyNow(meta.jam) } };
}

/* ---------- routes ---------- */
const routes = [];
const route = (method, pattern, opts, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), opts, fn });

route('GET', '/api/status', { pub:true }, () => {
  const m = getMeta(), n = q('SELECT COUNT(*) n FROM personel').get().n;
  return { app:'SiapHadir', setup: n === 0, nama: m.nama, logo: m.logo, video: !!m.video, jam: m.jam };
});

route('POST', '/api/setup', { pub:true }, async (req) => {
  if (q('SELECT COUNT(*) n FROM personel').get().n) throw new HttpError(409, 'Aplikasi sudah disiapkan');
  const b = await json(req);
  const nama = str(b.nama, 120), nrp = str(b.nrp, 40), pin = str(b.pin, 12);
  if (!nama || !nrp) throw bad('Nama dan NRP wajib diisi');
  if (!/^\d{6}$/.test(pin)) throw bad('PIN harus 6 angka');
  const id = 'n' + nrp.replace(/\W/g, '');
  q("INSERT INTO personel(id,nama,pangkat,nrp,jabatan,urut,role) VALUES(?,?,?,?,?,1,'admin')").run(id, nama, str(b.pangkat, 60), nrp, str(b.jabatan, 200));
  setPin(id, pin, false);
  if (b.unit) setMeta('nama', str(b.unit, 120));
  log(id, 'setup', 'Admin pertama dibuat');
  return { ok:true };
});

route('POST', '/api/login', { pub:true }, async (req) => {
  const b = await json(req);
  const nrp = str(b.nrp, 40), pin = str(b.pin, 12);
  const f = fails.get(nrp);
  if (f && f.until > Date.now()) throw new HttpError(429, 'Terlalu banyak percobaan. Coba lagi dalam 15 menit.');
  const p = q('SELECT * FROM personel WHERE nrp=? AND aktif=1').get(nrp);
  if (!p || !p.pin_hash || !crypto.timingSafeEqual(Buffer.from(hashPin(pin, p.pin_salt), 'hex'), Buffer.from(p.pin_hash, 'hex'))){
    const expired = f && f.until && f.until <= Date.now();
    const n = (expired ? 0 : (f?.n || 0)) + 1;
    fails.set(nrp, { n, until: n >= 5 ? Date.now() + 15*6e4 : 0 });
    throw new HttpError(401, 'NRP atau PIN salah');
  }
  fails.delete(nrp);
  const token = crypto.randomBytes(32).toString('base64url');
  q('INSERT INTO sesi(token_hash,pid,created,last) VALUES(?,?,?,?)').run(sha(token), p.id, Date.now(), Date.now());
  log(p.id, 'login');
  return { token, must_change: !!p.must_change };
});

route('POST', '/api/logout', {}, async (req) => {
  q('DELETE FROM sesi WHERE token_hash=?').run(sha((req.headers.authorization || '').slice(7)));
  return { ok:true };
});

route('POST', '/api/pin', {}, async (req, u) => {
  const b = await json(req);
  const p = q('SELECT pin_hash,pin_salt FROM personel WHERE id=?').get(u.id);
  if (hashPin(str(b.lama, 12), p.pin_salt) !== p.pin_hash) throw bad('PIN lama salah');
  if (!/^\d{6}$/.test(str(b.baru, 12))) throw bad('PIN baru harus 6 angka');
  if (/^(\d)\1{5}$|^123456$|^654321$/.test(b.baru)) throw bad('PIN terlalu mudah ditebak');
  setPin(u.id, b.baru, false); log(u.id, 'ganti-pin');
  return { ok:true };
});

route('GET', '/api/state', {}, (req, u, url) => stateFor(u, url.searchParams.get('bln') || '', url.searchParams.get('bio') === '1'));

route('POST', '/api/absen', {}, async (req, u) => {
  const b = await json(req);
  const pid = str(b.pid, 60);
  if (pid !== u.id && !u.admin) throw new HttpError(403, 'Anda hanya bisa mengisi absen sendiri');
  if (!q('SELECT 1 FROM personel WHERE id=? AND aktif=1').get(pid)) throw bad('Personel tidak ditemukan');
  const dates = Array.isArray(b.dates) ? b.dates.filter(validDate) : [];
  if (!dates.length || dates.length > 93) throw bad('Tanggal tidak valid');
  if (b.k === null){
    for (const t of dates) q('DELETE FROM absen WHERE pid=? AND tgl=?').run(pid, t);
    log(u.id, 'hapus-absen', pid + ' ' + dates.join(','));
    return { ok:true };
  }
  if (!STATUS.includes(b.k)) throw bad('Status tidak dikenal');
  // Privasi lokasi: koordinat hanya disimpan untuk hari ini, pada jam dinas, dan tidak sedang keperluan mendadak.
  const t0 = today();
  let gps = null;
  if (b.gps && dates.length === 1 && dates[0] === t0 && dutyNow()){
    const open = q("SELECT 1 FROM keluar WHERE pid=? AND tgl=? AND (kembali IS NULL OR kembali='')").get(pid, t0);
    const lat = Number(b.gps.lat), lng = Number(b.gps.lng), acc = Number(b.gps.acc) || null;
    if (!open && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !isNaN(lat) && !isNaN(lng)) gps = { lat, lng, acc };
  }
  const ins = q(`INSERT INTO absen(pid,tgl,k,ket,lok,lat,lng,acc,jam,oleh,at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(pid,tgl) DO UPDATE SET k=excluded.k, ket=excluded.ket, lok=excluded.lok, lat=excluded.lat, lng=excluded.lng, acc=excluded.acc, jam=excluded.jam, oleh=excluded.oleh, at=excluded.at`);
  const jam = nowHM(), at = Date.now();
  for (const t of dates) ins.run(pid, t, b.k, str(b.ket), str(b.lok, 120), gps && t === t0 ? gps.lat : null, gps && t === t0 ? gps.lng : null, gps && t === t0 ? gps.acc : null, jam, u.id, at);
  log(u.id, 'absen', `${pid} ${b.k} ${dates[0]}${dates.length > 1 ? '..' + dates[dates.length-1] : ''}${gps ? ' +gps' : ''}`);
  return { ok:true, gps: !!gps };
});

route('POST', '/api/keluar', {}, async (req, u) => {
  const b = await json(req), t = today();
  const alasan = str(b.alasan, 300);
  if (alasan.length < 5) throw bad('Tulis keterangan keperluan (minimal 5 huruf)');
  if (!dutyNow()) throw bad('Keperluan mendadak hanya berlaku pada jam dinas');
  if (!q('SELECT 1 FROM absen WHERE pid=? AND tgl=?').get(u.id, t)) throw bad('Lapor kehadiran dulu sebelum keperluan mendadak');
  if (q("SELECT 1 FROM keluar WHERE pid=? AND tgl=? AND (kembali IS NULL OR kembali='')").get(u.id, t)) throw bad('Masih ada keperluan mendadak yang belum selesai');
  q('INSERT INTO keluar(pid,tgl,keluar,alasan,est) VALUES(?,?,?,?,?)').run(u.id, t, nowHM(), alasan, str(b.est, 5));
  // Selama keluar, /api/absen menolak menyimpan koordinat baru (lihat pengecekan 'open' di sana).
  log(u.id, 'keluar', alasan);
  return { ok:true };
});
route('POST', '/api/kembali', {}, async (req, u) => {
  const r = q("UPDATE keluar SET kembali=? WHERE pid=? AND tgl=? AND (kembali IS NULL OR kembali='')").run(nowHM(), u.id, today());
  if (!r.changes) throw bad('Tidak ada keperluan mendadak yang aktif');
  log(u.id, 'kembali');
  return { ok:true };
});

route('POST', '/api/bio', {}, async (req, u) => {
  const b = await json(req);
  const pid = str(b.pid, 60);
  if (pid !== u.id && !u.admin) throw new HttpError(403, 'Anda hanya bisa mengisi biodata sendiri');
  if (!q('SELECT 1 FROM personel WHERE id=?').get(pid)) throw bad('Personel tidak ditemukan');
  const data = b.data && typeof b.data === 'object' ? b.data : {};
  const clean = {};
  for (const [k, v] of Object.entries(data)) if (/^\w{1,20}$/.test(k)) clean[k] = k === 'foto' ? String(v).slice(0, 400000) : str(v, 2000);
  if (clean.foto && !/^data:image\/(jpeg|png|webp);base64,/.test(clean.foto)) delete clean.foto;
  clean.updatedAt = Date.now(); clean.by = u.id;
  q('INSERT INTO biodata(pid,data,updated,oleh) VALUES(?,?,?,?) ON CONFLICT(pid) DO UPDATE SET data=excluded.data, updated=excluded.updated, oleh=excluded.oleh').run(pid, JSON.stringify(clean), clean.updatedAt, u.id);
  log(u.id, 'biodata', pid);
  return { ok:true };
});

/* --- admin --- */
route('POST', '/api/meta', { admin:true }, async (req, u) => {
  const b = await json(req);
  if ('nama' in b) setMeta('nama', str(b.nama, 120) || 'Satuan');
  if ('logo' in b){ const l = String(b.logo || ''); if (l && !/^data:image\/(png|webp|jpeg|svg\+xml);base64,/.test(l)) throw bad('Logo harus berupa gambar'); setMeta('logo', l.slice(0, 600000)); }
  if ('jam' in b){
    const j = b.jam || {};
    if (!/^\d{2}:\d{2}$/.test(j.mulai) || !/^\d{2}:\d{2}$/.test(j.selesai) || j.mulai >= j.selesai) throw bad('Jam dinas tidak valid');
    const hari = (Array.isArray(j.hari) ? j.hari : []).map(Number).filter(d => d >= 0 && d <= 6);
    if (!hari.length) throw bad('Pilih minimal satu hari kerja');
    setMeta('jam', { mulai: j.mulai, selesai: j.selesai, hari: [...new Set(hari)] });
  }
  if (b.video === false){ try { fs.unlinkSync(path.join(DATA_DIR, 'video.mp4')); } catch {} setMeta('video', false); }
  log(u.id, 'pengaturan', Object.keys(b).join(','));
  return { ok:true };
});
route('POST', '/api/video', { admin:true }, async (req, u) => {
  const buf = await readBody(req, 60e6);
  if (buf.length < 1000) throw bad('File video kosong');
  fs.writeFileSync(path.join(DATA_DIR, 'video.mp4'), buf);
  setMeta('video', true); log(u.id, 'video', buf.length + ' byte');
  return { ok:true };
});

function upsertPerson(b){
  const nama = str(b.nama, 120), nrp = str(b.nrp, 40);
  if (!nama || !nrp) throw bad('Nama dan NRP wajib diisi');
  const ex = b.id ? q('SELECT id FROM personel WHERE id=?').get(b.id) : q('SELECT id FROM personel WHERE nrp=?').get(nrp);
  if (ex){
    const dup = q('SELECT id FROM personel WHERE nrp=? AND id<>?').get(nrp, ex.id);
    if (dup) throw bad('NRP ' + nrp + ' sudah dipakai personel lain');
    q('UPDATE personel SET nama=?,pangkat=?,nrp=?,jabatan=?,urut=?,aktif=1 WHERE id=?').run(nama, str(b.pangkat, 60), nrp, str(b.jabatan, 200), Number(b.urut) || 999, ex.id);
    return { id: ex.id, created: false };
  }
  const id = 'n' + nrp.replace(/\W/g, '');
  q('INSERT INTO personel(id,nama,pangkat,nrp,jabatan,urut) VALUES(?,?,?,?,?,?)').run(id, nama, str(b.pangkat, 60), nrp, str(b.jabatan, 200), Number(b.urut) || 999);
  return { id, created: true };
}
route('POST', '/api/personel', { admin:true }, async (req, u) => {
  const b = await json(req); const r = upsertPerson(b);
  let pin = null; if (r.created){ pin = newPin(); setPin(r.id, pin, true); }
  log(u.id, r.created ? 'tambah-personel' : 'ubah-personel', r.id);
  return { ok:true, id:r.id, pin };
});
route('POST', '/api/personel/import', { admin:true }, async (req, u) => {
  const b = await json(req);
  const rows = Array.isArray(b.rows) ? b.rows : [];
  if (!rows.length) throw bad('Tidak ada data');
  let urut = q('SELECT COALESCE(MAX(urut),0) m FROM personel WHERE urut<999').get().m;
  const pins = [];
  db.exec('BEGIN');
  try {
    for (const r of rows){
      const [pangkat, nama, nrp, jabatan] = r.map(x => str(x, 200));
      if (!nama || !nrp) continue;
      const res = upsertPerson({ pangkat, nama, nrp, jabatan, urut: ++urut });
      if (res.created){ const pin = newPin(); setPin(res.id, pin, true); pins.push({ nrp, nama: (pangkat ? pangkat + ' ' : '') + nama, pin }); }
    }
    db.exec('COMMIT');
  } catch (e){ db.exec('ROLLBACK'); throw e; }
  log(u.id, 'impor-personel', rows.length + ' baris');
  return { ok:true, pins };
});
route('POST', '/api/personel/:id/reset-pin', { admin:true }, async (req, u, url, prm) => {
  if (!q('SELECT 1 FROM personel WHERE id=?').get(prm.id)) throw new HttpError(404, 'Personel tidak ditemukan');
  const pin = newPin(); setPin(prm.id, pin, true);
  q('DELETE FROM sesi WHERE pid=?').run(prm.id);
  log(u.id, 'reset-pin', prm.id);
  return { ok:true, pin };
});
route('POST', '/api/personel/:id/role', { admin:true }, async (req, u, url, prm) => {
  const b = await json(req);
  if (!['admin','anggota'].includes(b.role)) throw bad('Peran tidak valid');
  if (prm.id === u.id && b.role !== 'admin') throw bad('Anda tidak bisa mencabut peran admin Anda sendiri');
  q('UPDATE personel SET role=? WHERE id=?').run(b.role, prm.id);
  log(u.id, 'peran', prm.id + ' ' + b.role);
  return { ok:true };
});
route('DELETE', '/api/personel/:id', { admin:true }, async (req, u, url, prm) => {
  if (prm.id === u.id) throw bad('Anda tidak bisa menghapus akun Anda sendiri');
  q('UPDATE personel SET aktif=0 WHERE id=?').run(prm.id);
  q('DELETE FROM sesi WHERE pid=?').run(prm.id);
  log(u.id, 'nonaktif-personel', prm.id);
  return { ok:true };
});
route('GET', '/api/log', { admin:true }, () => ({ log: q('SELECT l.at,l.aksi,l.detail,p.nama,p.pangkat FROM log l LEFT JOIN personel p ON p.id=l.pid ORDER BY l.id DESC LIMIT 200').all() }));

/* ---------- static files ---------- */
const TYPES = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.webmanifest':'application/manifest+json', '.svg':'image/svg+xml', '.png':'image/png', '.webp':'image/webp', '.ico':'image/x-icon' };
function serveStatic(req, res, pathname){
  if (pathname === '/media/video'){
    const f = path.join(DATA_DIR, 'video.mp4');
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type':'video/mp4', 'Content-Length': fs.statSync(f).size, 'Cache-Control':'public, max-age=300' });
    return fs.createReadStream(f).pipe(res);
  }
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
  let file = path.join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR + path.sep) && file !== WEB_DIR) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB_DIR, 'index.html');
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600' });
  fs.createReadStream(file).pipe(res);
}

/* ---------- server ---------- */
async function handler(req, res){
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  cors(req, res);
  if (req.method === 'OPTIONS'){ res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
  try {
    for (const r of routes){
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re); if (!m) continue;
      let u = null;
      if (!r.opts.pub){ u = authUser(req); if (!u) throw new HttpError(401, 'Sesi berakhir, silakan masuk lagi'); }
      if (r.opts.admin && !u.admin) throw new HttpError(403, 'Hanya admin');
      return send(res, 200, await r.fn(req, u, url, m.groups || {}));
    }
    throw new HttpError(404, 'Tidak ditemukan');
  } catch (e){
    if (!(e instanceof HttpError)) console.error(e);
    send(res, e.code || 500, { error: e instanceof HttpError ? e.message : 'Kesalahan server' });
  }
}

const tls = process.env.TLS_CERT && process.env.TLS_KEY ? { cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) } : null;
const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
if (require.main === module) server.listen(PORT, () => console.log(`SiapHadir berjalan di ${tls ? 'https' : 'http'}://0.0.0.0:${PORT}  (data: ${DATA_DIR}, zona waktu: ${process.env.TZ})`));
module.exports = { server, db, dutyNow };
