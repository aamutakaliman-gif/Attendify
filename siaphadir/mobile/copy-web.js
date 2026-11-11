// Menyalin aplikasi web ke www/ untuk APK, plus pustaka inti Capacitor agar plugin native (notifikasi) bisa dipakai.
const fs = require('fs'), path = require('path');
fs.rmSync('www', { recursive: true, force: true });
fs.cpSync(path.join('..', 'web'), 'www', { recursive: true });
fs.copyFileSync(require.resolve('@capacitor/core/dist/capacitor.js'), path.join('www', 'capacitor.js'));
const f = path.join('www', 'index.html');
const html = fs.readFileSync(f, 'utf8');
if (!html.includes('<script>')) throw new Error('index.html tidak berisi <script>');
fs.writeFileSync(f, html.replace('<script>', '<script src="capacitor.js"></script>\n<script>'));
console.log('www siap');
