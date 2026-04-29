// Regenerate the PWA icon set from public/app-icon.png. Run after changing
// the source logo: `npm run gen:icons`. The output sizes mirror what
// ng add @angular/pwa originally generated, so manifest.webmanifest doesn't
// need updating.

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const sizes = [72, 96, 128, 144, 152, 192, 384, 512];
const source = path.join(__dirname, '..', 'public', 'app-icon.png');
const outDir = path.join(__dirname, '..', 'public', 'icons');

if (!fs.existsSync(source)) {
    console.error(`[gen-icons] missing source: ${source}`);
    process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

(async () => {
    for (const size of sizes) {
        const out = path.join(outDir, `icon-${size}x${size}.png`);
        await sharp(source)
            .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .png({ compressionLevel: 9 })
            .toFile(out);
        console.log(`[gen-icons] ${path.relative(process.cwd(), out)}`);
    }
})().catch(err => {
    console.error('[gen-icons] failed:', err);
    process.exit(1);
});
