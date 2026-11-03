/* test-v317.js —— v3.17.0 伴生插件「笔记工作台」
   覆盖：
   1) wb-launch.js 行为级：findMainPluginDir 在临时目录里按 id 找主插件（含损坏 manifest、
      非目录、无主插件等分支）；redirectIfNeeded 的各状态码；toFileUrl 转义。
   2) 静态：主插件 manifest 3.17.0 与 README 一致；bridge 的 launcher 逻辑；
      app.js 的 #workbench 直达；workbench.html 引用 wb-launch.js 与 launcher=1。
   3) 伴生 manifest 结构（独立 id、multiple:false、入口 workbench.html）。
   运行：node test-v317.js   （全部通过退出码 0） */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const MAIN = path.join(ROOT, 'EaglePDFReader');
const WB = path.join(ROOT, 'EagleNoteWorkbench');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name); }
}

/* ---------- 载入启动器（node 下 globalThis） ---------- */
const L = require(path.join(WB, 'wb-launch.js'));

console.log('\n[1] wb-launch 纯函数');
ok(L.MAIN_ID === 'LB7PDFRDK3QM', 'MAIN_ID 指向主插件 id');
ok(L.LAUNCH_HASH === '#workbench', 'LAUNCH_HASH 为 #workbench');

(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb317-'));
  const mk = (name, files) => {
    const d = path.join(tmp, name);
    fs.mkdirSync(d, { recursive: true });
    for (const [f, c] of Object.entries(files || {})) fs.writeFileSync(path.join(d, f), c);
    return d;
  };
  const mainDir = mk('LB7PDFRDK3QM', { 'manifest.json': JSON.stringify({ id: 'LB7PDFRDK3QM', version: '3.17.0' }) });
  mk('ai-eraser', { 'manifest.json': JSON.stringify({ id: 'AI-ERASER' }) });
  mk('broken', { 'manifest.json': '{oops' });
  mk('nofile', {});
  fs.writeFileSync(path.join(tmp, 'loose.txt'), 'x');

  ok(L.findMainPluginDir(fs, path, path.join(tmp, 'ai-eraser'), 'LB7PDFRDK3QM') === mainDir,
    '兄弟目录按 id 找到主插件');
  ok(L.findMainPluginDir(fs, path, path.join(tmp, 'ai-eraser'), 'NOPE') === null, '无主插件返回 null');
  ok(L.findMainPluginDir(fs, path, path.join(tmp, 'ai-eraser'), '') === null, '空 id 返回 null');
  ok(L.findMainPluginDir(null, path, path.join(tmp, 'ai-eraser'), 'LB7PDFRDK3QM') === null, '无 fs 返回 null');
  ok(L.findMainPluginDir(fs, path, path.join(tmp, '不存在的目录'), 'LB7PDFRDK3QM') === null, 'startDir 不存在返回 null');
  fs.rmSync(tmp, { recursive: true, force: true });
})();

(() => {
  const u = L.toFileUrl('C:\\Users\\gougo\\AppData\\Roaming\\Eagle\\Plugins\\LB7PDFRDK3QM');
  ok(u === 'file:///C:/Users/gougo/AppData/Roaming/Eagle/Plugins/LB7PDFRDK3QM/',
    'toFileUrl Windows 路径 → file:/// URL');
  const u2 = L.toFileUrl('C:\\tmp\\中文名 插件#1?q');
  ok(u2.indexOf('%23') > 0 && u2.indexOf('%3F') > 0 && u2.indexOf('%E4%B8%AD') > 0,
    'toFileUrl 转义 # ? 与中文');
  ok(L.toFileUrl(null) === null && L.toFileUrl('relative/path') === null, '非法输入返回 null');
})();

