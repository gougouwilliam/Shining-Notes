/* 生成伴生插件 logo.png：128x128，深底圆角 + 工作台看板格。
   无 PIL / 无 canvas 依赖，手写 PNG 编码（zlib deflate 由 node 内置提供）。 */
'use strict';
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const W = 128, H = 128;

/* --- 极简画布 --- */
const px = new Uint8Array(W * H * 4); // RGBA
function set(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  /* source-over */
  const sa = a / 255, da = px[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return;
  px[i]     = Math.round((r * sa + px[i]     * da * (1 - sa)) / oa);
  px[i + 1] = Math.round((g * sa + px[i + 1] * da * (1 - sa)) / oa);
  px[i + 2] = Math.round((b * sa + px[i + 2] * da * (1 - sa)) / oa);
  px[i + 3] = Math.round(oa * 255);
}

function insideRounded(x, y, x0, y0, w, h, rad) {
  if (x < x0 || y < y0 || x >= x0 + w || y >= y0 + h) return false;
  const cx = Math.max(x0 + rad, Math.min(x, x0 + w - rad));
  const cy = Math.max(y0 + rad, Math.min(y, y0 + h - rad));
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= rad * rad;
}

function fillRect(x0, y0, w, h, rad, col) {
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (insideRounded(x, y, x0, y0, w, h, rad)) set(x, y, col[0], col[1], col[2], col[3]);
}

/* 底：深灰圆角方块（与主插件窗口底色一致） */
fillRect(4, 4, 120, 120, 26, [24, 25, 28, 255]);
/* 描边一圈微亮 */
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++)
    if (insideRounded(x, y, 4, 4, 120, 120, 26) &&
        !insideRounded(x, y, 6, 6, 116, 116, 24)) set(x, y, 70, 76, 88, 255);

/* 看板四格：左列两块（列表），右上宽块（索引），右下小块（每日笔记） */
const tile = [86, 148, 214, 235];   // 主蓝
const tile2 = [122, 186, 238, 235]; // 浅蓝
const tile3 = [238, 178, 92, 235];  // 琥珀（每日）
fillRect(20, 22, 38, 84, 8, tile);            // 左长条：文档列表
fillRect(66, 22, 42, 46, 8, tile2);           // 右上：知识库
fillRect(66, 76, 42, 30, 8, tile3);           // 右下：每日笔记

/* 左长条里挖三条「文本行」 */
for (const [yy, ww] of [[34, 26], [50, 26], [66, 20]]) {
  fillRect(26, yy, ww, 7, 3, [24, 25, 28, 255]);
}

/* --- 编码 PNG --- */
const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0; // filter: none
  Buffer.from(px.buffer, y * W * 4, W * 4).copy(raw, y * (W * 4 + 1) + 1);
}
const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  crcTable[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);
const out = process.argv[2] || path.join(__dirname, 'logo.png');
fs.writeFileSync(out, png);
console.log('OK', out, png.length, 'bytes');
