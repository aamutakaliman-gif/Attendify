// Tes API: node --test test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'siaphadir-'));
const { server } = require('./server.js');
let base;
const call = async (method, url, body, token) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const todayISO = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); };
const ALL_DAY = { mulai: '00:00', selesai: '23:59', hari: [0,1,2,3,4,5,6] };
const NO_DUTY = { mulai: '00:00', selesai: '00:01', hari: [0,1,2,3,4,5,6] };

test.before(() => new Promise(r => server.listen(0, () => { base = 'http://127.0.0.1:' + server.address().port; r(); })));
test.after(() => server.close());

let admin, anggota, pinA, pidA;
test('setup admin pertama, lalu setup kedua ditolak', async () => {
  assert.equal((await call('GET', '/api/status')).body.setup, true);
  assert.equal((await call('POST', '/api/setup', { nama: 'Admin', nrp: '111', pin: '12' })).status, 400);
  assert.equal((await call('POST', '/api/setup', { nama: 'Admin', pangkat: 'Mayor', nrp: '111', pin: '482915', unit: 'Satuan Uji' })).status, 200);
  assert.equal((await call('POST', '/api/setup', { nama: 'X', nrp: '222', pin: '482915' })).status, 409);
});

test('login: PIN salah ditolak, benar dapat token', async () => {
  assert.equal((await call('POST', '/api/login', { nrp: '111', pin: '000000' })).status, 401);
  const r = await call('POST', '/api/login', { nrp: '111', pin: '482915' });
  assert.equal(r.status, 200); admin = r.body.token;
  assert.equal((await call('GET', '/api/state')).status, 401);
});

test('impor personel memberi PIN acak, wajib ganti PIN', async () => {
  const r = await call('POST', '/api/personel/import', { rows: [['Serka', 'Anggota Satu', '333', 'Penyidik'], ['Sertu', 'Anggota Dua', '444', 'Penyidik']] }, admin);
  assert.equal(r.status, 200); assert.equal(r.body.pins.length, 2);
  pinA = r.body.pins[0].pin; assert.match(pinA, /^\d{6}$/);
  const l = await call('POST', '/api/login', { nrp: '333', pin: pinA });
  assert.equal(l.body.must_change, true); anggota = l.body.token;
  assert.equal((await call('POST', '/api/pin', { lama: pinA, baru: '111111' }, anggota)).status, 400);
  assert.equal((await call('POST', '/api/pin', { lama: pinA, baru: '730184' }, anggota)).status, 200);
  const s = await call('GET', '/api/state', null, anggota);
  pidA = s.body.me.pid; assert.equal(s.body.me.must_change, false); assert.equal(s.body.me.admin, false);
});

test('anggota tidak bisa mengisi absen orang lain atau membuka fungsi admin', async () => {
  const s = await call('GET', '/api/state', null, admin);
  const other = s.body.personel.find(p => p.nrp === '444').id;
  assert.equal((await call('POST', '/api/absen', { pid: other, dates: [todayISO()], k: 'HDR' }, anggota)).status, 403);
  assert.equal((await call('POST', '/api/meta', { nama: 'X' }, anggota)).status, 403);
  assert.equal((await call('POST', '/api/personel/import', { rows: [['a','b','c','d']] }, anggota)).status, 403);
});

test('GPS hanya disimpan pada jam dinas', async () => {
  await call('POST', '/api/meta', { jam: NO_DUTY }, admin);
  let r = await call('POST', '/api/absen', { pid: pidA, dates: [todayISO()], k: 'LAP', gps: { lat: -6.2, lng: 106.8, acc: 10 } }, anggota);
  assert.equal(r.body.gps, false, 'di luar jam dinas lokasi harus dibuang');
  await call('POST', '/api/meta', { jam: ALL_DAY }, admin);
  r = await call('POST', '/api/absen', { pid: pidA, dates: [todayISO()], k: 'LAP', gps: { lat: -6.2, lng: 106.8, acc: 10 } }, anggota);
  assert.equal(r.body.gps, true);
  const s = await call('GET', '/api/state', null, admin);
  const v = s.body.absen[todayISO().slice(0,7) + '_' + pidA]['d' + todayISO().slice(8)];
  assert.equal(v.k, 'LAP'); assert.equal(v.gps.lat, -6.2);
});

test('anggota lain tidak melihat koordinat dan alasan keperluan orang lain', async () => {
  const l = await call('POST', '/api/login', { nrp: '444', pin: (await call('POST', '/api/personel/n444/reset-pin', null, admin)).body.pin });
  await call('POST', '/api/keluar', { alasan: 'Urusan keluarga mendadak' }, anggota);
  const s = await call('GET', '/api/state?bio=1', null, l.body.token);
  const v = s.body.absen[todayISO().slice(0,7) + '_' + pidA]['d' + todayISO().slice(8)];
  assert.equal(v.gps, undefined); assert.equal(v.kel[0].alasan, '');
  assert.equal(Object.keys(s.body.bio).length, 0);
});

