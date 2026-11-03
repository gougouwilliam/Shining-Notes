/* 生成插件图标：4× 超采样渲染后缩到 128×128，边缘自带抗锯齿。
   无第三方依赖（手写 PNG 编码，zlib 由 Node 内置）。
   用法：node gen-icon.js            → 输出 three 个候选 + 主插件/启动器成品
*/
'use strict';
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const OUT = 128;      // 最终尺寸
const K = 4;          // 超采样倍率
const S = OUT * K;

/* ---------------- 画布 ---------------- */
let px; // Uint8ClampedArray RGBA，S×S
function reset() { px = new Uint8ClampedArray(S * S * 4); }

function blend(i, r, g, b, a) {
  const sa = a / 255;
  if (sa <= 0) return;
  const da = px[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return;
  px[i]     = Math.round((r * sa + px[i]     * da * (1 - sa)) / oa);
  px[i + 1] = Math.round((g * sa + px[i + 1] * da * (1 - sa)) / oa);
  px[i + 2] = Math.round((b * sa + px[i + 2] * da * (1 - sa)) / oa);
  px[i + 3] = Math.round(oa * 255);
}

/* 圆角矩形判定（逻辑坐标） */
function inRoundRect(x, y, x0, y0, w, h, rad) {
  if (x < x0 || y < y0 || x > x0 + w || y > y0 + h) return false;
  const r = Math.min(rad, w / 2, h / 2);
  const cx = Math.max(x0 + r, Math.min(x, x0 + w - r));
  const cy = Math.max(y0 + r, Math.min(y, y0 + h - r));
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/* color: [r,g,b,a] 或 (x,y)=>[r,g,b,a]（逻辑坐标） */
function roundRect(x0, y0, w, h, rad, color) {
  const fn = typeof color === 'function' ? color : () => color;
  const X0 = Math.max(0, Math.floor(x0 * K)), X1 = Math.min(S, Math.ceil((x0 + w) * K));
  const Y0 = Math.max(0, Math.floor(y0 * K)), Y1 = Math.min(S, Math.ceil((y0 + h) * K));
  for (let Y = Y0; Y < Y1; Y++) {
    const ly = (Y + 0.5) / K;
    for (let X = X0; X < X1; X++) {
      const lx = (X + 0.5) / K;
      if (!inRoundRect(lx, ly, x0, y0, w, h, rad)) continue;
      const c = fn(lx, ly);
      if (!c) continue;
      blend((Y * S + X) * 4, c[0], c[1], c[2], c[3] === undefined ? 255 : c[3]);
    }
  }
}

function circle(cx, cy, r, color) {
  const fn = typeof color === 'function' ? color : () => color;
  const X0 = Math.max(0, Math.floor((cx - r) * K)), X1 = Math.min(S, Math.ceil((cx + r) * K));
  const Y0 = Math.max(0, Math.floor((cy - r) * K)), Y1 = Math.min(S, Math.ceil((cy + r) * K));
  for (let Y = Y0; Y < Y1; Y++) {
    const ly = (Y + 0.5) / K;
    for (let X = X0; X < X1; X++) {
      const lx = (X + 0.5) / K;
      const dx = lx - cx, dy = ly - cy;
      if (dx * dx + dy * dy > r * r) continue;
      const c = fn(lx, ly);
      blend((Y * S + X) * 4, c[0], c[1], c[2], c[3] === undefined ? 255 : c[3]);
    }
  }
}

/* 三角形填充（逻辑坐标，点序无所谓，用同侧判定） */
function triangle(p1, p2, p3, color) {
  const side = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const minX = Math.min(p1[0], p2[0], p3[0]), maxX = Math.max(p1[0], p2[0], p3[0]);
  const minY = Math.min(p1[1], p2[1], p3[1]), maxY = Math.max(p1[1], p2[1], p3[1]);
  for (let Y = Math.max(0, Math.floor(minY * K)); Y < Math.min(S, Math.ceil(maxY * K)); Y++) {
    const ly = (Y + 0.5) / K;
    for (let X = Math.max(0, Math.floor(minX * K)); X < Math.min(S, Math.ceil(maxX * K)); X++) {
      const lx = (X + 0.5) / K;
      const d1 = side(p1[0], p1[1], p2[0], p2[1], lx, ly);
      const d2 = side(p2[0], p2[1], p3[0], p3[1], lx, ly);
      const d3 = side(p3[0], p3[1], p1[0], p1[1], lx, ly);
      const neg = (d1 < 0) || (d2 < 0) || (d3 < 0);
      const pos = (d1 > 0) || (d2 > 0) || (d3 > 0);
      if (neg && pos) continue;
      blend((Y * S + X) * 4, color[0], color[1], color[2], color[3] === undefined ? 255 : color[3]);
    }
  }
}

/* ---------------- 品牌色（取自 app.css） ---------------- */
const AMBER   = [245, 197, 66, 255];   // #f5c542 高亮
const AMBER_D = [232, 163, 61, 255];   // #e8a33d
const BLUE    = [91, 140, 255, 255];   // #5b8cff accent
const BLUE_D  = [64, 108, 224, 255];
const PAPER   = [250, 250, 252, 255];
const LINE    = [196, 204, 218, 255];
const INK     = [32, 36, 44, 255];

/* 底色：深灰蓝渐变 + 顶部极淡内发光 + 亮边 */
function bg(rTop, rBot) {
  roundRect(0, 0, 128, 128, 29, (x, y) => {
    const t = y / 128;
    return [
      Math.round(rTop[0] + (rBot[0] - rTop[0]) * t),
      Math.round(rTop[1] + (rBot[1] - rTop[1]) * t),
      Math.round(rTop[2] + (rBot[2] - rTop[2]) * t),
      255
    ];
  });
  /* 1px 亮边：只画在圆角矩形内侧一环 */
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const lx = (x + 0.5) / K, ly = (y + 0.5) / K;
      if (!inRoundRect(lx, ly, 0.5, 0.5, 127, 127, 29)) continue;
      if (inRoundRect(lx, ly, 1.4, 1.4, 125.2, 125.2, 27.6)) continue;
      blend((y * S + x) * 4, 255, 255, 255, 26);
    }
  }
}

