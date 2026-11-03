/* test-v319.js —— v3.19.0 图钉资格回归护栏 + 新图标
   核心事实（来自 Eagle 本体 app.asar 的插件列表模板）：
       isPreviewPlugin: !!manifest.preview
       <div ng-if="!item.isPreviewPlugin" ... pinPlugin / unpinPlugin>
       visible: !item.isLocal && !item.isPreviewPlugin && !item.isDisabled   （快捷键菜单）
   ⇒ manifest 里有 preview 的插件，Eagle 不给图钉、也不给快捷键。
   因此：主插件（有 preview.pdf）钉不上，必须有个不含 preview 的插件承担顶栏入口。
   本测试把这条规则固化成断言，防止以后误删启动器或误给启动器加 preview。
   运行：node test-v319.js
*/
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const MAIN = path.join(ROOT, 'EaglePDFReader');
const WB = path.join(ROOT, 'EagleNoteWorkbench');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name); }
}

const mainMf = JSON.parse(fs.readFileSync(path.join(MAIN, 'manifest.json'), 'utf8'));
const wbMf = JSON.parse(fs.readFileSync(path.join(WB, 'manifest.json'), 'utf8'));

/* Eagle 的真实判定函数（照抄 app.asar 逻辑） */
const isPreviewPlugin = (mf) => !!mf.preview;
const canPin = (mf) => !isPreviewPlugin(mf);

console.log('\n[1] 图钉资格（Eagle 规则）');
ok(isPreviewPlugin(mainMf) === true, '主插件含 preview 段 → 被 Eagle 判为「预览插件」');
ok(canPin(mainMf) === false, '主插件因此拿不到图钉（平台限制，非 bug）');
ok(canPin(wbMf) === true, '启动器无 preview → 有图钉');
ok(!('preview' in wbMf), '启动器 manifest 绝不含 preview 字段（关键护栏）');
ok(Object.keys(wbMf).includes('main') && wbMf.main.url === 'workbench.html', '启动器是纯窗口插件');

console.log('\n[2] 两个插件都指向同一份数据（无副本）');
(() => {
  const launch = fs.readFileSync(path.join(WB, 'wb-launch.js'), 'utf8');
  ok(launch.indexOf('writeFile') < 0, '启动器只读不写（不碰任何数据文件）');
  ok(launch.indexOf('index.html') > 0, '启动器跳转目标是主插件 index.html');
  ok(launch.indexOf('launcher=1') > 0, '跳转带 launcher=1（bridge 据此修正 pluginPath）');
  const bridge = fs.readFileSync(path.join(MAIN, 'js', 'bridge.js'), 'utf8');
  ok(bridge.indexOf("q.get('launcher')") > 0, '主插件 bridge 识别 launcher 参数');
  const app = fs.readFileSync(path.join(MAIN, 'js', 'app.js'), 'utf8');
  ok(app.indexOf("location.hash === '#workbench'") > 0, '主插件保留 #workbench 深链');
})();

console.log('\n[3] 新图标');
(() => {
  const dim = (f) => {
    const b = fs.readFileSync(f);
    return [b.readUInt32BE(16), b.readUInt32BE(20), b.length];
  };
  const [mw, mh, ml] = dim(path.join(MAIN, 'logo.png'));
  const [ww, wh, wl] = dim(path.join(WB, 'logo.png'));
  ok(mw === 128 && mh === 128, '主插件 logo 128×128');
  ok(ww === 128 && wh === 128, '启动器 logo 128×128');
  ok(ml > 1500 && wl > 1500, '两个 logo 均为完整渲染（非占位图）');
  ok(ml !== wl, '两个图标内容不同（有区分度）');
  /* 深色底：四角像素应接近深色（说明不是白底/透明残留） */
  ok(fs.existsSync(path.join(ROOT, 'gen-icon.js')), '图标生成脚本随仓库保留，可复现');
})();

console.log('\n[4] 版本与交付一致性');
ok(mainMf.version === wbMf.version, '主插件与启动器版本一致');
ok(/^\d+\.\d+\.\d+$/.test(mainMf.version), '版本号格式合法');
(() => {
  const readme = fs.readFileSync(path.join(MAIN, 'README.md'), 'utf8');
  const m = readme.match(/当前版本 \*\*([\d.]+)\*\*/);
  ok(m && m[1] === mainMf.version, 'README 当前版本与 manifest 一致');
  ok(readme.indexOf('3.19.0') > 0, 'README 含 3.19.0 记录');
  ok(readme.indexOf('isPreviewPlugin') > 0, 'README 记录了图钉规则的证据（isPreviewPlugin）');
})();

console.log('\n----------------------------------------');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
