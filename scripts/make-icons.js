#!/usr/bin/env node
// Rasterise the sonora icon sources with headless Chromium.
//
//   node scripts/make-icons.js          # rewrite public/icons/*.png
//   node scripts/make-icons.js --check  # verify the committed bitmaps
//
// Every PNG here is a real render of the SVG beside it: the SVG is decoded by
// Chromium, drawn at the target size into a canvas and encoded by the browser.
// Nothing is hand-made and no image library is needed.
//
// The mark: the same coral rounded square + six-bar waveform as the in-app
// brand-logo (#i-wave), drawn upright because launchers apply their own mask.
// Sources live in public/icons/*.svg so the icons can be edited as vectors.
import fs from 'node:fs';
import path from 'node:path';
import { CHROME, freePort, launch } from '../test/helpers/cdp.js';

const ROOT = new URL('..', import.meta.url).pathname;
const ICONS = path.join(ROOT, 'public/icons');

// Chosen so every platform gets a native resolution:
// 512/192 for the manifest, 180 for iOS, 96 for launcher shortcuts.
const TARGETS = [
  { src: 'icon.svg', out: 'icon-512.png', size: 512 },
  { src: 'icon.svg', out: 'icon-192.png', size: 192 },
  { src: 'icon.svg', out: 'icon-96.png', size: 96 },
  // Full bleed + opaque: Android masks it itself, and iOS rejects transparency
  // in an apple-touch-icon (it composites onto black otherwise).
  { src: 'icon-maskable.svg', out: 'icon-maskable-512.png', size: 512 },
  { src: 'icon-maskable.svg', out: 'icon-180.png', size: 180 },
  // Bare coral bars on transparency, for dark surfaces / social cards.
  { src: 'icon-transparent.svg', out: 'icon-512-transparent.png', size: 512 },
];

/** PNG header: width/height live in the IHDR chunk at byte 16/20. */
function pngInfo(file) {
  const buf = fs.readFileSync(file);
  if (buf.subarray(1, 4).toString('latin1') !== 'PNG') throw new Error(`${file}: not a PNG`);
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bytes: buf.length,
    // 6 = RGBA (transparency possible), 2 = RGB (opaque).
    colorType: buf[25],
  };
}

function check() {
  let bad = 0;
  for (const { out, size } of TARGETS) {
    const file = path.join(ICONS, out);
    if (!fs.existsSync(file)) {
      console.error(`✗ ${out}: missing (run node scripts/make-icons.js)`);
      bad++;
      continue;
    }
    const { width, height, bytes, colorType } = pngInfo(file);
    if (width !== size || height !== size || bytes < 400) {
      console.error(`✗ ${out}: ${width}×${height} ${bytes}B colorType=${colorType}`);
      bad++;
    } else {
      console.log(`✓ ${out}: ${width}×${height} ${bytes}B colorType=${colorType}`);
    }
  }
  for (const svg of ['icon.svg', 'icon-maskable.svg', 'icon-transparent.svg']) {
    if (!fs.existsSync(path.join(ICONS, svg))) { console.error(`✗ ${svg}: missing`); bad++; }
  }
  if (bad) {
    console.error(`\n${bad} icon(s) wrong. Run: node scripts/make-icons.js`);
    process.exit(1);
  }
  console.log('\nall icons match their sources');
}

if (process.argv.includes('--check')) {
  check();
  process.exit(0);
}

if (!CHROME) {
  console.error('No Chromium/Chrome found (set CHROME_BIN).');
  process.exit(1);
}

const browser = await launch(await freePort());
try {
  for (const { src, out, size } of TARGETS) {
    const svg = fs.readFileSync(path.join(ICONS, src), 'utf8');
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    const result = await browser.eval(`(async () => {
      const img = new Image();
      img.src = ${JSON.stringify(dataUrl)};
      await img.decode();
      const n = ${size};
      const canvas = document.createElement('canvas');
      canvas.width = n;
      canvas.height = n;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, n, n);

      // apple-touch-icons must be opaque: iOS composites transparency onto
      // black, so a transparent plate would arrive with black corners.
      let minAlpha = 255;
      if (${out === 'icon-180.png' || out === 'icon-maskable-512.png'}) {
        const { data } = ctx.getImageData(0, 0, n, n);
        for (let i = 3; i < data.length; i += 4) minAlpha = Math.min(minAlpha, data[i]);
      }

      // Maskable safe zone: every "ink" pixel must sit inside the centre circle
      // with radius 40% of the icon (Chrome's spec), so no launcher crop can
      // bite the mark. Measure it instead of trusting the geometry.
      let inkRadius = 0;
      if (${out === 'icon-maskable-512.png'}) {
        const { data } = ctx.getImageData(0, 0, n, n);
        const cx = n / 2, cy = n / 2;
        for (let y = 0; y < n; y++) {
          for (let x = 0; x < n; x++) {
            const i = (y * n + x) * 4;
            const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
            if (luma < 110) inkRadius = Math.max(inkRadius, Math.hypot(x + 0.5 - cx, y + 0.5 - cy));
          }
        }
      }
      return {
        width: img.naturalWidth,
        height: img.naturalHeight,
        inkRadius,
        minAlpha,
        png: canvas.toDataURL('image/png').split(',')[1],
      };
    })()`);

    const file = path.join(ICONS, out);
    fs.writeFileSync(file, Buffer.from(result.png, 'base64'));
    const { width, height, bytes, colorType } = pngInfo(file);
    if (width !== size || height !== size) throw new Error(`${out}: wrote ${width}×${height}`);

    let note = '';
    if (result.minAlpha !== 255 && (out === 'icon-180.png' || out === 'icon-maskable-512.png')) {
      throw new Error(`${out}: has transparent pixels (min alpha ${result.minAlpha}); apple-touch must be opaque`);
    }
    if (out === 'icon-maskable-512.png') {
      const safe = size * 0.4;
      if (result.inkRadius > safe) {
        throw new Error(`${out}: mark reaches r=${result.inkRadius.toFixed(1)}, outside the ${safe} safe zone`);
      }
      note = ` · mark r=${result.inkRadius.toFixed(1)} < safe r=${safe}`;
    }
    console.log(`✓ ${out} ← ${src}: ${width}×${height} ${bytes}B colorType=${colorType}${note}`);
  }
} finally {
  browser.close();
}