/* 纸页 + 折角 */
function page(x0, y0, w, h, rad, paper, fold) {
  roundRect(x0, y0, w, h, rad, paper);
  const fw = 17;                       // 折角边长
  const rx = x0 + w, ry = y0;
  triangle([rx, ry], [rx - fw, ry], [rx, ry + fw], [0, 0, 0, 0]);   // 先占位（无效果）
  /* 用底色切掉右上角：靠折角色块本身覆盖即可，这里只画折角三角形 */
  triangle([rx, ry], [rx - fw, ry], [rx, ry + fw], fold);
}

/* ---------------- 候选 A：纸页 + 琥珀高亮（推荐） ---------------- */
function variantA() {
  reset();
  bg([38, 44, 58], [20, 23, 29]);
  const PX = 32, PY = 18, PW = 64, PH = 92;
  /* 纸页投影：三层递减，模拟柔和阴影 */
  roundRect(PX - 1, PY + 7, PW + 2, PH, 12, [0, 0, 0, 30]);
  roundRect(PX, PY + 4, PW, PH, 11, [0, 0, 0, 38]);
  page(PX, PY, PW, PH, 10, PAPER, [205, 214, 230, 255]);
  /* 文本行 */
  roundRect(PX + 12, PY + 19, 26, 5.5, 2.75, LINE);
  roundRect(PX + 12, PY + 31, 40, 5.5, 2.75, LINE);
  roundRect(PX + 12, PY + 43, 32, 5.5, 2.75, LINE);
  /* 琥珀高亮条：核心记忆点 */
  roundRect(PX + 9, PY + 56, 46, 13, 4.5, AMBER);
  roundRect(PX + 12, PY + 74, 30, 5.5, 2.75, LINE);
}

/* ---------------- 候选 B：三列看板（工作台） ---------------- */
function variantB() {
  reset();
  bg([36, 42, 56], [18, 21, 27]);
  const base = 99;
  roundRect(24, 34, 20, base - 34, 7, AMBER);      // 列1 高
  roundRect(51, 26, 24, base - 26, 7, BLUE);       // 列2 最高
  roundRect(82, 46, 20, base - 46, 7, [214, 221, 234, 230]); // 列3 矮
  /* 每列顶部一条“卡片”留白 */
  roundRect(27.5, 38, 13, 9, 3, [24, 27, 34, 235]);
  roundRect(55, 30, 16, 10, 3, [24, 27, 34, 235]);
  roundRect(85.5, 50, 13, 8, 3, [24, 27, 34, 200]);
  /* 底部基线 */
  roundRect(22, 102, 84, 4, 2, [255, 255, 255, 40]);
}

