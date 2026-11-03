/* 闪灵面板 · 启动器（v3.17.1）
   这个插件只有一个职责：找到「闪灵笔记」主插件，带 ?launcher=1#workbench 跳过去。
   数据全在 <userData>/Plugins/EagleNoteManager/data/（固定路径），跳转后由主插件接管，
   启动器自身零状态、不读写任何数据 —— 主插件升级 / 重装都不用动这里。

   v3.17.1：定位改多策略。实测 Eagle 加载插件页的 URL 未必是 file:// 形式，
   光靠 location.href 反推目录会失手（表现为「没找到主插件」）。按可靠度依次试：
     1) Eagle API：window.eagle.plugin.path（Eagle 告诉我们插件真实安装目录）
     2) location.href 反推（file:// 时可用）
     3) Eagle API：app.getPath('userData') → <userData>/Plugins 直接当扫描根目录
   插件注册（plugin-create）可能在页面跑起来之后才到，所以整套带短暂重试。 */
(function (global) {
  'use strict';

  /* 主插件 manifest.json 里的 id —— Eagle 安装目录里文件夹也叫这个名字 */
  var MAIN_ID = 'LB7PDFRDK3QM';
  var LAUNCH_HASH = '#workbench';

  function hasNode() { return typeof require === 'function'; }
  function mods() {
    try { return { fs: require('fs'), path: require('path') }; } catch (e) { return null; }
  }

  function eagleApi() {
    try {
      var e = global.eagle;
      return (e && e.item && e.library) ? e : null;
    } catch (e) { return null; }
  }

  /* file:// 链接 → 本地目录（不带结尾分隔符）。非 file: 或解析失败返回 null。 */
  function dirOfUrl(href) {
    try {
      if (!href || href.indexOf('file:') !== 0) return null;
      var u = new URL('.', href);
      return decodeURIComponent(u.pathname).replace(/^\/([A-Za-z]:)/, '$1')
        .replace(/[\\/]+$/, '');
    } catch (e) { return null; }
  }

  /* 本地目录 → file:// 链接。中文名、空格靠 encodeURI，# ? 手动转义。 */
  function toFileUrl(p) {
    if (!p) return null;
    var u = String(p).replace(/\\/g, '/');
    if (/^[A-Za-z]:/.test(u)) u = '/' + u;
    if (!/^\/[A-Za-z]:\//.test(u)) return null;
    if (!/\/$/.test(u)) u += '/';
    return 'file://' + encodeURI(u).replace(/#/g, '%23').replace(/\?/g, '%3F');
  }

  /* 在 rootDir 的直接子目录里找 manifest.json 的 id === mainId 的插件目录。
     返回目录绝对路径，找不到返回 null。
     manifest 损坏 / 非目录 / 无权限一律跳过，不抛错。excludeDir 用于排除自己。 */
  function scanForMain(fs, path, rootDir, mainId, excludeDir) {
    if (!fs || !path || !rootDir || !mainId) return null;
    var names;
    try { names = fs.readdirSync(rootDir); } catch (e) { return null; }
    names.sort();
    for (var i = 0; i < names.length; i++) {
      var dir = path.join(rootDir, names[i]);
      if (excludeDir && dir === excludeDir) continue;
      var raw;
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
        raw = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');
      } catch (e) { continue; }
      try {
        var manifest = JSON.parse(raw);
        if (manifest && manifest.id === mainId) return dir;
      } catch (e) { continue; }
    }
    return null;
  }

  /* 兼容旧签名：给自身目录，扫它的同级（父目录的孩子们） */
  function findMainPluginDir(fs, path, startDir, mainId) {
    if (!fs || !path || !startDir || !mainId) return null;
    try { if (!fs.statSync(startDir).isDirectory()) return null; } catch (e) { return null; }
    return scanForMain(fs, path, path.dirname(startDir), mainId, startDir);
  }

  /* 一次解析尝试。返回：
     { status:'ok', mainDir } 或 { status:'not-found', self, roots:[...] } 或 { status:'no-node' }
     self / roots 用于页面诊断展示。env 可注入 eagle / locationHref / mods / fs / path 便于测试。 */
  function tryResolve(env) {
    env = env || {};
    var m = env.mods !== undefined ? env.mods : (hasNode() ? mods() : null);
    if (!m) return { status: 'no-node' };

    var eagle = env.eagle !== undefined ? env.eagle : eagleApi();
    var href = env.locationHref !== undefined ? env.locationHref
      : (global.location && global.location.href) || null;

    /* 候选扫描根：自身所在目录的父目录、<userData>/Plugins */
    var roots = [];
    var self = env.selfDir || null;
    if (!self && eagle && eagle.plugin) {
      try { if (eagle.plugin.path) self = eagle.plugin.path; } catch (e) { /* ignore */ }
    }
    if (!self) self = dirOfUrl(href);

    if (self) {
      try { if (m.fs.statSync(self).isDirectory()) roots.push(m.path.dirname(self)); } catch (e) { /* ignore */ }
    }
    if (eagle && eagle.app && eagle.app.getPath) {
      try {
        var ud = eagle.app.getPath('userData');
        if (ud) roots.push(m.path.join(ud, 'Plugins'));
      } catch (e) { /* ignore */ }
    }

    for (var i = 0; i < roots.length; i++) {
      var hit = scanForMain(m.fs, m.path, roots[i], env.mainId || MAIN_ID, self);
      if (hit) return { status: 'ok', mainDir: hit, self: self, roots: roots };
    }
    return { status: 'not-found', self: self, roots: roots, href: href };
  }

  /* 同步执行跳转（旧行为保留）。状态码：ok / no-node / not-found / bad-url */
  function redirectIfNeeded(env) {
    var r = tryResolve(env);
    if (r.status !== 'ok') return r.status;
    var url = toFileUrl(r.mainDir);
    if (!url) return 'bad-url';
    if (!env || env.go !== false) {
      global.location.replace(url + 'index.html?launcher=1' + LAUNCH_HASH);
    }
    return 'ok';
  }

  /* 异步自动启动：plugin-create 可能晚于页面就绪，带几次重试（总窗口约 3.5s）。
     onAttempt(attempt, result) 每次尝试后回调，页面可拿来做诊断展示。 */
  function autoLaunch(env, onAttempt) {
    env = env || {};
    var delays = [0, 300, 600, 1200, 1400];
    var i = 0;
    return new Promise(function (resolve) {
      function step() {
        var r = tryResolve(env);
        if (onAttempt) { try { onAttempt(i, r); } catch (e) { /* ignore */ } }
        if (r.status === 'ok') {
          var url = toFileUrl(r.mainDir);
          if (url) {
            if (env.go !== false) global.location.replace(url + 'index.html?launcher=1' + LAUNCH_HASH);
            resolve({ status: 'ok', mainDir: r.mainDir });
            return;
          }
          resolve({ status: 'bad-url', diag: r });
          return;
        }
        if (r.status === 'no-node') { resolve({ status: 'no-node', diag: r }); return; }
        i++;
        if (i >= delays.length) { resolve({ status: 'not-found', diag: r }); return; }
        setTimeout(step, delays[i]);
      }
      step();
    });
  }

  var api = { MAIN_ID: MAIN_ID, LAUNCH_HASH: LAUNCH_HASH, dirOfUrl: dirOfUrl,
              toFileUrl: toFileUrl, scanForMain: scanForMain,
              findMainPluginDir: findMainPluginDir, tryResolve: tryResolve,
              redirectIfNeeded: redirectIfNeeded, autoLaunch: autoLaunch };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.WbLaunch = api;
})(typeof window !== 'undefined' ? window : globalThis);