test('keperluan mendadak: keterangan wajib, lokasi dijeda, lalu kembali', async () => {
  await call('POST', '/api/kembali', null, anggota);
  assert.equal((await call('POST', '/api/keluar', { alasan: 'abc' }, anggota)).status, 400);
  assert.equal((await call('POST', '/api/keluar', { alasan: 'Menjemput anak sakit' }, anggota)).status, 200);
  assert.equal((await call('POST', '/api/keluar', { alasan: 'Menjemput anak lagi' }, anggota)).status, 400, 'tidak boleh dobel');
  let r = await call('POST', '/api/absen', { pid: pidA, dates: [todayISO()], k: 'LAP', gps: { lat: 1, lng: 1 } }, anggota);
  assert.equal(r.body.gps, false, 'selama keluar lokasi tidak dicatat');
  let s = await call('GET', '/api/state', null, admin);
  let v = s.body.absen[todayISO().slice(0,7) + '_' + pidA]['d' + todayISO().slice(8)];
  assert.equal(v.gps, undefined); assert.equal(v.kel.at(-1).alasan, 'Menjemput anak sakit'); assert.equal(v.kel.at(-1).kembali, '');
  assert.equal((await call('POST', '/api/kembali', null, anggota)).status, 200);
  s = await call('GET', '/api/state', null, admin);
  v = s.body.absen[todayISO().slice(0,7) + '_' + pidA]['d' + todayISO().slice(8)];
  assert.notEqual(v.kel.at(-1).kembali, '');
});

test('rentang tanggal (cuti) tersimpan per hari', async () => {
  const d = new Date(); d.setDate(d.getDate() + 30);
  const iso = x => x.getFullYear() + '-' + String(x.getMonth()+1).padStart(2,'0') + '-' + String(x.getDate()).padStart(2,'0');
  const days = [0,1,2].map(i => { const y = new Date(d); y.setDate(d.getDate()+i); return iso(y); });
  assert.equal((await call('POST', '/api/absen', { pid: pidA, dates: days, k: 'CT', ket: 'Cuti tahunan', gps: { lat: 1, lng: 1 } }, anggota)).body.gps, false);
  const s = await call('GET', '/api/state?bln=' + days[0].slice(0,7), null, admin);
  assert.equal(s.body.absen[days[0].slice(0,7) + '_' + pidA]['d' + days[0].slice(8)].k, 'CT');
});

test('biodata: hanya diri sendiri dan admin', async () => {
  assert.equal((await call('POST', '/api/bio', { pid: pidA, data: { nama: 'Anggota Satu', hp: '0812' } }, anggota)).status, 200);
  assert.equal((await call('POST', '/api/bio', { pid: 'n444', data: { nama: 'x' } }, anggota)).status, 403);
  const s = await call('GET', '/api/state?bio=1', null, admin);
  assert.equal(s.body.bio[pidA].hp, '0812');
});

test('5 kali PIN salah mengunci 15 menit', async () => {
  for (let i = 0; i < 5; i++) await call('POST', '/api/login', { nrp: '444', pin: '000000' });
  assert.equal((await call('POST', '/api/login', { nrp: '444', pin: '000000' })).status, 429);
});

test('nonaktifkan personel memutus sesinya', async () => {
  assert.equal((await call('DELETE', '/api/personel/' + pidA, null, admin)).status, 200);
  assert.equal((await call('GET', '/api/state', null, anggota)).status, 401);
});

test('status bisa diatur: paket, status sendiri, status nonaktif ditolak', async () => {
  const pr = await call('GET', '/api/presets');
  assert.deepEqual(pr.body.presets.map(p => p.id), ['perusahaan', 'instansi', 'tnipolri']);
  assert.equal((await call('POST', '/api/meta', { preset: 'tnipolri' }, admin)).status, 200);
  let s = await call('GET', '/api/state', null, admin);
  assert.ok(s.body.meta.status.some(x => x.k === 'BKO'));
  const list = [{ k: 'HDR', l: 'Masuk', g: 'hadir' }, { k: 'ON', l: 'Lembur online', g: 'luar' }, { k: 'CT', l: 'Cuti', g: 'libur', aktif: false }];
  assert.equal((await call('POST', '/api/meta', { status: list }, admin)).status, 200);
  assert.equal((await call('POST', '/api/meta', { status: [{ k: 'CT', l: 'Cuti', g: 'libur' }] }, admin)).status, 400, 'harus ada status hadir');
  assert.equal((await call('POST', '/api/meta', { status: [{ k: 'X', l: 'a', g: 'hadir' }] }, admin)).status, 400, 'kode terlalu pendek');
  assert.equal((await call('POST', '/api/meta', { warna: 'merah' }, admin)).status, 400);
  assert.equal((await call('POST', '/api/meta', { warna: '#AA3300' }, admin)).status, 200);
  s = await call('GET', '/api/state', null, admin);
  const pid = s.body.me.pid, t = todayISO();
  assert.equal((await call('POST', '/api/absen', { pid, dates: [t], k: 'ON' }, admin)).status, 200);
  assert.equal((await call('POST', '/api/absen', { pid, dates: [t], k: 'CT' }, admin)).status, 400, 'status nonaktif');
  assert.equal((await call('POST', '/api/absen', { pid, dates: [t], k: 'BKO' }, admin)).status, 400, 'status sudah dihapus');
  assert.equal(s.body.meta.warna, '#aa3300');
});