/* ---------------- 候选 B2：看板（三列 + 卡片） ---------------- */
function variantB2() {
  reset();
  bg([38, 44, 58], [20, 23, 29]);
  const cols = [
    { x: 20, y: 26, h: 76, card: AMBER },
    { x: 51, y: 20, h: 82, card: BLUE },
    { x: 82, y: 32, h: 70, card: [214, 221, 234, 255] }
  ];
  const CW = 26;
  for (const c of cols) {
    /* 列底：半透明 + 一圈描边 */
    roundRect(c.x, c.y, CW, c.h, 7, [255, 255, 255, 58]);
    roundRect(c.x + 1, c.y + 1, CW - 2, c.h - 2, 6, [22, 26, 34, 235]);
    /* 列内卡片 */
    const n = c.h > 75 ? 3 : 2;
    let cy = c.y + 6;
    for (let i = 0; i < n; i++) {
      const alpha = i === 0 ? 255 : 170;
      roundRect(c.x + 6, cy, CW - 12, 11, 3, [c.card[0], c.card[1], c.card[2], alpha]);
      cy += 16;
    }
  }
}

/* ---------------- 候选 D：四格仪表盘（工作台） ---------------- */
function variantD() {
  reset();
  bg([38, 44, 58], [20, 23, 29]);
  const S1 = 33, G = 8, X0 = (128 - (S1 * 2 + G)) / 2, Y0 = (128 - (S1 * 2 + G)) / 2;
  roundRect(X0, Y0, S1, S1, 8, AMBER);                                  // 左上：每日笔记
  roundRect(X0 + S1 + G, Y0, S1, S1, 8, BLUE);                          // 右上：知识库
  roundRect(X0, Y0 + S1 + G, S1, S1, 8, [214, 221, 234, 255]);          // 左下：笔记
  roundRect(X0 + S1 + G, Y0 + S1 + G, S1, S1, 8, [255, 255, 255, 34]);  // 右下：回收站（空位）
  /* 左上格里压一条“文字行”，让它像一张卡片而不是纯色块 */
  roundRect(X0 + 8, Y0 + 21, 17, 4.5, 2.2, [60, 46, 12, 150]);
}

/* ---------------- 候选 C：层叠卡片 ---------------- */
function variantC() {
  reset();
  bg([37, 43, 57], [19, 22, 28]);
  roundRect(50, 20, 48, 74, 9, BLUE_D);            // 后卡
  roundRect(30, 28, 50, 76, 9, [120, 162, 255, 255]);
  roundRect(30, 28, 50, 76, 9, (x, y) => (y > 28 + 60 ? [255, 255, 255, 40] : null));
  /* 前卡 */
  const PX = 26, PY = 34, PW = 50, PH = 76;
  roundRect(PX, PY, PW, PH, 9, PAPER);
  roundRect(PX + 9, PY + 14, 24, 5, 2.5, LINE);
  roundRect(PX + 9, PY + 25, 32, 5, 2.5, LINE);
  roundRect(PX + 7, PY + 38, 36, 11, 4, AMBER);
  roundRect(PX + 9, PY + 54, 22, 5, 2.5, LINE);
  circle(PX + 14, PY + 66, 2.4, BLUE);
}

/* ---------------- 缩放输出 ---------------- */
function downscale() {
  const out = Buffer.alloc(OUT * OUT * 4);
  for (let y = 0; y < OUT; y++) {
    for (let x = 0; x < OUT; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < K; dy++) {
        for (let dx = 0; dx < K; dx++) {
          const i = ((y * K + dy) * S + (x * K + dx)) * 4;
          const al = px[i + 3] / 255;
          r += px[i] * al; g += px[i + 1] * al; b += px[i + 2] * al; a += al;
        }
      }
      const o = (y * OUT + x) * 4;
      const n = K * K;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

/* ---------------- PNG 编码 ---------------- */
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
function writePng(file, rgba) {
  const raw = Buffer.alloc((OUT * 4 + 1) * OUT);
  for (let y = 0; y < OUT; y++) {
    raw[y * (OUT * 4 + 1)] = 0;
    rgba.copy(raw, y * (OUT * 4 + 1) + 1, y * OUT * 4, (y + 1) * OUT * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(OUT, 0); ihdr.writeUInt32BE(OUT, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
  fs.writeFileSync(file, png);
  return png.length;
}

/* ---------------- 输出 ---------------- */
const dir = path.join(__dirname, 'logo-candidates');
fs.mkdirSync(dir, { recursive: true });
const list = [
  ['A-纸页高亮', variantA],
  ['B-看板三列', variantB],
  ['B2-看板卡片', variantB2],
  ['D-四格仪表盘', variantD],
  ['C-层叠卡片', variantC]
];
for (const [name, fn] of list) {
  fn();
  const n = writePng(path.join(dir, name + '.png'), downscale());
  console.log('OK', name, n, 'bytes');
}
