# SiapHadir

Aplikasi absensi dan papan kehadiran untuk organisasi dengan pola kerja dinamis: kantor, kerja dari rumah, kunjungan klien, perjalanan dinas, shift, pelatihan, cuti, izin, sakit.

Cocok untuk **perusahaan, instansi pemerintah, sekolah, rumah sakit, yayasan**, dan organisasi lain.

- **Pegawai** melapor sendiri dari HP (APK Android atau web), di kantor maupun di luar kantor.
- **Pimpinan/HRD** cukup membuka aplikasi: papan kehadiran hari ini, laporan siap kirim WhatsApp/email, dan rekap bulanan siap disalin ke Excel.
- **Privasi lokasi**: GPS hanya diambil **satu kali saat melapor, pada jam kerja**. Di luar jam kerja server menolak menyimpan lokasi. Saat ada keperluan mendadak, lokasi dijeda dan keterangan wajib diisi.
- **Data milik Anda**: berjalan di server Anda sendiri, satu file database. Tanpa langganan pihak ketiga.
- **Mengikuti identitas organisasi**: nama, logo, warna utama, video pembuka, jam kerja, dan daftar status diatur dari menu Pengaturan.

---

## 1. Status kehadiran yang bisa diatur

Saat setup pertama, pilih jenis organisasi untuk mendapat daftar status awal:

| Paket | Contoh status |
|---|---|
| Perusahaan / swasta | Hadir di kantor, Shift, Kerja dari rumah, Kunjungan / tugas luar, Perjalanan dinas, Pelatihan, Libur shift, Cuti, Izin, Sakit |
| Instansi pemerintah | Hadir, Piket, Tugas lapangan, Kerja dari rumah, Dinas luar, Diperbantukan, Diklat, Cuti, Izin, Sakit |
| TNI / Polri | Hadir, Piket, Tugas lapangan, Dinas luar, BKO, BP, Pendidikan, Lepas piket, Cuti, Izin, Sakit |

Admin bebas mengubah nama status, mematikan yang tidak dipakai, atau menambah status sendiri (kode 2–4 huruf). Setiap status masuk satu **kelompok**, dan kelompok inilah yang menentukan perhitungan di laporan:

| Kelompok | Dihitung |
|---|---|
| Hadir di kantor | Hadir |
| Hadir di luar kantor (WFH, kunjungan, lapangan) | Hadir |
| Bertugas di luar (perjalanan dinas, pelatihan, diperbantukan) | Tidak hadir |
| Tidak bekerja (cuti, izin, sakit, libur) | Tidak hadir |
| Tanpa keterangan | Tidak hadir |

---

## 2. Cara pakai untuk pegawai (bahan sosialisasi)

| Kapan | Siapa | Yang dilakukan |
|---|---|---|
| Sekali | Admin | Bagikan APK, lalu kirim **nomor induk + PIN awal** ke tiap pegawai secara pribadi |
| Sekali | Pegawai | Pasang APK → isi alamat server → masuk → buat PIN pribadi |
| Tiap hari kerja | Pegawai | HP mengingatkan 15 menit sebelum jam kerja → buka aplikasi → ketuk status → selesai |
| Bila perlu | Pegawai | Cuti / perjalanan beberapa hari: isi sekali dengan "Berlaku sampai" |
| Bila perlu | Pegawai | Keluar mendadak saat jam kerja: **Keperluan mendadak** → tulis alasan → **Sudah kembali** |
| Kapan saja | Pimpinan/HRD | Buka aplikasi: papan kehadiran, laporan, rekap |

Pengguna iPhone membuka alamat server di Safari, lalu **Bagikan → Tambah ke Layar Utama**.

---

## 3. Skema server

Cukup satu komputer di kantor, atau satu server sewaan (VPS). Pegawai yang bekerja di luar kantor memakai kuota seluler, jadi server harus bisa dijangkau dari internet dengan **HTTPS**. Tanpa HTTPS, HP menolak mengambil lokasi.

| Pilihan | Cara kerja | Cocok untuk |
|---|---|---|
| **VPS / cloud** | Server sewaan dengan domain sendiri | Paling mudah untuk perusahaan kecil–menengah |
| **Server kantor + Cloudflare Tunnel** | Server di kantor membuka sambungan keluar; tanpa IP publik, tanpa membuka port | Kantor tanpa IP publik |
| **Server kantor + IP publik** | Router meneruskan port 443 ke server; HTTPS lewat Caddy | Organisasi yang ingin data tidak lewat pihak ketiga |
| Hanya jaringan kantor | Server hanya bisa diakses dari WiFi kantor | Hanya bila semua pegawai selalu di kantor |

Perangkat minimum: CPU 2 inti, RAM 2–4 GB, SSD 40 GB, Ubuntu Server 24.04. Cukup untuk ratusan pegawai.

---

## 4. Pemasangan server

