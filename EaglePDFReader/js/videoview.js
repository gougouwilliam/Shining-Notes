/* 视频阅读区（v3.3 新增）

   与 PDF 阅读区互斥：打开视频时隐藏 #viewport，显示 #videoStage。
   视频笔记复用了 PDF 摘录的数据模型，只是把「页」换成了「时间」：
     { type:'note'|'area'|'highlight', t: 秒, t1: 秒|null, image: 帧截图 }
   这样右栏列表、知识库、Eagle 注释同步全都不用改，只要在显示时把 p.X 换成 00:12。

   文件来源两种：
   1) file:// 直读（最快，内存不占）——在 eagleplugin:// 下可能被 webSecurity 拦；
   2) 拦了就用 Node 读成 Blob 再 createObjectURL（一定可用，代价是占内存）。
   所以这里先试 (1)，一旦 <video> 抛 error 再退到 (2)。 */
const VideoView = (function () {
  let video = null;
  let objectUrl = null;
  let current = null;          // 当前条目
  let clipStart = null;        // 「片段」的第一下
  let watchdog = null;         // 「迟迟读不到元数据」的看门狗
  let cb = {};
  let zoom = 1;                // 视频显示倍率（顶栏 +/−/适宽 控制）
  let sel = null;              // 框选进行中：{x0,y0,layer,box}
  let selCb = null;            // 框选完成回调 {onDone(dataUrl), onCancel()}
  let marks = [];              // 时间轴刻度：[{t, t1, color, kind, id, active}]
  let dragging = false;        // 正在拖时间轴
  let cropPct = 0;             // 画面底部被裁掉的比例（0–6，单位 %）——见 detectCrop
  let rangeStop = null;        // 「预览片段」的终点；到点自动暂停

  const EXT = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'ogv', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', '3gp'];

  function isVideoItem(item) {
    if (!item) return false;
    const ext = String(item.ext || '').toLowerCase();
    if (EXT.indexOf(ext) >= 0) return true;
    return /\.(mp4|m4v|mov|webm|mkv|avi|ogv|wmv|flv|mpg|mpeg|ts|3gp)$/i.test(String(item.name || ''));
  }

  function fmt(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(r)}` : `${p(m)}:${p(r)}`;
  }

  function el(id) { return document.getElementById(id); }

  function nodeMods() {
    try { if (typeof require === 'function') return { fs: require('fs'), path: require('path') }; } catch (e) { /* ignore */ }
    return null;
  }

  function init(callbacks) {
    cb = callbacks || {};
    video = el('videoEl');
    if (!video) return;

    video.addEventListener('timeupdate', syncTime);
    video.addEventListener('durationchange', syncTime);
    video.addEventListener('loadedmetadata', () => {
      syncTime();
      if (watchdog) { clearTimeout(watchdog); watchdog = null; }
      if (cb.onReady) cb.onReady(duration());
    });
    /* 画面出来了才谈得上「量底部那条白边」。seek 之后画面变了也要重量 ——
       有些视频前几秒是片头（带白底字幕条），正片才是干净画面。 */
    video.addEventListener('loadeddata', () => { detectCrop(); syncCtrl(); });
    video.addEventListener('seeked', () => { detectCrop(); });
    video.addEventListener('error', () => fallbackBlob());
    video.addEventListener('play', () => { if (cb.onState) cb.onState(true); syncCtrl(); });
    video.addEventListener('pause', () => { if (cb.onState) cb.onState(false); syncCtrl(); });
    video.addEventListener('volumechange', syncCtrl);

    const rate = el('vsRate');
    if (rate) rate.addEventListener('change', () => { video.playbackRate = Number(rate.value) || 1; });

    /* v3.30：自带控制条的三个键。原生 controls 会盖住画面底部（正好是那条白边露出来的位置），
       所以去掉了；但播放 / 静音 / 全屏这三个还是得能点。 */
    const playBtn = el('btnVsPlay');
    if (playBtn) playBtn.addEventListener('click', () => { toggle(); });
    const muteBtn = el('btnVsMute');
    if (muteBtn) muteBtn.addEventListener('click', () => {
      if (!video) return;
      video.muted = !video.muted;
      if (!video.muted && video.volume === 0) video.volume = 1;
      syncCtrl();
    });
    const fullBtn = el('btnVsFull');
    if (fullBtn) fullBtn.addEventListener('click', toggleFull);

    /* v3.31：点画面本身 = 播放 / 暂停。
       去掉原生 controls 之后，播放键只剩工具条上那一个，而用户的手会本能地
       去点画面 —— 点了没反应，看起来就是「播放器坏了」。
       框选模式（vsSelLayer 显形、正在拖矩形）不抢这一下。 */
    if (video) {
      video.addEventListener('click', () => {
        if (areaActive()) return;
        toggle();
      });
    }
    document.addEventListener('fullscreenchange', syncCtrl);
    syncCtrl();

    /* 框选：在画面上拖矩形。按下在 layer 上，移动/抬起挂在 window，
       这样鼠标拖出画布外也不会丢事件。 */
    const layer = el('vsSelLayer');
    if (layer) {
      layer.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const box = el('vsSelBox');
        const r = video.getBoundingClientRect();
        sel = { x0: e.clientX - r.left, y0: e.clientY - r.top, rect: r, moved: false };
        if (box) {
          box.hidden = false;
          box.style.left = sel.x0 + 'px';
          box.style.top = sel.y0 + 'px';
          box.style.width = '0px';
          box.style.height = '0px';
        }
      });
    }
    window.addEventListener('mousemove', onSelMove);
    window.addEventListener('mouseup', onSelUp);

    /* 时间轴：按下即定位，按住拖动连续定位。
       片段进行中也能拖 —— 用户不必等视频真的播到 B 点。 */
    const track = el('vsTrack');
    if (track) {
      track.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        /* 点在色块上 = 顺手选中那条记录（Delete 才有对象可删），同时照旧定位到该时间点 */
        const mk = e.target.closest ? e.target.closest('.vst-mark') : null;
        if (mk && mk.dataset.id && typeof cb.onMarkPick === 'function') {
          try { cb.onMarkPick(mk.dataset.id); } catch (err) { /* ignore */ }
        }
        dragging = true;
        seekAtClientX(e.clientX);
      });
    }
    window.addEventListener('mousemove', (e) => { if (dragging) seekAtClientX(e.clientX); });
    window.addEventListener('mouseup', () => { if (dragging) { dragging = false; renderTrack(); } });
  }

  function seekAtClientX(clientX) {
    const track = el('vsTrack');
    if (!track || !video) return;
    const r = track.getBoundingClientRect();
    if (!r.width) return;
    const k = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    seek(k * duration());
    renderTrack();
    renderClipUI();
  }

  /* ---------- 时间轴刻度：截图 / 框选 / 片段按颜色排在轴上 ---------- */
  function setMarks(list) {
    marks = (list || []).filter((m) => m && typeof m.t === 'number')
      .map((m) => ({
        t: Math.max(0, m.t),
        t1: typeof m.t1 === 'number' ? m.t1 : null,
        color: m.color || '#f5c542',
        kind: m.kind || '',
        id: m.id || '',
        active: !!m.active
      }));
    renderTrack();
  }

  function renderTrack() {
    const wrap = el('vstMarks');
    const fill = el('vstFill');
    const head = el('vstHead');
    const d = duration();
    if (fill && head) {
      const k = d ? Math.max(0, Math.min(1, time() / d)) : 0;
      const p = (k * 100).toFixed(3) + '%';
      fill.style.width = p;
      head.style.left = p;
    }
    if (wrap) {
      wrap.innerHTML = '';
      if (!d) return;
      marks.forEach((m) => {
        const n = document.createElement('div');
        n.className = 'vst-mark' + (m.active ? ' active' : '');
        n.style.background = m.color;
        if (m.id) n.dataset.id = m.id;
        if (m.t1 != null && m.t1 > m.t) {
          n.classList.add('vst-span');
          n.style.left = (Math.min(1, m.t / d) * 100).toFixed(3) + '%';
          n.style.width = (Math.max(0.4, (m.t1 - m.t) / d * 100)).toFixed(3) + '%';
        } else {
          n.style.left = (Math.min(1, m.t / d) * 100).toFixed(3) + '%';
        }
        n.title = m.kind
          ? m.kind + ' ' + fmt(m.t) + (m.t1 != null && m.t1 > m.t ? ' → ' + fmt(m.t1) : '')
          : fmt(m.t);
        wrap.appendChild(n);
      });
    }
    renderClipUI();
  }

  /* 片段进行中：画面左上角计时 + 轴上 A→当前 的区间 */
  function renderClipUI() {
    const box = el('vsClipTimer');
    const bar = el('vstClip');
    const d = duration();
    if (clipStart == null) {
      if (box) box.hidden = true;
      if (bar) bar.hidden = true;
      return;
    }
    const cur = time();
    const span = Math.max(0, cur - clipStart);
    if (box) box.hidden = false;
    const e1 = el('vsClipElapsed');
    const e2 = el('vsClipRange');
    if (e1) e1.textContent = fmt(span);
    if (e2) {
      e2.textContent = cur >= clipStart
        ? 'A ' + fmt(clipStart) + ' · B ' + fmt(cur)
        : 'A ' + fmt(clipStart) + ' · 现在在起点之前';
    }
    if (bar) {
      if (!d) { bar.hidden = true; return; }
      const a = Math.min(1, clipStart / d) * 100;
      const b = Math.min(1, Math.max(clipStart, cur) / d) * 100;
      bar.hidden = false;
      bar.style.left = a.toFixed(3) + '%';
      bar.style.width = Math.max(0.3, b - a).toFixed(3) + '%';
    }
  }

  function setClip(t0) {
    clipStart = (t0 == null || !isFinite(t0)) ? null : Math.max(0, Number(t0));
    renderTrack();
    return clipStart;
  }
  function clipStartTime() { return clipStart; }

  function onSelMove(e) {
    if (!sel) return;
    const box = el('vsSelBox');
    if (!box) return;
    const x = e.clientX - sel.rect.left;
    const y = e.clientY - sel.rect.top;
    const left = Math.max(0, Math.min(x, sel.x0));
    const top = Math.max(0, Math.min(y, sel.y0));
    const w = Math.abs(x - sel.x0);
    const h = Math.abs(y - sel.y0);
    if (w > 6 || h > 6) sel.moved = true;
    box.style.left = left + 'px';
    box.style.top = top + 'px';
    box.style.width = w + 'px';
    box.style.height = h + 'px';
  }

  function onSelUp() {
    if (!sel) return;
    const box = el('vsSelBox');
    const s = sel;
    sel = null;
    if (!s.moved) {                       // 只是点了一下，当取消
      if (box) box.hidden = true;
      return;
    }
    const bw = parseFloat(box && box.style.width) || 0;
    const bh = parseFloat(box && box.style.height) || 0;
    const bl = parseFloat(box && box.style.left) || 0;
    const bt = parseFloat(box && box.style.top) || 0;
    if (bw < 8 || bh < 8) { if (box) box.hidden = true; return; }

    /* 屏幕坐标 → 视频原始像素。video 是 object-fit: contain，元素框比画面宽时
       左右有黑边，必须按「实际画面区域」换算，否则截出来的位置会偏。 */
    const vw = video.videoWidth || 0;
    const vh = video.videoHeight || 0;
    const k = Math.min(s.rect.width / vw, s.rect.height / vh) || 1;
    const offX = (s.rect.width - vw * k) / 2;
    const offY = (s.rect.height - vh * k) / 2;
    const rect = {
      x: Math.max(0, (bl - offX) / k),
      y: Math.max(0, (bt - offY) / k),
      w: Math.min(vw, bw / k),
      h: Math.min(vh, bh / k)
    };
    /* 底部被裁掉那条白边不该被框进去（它已经看不见了，画到图里只会莫名其妙） */
    const visibleH = vh * (1 - cropPct / 100);
    if (rect.y + rect.h > visibleH) rect.h = Math.max(1, visibleH - rect.y);
    const data = captureFrame(1, rect);
    endArea();
    const done = selCb && selCb.onDone;
    selCb = null;
    if (done) done(data, rect);
  }

  function endArea() {
    const layer = el('vsSelLayer');
    const box = el('vsSelBox');
    if (layer) layer.hidden = true;
    if (box) { box.hidden = true; box.style.width = '0px'; box.style.height = '0px'; }
    sel = null;
  }

  /* 开始框选。cb: { onDone(dataUrl, rect), onCancel() } */
  function beginArea(c) {
    if (!video || !video.videoWidth) { setTip('视频还没准备好，稍等一下再框选'); return false; }
    const layer = el('vsSelLayer');
    if (!layer) return false;
    selCb = c || null;
    endArea();
    layer.hidden = false;
    setSelHint('拖拽框选要截取的区域，Esc 取消');
    return true;
  }

  function cancelArea() {
    const c = selCb;
    const had = !!c;
    endArea();
    selCb = null;
    if (c && c.onCancel) c.onCancel();      // 交给调用方收尾（弹栈、恢复播放）
    return had;
  }

  function areaActive() {
    const layer = el('vsSelLayer');
    return !!(layer && !layer.hidden);
  }

  function setSelHint(text) {
    const n = el('vsSelHint');
    if (n) n.textContent = text;
  }

  /* 显示倍率：0.5× ~ 2×，适宽 = 1 */
  function setZoom(z) {
    zoom = Math.max(0.5, Math.min(2, Number(z) || 1));
    const stage = el('videoStage');
    if (stage) stage.style.setProperty('--vs-zoom', String(zoom));
    if (cb.onZoom) cb.onZoom(zoom);
    return zoom;
  }
  function getZoom() { return zoom; }

  function syncTime() {
    const t = el('vsTime');
    if (!t || !video) return;
    t.textContent = fmt(video.currentTime) + ' / ' + fmt(video.duration);
    /* 「预览片段」到点自停：只认 timeupdate 就够，误差在 0.25 秒内，
       人耳听不出来；但要防「拖到终点之后再也不触发」的边角，所以也判 >= */
    if (rangeStop != null && video.currentTime >= rangeStop - 0.03) {
      rangeStop = null;
      pause();
      setTip('片段预览结束（' + fmt(video.currentTime) + '）');
    }
    renderTrack();
  }

  function duration() {
    return video && isFinite(video.duration) ? video.duration : 0;
  }
  function time() { return video ? video.currentTime : 0; }
  function playing() { return !!(video && !video.paused); }

  function play() { if (video) video.play().catch(() => {}); }
  function pause() { if (video) video.pause(); }
  function toggle() { if (!video) return; if (video.paused) play(); else pause(); }
  function seek(t) {
    if (!video) return;
    const d = duration();
    video.currentTime = Math.max(0, Math.min(d || t, Number(t) || 0));
    /* 用户自己拖到别处了，就别再按上一段的终点把播放掐掉 */
    rangeStop = null;
    syncTime();
  }
  function nudge(dt) { seek(time() + dt); }

  /* ---------- 片段：连按两次取 A / B ---------- */
  function onClip() {
    const t = time();
    if (clipStart == null) {
      setClip(t);
      setTip('片段起点 A = ' + fmt(t) + '，播到终点后再按一次「片段」（可拖时间轴或按 → 快进）');
      if (cb.onClipStart) cb.onClipStart(t);
      return;
    }
    const t0 = Math.min(clipStart, t);
    const t1 = Math.max(clipStart, t);
    setClip(null);
    setTip('已截取片段 ' + fmt(t0) + ' → ' + fmt(t1));
    if (cb.onClip) cb.onClip(t0, t1);
  }

  function setTip(text) {
    const n = el('vsTip');
    if (n) n.textContent = text;
  }

  /* ---------- 自绘控制条（v3.30） ---------- */
  function syncCtrl() {
    const p = el('btnVsPlay');
    if (p) {
      const on = playing();
      p.textContent = on ? '❚❚' : '▶';
      p.title = on ? '暂停（空格）' : '播放（空格）';
    }
    const m = el('btnVsMute');
    if (m && video) {
      const muted = !!video.muted || video.volume === 0;
      m.textContent = muted ? '🔇' : '🔊';
      m.title = muted ? '取消静音' : '静音';
      m.classList.toggle('off', muted);
    }
    const f = el('btnVsFull');
    if (f) {
      const fs = !!(document.fullscreenElement);
      f.textContent = fs ? '⤡' : '⛶';
      f.title = fs ? '退出全屏（Esc）' : '全屏';
    }
  }

  function toggleFull() {
    const stage = el('videoStage');
    try {
      if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
      if (stage && stage.requestFullscreen) { stage.requestFullscreen().catch(() => {}); }
    } catch (e) { /* ignore */ }
  }

  /* ---------- 预览一段（v3.30） ----------
     片段以前是「录成 mp4，再用系统播放器打开」。用户说得对：原视频就在眼前，
     预览根本不需要出文件 —— 定位到 A 播到 B，到点自己停。 */
  function playRange(t0, t1) {
    if (!video) return false;
    const a = Math.max(0, Number(t0) || 0);
    const b = Math.max(a, Number(t1) || 0);
    seek(a);                       // seek 会清掉 rangeStop，所以先定位再设终点
    rangeStop = b > a + 0.05 ? b : null;
    play();
    return true;
  }

  function stopRange() { rangeStop = null; }

  /* ---------- 底部白边 / 烧进画面的进度条（v3.32 重写） ----------
     这些视频是「录屏」，画面最底下烧着一条播放器进度条，条下面和上面都是白，
     于是播放器里看着是白带、截出来的图也拖着白带。

     实测数据（1920×858，见 .tmp-frames 里的 raw_3 / raw_6）：
       · 左右是黑边（pillar box），白带只横跨中间 1282 列 ——
         拿「整行 99% 是白」去判，占比永远只有 66.7%，阈值永远达不到，
         v3.30 / v3.31 两版就是死在这里，一行都没裁掉；
       · 白带中间那条进度条只占 69% 的白 ——
         「连续纯白」的写法走到条这里就断，只裁到条下方 16 行，条还留着。

     所以改成三步：
       ① 先量出内容列范围（排除左右黑边），之后只在内容列里判白；
       ② 「白 → 进度条 → 白」算同一块，中间允许 2 行噪声；
       ③ 上限 maxRows（默认画面高 5%），再多就当那是画面内容，宁可不裁。 */

  function mkCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, w);
    c.height = Math.max(1, h);
    return { el: c, ctx: c.getContext('2d', { willReadFrequently: true }) };
  }

  /* 量底部白带（含烧进去的进度条）占多少行。
     要求：画布 1 行 == 视频 1 行（宽度可以缩，行数不能缩，否则几十行会被抹平）。 */
  function analyzeBand(ctx, w, h, maxRows) {
    if (!ctx || !w || !h || h < 8) return 0;
    const cap = Math.max(3, Math.min(h, Math.round(maxRows || h * 0.05)));
    let img;
    try { img = ctx.getImageData(0, 0, w, h); } catch (e) { return 0; }
    const d = img.data;

    /* ① 内容列：整幅高度上均匀取 24 行，统计每列「接近纯黑」的比例，
          取最长的非黑连续段 —— 左右黑边就被排除了。 */
    const rowStep = Math.max(1, Math.floor(h / 24));
    const colStep = Math.max(1, Math.floor(w / 400));
    let samples = 0;
    for (let y = 0; y < h; y += rowStep) samples++;
    if (!samples) return 0;

    let run = 0;
    let best = 0;
    let bestAt = 0;
    let idx = 0;
    for (let x = 0; x < w; x += colStep, idx++) {
      let dark = 0;
      for (let y = 0; y < h; y += rowStep) {
        const i = (y * w + x) * 4;
        if (d[i] <= 24 && d[i + 1] <= 24 && d[i + 2] <= 24) dark++;
      }
      if (dark <= samples * 0.6) {
        run++;
        if (run > best) { best = run; bestAt = idx - run + 1; }
      } else {
        run = 0;
      }
    }
    const totalCols = idx;
    /* 内容区不到四分之一宽 → 量不准（全黑画面 / 极窄画面），不动 */
    if (best < totalCols * 0.25) return 0;
    const cx0 = bestAt * colStep;
    const cx1 = Math.min(w - 1, (bestAt + best - 1) * colStep);

    /* ② 逐行算「白像素」占比，只看内容列 */
    const ratio = (y) => {
      let white = 0;
      let total = 0;
      for (let x = cx0; x <= cx1; x += 2) {
        const i = (y * w + x) * 4;
        total++;
        if (d[i] > 232 && d[i + 1] > 232 && d[i + 2] > 232) white++;
      }
      return total ? white / total : 0;
    };

    /* ③ v3.33：改成「白 → 进度条 → 白」三段式匹配，不再贪婪地见浅色就往里吞。
       为什么（实测 f3 = 白底幻灯片那一帧）：
         底部 14 行纯白，再往上全是 0.7~0.95 白的浅色正文。
         旧写法 `r >= 0.42 就算带内` 会一路啃到上限，把幻灯片正文切掉 40 多行。
       新判据：底部先要有整行纯白 A；上面允许一段浅色 B（进度条）；
       只有 B 之上**又出现整行纯白 C**，才承认 B 是白带里的条、三段一起裁；
       否则只裁 A —— 宁少裁，不啃正文。 */
    let A = 0;
    while (A < cap && ratio(h - 1 - A) >= 0.98) A++;

    /* 形态二：进度条正好贴着画面底边（条下方没白了）。
       底部直接是 0.7 左右的条，条上方才是整行白 —— 这时 A 会是 0，
       不能因此判「没有白带」，否则整条白带留在画面里。 */
    if (A < 2) {
      let b = 0;
      while (b < 16 && h - 1 - b >= 0) {
        const r = ratio(h - 1 - b);
        if (r >= 0.42 && r < 0.98) b++;
        else break;
      }
      if (b < 3) return 0;
      let c = 0;
      while (c < cap && h - 1 - b - c >= 0 && ratio(h - 1 - b - c) >= 0.98) c++;
      if (c < 3) return 0;
      return Math.min(b + c + 2, cap);
    }

    const yA = h - 1 - A;
    let B = 0;
    while (B < 16 && yA - B >= 0) {
      const r = ratio(yA - B);
      if (r >= 0.42 && r < 0.98) B++;
      else break;
    }
    let C = 0;
    if (B >= 3) {
      const yB = yA - B;
      while (C < cap && yB - C >= 0 && ratio(yB - C) >= 0.98) C++;
    }
    const total = (B >= 3 && C >= 3) ? A + B + C : A;
    /* 白带上方紧挨着的 1-2 行是「画面 + 白」的过渡行（实测 0.97 白），
       不把它算进来就是一条肉眼可见的细白线；多裁 2 行内容只有 0.23%，看不见。 */
    return Math.min(total + 2, cap);
  }

  /* 出图前裁掉底部白带（画布 1 行 == 视频 1 行） */
  function trimCanvas(c) {
    let rows = 0;
    try {
      rows = analyzeBand(c.getContext('2d'), c.width, c.height, Math.ceil(c.height * 0.05));
    } catch (e) { rows = 0; }
    if (rows < 2) return c;
    const out = document.createElement('canvas');
    out.width = c.width;
    out.height = Math.max(1, c.height - rows);
    try {
      out.getContext('2d').drawImage(c, 0, 0, c.width, out.height, 0, 0, c.width, out.height);
    } catch (e) { return c; }
    return out;
  }

  /* 显示层：量一次当前画面，把底部那条白带裁出可视区（clip-path），
     下面的 .vs-frame 是黑的，看起来就是播放器自带的下缘。

     取样要点（三次踩坑的结论）：
       · 行不能缩 —— 白带只有 39 行，整帧缩到 200 宽就只剩 17 行，判不准；
       · 宽度可以缩 —— 缩宽度不影响行数，但左右黑边必须能被认出来；
       · 所以这里画的是「底部一条 1:1 的窄条画布」：宽度降到 320，
         高度原样保留，analyzeBand 在里面自己找内容列。 */
  function detectCrop() {
    if (!video || !video.videoWidth || !video.readyState) return;
    try {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      /* v3.33：上限从 5% 提到 6.5%。
         实测幻灯片那一帧的白带正好 43 行 / 858 = 5.01%，旧上限 ceil(858*0.05)=43
         刚好把它卡在边界上 —— 少裁一两行就是用户看到的「还有一点点白」。
         宁可把上限放宽，也不要让白带贴着上限擦边。 */
      const maxRows = Math.ceil(vh * 0.065);
      const bandH = Math.min(vh, maxRows + 16);
      const bw = Math.max(80, Math.min(320, vw));
      const c = mkCanvas(bw, bandH);
      c.ctx.drawImage(video, 0, vh - bandH, vw, bandH, 0, 0, bw, bandH);
      const rows = analyzeBand(c.ctx, bw, bandH, maxRows);
      applyCrop(rows ? (rows / vh) * 100 : 0);
    } catch (e) { /* ignore */ }
  }

  function applyCrop(pct) {
    const p = Math.max(0, Math.min(8, Number(pct) || 0));
    if (Math.abs(p - cropPct) < 0.05) return;
    cropPct = p;
    /* v3.33：为什么还要额外 +1px ——
       裁量是按视频行算出来的百分比，可 clip-path 最终要落到设备像素上取整。
       视频 858 行显示成几百 CSS px 时，1 CSS px 就对应好几行画面；
       取整一旦往下抹，边界就留半行「画面 + 白带」的混色，
       肉眼看就是一条细白线（用户说的「还有一点点」）。
       多裁 1px 把它推进下方那条黑带里，看不见任何代价。 */
    let clip = '';
    if (p) {
      let hpx = 0;
      try { hpx = video && video.getBoundingClientRect ? video.getBoundingClientRect().height : 0; } catch (e) { hpx = 0; }
      const pad = hpx > 40 ? (1 / hpx) * 100 : 0.12;
      clip = 'inset(0 0 calc(' + (p + pad).toFixed(2) + '% + 1px) 0)';
    }
    try {
      if (video) video.style.clipPath = clip;
    } catch (e) { /* ignore */ }
    const layer = el('vsSelLayer');
    if (layer) layer.style.bottom = p ? p.toFixed(2) + '%' : '0';
    /* 最后一层兜底：底部压一条黑边（见 css 的 .vs-frame.has-crop::after）。
       clip 边界再怎么取整，最下面那几像素也是黑的。 */
    const frame = el('vsFrame');
    if (frame) frame.classList.toggle('has-crop', !!p);
  }

  /* ---------- 帧截图。rect 传视频原始像素的局部区域，不传就是整帧 ---------- */
  function captureFrame(scale, rect) {
    if (!video || !video.videoWidth) return '';
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const r = rect && rect.w > 0 && rect.h > 0
      ? rect
      : { x: 0, y: 0, w: vw, h: vh };
    const maxW = 1200;
    const k = Math.min(1, maxW / r.w);
    const s = scale || k;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(r.w * s));
    c.height = Math.max(1, Math.round(r.h * s));
    const ctx = c.getContext('2d');
    try {
      ctx.drawImage(video, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
      /* v3.30：整帧截图顺手裁掉底部那条白边（局部框选不动 —— 那是用户自己划的范围） */
      const out = (rect && rect.w > 0 && rect.h > 0) ? c : trimCanvas(c);
      return out.toDataURL('image/jpeg', 0.86);
    } catch (e) {
      return '';
    }
  }

  /* ---------- 取「某一秒」的画面（v3.15） ----------
     字幕存笔记要配一张「这句话开始时的画面」。用**另一个**离屏 video 去定位，
     而不是动正在播的那个 —— 把播放中的视频拖到别的秒再拖回来，
     轻则卡顿一下，重则把用户正在看的位置弄丢。 */
  function captureFrameAt(t) {
    return new Promise((resolve) => {
      const src = video ? (video.currentSrc || video.src) : '';
      if (!src) { resolve(''); return; }
      let v = null;
      let settled = false;
      const done = (out) => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        if (v) {
          try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) { /* ignore */ }
        }
        resolve(out || '');
      };
      /* 有些格式 seek 会卡住（尤其是 file:// 大文件），别让调用方无限等 */
      const guard = setTimeout(() => done(''), 6000);

      try {
        v = document.createElement('video');
        v.muted = true;
        v.playsInline = true;
        v.preload = 'auto';
      } catch (e) { done(''); return; }

      const draw = () => {
        try {
          const vw = v.videoWidth, vh = v.videoHeight;
          if (!vw || !vh) { done(''); return; }
          const maxW = 1000;
          const s = Math.min(1, maxW / vw);
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(vw * s));
          c.height = Math.max(1, Math.round(vh * s));
          const ctx = c.getContext('2d');
          ctx.drawImage(v, 0, 0, c.width, c.height);
          done(c.toDataURL('image/jpeg', 0.86));
        } catch (e) { done(''); }
      };

      v.addEventListener('error', () => done(''));
      v.addEventListener('loadedmetadata', () => {
        const dur = isFinite(v.duration) ? v.duration : 0;
        const at = Math.max(0, Math.min(Number(t) || 0, dur ? dur - 0.05 : Number(t) || 0));
        try { v.currentTime = at; } catch (e) { done(''); }
      });
      v.addEventListener('seeked', () => {
        /* 再等一帧：个别解码器在 seeked 之后画面还没真正可用 */
        requestAnimationFrame(() => requestAnimationFrame(draw));
      });
      v.src = src;
    });
  }

  /* ---------- 原分辨率取帧（v3.27） ----------
     索引里存的截图是压缩过的 JPEG（宽最多 1200），做幻灯片、贴文档、投稿都不够用。
     这里按视频自己的 videoWidth / videoHeight 原样取一张 PNG ——
     「节选出来的东西，应该能按原样另存」。 */
  function drawNative(v, rect) {
    try {
      const vw = v.videoWidth || 0;
      const vh = v.videoHeight || 0;
      if (!vw || !vh) return '';
      const r = rect && rect.w > 0 && rect.h > 0
        ? {
          x: Math.max(0, Math.min(rect.x, vw - 1)),
          y: Math.max(0, Math.min(rect.y, vh - 1)),
          w: Math.min(rect.w, vw),
          h: Math.min(rect.h, vh)
        }
        : { x: 0, y: 0, w: vw, h: vh };
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(r.w));
      c.height = Math.max(1, Math.round(r.h));
      const ctx = c.getContext('2d');
      ctx.drawImage(v, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
      const full = !(rect && rect.w > 0 && rect.h > 0);
      const out = full ? trimCanvas(c) : c;
      return out.toDataURL('image/png');
    } catch (e) {
      return '';
    }
  }

  /* 取 t 秒处的原分辨率画面（rect 用视频原始像素）。
     当前画面正好在 t 附近就直接画主视频；否则用离屏 video seek —— 与 captureFrameAt
     同一套思路，只是不缩放。 */
  function captureNative(t, rect) {
    const at = Math.max(0, Number(t) || 0);
    if (video && video.videoWidth && Math.abs(time() - at) < 0.4) {
      const now = drawNative(video, rect);
      if (now) return Promise.resolve(now);
    }
    return new Promise((resolve) => {
      const src = video ? (video.currentSrc || video.src) : '';
      if (!src) { resolve(''); return; }
      let v = null;
      let settled = false;
      const done = (out) => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) { /* ignore */ } }
        resolve(out || '');
      };
      const guard = setTimeout(() => done(''), 6000);
      try {
        v = document.createElement('video');
        v.muted = true;
        v.playsInline = true;
        v.preload = 'auto';
      } catch (e) { done(''); return; }
      v.addEventListener('error', () => done(''));
      v.addEventListener('loadedmetadata', () => {
        const dur = isFinite(v.duration) ? v.duration : 0;
        const target = Math.max(0, Math.min(at, dur ? dur - 0.05 : at));
        try { v.currentTime = target; } catch (e) { done(''); }
      });
      v.addEventListener('seeked', () => {
        requestAnimationFrame(() => requestAnimationFrame(() => done(drawNative(v, rect))));
      });
      v.src = src;
    });
  }

  function nativeSize() {
    return { w: (video && video.videoWidth) || 0, h: (video && video.videoHeight) || 0 };
  }

  /* ---------- 载入 / 关闭 ---------- */
  function cleanupSrc() {
    if (objectUrl) {
      try { URL.revokeObjectURL(objectUrl); } catch (e) { /* ignore */ }
      objectUrl = null;
    }
  }

  /* v4.2.1 稳定性：blob 源统一走异步读 —— readFileSync 读整个视频会把 UI 冻住
     （几个 GB 的文件就是好几秒的白屏假死）。共用一个在飞保护：error 事件和
     2.5s 看门狗可能同一拍触发，读两次白费内存；读的途中用户切了视频就作废。 */
  let blobReading = false;
  function startBlobRead(onOk, tipText) {
    const m = nodeMods();
    const path0 = current && current.filePath;
    if (!m || !path0) return false;
    if (blobReading) return true;      // 已经在读同一个文件，这次等着接结果就行
    blobReading = true;
    m.fs.readFile(path0, (err, buf) => {
      blobReading = false;
      if (err || !buf || !buf.length) {
        setTip('读取视频失败：' + (err && err.message ? err.message : '文件为空'));
        return;
      }
      if (objectUrl || !video) return;                      // 等待期间已经切过去了
      if (!current || current.filePath !== path0) return;   // 已经换了视频
      try {
        const blob = new Blob([buf], { type: guessMime(current) });
        objectUrl = URL.createObjectURL(blob);
        video.src = objectUrl;
        video.load();
        if (tipText) setTip(tipText);
        if (onOk) onOk();
      } catch (e) {
        setTip('读取视频失败：' + (e.message || e));
      }
    });
    return true;
  }

  function fallbackBlob() {
    if (!current || objectUrl || blobReading) return;   // 已经在用/在读 blob，别再循环
    const m = nodeMods();
    if (!m || !current.filePath) {
      setTip('这个视频无法播放（格式不受支持，或文件不可读）');
      return;
    }
    startBlobRead(null, '已切换为内存读取播放');
  }

  /* 主动切到内存源（blob）。
     为什么需要：页面是 eagleplugin://，视频是 file:// —— 跨源。读画面没问题，
     但「把视频的声音接进 WebAudio」会被同源策略掐掉（能连上，输出恒为 0）。
     blob 与页面同源，切过去音频就能抓了。代价是文件整个读进内存，所以有大小上限，
     并且只在字幕检测到「有画面没声音」时才由上层调用，正常播放不受影响。
     v4.2.1：读取改异步（不冻 UI）；返回 true = 读取已启动，调用方按原语义
     继续等音频帧，读失败时静默看门狗会照常走到「抓不到音频」的提示。 */
  function ensureBlobSource() {
    if (!current || !video) return false;
    if (objectUrl) return true;                  // 已经是 blob 源
    if (!current.filePath) return false;
    const m = nodeMods();
    if (!m || !m.fs) return false;
    try {
      const st = m.fs.statSync(current.filePath);
      if (st && st.size > 2 * 1024 * 1024 * 1024) return false;   // 超过 2 GB 不折腾内存
    } catch (e) { return false; }
    const t = video.currentTime || 0;
    const wasPlaying = !video.paused;
    return startBlobRead(() => {
      video.addEventListener('loadedmetadata', () => {
        try { video.currentTime = t; } catch (e) { /* ignore */ }
        if (wasPlaying) video.play().catch(() => {});
      }, { once: true });
    }, '已切换为内存读取播放（为了抓取音频做字幕）');
  }

  function guessMime(item) {
    const ext = String((item && (item.ext || item.name)) || '').toLowerCase();
    if (/mp4|m4v/.test(ext)) return 'video/mp4';
    if (/webm|ogv/.test(ext)) return 'video/webm';
    if (/mov/.test(ext)) return 'video/quicktime';
    if (/mkv/.test(ext)) return 'video/x-matroska';
    return 'video/mp4';
  }

  function open(item, opts) {
    if (!video) init(opts || {});
    if (opts) cb = Object.assign(cb, opts);
    close();
    current = item;
    setClip(null);
    marks = [];
    renderTrack();
    const stage = el('videoStage');
    const nameEl = el('vsName');
    if (nameEl) nameEl.textContent = item.name || '视频';
    if (stage) stage.hidden = false;
    setTip('空格 播放/暂停 · ← → 前后 5 秒');
    if (item._objectUrl) {
      objectUrl = item._objectUrl;
      video.src = objectUrl;
    } else if (item.filePath) {
      video.src = U.toFileUrl(item.filePath);
    }
    video.playbackRate = 1;
    /* v4.2.1 提速：明确要 auto 预取。部分内核默认只取元数据，
       第一下播放要等一段缓冲；auto 让打开期间就把数据往里灌，按空格立即出画。 */
    try { video.preload = 'auto'; } catch (e) { /* ignore */ }
    const rate = el('vsRate');
    if (rate) rate.value = '1';
    try { video.load(); } catch (e) { /* ignore */ }

    /* v4.2.2：打开即播（需求「视频直接播放」）。
       play() 在流没就绪时可能被内核拒绝 —— 失败就等首帧到了再补一次；
       若用户在这几十毫秒里手动按了暂停，这里不抢回去（只补这一次）。 */
    try {
      const p = video.play();
      if (p && p.catch) {
        p.catch(() => {
          video.addEventListener('loadeddata', () => { try { video.play(); } catch (e) { /* ignore */ } }, { once: true });
        });
      }
    } catch (e) { /* 个别内核同步抛错，静默留给空格键 */ }

    /* 看门狗：在 eagleplugin:// 里 file:// 有时既不报错也不加载（静默被拦），
       光等 error 事件会一直卡在黑屏。2.5 秒还没读到任何元数据就直接改走内存读取。 */
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      watchdog = null;
      if (!video || objectUrl) return;
      if (video.readyState < 1) fallbackBlob();
    }, 2500);
    const want = opts && typeof opts.startAt === 'number' ? opts.startAt : null;
    if (want != null) {
      video.addEventListener('loadedmetadata', () => { seek(want); }, { once: true });
    }
    syncTime();
  }

  function close() {
    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
    endArea();
    selCb = null;
    const stage = el('videoStage');
    if (stage) stage.hidden = true;
    if (video) {
      try { video.pause(); } catch (e) { /* ignore */ }
      video.removeAttribute('src');
      try { video.load(); } catch (e) { /* ignore */ }
    }
    cleanupSrc();
    current = null;
    rangeStop = null;
    applyCrop(0);
    setClip(null);
    marks = [];
    renderTrack();
    setZoom(1);
    syncCtrl();
  }

  function isOpen() {
    const stage = el('videoStage');
    return !!(stage && !stage.hidden);
  }

  return {
    init, open, close, isOpen, isVideoItem,
    time, duration, seek, nudge, toggle, play, pause, playing,
    playRange, stopRange, cropPct: () => cropPct, syncCtrl,
    captureFrame, captureFrameAt, captureNative, nativeSize, fmt, clip: onClip, EXT,
    element: () => video,
    beginArea, cancelArea, areaActive, setZoom, getZoom, setTip,
    ensureBlobSource,
    setMarks, setClip, clipStartTime, renderTrack,
    /* v3.31：白边检测的三个纯函数放出来，好让 test-v331 用假 canvas 真跑一遍
       （「整帧缩到 72 行 → 白边被抹平成 0」这个 bug 只能靠数值验证）。 */
    __test: { analyzeBand, trimCanvas }
  };
})();

try { window.VideoView = VideoView; } catch (e) { /* ignore */ }
if (typeof module !== 'undefined' && module.exports) module.exports = VideoView;
