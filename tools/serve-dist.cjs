// Serve the production build over HTTPS so the service worker is reachable.
// `ng serve` disables SW registration via isDevMode(), so this is the only way
// to verify the PWA layer end-to-end (sw.js registers, ngsw caches, bgFetch
// routes Gemini calls). Pair with `npm run build` first.
//
// SPA fallback returns index.html for any non-asset path so deep links survive.

const fs = require('fs');
const https = require('https');
const path = require('path');

const root = path.join(__dirname, '..', 'dist', 'text-rpg', 'browser');
const port = Number(process.env.PORT) || 4200;
const certFile = path.join(__dirname, '..', '.certs', 'dev.pem');
const keyFile = path.join(__dirname, '..', '.certs', 'dev-key.pem');

if (!fs.existsSync(root)) {
    console.error('[serve-dist] no build at', root);
    console.error('[serve-dist] run `npm run build` first.');
    process.exit(1);
}
if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
    console.error('[serve-dist] no dev cert. run `node tools/dev-cert.cjs` first.');
    process.exit(1);
}

const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.md': 'text/markdown; charset=utf-8',
    '.wasm': 'application/wasm'
};

const server = https.createServer({
    cert: fs.readFileSync(certFile),
    key: fs.readFileSync(keyFile)
}, (req, res) => {
    let urlPath;
    try {
        urlPath = decodeURIComponent(new URL(req.url, 'https://x').pathname);
    } catch {
        res.writeHead(400).end('Bad Request');
        return;
    }
    if (urlPath.endsWith('/')) urlPath += 'index.html';

    // Disallow path traversal
    const resolved = path.normalize(path.join(root, urlPath));
    if (!resolved.startsWith(root)) {
        res.writeHead(403).end('Forbidden');
        return;
    }

    fs.stat(resolved, (err, stat) => {
        if (err || !stat.isFile()) {
            // SPA fallback for navigation requests; 404 for anything that looks
            // like a static asset (has an extension other than .html).
            const ext = path.extname(urlPath);
            if (ext && ext !== '.html') {
                res.writeHead(404).end('Not Found');
                return;
            }
            const fallback = path.join(root, 'index.html');
            res.writeHead(200, { 'content-type': mime['.html'] });
            fs.createReadStream(fallback).pipe(res);
            return;
        }
        const ext = path.extname(resolved);
        res.writeHead(200, { 'content-type': mime[ext] || 'application/octet-stream' });
        fs.createReadStream(resolved).pipe(res);
    });
});

server.listen(port, '0.0.0.0', () => {
    const ifaces = require('os').networkInterfaces();
    const ips = Object.values(ifaces)
        .flat()
        .filter(n => n && n.family === 'IPv4' && !n.internal)
        .map(n => n.address);
    console.log(`[serve-dist] https://localhost:${port}/`);
    for (const ip of ips) console.log(`[serve-dist] https://${ip}:${port}/`);
});