```bash
# Node.js 22 (memakai node:sqlite bawaan, tanpa paket tambahan)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs sqlite3

# Salin folder siaphadir ke /opt/siaphadir, lalu uji
cd /opt/siaphadir/server && npm test

# Jalankan sebagai layanan
sudo tee /etc/systemd/system/siaphadir.service >/dev/null <<'UNIT'
[Unit]
Description=SiapHadir
After=network.target
[Service]
WorkingDirectory=/opt/siaphadir/server
Environment=PORT=8080
Environment=DATA_DIR=/var/lib/siaphadir
Environment=TZ=Asia/Jakarta
ExecStart=/usr/bin/node --no-warnings server.js
Restart=always
User=www-data
[Install]
WantedBy=multi-user.target
UNIT
sudo mkdir -p /var/lib/siaphadir && sudo chown www-data /var/lib/siaphadir
sudo systemctl enable --now siaphadir
```

**HTTPS dengan Caddy** (`sudo apt install caddy`, isi `/etc/caddy/Caddyfile`):
```
absen.kantor-anda.co.id {
    reverse_proxy localhost:8080
}
```
Bisa juga memakai Cloudflare Tunnel ke `http://localhost:8080`, atau sertifikat sendiri lewat `TLS_CERT` dan `TLS_KEY`.

**Cadangan harian:**
```bash
sudo mkdir -p /backup/siaphadir
echo '30 23 * * * root sqlite3 /var/lib/siaphadir/siaphadir.db ".backup /backup/siaphadir/siaphadir-$(date +\%F).db"' | sudo tee /etc/cron.d/siaphadir-backup
```

| Variabel | Bawaan | Fungsi |
|---|---|---|
| `PORT` | 8080 | Port server |
| `DATA_DIR` | `server/data` | Lokasi database dan video pembuka |
| `TZ` | Asia/Jakarta | Zona waktu, penentu jam kerja (WIB/WITA/WIT) |
| `CORS_ORIGINS` | `https://localhost,capacitor://localhost,http://localhost` | Asal yang boleh memanggil API (APK memakai `https://localhost`) |
| `SESSION_DAYS` | 180 | Lama pegawai tetap masuk tanpa PIN |
| `TLS_CERT`, `TLS_KEY` | – | HTTPS langsung tanpa Caddy |

---

## 5. Penggunaan pertama
1. Buka alamat server. Di layar **Siapkan aplikasi**, isi nama organisasi, jenis organisasi, dan akun admin.
2. **Pengaturan**: unggah logo, pilih warna utama, sesuaikan status dan jam kerja, dan (opsional) unggah video pembuka.
3. **Pegawai → Tempel banyak sekaligus dari Excel**: kolom Nama, Nomor induk, Jabatan (boleh diawali kolom Golongan). PIN awal tiap pegawai tampil **satu kali saja**. Salin, lalu bagikan secara pribadi.
4. Bagikan APK. Pegawai yang lupa PIN: **Pegawai → Kelola → Atur ulang PIN**.

---

## 6. Membangun APK
GitHub Actions (`.github/workflows/siaphadir.yml`) menjalankan tes dan membangun APK di setiap perubahan; unduh dari **Actions → SiapHadir → Artifacts**.

Membangun sendiri (JDK 21 + Android SDK 35):
```bash
cd siaphadir/mobile
npm ci
npm run apk     # android/app/build/outputs/apk/debug/app-debug.apk
```
Satu APK bisa dipakai semua pelanggan, karena alamat server diisi saat pertama dibuka.

Untuk rilis atau Play Store, tanda tangani dengan kunci rilis sendiri (`./gradlew assembleRelease` + keystore), dan simpan keystore dengan aman. Pembaruan APK hanya bisa dipasang bila ditandatangani dengan kunci yang sama.

---

## 7. Keamanan dan privasi
- PIN disimpan sebagai hash (scrypt). Setelah 5 kali salah, akun dikunci 15 menit.
- Pegawai hanya bisa mengisi absen dan biodatanya sendiri. Admin bisa mengisi untuk siapa pun.
- Koordinat GPS dan alasan keperluan mendadak hanya terlihat oleh yang bersangkutan dan admin.
- Biodata (alamat, kontak darurat, foto) hanya terlihat oleh pemiliknya dan admin.
- Semua perubahan tercatat di **Pengaturan → Riwayat aktivitas**.
- Pegawai yang dinonaktifkan langsung keluar dari semua perangkatnya.
- Data pribadi pegawai termasuk data pribadi menurut UU 27/2022 tentang Pelindungan Data Pribadi. Organisasi pemakai bertanggung jawab memberi tahu pegawai tentang data yang dikumpulkan, termasuk lokasi [CEK ketentuan terbaru].

## 8. Struktur
```
siaphadir/
  server/   server.js (API + file web), test.js
  web/      aplikasi (satu file index.html), ikon, manifest
  mobile/   cangkang Android (Capacitor 7) → APK
```

## Penamaan
Kode SiapHadir ditulis baru dan terpisah dari proyek Attendify di repositori ini. Sebelum dijual, pindahkan folder `siaphadir/` ke repositori sendiri, dan cek ketersediaan merek "SiapHadir" di PDKI (pdki-indonesia.dgip.go.id) [CEK].