console.log('\n[2] tryResolve 多策略');
(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb317b-'));
  const mainDir = path.join(tmp, 'LB7PDFRDK3QM');
  fs.mkdirSync(mainDir, { recursive: true });
  fs.writeFileSync(path.join(mainDir, 'manifest.json'), JSON.stringify({ id: 'LB7PDFRDK3QM' }));
  const selfDir = path.join(tmp, 'LB7NOTEWB01');
  fs.mkdirSync(selfDir, { recursive: true });
  const M = { fs: fs, path: path };

  /* 策略1：Eagle API 的 plugin.path（模拟非 file:// 页面 URL 场景） */
  let r = L.tryResolve({
    mods: M,
    eagle: { plugin: { path: selfDir }, app: { getPath: () => tmp } },
    locationHref: 'http://127.0.0.1:9222/LB7NOTEWB01/workbench.html'
  });
  ok(r.status === 'ok' && r.mainDir === mainDir, 'eagle.plugin.path 策略命中');

  /* 策略3：只有 userData 可用（eagle.plugin 没给 path）；主插件须在 <userData>/Plugins 下 */
  const ud = path.join(tmp, 'Plugins');
  fs.mkdirSync(ud, { recursive: true });
  fs.renameSync(mainDir, path.join(ud, 'LB7PDFRDK3QM'));
  r = L.tryResolve({
    mods: M,
    eagle: { app: { getPath: () => tmp } },
    locationHref: 'eagle-plugin://whatever/workbench.html'
  });
  ok(r.status === 'ok' && r.mainDir === path.join(ud, 'LB7PDFRDK3QM'), 'userData/Plugins 扫描根命中');

  /* 什么都没有 → not-found 且带诊断信息 */
  r = L.tryResolve({ mods: M, eagle: null, locationHref: null });
  ok(r.status === 'not-found' && Array.isArray(r.roots), '无任何线索 → not-found 带诊断');

  /* 非 file: URL 不反推目录 */
  ok(L.dirOfUrl('http://localhost/x/y.html') === null, 'dirOfUrl 忽略非 file: 协议');
  ok(L.dirOfUrl('file:///C:/a/b/c.html') === 'C:/a/b', 'dirOfUrl 正常解析 file: URL');

  /* 同步 redirectIfNeeded 兼容层 */
  delete globalThis.location;
  ok(L.redirectIfNeeded({ mods: M, eagle: null, locationHref: null }) === 'not-found',
    '无线索 → not-found（多策略下不再有 no-dir）');
  ok(L.redirectIfNeeded({ mods: null }) === 'no-node', '无 Node → no-node');

  fs.rmSync(tmp, { recursive: true, force: true });
})();

console.log('\n[3] 主插件侧改造');
(() => {
  const bridge = fs.readFileSync(path.join(MAIN, 'js', 'bridge.js'), 'utf8');
  ok(/launcher:\s*q\.get\('launcher'\)\s*===\s*'1'/.test(bridge), 'parseQuery 解析 launcher=1');
  ok(/launcher=1：跳转前的窗口注册信息属于启动器/.test(bridge) &&
     /state\.query\.launcher \? null/.test(bridge), 'launcher 模式跳过 created.path 作为 pluginPath');
  ok(/launcher=1：pluginPath 是靠 location\.href 兜出来的主插件目录/.test(bridge) &&
     /state\.query\.launcher && state\.pluginPath/.test(bridge), 'launcher 模式补读主插件真实 manifest');
  const app = fs.readFileSync(path.join(MAIN, 'js', 'app.js'), 'utf8');
  ok(/location\.hash === '#workbench'/.test(app) && /Workbench\.open\(true\)/.test(app),
    'boot 后 #workbench 直达工作台');
  const mf = JSON.parse(fs.readFileSync(path.join(MAIN, 'manifest.json'), 'utf8'));
  ok(/^\d+\.\d+\.\d+$/.test(mf.version), '主插件 manifest 版本格式合法');
  const readme = fs.readFileSync(path.join(MAIN, 'README.md'), 'utf8');
  ok(readMeVer(readme) === mf.version, 'README 当前版本与 manifest 一致');
  ok(readme.indexOf('3.17.0') > 0 && readme.indexOf('笔记工作台') > 0, 'README 含 3.17.0 更新记录');
  function readMeVer(t) { const m = t.match(/当前版本 \*\*([\d.]+)\*\*/); return m ? m[1] : '?'; }
})();

console.log('\n[4] 伴生插件结构');
(() => {
  const mf = JSON.parse(fs.readFileSync(path.join(WB, 'manifest.json'), 'utf8'));
  ok(mf.id === 'LB7NOTEWB01' && mf.id !== 'LB7PDFRDK3QM', '独立插件 id，不与主插件冲突');
  const mainMfV = JSON.parse(fs.readFileSync(path.join(MAIN, 'manifest.json'), 'utf8')).version;
  ok(mf.version === mainMfV, '伴生插件版本与主插件同步');
  ok(mf.main && mf.main.url === 'workbench.html', '入口为 workbench.html');
  ok(mf.main.multiple === false, 'multiple:false —— 重复点击聚焦已有窗口');
  ok(mf.main.backgroundColor === '#18191c', '窗口底色与主插件一致（无白闪）');
  ok(fs.existsSync(path.join(WB, 'logo.png')) && fs.statSync(path.join(WB, 'logo.png')).size > 200,
    'logo.png 存在');
  const html = fs.readFileSync(path.join(WB, 'workbench.html'), 'utf8');
  ok(html.indexOf('wb-launch.js') > 0, 'workbench.html 引用 wb-launch.js');
  ok(html.indexOf('WbLaunch.autoLaunch') > 0, '页面调用 autoLaunch（带重试）');
  ok(html.indexOf('not-found') > 0 && html.indexOf('重试') > 0, '主插件缺失时有提示与重试');
  ok(html.indexOf('launcher=1') === -1, 'launcher=1 由 wb-launch 统一拼接（页面不重复写）');
})();

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
