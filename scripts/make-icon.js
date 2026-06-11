/**
 * Generates images/icon.png (256x256) — two account figures with a swap
 * arrow. Rendered at 4x and downsampled for smooth edges. No external deps.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = 256;
const SS = 4;            // supersampling factor
const S = OUT * SS;      // render size

// colors (RGBA)
const BG = [0x2b, 0x2a, 0x33, 255];      // dark slate
const FRONT = [0xd9, 0x77, 0x57, 255];   // terracotta
const BACK = [0xa8, 0xad, 0xb8, 255];    // cool gray
const ARROW = [0xf5, 0xf2, 0xec, 255];   // warm white

// geometry in 256-space, scaled up by SS
const k = SS;
const R = 56 * k;        // corner radius

function inRoundedRect(x, y) {
  const w = S, h = S;
  if (x < 0 || y < 0 || x >= w || y >= h) return false;
  const cx = Math.max(R - x, x - (w - 1 - R), 0);
  const cy = Math.max(R - y, y - (h - 1 - R), 0);
  return cx * cx + cy * cy <= R * R;
}
const circle = (cx, cy, r) => (x, y) => {
  const dx = x - cx * k, dy = y - cy * k;
  return dx * dx + dy * dy <= (r * k) * (r * k);
};
// upper half of an ellipse (shoulders)
const shoulders = (cx, cy, rx, ry) => (x, y) => {
  if (y > cy * k) return false;
  const dx = (x - cx * k) / (rx * k), dy = (y - cy * k) / (ry * k);
  return dx * dx + dy * dy <= 1;
};
const rect = (x0, y0, x1, y1) => (x, y) =>
  x >= x0 * k && x <= x1 * k && y >= y0 * k && y <= y1 * k;
// horizontal arrowhead: tip at (tx, cy), base at bx, half-height hh
const head = (tx, bx, cy, hh) => (x, y) => {
  const t = (x - tx * k) / ((bx - tx) * k);  // 0 at tip, 1 at base
  if (t < 0 || t > 1) return false;
  return Math.abs(y - cy * k) <= hh * k * t;
};

// paint order: background, back figure, front figure, double-headed arrow
const layers = [
  { color: BACK,  tests: [circle(170, 92, 30), shoulders(170, 168, 47, 34)] },
  { color: FRONT, tests: [circle(97, 100, 34), shoulders(97, 184, 53, 38)] },
  { color: ARROW, tests: [
      rect(97, 215, 159, 227),
      head(180, 159, 221, 13),   // right-pointing head
      head(76, 97, 221, 13)      // left-pointing head
  ] }
];

const px = Buffer.alloc(S * S * 4);
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    if (!inRoundedRect(x, y)) continue;
    let c = BG;
    for (const layer of layers) {
      if (layer.tests.some(t => t(x, y))) c = layer.color;
    }
    px.set(c, (y * S + x) * 4);
  }
}

// downsample SSxSS -> 1 px (average, alpha-weighted)
const out = Buffer.alloc(OUT * OUT * 4);
for (let y = 0; y < OUT; y++) {
  for (let x = 0; x < OUT; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let j = 0; j < SS; j++) {
      for (let i = 0; i < SS; i++) {
        const o = (((y * SS + j) * S) + (x * SS + i)) * 4;
        const al = px[o + 3];
        r += px[o] * al; g += px[o + 1] * al; b += px[o + 2] * al; a += al;
      }
    }
    const o = (y * OUT + x) * 4;
    if (a > 0) {
      out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a);
    }
    out[o + 3] = Math.round(a / (SS * SS));
  }
}

// --- minimal PNG encoder ---
const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let i = 0; i < 8; i++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(OUT, 0); ihdr.writeUInt32BE(OUT, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA

const raw = Buffer.alloc(OUT * (OUT * 4 + 1));
for (let y = 0; y < OUT; y++) {
  raw[y * (OUT * 4 + 1)] = 0; // filter: none
  out.copy(raw, y * (OUT * 4 + 1) + 1, y * OUT * 4, (y + 1) * OUT * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);

const dest = path.join(__dirname, '..', 'images', 'icon.png');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, png);
console.log(`wrote ${dest} (${png.length} bytes)`);
