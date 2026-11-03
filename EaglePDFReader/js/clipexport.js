/* 片段导出（v3.27）

   「节选片段」记录的是 A→B 两个时间点，索引里只留了一张封面帧。
   用户真正想要的是那一段视频本身 —— 而且要原分辨率。

   为什么不用 ffmpeg：插件不带外部依赖，Eagle 也不保证机器上有。
   这里的做法是「画布重录」：
     · 画布尺寸 = video.videoWidth × videoHeight（原分辨率，不缩放）；
     · 每一帧请求时用 drawImage 把当前画面搬上画布；
     · canvas.captureStream(fps) 把画布变成视频轨，audio 轨从 video.captureStream() 取；
     · MediaRecorder 按原速录一遍，出 mp4（Chromium 支持时）否则 webm。

   代价是「实时」—— 10 秒的片段要录 10 秒。这一点必须让用户看见（进度条 + 取消），
   不能让人以为程序卡住了。录音期间视频会正常播放（有声音），这是唯一能拿到音轨的
   稳妥办法；用户如果本来就是静音，导出的文件也没有声音，界面上会说明。

   纯函数（pickMime / extOf / bitrateFor / fileBase）单独导出，便于 Node 里断言。 */
const ClipExport = (function () {
  let job = null;

  /* 支持的容器：优先 mp4（通用播放器/微信都认），退而求其次 webm */
  const MP4_TYPES = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4'
  ];
  const WEBM_TYPES = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];

  function isSupported() {
    return typeof MediaRecorder !== 'undefined'
      && typeof HTMLCanvasElement !== 'undefined'
      && !!HTMLCanvasElement.prototype.captureStream;
  }

  function pickMime(supported) {
    const can = supported || (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported
      ? (t) => MediaRecorder.isTypeSupported(t)
      : () => false);
    const all = MP4_TYPES.concat(WEBM_TYPES);
    for (let i = 0; i < all.length; i++) {
      try { if (can(all[i])) return all[i]; } catch (e) { /* ignore */ }
    }
    return '';
  }

  function extOf(mime) {
    const m = String(mime || '').toLowerCase();
    if (m.indexOf('mp4') >= 0) return '.mp4';
    if (m.indexOf('webm') >= 0) return '.webm';
    return '.webm';
  }

  /* 码率跟着分辨率走：1080p30 大约 7.5 Mbps，够清楚又不至于把文件撑爆 */
  function bitrateFor(w, h, fps) {
    const px = Math.max(1, (Number(w) || 0) * (Number(h) || 0));
    const f = Math.max(1, Number(fps) || 30);
    return Math.round(Math.min(24000000, Math.max(1200000, px * f * 0.12)));
  }

  /* 文件名：视频名 + 片段区间。Windows 不允许的字符统一换成 - */
  function fileBase(name, t0, t1, fmt) {
    const clean = String(name || '视频')
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .trim() || '视频';
    const base = clean.replace(/\.[a-z0-9]{2,5}$/i, '');
    const f = typeof fmt === 'function' ? fmt : (s) => String(Math.floor(s || 0));
    const tag = f(t0) + '-' + f(t1);
    return base + '-片段-' + tag.replace(/[:：]/g, '');
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function once(target, ev, ms) {
    return new Promise((resolve) => {
      let done = false;
      const fin = () => { if (done) return; done = true; target.removeEventListener(ev, fin); resolve(true); };
      target.addEventListener(ev, fin, { once: true });
      if (ms) setTimeout(() => { if (!done) { done = true; target.removeEventListener(ev, fin); resolve(false); } }, ms);
    });
  }

  function hud(show, text, ratio) {
    const box = document.getElementById('vsExpHud');
    const t = document.getElementById('vsExpText');
    const fill = document.getElementById('vsExpFill');
    if (box) box.hidden = !show;
    if (text && t) t.textContent = text;
    if (fill && typeof ratio === 'number') fill.style.width = Math.max(0, Math.min(100, ratio * 100)).toFixed(1) + '%';
  }

  function isRunning() { return !!job; }

  function cancel() {
    if (!job) return false;
    job.cancelled = true;
    return true;
  }

  /* 导出 t0→t1 这一段。
     opts: { video, t0, t1, name, onProgress(done,total), onNote(msg) }
     返回 { blob, mime, ext, width, height, cancelled } */
  async function recordSegment(opts) {
    const o = opts || {};
    const video = o.video;
    if (!video) throw new Error('找不到视频');
    if (!isSupported()) throw new Error('当前环境不支持录制（MediaRecorder 不可用）');
    const w = video.videoWidth || 0;
    const h = video.videoHeight || 0;
    if (!w || !h) throw new Error('视频还没准备好，等画面出来再导出');

    const t0 = Math.max(0, Number(o.t0) || 0);
    const t1 = Math.max(t0 + 0.1, Number(o.t1) || 0);
    if (t1 - t0 > 15 * 60) throw new Error('片段超过 15 分钟，导出要按原速等这么久，先用剪辑软件切短一点');

    if (job) throw new Error('已经有一个片段在导出');

    const fps = 30;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const draw = () => {
      try { ctx.drawImage(video, 0, 0, w, h); } catch (e) { /* 帧还没就绪，下一帧再画 */ }
    };

    const stream = canvas.captureStream(fps);
    let audioTaken = 0;
    try {
      const src = video.captureStream ? video.captureStream()
        : (video.mozCaptureStream ? video.mozCaptureStream() : null);
      if (src) {
        src.getAudioTracks().forEach((track) => { stream.addTrack(track); audioTaken++; });
      }
    } catch (e) { audioTaken = 0; }

    const mime = pickMime();
    let rec = null;
    try {
      rec = new MediaRecorder(stream, mime
        ? { mimeType: mime, videoBitsPerSecond: bitrateFor(w, h, fps) }
        : { videoBitsPerSecond: bitrateFor(w, h, fps) });
    } catch (e) {
      try { rec = new MediaRecorder(stream); } catch (e2) { throw new Error('无法启动录制：' + (e2.message || e2)); }
    }

    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((resolve) => { rec.onstop = () => resolve(true); });

    const wasTime = video.currentTime || 0;
    const wasPaused = video.paused;

    job = { cancelled: false, startedAt: Date.now() };
    const mine = job;

    try {
      video.pause();
      if (Math.abs(video.currentTime - t0) > 0.05) {
        video.currentTime = t0;
        await once(video, 'seeked', 3000);
      }
      draw();
      rec.start(250);
      /* 播放要在录制启动之后：太早开始，音频轨还没接上，前几帧会没声音 */
      await video.play().catch(() => { /* 自动播放被拦也继续：画面照样能录 */ });

      const total = t1 - t0;
      await new Promise((resolve) => {
        const step = () => {
          if (mine.cancelled) { resolve(); return; }
          draw();
          const cur = video.currentTime || 0;
          const done = Math.max(0, Math.min(total, cur - t0));
          if (o.onProgress) { try { o.onProgress(done, total); } catch (e) { /* ignore */ } }
          if (cur >= t1 - 0.03 || video.ended) { resolve(); return; }
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });

      draw();
      /* 收尾前再补两帧，避免最后一帧被丢掉 */
      await sleep(60);
      try { rec.stop(); } catch (e) { /* ignore */ }
      await Promise.race([stopped, sleep(2500)]);

      const outMime = (rec.mimeType || mime || 'video/webm');
      const blob = new Blob(chunks, { type: outMime });

      /* 恢复现场：位置停在片段终点，播放状态按原样还回去 */
      try { video.pause(); } catch (e) { /* ignore */ }
      try { video.currentTime = Math.min(t1, isFinite(video.duration) ? video.duration : t1); } catch (e) { /* ignore */ }
      if (!wasPaused) { try { await video.play(); } catch (e) { /* ignore */ } }

      const cancelled = !!mine.cancelled;
      if (cancelled && !blob.size) {
        return { blob, mime: outMime, ext: extOf(outMime), width: w, height: h, cancelled: true, silent: !audioTaken };
      }
      if (!blob.size) throw new Error('没有录到画面（视频可能被别的窗口占用或已经结束）');
      if (wasPaused) { try { video.currentTime = wasTime; } catch (e) { /* ignore */ } }
      return {
        blob, mime: outMime, ext: extOf(outMime),
        width: w, height: h, cancelled, silent: !audioTaken
      };
    } finally {
      job = null;
      try { stream.getTracks().forEach((t) => { if (t.stop) t.stop(); }); } catch (e) { /* ignore */ }
    }
  }

  return { isSupported, pickMime, extOf, bitrateFor, fileBase, recordSegment, cancel, isRunning, hud };
})();

try { window.ClipExport = ClipExport; } catch (e) { /* ignore */ }
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ClipExport };
}
