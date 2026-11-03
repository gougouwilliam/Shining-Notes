/* selband.js —— 优雅选区条带的纯计算（v3.22）
 *
 * 背景（v3.21 没根除的问题）：
 *   PDF.js 文字层里的 span 是「绝对定位 + scaleX」摆放的，视觉顺序 ≠ DOM 顺序。
 *   拖选时鼠标稍微落到行间空白处，Chromium 的命中测试会退回到父级 .textLayer，
 *   再把「起点 → 该父级末尾」整段 DOM 区间算成选区 —— 表现就是「轻轻一动，
 *   一大片整行整段变蓝」，而且摘录/翻译拿到的文本也是错的。
 *
 * 两层处理：
 *   1) 视觉：原生 ::selection 在文字层内全程透明，改由 .selBandLayer 画圆角、
 *      低饱和、贴合字符的柔和条带。条带矩形由 viewer 逐个文本节点取真实几何
 *      （见 viewer._liveRects），因此首行从按下处起、末行到抬起处止、中间整行 ——
 *      既不会糊成一个大方框，也不会被裁成竖条。
 *   2) 数据：mouseup 时用 isSuspicious 判定选区是否被放大，若放大则用
 *      pickCaret 按指针位置重新定位结束点，把摘录/翻译的文本收回到真实拖过范围。
 *
 * 本文件只放纯函数（不碰 DOM），便于在 Node 里做行为级回归。
 */
(function (global) {
  'use strict';

  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  /* 视口坐标的矩形列表 → 裁剪进各页、转成相对页左上角的 px 矩形。
   *   rects: 类 DOMRect 数组 {left,top,right,bottom,width,height}
   *   pages: [{page,left,top,right,bottom}]（视口坐标）
   *   返回 [{page,left,top,width,height}]（相对页左上角 px）
   */
  function mapRects(rects, pages) {
    const out = [];
    if (!rects || !pages) return out;
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      if (!r) continue;
      const rl = num(r.left, 0);
      const rr = (r.right != null ? r.right : rl + num(r.width, 0));
      const rt = num(r.top, 0);
      const rb = (r.bottom != null ? r.bottom : rt + num(r.height, 0));
      if (rr - rl <= 0.5 || rb - rt <= 0.5) continue;
      for (let j = 0; j < pages.length; j++) {
        const p = pages[j];
        const L = Math.max(rl, p.left), R = Math.min(rr, p.right);
        const T = Math.max(rt, p.top), B = Math.min(rb, p.bottom);
        if (R - L > 0.5 && B - T > 0.5) {
          out.push({ page: p.page, left: L - p.left, top: T - p.top, width: R - L, height: B - T });
        }
      }
    }
    return out;
  }

  /* 是否该画条带：框选 / 锚点工具下不画；无选区或折叠选区不画 */
  function canPaint(tool, rangeCount, collapsed) {
    if (tool === 'area' || tool === 'note') return false;
    if (!rangeCount || rangeCount < 1) return false;
    if (collapsed) return false;
    return true;
  }

  /* v3.22 曾用 clipToBand 把条带「裁进拖拽带」来压制误选，结果走向另一个极端：
   * 横向也被裁，用户从段落中间往下拖时，中间整行被截成 [按下点, 抬起点] 那一段，
   * 屏幕上就是一个竖长条 —— 看起来像「框选」。v3.23 已删除该函数：
   * 改为按文本节点取真实行矩形（viewer._liveRects），只按纵向过滤候选节点，
   * 横向一律保留完整行宽，得到「一行一行跟着走」的观感。 */

  /* 选区是否被浏览器「吸附放大」了。 */

  /* 选区是否被浏览器「吸附放大」了。
   * 判据是「选区包围盒显著超出实际拖拽带」—— 正常拖选时两者基本一致，
   * 只有命中测试退回到父级容器时才会突然多出整行/整页。
   *   selRect: {left,top,right,bottom}（选区包围盒，视口坐标）
   *   band:    {l,t,r,b}（拖拽带）
   */
  function isSuspicious(selRect, band, lineH) {
    if (!selRect || !band) return false;
    const lh = Math.max(6, num(lineH, 14));
    const bandH = Math.max(0, band.b - band.t);
    const bandW = Math.max(0, band.r - band.l);
    const selH = Math.max(0, num(selRect.bottom, 0) - num(selRect.top, 0));
    const selW = Math.max(0, num(selRect.right, 0) - num(selRect.left, 0));
    /* 竖向多出 2.2 行以上：整段/整页被吞进来了 */
    if (selH > bandH + lh * 2.2) return true;
    /* 横向多出 9 个字符宽以上：起点之后的整行被吞进来了 */
    if (selW > bandW + lh * 9) return true;
    /* 起点也被吸附到拖拽带上方很远（按下时落在空白行间） */
    if (num(selRect.top, 0) < band.t - lh * 1.6) return true;
    return false;
  }

  /* 在候选文本节点里，按指针位置挑一个最合适的插入点。
   *   nodes: [{node, left, top, right, bottom}]（视口坐标；node 为文本节点）
   * 竖直距离权重远大于水平，避免跨行挑错；水平位置换算成字符偏移，
   * 让收尾落点尽量贴合鼠标。
   */
  function pickCaret(nodes, x, y) {
    if (!nodes || !nodes.length) return null;
    let best = null, bestD = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!n || !n.node) continue;
      const cy = (n.top + n.bottom) / 2;
      const halfH = Math.max(0, (n.bottom - n.top) / 2);
      const dy = Math.max(0, Math.abs(y - cy) - halfH);
      const dx = Math.max(0, Math.max(n.left - x, x - n.right));
      const d = dy * 100 + dx;
      if (d < bestD) { bestD = d; best = n; }
    }
    if (!best) return null;
    const len = (best.node.nodeValue || '').length;
    const w = best.right - best.left;
    let off;
    if (w <= 0.5) off = len;
    else off = Math.round(clamp01((x - best.left) / w) * len);
    return { node: best.node, offset: Math.max(0, Math.min(len, off)) };
  }

  const mod = { mapRects, canPaint, isSuspicious, pickCaret };
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  try { global.SelBand = mod; } catch (e) { /* ignore */ }
})(typeof window !== 'undefined' ? window : globalThis);
