// Generate a locally-trusted dev cert via mkcert so `npm start` can serve over
// HTTPS — required for testing the PWA service worker from another device on
// the LAN (phone hitting the dev machine's IP). Localhost alone doesn't need
// HTTPS for SW, so this script is only useful when --host 0.0.0.0 is in play.
//
// Idempotent: regenerates only when files are missing. Delete .certs/ to force
// a refresh (e.g. after IP changes).
//
// Pre-requisite (one-time per machine): `mkcert -install` to trust the local
// root CA on this PC. To trust the cert on a phone, install the rootCA.pem
// printed below — instructions in the script output.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const certDir = path.join(__dirname, '..', '.certs');
const certFile = path.join(certDir, 'dev.pem');
const keyFile = path.join(certDir, 'dev-key.pem');

if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    process.exit(0);
}

fs.mkdirSync(certDir, { recursive: true });

const lanIps = Object.values(os.networkInterfaces())
    .flat()
    .filter(n => n && n.family === 'IPv4' && !n.internal)
    .map(n => n.address);

const hosts = ['localhost', '127.0.0.1', '::1', ...lanIps];

console.log(`[dev-cert] generating cert for: ${hosts.join(', ')}`);

const gen = spawnSync(
    'mkcert',
    ['-cert-file', certFile, '-key-file', keyFile, ...hosts],
    { stdio: 'inherit', shell: true }
);

if (gen.status !== 0) {
    console.error('[dev-cert] mkcert failed. Install mkcert and run `mkcert -install` once.');
    process.exit(1);
}

const caRoot = spawnSync('mkcert', ['-CAROOT'], { encoding: 'utf8', shell: true });
if (caRoot.status === 0) {
    const rootPem = path.join(caRoot.stdout.trim(), 'rootCA.pem');
    console.log('');
    console.log('[dev-cert] To trust this cert on a phone:');
    console.log(`  rootCA: ${rootPem}`);
    console.log('  Android: Settings → Security → Install a certificate → CA certificate');
    console.log('  iOS: AirDrop/email the file → install profile → Settings → General → About →');
    console.log('       Certificate Trust Settings → enable for the mkcert root');
    if (lanIps.length) {
        console.log('');
        console.log(`[dev-cert] LAN URLs once "npm start" is up:`);
        for (const ip of lanIps) console.log(`  https://${ip}:4200`);
    }
}
