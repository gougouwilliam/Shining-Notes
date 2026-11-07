# 闪灵笔记 · 插件

在 Eagle 内完成 PDF 的**阅览 → 摘录 → 笔记 → 回流资源库**闭环，并提供跨文档的「知识库」、带时钟与每日笔记的统计「工作台」、30 天回收站与划词翻译。
3.3.0 起，摘录的高亮会**同步写进 PDF 文件本身**（换了阅读器也还在），顶栏是**常驻的全文搜索框**，并新增**视频笔记**。
零外部依赖，全部资源（PDF.js、pdf-lib、CJK 字符映射、标准字体）随插件本地打包，**除划词翻译外不联网**。

当前版本 **4.5.0**。

---

## 更新记录 · 4.5.0（Obsidian：绝对同步 / 精确双链 / 排版重做）

> 需求复述：① 插件里摘录或笔记的**增、删、改**在 OB 端绝对同步，OB 端只做阅读与文字修改；② 在 OB 点双链要**直接落到对应那条笔记**，而不是只打开插件笔记所在的整篇 md；③ OB 里的浏览排版美化、层次清晰。

### ① 绝对同步：结构归插件，文字归 OB

先查清旧实现的四个真实缺口：

- 打字防抖 **2.6s**、回读轮询 **15s** —— 插件改了要等好几秒 OB 才看得见；
- `writeNow()` 用**全文 hash** 判重，而 frontmatter 的 `updated` / `rev` 每次都变 → 判重永远不命中，**每次保存都重写整篇 md**；
- 空闲回读 `syncExternal()` 走的是 `writeNow()`，也就是「回读顺手把文件重新生成一遍」。轮询一旦加密，用户在 OB 里正打着字会被外部刷新打断，甚至丢字符；
- 退出时打字防抖里还压着的那次投影没有强制 flush，会留「差一次同步」的尾巴。

改造：

| 环节 | v4.4.9 | v4.5.0 |
|---|---|---|
| 插件 → OB 落盘 | 2.6s 防抖 | **0.7s** 防抖；明确保存 / 退出立即写 |
| OB → 插件回读 | 15s，且会重写文件 | **3s，只吸收不重写** |
| 判重依据 | 全文 hash（永远判不重） | **正文指纹 `bodyKey`**，正文没变一个字节都不碰 |
| 启动 / 退出 | 无全量对账 | 启动 3s 单次 `rebuildAll(false)`；退出 / `beforeunload` / `pagehide` 三处 `flush()` |
| 可观测性 | 无 | frontmatter `synced:` + `debug.log` 的 `proj.write` / `proj.absorb` / `proj.rebuild` |

`syncExternal()` 现在只做三件事：读回 OB 的文字改动 → 经 `onExternal` 合并进权威 JSON → 把 manifest 认领到「磁盘当前这一版」（`rec.hash` / `rec.items` / `rec.at`）。**不重写文件**。等插件里真的发生增删改时，`writeNow()` 再拿已合并的 data 重新生成整篇，用户的手改自然一起带过去。冲突策略不变：MD 为准、被覆盖的旧值落 `.conflict`。

### ② 精确双链：从「跳到文件」改成「跳到那一条」

根因来自现场 md：插件把**摘录下的批注**和**独立笔记**混在一起列进 `[[` 候选，但投影只给独立笔记写了 `#### <第一行>` 标题头。于是 `[[C7动脉瘤夹闭…#测试一下框选下的笔记功能]]` 这类链接指向的是摘录批注，OB 里根本没有同名标题 —— 只能退化为打开文件。标题重名、标题里含 `#` / `[[ ]]`、后来改了标题，也都会让链接失效。

改造：**每条摘录 / 每条笔记都挂一个 OB 原生稳定块 ID**（`^eaglenote-ex-<条目id>` / `^eaglenote-nt-<条目id>`，写在该条自己的标题行末），候选插入改成 `[[书名#^块ID|可读别名]]`：

- OB 点击精确滚到那一条并高亮，不再是「打开整篇 md」；
- 块 ID 只由条目 id 生成，**改标题、两条笔记同名、标题里带特殊字符都不影响**；
- 插件里点这类链接时，`Projection.titleByAnchor()` 把块 ID 翻回笔记标题，再走原来的 `locateNoteByTitle()`；
- 旧的 `[[书#标题]]` 全部照常解析、照常跳转，独立笔记的 `#### 原始第一行` 标题头保留；
- 反链 / 出链对账走 `bookOf()`，块链接仍只按书名段匹配，不受影响。

### ③ OB 排版

顶部说明收成 `> [!info]-` 折叠框；`## 摘录 · N 条` / `## 笔记 · N 条` 带计数并用 `---` 分区；每条统一「编号 + 页码/时间点 + 类型·颜色」标题；原文与批注分别用 `> [!quote]-` / `> [!note]` callout；图片加 `|420` 宽度（不认该语法的编辑器退化为普通图片，**绝不裂链**）；笔记正文里的 `#` / `##` 转义成 `\#` 普通文本，不再把 AI 总结的伪标题塞进 OB 大纲 —— 这个变换是**无损可逆**的，用户在 OB 里删掉反斜杠也恰好读回原文。frontmatter 新增 `synced:`（最后落盘时间）。「Eagle 注释」节明确标注为回写通道，文件末尾的「手记」区仍完全由用户支配、插件绝不覆盖。

**兼容性**：回读层同时认 v4.4 旧格式（`**笔记**` / `### head` + `#### title`）与 v4.5 新格式，磁盘上存量 md 升级时手改内容一字不丢；首次启动的全量对账会把旧排版迁移成带块锚点的新版。

**实测判据**：重启 Eagle（插件不热更新）→ 打开一篇有多条摘录的文档 → `debug.log` 应出现 `proj.rebuild`、保存时出现 `proj.write`；OB 里篇 md 应看到编号标题与折叠 callout；用 `[[` 引用一条「摘录下的批注」后到 OB 点击，应直接滚到那条批注。

**回归**：新增 `test-v450.js`（61 项，vm 加载完整模块 + 真实临时文件系统，覆盖增/改/删、只吸收不重写、块 ID 唯一性与稳定性、新旧格式往返、零窗口 API 红线）；同步放宽 10 个历史套件里因排版/链路升级而过时的静态断言。**全量 56 套件全绿**，`verify-features` ✅84 🟡33 ❌0。

---

## 更新记录 · 4.4.9（快捷键隔离加固：确认送达 + 生命周期自愈）

> 需求复述：**打开插件就关掉 Eagle 自己的快捷键**（怕和插件冲突）、**关闭插件立刻恢复**、**开着插件直接关 Eagle、再开 Eagle 时也要恢复**。
> 这套机制 4.4.6 已经上线（现场日志里每次打开是 `shortcuts.set {ignored:false}` → `{ignored:true}`，退出是 `{ignored:false}`），本次不是重做，而是把「发出就算」改成「确认送达 + 三重兜底」。

- **① 回执与补发**（`bridge.js`）：`setHostShortcuts()` 现在每次调用写 `shortcuts.set`（发出）、`shortcuts.ok`（IPC 无异常落地）、`shortcuts.err`（带错误文本），失败自动补发一次并写 `shortcuts.retry`。新增 `shortcutsSettled(ms)` 提供可 `await` 的送达点，**带超时**——宁可少等，绝不让一次失联的 IPC 卡住启动或退出。同步返回 `true` 的旧契约不变（含义是「已发出」）。Eagle 没有公开的 `isIgnoringMenuShortcuts` getter，所以 `ok` 表示送达成功，不是状态读回。
- **② 启动串行**：`app.js` 的「快捷键隔离」步骤改成 `发 false → await 落地 → 发 true`。以前两条 IPC 连续盲发，理论上存在先发的 `false` 晚到、把刚设的 `true` 覆盖回去的乱序风险；先发 `false` 仍承担「自愈上次残留」的职责。
- **③ 退出不再抢跑**：`exitPlugin()` 预览分支改成 `发 false → await 落地（最多 200ms）→ 显式下线宿主 ESC 桥 → 才发 Exit`。以前恢复与 `hostExit()` 并发，webview 一卸载那条 IPC 就可能被吞掉。
- **④ 宿主看门狗（本次关键，解决第③个场景）**：`setIgnoreMenuShortcuts` 是 **webContents 运行时状态、不写盘**，Eagle 进程真重启必然复位；但如果用户「关窗口到托盘」、主窗口 webContents 还活着，而 guest 的 `beforeunload` / `pagehide` 又没来得及发 `false`，`true` 就会残留，Eagle 快捷键全部失灵。现在注入主窗口的 ESC 桥兼任看门狗：每秒检查插件 `<webview>` 是否还在，一旦消失就由**主窗口自己**经 `plugin.window.webContents.` 补发 `false`；结果写在 `window.__eaglenoteShortcutRestore` 便于排查。三档 `remove()` 避免误伤：
  - `remove(0)` 新桥覆盖旧桥 —— 只摘监听，绝不恢复（新插件马上要设 `true`）；
  - `remove(1)` 看门狗 / 按键时发现 webview 消失 —— 先确认没有其它插件 webview 才恢复，**切条目时不冲掉新 guest 刚设的 `true`**；
  - `remove(2)` 插件主动退出、显式下线 —— 无条件恢复（此时 webview 可能还没被卸载）。
  - 主窗口若没暴露 `ipcRenderer` 就静默降级，`no-ipc` 标记可查；guest 侧三条恢复与「重启复位 + 启动自愈」仍是独立的两重保障。
- **零窗口 API 红线不变**：所有新增通道都只走 `webContents` IPC / 主窗口 DOM 层，`IPC_WINDOW_DENY` 硬拦截照旧，ESC 仍无条件吞掉、绝不交还宿主，退出前落盘不变。
- **快捷键冲突面说明**：`setIgnoreMenuShortcuts(true)` 屏蔽的是 **Eagle 应用菜单的加速器**（Ctrl+N / Ctrl+F / ESC 等），这正是与插件冲突的那一层；插件 `<webview>` 有焦点时，主窗口的普通 `keydown` 本就不会收到按键。Eagle 给独立插件窗口挂的 `app/js/utils/ignoreMenuShortcuts.js` 只作用于那个独立窗口自己的 webContents，不会反过来覆盖主窗口的设置。
- **版本与验证**：双 manifest 4.4.9；新增 `test-v449.js`（vm 真跑注入脚本，覆盖回执/重试/超时、启动与退出顺序、看门狗 6 个场景、零窗口 API），全量 55 套件全绿，`verify-features` ❌0。`debug.log` 判据：打开插件应看到 `shortcuts.set` → `shortcuts.ok` 各两次（先 false 后 true），退出应看到 `shortcuts.restore {phase:"exit"}`；若出现 `shortcuts.err` / `shortcuts.retry` 说明 IPC 曾失联但已补发。`hostesc.install.ok {result:"installed:ipc"}` 表示主窗口看门狗确实可用；`installed:no-ipc` 表示主窗口没暴露 `ipcRenderer`，看门狗降级，此时由 guest 侧三条恢复与「重启复位 + 启动自愈」兜底。另可在 Eagle 主窗口控制台读 `window.__eaglenoteShortcutRestore` 查看门狗最后一次结果。

---

## 更新记录 · 4.4.8（修复「必须点一次插件界面，ESC 才能退出」）

> 关窗红线不变：绝不通过 `plugin.window.` / `@electron/remote` 对窗口对象执行 close / destroy / hide / minimize 等生命周期方法；ESC 绝不交还宿主；4.4.7 的宿主 Exit 通道原样保留。

- **现场现象**：4.4.7 部署后，用户反馈「必须要点一次插件的界面，才能用 ESC 退出；用插件直接打开，按 ESC 还是没反应」。`debug.log` 14:18~14:19 给出决定性证据：凡是退出成功的那几次，都是
  `exit.hostclose {sent:true}` → `exit.host {via:"executeJavaScript"}` → `exit.host.ok {result:"eaglenote-exit-ok"}`；而「直接打开就按 ESC」的情形 guest 里**一行日志都没有** —— 不是退出失败，是按键根本没送到插件。
- **根因：焦点，不是关窗**。预览页是 Eagle 主窗口 `<webview>` 的 guest。刚打开时键盘焦点仍留在主窗口，ESC 不会派给 guest；而插件启动时的 `setIgnoreMenuShortcuts(true)` 又把宿主菜单快捷键屏蔽了，于是这一下 ESC **两边都没人处理**。点一下界面会触发 `pointerdown` 里的 `window.focus()`，焦点落进 guest，ESC 才立刻生效。此前 4.4.4~4.4.6 把它归因于 sticky activation / 关窗通道，都是误判。
- **修复① 接管焦点**（`bridge.js` `focusGuest()` + `app.js`）：通过主窗口 `webContents.executeJavaScript`，让宿主对自己的 `<webview>` 调 `focus()`；按 `window.windowID`（Eagle 在 dom-ready 注入的 `webview.getWebContentsId()`）精确匹配，拿不到时按插件目录 URL 兜底。`Bridge.ready()` 之后分 **0 / 150 / 450 / 1000 / 2000ms** 五次重试，覆盖 webview 创建、主窗口抢回焦点、首屏渲染完再抢一次。每次把宿主返回值与 guest 的 `hasFocus()` 写进 `focus.host.ok` / `focus.self`。
- **修复② 宿主 ESC 转发桥**（`bridge.js` `installHostEscBridge()` / `initHostEscReceiver()`）：焦点万一仍在主窗口，主窗口 document 捕获 ESC 后不再让宿主自己处理，而是 `webview.send('eaglenote:esc')` 转给 guest；guest 把它转成**合成 keydown** 派给 window，于是照旧命中 `app.js` 的捕获监听 → `escguard` 分级 → `exitPlugin()` 的**落盘 / 恢复快捷键 / 宿主 Exit**。绝不直接 `postMessage('Exit')` 绕过落盘，也绝不把 ESC 交还宿主。
  - 桥在 **boot 同步段**就挂上（不等 `Bridge.ready()` 的异步等待），`ready` 后用精确 id 幂等重挂；焦点已在 guest 时不转发（避免双触发）；webview 被卸载后下一次按键自动摘除监听且**不拦截事件**；`beforeunload` / `pagehide` 显式卸载。
  - 两条修复都只走 `plugin.window.webContents.` 的 `executeJavaScript`（主窗口 DOM 层），一个 `BrowserWindow` 方法都没碰。
- **诊断**：`hostesc.install.ok/err`、`focus.host.ok/err`、`focus.self`、`hostesc.recv`、`esc.key {src:"real"|"host", hasFocus}` 写进 `debug.log`，现场一眼可判按键是真实进 guest 还是走转发桥。
- **实测判据**：重启 Eagle（让新插件生效）后，**打开文档不点任何地方直接按 ESC**，预览应正常收起、Eagle 主窗口完好。理想日志为 `hostesc.install.ok {result:"installed"}` → `focus.host.ok {result:"focused:true"}` → `esc.key {src:"real"}`（或焦点没进来时 `hostesc.recv` + `esc.key {src:"host"}`）→ `exit.hostclose {sent:true}` → `exit.host.ok {result:"eaglenote-exit-ok"}`。若仍无反应，先看有没有 `esc.key`：没有说明焦点与桥都没到位，再查 `hostesc.install.err`。

---

## 更新记录 · 4.4.7（修复「无论是否操作，ESC 都退不出插件」）

> **⚠️ 4.4.3 / 4.4.4 / 4.4.5 的关窗结论、4.4.6 的 Exit 送达方式均已作废**，保留在下面仅作事故审计轨迹。**关窗红线不变：绝不通过 `plugin.window.` / `@electron/remote` 对窗口对象执行 close / destroy / hide / minimize 等生命周期方法。**

- **现场现象**：4.4.6 部署后用户反馈「打开插件，无论是否操作，ESC 都没作用」。`debug.log` 14:02 / 14:03 给出决定性证据：
  - `exit.host {"sent":0,"targets":0}` —— `hostExit()` 试图给 `window.parent` / `top` / `opener` 发 `Exit`，但**一个目标都没有**。
  - `exit.hostclose {"sent":false}` → `exit.rendererclose {}`（600ms 兜底执行）→ `exit.stillalive {"sent":false}` —— 页面仍在，两条出口全断。
- **根因**：预览页是 Eagle 主窗口 `<webview>` 的 **guest 顶层 browsing context**，不是 iframe。`window.parent === window.top === window`、`opener` 为 null，所以 `parent.postMessage('Exit','*')` 天生发不到宿主（Eagle 里用 `parent.postMessage` 的两个 viewer 都是 iframe 形态，有 `window.frameElement`）。另外，Chromium 只允许脚本关闭「由脚本自己打开」的窗口，guest 里的 `window.close()` 是**空操作**——这正是 v4.4.6 600ms 兜底无效的原因。
- **修复：换成真正可达的宿主通道**（`bridge.js`）：
  - 主进程 `ipcMain.handle('plugin.window.webContents.', …)`（`app.asar @22653580`）用 `BrowserWindow.fromWebContents(event.sender).webContents` 取到的正是 **Eagle 主窗口 webContents**。
  - 新增 `hostRendererEval()`，走该通道调 `executeJavaScript`，让**主窗口自己**执行 `window.postMessage('Exit','*')`；主窗口 `@1644768` 的官方监听器 `e.data === "Exit"` → `$scope.leaveDetailMode()` 卸载 webview。
  - 全程零 `BrowserWindow` 方法、不碰窗口生命周期，**也不依赖菜单快捷键**——所以用户要求的「插件期间屏蔽 Eagle 快捷键」可以照常开启，与退出互不干扰。
  - 执行代码带 `'eaglenote-exit-ok'` 返回值哨兵：成功会写 `exit.host.ok {result:"eaglenote-exit-ok"}`（证明代码真在主窗口跑过），失败写 `exit.host.err`；`exit.host` 行还会记 `via: "executeJavaScript" / targets: 0`，现场一眼可判通道。
  - 独立窗口 / iframe 形态仍优先用 `parent.postMessage`（快速路径），且不与新通道并发。
- **退出分支**（`app.js`）：落盘 → 摘 `beforeunload` → 恢复 Eagle 快捷键 → 一条 Exit → 600ms 仍活才**串行补发一条**（幂等，防 IPC 丢包）→ 1200ms 才提示。删掉已被证伪的渲染层自关兜底；连按防抖、ESC 分级策略、零窗口 API 全部不变。
- 更正 `winguard.js` / `escguard.js` 头部注释，避免把「parent.postMessage 可达」当成事实继续误导。
- **实测判据**：重启 Eagle 后打开文档、点一下、按 ESC，理想日志为 `exit.hostclose {sent:true}` → `exit.host {via:"executeJavaScript"}` → `exit.host.ok {result:"eaglenote-exit-ok"}`，随后预览正常收起、Eagle 主窗口完好。若仍停留，看 `exit.host.err` 与 `exit.stillalive` 即可区分 IPC 失败与宿主未响应。

---

## 更新记录 · 4.4.6（止血：不再销毁 Eagle 主窗口；插件期间独占快捷键）

> **⚠️ 4.4.3 / 4.4.4 / 4.4.5 三版的关窗结论全部作废**，保留在下面仅作事故审计轨迹，勿再照抄。

- **事故现象**：用户实测「不操作还能退；操作了要么连 Eagle 一起退出、要么没反应」，最后变成「最小化的 Eagle 双击都打不开」。`Eagle/app.asar` 与现场日志给出决定性证据：
  - 插件预览页**跑在 Eagle 主窗口的 `<webview>` 里**（`app.asar` 注入的是 `window.windowID = webview.getWebContentsId()`，`parentID` 才是主窗口）。`openPreview` 那条 `new BrowserWindow` 路径属于别的预览器，v4.4.3 把它当成本插件路径，是根本误判。
  - 因此主进程 `BrowserWindow.fromWebContents(event.sender)` 返回的是 **Eagle 主窗口**。`debug.log` 的 `[env] {"bw":"max"}` 正是主窗口最大化（与 `window-state.json` 的 `isMaximized:true` 吻合），不是「预览窗口最大化」。
  - v4.4.4 发 `bw.close()`、v4.4.5 发 `bw.destroy()`，关掉/销毁的都是主窗口：`log.log` 08:44:53 起连续 `TypeError: Object has been destroyed at MenuItem.click`，正是用户双击托盘打不开的那几次。
- **修复① 红线**（`bridge.js`）：`IPC_WINDOW_DENY` 在 `ipcWindow()` 入口硬拦截 `close / destroy / hide / minimize / maximize / unmaximize / show / showInactive / focus / restore / setFullScreen / setAlwaysOnTop`，只读探测（`isMaximized` 等）仍放行。`closeSelf` / `destroySelf` / `closeCurrent` / `closeWindow` 四条历史关窗通道全部退役（恒返回 false，零窗口 API）；`framewin.js` 的四层关窗兜底也清空，✕ 与 Ctrl+W 统一走 `App.exit()`。
- **修复② 退出改用宿主官方通道**：`Bridge.hostExit()` 发 `parent.postMessage('Exit','*')` —— Eagle 主窗口监听 `message === "Exit"` → `leaveDetailMode()` 卸载 webview，主窗口无任何生命周期变化。`exitPlugin()` 预览分支 = 落盘 → 摘 `beforeunload` → **恢复 Eagle 快捷键** → 发一条 Exit → 600ms 仍活才用 `window.close()` 关掉当前 renderer（不经主进程）→ 1200ms 才提示。绝不并发关窗请求，不依赖 `window.closed`。
- **修复③ 快捷键隔离（本次需求）**：
  - **插件打开后** → `webContents.setIgnoreMenuShortcuts(true)`，屏蔽 Eagle 宿主菜单快捷键，ESC 等按键只由插件处理；这是 Eagle 自己对独立插件窗口采用的官方机制（`app/js/utils/ignoreMenuShortcuts.js`），经 `plugin.window.webContents.` 通道调用，**不碰窗口生命周期**。
  - **插件关闭后** → `setIgnoreMenuShortcuts(false)` 立即恢复；`exitPlugin()`、`beforeunload`、`pagehide` 三处都有，覆盖用户点 Eagle 自己的 ✕、切条目、从插件界面直接退出 Eagle。
  - **直接退出 Eagle 后重启** → 该开关是 webContents 的**运行时状态、不写盘**，Eagle 重启自动复位；插件每次启动还会先无条件发一次 `false` 再发 `true`（自愈上次残留），双保险。
- 保留不变：ESC 无条件吞掉、浮层/搜索/输入优先级、退出前落盘、守卫三档取值契约、独立窗口形态走 `window.close()` 关自己、投影/数据/模型一律不动。
- **Eagle 已打不开的恢复**：`window-state.json` 正常（`isMaximized:true`），主窗口对象是被 `destroy()` 销毁而非配置损坏。彻底退出 Eagle 进程后重新启动即可恢复；若托盘图标还在，先从任务管理器结束 `Eagle.exe` 再启动。升级到 4.4.6 后不会再发生。

---

## 更新记录 · 4.4.5（预览窗口 ESC 只发一条 destroy）

- **用户实测回归**：v4.4.4 装好后「不操作还能退；操作了要么连 Eagle 一起退出、要么没反应」。`debug.log` 08:32/08:33 给出决定性证据：`exit.senderclose {"sent":true}` 说明 IPC close 已发出，但同一个 `windowID=9` 被连按十几次窗口都没关，且 **`exit.senderdestroy` 与 `exit.stillalive` 一行都没有**。
- **根因（v4.4.4 的设计缺陷，不是浏览器拦截）**：预览分支同时发了主进程 `bw.close()` 和 renderer 的 `window.close()`，两条关闭请求并发、互相打断，结果在「宿主一起收走」和「卡住没反应」之间摇摆；更致命的是 `window.close()` 一发出，Chromium 就把 `window.closed` 提前置为 `true`，`exitPlugin()` 里所有 `if (!alive()) return` 兜底全被短路 —— 320ms 的 `destroy` 和 900ms 的提示根本没机会执行，所以日志里看不到任何失败记录。
- **翻 `app.asar` 确认的依据**：`ipcMain.handle('plugin.window.')` 是 `BrowserWindow.fromWebContents(event.sender)`，只作用于发消息的预览窗口；`openPreview` 创建的窗口没有 `close` 事件拦截。Eagle 主窗口另监听 `message === "Exit"` → `leaveDetailMode()`，菜单里 ESC 加速器会调 `escHandler`；但 v3.31 曾试过放行 ESC 让宿主兜，结果「Eagle 把整个界面收走」，所以 **不能交还宿主**。
- **修复① 单一出口**（`app.js`）：预览分支只发 `Bridge.closeCurrent('destroy')`，320ms 后若本 JS 仍在执行再补一次防 IPC 丢包。`destroy()` 不触发 `'close'` 事件、不跑 `beforeunload`、不受 sticky activation 影响，因此既不触发宿主收起界面的回调，也不会卡在关闭拦截里。**不再发 `window.close()`、不再发 IPC `close`**。
- **修复② 兜底不再被骗**：预览分支删掉所有 `if (!alive()) return` —— timer 能执行本身就说明窗口还在（真关掉了 renderer 上下文就没了，timer 根本不会跑），不需要 `window.closed`。
- **修复③ IPC 结果落盘**（`bridge.js`）：`ipcWindow(method, tag)` 支持可选 tag，`closeCurrent` 带 `exit.ipc`，成功写 `exit.ipc.ok`、失败写 `exit.ipc.err`。v4.4.4 的 `.catch(()=>{})` 把失败全吞了，日志只剩 `sent:true`，分不清是消息没送达、handler 抛错还是窗口已销毁。
- 保留不变：三级许可（现场 `no-self-id` → `allow:false / allowWindowClose:true / allowSenderClose:true`）、ESC 无条件吞掉（绝不交还宿主）、浮层/搜索/输入优先级、退出前落盘并摘 `beforeunload`、120/420ms 宿主 restore/show、1.2s 连按防抖。独立窗口形态（从闪灵面板打开）仍走原来的 `closeSelf` + `destroySelf` 路径。
- **待实测**：重启 Eagle 后打开文档，点过页面再按 ESC。理想日志是 `exit.destroy {sent:true}` + `exit.ipc.ok {method:"destroy"}`，随后窗口直接关闭、不再有 `exit.stillalive`；若仍提示，看 `exit.ipc.err`。

---

## 更新记录 · 4.4.4（点击页面后 ESC 仍能稳定退出）

- **用户实测**：通过插件打开文档，不操作或只用滚轮时按 ESC 能退出；鼠标点过一下之后再按 ESC 就退不出去。现场 `debug.log` 里 00:25 之后成片的 `exit.selfclose`，裁决恒为 `{allow:false, allowWindowClose:true, code:'no-self-id'}`，窗口身份 `mode=preview / parentID=2 / windowID=8`。
- **根因**：`app.js` 在 `window` 上挂了 `beforeunload`（退出时 `persist`）。Chromium 规定：页面存在 `beforeunload` 监听器、且用户已产生 sticky activation（鼠标点击、键盘输入）时，脚本发起的 `window.close()` 会被拦下等待确认 / 静默拒绝；滚轮滚动不产生 activation，所以「不操作时能退、点一下就退不了」。v4.4.3 恰好把 `window.close()` 留成了唯一出口。顺带更正 4.4.3 小节里「刚打开时 ESC 由宿主退出」的推测——现场证明 ESC 一直由插件吞掉处理，差别只在脚本关窗是否被放行。
- **修复① 摘钩**（`app.js`）：`beforeunload` 改成具名监听并留下摘钩句柄；`exitPlugin()` 先 `flushDrafts` + `persist(true)` 落盘，再摘掉监听，关窗时 renderer 层已无任何 `beforeunload`。用户点 Eagle 自己的 ✕ 退出时监听仍在，照常保存。
- **修复② 主进程按 sender 定向关窗**（`bridge.js`）：新增 `Bridge.closeCurrent('close' | 'destroy')`，走 `ipcRenderer.invoke('plugin.window.', …)`；Eagle 主进程用 `BrowserWindow.fromWebContents(event.sender)` 定位，作用对象只能是发出消息的窗口，`destroy()` 更是无条件绕过 renderer 的 `beforeunload`。现场 `[env] {"ipc":true,"bw":"max"}` 已证明这条通道在预览窗口可用且指向正确。
- **修复③ 第三级许可**（`winguard.js`）：新增 `allowSenderClose`，证据比 `allowWindowClose` 更严 —— 只有 `windowID≠parentID`（Eagle 明确注入的独立预览窗口）或 `parentID/windowID` 全无的独立 `window` 形态才放行；`windowID===parentID`、`flagged-host`、`browser`、`unknown-mode`，以及「有 parentID 却拿不到 windowID」的身份不明形态一律零窗口操作。`allow` / `allowWindowClose` / `code` 取值不变，旧裁决契约保持。
- **修复④ 序列与诊断**（`app.js`）：预览分支 = 摘钩 → `closeCurrent('close')` → `window.close()` 兜底 → 120/420ms restore/show 宿主 → 320ms 仍活则 `closeCurrent('destroy')` → 900ms 仍活才提示。连按 ESC 加 1.2s 防抖，不再对主进程重复发请求；`debug.log` 增记 `exit.senderclose` / `exit.senderdestroy` / `exit.stillalive`。全程不调 `closeSelf` / `destroySelf`（依赖 remote，且可能指回主窗口）。
- **顺手修**：日志里反复出现的 `Uncaught TypeError: onProgress is not a function @ asr.js` —— v4.3.5 已修过调用方传参，本版再把 `asr.js` 所有进度回调调用点统一成 `typeof onProgress === 'function'` 判定，`prepare()` 入口也做归一，任何非函数真值都不会再被当函数调用（v4.3.5 的归一化契约不变）。
- 安全边界不变：绝不把 `close` / `destroy` 施加到 Eagle 主窗口；ESC 仍无条件吞掉，浮层 / 搜索 / 输入的优先级不变；不动投影 / 数据 / 模型。

---

## 更新记录 · 4.4.3（修复「一操作后 ESC 只弹提示、退不出插件」）

- **用户实测**：通过插件打开文档，什么都不操作按 ESC 能退出插件；一旦在插件里操作过，再按 ESC 就只弹「当前是 Eagle 预览视图，为保护主界面不执行关闭」。现场 `debug.log` 里 43 次裁决全是 `no-self-id`，一次都没放行。
- **事实更正**：翻 Eagle 4.0 `app.asar` 的 `pluginModule.openPreview`，预览视图其实是 `new BrowserWindow({...})` **独立承载** 的，`dom-ready` 注入 `window.parentID = 主窗口 webContents.id`、`window.windowID = win.webContents.id`。所以 `windowID !== parentID` 恰恰证明「我不是主窗口」。v4.4.1 把「有 parentID」一律当成「跑在主窗口的 webview 里」，又要求必须拿到 `@electron/remote` 的 `selfId` 才放行 —— 预览窗口里 remote 经常不可用，于是连自己的预览窗口都不敢关。
- **为什么「有没有操作」会不一样**：刚打开时焦点还在 Eagle 主窗口，ESC 由宿主自己退出预览；一旦操作，`grabKeys()` 把焦点抢进插件，ESC 被插件吞掉并走 `exitPlugin()`，才撞上守卫拒绝。主窗口的 `escHandler` 只做 `leaveDetailMode()`，不会最小化 —— 当年「一起最小化」的锅不在 ESC 冒泡，而在 remote/IPC 关窗路径可能指回主窗口。
- **修复① 两级许可**（`winguard.js`）：`allow` 保持原语义（能否对 remote / IPC 拿到的窗口执行 `close`/`destroy`，证据最严）；新增 `allowWindowClose`（能否 `window.close()`，它只作用于**当前 renderer 所在窗口**，天然不跨窗口）。只有「当前 JS 确实与主窗口共用 webContents」（`windowID === parentID`）或 `selfIsHost` 才禁止。现场 `no-self-id` 现在得到 `{allow:false, allowWindowClose:true}`。
- **修复② 独立预览窗口关自己**（`app.js`）：守卫拒绝 remote、但允许 `window.close()` 时，保存草稿 → `focusParent({focus:false})` 只 restore/show 宿主 → `window.close()` 关掉自己的预览窗口 → 120/420ms 再补两次恢复。**全程不调用** `closeSelf` / `destroySelf` / `ipcWindow` / `destroy`。Electron 个别版本静默拒绝脚本关窗时，900ms 后给一句可执行提示（按空格或点 Eagle 的返回）。
- **修复③ 诊断补全**：`debug.log` 增记 `exit.env`（mode / parentID / windowID / selfId / allIds）与 `exit.selfclose`。上次只记裁决码，看不出生效形态，白排查一轮。
- 安全边界不变：`windowID === parentID`、`flagged-host`、`browser-mode`、`unknown-mode` 一律零窗口操作；ESC 仍无条件吞掉，绝不漏给宿主；`Ctrl+W` / ✕ 走同一出口。
- 本版不改投影 / 数据 / 模型，也不动 ESC 的浮层、搜索、输入优先级。

---

## 更新记录 · 4.4.2（Eagle 删除条目后，Obsidian 残留笔记自动回收）

- **用户实测**：一个视频已在 Eagle 里删除，Obsidian 里对应 md 却一直还在；「重建全部」也清不掉。
- **根因（设计缺口）**：投影层只按插件自己的 `docs/*.json` 生成/更新 md，`rebuildAll()` / `syncExternal()` 从不反查 Eagle 里条目是否还存在；而「只有 Eagle 注释、没有摘录笔记」的条目压根没进 `docs`，连全量重建都看不见它，`manifest` 里那条记录就成了永远没人管的死账。另外 `Projection.remove()` 虽存在却全项目无任何调用。
- **修复① 存在性对账**：`Projection.orphanCandidates(aliveIds)` 比对「vault 清单」与「Eagle 全库 id」，找出已删条目；`syncAliveIds()` 顺带解除从回收站恢复条目的墓碑。官方 API 拿不到全库清单（失败/空库）时一律不产出候选，绝不误删。
- **修复② 复核 + 备份 + 回收**：工作台新增「清理已删条目…」按钮，逐条 `getById` 复核（单条查询报错保守跳过）后，把 md **先备份到 `<库>\.eaglenote\deleted-md\`**（vault 之外，OB 不显示、可随时找回），再删 md、清 manifest / assets / 别名索引，并写 `.eaglenote-deleted.json` 墓碑。备份失败则原件一个字节都不动。
- **修复③ 防复活**：`writeNow()` 撞到墓碑直接跳过，`rebuildAll()` / `syncExternal()` 也显式跳过 —— 否则下次重建会把删掉的 md 又写回来。条目从 Eagle 回收站恢复时自动解除墓碑，投影照常回来。
- **自动触发**：插件启动 8 秒后静默对账一次，之后每 5 分钟一轮（全库 API 有成本，不塞进 15 秒回读循环）。静默轮自动跳过含非空「手记」的 md，留给工作台按钮由用户确认。
- 本版不改 ESC / 关窗策略，也不动模型与数据目录。

---

## 更新记录 · 4.4.1（修复 ESC 连带 Eagle 一起最小化）

- **用户实测回归**：v4.4.0 恢复「ESC 关闭插件」后，按 ESC 会把 Eagle 主界面一起收走（最小化到托盘）。
- **根因**（翻 Eagle 4.0 `app.asar` 确认）：预览形态下插件跑在 Eagle 主窗口的 `<webview>` 里，`dom-ready` 注入 `window.parentID = 主窗口 webContents.id`、`window.windowID = webview id`。这种形态下 `require('@electron/remote').getCurrentWindow()` 和主进程 `BrowserWindow.fromWebContents(event.sender)`（`plugin.window.` IPC 的实现）都可能指回 **Eagle 主窗口**；对它 `close()` 会被 Eagle 的「关闭到托盘」拦成 minimize/hide，于是插件视图与整个 Eagle 一起消失。v3.22 曾有 `canSelfClosePreview()`（`windowID === parentID` 时拒绝关窗），v3.31 随「ESC 永不关窗口」删掉；v4.4.0 恢复关窗却没恢复守卫 = 回归点。
- **修复① identity guard**：新增纯函数 `js/winguard.js`（`closeVerdict`），只有能证明「自己是另一个窗口」时才允许关窗：`selfIsHost`、`windowID === parentID`、`selfId === parentID`、拿不到 selfId、窗口列表不足两个、selfId 不在列表内、预览形态无佐证 —— 任一命中即拒绝。`Bridge.closeSelf()` / `destroySelf()` 与 framewin 的两条兜底链路全部先过守卫，守卫不过**一个窗口 API 都不碰**。
- **修复② exitPlugin 安全化**：守卫拒绝时不关窗、不销毁、不 window.close，只 restore/show 主窗口（不抢焦点）并提示「当前是 Eagle 预览视图，请按空格或点 Eagle 的返回退出预览」。ESC 决策不变（空栈仍 exit-plugin，浮层/搜索/输入优先级不变），但出口多了一道身份闸门。
- **修复③ 宿主恢复兜底**：`focusParent()` 增强为 parentID 缺失时也能从窗口列表里找出宿主；关窗前后共 3 次 restore/show（120/420ms）＋ ESC 后 260ms 一次，任何把主窗口收走的副作用都会被纠正回来。只做恢复，绝不最小化/隐藏。
- **诊断**：`debug.log` 新增 `exit.guard` / `exit.guard.deny` 行，记录 mode、parentID、windowID、selfId、窗口数与裁决码，再出问题一眼可定位。
- 行为边界：独立窗口形态（从插件面板/闪灵面板打开）ESC 照常关闭插件；Eagle 预览视图形态 ESC 不再执行关闭（那是唯一会波宿主的形态），改用 Eagle 原生的空格/返回退出预览。Ctrl+W、✕ 同样受守卫保护。

---

## 更新记录 · 4.4.0（OB 格式优化 + 双链精确定位 + ESC 关闭插件）

- **OB 输出格式优化**：摘录/笔记的引用原文改用 Obsidian callout（`> [!quote]-`）呈现——折叠的引用框，标题带类型·颜色标签（如「高亮 · 黄」），阅读视图里摘录、笔记、批注一眼可分，点标题展开原文。回读口径零变化（`>` 行全部剥离），Typora/VSCode 里退化为普通引用块。
- **双链精确到笔记**：[[ 补全候选、插入文本、manifest 索引（rec.nt）统一改成「正文第一行原样」口径（新增 `WikiLink.noteAnchorTitle`），与投影 md 的 `#### 标题头` 完全同源——`[[书名#笔记标题]]` 在 Obsidian 里不再只跳到文件，直接定位到那条笔记。v4.3 时代按剥壳截断口径写出的旧链接仍可跳（兼容回退）。
- **ESC 关闭插件**：弹层全部关完后，再按 ESC = 关闭插件窗口（与 ✕ / Ctrl+W 同一条出口，退出前照常静默存草稿）。浮层/搜索框/输入状态的 ESC 行为不变：有浮层先收浮层、搜索有字先清字、输入中先失焦——浮层永远快于关窗。这是 v3.22 移除该行为后的政策回调：当年的事故（ESC 连 Eagle 一起收走）源于三层兜底叠加，如今决策点只剩 escguard 一处，且 ESC 事件无条件 preventDefault，绝不会漏给 Eagle 宿主。
- **快捷键盘点（对照 Eagle 官方快捷键表）**：插件内 Delete（防误删素材）、Space（视频播放）、方向键（翻页/步进）等高危键均已拦截，无实质冲突；Ctrl+N 在插件内=新建笔记（Eagle 里=贴上剪贴板图片），插件窗口内被插件优先接管，属预期行为。

---

## 更新记录 · 4.3.6（双链在 Obsidian 里可用）

- **问题**：插件里的双链 `[[书名]]` / `[[书名#笔记]]` 在 Obsidian 里全是未解析链接。两个根因：① OB 按文件名解析 `[[书名]]`，而投影文件名经过消毒（非法字符换空格、超长截断加 …、撞名加 (id)），书名常对不上；② `[[书#笔记]]` 只认标题，而笔记标题（正文第一行）藏在正文里，md 里没有对应标题。
- **书级修复**：md 的 frontmatter 新增 `aliases:`——写入原始书名与改名历史（旧名），OB 里 `[[书名]]` / `[[旧名]]` 靠别名照常解析、照常可点。
- **笔记级修复**：每条笔记的标题升级成真正的 `#### 标题` 标题头（紧跟 `### 第 X 页`），正文从第二行写起（OB 里标题不重复显示）；`[[书名#笔记标题]]` 在 OB 里直接定位到那条笔记。回读时标题头还原成 md 第一行，与插件存储口径一致——没动过就不产生假「外部改动」，改了标题就正常同步回插件。
- 兼容：旧结构 md（标题在正文里）回读口径不变，不会误判为外部修改；用户自己写的 `####` 小节不受影响。

---

## 更新记录 · 4.3.5（精修模型下载修复）

- **Bug 修复**：视频实时字幕里点「精修·未装」/ 开播引导下载精修模型，下载刚起步就静默失败（日志报 `Uncaught TypeError: onProgress is not a function @ asr.js`）。根因：API 约定不一致——`Asr.prepare()` 收 `{ onProgress }` 对象，`Asr.ensureRefine()` 收裸函数，subtitle.js 两处调用按 prepare 的样式传了对象，对象是真值、被当函数调用直接炸。
- 修复：两处调用改传裸函数；`ensureRefine` 归一化防御——两种传参都收，杜绝同类误用。
- 核实：精修模型本体（SenseVoice 229 MB）在 Clinical Surgery 库完好，此前下载从未成功即本 bug 所致。

---

## 更新记录 · 4.3.4（删光内容后空壳 md 回收修复）

- **Bug 修复**：摘录/笔记删光后 md 没有回收，留下一具空壳。根因：回收守卫只看「注释区有没有文本」——插件自己投影到注释区的旧值也挡住回收，而空壳写完后没有任何机制再触发该条目，于是永远残留。
- **新判据**：注释区文本与上次插件写入一致（哈希比对，含已同步/即将写回队列的）→ 放行回收；只有**用户手改、md 独有**的注释文本才保留——它们会经合并队列写回 Eagle 注释栏，内容零丢失，同步完成后下次自然回收。手记区保留逻辑不变。
- 修复后重启插件，启动时的空闲全量回填会把现存空壳一并清掉，无需手工处理。

---

## 更新记录 · 4.3.3（OB 文件夹整理 + Ctrl+N 新建笔记）

- **Obsidian 里可以随意整理文件夹了**：新建文件夹、把笔记拖进子文件夹、F2 改名，插件都会自动重新认领——15 秒轮询回读照常、保存写盘跟着新位置走，不再出现「根目录又长一份重复文件」。认领优先按文件头 `eagle: "<条目id>"` 锚点（移动 + 改名都能认出），锚点丢失时退回按文件名认，同名多份宁可放弃也绝不认错。认领时自动按新深度重写 assets 图片引用（`../assets/…`），截图在 OB 里不裂。
- **改名也跟着文件夹走**：在 Eagle 里改了条目标题导致文件名重算时，新文件落在用户安排的同一个文件夹里，旧名文件从原位置删除。
- **assets 图片资产始终留在 vault 根**：所有子文件夹里的笔记共享同一份 `assets/`，移动笔记不搬运图片。
- **插件内 Ctrl+N / ⌘N 新建笔记**：与「✎ 新建笔记」按钮同一入口，弹居中大编辑窗。大笔记框已开着时只把光标送回编辑器，绝不重置草稿（防误按丢字）。

---

## 更新记录 · 4.3.2（vault 按库名命名）

- **Obsidian 仓库一眼区分多库**：vault 目录名从固定的 `vault` 改为 **`闪灵笔记 - <库名>`**（库名 = Eagle 库文件夹去掉 `.library` 后缀，与界面显示一致）。多库场景下 Obsidian 的仓库切换器里不再是一排毫无辨识度的「vault」。
- **旧目录自动迁移**：插件启动时检测到旧 `vault/` 目录且新名目录不存在 → 同盘 rename 迁移，内容零拷贝零丢失（`.obsidian` 配置、投影 md、锚点清单全部跟着走）。
- **Obsidian 侧注意**：迁移后旧仓库引用会失效——在 Obsidian 里「打开文件夹作为仓库」重新指向 `<库>\.eaglenote\闪灵笔记 - <库名>` 即可；旧的「vault」条目可在仓库切换器里移除。

---

## 更新记录 · 4.3.1（Eagle 注释巡检）

- **工作台新增「Eagle 注释巡检…」按钮**：全库扫描 Eagle 注释栏，凡带插件标记（`【摘录|截图|框选|片段|打点|字幕|笔记|锚点 · 】`行首格式）的整条清空。背景：插件索引清空之后，clearAll 就找不到该清哪些注释了——巡检不依赖索引，专治这种残留。
- **走官方 API 执行**：Eagle 运行中即可清，内存 / library-caches 缓存 / 磁盘 metadata.json 三层由 Eagle 自动同步、界面实时生效（不要再用文件层直改 metadata.json 的方式清注释——Eagle 退出时会用内存把改动覆盖回去）。
- **守卫**：批量扫描命中后逐条 `getAnnotation` 复核；只有行首标记匹配才算插件写入，用户手打的注释一行不动。执行前列出命中条目请用户确认，完成后报告扫描数 / 清空数 / 失败数。

---

## 更新记录 · 4.3.0（Obsidian 双向同步）

- **以 Obsidian 为前端观看/编辑笔记**：vault 固定在 `<库>\.eaglenote\vault\`，随 Eagle 资料库整体迁移——换电脑 / 重装系统后，重装 Eagle + 插件 + Obsidian，「打开文件夹作为仓库」指回该路径即恢复。
- **双向同步**：保存笔记约 2.6 秒后自动投影进 vault；Obsidian 里手改的内容约 15 秒内被扫描发现并吸回权威 JSON（合并后列表即时刷新，弹 toast 提示）。摘录批注、独立笔记正文双向回流；Eagle 注释栏小节走写回队列。引用原文、页码、时间点、图片以插件为准不被覆盖；文件末尾「手记」区永远只属于你。
- **冲突兜底**：用户承诺不两边同时改；万一真撞上，md 为准、被覆盖的旧值落 `.conflict` 文件，绝不静默丢数据。
- **权威数据不变**：仍是 `<库>\.eaglenote\docs\*.json`，md 只是投影 + 手改通道，可随时关闭同步（vault 文件保留）或整个删掉 vault 重建（工作台开关 + rebuildAll）。
- 工作台新增「Obsidian 双向同步」开关与 vault 路径显示；`[[双链]]`、改名别名索引照常供 Obsidian 与插件两侧使用。

---

## 更新记录 · 4.2.18（数据层加固：损坏文档隔离）

- **损坏文档不再被静默覆盖**：单个文档 JSON 读不出来（磁盘级故障）时，此前直接当空数据处理，下一次保存会把原地那份「可能可抢救的数据」覆盖掉。现在先把损坏文件改名隔离（`*.corrupt-<时间戳>`）再返回空数据，日志留痕、可手工恢复。索引损坏原本就有重建兜底（从 docs/ 全量重建），不变。
- **稳定性巡检结论**（2026-11-04）：核心数据路径全部 tmp+rename 原子写；迁移三重守卫幂等；debug.log 200KB 自动轮转；知识库全库扫描 10 分钟缓存 + 异步超时；主插件单写者、工作台不直接写索引。

---

## 更新记录 · 4.2.17（框选笔记不进阅读区 + 代码巡检）

- **框选笔记不再显示在 PDF 阅读区**：此前「框选并笔记」写了笔记后，笔记前 16 个字会以小标签形式内嵌在阅读区的框选标记里。现在阅读区只留框选标记本身，笔记内容走右栏卡片和悬停提示。
- **巡检优化**：清理 `.ann-tag` 死样式；删除 `#noteSearch` 上永远收不到事件的冗余 Esc 处理（全局捕获层已统一处理）；搜索结果面板打开时窗口缩放会跟着重定位（fixed 坐标快照失效问题）。

---

## 更新记录 · 4.2.16（Esc 前交还焦点，蓝框偶闪根治）

- **按 Esc 时先交还非输入类焦点**：鼠标点过的卡片/页签/按钮会把焦点留在原地，按 Esc（键盘事件）时 Chromium 把「最后输入方式」翻成键盘模式，`:focus-visible` 蓝圈当场闪一下、重渲染后才消失（4.2.14 只修了页签一处，其他卡片仍会偶闪）。现在 Esc 分支在绘制发生前 blur 掉非输入焦点，蓝圈没机会画出来；输入框/正文焦点不动，光标与输入法状态保留。

---

## 更新记录 · 4.2.15（搜索默认「全部」+ 改名 + 搜索面板定位根治 + 框选压暗）

- **搜索结果固定停在「全部」**：之前有「第一层有结果就跳第一层」的自动选层，资料内笔记 0 条时会自动跳到「全局笔记」（用户截图实锤）。现在永远默认「全部」三层合流，想看单层自己点标签。「全部」内排序为 资料内笔记 → 全局笔记 → Eagle 数据库。
- **标签改名**：「本笔记」→「资料内笔记」，「Eagle 库」→「Eagle 数据库」（搜索结果标签 + 搜索框占位符 + 提示行）。
- **全文搜索结果面板定位根治**：改为 `position: fixed`（视口坐标），面板左缘对齐搜索栏左缘、右缘对齐明暗切换键右缘、顶边贴搜索栏下方。之前 absolute 坐标系错位且会撑宽布局——点搜索栏 PDF 被挤得左移、面板半截出屏，一并根治。
- **视频框选压暗**：框选 / 框选并笔记拖动时，画面四周压暗（55% 黑），选框内视频保持原样（大扩散 box-shadow 挖空），选框边界一目了然。

---

## 更新记录 · 4.2.14（页签蓝圈根治 + 搜索默认「全部」）

- **点页签再按 Esc 不再出现蓝色框体**：鼠标点「摘录 / 笔记」页签后按钮留着焦点，按 Esc 时 Chromium 把「最后输入方式」翻转成键盘，`:focus-visible` 的蓝圈当场画在页签上。现在点完页签把焦点交还（blur），键盘 Tab 导航的焦点圈保留（无障碍不受影响）。
- **笔记搜索默认「全部」**：搜索结果的默认层从「本笔记」改为「全部」（三层合流），清空/重置后同样回到「全部」。

---

## 更新记录 · 4.2.13（Enter 不再漏给宿主 + 新建按钮严格对齐）

- **笔记输入框按 Enter 不再「用默认软件打开文档」**：全局按键对「正在打字」的 Enter 一向放行，宿主 Eagle 收到没人认领的 Enter 就会打开当前文档。现在笔记正文里按 Enter 由编辑器整键吞掉（preventDefault + stopPropagation），换行手工补上，输入法选词、Ctrl+Enter 保存、[[ 补全确认全都不受影响；[[ 补全弹窗「空结果」分支和笔记搜索框里的 Enter 同样堵上。
- **新建笔记按钮与笔记卡片严格对齐**：列表出滚动条时卡片实际宽度被吃掉 10px，静态 CSS 算不准 —— 改为渲染时抄 `.notes-list` 的 clientWidth（已扣滚动条）实测同步按钮宽度，窗口缩放时跟随；margin 不再居中，左缘与卡片左缘重合。

---

## 0. 运行环境与可选依赖

插件本体（4.9 MB）**不包含、也不下载任何模型**。装上就能阅读、标注、摘录、写笔记、搜索、看视频笔记 —— 这些功能零外部依赖，PDF.js / pdf-lib / 字体全部随包本地打包。

| 能力 | 需要什么 | 没有时会怎样 |
| --- | --- | --- |
| 阅读 / 标注 / 摘录 / 笔记 / 搜索 / 视频笔记 | 无 | —— |
| 划词翻译 | 能联网，或本机有 Ollama | 自动走在线通道（有道免密钥），功能照常可用 |
| 图片 OCR（视频截图、框选图片） | **必须**本机有 Ollama + 视觉模型 | 按钮可点，但会明确告知缺什么，并在右栏展开三步安装引导 |
| 视频实时字幕 | 首次点「开启」时下语音识别引擎 + 模型（约 212 MB） | 不影响视频播放与笔记；左栏字幕区显示「开启」与下载进度 |
| 字幕精修（可选，3.12.0 起） | 勾选后多下 **239 MB**（SenseVoice） | 不下也能用，只是只有实时粗字幕；头部「精修·未装」随时补下 |

### 视频实时字幕（3.10.0 起，3.12.0 加精修）

打开视频时，左栏**上半是实时字幕、下半还是历史记录**。边播边出字，中文只显示原文，
英文会补一条中文译文（双语）。全部在本机跑，音频不出网。

**引擎和模型不打进插件包**（否则从 2.3 MB 涨到 210 MB，商店也过不了），第一次点「开启」
时下载一次，缓存在 `<数据目录>/asr/` 下，之后离线可用、任何视频都不用再等：

| 组成 | 大小 | 来源 | 必需 |
| --- | --- | --- | --- |
| sherpa-onnx 引擎（含 onnxruntime） | 约 23 MB | npm 镜像（npmmirror / npmjs） | 是 |
| 中英双语流式 zipformer 模型（int8） | 约 189 MB | hf-mirror / huggingface | 是 |
| SenseVoice 非流式模型（int8，精修用） | 约 239 MB | hf-mirror / huggingface | 否 |

**为什么是三层**（3.14 起）：流式模型只能看「已经说过的字」，遇到专业术语、人名、数字，错法是系统性的
（听成音近的常用词）。所以字幕会**先出粗的、几百毫秒后被换成准的**，被精修过的那行时间戳
旁会多一个绿点。精修在 `decodeAsync` 里跑（线程池，2 线程），播放不卡，也不跟流式抢 CPU。

| 层 | 什么时候跑 | 拿什么做判断 | 解决什么 |
| --- | --- | --- | --- |
| ① 流式 + **热词偏置** | 边播边出字 | 术语表 + 视频文件名 | 「胆囊三角」不再被听成「单囊三角」 |
| ② 精修（SenseVoice） | 每句落定后 | 这一句的原始音频 | 双向看整句，更准、自带中文标点 |
| ③ 语境校对（需要本地 Ollama） | 精修之后 | 前后各几句 + 术语表 | 只靠单句判不出来的同音字 |

- **热词（contextual biasing）不换模型、不重新下载权重** —— 它是 sherpa-onnx 在解码时给
  指定词加分。限制要说清：只对 transducer + `modified_beam_search` 生效（我们流式那支正好
  符合），**SenseVoice 吃不到**，所以热词只提升第一遍。中英双语模型还需要一份 `bpe.vocab`
  （约 1 MB，用到时才单独下，不会让已经下好 189 MB 的人被判成「模型不完整」）。
- **语境校对只在本地跑**：字幕文本 + 前后几句 + 术语表交给本机 Ollama，音频不出网。
  它有三道闸门（只取第一行、长度不能超出原文 0.45–1.9 倍、不增删内容），
  模型一旦「顺手发挥」就整条丢弃 —— 宁可少改一次，也不能把字幕改坏。
  没装 Ollama 时头部显示「语境·未装」，前两层照常工作。
- **为什么没有换医学专用 ASR 模型**：现成的医疗模型（如基于 Qwen3-ASR 的 LoRA 微调版）
  要 Python + Torch + GPU，也没导出 sherpa-onnx / ONNX 格式，塞不进 2.3 MB 的插件包。
  而垂直领域的收益大头本来就在「术语」，这一块用热词 + 术语表已经能拿到，代价是零。

**音频同时归档**到 `<数据目录>/asr/audio/<itemId>.pcm`（16 kHz 单声道 int16，一分钟 1.9 MB）：
精修要重听、重开插件不用重播、原始音轨本身就是资料的一部分。按时间戳随机写，往回拖进度条会
覆盖同一段，不会拼成两段错位音频。

四点如实说明：

- **音频直接从播放器抓**（WebAudio 的 `MediaElementSource`），所以不依赖 ffmpeg，
  浏览器能播的格式都能转写；代价是「播到哪儿才转到哪儿」，跳过去还没播的地方没有字幕。
- **每次打开视频都从头生成**（3.13 起）：字幕不落盘、不续播，打开就是空白，点「开启」从当前
  播放位置开始重新转。想留下来就点「导出」——md 与音频一起落到资料库 `_notes`。
- **不做逐句翻译判断**：把整段视频的句子票数算一下，中文句不少于英文句就当中文视频，
  夹的英文不单翻（否则「今天讲 Transformer」这种会被翻成半中半英，更难读）。
- **接了两条支路才不静音**：`createMediaElementSource` 一旦调用，`<video>` 的音频就被
  WebAudio 图接管，元素不再直连扬声器。原声必须自己接回 `destination`；采集支路要挂在
  一个 0 音量的增益上（`ScriptProcessor` 没有输出连接就不会被调度）。
- **静音段不精修**：SenseVoice 对纯静音会编出内容（实测全 0 输入得到 `그.`）。精修前先算
  RMS，低于 -50 dBFS 直接跳过 —— 跳转后 pcm 里的空洞正好走这条路。

### 要用 OCR / 离线翻译时的三步

1. 安装 Ollama（免费开源）：<https://ollama.com/download> —— Windows / macOS / Linux 都有安装包；
2. 终端执行 `ollama pull qwen2.5vl:7b`（约 6 GB；显存不足 8 GB 可换 `qwen2.5vl:3b`）；
3. 回到插件，右栏顶部「本地增强」按提示点**重新检测**。

装好之后模型只在本机跑，图片和文字都不出网。**插件一启动就会自己把 `ollama serve` 拉起来**（3.9.2 起），并**自己找到 `ollama.exe` 在哪**（3.9.5 起）：闲置 5 分钟自动卸载模型，把显存还给别的程序。

**怎么找到 ollama.exe（不用你手填路径）**，按证据强度依次问系统，命中即停：

1. 上次找到的路径（记住后开机第一次 `statSync` 就命中，零成本）；
2. 设置里手填的路径 / `OLLAMA_EXE` 环境变量；
3. 各平台标准安装位置（见下面「平台」）；
4. `PATH`（`where ollama`）—— 官方安装包会把自己加进 PATH；
5. **正在运行的 ollama 进程的 exe 路径** —— 托盘版开机就常驻，从进程反查最准；
6. Windows 卸载表里登记的 `InstallLocation`；
7. 兜底：在常见根目录（家目录、Program Files、各盘根目录）里有限度地走一遍目录树找 `ollama.exe`。

第 1~3 步是几次 `statSync`（毫秒级）；第 4~6 步要起进程问一句（约几百毫秒）；第 7 步有预算（9 秒上限、最多 4 万个目录，只读目录名不读文件内容，跳过 `node_modules` / `AppData` / 隐藏目录）。**七步全空才判定「没装」**，那时才提示去下载。右栏「本地增强」里另有「自动查找」按钮，随时可以手动再扫一遍。

**自动拉起是静默的**：Windows 上用 `windowsHide` + 不带 `detached`（Node 在 detached 分支里不传 `CREATE_NO_WINDOW`，那才是「闪一堆黑窗」的真凶），拉进程全程不弹窗。确实找不到就安静失败，右栏给三步引导 + 「自动查找」+ 一格手填路径作为最后手段 —— 失败后 30 秒内不重试，不会反复拉进程。

**手填路径只作兜底**：绿色版放在最刁钻的位置（比如网络盘）扫不到时，右栏「本地增强」展开后底部有一格路径输入，翻译面板齿轮里的「可执行文件路径」是同一个配置，填一处即可。那是用户自己的配置，不是写死的路径。

### 让翻译更准（3.12.0 起）

划词翻译的准确度，瓶颈通常不是模型大小，而是**信息不足**：一个词脱离句子就有歧义，通用引擎只会给「最常见」的那个译法。两件事补上：

1. **上下文自动带**。选区所在文字层的前后 480 字会一起交给本地模型，只用来消歧、不参与输出。
   `dissection` 单拎出来是「解剖」，在血管外科的句子里是「夹层」；`intervention` 在介入科是
   「介入手术」，在公卫里是「干预」。这个不需要你做任何事。
   > 小模型偶尔会把上下文一起翻了 —— 所以有一道「译文长度 > 原文 3.2 倍」的检测，命中就去掉上下文重来一次。
2. **术语表**。翻译面板齿轮 → 术语表，一行一条 `英文 = 中文`（也认 `=>` 和 Tab）：

   ```
   dissection = 夹层
   intervention = 介入手术
   coil = 弹簧圈
   # 井号开头是注释
   ```

   翻译时**只注入这句话里真的出现过**的术语（最多 24 条），词边界匹配 —— `he` 不会被
   `the` / `other` 带出来。术语表一改，缓存键跟着变，旧的错译不会再被复用。

**边界**：这两项只有**本地模型**吃得到（有道 / Google 的接口没有这个能力）。没有本地模型时，
能做的只有「同一句话不会翻两次、译法稳定」，准确度取决于在线引擎本身。

### 平台

`manifest.platform = "all"`。可执行文件查找路径按 `process.platform` 分流（下面只是第 3 步「标准位置」，第 4~7 步才是覆盖绿色版的那些）：

- Windows：`%LOCALAPPDATA%\Programs\Ollama\ollama.exe`、`%ProgramFiles%\Ollama\ollama.exe`
- macOS：`/Applications/Ollama.app/Contents/Resources/ollama`、Homebrew 的 `/opt/homebrew/bin` 与 `/usr/local/bin`
- Linux：`/usr/local/bin/ollama`、`/usr/bin/ollama`、`/snap/bin/ollama`

> **已知限制（如实披露）**：开发与实机验证主要在 Windows 完成，macOS / Linux 未逐项实机验证。
> PDF 读写走 pdf-lib / PDF.js，本身跨平台无差别；唯一平台差异是上面这组「找 ollama 可执行文件」的路径，
> 找不到时给提示而不是报错崩溃。

> 历史更新记录里若出现 `local-ai/ollama/`、`%USERPROFILE%\WorkBuddy\...`、`start-ollama.bat`，
> 都是 3.8.0 之前的开发期写法，**已在 3.8.0 全部移除**。正式版只认厂商标准安装位置。

---

## 1. 双形态：窗口插件 + 预览扩展

Eagle 4.0 的插件类型里，本插件同时注册了两种身份：

| 形态 | 声明位置 | 触发方式 | 用途 |
| --- | --- | --- | --- |
| **窗口插件** | `manifest.main` | 插件面板点击 / 选中条目后按 `P` | 大窗口精读、多文档切换、完整标注与笔记 |
| **预览扩展** | `manifest.preview["pdf"]` / `["mp4,mov,…"]` | 资源库中选中 PDF 或视频 **按空格** | 把 Eagle 默认的预览换成插件阅读器 |

```
"preview": {
  "pdf":   { "viewer": { "path": "index.html", "allowZoom": false } },
  "mp4,m4v,mov,webm,mkv,avi,ogv,wmv,flv,mpg,mpeg,ts,3gp": {
    "viewer": { "path": "index.html", "allowZoom": false }
  }   // 3.3.2：key 必须是扩展名，写 "video" 不生效
}
```

**为什么预览里也能入库**：Eagle 的预览 webview 使用 preload `js/plugin/api-format-extension.js`，
它注入了**完整的 Eagle Plugin API**（`item / library / shell / app …`），并在 `dom-ready` 阶段
写入 `window.eagle.plugin.path` 与 `window.eagle.library.path`。
因此按空格打开的阅读器同样能高亮、摘录、写入注释、存入资源库——不是阉割版。

预览 URL 形如：

```
file:///<插件目录>/index.html?id=<条目ID>&path=<PDF绝对路径>&width=&height=&lang=&theme=
```

插件启动时解析 `id` / `path` 直接定位到当前文档，并给 `<body>` 加 `mode-preview` 进入紧凑布局。
3.1.0 起**两栏都不再支持折叠**（折叠后右栏会找不回来，见更新记录第 8 条）：
右栏（摘录 / 笔记 / 知识库）始终可见，`mode-preview` 下窗口窄于 900px 时自动收左栏（目录 / 缩略图 / 搜索），
保证按空格进去第一时间看到的是「文档 + 摘录」，而不是一片空白或一个关掉的面板。

### 更新记录 · 4.2.12（md 投影下线 + 别名索引随库）

- **Markdown 知识库功能整体下线**：不再生成任何 md / README / assets 文件。权威数据始终是 `.eaglenote\docs\*.json`（条目 id 稳定、含坐标/时间轴/附件），AI 知识库直接读 JSON；md 需要时将来可随时按需再生成，删除不丢任何数据。
- **只保留对 `[[` 引用有用的核心**：全库改名别名索引（`.eaglenote-lib.json`）改放 `<资料库>\.eaglenote\`（与笔记数据同目录），候选把关从「md 开关」改为独立的 `libReady`——`[[` 搜索、双链、改名别名不受下线影响。
- **旧位置索引自动迁移**：启动时按序探测盘根 `Notes Collection from Eagle\<库名>`、v4.2.11 过渡位置 `.eaglenote\md`，命中即把索引搬进 `.eaglenote\`，库内已有不覆盖。
- **工作台设置区瘦身**：「生成 Markdown 知识库」开关、打开知识库根目录、更换位置、立即同步 MD、重建全部 Markdown 五个入口删除；「打开本库笔记」改名「打开本库数据目录」。
- **换电脑目标达成**：整个 Eagle 库文件夹一起搬 → 新机器装好 Eagle + 插件 → `.eaglenote\` 里的笔记数据、附件副本、别名索引原样可用，识别准确。
- 测试：test-v430 重写为 30 项（含 migrateLegacyIndex 迁移行为沙箱）；32 套件 0 失败；verify-features ✅64 ❌0。

### 更新记录 · 4.2.11（md 知识库随库走 + 新建按钮对齐）

- **md 知识库默认位置改到库内**：`<资料库>\.eaglenote\md\`——和笔记数据同一个原则，整个 Eagle 库文件夹搬走，md 镜像跟着走，不再往 E:\ 盘根撒全局的「Notes Collection from Eagle」文件夹。盘根老规则仅在库路径不可写时作为回退保留。
- **旧索引自动迁移**：首次启动把旧位置（盘根 `<库名>\` 下）的 `.eaglenote-lib.json`（改名别名索引）和 manifest 搬进库内，`[[旧名]]` 解析不断链；md 正文不搬，打开对应文档时按权威 JSON 重新生成。库内已有数据不反向覆盖。
- **权限说明**：工作台里自定义过知识库位置的用户不受影响，仍走 `<自定义目录>\<库名>\` 结构。「打开知识库」按钮在随库模式下直接打开当前库的 md 根。
- **AI 知识库说明**：md 是给人看的投影，权威数据始终是 `.eaglenote\docs\*.json`（条目 id 稳定、含坐标/时间轴/附件）。将来接 AI 直接读 JSON 即可，md 可随时重新生成，删除不丢数据。
- **新建笔记按钮与笔记列对齐**（v4.2.10）：宽度收进与笔记卡片相同的 10px 边距。
- 测试：test-v430 24 项（含 setPortableRoot 迁移行为沙箱）；32 套件 0 失败；verify-features ✅64 ❌0。

### 更新记录 · 4.2.10（按钮与笔记列对齐 + 数据层稳定性巡检）

- **新建笔记按钮与笔记列对齐**：宽度收进与笔记卡片相同的 10px 边距（`calc(100% - 20px)` 居中），高度与字号保持紧凑档。
- **数据层稳定性巡检**：笔记库读写、随库迁移、媒体转存全链路回归通过；详见 v4.2.8/v4.2.9 的迁移与媒体管线说明。
- 测试：31 套件 0 失败；verify-features ✅64 ❌0。

### 更新记录 · 4.2.9（新建按钮收窄 + 网页视频灰按钮根治）

- **新建笔记按钮收窄**：不再 `width:100%` 顶满面板两边，高度与字号各降一档（padding 14→9px、字号 13.5→12.5px），底部与 Eagle 原生底栏保持距离。
- **网页视频灰播放按钮根治**：`@[视频](链接)` 里填的不是 .mp4/.webm 直链而是网页链接（B 站、腾讯视频等）时，`<video>` 永远是灰按钮还占一大块。现在直接渲染「▶ 网页视频 · 点击在浏览器中播放」卡片，走系统浏览器打开，不再放一个播不了的假播放器。
- **网络直链失效兜底**：http 的视频直链加载失败（403 防盗链 / 已下架）时，视频隐藏并在下方补一条「点击在浏览器中打开」的提示，不再无声灰掉。
- **本地媒体失败说明**：本地视频 / 图片（含手写 `file:///` 链接）读取失败时下方给出「文件可能被移动、删除或暂不可用」说明；`file:///` 形式的链接现在会正确转回本地路径再读（之前 fs 直接读 URL 必失败）。

### 更新记录 · 4.2.8（方向键光标 + 笔记随库迁移 + [[残留修复 + Esc 保存确认）

- **方向键移动光标修复**：预览态的光标哨兵只在打字（input）时重画，方向键只改选区不触发重画，看起来像「四向键失效」。现在监听 `selectionchange`，预览态光标跟着选区实时走。
- **Ctrl+→ 跳到本行末尾**（用户点名），Ctrl+← 对称跳行首；Shift/Alt 组合不抢，不影响选区操作。
- **Esc 关闭新建笔记先问保存**：有未保存内容时弹「取消 / 不保存 / 保存」三键确认，不再静默自动保存——之前静默存掉，想反悔都来不及。
- **`[[` 选完候选不再残留双 `[[`**：插入从「[[」之前整体替换（之前从之后拼，`[[[[书#笔记]]` 实锤）。
- **笔记链接可以点开了**：① 预览层的 mousedown 之前一律吞掉并切回编辑态，链接在 click 到来前就被移除——现在放行 `a.wikilink`；② 指向**当前书**笔记的链接直接定位到那条笔记，不再整本书重载一遍。
- **附件徽标放大**：图标换 accent 蓝底圆角块、字号 12.5px、阴影描边，一眼能看见。
- **新建按钮让位**：底部留白加大，不再和 Eagle 原生的前后文件切换条贴在一起（那条 bar 属于 Eagle 本体界面，插件无权关闭）。
- **笔记数据随库迁移**（换电脑刚需）：Store 根目录优先 `<Eagle库>\.eaglenote`——笔记正文、附件副本、粘贴贴图全进库文件夹。整个 Eagle 库搬去新电脑 / 重装 Eagle + 插件后指回同一个库，数据原样可用。首次切换自动把 userData 旧数据一次性复制过来（旧目录保留当备份，`archive-*` 不搬，库内已有数据不反向覆盖）；库目录写不进（只读盘等）自动回退 userData，行为与旧版一致。语音模型体积大，仍留 userData。

- 测试：test-v428 37 项；30 套件 0 失败；verify-features ✅64 ❌0。

### 更新记录 · 4.2.7（媒体管线 + Esc 全修 + 预览光标 + 工具栏图形化）

- **视频黑屏修复**：插件页面跑在 `eagleplugin://` 协议下，`file://` 的视频 / 图片会被 webSecurity 静默拦成黑屏裂图（videoview.js 同款坑）。新增 `mediafix.js`：全局 MutationObserver 扫描所有 Markdown 渲染出的媒体，Node fs 读文件换同源 blob URL，file:// 先试、3 秒看门狗兜底——预览、阅读页、卡片、知识库一处修复，调用方零改动。
- **粘贴图直接显示，不再是一坨编码**：Ctrl+V 贴图先落盘 `<数据目录>/media/`，笔记里只记 `enmedia:<文件名>` 短引用（编辑态不再看 base64 长串），渲染时自动从副本读出显示。
- **附件复制副本**：本地文件附件先 `copyFileSync` 进媒体库，原稿之后被删 / 挪位置，笔记内容与引用不受影响（复制失败才退回原路径）。
- **图片 / 视频大小调节**：`![图](地址 =300x200)`、`@[视频](地址 =640x360)`、`=300`（只定宽）/ `=x200`（只定高）尾参，Typora 同款写法。
- **Esc 三处全修**：① 笔记栏搜索框 Esc 清空真正生效（根因：全局监听挂在 window 捕获阶段，先于输入框自己的 keydown 把按键抢走）；② `[[` 引用弹窗开着时按 Esc 不再把整个编辑框关掉而弹窗残留——逐层退：有词先清词 → 再按关弹窗（顺带删掉悬空的 `[[`）→ 再按关编辑框（自动保存）；③ 以上都走同一条全局通路，行为一致。
- **预览态光标回归**：停手切渲染后，光标位置画一个闪烁 caret（\u2063 哨兵定位），渲染层保留蓝色焦点框——「能继续打字但看不见光标」的别扭感消除。
- **笔记搜索框卡片化**：独立底色 + 边框 + 阴影，与上方 OCR / 环境条拉开距离。
- **工具栏图形化重做**：列表 / 分割线 / 左中右对齐 / 视频 / 附件换统一 14px 线性 SVG 图标；新增 📎 附件按钮（与「＋ 本地文件」同入口）；删除线按钮改 CSS 划线；**「引用摘录」按钮下线**（大窗编辑时无法回 PDF 摘录，功能不成立，按用户确认移除）。
- 测试：test-v427 48 项；29 套件 0 失败；verify-features ✅64 ❌0。

### 更新记录 · 4.2.6（改名闪灵笔记 + 预览不失焦 + 阅读页 + 工具栏媒体增强）

- **改名**：主插件「Eagle 笔记管理」→ **闪灵笔记**，工作台「笔记工作台」→ **闪灵面板**（manifest、窗口标题、界面、导出 PDF 作者、知识库说明同步）。
- **预览切换永不失焦**（修 4.2.5 痛点）：previewing 不再用 display:none（会把焦点一起没收，打字快就被打断），改为输入框 opacity:0 铺在渲染层底下——焦点始终留在输入框，切到预览后**继续打字，渲染效果实时跟着变**；点渲染区回编辑态，光标原地不动；敲 `[[` 自动回编辑态弹补全。
- **笔记阅读页**：单击卡片 = 定位原文（延时 260ms 区分双击），**双击卡片 = 打开只读阅读大窗**（渲染全文 + 原文引用），阅读页内「✎ 编辑」进编辑器；笔记和摘录卡片都支持。
- **笔记搜索框升级**：放大到与「新建笔记」按钮一个量级；结果标签四项 **全部 / 本笔记 / 全局笔记 / Eagle 库**（「全部」三层合流）；**Esc 一律直接清空**（不再逐层绕）；**空查询点搜索框显示最近笔记**（时间倒序前 10 条，单击定位双击阅读）。
- **`[[` 搜索侧窗加大**：与整张笔记弹窗等高（原来只与输入框等高，用户嫌小）。
- **工具栏增强**：新增**左 / 中 / 右对齐**按钮（md 渲染成 text-align div，内部行内语法递归渲染）；**视频链接按钮**（`@[视频](链接或本地路径)` 预览时变内嵌播放窗口，带空格的本地路径也认）；**Ctrl+V 直接贴图**进笔记（dataURL 内嵌，4MB 上限）。
- **markdown 渲染器**：新增图片 `![alt](src)`、视频 `@[标题](url)` / 视频扩展名自动识别、对齐块；媒体地址白名单（http/data/file/本地盘符），`javascript:` 一律拒收防注入。
- **界面**：面板标签（摘录/笔记/知识库）改内容宽、整组居中——蓝色下划线与文字对齐（之前标签平分整行，线比字宽一大截）。
- 测试：test-v426 36 项；28 套件 0 失败；verify-features ✅65 ❌0。

### 更新记录 · 4.2.5（新建按钮醒目化 + 预览同窗切换 + 三层笔记搜索）

- **新建笔记按钮醒目化**：笔记栏底部「✎ 新建笔记」改为蓝底白字实心大按钮（原来虚线幽灵样式太低调）。
- **Markdown 预览同窗切换**：独立预览栏退役。输入框和渲染效果共用同一块区域——打字时是编辑态，停手约 0.8 秒原地变成渲染效果，点一下渲染区回到编辑（光标/滚动位置保留）。弹窗输入框因此加高到 340px，[[ 搜索侧窗与输入窗等高对齐。
- **[[ 结果展开按钮**：候选超过 24 条时，底部「还有 N 条」提示变成「共 N 条结果 · 点击展开全部」按钮，点一下全量展示（列表内滚动）；换关键词自动收回折叠态。
- **笔记栏顶部三层搜索**：新增搜索框，按优先级自动下沉——①本文献笔记 → ②全局笔记（所有投影书的笔记标题）→ ③Eagle 资料库全部 PDF/视频。层标签可手动切换，Esc 逐层退回（库→全局→本文献→清空），点结果直接打开/定位。排序与 [[ 补全共用同一套相关度打分（拼音 + 开头/词界/中段），库清单 10 分钟缓存不全库频扫。
- 相关度打分/拼音匹配提升为编辑器组件级并导出（`NoteEditor.matchScore`），三层搜索与 [[ 补全排序口径一致。
- 测试：test-v425 39 项全过；27 套件 0 失败；verify-features ✅65 ❌0。

### 更新记录 · 4.2.4（新建笔记大窗 + [[ 侧边搜索窗 + 相关度打分）

- **新建笔记统一居中大窗** —— 笔记栏底部的小编辑区退役，换成「✎ 新建笔记」大按钮；所有新建入口（底部按钮、摘录并笔记、框选并笔记、锚点并笔记、编辑已有笔记）都走同一个居中浮动窗，空间大、支持完整 Markdown 工具栏与附件。
- **[[ 引用独立搜索窗** —— 在大笔记窗里敲 `[[`，候选/搜索窗弹出在编辑器右侧（右边放不下自动挪左边），不再挤在正文里跟随光标；搜索框、拼音、多关键词、高亮能力不变。笔记栏小窗若保留则仍用跟随光标的内嵌模式。
- **搜索相关度打分** —— 之前打一个「c」，中段子串和任意位置的拼音首字母全部算命中，一屏都是沾边结果。现在每个词打分：开头 > 词界 > 中段；单字符拉丁词只有打在开头/词界/拼音首字才算强命中，中段沾边的弱命中直接过滤；候选按相关度降序排列。
- **修**：v4.2.3 部署把回滚快照放在 Plugins 目录内，Eagle 把它们也注册成同名插件，导致「升级后仍显示/运行旧版」。快照已迁至 `plugin-snapshots\`，此后不再写入 Plugins 目录。

### 更新记录 · 4.2.3（拼音搜索 + 全库候选 + 空态提示 + 修弹窗自己冒出来）

- **修：一开笔记栏就冒出双链弹窗** —— v4.2.2 重构补全弹层时把 `hidden` 初始化弄丢了，弹层随编辑器挂载直接显示。已补回。
- **拼音搜索**：内置 pinyin-pro（vendor，318KB），书名 / 笔记标题全拼、首字母、混合都能搜 —— 「sa」搜出「撒」，「ls」搜出「历史」，中文关键词照常。命中高亮同步升级：按字符下标打 mark，拼音命中的字也亮。拼音库没加载成功时自动退回纯子串匹配。
- **没搜到不再无声消失**：之前没有匹配时整个弹层直接收掉，看着像坏了。现在弹层留着，显示「没有匹配「xx」的书 / 笔记 · 换个关键词试试」，改词接着搜。
- **双链候选扩到全库**：候选不再只限「插件打开过的书」—— Eagle 资料库里所有 pdf / 视频都进候选（后台节流同步，60s 一次，不卡输入）。引用的成立与改名/移动的健壮性：索引只存条目 id + 名字 + 别名（不存路径，移动文件夹不影响）；Eagle 里改名后，旧名自动记进别名（与 4.2.1 书籍改名同一机制），`[[旧名]]` 依旧能跳。

### 更新记录 · 4.2.2（打开即播 + 补全弹层真搜索框）

- **视频打开即播**：之前打开视频只做预取，停在首帧等人按空格；现在 `open()` 主动调 `play()`，打开就出声出画。流没就绪时 `play()` 被内核拒绝的，等首帧到了自动补播一次（用户若已手动暂停则不打扰）。
- **`[[` 补全弹层自带真搜索框**：之前弹层顶部只有一行「敲关键词」的提示文字，点它焦点就离开编辑框，blur 直接把整个弹层收了——想搜笔记根本进不去。现在弹层顶部是一个真正的搜索输入框（钉在顶部不随列表滚动），点进去直接打字，结果实时过滤；打字同步回写进 `[[` 后面，编辑框里打、搜索框里打都走同一套过滤；键盘 ↑↓/Enter/Esc 两边通用；弹层加宽、列表区限高 260px 内部滚动。

### 更新记录 · 4.2.1（引用搜索 + 字幕后台就绪 + 四方同步加固）

- **引用弹框搜索**：`[[` 候选支持空格分隔的多关键词 AND 过滤；不用先敲 `#`，直接敲笔记关键词也能搜到笔记；命中片段高亮，空查询时顶部提示搜索用法。
- **字幕后台就绪**：打开视频即自动开始转写（引擎与模型已就绪时，绝不偷偷下载），字幕面板保持不弹出；顶栏「字幕」键亮运行小绿点，转写状态一眼可辨；音频通道偶发未接上时在视频首次出声时自动补试一次。
- **四方同步审计（Eagle 条目 / 投影 md / manifest / 笔记库）**：
  - 修复改名断链：条目改名后，别的书里已写的 `[[旧名]]` 现在经 manifest 别名（aliases）解析到新条目，反向链接面板同步认账、上下文摘录照常；
  - 修复孤儿覆盖：manifest 清单丢失/损坏时，覆盖磁盘同名 md 前先备份为 `.orphan-<时间戳>.md`，不再可能静默丢外部手改。
- **稳定性与打开速度**（功能/界面/交互不变）：视频 blob 兜底从同步读整文件改为异步读（大文件不再冻 UI）+ 在飞保护；`preload=auto` 打开期间预取数据；打开视频时的投影写盘延后到界面出来之后（loadToken 守卫快速切换）。

### 更新记录 · 4.2.0（双链升级：笔记级引用 + 层级补全选择器）

- **引用到笔记层**：新语法 `[[书名#笔记标题]]`（可带 `|别名`）——点击先打开书，再定位到正文第一行匹配的那条笔记（切到笔记页、高亮、滚进视野）；匹配不到时提示但不丢链接。笔记标题口径 = 笔记正文第一行剥 Markdown 记号截 60 字（`WikiLink.noteTitle`，补全 / 跳转 / 反链三处共用）。
- **补全选择器重构**：`[[` 触发的候选从平铺书名改为**层级树**（书名分组 → 笔记缩进项），随输入实时过滤，`书#笔记` 两级查询；行数封顶 24 + 「还有 N 条 · 继续输入缩小范围」提示，弹层限高 240px 内部滚动——条目多不再糊满半屏。当前书不出书级候选，但自己的笔记可被互链（`[[本书#另一条笔记]]`）。
- **索引与反链**：manifest 新增 `nt` 字段（每本书的笔记标题，writeNow 落盘、老条目从 Store 惰性回填）；`[[书#笔记]]` 按书名段计入反向链接，反链面板过滤自身；补全树 15s 缓存，写盘即失效。
- **修复：点双链必弹红色「Failed to open」**——`#panel` 的 Markdown 外链委托把双链锚点（`href="javascript:void(0)"`）也交给 `shell.openExternal`。现在委托跳过 `a.wikilink`，且 `Bridge.openExternal` 只放行 http/https/mailto。
- **字幕弹窗**：宽度 400→320px、高度收窄；进入视频模式**不再自动弹出**，点顶栏「字幕」键打开。

### 更新记录 · 4.1.1（左右对调）

- 布局对调：摘录 / 笔记栏移到**左侧**，PDF / 视频阅读区移到**右侧**（网格 `--panel-w + 1fr`）。
- 配套：面板分隔线 border-left → border-right；顶栏弹出面板（目录 / 缩略图 / 搜索 / 字幕）仍锚在阅读区顶栏按键下方，行为不变。

### 更新记录 · 4.1.0（界面重构：左栏移除 + 环境检查弹窗重设计）

- **左侧栏整体移除**，阅读区一栏独占，空出的宽度全部给右侧摘录 / 笔记栏（340 → 420px）：
  - **目录 / 缩略图**：改为顶栏最左侧两个按键的**弹出面板**（互斥开合、点外部关闭、ESC 逐层收起、带关闭键）；
  - **搜索结果**：从「左栏顶替目录」改为锚在搜索框正下方的弹出面板，行为不变（边输边搜、Enter 逐个跳、ESC 只退搜索）；
  - **实时字幕**（视频）：改为顶栏「字幕」键的弹出面板（400px 宽），**进入视频模式自动弹出**，保持原「字幕常驻」的使用习惯；精修 / 语境 / 专业领域 / 存为笔记等工具行原样保留；
  - **阅读历史**：左栏 UI 移除；数据照常记录，工作台「最近阅读」与「清空阅读历史」是同一份数据的入口，功能不受影响。
- **首次安装的环境检查弹窗重设计**：盾形徽标头部 + 「还差 N 步 / 全部就绪」摘要行 + 条目卡片化（缺项左侧橙色竖条、就绪项淡化为绿色），底栏加分割线，「重新检测」改为显式按钮。文案与检测 / 下载 / 代跑 pull 的逻辑不变。
- **笔记区优化**：右栏底部的新建 / 编辑区做成抬起的「纸」（上边框 + 投影 + 输入框退一层底色），笔记卡片加大内边距与悬停阴影。
- 细节：缩略图面板 DOM 常驻（重开不再整列重画，只同步当前页高亮）；字幕多选时「存为笔记(N)」的紧凑模式改挂在新的 `.sub-tools` 行上。

### 更新记录 · 4.0.0（双链笔记 · 文档级全链路）

- **语法**（Obsidian 兼容，不发明新格式）：正文里写 `[[书名]]` 链接到另一本投影 md（书名 = Eagle 条目名去扩展名），`[[书名|别名]]` 显示别名。块级 `[[书名#ec:xx]]` 留给 4.1（ec 锚点已存在）。
- **新模块 js/wikilink.js**（纯函数，vm 可测）：parseLinks / distinctTargets（归一化去重、排除自链）/ linkContexts（反链上下文摘录）/ normalize。行内代码与代码块里的 `[[..]]` 不算链接，索引与渲染同口径。
- **索引层**：writeNow 时从投影文本解析出链写进 manifest[id].links（md 正文一个字不动）；hash 未变也补齐老条目的 links 字段（升级自愈）；反链运行时聚合（backlinksOf），**不写进 md 正文**——避免 A↔B 写循环，E 盘文件保持 Obsidian 双开可用。老 manifest 条目无 links 字段时惰性读盘补算。
- **渲染层**：markdown.js 的 stash 通道里插 `[[..]]`（转义安全，行内代码天然保护），渲染成无 href 的 `a.wikilink` + data-wtarget，点击走全局事件委托。
- **跳转**：manifest 书名归一化对账 → 条目 id → Eagle getItemById → 插件内 openItem；未投影的书走资料库搜索兜底；都找不到给可读提示（链接先留着）。改名不断链。
- **编辑器补全**：敲 `[[` 弹书名候选（数据源 = manifest 全部书名，排除当前书），↑↓ 选择、Enter/Tab 确认、ESC 只关下拉不往全局 Esc 栈漏。
- **反链面板**：笔记列表底部「⟲ 反向链接 · N 篇」，每条带上下文摘录（最多 3 段/篇），点击跳到来源书。

### 更新记录 · 3.41.2（置顶栏场景 ESC = 返回资料库）

- 实测反馈：从置顶栏进工作台，ESC 会「退到插件」（收起工作台露出背后无文档的插件界面），而右上角 ✕ / 「返回资料库」直接关窗回 Eagle 资料库——三个出口行为不一致。
- 经确认改为：**背后无文档的窗口（置顶启动器 / 顶栏图标）里，ESC 也走 returnToLibrary**——关窗回资料库，和「返回资料库」同一条路（App.exit 存草稿 → closeSelf，未保存笔记不会丢）。背后有文档（摘录 / 笔记界面进来）时 ESC 仍然只收起工作台，回到摘录笔记界面——「ESC 只收层不关窗」的铁律在有用回落处时保持不变。
- 实现：workbench.js 新增 escBack() 作为 ESC 层处理器（Esc.push 注册），app.js 的 ESC 兜底列表（closeVisibleOverlay）同步改用 escBack；打开文档流程的两处 Workbench.close() 保持纯收起（加载新文档不能顺手关窗）。

### 更新记录 · 3.41.1（意见清单十项）

- **模型下拉黄圈**：`.ai-prov:focus` 去掉浏览器默认焦点环，改走全局 accent 焦点风格（描边 + 软光晕），点别处自动消失。
- **「加入笔记」常驻可见**：`.ai-msg-foot` 取消「悬停才显形」（opacity 0 → 1），触屏 / 不悬停也能看到。
- **分段总结折叠**：中间分段提炼的消息默认折叠（label 带 ▸ 展开 / ▾ 收起），只留「最终总结（全文）」作主结果——map-reduce 本来就会合并，这次解决的是几段要点盖过总结的观感问题。
- **有道智云（付费密钥）渠道下线**：translator.js 引擎表、划词翻译设置面板（appKey/appSecret 输入行）、index.html 提示语、清数据保留清单里的 `eaglenote:tryoudao` 全部移除；保留有道**免密钥**（aidemo）渠道与本地模型 / MyMemory。
- **右侧笔记栏按钮焦点蓝框**：`.panel-head button:focus` 同步去焦点环（与 3.41.0 的 panel-tabs 一致），ESC 后不再残留蓝框。
- **工作台「返回」按场景分流**（`Workbench.returnToLibrary`）：背后有文档（摘录 / 笔记界面点进来）→ 文案「返回刚才的摘录笔记界面」，只收起工作台；背后无文档（置顶启动器 / 顶栏图标）→ 文案「返回资料库」，直接关窗回到 Eagle 资料库（走 FrameWin.closeSelf，和标题栏 ✕ 同一条路）。
- Eagle 里重命名条目 → 投影 md 同步改名（fileOf 按 manifest.title 重算，writeNow 写新文件后删旧文件），笔记内容不丢；本条为行为确认，无代码改动。

### 更新记录 · 3.41.0（下线 Kimi 双通道；AI 回复 Markdown 呈现）

- 按需求移除 Kimi 网页壳（js/kimiweb.js 整个模块、webview 面板 CSS、index.html 挂载、app.js 的 getFilePath）与 Kimi API 通道（provider/kimiKey/kimiModel 及其设置行），模型通道收敛为两条：本地 Ollama（默认兜底）+ 自定义 OpenAI 兼容接口（推荐智谱 GLM-4-Flash 免费档）。
- 旧配置自愈：localStorage 里 provider 存过 kimi / kimiweb 的自动回退 local，残留的 kimi 字段加载时清理，弹窗不会失效。
- 修复 AI 消息从未真正渲染 Markdown 的老问题：markdown.js 的 `Markdown` 是词法全局（不在 window 上），aisummary 里 `window.Markdown` 恒为 null、renderMd 一直退化为纯文本。现在两条路都探测，总结 / 追问 / 分段要点全部按 Markdown 渲染；流式过程中 120ms 节流渲染，close 时最终渲染；入库（加入笔记 / AI 摘句）保存原始 Markdown 文本不变。
- .ai-md 补齐代码块 / 表格 / 引用 / 分割线样式。

### 更新记录 · 3.40.3（登录成功却报「网页壳不可用」——拆掉总结入口的静态门槛）

- 实测暴露：登录/扫码都成功了（证明 webview 实际可用），点总结却报「Kimi 网页壳不可用（静态探测没认出 webview 标签）」。根因：3.40.1 只拆了 ensureView 的静态预否决，但 aisummary 的 kimiwebChat / kimiwebFileSummary 入口还挂着 `if (!KW.available)` 的静态探测门槛——静态探测在这个窗口误报，把实际可用的通道拦死。
- 修复：两处门槛改为只检查「模块是否加载」（typeof sendText/sendFile === 'function'），实际可用性完全交给 ensureView 的运行时裁决（loadURL 存在性）。设置行状态格同步改为「实际会话状态优先」：面板开着/会话就绪时直接显示会话状态，不再显示探测失败的文案。


### 更新记录 · 3.40.2（预览窗口逃逸口：一键转到插件窗口形态）

- 实测确认：双击 PDF 打开的是「格式扩展预览窗口」（Eagle `openPreview` 路径），其 webPreferences **没有** webviewTag —— 而 manifest.main 的「插件窗口形态」才有。之前所有 webview 修复都正确，但用户常用的入口恰好是没有 webview 的那个。
- 从 Eagle 源码挖出官方通道：主窗口 renderer 挂着 `ipcRenderer.on('open-plugin', pluginId => pluginModule.openPluginById(pluginId))`，而预览窗口的 `window.parentID` 正是主窗口 webContents id。于是 kimiweb.js 新增逃逸口：`ipcRenderer.sendTo(parentID, 'open-plugin', 'LB7PDFRDK3QM')` 直接请求 Eagle 打开插件窗口形态（那边 webview 可用）。
- 交互：预览窗口里点「登录 / 打开窗口」→ 自动发 open-plugin 打开插件窗口，状态文案指引用户在那边用 Kimi 网页通道；状态格自动区分「预览窗口（可跳转）」与「非 Eagle 环境」两种不可用原因；不可用报错全部带跳转指引。


### 更新记录 · 3.40.1（网页壳探测误报修复：多重信号 + 运行时裁决）

- 问题：3.40.0 里点「登录 / 打开窗口」看似没反应，状态一直显示「当前环境不支持」。根因是探测方式不可靠——`createElement('webview').constructor.name` 在 Electron 生产构建里类名可能被压缩改名，静态探测误报「不可用」，而登录入口又被这个误报挡住。
- 修复：
  1. 静态探测改三重信号：Electron 注入方法（`getWebContentsId`，最权威）→ `customElements.get('webview')` 注册表 → 类名兜底；
  2. 建窗环节不再被静态探测一票否决——运行时用 `loadURL/executeJavaScript` 是否存在做最终裁决（HTMLUnknownElement 一定没有这些方法，这是 definitive 信号），失败时报错精确到「这个窗口没启用 webview 标签」并回收面板节点；
  3. 新增 `KimiWeb.probe()` 实测通道（真建一次 webview 并打开 Kimi 首页），「检测」按钮从「发条消息测试」改为无副作用的 probe；登录/检测的成败都写进状态文案，不再只写状态栏。
- 佐证：已核实 Eagle 官方源码（app.asar）中插件窗口 `webPreferences` 明确带 `webviewTag: true, nodeIntegration: true`，所以主窗口插件里 webview 一定是开的，之前是探测误报。


### 更新记录 · 3.40.0（网页壳改架构：@electron/remote → 页内 webview）

- **实测推翻旧方案**：插件页 require 不到 `@electron/remote`（模块查找路径
  不含 app.asar/node_modules），且 Electron ≥14 还要求主进程对每个
  webContents 显式 `enable(remote)`，插件窗口没有 —— remote 这条路在
  插件页里走不通（bridge.js 的关窗能工作是因为有 IPC 兜底，掩盖了这一点）。
- **新架构**：翻 app.asar 确认插件窗口 `webviewTag: true`，改用页内
  `<webview partition="persist:kimiweb">`：
  登录态照样落盘；提问/读回复走 `webview.executeJavaScript`（宿主页轮询
  驱动）；文件直传改为宿主页 Node fs 读 PDF → base64 分块（2MB/块）推入
  guest → 页内 `new File` + `DataTransfer` 注入 `input[type=file]`
  （React onChange 正常触发），**彻底摆脱 remote / CDP 依赖**；
  文件上限 80MB，超出明确报错并自动兜底到文本通道。
- **登录面板**：webview 默认藏在屏幕外（保持渲染，任务照常跑），
  点「登录 / 打开窗口」滑到屏幕中央，扫码后点面板 ✕ 收起（ESC 也只收面板）。
- 能力探测改为 `createElement('webview')` 惰性判断（WebviewElement vs
  HTMLUnknownElement），不缓存失败；空格预览（无 webviewTag）给出
  明确指引「从 Eagle 主窗口进入」。
- 伴生「笔记工作台」版本号对齐 3.40.0（无代码变化）。


### 更新记录 · 3.39.2（网页壳可用性：惰性探测 + 诊断信息）

- **修实际使用报「Kimi 网页壳不可用」**：旧版在脚本加载那一刻探测
  `@electron/remote` 并缓存结果，而 Eagle 向插件页注入 require 的时机可能晚于
  脚本执行 —— 加载时探测失败就永远不可用。改为**惰性探测**（每次调用时再试，
  成功才缓存；与翻译模块 `require('child_process')` 同款语义）。
- 不可用时给出**分层诊断**：没有 require（空格预览 / 浏览器形态，提示从
  Eagle 主窗口进入）／require 在但拿不到 remote（版本差异）——不再笼统说
  「环境不支持」。
- 伴生「笔记工作台」版本号对齐 3.39.2（无代码变化，出包惯例）。


### 更新记录 · 3.39.1（AI 总结本地 Ollama 兜底）

- **本地兜底**：非本地通道（Kimi 网页 / 自定义接口 / Kimi API）失败时，
  自动改用本地 Ollama 重试一次 —— 总结与追问都生效。兜底前在消息流里
  插一条灰底「兜底」通知（失败原因 + 已切换），完成态标注「本地模型（兜底）」，
  **绝不静默换模型**；用户主动「停止」不触发兜底。
- 兜底是会话级临时切换（`chatCollectFB` 内部换 provider 再还原），
  **不改用户保存的通道设置**；本地也失败时抛**原始**错误（那才是根因）。
- Kimi 网页文件直传失败（没登录 / 前端改版 / 上传超时）→ 报明原因后
  落到本地文本管线继续总结（提取全文 → 兜底通道），不整场报废。


### 更新记录 · 3.39.0（AI 总结四通道：Kimi 网页壳 + 自定义 OpenAI 兼容接口）

AI 总结的模型通道从 2 条扩到 4 条，弹窗左上下拉切换：

- **Kimi 网页（会员）**：新增 `js/kimiweb.js`。用 @electron/remote 建一个隐藏
  BrowserWindow（`persist:kimiweb` 分区，登录态落盘，重开 Eagle 不掉），首次在
  设置里点「登录 / 打开窗口」扫码登录一次。总结时**整份 PDF 直传网页**
  （CDP `DOM.setFileInputFiles` 注入文件输入框，即 Playwright 同款机制），
  由网页 Kimi 自己解析长文 —— 没有上下文切段的损失；追问复用同一场会话，
  上下文网页端自己记得。回复靠轮询 DOM（文本稳定 + 无停止按钮 = 完成），
  伪流式增量上屏。诚实声明：网页自动化不在会员协议覆盖范围内，节制使用；
  Kimi 前端改版壳会失灵，所有选择器可配置（localStorage `eaglenote.kimiweb.cfg`）。
- **自定义接口（OpenAI 兼容）**：填 baseURL + Key + 模型名接任何兼容服务，
  默认预填智谱 `glm-4-flash`（免费不限量，open.bigmodel.cn 注册即用）。
- Kimi API / 本地 Ollama 通道不变，仍是默认兜底。
- 代码层：Kimi API 的 SSE 调用重构为通用 `openaiChat(base, key, model, …)`，
  四通道共用一条 OpenAI 兼容实现；`chat()` 按 provider 路由；
  网页壳新会话把 system 并进首条 user（网页没有 system 角色），
  map-reduce 自然退化成连续对话（第 1 段发起新会话、后续各段是追问）。
- `app.js` 给 AI 总结注入 `getFilePath`（本地 PDF 路径，供网页壳直传）；
  `index.html` 挂载 `kimiweb.js`（在 aisummary 之前）。


### 更新记录 · 3.38.0（一键 AI 总结全文 + 追问 + 摘句入笔记）

顶栏新增「AI 总结」（视频模式隐藏）：弹窗把全文交给模型，流式出一份结构化总结
（一句话总结 / 核心要点 / 关键数据 / 结论），总结完可以继续追问，
**AI 消息整条或选中其中几句都能一键存成笔记**（统一加来源标记，可撤销）。

- **双通道**：本地 Ollama（默认，免费不外传，和翻译共用本机模型）；
  Kimi API（Moonshot 开放平台，OpenAI 兼容）。注意 Kimi 会员 ≠ API 权限，
  key 要在 platform.moonshot.cn 单独创建、按量计费；WorkBuddy 积分是会话内算力，
  插件没有通道调用，不接。
- **长文不截断**：正文超过模型预算时按页切分，先逐段提炼再合并（map-reduce），
  各段中间过程灰底可见；扫描页（无文本）自动跳过，纯扫描件给出明确提示。
- **流式**：ollama ndjson 与 OpenAI SSE 都按块解析、坏行容忍；
  模型 keep_alive 10m，总结 + 追问全程不掉显存。
- **存笔记**：整条消息悬停出「加入笔记」，正文选中文字出浮标（AI 摘句）；
  入库走 addAiNote（persist + 投影同步 + Undo 可撤销）。
- ESC 语义不变：弹窗注册进浮层栈，ESC 只关弹窗，绝不关插件。
- 新增 `test-v340.js`（71 项）：切分 / SSE+ndjson 解析 / 提示词组装 / 假流式全链路 /
  配置预算 / 静态挂接断言；v338 隐藏清单断言同步更新。


### 更新记录 · 3.37.0（知识库两条新语义：空内容不建文件 + Eagle 注释栏双向同步）

上一版遗留的两件事一起了断：

- **空内容不建 md**：没有摘录、笔记、Eagle 注释就不落盘，产生第一条内容才建文件；
  内容清空（且没有手记）→ 整个文件连同 assets、清单条目一起回收。
  起因是「打开即投影」：三部只点开没记笔记的视频在 E 盘留下三篇空壳 md，
  清掉之后一打开又长回来——现在文件只跟着内容存在。
- **Eagle 注释栏（注释框）双向同步**：Eagle 条目 metadata 的 `annotation`
  投影为 md 里受锚点保护的 `## Eagle 注释（双向同步）` 区块（`<!-- eagle:ec:… -->`）。
  在 md 里手改 → 通过官方 API（`item.annotation` + `save()`，HTTP API 兜底）写回 Eagle，
  Eagle 界面实时可见；在 Eagle 里改 → 投影进 md；两边都改 → md 优先，
  Eagle 那一版进 `.conflict` 备份（与摘录批注同一套冲突语义）。
  写回与 Eagle 落盘的时差用 15 秒覆盖窗口处理，异步写回未完成前 build
  不会被旧值冲掉；写回失败（Eagle 没开等）留在队列，下次有写回时重试。
- 注释栏非空也算「有内容」：给条目写了注释，下次同步就会建 md。
- 新增 `test-v339.js`（34 项）：空壳不建/回收/手记保壳、ec 三向同步
  （Eagle→md、md→Eagle、双改冲突）、不重复写回、解析器三锚点。


### 更新记录 · 3.36.2（按交互规范做代码体检：1 处 P2 修复，行为零变化）

把散在 60 版更新记录里的功能 / 布局 / 交互要求整理成规范
（`deliverables/插件功能与交互规范.md`），再按规范逐条对代码做体检：

- **P2 唯一一处**：全库索引 `index.json` 一直是直接覆写，
  与 docs / trash / daily / manifest / md 正文（全部 tmp+rename）不一致，
  写一半崩溃会留下半个索引文件。补成 tmp+rename 原子写。
- 其余核查全部通过：ESC / 退出链路无隐藏关窗路径；escapeHtml 覆盖引号、
  Markdown 链接协议白名单且 URL 预转义，注入面干净；输入法保护 3 处、
  keyup 220ms 兜底、视频顶栏隐藏清单与记录一致；45 处 `==` 全是 `== null` 惯用法。
- 新增 `test-v338.js`（45 项）：Undo 模块 vm 真跑（此前一直是「有实现、无测试」）、
  index.json 原子写、escguard 四档行为级断言、交互铁律静态断言。


### 更新记录 · 3.36.1（代码瘦身：功能、交互、界面不变）

纯清理，没有任何功能或界面变化：

- 删掉从未被调用的 `downloadBlob()`、`hasMods()`，以及 30 多个无人使用的私有导出别名
  （`Subtitle._*`、`Translator._*`、`Asr._*` 等早期测试钩子），内部实现保持原样。
- 删掉 CSS 里 38 条没有对应元素的旧版样式：旧知识库卡片 `.kbc-*`、早期语音输入
  `.mic-*` / `.np-mic`、`#noteInput`、`#btnQuit`、`.topbar-center` 等；
  PDF.js 运行时生成的 `.markedContent` / `.endOfContent` 予以保留。
- 源码减少约 850 行。全量回归 977 项断言 0 失败，功能自查 82 项 ❌0。


### 更新记录 · 3.36.0（清除插件数据后，知识库里还留着 md）

点「清除插件数据」，`data\` 清干净了，但 `E://Notes Collection from Eagle\` 里还躺着两篇 md。
查下来是两件事叠在一起：

**① 库名拿不到就退成 `Eagle`。** Eagle 的 `eagle.library` 常常只给 `path`、不给 `name`，
`safeName(libraryName || 'Eagle')` 于是把子目录算成 `...\Eagle`，还真的 `mkdir` 了一个出来。
两篇 md 明明在 `...\DY - Clinical Surgery\`。

**② clearAll 只清「当前 root」。** 清除时 root 指向那个假的 `Eagle`，
清单里认领的文件在那儿一个都不存在 → 一个文件都没删掉，真正的目录原地不动。

改法：

- 新增 `libDirName()`：`name` → `<库>.library` 目录名反推 → 都没有就返回空（**不编名字**）。
  `relocate` / `bridge` 都改用它；库名完全不明时宁可不写，也不造目录。
- `clearAll()` 改成扫**整个知识库根**：每个带 `.eaglenote-manifest.json` 的子目录各清一遍，
  按各自清单认领，删 md、删 assets 里的副本、撤清单；目录只剩空壳就一起收掉。
- 「清除插件数据」不再用 `Projection.isOn()` 拦着 —— 开关关着时历史副本最容易漏。
- 用户往目录里放的文件照样不动：有非插件文件就保留目录，没有清单的目录直接跳过。

`test-v337.js`（27 项）用真文件系统造两个库目录验证：两处都清干净、目录收掉；
手写 md 保留；没有清单的目录不碰；`libDirName` 三种取法；`relocate` 不再生 `Eagle`。


### 更新记录 · 3.35.1（装上就弹红条：refreshPath is not defined）

3.35.0 装完一打开工作台就是一条红色横幅「异步异常：refreshPath is not defined」，
两个插件都中（启动器一跳回主插件就一起炸）。根因不在 `refreshPath` 本身，而在**它待错了闭包**：

```
const Workbench = (function () { … render() { … refreshPath(); } … })();   ← 调用方
const Trash     = (function () { … function refreshPath() { … } … })();    ← 定义被塞进了这里
```

两个 IIFE 各是一个独立作用域，函数声明的提升也只在自己的块里生效。于是每次渲染工作台
都抛 ReferenceError，被 `app.js` 的 `unhandledrejection` 兜住，就成了那条红条。

- `projText` / `refreshPath` 移回 `Workbench`（和 `render` 同一层），`Trash` 的导出表删掉这两项；
- 工作台导出加上 `refreshPath`，`app.js` 换目录后能就地刷新那行路径。

为什么没被测试抓住：旧断言只查 `has(WB, 'refreshPath')` —— 字符串在不在，和它能不能被调用是两件事。
`test-v336.js`（25 项）改成两类：
1. **真跑**：`vm` + 假 DOM 执行一遍 `Workbench.render()`，跑通才算过（就是用户看到红条的那条路径）；
2. **作用域体检**：对每个 `const X = (function () { … })();` 扫描内部调用的名字，必须是本块声明的、
   文件级的，或语言内置的。并附一段「上次那种插错位置」的最小复刻做检测器自检 ——
   否则这条检查可能永远是绿的，等于没测。


### 更新记录 · 3.35.0（笔记变成资源管理器里能逛的知识库）

目标变了：以前 Markdown 是「藏在资料库里的副本」，现在它是**你能在 Windows 里直接看到、直接改的知识库**。

```
E://Notes Collection from Eagle\
├─ README.md
└─ DY - Clinical Surgery\
   ├─ 膜解剖实战 - 保脾胰体尾切除术.md
   ├─ LSPDP 保脾胰体尾.md
   └─ assets\<条目 id>\*.png
```

- **位置**：默认 `E://Notes Collection from Eagle`（E 盘不可写就依次试 D/F，最后退回「文档」）；
  选目录时真写一个探针文件，只读盘会被跳过。工作台可「更换位置…」，选过的目录记在偏好里。
- **命名**：文件名就是书名。两个条目撞名时，后来的那个才追加 `(条目id后 6 位)`，
  不再让所有文件名都顶一串乱码。**Eagle 里改名 → 文件跟着改，旧文件自动删掉。**
- **一一对应**：frontmatter 里 `eagle:` 是条目 id、`source:` 是源文件真实路径；
  每条摘录、每条笔记各包一对 `<!-- eagle:ex:… -->` / `<!-- eagle:nt:… -->` 锚点注释
  （渲染时看不见，Typora / VSCode 里也不会露出来），四者可以逐条对上。
- **空内容不建文件（3.37）**：没有摘录、笔记、Eagle 注释就不生成 md，产生第一条内容才建；
  内容清空（且没写手记）→ 文件连同图片目录一起回收，磁盘上不留空壳。
- **Eagle 注释双向同步（3.37）**：md 里的「Eagle 注释（双向同步）」区块（`<!-- eagle:ec:… -->`）
  与 Eagle 条目的注释栏互为镜像——在 md 里改会通过官方 API 写回 Eagle（界面实时可见），
  在 Eagle 里改会同步进 md；两边都改过时 md 优先，Eagle 那一版进 `.conflict`。
- **能手改**：改「笔记正文」或摘录下面的批注，保存即可。插件下次打开这篇、
  或你点「立即同步 MD」、或后台每 45 秒那一扫，都会读回来。
  **写之前先读**：投影要先看 MD 有没有被改过，不看就写等于把用户手打的东西冲掉。
- **改不了的**：引用原文、页码、时间点、图片 —— 这些是插件生成来定位高亮的，改了会被还原。
- **自由内容**：文件末尾加一行 `## 手记（不会被插件覆盖）`，那一段原样保留。
- **冲突**：同一段文字两边都改过时以 MD 为准，插件里那份旧值另存成
  `<书名>.conflict-<时间>.md`（不会被「清空」删掉）。
- 旧的 `<资料库>\_notes` 不再更新，里面留一个 `_MOVED-to-知识库.txt` 指路，旧文件一律不动。

测试 `test-v335.js` 用**真文件系统 + 临时目录**跑整条链路：写入 → 手改 → 读回 → 双改冲突 →
手记保留 → 清空，68 项。这一层没法靠字符串断言假装通过。


### 更新记录 · 3.34.1（三个窗口按钮真的能点了）

上一版把 ✕ 改到退出流程上，用户回来一句：**「白色条带没了，不过点 X 还是不行，最小化和最大化也没反应」**。

三个按钮**同时**失效，说明不是三个 bug，而是 handler 一个都没绑上。查下来是启动时序：

```js
init() 要求 isLauncher() && eagle.window 都在
isLauncher() 读的是 Bridge.state.query.launcher
Bridge.state.query 要等 Bridge.ready()（异步，最多等 1 秒 Eagle）跑完才赋值
init() 在同步启动段就执行完了 → 判断恒为假 → return false → 三个按钮全是死的
```

标题栏之所以还看得见，是 `index.html` 里那段尽早打 `frameless` 的内联脚本按
`location.search` 把 `hidden` 去掉了 —— **看得见、点不动**，正好就是用户看到的现象。

改法：

- `isLauncher()` 直接读 `location.search`（与内联脚本同一个正则），Bridge 只作兜底；
- `init()` **不再要求 `eagle.window` 存在**（它同样可能晚到）；
- 动作改走 `@electron/remote` 直连（`minimize` / `maximize` / `unmaximize` / `isMaximized` / `close`），
  `eagle.window` 当第二选择，最后才退 `plugin.window.` 的 IPC 转发 —— 和 Ctrl+W 能关窗是同一条通道；
- 最大化按钮点下去**先切图标**再对状态（窗口动画那 200ms 里图标是旧的话，用户会以为没点上）；
- `init()` 幂等，`app.js` 在 Bridge 连上后再补调一次；
- 按钮单独补一行 `-webkit-app-region: no-drag`（拖拽区按元素算，少这行某些机器上点击会被当成拖标题栏吞掉）；
- 每次动作都写进 `debug.log`（`framewin { act, via }`），下次再有问题不用猜。

> 教训：这条标题栏从 3.20 起就一直在「显示正常、按钮全哑」的状态，
> 因为从来没人点过它 —— 自绘 UI 一定要有「点了之后真的发生什么」的自动测试，
> 光断言元素存在是没用的。这轮补了 54 项，用 `vm` 沙箱 + 假 DOM **真跑一遍 init 再模拟点击**。


### 更新记录 · 3.34.0（顶栏 ✕ 能关窗口了）

用户报：打开工作台，按 ESC 把工作台收起来之后，插件窗口还开着，
此时点插件右上角的 ✕ **没有任何反应**，只有 Ctrl+W 能关。

✕ 早就存在（3.20 给启动器窗口做无边框标题栏时画的），也一直绑着点击事件，
问题是它绑的是 `window.close()` —— 而 Eagle 的插件窗口对 close 有拦截，
这正是 3.28 查出来的那件事：`window.close()` 发出去就没了，不报错、也不关窗。

Ctrl+W 之所以好使，是因为它走的是 `exitPlugin()`：
先 `Bridge.closeSelf()`（remote 直连 `BrowserWindow.close()`），400ms 后窗口还在就
`destroySelf()` 无条件销毁。**✕ 和 Ctrl+W 必须是同一条路**，否则就会留一个
「按了没反应」的假出口 —— 而这已经是这个插件里第二次犯这个毛病（第一次是顶栏那个 ✕，3.30 直接删了）。

改法：

- `app.js` 暴露 `window.App.exit = exitPlugin`（顺带 `closeSelf` / `destroySelf`）；
- `framewin.js` 的 ✕ → `closeSelf()`：`App.exit()` → `Bridge.closeSelf()` + 400ms `destroy` → `window.close()`，
  三级降级，且**不再自己拼一套关窗逻辑**。走退出流程的附带好处：点 ✕ 也会先存草稿；
- 启动器 `workbench.html` 那个 ✕（启动中那一秒可见）也不再裸调 `window.close()`，
  改走 `@electron/remote` / `plugin.window.` IPC。这里**故意不加 destroy 兜底**：
  这个页面下一秒就 `location.replace` 去主插件，销毁会把刚打开的窗口一起关掉。

ESC 的规则不变（3.31 起**永不关窗口**，只往回收一层），Ctrl+W 仍是键盘出口。


### 更新记录 · 3.33.0（白带彻底清掉 · 不再啃正文）

用户反馈「白带还有一点点」，截图只有一个 1462×27 的条带。逐像素量下来是
**画面 → 一行过渡 → 一行白 → 一行灰 → 纯黑 7 行**：白带主体已经裁掉了，
剩下的黑是 `clip-path` 裁完露出的底板，那两行浅色就是**裁剪边界上的残渣**。

三个原因，都不在「阈值」上：

1. **clip-path 的百分比要落到设备像素上取整**。视频 858 行显示成几百 CSS px，
   1 CSS px 就是好几行画面；取整往下抹，边界就留半行「画面 + 白」的混色；
2. **白带上方紧贴着一行 0.97 白的过渡行**。判据只认 ≥0.98，这一行永远被留下，
   它就是那条「细白线」；
3. **上限 5% 卡得太死**。幻灯片实测白带 5.01%，`ceil(858×0.05)=43` 刚好卡在边界，
   少裁一两行。

改法：

- **clip 多裁 1px**：`inset(0 0 calc(P% + 1px) 0)`，边界推进到黑带里；
- **底部压 4px 黑边**：`has-crop` 时 `.vs-frame::after` 出现，clip 再怎么取整，最下面几像素都是黑；
- **裁剪量 +2 行过渡**，上限提到 6.5%。

顺带修掉一个**上一版引入的过度裁剪**：旧判据「白占比 ≥0.42 就算白带」，
遇到白底幻灯片（白带之上就是 0.7~0.95 白的正文）会一路啃到上限，把正文切掉四十多行。
现在改成**三段式匹配**：

| 段 | 判据 | 含义 |
| --- | --- | --- |
| A | 底部整行白（≥0.98） | 白带本身 |
| B | 之上 0.42~0.98 | 烧进画面的进度条 |
| C | 再之上又出现整行白 | 证明 B 确实是白带里的条，不是正文 |

只有 **B≥3 且 C≥3** 才把三段一起裁，否则只裁 A。
另外补了「条贴底」形态（底部直接是条、条上方才是白）。

实测（1920×858 五帧）：裁 12~16 行（1.40%~1.86%），幻灯片段落只裁底部纯白，
不再啃正文。

---


### 更新记录 · 3.32.0（白带真被裁掉 · 卡片不再有一圈白线）

这一版只修两件事，都是上一版「已经修过」的东西 —— 因为上一版的判据本身就是错的。

**① 白带：判据错了，不是裁得不够**

用户三张图（播放器里、截图卡片里、片段卡片里）都是同一条白带。把三张真图和原片
抽帧逐行量了一遍，才看清几何：

| 实测对象 | 尺寸 | 白带行数 | 结构 |
| --- | --- | --- | --- |
| 原始视频（手术画面） | 1920×858 | 37 行（4.31%） | 白 16 + 进度条 10 + 白 11 |
| 原始视频（幻灯片） | 1920×858 | 39 行（4.5%） | 白 → 进度条（76% 白）→ 白 |
| 截图.png | 1920×858 | 39 行 | 同幻灯片 |
| 片段.png | 1920×842 | 21 行 | 上一版只裁掉 16 行，条还留着 |

两个死结：

1. **左右是黑边**。白带只横跨中间 1282 列，占整行 66.7% ——
   「整行 99% 是白」这个判据永远不成立，一行也裁不掉。
2. **白带里烧着播放器进度条**。那 10 行只有 69% 是白，
   「连续纯白」走到条这里就断，只裁到条下方的 16 行，条留在画面里。

改法（`videoview.analyzeBand`，`imgcache.whiteRows` 同一套判据）：

1. 先量**内容列范围**（整幅均匀取 24 行，找最长的非「接近纯黑」列连续段），之后只在内容列里判白；
2. 「白 → 进度条 → 白」算**同一块**，中间允许 2 行噪声；噪声行不计入裁剪高度（宁可少裁，不啃内容）；
3. 上限 **5% 画面高**，并且整块里至少要有 3 行纯白，否则判为画面内容、一行不裁。

实测结果：手术画面 38 行（4.43%）、幻灯片 43 行（5%，被上限兜住）、
片段 22 行（条贴底边时也能连条一起裁）、真·画面到底的画面 0 行。

**② 卡片里的一圈白线**

`background: #fff` 配「宽度写 px、高度 auto」，浏览器取整后会从图边漏出 1px 白底 ——
视频来的图（截图 / 框选 / 片段）看着就像被描了一圈白框。视频图改成透明底，
PDF 摘录图（透明底黑线稿）保持白底。

---


### 更新记录 · 3.31.0（ESC 不再关窗口 · 另存为真能弹出来 · 点画面播放 · 白边量得出来 · 图片选中框）

这一版把上一版「修 ESC」的思路整个翻过来了 —— 用户的原话是**「越叠加越乱」**。

**① ESC 不再关插件窗口（三个出口一起拆）**

上一版为了「ESC 一定退得出去」，给出口叠了三层保险，结果三层都成了误退的通道：

| 出口 | 怎么误触发 | 现在 |
| --- | --- | --- |
| `escguard.js` 的 `exit-plugin` 档 | 栈里没浮层就直接退 | **整档删除**，返回 `noop` |
| app.js「连按两次毫无进展就强退」 | 另存为框弹不出来，用户按 ESC 想关它 → 第一下空转、第二下强退 | `escStall` / `escUiSig` / `forceExit` 全部删除 |
| index.html 内联兜底（900ms 没认领就自己调 IPC 关窗） | 真全屏第一下 ESC、输入法选词时都会提前 return 不被认领 → 900ms 后关窗 | **整段删除** |

现在 ESC 只做一件事：**往回收一层**（浮层 → 搜索 → 失焦 → 什么都不做）。
并且 `preventDefault + stopPropagation` 无条件吞掉 —— 宿主 Eagle 收不到 ESC，
也就不会再「跟着一起关界面」。没东西可关时给一句提示：`ESC 只关闭浮层；要退出插件请按 Ctrl+W`。
退出插件统一走 **Ctrl+W**。

**② 另存为真的能弹出来了**

`window.eagle.dialog` 这条通道在预览窗口里**从来没成功过**（debug.log 里每一行都是
`[save.ask] unavailable / 另存为框 120 秒没有响应`）—— 之前那些「2.6 秒焦点判定」
「120 秒看门狗」都是在给一个不存在的对话框打补丁。

Eagle 自己满处 `require('@electron/remote')`，插件窗口也开着 nodeIntegration，所以现在直接：

```js
const rem = require('@electron/remote');
await rem.dialog.showSaveDialog(rem.getCurrentWindow(), opt);   // 真·系统另存为
```

同步等结果，用户不点它就一直开着；没有猜测、没有超时。remote 不可用（宿主关了
`enableRemoteModule`）才退回老的 IPC 通道。截图 / 框选 / 片段三条链共用这一个入口。

**③ 点画面 = 播放 / 暂停**

v3.30 去掉原生 `controls` 之后只补了工具条上那三个键，画面本身没绑任何行为 ——
点了没反应，看起来像播放器坏了。现在 `<video>` 上绑 `click → toggle()`（框选模式下让路），
光标也改成 `pointer`。

**④ 白边：之前根本量不出来**

不是裁得不够，是**取样把白边抹平了**。旧代码把整帧缩到 160px 宽再逐行量：
1920×858 缩完只剩 **72 行**，而白边只有 **10 行** → 按比例是 0.84 行，四舍五入直接没有，
`n < 2` 立刻返回 0，于是「永远检测不到白边」。

现在分两步取：
* 整帧缩略图（200px 宽）只用来判「是不是白底幻灯片」（中间行 ≥98% 白就不动）；
* 底部 6% 的带状区**按 1 画布行 = 1 视频行**取（只缩宽度，不动高度），10 行白边原样保留 → 裁 1.17%。

`test-v331.js` 用假 canvas 把这个 bug 钉住了：同样的数据，旧取样返回 0、新取样返回 10。

**⑤ 点 PDF 里的图片，给它描一圈框**

页面上并排几张图、或图紧挨正文时，只弹工具条看不出点的是哪张。现在点中图片
在 `.pinLayer` 里画一个 2px 描边 + 极淡底色的框（百分比定位，跟着缩放走；
`pointer-events:none` 不挡后续点击），工具条收掉时框一起收。


### 更新记录 · 3.30.0（片段先记时间轴 · 白边 · 专业词表 · 语音下线 · 退出回主窗）

用户一次报了 13 条，其中 6 条其实是同一个设计错误：**片段一按下去就去录文件**。

**① 片段：先记时间轴，要文件时才录**

以前是「按第二次 → 弹另存为 → 实时录一遍 → 才建记录」。于是：

* 弹框那几秒视频停着 → 看着像「第二次点片段，视频莫名暂停」；
* 取消另存 → 右栏什么都没有，明明 A、B 都选好了；
* 录制要按原速跑 → 「并笔记」的输入框被这个 await 卡在后面，永远轮不到弹出；
* 卡片上没有图，笔记里也没有图。

现在 A→B 一定就建记录（预览图后台补），卡片上是
「▶ 00:12 → 00:35 · 23.0s」+ 两个按钮：**预览片段**（在视频窗口里按 A→B 播，到点自停，
不产生文件、不调系统播放器）、**另存为**（这时才真的录）。笔记里同样有预览图和区间。

**② 底部那条白带**

真相是**视频文件本身**最后十几行是纯白（录屏的进度条/滚动条残留）。
三处一起处理：

* 播放器：`clip-path` 裁掉底部（只裁连续纯白、≤6% 高度，白底画面一律不碰），
  下面用黑底接住；同时去掉原生 `controls` —— 它那条深色渐变正好盖住白边，
  鼠标一移开就露出来，所以「鼠标移出画面才出现白带」。换成自绘的播放/静音/全屏。
* 截图 / 框选 / 打点：`drawNative` / `captureFrame` 出图前就裁掉（框选区域不裁，那是用户自己划的）。
* 实时预览：仍由 `ImgCache` 裁。

**③ 视频转字幕：专业词表**

新增 `js/domainterms.js`：医学 148 词、生命科学 106 词，外加 33 条「常见听错 → 正确写法」
（`单囊三角 → 胆囊三角`、`皮动脉 → 脾动脉`…）。字幕面板多一个「通用 / 医学 / 生命科学 /
医学+生命科学」下拉，两处生效：识别热词偏置（解码时偏向这些词）+ 语境校对提示词
（只挑跟这一句沾边的 36 个词，整表塞给小模型它会往句子里硬塞术语）。

**④ 笔记的语音输入整块下线**

三个麦克风入口（右栏编辑器、笔记浮层、每日笔记）+ `js/voiceinput.js` 全部删除。
语音能力没有消失：视频转字幕走的还是 `asr.js` / `subtitle.js`。

**⑤ 退出**

* 顶栏右端那个 ✕ 删了 —— 它只是又一个「按了没反应」的假出口。
* 关窗改走 `@electron/remote` 的 `BrowserWindow.close()`（同步、有返回值），
  IPC 只作兜底。
* 退出前先 `restore + show + focus` Eagle 主窗口。以前会落到「一个最小化的 Eagle」，
  不是被我们最小化了，而是 Eagle 本来就在托盘，插件一关焦点就交回那个最小化窗口。

**⑥ 另存为不再干等**

`askEx` 里加了 2.6 秒的「框到底出没出现」判断：系统模态框一弹出父窗口必失焦，
还带着焦点就说明没弹 —— 立刻返回 `unavailable`，按兜底路径落盘并说明。
以前这里会傻等 120 秒，用户看到的就是「提示正在按原分辨率取帧…，然后没有下文」。
迟到的对话框结果也仍然被采纳（会额外存一份并告知）。

另外「另存原图」的顺序反过来了：**先复制素材目录里的原件**（瞬间、像素一致），
回原视频取帧只作兜底 —— 截图本来就是原分辨率，没必要再 seek 一遍。

**验证**：`test-v330.js` 109 项；全量 **709 项 0 失败**。


### 更新记录 · 3.29.0（摘录图先收进右栏 · 另存只在卡片上 · 全功能自查）

**上一版把方向搞反了。** 3.28 把「图片摘录 / 框选 / 视频截图」全改成**先弹另存为**，
于是一点「摘录」就跳出系统对话框，收集动作被打断成归档动作。用户的原话是
「应该先保存到右侧栏，在右侧栏如果需要另存我再操作」——所以动作分家：

| 动作 | 现在 | 文件去了哪 |
| --- | --- | --- |
| 图片摘录 / PDF 框选 / 视频截图 / 视频框选 | **不弹框**，直接收进右栏 | `<数据目录>/media/文档名-p3-框选.png` |
| 卡片上的「另存原图」 | 才弹另存为 | 你选的位置（原字节复制，不重新编码） |
| 片段（A→B） | 仍然弹另存为（按 3.28 的要求保留） | 你选的位置 |

* `keepImageLocally()`：写进 `<dataDir>/media/`，同名自动 `(2)`，索引里**仍只记路径**；
* `copyImageFileAs()`：卡片另存时**读原文件按字节写**，像素与摘录时一模一样，
  不再走 `ImgCache.dataUrl` 的「解码 → 缩放到 1800px → 再编码」那条路；
* 视频记录的「另存原图」优先回原视频重新取帧（比截图那张还大），取不到才复制已存文件；
* 收进右栏后提示改成「已收进右栏（p.3）· 要独立文件点卡片上的「另存原图」」，不报一长串路径；
* `Store.wipeAll()` 增加 `media/`、`exports/` —— 清数据时这些副本一起清掉，
  确认框里也写明了「不会动你已经另存出去的独立文件」。

**全功能自查**见 `FEATURES.md`（按 12 组、84 项逐条对照代码与测试，标出「已验证 / 需你确认」）。


### 更新记录 · 3.28.3（修：PDF 框选「只看见框，截不了图」）

**根因不在框选，在「另存为」。** `saveas.js` 把三种结果塞进两个返回值里：

```js
// 旧写法
if (!r || r.canceled) return '';      // ← 对话框没弹出来 和 用户点取消，变成同一件事
```

Eagle 主进程的对话框通道是 `dialog[method](BrowserWindow.fromWebContents(event.sender), …)`。
拿不到窗口句柄时它**静默返回 `undefined`**，于是 `!r` 成立 → 被当成「用户取消」→ 什么都不保存、
只在角上闪一句 1.8 秒的「已取消」。看起来就是：框画出来了，然后没有然后。

**改法**（`SaveAs.askEx`）：三态取代二态 —— `path` / `cancel` / `unavailable`。

* `cancel`：用户真的点了取消 → 不留任何东西（原行为不变）；
* `unavailable`：**绝不丢图**。先落到源文件旁边（同名自动加 `(2)`），源目录写不进去再退到
  数据目录的 `assets/`，并用 7 秒提示写清楚「另存为框没弹出来：<原因>，已直接存到 <路径>」；
* 120 秒看门狗：对话框一直不返回也归到 `unavailable`，不会把一次框选吊死在那里。

**同时补的兜底**：框选现在先把「屏幕坐标」一起带上来（`viewer.onAreaRect` 增加 `client`），
pdf.js 那条重渲染的路万一抛错或返回空，就改走 `webContents.capturePage` 直接截窗口这一块
（`Bridge.captureWindow`）。清晰度略差，但「框了就一定拿得到图」。

**为什么这次能定位**：新增 `js/dbg.js`，把关键步骤写进 `<数据目录>/debug.log`（200KB 轮转，
只记事件与错误，不记内容）：启动时探一次 `plugin.window.*` 通道（`windowProbe`）判断窗口句柄
到底拿没拿到，之后每次框选记 `area.begin / area.capture / save.ask / save.write`。
再加上 `handleAreaRect` 整段 try/catch —— 以前任何一跳抛错都会变成静默的 unhandled rejection。

**验证**：`test-v328.js` 第 11 段（30 项）用假 dialog 真跑 `askEx` 的四种结局（选了 / 取消 /
返回 undefined / 抛错 / 没有 API）、`uniquePath` 不覆盖、`Dbg.log` 真落盘且截断超长内容；
外加静态断言：`handleAreaRect` 不再「裸 await captureRegion」、`viewer` 带上了 `client`、
`index.html` 里 `dbg.js` 在 `store.js` 之后 `app.js` 之前。


### 更新记录 · 3.28.2（修：语音提示「拿不到麦克风：Failed due to shutdown」）

**这不是权限问题。** 翻了 Eagle 的 `app.asar`：它没有设置 `setPermissionRequestHandler`
也没有 `setPermissionCheckHandler`，Electron 走默认放行。这条错的真实含义是
**音频设备会话刚打开就被关掉**，而 Chromium 把三种完全不同的情况都归成它：

| 实际情况 | 表现 |
| --- | --- |
| 系统音频服务没起来（刚重启过、被其它程序打断） | 首次取麦就 shutdown，再试往往就过 |
| 默认录音设备在系统里被禁用 / 拔掉 | 不指定设备一直失败，指定另一台能开 |
| 设备被会议软件、录音软件独占 | 报 `NotReadableError`，偶尔也被折叠成 shutdown |

光看那句英文分不出是哪一种，所以改成两件事：

**① 分级兜底**（`openMic()`）：按「带音频增强 → 关掉增强 → 全默认参数 → 点名指定 deviceId」
四级往下退，**每一级失败且属于可重试类型（AbortError / NotReadableError / shutdown）时先等
240ms 再试一次**。取麦前先 `window.focus()` —— 窗口在后台时个别情况下会话会被立刻回收。

**② 说得清楚**：失败提示从「拿不到麦克风：Failed due to shutdown」变成中文可执行建议，例如
「音频设备启动被中断（多半是系统音频服务没起来，重启一次 Eagle 通常就好）」。提示右侧多一个
**「自检」**按钮，点开列出：页面协议与安全上下文、`enumerateDevices()` 的输入/输出台数与名字、
每一次尝试的原始错误名与消息、`AudioContext` 的 state 与采样率 —— 可一键复制。

**验证**：`test-v328.js` 第 9 段用假 `navigator` 真跑 `openMic()`，六个场景：一次成功不重试、
shutdown 后重试成功、前两组参数失败退到第三组、全失败给中文建议并记录 6 次尝试、
默认设备禁用时走到「指定 deviceId」这一级、错误名到建议的映射。段内断言 9.4/9.5 最初写错了
（假设备默认成功，导致「全失败」根本不会失败），改为显式给足失败序列 —— 这也是这轮学到的：
**假对象要给死，别给「默认成功」**。

`test-v328.js` 共 136 项，全量回归 **575 项 0 失败**。


### 更新记录 · 3.28.1（修：装完就报「初始化编辑器失败」）

**症状**：装好后打开插件，页头一条红条 ——
`部分功能初始化失败：初始化编辑器：Cannot access 'ta' before initialization`。
编辑器整个没起来（右栏写不了笔记），两个插件窗口都报同一条。

**原因**：3.28.0 给编辑器加语音按钮时，把它写在了输入框创建之前：

```js
const mic = VoiceInput.button(ta, { label: '语音' });   // ← 这里 ta 还不存在
...
const ta = el('textarea', 'ne-input');                  // ← 声明在 8 行之后
```

`const` 有暂时性死区（TDZ）：在声明语句执行前读这个绑定，不是 `undefined`，而是直接抛
`ReferenceError`。`NoteEditor.create()` 因此整体抛错，boot 把它记成「初始化编辑器」失败。

**为什么测试没抓到**：3.28.0 的断言只检查「editor.js 里出现了 `VoiceInput.button`」——
静态查文本，看不出顺序错了。这类错只有真的跑一遍才暴露。

**修法**：麦克风那段挪到 `ta` 与工具栏都建好之后再挂（仍然在 `create()` 内），并写明原因。

**这次的防复发措施**：`test-v328.js` 新增第 7b 段「编辑器冒烟」—— 用假 DOM 真跑一遍
`NoteEditor.create()`，断言：不抛错、麦克风确实挂进工具栏且带 `.ne-mic`、**传给
`VoiceInput.button` 的就是那个 `<textarea>`**（不是 undefined）、麦克风是工具栏最后一项、
没有 `VoiceInput` 时安静跳过不插空按钮、`setValue/getValue` 正常。把顺序改回去跑，测试会
打印出一模一样的 `Cannot access 'ta' before initialization`。

**验证**：`test-v328.js` 104 项，全量回归 **543 项 0 失败**。


### 更新记录 · 3.28.0（ESC 真正关窗 · 截图与片段另存为 · 图片只存路径 · 白线 · 语音 · 清数据）

**1. ESC 第五次修 —— 这次先读了 Eagle 的源码**

前四版都在猜「按键通路」，全错。这次把 `C:\Program Files\Eagle\resources\app.asar`
翻了一遍，找到两条硬事实：

- `eagle.window` 只包了 `show/hide/focus/minimize/maximize/restore/…`，**没有 `close`**。
  以前调 `eagle.window.close()` 拿到的是 `undefined`，什么也没发生；
  退回去用 `hide()` 又只是把窗口藏起来 —— 用户看到的还是「按了没反应」。
- 但主进程留了一条通用通道：
  ```js
  ipcMain.handle('plugin.window.', async (event, params) => {
    let bw = BrowserWindow.fromWebContents(event.sender);
    const { method, value, value2 } = params;
    if (bw && bw[method]) return bw[method](value, value2);
  });
  ```
  也就是说**任意 BrowserWindow 方法**都能这样调 —— 包括 `close` 和 `destroy`。

于是退出改成三段式：`close` →（400ms 后）`destroy` →（1s 后）**常驻横幅**。
横幅不是 toast，不会自己消失，带「再试一次 / 最小化 / 知道了」—— 关不掉这件事必须让人知道，
而不是静默失败。另外还查清了一处误判：`document.visibilityState === 'hidden'` 曾被当成
「窗口已关闭」，可 `hide()` 恰好就会让文档变 hidden，等于把失败当成功，所以再也不看它。

最后再加一道保险：`index.html` 的 `<body>` 之后、**所有脚本之前**放了一段内联脚本，
自己记一次 ESC 按下时间，900ms 内主程序没认领（`window.__escHandledAt`）就直接走同一条
IPC 通道关窗。app.js 若因任何原因没挂上键盘监听，这段也还在。顺手加了 `Ctrl+W`。

**2. 划词：鼠标走到行与行之间会整段闪一下**

PDF.js 的文字层是绝对定位的 `<span>`，行与行之间有空隙。鼠标落在空隙上时命中测试会退回
父级 `.textLayer`，浏览器就把「起点 → 父级末尾」整段算成了选区 —— 于是每次跨行都闪一下全选。

修法是**每帧修正**，不只是 mouseup 时修：画条带之前取一次当前选区的两个端点，
若端点落在非文字节点（或它的 offset 越界），换成离按下点最近的那个字；
然后用 `sel.collapse(anchor) + sel.extend(focus)` 重建 —— 这个组合会自动处理拖选方向
（往回拖时 anchor/focus 是反的，`setStart/setEnd` 会算错）。纵向窗口也从
`行高×3 + 40px` 收到 `行高×0.7`，不再把上一行整行圈进来。

**3. 截图 / 框选 / 片段：一律「另存为」**

以前是直接塞进索引、顺手写在源文件旁边。两个后果：索引 JSON 里躺着 base64 大图
（一张 1200px 的 JPEG 十几万字符，备份、同步、打开都变慢），用户也没法决定文件放哪儿。

现在统一成 **先弹系统保存对话框，选好位置再落盘**（`eagle.dialog.showSaveDialog`）：

| 动作 | 产出 | 默认文件名 |
| --- | --- | --- |
| 视频截图 | 原分辨率 PNG | `文档名-00:18-截图.png` |
| 视频框选 | 框内区域的原分辨率 PNG | `文档名-00:18-框选.png` |
| PDF 框选 | 原分辨率 PNG | `文档名-p12-框选.png` |
| 片段 | mp4（Chromium 支持时）否则 webm | `文档名-00:18-00:23.webm` |

索引里**只留路径**（`ann.imagePath` / `ann.filePath`）。右栏要显示缩略图时按路径读盘、
`createImageBitmap` 缩到 900px 以内、转 blob URL 缓存在内存里（`js/imgcache.js`）。
文件被挪走或删掉就显示占位，不留破图。原图一个像素都不动 —— 存出去的是给人用的，
缩略图只是给人看的。片段卡片显示「▶ 文件名 · 时长」，点「打开片段」用系统播放器直接播。

**4. 右栏的图不能被拖走**

把摘录图片往阅读区一拖，Eagle 会当成「拖入一个文件」并提示「仅支持 PDF 文件」。
现在 `img.draggable = false` + `-webkit-user-drag: none` + 在 `dragstart` 捕获阶段
统一拦掉所有 `<img>`（第三道是防拖影先出现再被取消）。

**5. 视频右侧「截图」「片段」下面那条白线**

不是 CSS 边框。把真实数据里的截图抽出来逐行采样，底部 10 行是纯白，Eagle 自己生成的
`_thumbnail.png` 底部同样白 —— 是**视频文件本身**的底部白边（录屏的进度条 / 滚动条残留），
整帧截图会把它一起截进来。「框选」因为是局部裁切，所以没有。

修在显示层：生成缩略图时从底部往上数，连续 ≥99% 像素 >250 的行算白，裁掉；
超过画面高度 6% 就认为那是正常内容，放弃裁切（防止把白底 PPT 的下半页裁掉）。
另存的原图不动。

**6. 语音记笔记**

编辑器工具栏在「引用摘录」后面加了麦克风按钮（`.ne-mic`），右栏编辑器和摘录笔记的大框
都生效。走的是 3.15 起就有的 `VoiceInput`，只是以前没挂到这两个地方。

**7. 清除插件产生的数据**

工作台底部新增「清除插件数据…」：连 `docs/`、`pdfbak/`、`index.json`、`trash.json`、
`daily.json` 一起删，并清空 `ImgCache`。**不动**：PDF 正文、你另存出去的图片和片段、`asr/` 下的识别模型
（几百 MB 下载来的，删了要重下，和「清数据」不是一回事）。确认框里把这三条写清楚了。

有一处容易漏：回收站、阅读历史、每日笔记、术语表、行内翻译缓存其实都在 **localStorage** 里，
只删文件的话重开插件它们全还在 —— 等于「清了但没清干净」。所以同时也按 `eaglenote:` 前缀
扫一遍 localStorage，只留主题、有道开关、数据版本这三个纯设置项。

**验证**：新增 `test-v328.js`（92 项），覆盖 `SaveAs` 纯函数（文件名清洗 / 扩展名补回 /
默认路径 / dataURL→字节）、`ImgCache._whiteRows` 的裁切边界（6% 上限、非白、读不到像素、
探测窗口上限）、ESC 三条通道与内联兜底的加载顺序、图片只存路径、禁拖的三道拦截、
wipe 的保留清单与 localStorage 清扫、语音按钮、`_snapRange` 的选区重建。全量回归 **531 项 0 失败**。


### 更新记录 · 3.27.0（注释三方统一 · ESC 死循环 · 原分辨率另存 · 节选按键提示）

**1. ESC 退不出去 —— 找到真凶：笔记框的「要不要保存」**

「刚进插件能退，写过笔记之后就退不出去」这件事，前几版一直在调按键通路。
真正的原因在笔记框：按 ESC 关它时弹了一个确认框，而**确认框自己也是一层 Esc**。
于是按键序列变成「弹弹框 → 关掉弹框 → 又弹一次」，确认框永远在，笔记框永远
关不掉，用户按十下也出不去。更糟的是「危险层不许强退」的保护恰好把这条死循环
保护了起来 —— 连按两次的兜底也被它挡住。

现在 ESC 关笔记框**不问**：草稿本来就是随打随存的，静默保存后直接关。
点击 ✕ 关闭仍然问一句（那是用户主动要关，问一句是对的）。

配套三处：

- **危险层按真实可见性体检**。笔记框 / 确认框以前故意不体检（怕越过确认框把
  未保存的字关掉），结果关掉之后栈里还留着那一层，ESC 永远被它挡在「有危险层」
  这个分支里。现在按 DOM 是否可见判断：看得见就尊重，看不见就回收。
- **连按三次毫无变化 → 无条件退出**（不再被危险层豁免）。
- **退出前先关眼前看得见的浮层**：栈少一层的时候，ESC 不会跳过一个看得见的框
  直接把窗口退掉。

另外去掉了一个会「把整个 Eagle 收进托盘」的兜底（`eagle.window.hide()`），
并在顶栏加了一个常驻的 **✕** —— 键盘事件被原生控件吞掉时，鼠标总还能退出去。

**2. 注释三方统一：Eagle 条目注释 = PDF 里的标注 = 插件索引**

以前只把「笔记正文」写进 Eagle 注释，于是**只摘录、没写字**的条目在 Eagle 里
什么也看不到（这就是「PDF 的笔记没进注释」）。现在注释由整篇内容生成：
每条摘录带类型和位置（第几页 / 00:12–00:31），挂在摘录上的笔记跟在后面，
独立笔记单独成条，按时间排序。

写入改成**写完必须读回来对上**：拿到的 Item 可能是缓存副本，`save()` 也可能
静默返回 false。三次对不上就如实告诉用户「注释未写入」，不再假装成功；
Eagle 的 IPC 刚启动时短暂不可用会自动重试三次。打开文档时也会对一次账
（本地为空时绝不清空，免得抹掉用户在 Eagle 里自己敲的字）。

**3. 清空时三处一起清**

工作台下面的「清空全部摘录与笔记」以前只抹 PDF 里的高亮、只清**当前这一条**
的 Eagle 注释，于是别的文档上看得到「插件里空了、Eagle 注释里还在」。
现在在删索引之前先记下每篇的预期注释，删完逐条对账清空，并在提示里报数
（清掉几条、几条被 Eagle 拒绝）。对不上的（用户自己敲的注释）不动。

**4. 节选片段：按键会红闪**

节选片段是两段式动作（先按一下取 A，播到终点再按一下取 B），中间没有模态框，
状态只活在内存里 —— 切个窗口回来就不知道自己还在录。现在按下的那颗按键变红
闪烁、文字变成「● 节选中…」，另一颗「并笔记」版亮一道红边。框选同理
（「● 框选中…」）。切文档 / 退出视频时自动复位。

**5. 视频按原分辨率另存 / 导出**

- **原图**：卡片上新增「原图」，回原视频按 `videoWidth × videoHeight` 重新取一帧
  PNG（框选按当初框的位置取），存到源文件同目录。索引里那张是宽 ≤1200 的
  JPEG，做幻灯片不够用。
- **导出片段**：片段卡片上新增「导出片段」，把 A→B 这一段重新录成视频 ——
  画布尺寸就是原分辨率，音轨从 `<video>` 取，MediaRecorder 出 mp4（Chromium
  支持时）否则 webm。录完落在源文件同目录，文件名带时间区间，重名自动加序号。
  这是**实时录制**（10 秒片段录 10 秒），右上角有进度条和取消键，Esc 也能停；
  超过 15 分钟会直接拒绝并说明原因。

**6. 右栏笔记栏上下颠倒**

已经建好的笔记在上（进来先看内容），新建 / 编辑区在底部（写完就发出去，
不用先滚过一列表）。编辑器限高 52%，笔记多了也不会把列表挤没。

**验证**：新增 `test-v327.js`（72 项），覆盖注释正文生成（摘录/笔记/时间轴/
图片/排序）、导出纯函数（容器选择、码率、文件名）、ESC 死循环的三处修复、
布局顺序与落盘接口。全量回归 **438 项 0 失败**。


### 更新记录 · 3.26.0（字幕按语义断句 · 译文按句重排 · 视频左栏加宽）

三条反馈，前两条其实是同一件事的两面。

**1. 一段字幕太长，读着费力 —— 现在按语义断句**

一条字幕的长度本来由端点检测决定：换气停 1.9 秒才算一句，中间还允许并到 110 字。
于是屏幕上经常是「三句话挤成一段」。现在文本落定后按标点拆句，**一句一条**。

**不需要额外的模型。** 句读来自已经在跑的精修模型（SenseVoice 自带标点）；
精修没装时退回逗号 / 空格的弱边界，也能拆，只是不如标点准。
拆的时候保护缩写（Dr. / e.g. / U.S.）、小数与版本号（3.5 / v1.2），
不会把 "Dr. Smith" 切成两句；尾部太短的碎句会并回邻条，不会造出一地碎渣。

每条的时间按文字宽度比例分摊，点某一条仍然跳到大致的位置。

**2. 翻译准确性再提一截 —— 找到一处一直存在的错位**

以前是「转写出来就先翻，精修回来再改原文」：精修把听错的字改掉了，
**那条译文却留着没动**，于是屏幕上显示的是「按错字翻出来的中文」。
这是「看着总是差一点」的主因之一。现在翻译统一排到文本落定之后
（精修 → 语境 → 断句 → 翻译），翻的一定是最终那一句。

另外三处：

- **带上前后文**：翻译时把前后各几句原文一起交给引擎。本地模型会用它判断术语和指代，
  同一段视频里的译名不再前后打架；在线接口忽略这个参数，不吃亏。
  上下文也进了缓存键 —— 否则「带上文翻的结果」会命中「没带上文时的旧译文」。
- **拆句本身提准**：短句比长段落好翻，句子之间的逻辑不再被抹平。
- **译文闸门**：明显没翻（原样回显、没有汉字）或长度离谱（比原文长一倍以上，
  通常是模型自己在解释）的译文不落到字幕上。宁可空着，也不摆一段错的。

**3. 视频界面左栏太窄**

左栏 232px，一行只放得下十来个字，断句之后还是要折三四行。现在视频模式下
左右两栏同宽（都取右栏宽度），并显式撑满整列高度，和右栏等高。
中间播放区因此左右对称，画面重心也不偏。

**验证**：新增 `test-v326.js`（68 项），覆盖断句点识别、缩写/小数点保护、
宽度退让、译文按比例对齐，以及沙箱里「一条长字幕真的被拆成多条、时间轴没被拉长、
后面那条没被挤掉」。全量回归 **366 项 0 失败**。


### 更新记录 · 3.25.0（笔记框统一、ESC 再加固、字幕表头与年度热力图）

四条反馈：

**1. 框选后的笔记框与摘录、锚点不一致**

原来三个入口三种形态：摘录和锚点弹大笔记框，框选弹一个小浮层；
标题还只有一处写死成「摘录并笔记」，分不清自己在写哪一种。
现在三者统一走大笔记框，标题按来源区分：**框选并笔记 / 摘录并笔记 / 锚点并笔记**，
副标题写明页码与类型；已有内容时冠以「编辑」。

**2. ESC 仍然退不出去 —— 又找到两处**

- `ESC_LAYER_ALIVE` 漏了 **workbench / kb / trash** 三层。工作台、知识库、回收站
  关闭时只改 DOM，栈里的条目却留着；于是每次 ESC 都在弹一个**已经不存在、看不见**的层，
  界面上毫无变化。现在这三层也按真实可见性回收。
- 「空转判据」的签名里含 `activeElement`。焦点在两次按键之间来回跳（失焦又被拽回），
  签名每次都不同，于是永远判不出「毫无进展」，强退兜底形同虚设。现在签名**只看还开着哪些浮层**。
  同时补三个写错的 DOM id（`pickPicker` / `kbView` / `trashView` → `eaglePicker` / `kbOverlay` / `trashOverlay`）。

另外两处加固：

- **连按判定改用「连续无进展次数」**，不再依赖 1.5 秒时间窗 —— 用户按键慢也不会漏判。
- **关窗改为并行发起**：Eagle API 的 `close` / `hide`、`Bridge.closeWindow`、`window.close`
  一起发，谁敢关谁关。旧版每 340ms 串行试一步，接近一秒的「毫无反应」本身就是体验问题。
- **keyup 兜底**：万一某个原生控件（如 `<video controls>`）把 keydown 吞在内部，
  keyup 还能出来，220ms 内没有 keydown 处理记录就补一次。

**3. 字幕多选时排版塌了**

右栏变窄时 `.sub-head` 的 flex 子项各自折行：「实时字幕」被压成两行、
「存为笔记（4）」断成两截。修法：表头 `flex-wrap: nowrap`；标题超宽时省略号而非折行；
按钮不收缩；**多选时自动收起「精修」「语境」**给计数按钮腾位置，计数改用半角括号。

**4. 年度活动可以按月份看**

旧版是 7 行 × 53 列的全年长条，能看出哪天忙，看不出哪个月忙 —— 月份只能靠数格子。
现在改成**一月一行**：纵向 12 个月，横向 1..31 日，月份自带标签，疏密一眼可读。
2 月不会画出 30 日（按真实天数补齐）。


### 更新记录 · 3.24.0（ESC 退不出去：找到真正的死循环，拆掉它）

反馈：3.23 之后，点过阅读区或放过视频，ESC 仍然退不出去。

**根因：退出路径自己把自己锁住了**

`exitPlugin()` 在关窗之前先判断「有没有没保存的草稿」，有就弹出
「还有没保存的笔记」确认框。而这个确认框自己又压在 Esc 栈顶：

1. 第一次 ESC → 弹框（等用户选）；
2. 第二次 ESC → 只把框关掉（返回 `cancel`），窗口不动；
3. 第三次 ESC → 草稿还在，又弹一次同一个框。

草稿一直存在，框就一直弹，**用户看到的永远是「按 ESC 什么也没发生」**。
3.23 加的「连按两次强制退出」也被一条豁免规则挡住：`isRepeat` 里写着
「上一次是 exit-plugin 就不判重复」—— 恰好使这个循环永远判不出重复。

**改法**

1. **退出路径不再有确认框**。改为 `flushDrafts()`：把手头这一份静默写进笔记，
   再走关窗。笔记本来就随打随存（`persist` 有防抖），退出不该打断用户，
   更不该用一个「关掉就再弹」的框把人锁在窗口里。
2. **空转判据换成界面真实可见性**。新增 `escUiSig()`，只统计真实可见的浮层
   （工具条 / 翻译框 / 链接浮层 / 笔记大框 / 确认框 / 搜索面板 / 工作台…）加上
   当前焦点。连按两次签名不变 → 判定空转，直接退出。真·逐级退出每按一次必然
   少一层，签名必变，不会误杀。
3. **删掉 `isRepeat` 里的 exit-plugin 豁免**。它原本为防误杀而加，实际成了死循环的保护伞。
4. **keydown 同时挂到 window 捕获阶段**（用 `__escSeen` 去重）。window 是事件链
   最外层，一定比 document 先拿到按键 —— 焦点落在原生 `<video controls>`、内嵌内容
   或可编辑元素里时，也不会出现「按键根本不进处理器」。
5. **全屏只让一次**。`escFsPassed` 保证第一下 ESC 让给浏览器退全屏，若全屏状态是
   残留、第二下仍存在，就按正常流程退出，不会永久吞掉 ESC。
6. **输入法保护**。`e.isComposing / keyCode 229` 时直接放行 —— 中文选词时的 ESC
   是「取消候选」，不该被当成退出。

**数据安全**：ESC 退出会先保存，不会丢内容；删除笔记等危险操作仍走确认框，
且确认框不会被「连按两次」越过（`guarded` 判定）。


### 更新记录 · 3.23.0（ESC 不再「按了没反应」+ 划词改回逐行跟随）

反馈：① 刚进插件时 ESC 能退出，一旦点过阅读区或放过视频，ESC 就退不出去了；
② 从段落中间从上往下拖选时，屏幕上是「像框选的一个方框」，松手后才变成整行。

**ESC：把「卡住」的两种可能都堵死**

1. **先给 Esc 栈做体检**。新增 `Esc.prune(keep)`：按真实 DOM 可见性清理「界面早就关了、
   栈里还留着」的层。这类残留会让每次 ESC 都在弹一个看不见的层，用户看到的就是
   「按了没反应」。只对能从 DOM 一眼判断的层（工具条 / 搜索 / 翻译框 / 链接浮层 /
   批注浮层 / 资源库选择器 / 视频框选与片段）做体检；确认框、笔记大框、工作台等
   会挡住数据操作的层**故意不判断**，未知层一律按「还开着」处理 —— 宁可多按一次，
   也绝不越过确认框把未保存的笔记一起关掉。
2. **连按两次强制退出**。`EscGuard.isRepeat(last, now)`：两次 ESC 间隔 1.5 秒内、
   栈签名（栈内层名 + 搜索/输入状态）完全一致、且上一次不是退出 → 判定为空转，
   直接退出。真·逐级退出每次必然少一层或改变输入状态，签名一定不同，所以不会误杀。
   这一条同时兜住「焦点在可编辑元素里、失焦没有肉眼可见变化」导致 ESC 空转的情况。
3. **关窗不再「调用一下就算成功」**。改成链式尝试：先 `window.close()` → 340ms 后
   仍可见就补 `eagle.window` / `Bridge.closeWindow()` → 再不行明说一句
   「请按 Ctrl+W 或点右上角 ✕」。判据用 `window.closed` 与
   `document.visibilityState`（被隐藏的窗口是 `hidden` 而非 `closed`）。
4. ESC 的每一个分支（弹层 / 清搜索 / 失焦 / 退出）现在都统一
   `preventDefault + stopPropagation`，语义完全由插件决定，不再漏给 Eagle 二次判断。

**划词：v3.22 的「横向裁剪」是罪魁**

5. 根因：v3.22 为了让条带「只跟着鼠标走」，把每个矩形都裁进拖拽带 —— 横向也裁。
   于是从段落中间往下拖时，中间整行被截成 `[按下点, 抬起点]` 那一段，屏幕上就是一个
   竖长条，看起来就是框选。同时 `range.getClientRects()` 作用在跨多个绝对定位 span
   的 Range 上会返回整块包围盒，也在放大这种观感。
6. 改法：删除 `clipToBand`；拖选开始时按页惰性缓存文本节点几何（只一页，代价可控），
   每帧对落在拖拽带里的十几个节点逐节点 `selectNodeContents + setStart/setEnd`
   取真实矩形，再用 `U.mergeLineRects` 按行合并。结果是：首行从按下处开始、
   末行到抬起处结束、中间整行 —— 一行一行跟着走。缓存按页惰性建立，
   缩放 / 重排 / 文字层重建时作废。


### 更新记录 · 3.22.0（ESC 三处退出行为 + 划词条带优雅化）

反馈：① PDF 阅读界面按 ESC 退不出去；② 置顶工作台按一下 ESC 只收起工作台、露出笔记界面；
③ 划词时鼠标轻微一动仍会选上一大片，蓝色标识希望更优雅。

**ESC：按窗口形态分流（新增 `js/escguard.js`，纯函数可测）**

1. **预览模式退不出去**。查 Eagle `app.asar` 的 `openPreview`：预览页面由 `new BrowserWindow`
   独立承载，`dom-ready` 注入 `windowID / parentID`；按键不会冒泡到主窗口的 `escHandler`。
   旧实现在该分支只弹一句「按空格关预览」的 toast，所以用户觉得 ESC 完全没用。
   → 改为 `window.close()` 关掉这个独立窗口；`canSelfClosePreview()` 在
   `windowID === parentID`（理论上不会发生）时拒绝关闭，绝不误关 Eagle 主窗口。
   Electron 某些版本会静默拒绝脚本关窗，320ms 后若窗口仍在则回落到提示。
2. **启动器工作台只退一半**。伴生插件跳转的 `?launcher=1` 窗口里，工作台是「落地页」而非浮层，
   旧逻辑按 Esc 弹栈顶（`Esc.pop('workbench')`），于是收起工作台、露出笔记界面。
   → `EscGuard.escapeAction({launcher, depth, topName, searchActive, typing})` 判定：
   启动器 + 栈顶为工作台 → 直接 `exit-plugin`；启动器窗口关闭优先走 `window.close()`，
   避免 `eagle.window.hide()` 把整个 Eagle 收进托盘。
   普通窗口（从笔记界面点进工作台）仍保持「只收工作台」，未保存笔记确认框仍优先弹出。

**划词：原生蓝底停用，改画柔和条带（新增 `js/selband.js`，纯函数可测）**

3. **根因再定位**。PDF.js 的 span 是绝对定位 + `scaleX`，视觉顺序 ≠ DOM 顺序。
   鼠标落到行间空白时 Chromium 命中测试退回父级 `.textLayer`，把「起点 → 父级末尾」
   整段 DOM 区间算成选区 —— 这才是 v3.21 之后仍会「一动选一大片」的原因，
   它不是灵敏度问题，降 `::selection` 透明度也治不了。
4. **视觉**：文字层内原生 `::selection` 全程透明，改由 `.selBandLayer` 画圆角、低饱和、
   `mix-blend-mode: multiply` 的柔和条带；拖选中按 rAF 画近似条带，但**一律裁进本次鼠标
   实际经过的拖拽带**，且单条高度不超过 1.45 行。底层选区再大，屏幕上也只跟着鼠标走。
   mouseup 后由 `snapshotSelection()` 的精确行矩形重画一次定稿。
5. **数据**：`isSuspicious()` 比较选区包围盒与拖拽带，判定被吸附放大后，
   `pickCaret()` 按指针位置把结束点重新钉回最近的文本节点，再交给原有摘录/翻译链路。
   选中的文本数据仍来自原生 `selection`，只是范围被收回到真实拖过的部分。

**没有改动的**：跨页选区拆分、摘录矩形计算、划词翻译、快捷键、RunGate 分诊逻辑。


### 更新记录 · 3.21.0（划词：不再整片泛蓝、选区跟得上鼠标）

反馈：PDF 里拖选文字时蓝色闪得厉害，鼠标到哪选区跟不上，稍微偏一点就整行整段变蓝。

**三条原因，一起修：**

1. **拖选期间还在反复算几何**（闪烁与滞后的主因）。`selectionchange` 的 140ms 防抖会周期性调用
   `viewer.snapshotSelection()`：遍历所有页 → 对命中页 `getBoundingClientRect()` →
   TreeWalker 逐文本节点 `createRange()` + `getClientRects()`。这是全文档强制同步布局，
   一秒七次，边拖边算，蓝色选区自然来回重绘、跟不上指针。
   → 新增「拖选守卫」`viewer._bindSelectGuard()`：鼠标按下到抬起之间 `isSelecting()` 为真，
   `onSelectionChange` 直接返回；几何只在 `mouseup` 后由 `onDocumentMouseUp` 取一次。
2. **悬停蓝框在拖选时照画**。`_bindHover()` 的 rAF 节流 mousemove 会给链接/图片画带蓝底蓝边的框
   （`.link-hover`），拖过图片区域时它出现又消失，看起来就像「一片区域忽闪着变蓝」。
   → 拖选期间跳过悬停计算并清掉悬停框；顺带也避免了每帧 `ensureOverlays()` 的图片几何解析。
3. **整层都能起选**。原来 `.textLayer { user-select: text }`，在文字之间的空白处按下鼠标也会起选，
   Chromium 会把「最近的文字位置」吸附到行首/行尾，于是偏一点就整行整段变蓝。
   → 层改为 `user-select: none`，只有 `span` 可选；`br` / `.markedContent` / `.endOfContent`
   明确不可选。框选/锚点工具下同步把 `span` 也关掉，保持原来的「拖拽时禁选字」。
   另外给文字层加 `contain: paint` 把重绘关在层内，选区底色从 .30 降到 .22。

**没有改动的**：跨页选区拆分、摘录矩形计算、划词翻译、快捷键，都走原来的链路。


### 更新记录 · 3.20.1（修：点工作台图标却打开了选中文档）

**现象**：3.20 起窗口颜色对了，但从图钉点「笔记工作台」，落地的是**当下选中的那篇 PDF**，
而不是工作台。

**根因**（读 `app.asar` 确认）：Eagle 每次创建插件窗口，会向该窗口连发**两次** `plugin-run`：

```js
// create() 内部：did-finish-load 后 100ms
win.webContents.send('plugin-create', plugin);
win.webContents.send('plugin-run');

// create() 的 .then()：show() 之后再来一次
browserWindow.show();
browserWindow.webContents.send('plugin-run', { args, ...plugin });
```

两次的 payload 完全一样，没有可区分字段。而主插件收到 `plugin-run` 的老逻辑是
「读资源库当前选中项并打开」，于是启动器窗口刚跳进来、工作台刚渲染，
第二次 `plugin-run` 就把选中的 PDF 顶了上来。

**修法**：新增 `js/rungate.js`，把「这次 plugin-run 该怎么处理」抽成纯函数三档判定：

| 情形 | 判定 |
| --- | --- |
| `?launcher=1` 的窗口（工作台入口） | `workbench` —— 只回工作台，永不抢文档 |
| 既没打开文档、用户又没碰过我们的界面（= 建窗时的伪触发） | `ignore` |
| 其余（已有文档，或用户已在窗口里操作过） | `open-selected` —— 保持老语义 |

配合 `openInitial()` 顶部的 `if (q.launcher) return;`，启动器窗口从此只有一种落点：
工作台。普通窗口（从插件面板打开）里「选中文档 → 再点插件」的老行为不变。


### 更新记录 · 3.20.0（窗口边框深色化：去掉原生边框，自绘标题栏）

**问题**：从顶栏图钉打开工作台，窗口顶部是一条**白色标题栏**，与 Eagle 的深色界面割裂；
而从阅读器里进工作台是深色的。

**根因**（查 `app.asar` 确认）：Eagle 创建插件窗口时把 `frame` 原样传给 Electron
（`frame: frame ?? true`），全篇没有设置 `nativeTheme.themeSource`。
Windows 于是按**系统主题**给这个原生边框上色——系统是浅色，插件窗口就是白条。
**这不是我们页面配色的问题，是 OS 画的边框，任何 CSS/JS 都改不了它的颜色。**
从阅读器里进工作台之所以看着深色，是因为那是同一个窗口内的视图切换（没有新边框），
或用的是 Eagle 自己的全屏预览层，本来就没有系统标题栏。

**做法**：启动器插件的窗口改成 `"frame": false`（无原生边框），
在主插件页面里自绘一条 34px 的深色标题栏（`#winBar`）：

| 能力 | 实现 |
| --- | --- |
| 拖动窗口 | CSS `-webkit-app-region: drag`（按钮单独 `no-drag`） |
| 最小化 / 最大化 / 还原 | `eagle.window.minimize / maximize / unmaximize / isMaximized` |
| 关闭 | `window.close()`（Eagle 的 `eagle.window` 没有 close，Electron 里 `window.close()` 即关窗） |
| 双击标题栏 | 最大化 / 还原（Windows 习惯） |

只在 URL 带 `launcher=1`（也就是从图钉启动器进来的那个窗口）时启用；
直接打开的主插件窗口保持原生边框，行为不变。新增 `js/framewin.js` 承载，`body.frameless` 负责让位 34px。

> 顺带说明「先窗口化、然后才最大化」那一下跳变：Eagle 在 `ready-to-show` 里只登记，
> 真正的最大化要等 `did-finish-load` 之后才调用（`bw.webContents.once('did-finish-load', () => bw.maximize())`），
> 所以窗口一定先按 manifest 尺寸出现、再被拉大。这是 Eagle 恢复上次窗口状态的实现方式，
> 插件侧改不了；把该插件窗口关掉时保持「非最大化」，下次就不会再有这一下。


### 更新记录 · 3.19.0（找回图钉：Eagle 不给「预览插件」置顶权）

**背景**：3.18 合并成单插件后，插件列表里「Eagle 笔记管理」这一行**根本没有图钉图标**。
查 Eagle 本体（`app.asar` 里的插件列表面板模板）拿到确凿原因：

```html
<!-- 插件行右侧：图钉只在「非预览插件」时才渲染 -->
<div ng-if="!item.isPreviewPlugin" ng-show="pluginModule.pinnedPluginMaps[...]" ng-click="unpinPlugin(...)">
```
```js
isPreviewPlugin: !!manifest.preview          // 判定依据：manifest 里有没有 preview 段
```

也就是说：**只要 `manifest.json` 里有 `preview` 字段，Eagle 就同时隐藏「图钉」和「设置快捷键」**
（快捷键菜单的条件里也有 `!item.isPreviewPlugin`）。我们的 PDF 阅读器必须声明 `preview.pdf`，
所以主插件永远钉不上——这是平台规则，插件代码改不了。

**结论**：单插件 + 置顶，在 Eagle 上物理不可行。顶栏要有入口，就必须存在一个**不含 `preview`** 的插件。

**做法**：

| 插件 | manifest | 能不能钉 | 作用 |
| --- | --- | --- | --- |
| Eagle 笔记管理（`LB7PDFRDK3QM`） | 含 `preview.pdf` | 否 | 阅读器 / 摘录 / 笔记 / 工作台全部功能 |
| 笔记工作台（`LB7NOTEWB01`） | 纯 `main`，无 `preview` | **是** | 图钉入口，点开跳进主插件并落在工作台 |

- 3.18 对主插件的改动全部保留（主图标点开也仍直达工作台），两者不冲突。
- 两个插件共用同一份磁盘数据（`<userData>/Plugins/EagleNoteManager/data/`），启动器只跳转、不复制数据。
- 新图标：主插件「纸页 + 琥珀高亮」，启动器「四格仪表盘」，共用一套深色底与品牌色（`#5b8cff` / `#f5c542`）。

> **更正 3.18 的错误说明**：3.18 记录里写「置顶『Eagle 笔记管理』这一个图标就是工作台入口」，
> 这是错的——那个图标钉不了。以本节为准。


### 更新记录 · 3.18.0（合并为单插件：点开主图标直接进工作台）

**场景**：3.17 把工作台拆成了独立的「笔记工作台」启动器插件，实测有两个问题：
① 独立窗口带的是 **Windows 系统原生标题栏**（`frame:true` 时由系统主题决定，
Eagle 插件 API 改不了 `setBackgroundColor` 之外的东西），在浅色系统下会露出一圈浅色外框，
跟深色主插件格格不入；② 要装两个包、置顶两个图标，多此一举。

**做法**：合并回单插件。关键在 `openInitial()` 的启动语义分流——

| 启动方式 | 判定 | 落地 |
| --- | --- | --- |
| 顶栏/插件面板点开 | `window` 模式（URL 无 `id`/`path`） | **直接进工作台**，不再读「Eagle 当前选中项」 |
| 空格 / 双击预览文档 | `preview` 模式（URL 带 `id`/`path`） | 照常打开该文档 |
| 插件已运行时在 Eagle 中再触发 | `Bridge.onRun` | 读当前选中项打开 |

旧逻辑在 window 模式会尝试打开「Eagle 当前选中项」，所以点顶栏图标时若库里恰好选中了某篇 PDF，
就被带去读文档、看不到工作台。现在 window 模式直接开门面，从插件面板点主图标也一步进工作台。

> 代价说清楚：① 从顶栏点开不再自动打开选中项，想读某篇文档请用空格预览，
> 或窗口已开时在 Eagle 中点一下选中项；
> ② 主插件**钉不到顶栏**（原因见 3.19.0），顶栏入口由「笔记工作台」启动器承担。


### 更新记录 · 3.17.0（伴生插件「笔记工作台」首次出现；3.18 曾移除，3.19 恢复）

**场景**：Eagle 的插件置顶是**插件级**的——图钉只能钉整个插件，不能钉某个功能。
想要「点一下就进工作台」，把工作台从一个标签页变成一个独立插件：新增伴生启动器
**`Eagle 笔记工作台-3.17.1.eagleplugin`**，装好后它在插件面板里是一个独立条目，
图钉置顶 / 设置快捷键都随你。点它 = 打开主插件并直接落在工作台视图。

> 启动器 3.17.1 修订：实测 Eagle 加载插件页的 URL 未必是 `file://` 形式，首版靠地址反推
> 目录会失手（弹「没找到主插件」）。改为多策略定位——`eagle.plugin.path` → 地址反推 →
> `<userData>/Plugins` 扫描——并带约 3.5 秒重试（等 Eagle 的插件注册事件到位），
> 失败时页面显示已尝试的候选目录，便于排查。

| 设计点 | 做法 | 为什么 |
| --- | --- | --- |
| 零数据复制 | 启动器只有一个职责：扫描同目录下 `manifest.json` 的 `id` 为 `LB7PDFRDK3QM` 的主插件，带 `?launcher=1#workbench` 跳过去 | 工作台数据全在磁盘 `<userData>/Plugins/EagleNoteManager/data/`（固定路径，与插件安装位置无关），跳转后由主插件接管，启动器自身零状态 |
| pluginPath 漂移 | 跳转后的窗口里 `plugin-create` 事件指向的是**启动器**目录；`launcher=1` 时 bridge 跳过它，改用页面地址兜底，并补读主插件真实 manifest | 否则 pdf.js worker / cmaps 会解析到启动器目录，关于页也会显示错的名字 |
| 主插件没装 | 启动器显示明确提示，不跳转、不报错 | 伴生插件不该在缺主插件时白屏 |

两个插件独立升级、互不覆盖；卸载主插件后启动器只会停在提示页。


### 更新记录 · 3.16.0（首次启动环境检查：装完插件一次说清缺什么）

**场景**：把插件分享给别人或上架 Eagle 插件库，用户装完后对着一片空白界面不知道还要装什么。
现在**第一次打开插件**就会弹出「环境检查」清单，缺什么、怎么装、点哪里，一屏说清。

| 依赖 | 缺时怎么办 | 为什么这么做 |
| --- | --- | --- |
| 语音识别引擎 + 双语模型（约 210 MB） | 清单里点「处理」直接下载，带进度 | 纯文件下载，插件内能完成 |
| 字幕精修模型（约 239 MB，可选） | 同上 | 标成「可选」—— 没有它字幕也能用 |
| Ollama 本体 | 「处理」打开官方下载页 ollama.com/download，装完点「重新检测」 | **不代装安装器**：静默装系统级软件要 UAC 授权，上架审核也过不去，而且用户对「插件偷偷装了什么」非常敏感 |
| OCR 视觉模型（约 6 GB） | Ollama 装好后点「自动拉取」—— 插件**代跑 `ollama pull`**（v3.16 新能力，`Translator.pullModel`），进度实时显示；也可以自己在终端跑同样的命令 | 本体已装时 pull 只是一条 CLI 命令，代跑没有副作用 |

- 弹出时机：boot 后 3.5 秒（等 Ollama 探测跑完再判断，避免把「正在找」误报成「没装」）；全部就绪或用户点过「稍后再说」就再也不弹。
- 「稍后再说」= 不再自动弹；翻译设置底部新增「环境检查」入口随时重开，还有「重新检测」按钮。
- 下载中的行显示实时进度（MB 数 / pull 百分比）+ 转圈点；失败给降级建议（终端命令），不弹错误框。


### 更新记录 · 3.15.0（字幕存笔记 / 多选批量操作 / 语音输入笔记 / 划词重排）

| # | 反馈 | 处理 |
| --- | --- | --- |
| 1 | 新字幕在下面生成，字幕框要自动下拉 | 列表跟随最新句自动滚到底；用户往回翻查看历史时**不打断**（4 秒内不抢滚动），点最新一句或重新滚到底即恢复跟随 |
| 2 | 字幕支持保存到笔记，附首画面截图；Ctrl 多选、断开处各自截图 | 字幕条目可 Ctrl 点选 / Shift 连选 / Ctrl+A 全选；「存为笔记」按**连续段**分组——连续一段只截它开头那一帧，断开的段各自再截一张。截图走离屏播放器定位（`captureFrameAt`），**不动正在播的那个**，存笔记不会把播放位置弄丢 |
| 3 | PDF 阅读区上方工具栏，功能按钮之间等间距 | 组内间距（`.tb.act-group`）与组间距（`.topbar` 的 gap）取同一个 10px，左右内边距对称——之前「组挨得近、按钮挨得远」看起来就是忽宽忽窄 |
| 4 | 成段划词翻译充满换行和断字符 "-"，影响翻译质量 | 翻译前先 `U.reflow` 重排：① 行尾「连字符+换行+小写」拼回被切开的单词；② 行没以句末标点收尾、下一行也不是列表/编号 → 合并（中文之间直接粘、西文之间补空格）。刻意保守：只动**几乎肯定是排版造成的**换行，宁可少合并不误合并。划词翻译和摘录卡片的「翻译」都走这条管线 |
| 5 | 悬浮工具栏摘录按钮不要粗体 | `font-weight: inherit`，和其余三个完全一致 |
| 6 | 框选后显示「批注」，统一为「笔记」 | 浮层标题、保存提示、注释措辞全部统一为「笔记」 |
| 7 | 所有能记笔记的地方加语音输入 | 批注浮层、工作台每日笔记都配上 🎙 按钮。走「录完再说」：整段 PCM 交给 SenseVoice 非流式整段重听（带标点），再结合已写内容 + 术语表让本地模型校一遍——同一套模型，把字幕的「快」换成笔记的「准」。录音中有浮标提示（在听/时长/怎么停），再点一下结束。默认仍是打字 |
| 8 | 字幕断句卡在句子中间 | 端点检测放宽（尾部静音 2.8s / 短静音 1.9s / 强制断 26s），并且**短句合并**：落定的碎句若没到句末标点、时长又短，就并进前一句再等下一片——断句尽量落在句号处 |
| 9 | 摘录/笔记/知识库/回收站支持 Ctrl 多选、Ctrl+A 全选、批量操作 | 四个列表共用一套多选交互（Ctrl 点选 / Shift 连选 / Ctrl+A 全选 / Esc 取消），选中后浮出批量操作条：摘录·笔记·知识库（复制 / 删除进回收站）、回收站（还原 / 彻底删除）。批量删除**一次 Ctrl+Z 全部撤回**；批量操作只重建一次索引 |


### 更新记录 · 3.14.0（字幕更准：热词 / 语境校对 / 自动开启，界面若干）

| # | 反馈 | 处理 |
| --- | --- | --- |
| 1 | 视频实时精修的准确性还是不行，要不要引入医学专门模型？要不要结合前后文语境？ | **不换模型，加两层**。① **热词偏置**：把术语表 + 视频文件名交给流式识别器，解码时给这些词加分 —— 不换权重、不重新下载（中英模型只多下 1 MB 的 `bpe.vocab`），对「胆囊三角/单囊三角」这类系统性错字最直接；② **语境校对**：精修之后再把前后各几句 + 术语表交给本机 Ollama，只改听错的音近字，三道闸门防模型发挥。**为什么不用医学专用模型**：现成的（Qwen3-ASR 系的 LoRA 微调）要 Python+Torch+GPU，也没有 sherpa-onnx/ONNX 导出，塞不进插件；而垂直领域的大头收益在术语，热词已经能拿到 |
| 2 | 每次打开视频都提示「需要先下载识别引擎」，可我早就下好了 | 真 bug：`showGuide()` 读的是 `Asr.status()`，而 `status()` 只是把缓存的 `state` 原样吐出来，冷启动时它还是 `unknown` → 永远判定「没下好」。改成 `probe()`（真的去盘上看一眼）；`status()` 遇到 `unknown` 也会自愈；另外 `setDataDir()` 进来时把 `state` 打回 `unknown`（Bridge 可能晚于首次探测才注入数据目录） |
| 3 | 视频实时字幕应该默认自动开启，可以手动关闭 | 引擎和模型都齐了就自动进采集待命（此时还没播，不吃 CPU）；没齐照旧显示引导页，**绝不偷偷下载 212 MB**。「手动关闭」的语义：自己按「暂停」= 记下来，下一个视频也不自动开；再按一次「开启」即恢复 |
| 4 | 每个保存笔记的按键都放一个快捷键提示 | 批注「保存」、译文「存入笔记」都印上了 `Ctrl ↵` 角标（笔记编辑器的保存按钮 3.9.4 起就有），和 `title` 里的 `Ctrl+Enter` 对上 |
| 5 | 摘录卡片下面那一排按钮挤得字都竖排了 | 允许整行换行、按钮文字 `white-space: nowrap`：排不下就整行往下走，而不是把「写笔记」压成两行。「删除」固定在行尾右侧，顺手动作和破坏性动作分开 |
| 6 | 顶部工具栏各功能模块之间距离不等距 | 原来是 `space-between` + 搜索框 `margin: 0 -6px`，每两组间距都不一样。统一成一个 `gap: 10px`，多余宽度全交给搜索框吸收，其余组之间都是同一个间距 |
| 7 | 点摘录或笔记，PDF 阅读区还是会闪一下蓝 | 那层是铺满整页的 `--accent-soft` 蒙版。改成只在**这条摘录自己的矩形**上描一圈再淡出：信息更准（闪的就是目标），也不再整页泛蓝 |
| 8 | 进工作台再退出，「工作台」按钮上还留着黄圈 | 鼠标点过的按钮一直保留焦点，浏览器默认焦点环就一直挂着。退出时把焦点收回去；顶栏按钮的焦点圈改成自己画（鼠标点击不给、键盘 Tab 才给） |
| 9 | 悬浮工具栏的「摘录」按钮不需要蓝色 | 四个键（摘录 / 摘录并笔记 / 翻译 / 复制）是平级动作，蓝色凭空造了个主次。改成与其他一致，只保留一点点字重 |


### 更新记录 · 3.13.0（视频字幕每次打开都从头生成）

| # | 反馈 | 处理 |
| --- | --- | --- |
| 1 | 每次打开视频，字幕都应该重头生成 | 字幕不再按条目缓存：打开视频就清空列表、删掉旧版本留下的 `<数据目录>/asr/subs/<key>.json`，按钮回到「开启」。原因不只是「想要新的」——旧实现的「续播」根本不成立：重开的播放位置是 0，新转的句子接在旧句子后面，时间轴直接错位，看着像同一段说了两遍；而且老缓存里是没有精修、没有标点的粗字幕，摆在面前比空着更误导。<br>**代价**说清楚：不留缓存 = 关插件前记得点「导出」。音频归档 `<asr/audio/>` 保留（精修与导出要它）。<br>顺带修一个串台 bug：换视频时还在飞的翻译 / 精修任务带了代次校验，迟到的结果不会写到新视频的行上 |


### 更新记录 · 3.12.1（视频色板间距与 PDF 顶栏对齐）

| # | 反馈 | 处理 |
| --- | --- | --- |
| 1 | 视频下方选标记颜色时，色点之间太挤 | 视频工具条的色点间距从 5px 改成 **9px**，和 PDF 阅读区顶栏那排色点同一个节奏。两处是同一个动作（选下一笔用什么颜色），间距一致才不会换到视频就点歪 |


### 更新记录 · 3.12.0（字幕分层精修 / 音频归档 / 术语表 + 上下文 / 修没声音与色块残留）

| # | 反馈 | 处理 |
| --- | --- | --- |
| 1 | 开实时字幕后视频**没声音** | 3.10 的接线是 `src → proc → destination`，而 `ScriptProcessor` 的 `outputBuffer` 默认全 0、代码从来不往里写 —— 等于「声音被 WebAudio 接管后，又送进一个不发声的旁路」。改成两条并行支路：原声 `src → destination` 直达（零延迟），采集 `src → proc → 增益0 → destination`（ScriptProcessor 必须挂在输出上才会被调度，增益 0 保证不重复出声）。另外 `detach()` 以前会把 `srcNode` 全断开，等于关掉字幕后视频永久静音，现在只拆旁路 |
| 2 | 实时字幕准确性太差 | 分两层：**实时层**照旧出字（`greedy_search` 换成 `modified_beam_search`，4 条候选路径回看，中英混说的句子不再一条路走到黑）；**精修层**在每句落定后，把那几秒音频交给非流式模型 **SenseVoice**（中/英/日/韩/粤，自带标点）重听一遍，替换掉粗字幕。实测 10 秒音频 186 ms（RTF 54×），`decodeAsync` 跑在线程池里，播放不卡 |
| 3 | 核心目的是把音频作为知识库的一部分 | 音频同时**归档**到 `<dataDir>/asr/audio/<itemId>.pcm`（16 kHz 单声道 int16，按时间戳随机写，回拖进度条天然覆盖）。三个用处：精修要重听、重开插件不用重播、原始音轨本身就是资料。可导出为 wav |
| 4 | 划词翻译怎么保证准确性 | ① **上下文**：取出选区所在文字层的前后 480 字一起交给本地模型（`dissection` 是解剖还是夹层，看语境）；② **术语表**：一行一条 `英文 = 中文`，翻译时只注入「这句话里真的出现过」的术语（最多 24 条），词边界匹配，`he` 不会被 `the`/`other` 带出来。两者都只对本地模型生效（在线接口没这个能力）；在线通道有变的只是缓存键会跟着术语表变 |
| 5 | 又出现「删了摘录、PDF 上高亮还在」 | 根因是 `mix-blend-mode` 把每个色块提升成独立合成层，删 DOM 只算「层内容变了」，贴图被复用就会留在画面上，直到整页重排（重开文档）。改成**每次重绘都换一个新的 `hlLayer` 节点**，旧节点连同它的 RenderSurface 一起释放；`sweep()` 也从「删掉孤儿节点」升级为「发现孤儿就整页重绘」，并补一次 220 ms 后的复扫（删除动作会连带触发注释同步、PDF 重写，中间任何一帧重绘都可能把色块画回来） |

**代价与边界，先说清楚**

- 精修模型 **239 MB**，是可选的（引导页勾选才下）。不下也能用，只是只有粗字幕；头部「精修·未装」随时可以补下。引擎 + 流式模型 + 精修模型全套约 450 MB。
- 精修比流式慢一个数量级（一句 0.1–0.3 秒），但它排在线程池里串行跑，不抢播放的 CPU。**字幕会先出粗的，几百毫秒后被换成准的**，同一行右侧时间戳变绿点就是被精修过。
- 音频归档 **1 分钟 1.9 MB / 1 小时约 115 MB**，存在插件数据目录，不删。介意的话可以手动清 `asr/audio/`。
- 术语表只影响「本地模型」这一条通道。用有道/Google 兜底时，能做的只有译法一致（靠缓存），没法注入术语。
- **SenseVoice 对静音会编内容**（实测全 0 输入得到 `그.`），所以精修前先算 RMS，低于 -50 dBFS 直接跳过；跳转后 pcm 里的空洞正好走这条路。


### 更新记录 · 3.11.0（笔记多一份 Markdown 副本，落在资料库自己的 `_notes` 里）

- 每篇文档的摘录与笔记会同步写一份 Markdown 到 `<资料库>/_notes/<itemId>-<书名>.md`，图片落 `_notes/assets/<itemId>/`，正文用相对路径引用。
- **只是副本**：权威数据仍是 `docs/<itemId>.json`（坐标 / 颜色 / 时间轴 / 附件），MD 可以删、可以重建，插件不从 MD 回读。
- 整篇重写 + 内容哈希幂等（打字停 2.6s 才落盘）；书名改了自动删旧文件，删掉的摘录会连带清理 png；`_notes` 里用户自己放的文件一律不碰。
- 工作台「索引与维护」新增：`_notes` 路径、`生成 Markdown 副本` 开关、`打开笔记目录`、`重建全部 Markdown`。
- 没有新建资料库：Eagle 插件 API 只有 `library.info()/name/path/modificationTime`，**不能建库、切库、枚举库**，且 Eagle 不索引文件正文。


### 更新记录 · 3.10.0（视频实时字幕：左栏上半出字，中文不翻、英文双语）

| # | 反馈 | 处理 |
| --- | --- | --- |
| 1 | 打开视频时，左栏下半显示历史记录，上半部分给实时语音转文字 | 视频模式下左栏一分为二：**上半=实时字幕，下半=历史记录（34%）**。3.4.0 曾把视频模式下的上半栏整块 `display:none` 让历史记录撑满，这次放开那一刀，中间的分隔条也回来了，可以上下拖动调比例 |
| 2 | 中文的话不用翻译，英文的视频保留双语 | 中文条目只显示原文；英文条目在原文下面补一条中文译文（走现有翻译通道，在线/本地都行）。**判断按整段视频的票数**：中文句不少于英文句就算中文视频，夹在里面的英文也不单翻 —— 否则「今天讲 Transformer 和 attention」这种会被抠出半句去翻，读起来更乱 |
| 3 | 要「实时」，不是先转完再给你看 | 选 sherpa-onnx 的**流式**识别（不是 whisper 那种整段跑完才出字）：音频从 `<video>` 用 WebAudio 实时抓，0.1 秒一块喂进去，说话停 1.2 秒就落一条字幕，第一句话不到两秒就出现在左栏。实测 10 秒音频端到端 130 毫秒 |
| 4 | 为什么不复用已经装好的 Ollama | Ollama 只有文本和视觉模型，没有声学模型，喂不进音频。whisper.cpp 能用但它的 Windows 二进制只在 GitHub Release 上（国内常连不上），而且非流式，长片要等好几分钟才有第一句 |
| 5 | 不想为了这个功能再装一堆东西 | 插件里点一次「开启」，引擎（23 MB，npm 镜像）和模型（189 MB，hf-mirror）自己下好解压到位，缓存在数据目录，之后离线可用。插件包本身只增加了 36 KB 代码，没有被撑大 |
| 6 | 字幕和播放位置对得上吗 | 每条字幕带起止时间，播到哪条哪条就高亮；点任意一条跳到那个时间点。视频跳转后会重置识别流，否则会把跳转前那半句接着读下去 |
| 7 | 换个视频、关掉再打开，字幕还在吗 | 按 Eagle 条目缓存到 `<数据目录>/asr/subs/`。再打开同一个视频直接显示上次的字幕，可以从上次停的地方接着转（**3.13 起改为每次打开都从头生成**，见下） |


### 更新记录 · 3.9.5（自己找到本机的 ollama，不用再手填路径）

| # | 反馈 | 处理 |
| --- | --- | --- |
| 1 | 「插件不能自己检测我装没装 ollama 么，非要我输入 ollama 位置？」 | 能。原来只看 `%LOCALAPPDATA%\Programs\Ollama` 和 `%ProgramFiles%\Ollama` 两个目录，凡是绿色版 / 装在别的盘的一律判成「没装」。现在七步依次找：记住的路径 → 设置/环境变量 → 标准位置 → `PATH`（`where ollama`）→ **正在跑的 ollama 进程的 exe 路径** → 卸载表登记的 InstallLocation → 兜底扫一遍常见目录。命中即停，找到后记住，下次开机第一次 `statSync` 就命中 |
| 2 | 扫盘会不会很慢 / 会不会翻遍全盘 | 家目录排第一（绿色版多半在这里），系统盘根目录放最后；有预算（9 秒、最多 4 万目录）和深度上限；只读目录名不读文件内容；跳过 `node_modules`、`AppData`、隐藏目录。实测这台机器命中在 **几十毫秒**内。每个根目录单独走 BFS —— 早先版本把根目录塞进同一个队列，`C:\` 会先把预算吃光，家目录那层永远轮不到，这是「明明装了却说没装」的直接原因 |
| 3 | 不想每次失败都等一遍扫盘 | 扫过没找到会记 12 小时内不再自动扫；点「检测」或「自动查找」会清掉这条记忆，立刻重扫 |
| 4 | 引导条只有「填路径」一格，等于让人自己去翻文件 | 改成两行：**「自动查找」按钮**（找到就直接用它启动，路径同时填进输入框供核对）+ 手填路径作为兜底。查找那几秒状态行显示「正在本机查找 Ollama…」，按钮变「查找中…」 |
| 5 | 失败提示文案不对 | 以前说「还是没起来，填一下路径」，现在如实说「没找到本机的 ollama.exe —— 可能确实还没装」。找到时提示「找到了（运行中的进程）：C:\…」 |


### 更新记录 · 3.9.4（Ctrl+Enter 保存笔记）

| # | 反馈 | 处理 |
| --- | --- | --- |
| 1 | 加入 Ctrl+Enter 保存笔记 | 编辑器里原本就绑了一份，但只在光标停在正文时才响 —— 点过预览、点过附件、或者焦点被浮层抢走，那一下就没反应了；用拼音输入法选词时反而会误存半句话。现在改成两层：编辑器内部保留（补了输入法判断），`onKeyDown` 再加一层应用级兜底，**不看焦点在哪**，只要手头有正在写的东西就存。按钮上直接印 `Ctrl ↵` 角标，存完自动清空 |
| 2 | 同时开了好几个框时，这一下该存哪个 | 按层级：批注浮层 / 笔记大框（模态优先）→ 光标所在的编辑器 → 翻译框（存译文）→ 右栏编辑器。避免「明明在写笔记，回车存进去的却是刚才那条译文」 |
| 3 | 输入法选词时被误存 | `e.isComposing || e.keyCode === 229` 直接放过，那一下 Enter 是「确认候选」，不是「保存」 |
| 4 | 每日笔记也要能立刻存 | 平时 600ms 防抖自动保存，`Ctrl+Enter` 走 `Workbench.flushDaily()` 跳过等待，底部统计行立刻变成「N 字 · 已保存」 |


### 更新记录 · 3.9.3（翻译渠道与 OCR 状态都摆到明面上）

| # | 反馈 | 处理 |
| --- | --- | --- |
| 1 | 划词 / 摘录翻译到底走的是本地模型、有道还是别的？哪条能用？ | 翻译框下面加一条**渠道条**：本地模型、有道智云、有道（免密钥）、Google、MyMemory 全列出来。可用的亮着、不可用的置灰、这次实际用的那条打「本次」并高亮；鼠标停在上面能看模型名、上次耗时、上次失败原因。数据是真的：本地模型问 `/api/tags` 与 `/api/ps`，有道看密钥有没有填，在线通道记各自最近一次的成败（内存里，不落盘） |
| 2 | 本地模型没起来的时候不知道怎么办 | 渠道条里的「本地模型」灰掉时可以**点一下**，等于让它现场去拉服务；起来后回一句「正在试着拉起本地模型…」→ 状态自己变绿，不用再去翻设置 |
| 3 | 摘录卡片上的译文看不出是谁翻的 | 译文旁边加一枚渠道小标（本地模型 / 有道 / Google…），同一段文字用不同渠道翻出来风格不一样，看这个能对得上 |
| 4 | OCR 的视觉模型有没有在运行，还是已经关了？ | 右栏那条状态从「就绪就整条收起」改成**常驻一行**，直接写「OCR 就绪 · qwen2.5vl:7b 已加载」；模型被卸出显存就变成「未在显存」（第一次识别会多等几秒）。判断依据是 `/api/ps` —— 它列的就是此刻真正占着显存的模型，比按时间戳猜准 |
| 5 | 显存被占着，想马上收回来 | 展开「详情」多一行：显存占用多少、几分钟后自动释放、一个**释放显存**按钮（发 `keep_alive: 0`，立刻卸载，不用等 5 分钟闲置，也不用关插件） |
| 6 | 状态会不会一直是旧的 | 打开文档后每 20 秒重读一次 `/api/ps`，窗口藏起来时不刷。只读不发推理请求 —— 否则模型永远闲不下来，显存放不掉 |


### 更新记录 · 3.9.2（打开插件自动拉起本地模型 / 状态不再误报）

| # | 反馈 | 处理 |
| --- | --- | --- |
| 1 | OCR 需要的本地视觉模型，没有随着插件打开自动运行 | 3.9.0 为了消灭「一打开就闪控制台窗口」，把开机时的 `ensureServe()` 摘掉了，只剩「探活 + 预热」—— 结果装了 Ollama、但这次开机后服务没起的机器，右栏一直挂着「未检测到 Ollama」，用户得点一次 OCR 才会被拉起来。现在恢复自动拉起，且开机时机提前到插件启动 1.5 秒（停在工作台里也会拉，不必先打开文档）：`bootLocalAi()` = 探活 → `ensureServe()` → `force` 重探 → 预热 → 刷新右栏。闪窗的两条根因（`detached: true` 与 `ollama app.exe` 候选）在 3.9.0 已经修掉，所以这次拉进程是真正无窗口的；找不到 exe 就安静失败，失败后 30 秒内不重试 |
| 2 | 右栏写「未检测到 Ollama」，可服务明明在跑 | `probeLocal()` 原来把 `probe.ok` 定义成「至少有一个模型」，于是 `/api/tags` 返回 200 但 `models` 为空（Ollama 刚装好、还没 pull）会被判成 `null`，界面就说「没装」。改成「HTTP 通了就是通了」，返回 `{ serve: true, model: '' }`，界面正确显示「已在运行 · 还缺视觉模型」，第 1 步自动打勾。翻译链路补了 `local.model` 判断，避免拿空模型名去请求 |
| 3 | 拉服务的几秒里界面看不出在动 | `envState` 加 `starting`：正在后台拉服务时写「正在启动本地模型…」，不再先写一句「未检测到」再改口 |
| 4 | 免安装版（解压即用）用户没地方填 exe 路径 | 出口原来只藏在翻译面板的齿轮里。右栏「本地增强」展开后底部直接加一格「解压即用版：填 ollama.exe 完整路径 + 用它启动」，回车也能提交；填完立刻 `resetServeHint()` + 重新拉起，不用等 30 秒冷却，也不用去找齿轮 |
| 5 | 填了 exe 路径却像没生效 | 两个真实 bug：① `checkEnv` 探测成功后回填模型名时调 `setLocal({url, model})` —— 而 `setLocal` 是**全量写入**，少传 `exe` 就把用户刚填的路径抹掉了；改为连同 `exe` 一起写，并在注释里标死这条约束。② 保存翻译面板配置时只 `doTranslate()`，不重新拉服务，改完路径得等下次开文档；现在保存后立刻 `bootLocalAi()` |
| 6 | 手动点「检测」还是慢半拍 | `redetectEnv` 先 `resetServeHint()` 再 `ensureServe()`：用户亲手点检测就是明确要再试，不该被「刚失败过、等 30 秒」的节流挡住 |


### 更新记录 · 3.9.1（删除后阅读区的色块立刻消失）

| # | 反馈 | 处理 |
| --- | --- | --- |
| 1 | 点删除后摘录栏 / 笔记栏空了、Eagle 注释也同步了，但 PDF 阅读区那块高亮还在，得重新打开文件才消失 | 右栏和注释是「按数据重算」，标注层却是「按页码局部重绘」—— 只重画 `ann.page` 那一页。一旦这块色块被画在了别的页上（跨页选中时记录过页码、page 与 rects 不一致），或者那次重绘正好撞上页面重新渲染 / 缩放而被打断，就留下一个**数据里已经没有、画面上还在**的色块，只有重开文档（整页重建）才会清掉。<br>修法三层：① `refreshAnnotations()` 这条唯一出口里补一步 `annMgr.sweep()` —— 拿「当前数据里的 id 集合」去跟画面上所有 `[data-ann-id]` 对账，数据里没有的一律摘掉，整页已经没有任何标注的 `hlLayer` 直接清层；② 清层从 `innerHTML=''` 换成 `replaceChildren()`，走「移除节点」的正常路径，不留给合成层残留的机会；③ 层被清空后再 `forceRepaint()` 一帧（把空层藏掉、下一帧放回），兜住 CEF 里 `mix-blend-mode` 色块被删后偶发不重绘的情况。<br>`sweep()` 只遍历已经渲染出来的几十个节点，成本可以忽略，每次数据变更都会跑一遍 |


### 更新记录 · 3.9.0（不再闪控制台窗口 / 删除笔记立即同步注释）

| # | 反馈 | 处理 |
| --- | --- | --- |
| 1 | 第一次打开插件，会有一堆 CMD 的框弹出来又消失 | 两个原因叠在一起：① 拉服务时用了 `detached: true`，而 Node 在 detached 分支里**不传 CREATE_NO_WINDOW**，`windowsHide: true` 形同虚设，每拉一次就闪一个黑窗；② `ollamaExeCandidates` 里还留着 `ollama app.exe`（带托盘的 GUI 启动器），把 `serve` 当参数递过去它不认，会弹出自己的窗口。改法：Windows 下不带 detached、删掉 GUI 启动器候选、整轮拉不起来就歇 30 秒再试。更关键的一条：**打开文档时不再拉进程** —— 预热只探 `/api/tags`，探不到就安静放弃，等用户真的点翻译 / OCR 才 `spawn` |
| 2 | 对视频和 PDF 做笔记时会同步到注释，删除笔记也应该同步 | 删笔记原来只动了插件里的数据：`removeNoteEntry` 里那条 `syncLater()` 走的是 1.2 秒防抖，用户删完就关窗的话根本没写出去。现在：① 删除动作**立即**写注释（先 `syncLater.cancel()` 再直接写，避免两次写打架）；② `refreshAnnotations()` 这个「唯一出口」补上同步，于是新增 / 修改 / 删除 / 撤销四条路都会重算注释；③ 撤销删笔记、撤销新增笔记、撤销改笔记的闭包也补了同步；④ 删最后一条笔记写的是空串，这类写最容易「看着成功实际没生效」，写完读回核对一次，不对就再写一遍，仍失败则明确提示，不再默默停在旧内容 |


### 更新记录 · 3.8.1（点阅读区不再冒出一圈焦点框）

| # | 反馈 | 处理 |
| --- | --- | --- |
| 1 | 打开 PDF，点一下阅读区，阅读区会显示一个框 | 3.7.0 给 `#viewport` 挂 `tabindex="-1"` 是为了把键盘焦点抓进来（否则 ←/→ 被 Eagle 当成切素材），但浏览器会给「被点到的可聚焦元素」画一圈系统焦点框。补 `.viewport:focus / :focus-visible { outline: none }`，视频区 `#videoStage` 同样处理 —— 焦点照旧在，只是不画那圈。功能零改动，纯观感 |


### 更新记录 · 3.8.0（上架准备：跨平台路径合规 / 首次运行环境向导）

| # | 问题 | 处理 |
| --- | --- | --- |
| 1 | 本地模型 10 GB，不可能打进 4.9 MB 的插件包 | 定调为**可选增强**：模型不进包，改由用户自己装，插件负责「发现 + 说明 + 引导」。翻译本来就有在线兜底，只有 OCR 是硬依赖，所以把引导做在 OCR 的必经之路上 |
| 2 | 代码里扫 `%USERPROFILE%\WorkBuddy\*\local-ai\ollama\ollama.exe` | 这是**开发机专属路径**，别人机器上永远不存在。Eagle 审核明确禁止依赖只在开发者电脑上有的路径，已整体删除。改为按 `process.platform` 分流，只认厂商标准安装位置 + `OLLAMA_EXE` 环境变量：Windows `%LOCALAPPDATA%\Programs\Ollama`、macOS 官方 App 内的 `Contents/Resources/ollama` 与 Homebrew 两种前缀、Linux 的 `/usr/local/bin` `/usr/bin` `/snap/bin` |
| 3 | OCR 失败的提示写「先启动 Ollama（local-ai/ollama/start-ollama.bat）」 | 用户机器上没有这个文件，看到只会更懵。改成指向 `ollama.com/download` + 具体 pull 命令 + 「回插件点重新检测」；`VISION_SUGGEST` / `VISION_SMALL` / `OLLAMA_SITE` 抽成常量，文案和界面共用一份 |
| 4 | 用户不知道 OCR 为什么按不了 | 右栏新增常驻一条「本地增强」：一行说清当前状态（未检测到 Ollama / 还缺视觉模型），点开是三步引导（下载 → 一键复制 pull 命令 → 重新检测），服务通了第 1 步打勾、模型有了第 2 步打勾，**全部就绪后整条自动隐藏**。平时只占一行，不打扰不用 OCR 的人 |
| 5 | OCR 撞到缺环境时只弹一句红字 | `ocrAnn` 捕获到「缺 Ollama / 缺视觉模型」时，toast 改成说人话的一句「已在右栏展开设置」，同时**自动展开向导**并重新检测 —— 把用户送到能解决问题的地方 |
| 6 | 上架材料 | README 新增 §0「运行环境与可选依赖」，写清哪些功能零依赖、OCR 需要什么、三步安装、平台差异与未实机验证的部分；`manifest.devTools` 保持 `false`；打包脚本继续排除 `Plugins/` 开发源码目录 |


### 更新记录 · 3.7.0（撤销 / Delete 三处一致 / 卡片内翻译与 OCR / 笔记定位 / 自动拉起模型）

| # | 反馈 | 处理 |
| --- | --- | --- |
| 1 | 加 Ctrl+Z 撤回上一步操作 | 新增 `js/undo.js`：只记录**改数据**的动作（新增 / 修改 / 删除摘录，新增 / 修改 / 删除笔记），翻页缩放这类视图状态不进栈。每条只存一个闭包（不存快照，图片 base64 存不起），撤销执行期间静音、不会把撤销动作又记一遍。跨页选一段话只算**一步**。换文档时清空栈（撤销一步跨文档的删除会把内容塞进另一份文件）。带 `Ctrl+Shift+Z` / `Ctrl+Y` 重做 |
| 2 | PDF 阅读时左右键翻页，现在是切 Eagle 下一份文件 | **按键没进插件**，跟空格同一个病根：焦点在 Eagle 主窗口时，方向键先被宿主当成「上一张/下一张素材」。改法：`#viewport` 加 `tabindex="-1"`，`grabKeys()` 在 PDF 下聚焦阅读区（视频下仍聚焦 `#videoStage`），打开文档后与每次点阅读区都抓一次。`←/→` 本来就在 `onKeyDown` 里映射到 `goToPage`，之前只是轮不到它执行 |
| 3 | 文字摘录要能翻译，图片摘录要能 OCR | 摘录卡片按类型给键：有图 → **OCR**（原有）；纯文字 → **翻译**（新增）。译文存进 `ann.translation`，卡片里以蓝线块显示在原文之下、笔记之上，随数据持久化，下次打开直接看；翻译与划词走同一条链路（本地模型优先），完成后再点变「重新翻译」 |
| 4 | Delete 键要能删选中的摘录/笔记/时间轴标记，别删 Eagle 素材；且 PDF 文件、阅读区、右栏三处要一致 | 捕获阶段无条件拦下 `Delete`（没选中时只提示，绝不漏给 Eagle）。选中态：点卡片=选中、点阅读区高亮=选中、点时间轴色块=选中（`setMarks` 带 `id`，色块 `pointer-events:auto`）。删除统一走 `refreshAnnotations()`：标注层重绘 + 右栏两栏重绘 + 索引落盘 + `schedulePdfSync()` 写回 PDF。顺带修了「删笔记把摘录图片一起删掉」——图片属于摘录，删笔记只清正文与附件 |
| 5 | 摘录并笔记时，笔记框没输入前按 Esc 应取消，不保留摘录/截屏 | `openComposer(..., {fresh:true})` 把「本次新建的那条」记在 `ctx.freshAnnId`；关框时若还没保存就 `rollbackFresh()` 真删除（不进回收站、不记撤销），提示「已取消，这次摘录没有保留」。保存成功时先清掉这个标记，所以「保存后关闭」不会误删。编辑已有笔记再关闭不受影响 |
| 6 | 点摘录能跳转，点笔记不能；有引用的笔记应跳到对应位置，没有引用要提示 | `jumpToNote()`：优先跳到被引用的那条摘录（视频则 seek），其次页码/时间点；都没有就明确说「这条笔记没有引用摘录，也没有页码，无法定位」。点卡片正文即可跳（以前只有「定位」按钮能跳），「定位」按钮的显示条件也放宽到 `page / t / annId` 任一存在 |
| 7 | 摘录/笔记多了以后，新加的要看得到 | 新增摘录 → `scrollExcerptTo()`（顺带切到「摘录」页签）；新增笔记 → `scrollNoteTo()`（切到「笔记」）。列表按时间倒序，新内容在顶端，不滚过去会像「没生效」 |
| 8 | 视频截图 OCR 提示没检测到模型；应像划词翻译一样自动启动，5 分钟不用就释放显存 | `Translator.ensureServe()`：先 `/api/tags` 探活，不通就按 `LOCALAPPDATA\Programs\Ollama`、`%USERPROFILE%\WorkBuddy\*\local-ai\ollama\ollama.exe` 找可执行文件并 `spawn serve`（带 `OLLAMA_HOST/KEEP_ALIVE/CONTEXT_LENGTH=8192/NUM_PARALLEL=2`，与 bat 对齐），最多等 15 秒；10 秒内不重复尝试。翻译与 OCR 都会先调它。保活 `KEEP_ALIVE` 10m → **5m**，OCR 的 3m 也统一到 5m（原来两个模型切换会多等一次换载） |
| 9 | 清除之前的记录（包括历史），或把清历史的入口放到工作台 | 工作台维护区新增「清空阅读历史」，「清空全部摘录与笔记」也一并清历史 + 清栈 + **逐个抹掉 PDF 文件里插件写入的高亮**（先 `countMarks` 探，文件里没有就一个字节不动），清完 `renderAll()` 整页重绘。另外左栏「历史记录 → 清空」这个按钮**从来没绑过事件**，这次接上了 |


### 更新记录 · 3.6.0（色板挨着截图键 / PDF 筛选圈内文字改「摘录」）

| # | 反馈 | 处理 |
| --- | --- | --- |
| 1 | 视频界面，选颜色挨着截图按键 | 色板原本在时间右边，中间隔着一个 `spacer`，离六个标注键很远，换色要横跨半个工具栏。现在把 `#vsSwatches` 挪进 `#vsActs` 里，排在「截图」左边，右侧加一条 `border-right` 细线分隔——选色和按截图在同一处，手不用来回找。顶栏那份色板照旧只在 PDF 下显示 |
| 2 | PDF 界面右栏摘录下面的圈内文字，把「高亮」改成「摘录」 | 面板叫「摘录」、卡片也叫摘录，唯独筛选圈写着「高亮」，同一件事两个说法。`PDF_FILTERS` 与 `index.html` 里的静态文案一起改成 **全部 / 摘录 / 框选 / 锚点**；`data-filter` 仍是 `highlight`，底层类型与 PDF 写入逻辑都不用动，老数据照样筛得出来 |


### 更新记录 · 3.5.0（视频：空格归属 / 时间轴与计时 / 筛选语义 / 长文展开 / 复制分家）

| # | 反馈 | 处理 |
| --- | --- | --- |
| 1 | Eagle 里空格打开视频后，再按空格还是退出插件 | **不是代码没接住，是按键根本没到插件**。Eagle 的「空格关预览」由主窗口处理；插件在 iframe 里，焦点还在 Eagle 那边时，键盘事件不会进本页面，`preventDefault` 无从谈起。改法：`#videoStage[tabindex=-1]` + `grabKeys()`（`window.focus()` + 聚焦视频区），打开视频时调用，任何 `pointerdown` 也重新抢一次；`keydown` 改为**捕获阶段**监听（先于原生 `<video controls>`），`keyup` 上的空格一并吞掉，防宿主在抬起时判关闭。若个别环境仍抢不到焦点，点一下画面再按即可 |
| 2 | 视频模式顶栏：工作台靠右，挨着明暗 | `.tb-spacer` 原为 `flex:0 0 0`（PDF 下靠搜索框 `flex:1` 顶满），视频下搜索框一藏就没东西撑开。给 `.topbar.video-mode .tb-spacer` 单独设 `flex:1`，于是「缩放在左、工作台+明暗贴右」，PDF 布局一点不受影响 |
| 3 | 视频下也要能选标记颜色，否则全是黄的 | `renderSwatches()` 多渲染一个 `#vsSwatches`（在视频下方工具栏），视频模式只切换显隐：顶栏那份照旧收起，下方这份亮出来。截图/框选/片段都取 `state.currentColor`，选了什么色就记什么色 |
| 4 | 摘录下的小圆框（筛选）在视频下是「全部/框选/锚点」，跟功能对不上 | 同一批 chip 按模式换语义：视频为 **全部 / 截图 / 框选 / 片段**，PDF 仍为 全部 / 摘录 / 框选 / 锚点（3.6.0 起把「高亮」改叫「摘录」）。底层截图、框选、片段的 `type` 都是 `area`，所以新增 `vt` 字段（`shot/area/clip/mark`）区分「做了什么」；老数据没有 `vt` 时按 `t1` 有无推断，不会看漏 |
| 5 | 节选时想看到已选多长（有个计时），时间轴上也要标出哪里截过图/框/片段 | 新增 `#vsClipTimer`（盖在画面左上角）：按第一下从 **00:00** 起算，实时显示 `已选时长` 与 `A → B`。新增 `#vsTrack` 自绘时间轴：截图/框选画点、片段画区间，**颜色就是各自的标记色**，悬停显示类型与时间；片段进行中还会画一段 A→当前 的临时区间 |
| 6 | 节选时想拖时间轴 / 按右键快进，不想等播到 B | `#vsTrack` 支持按下即定位、按住拖动连续定位；`←/→` 每次 ∓/+5 秒（`↑/↓` 30 秒），按住可连发。片段进行中两个入口都可用，定位到哪就在哪按第二下取 B |
| 7 | PDF/视频的摘录或笔记文字太长，右栏看不全，要能展开 | 新增 `addExpandable()`：正文超阈值时加 `is-clamped`（摘录 5 行 / 笔记 8 行 / 笔记里的引文 2 行）并挂一个**展开全文**按钮，点开 `expanded` 还原全文、再点收起。摘录正文与笔记正文的原始行数限制已从基础样式里拿掉，避免"被截断却没有按钮" |
| 8 | 摘录里点复制，复制的应该是摘录而不是笔记；有笔记时应拆成两个键；笔记里复制只复制笔记 | 摘录卡片：无笔记只有 **复制摘录**，有笔记则 **复制摘录** + **复制笔记**（分别 `copyex` / `copynote`）；图片摘录且无文字时仍走剪贴板写图。笔记页签的 **复制笔记** 只复制 `n.md`，不再把「原文引用」拼进去 |


### 更新记录 · 3.4.0（视频模式重做：界面 / 空格 / 标注暂停联动 / 图片 OCR）

| # | 反馈 | 处理 |
| --- | --- | --- |
| 1 | 搜索框有文字时按 Esc 应该清空并退出搜索，现在直接退出插件了 | 两处根因。① 搜索层原来只在 `runSearch()` 里入栈，而输入框 `debounce` 220ms 才触发它——"打完字立刻按 Esc"的瞬间栈是空的，Esc 就落到"退出插件"。改成**输入框一有字就入栈**，不等索引。② 输入框自己的 Esc 处理只 `stopPropagation` 没 `preventDefault`，且清完搜索后栈已空；现在补 `preventDefault`，并在 document 层加兜底：栈空但搜索框还有字时，那一 esc 只清搜索 |
| 2 | 空格键冲突：希望「Eagle 里按空格 → 打开插件、视频载入」，再按空格才播放 | `openVideoItem` 记 `openedAt`，**打开后 600ms 内的空格忽略**——Eagle 那次"打开"的按键若跟着送进来，不会让视频一进来就自己播。之后空格就是正常播放/暂停，退出仍走 X 或 Esc |
| 3 | 视频模式下左侧栏不用目录和缩略图，只留阅读历史；并把「阅读历史」改叫「历史记录」 | `.left.video-mode` 把 `#leftTop`（目录/缩略图/搜索面板）和分隔条整块收起，历史区 `flex:1` 撑满；标题改为「历史记录」。PDF 模式同名（需求 2） |
| 4 | 视频模式顶栏：去掉翻页，从缩放开始，适宽在左，右侧只留工作台和明暗，不要搜索 | `applyModeUI()` 统一开关：视频时隐藏 `#pageGroup` / `#swatchBar` / `#toolGroup` / `#searchBox`，缩放组自然落到最左。缩放作用于视频显示倍率（50%–200%，适宽=100%），`--vs-zoom` 驱动宽度与 `max-height`，放大后可滚动。Ctrl+F 在视频模式明确提示"没有全文搜索" |
| 5 | 截图 / 截图并笔记 / 框选 / 框选并笔记 / 节选片段 / 节选片段并笔记 这些按钮放到视频下方 | 视频底部工具栏改成 6 键（原来只有打点/片段/截帧）。摄影机语义对齐：**截图并笔记**即原"打点"（截帧+写笔记），原按钮已移除。**框选是新功能**：`VideoView.beginArea()` 在画面上拖矩形，按 `object-fit: contain` 的实际画面区换算回视频像素再裁剪，避免黑边导致偏移 |
| 6 | 启动这些功能时视频暂停，完成（或取消）后自动继续 | `pauseForVideo()` / `resumeVideo()` 记住"开始前是否在播"，只在原本在播时恢复，不会把暂停的视频弄成自动播放。规则：截图、片段取 A 点**不暂停**；截图并笔记、框选、框选并笔记、片段取 B 点**暂停**；笔记框关闭（保存/不保存都算）或框选 Esc 取消后恢复 |
| 7 | 摘录内容是图片时想要 OCR（讲课视频截图），方便复制和做笔记 | 新增 `Translator.ocrImage()`：走本机 Ollama 的**视觉模型**（自动挑 `qwen2.5vl` / `llava` / `minicpm-v` 之类），图片不出本机、绝不偷偷走联网 OCR。图片摘录卡片的按钮组多一个 **OCR**（识别过的显示「重新识别」），结果写进摘录正文，可直接复制或"写笔记"带入。没装视觉模型时明确提示 `ollama pull qwen2.5vl:7b`。实测 1280×720 中文幻灯片：**命中率 100%、热态 1.45 秒、5 行分行完整**；顺带发现两个模型（5.6 + 6.2 GB）装不进 12 GB 显存，换载一次要 3.9 秒，所以改成**优先共用视觉模型**（它做纯文本翻译也是 0.3–0.5 秒，质量相当），一个顶两个 |


### 更新记录 · 3.3.7（显存 10 分钟释放 / 预热改问 /api/ps / 上下文放大）

| # | 反馈 | 处理 |
| --- | --- | --- |
| 1 | 自动卸载时间可以再缩短点，5 或 10 分钟，看文献都是集中时间看的 | 取 **10 分钟**。关键在于**每次翻译都会重置计时器**：集中阅读时无论看多久，只要两次划词间隔不到 10 分钟，模型就一直热着；一停手就释放约 5.6 GB 显存。选 10 而不选 5 的理由是阅读有"想一会儿再划下一段"的节奏，5 分钟容易在思路中断处触发重新加载（+4 秒），10 分钟能盖住绝大多数停顿。`start-ollama.bat` 里 `OLLAMA_KEEP_ALIVE=10m`，翻译请求也显式带 `keep_alive:'10m'`，不依赖服务端全局值 |
| 2 | ——（改保活时长时暴露的隐患） | 预热原来靠 `warmAt` 时间戳做"5 分钟内不重复"，**这个窗口和服务端保活时长是两套互不知情的数字**：保活改 10 分钟、窗口仍是 5 分钟，第 5–10 分钟打开新文档会白跑一次预热；反过来若保活调到 2 分钟，窗口内模型其实已被卸载，预热却不执行。改成先问 `GET /api/ps`：模型在显存就直接返回，不在才发 1 token 请求。实测热态 **67 ms** 返回、只敲 `tags` + `ps`，零加载 |
| 3 | ——（实测发现的截断风险） | Ollama 默认 `num_ctx` 只有 4096，而插件按 900 字切块，长块加 system prompt 和译文会贴到这个上限，超出部分会被静默截断。`start-ollama.bat` 加 `OLLAMA_CONTEXT_LENGTH=8192`，显存占用 5.1 → 5.6 GB（12 GB 卡上两份并发仍宽裕），`/api/ps` 的 CONTEXT 列已确认 8192 |


### 更新记录 · 3.3.6（打开文档就预热本地模型）

| # | 反馈 | 处理 |
| --- | --- | --- |
| 1 | 后台服务是不是被取消了？ | 没有。那是 3.3.5 改并发配置时的**主动重启**（`OLLAMA_NUM_PARALLEL` 只在进程启动时读一次）。顺带查出一个真问题：闲置 60 分钟 Ollama 会把模型从显存卸载，**下次翻译要重新加载 4–10 秒**，体感就像坏了 —— 实测卸载后首次加载 4.02 s |
| 2 | （按用户选择）改成打开文档时预热 | `Translator.warmup()`：向本地模型发一个 `num_predict:1` 的极短请求，把它顶进显存。`openDocument` 成功、`hideLoading()` 之后延迟 1.5 秒异步触发，不和首屏渲染抢资源；同一模型 5 分钟内不重复预热；没装 Ollama 时静默返回 false。实测：冷启动预热 **4631 ms**（这 4.6 秒发生在用户本来就在等渲染的时刻，无感），预热后首次翻译 **673 ms**、第二段 **177 ms** |


### 更新记录 · 3.3.5（划词翻译 5 秒 / 本地模型自动启用 / 长文并行）

| # | 反馈 | 处理 |
| --- | --- | --- |
| 1 | 用 3.3.4 划词翻译要 5 秒左右才有结果 | 查出**三段叠加的浪费**。① 最致命：选中文字时后台已经预翻译（`prefetch`），点「翻译」时 `translate()` **只查缓存、不查还在跑的那份 promise** —— 缓存还没写入，于是又整份重发一次，等待时间直接翻倍。改成先 `await prefetching.get(key)`，等同一份结果（实测点按钮后 189 ms 返回、标记为缓存）。② 首次请求 2.5 秒全花在 DNS + TLS 握手（第二次只要 166 ms），已在 `index.html` 加 `preconnect` / `dns-prefetch`。③ 本地模型没被启用（见下条），5 秒里没有兜底 |
| 2 | ——（用户没在设置里填模型名，本地模型等于没装） | `probeLocal()` 去掉「必须先填模型名」的早退，**默认就探测本机 Ollama**：装着就直接用，一个字都不用配。连不上是 ECONNREFUSED，毫秒级返回且结果缓存 30 秒，没装的用户无感。实测未配置状态：短句 167 ms 就由本地返回 |
| 3 | ——（长文本时本地比云端还慢） | 本地模型 1300 字要 **4.8 秒** —— 插件按 900 字切成 2 块并行发出，但 Ollama 默认 `OLLAMA_NUM_PARALLEL=1`，两块只能排队，时间等于翻倍。`start-ollama.bat` 加 `OLLAMA_NUM_PARALLEL=2`（12 GB 显存装得下两份 4K 上下文），实测 1300 字 **2.7 秒** |


### 更新记录 · 3.3.4（本地模型接通：GPU 上跑翻译 / 空模型名自动探测 / 译文语言自检）

| # | 反馈 | 处理 |
| --- | --- | --- |
| 1 | 翻译慢了、还有 500 字上限，想用本地模型；后面 OCR、图片文字、视频实时转译也要用 | Ollama **免安装版**已就位：`local-ai/ollama/`（0.40.11，2.1 GB，含 `ollama.exe`），模型 `qwen2.5:7b`（4.7 GB）已 pull。实测在这台机器上 **RTX 5070 Ti / 12 GB 显存全量装载**（`compute=12.0 cuda_v13`），生成速度 **59 tok/s**：200 词英文 → 1.3 s，800 词 → 4.3 s，中译英 1.4 s；冷启动一次性 10.5 s（之后 30 分钟常驻显存）。彻底没有字数上限，也不出网。**已配置开机自启**：启动文件夹里的 `Ollama-Serve.vbs` 会在登录时无窗口拉起（日志 `local-ai/ollama/serve.log`）；临时手动重启双击 `start-ollama.bat`，不想要自启就删掉那个 vbs |
| 2 | （顺带修的可用性缺口）装了 Ollama 但设置面板还是提示要自己填模型名，不填就当没装 | `probeLocal()` 原来有 `if (!cfg.model) return null` 的早退 —— 没填模型名就**连探测都不发**，用户只能自己去 `ollama list` 查名字。新增 `forConfig` 参数：打开面板时即使模型名空着也去敲 `/api/tags`，**探到就直接回填到输入框**并提示；探到的模型和已填的不一致时提示本机实际有哪些 |
| 3 | （实机发现）本地模型中译英会把「一是…二是…」原样留在译文里，看着像翻了其实是半截 | 两道修：① system prompt 明确「每个词都要转换，一是/二是 要译成 first/second，不得残留源语言字符」；② 新增 `looksUntranslated()` **译文语言纯度自检** —— 译成外文时残留 **≥2 个汉字**即判不合格（用比例抓不住：4 个汉字 / 330 字符只有 1.2%），译成中文时汉字占比 < 25% 判不合格；不合格先用**严格 prompt 重试一次**，仍不合格就抛错交给有道/MyMemory 兜底 |


### 更新记录 · 3.3.3（高亮与 WPS 同色系 / 四键独立 / 搜索体验收尾 / 视频打开修复 / 翻译换主力）

| # | 反馈 | 处理 |
| --- | --- | --- |
| 1 | PDF 里的高亮确实是半透明了，但和 WPS 自己画的「高亮文本」不是一个观感，希望同色系 | 换成**马克笔配方**：外观流的 `ExtGState` 加 `BM /Multiply`（正片叠底，白纸显色、黑字仍黑），不透明度 0.38 → **0.45**，`/C` 从「提亮 50%」改成**只提亮 20%**（色相/饱和度与插件色板、也就是 WPS 高亮色板同一套）。`PdfWrite.VERSION` 3 → 4，旧文件第一次打开会自动重写一遍 |
| 2 | 摘录 / 摘录并笔记 / 框选 / 锚点 要各自独立成键 | 原来两两挤在两个 `.seg` 里，现在四个都是独立的 `.tb.solo.act`（有自己的边框、圆角、悬停底色），框选/锚点仍带 `.tool-btn` 与 `.active` 态 |
| 3 | 搜索框再长一点，两边顶住「锚点」和「工作台」 | `.tb-spacer` 收成 0，`#searchBox` 加 `margin: 0 -6px` 吃掉左右各 10px 的 gutter，视觉上左右相贴；`min-width: 240px` 保住最小可用宽度 |
| 4 | 搜索状态下按 Esc 反而退出了插件 | 根因：`Esc.push('search')` 只在**有命中**时才压栈，无结果时栈是空的，Esc 就落到「退出插件」那一层。改成**一进入搜索态就入栈**（`Esc.has` 去重），与有没有结果无关 |
| 5 | 搜索时左栏顶部还挂着「目录 / 缩略图」 | 两层原因：① 顶部标题条本来就有，但 `#leftTabs.hidden = true` **根本没生效** —— `.mini-tabs { display: flex }` 的作者样式优先级高于 UA 的 `[hidden]`；② 目录页签因此与结果列表叠在一起。补一条全局兜底 `[hidden] { display: none !important; }`，并给 `.lsp-head` 加上 `⌕ 搜索结果` 的标题条样式 |
| 6 | 资源库里给视频按空格：插件起来了，视频没打开，还报「未能载入」 | 根因不在视频，在**判定**：`openInitial()` 全程用 `if (state.doc) return` 判断「打开了没有」，而视频只有 `state.isVideo`、没有 `doc` → 明明已经打开成功，仍被判为失败，接着 `showEmpty()` 把视频区关掉并盖上错误提示。改成 `loaded() = !!(state.doc \|\| state.isVideo)`。顺带：`getSelectedPdfs()` 只放行 `ext === 'pdf'`，选中视频永远拿不到 → 新增 `getSelectedDocs()`；`localItem()` 曾把 ext 写死 `'pdf'`，按路径打开的 mp4 会被送去 pdf.js → 改成从文件名推；再加一个 2.5 秒**看门狗**，`eagleplugin://` 下 file:// 静默被拦时自动改走内存读取 |
| 7 | 清空测试数据、还原 PDF、Eagle 里的注释也还原 | `reset-3.3.3.py`：整目录归档 → 用 `pdfbak/` 原件覆盖（字节级一致，已核对）→ 清空本插件管过的 Eagle 条目 `annotation` 字段 → 删 `docs/ index/ trash/ daily` |
| 8 | 翻译还是慢，而且似乎有 500 字限制 | ① 新增**有道「免密钥」接口**（`aidemo.youdao.com`）作主力：国内直连、无需注册，实测单句 **50–300ms**；② 调度从「排队」改「**对冲**」：一线引擎先跑，1.2 秒没回就把 Google / MyMemory 一起放出去，谁先回用谁；③ **500 字限制找到了** —— 是 MyMemory 的硬顶（有道免密钥也有 ~1000 字上限），上一版按 1200 切块，长选区必然踩线。现在按 900 切块给主线路，MyMemory 内部再切到 300–450 |


### 更新记录 · 3.3.2（WPS/Edge 看不到高亮 / 搜索栏与左栏 / 视频预览 / 翻译提速）

| # | 反馈 | 处理 |
| --- | --- | --- |
| 1 | 常用 **WPS** 打开：高亮是一条不透明色带盖住文字；用 **Edge** 打开：什么标记都没有 | 一个根因：外观流里写的是 `0.38 gs`，而 `gs` 的操作数必须是**资源名**（`/GS0 gs`）。PDFium（Edge）认为这一句非法，整个外观流不画；WPS 丢掉 AP、退回用 `/C` 实心填充。少一个斜杠，两家的症状全对上了。另外把 `/C` 换成**淡版**颜色——即便某个阅读器不认 AP 只认 `/C`，铺出来的也是淡色带，不会再挡字 |
| 2 | 搜索栏长度顶到右侧「工作台」按钮 | `.search-field` 改成 `flex: 1 1 auto`（占满剩余宽度）、输入框 `flex: 1`、`.tb-spacer` 收成 6px 缝隙；计数 `1/17` 与 `‹ › ✕` 全在框内右侧，够长不挤 |
| 2.1 | 搜索结果浮层不想要，整合到搜索框右侧；搜索时左栏用来放结果 | 删掉 `#searchPop` 浮层。左栏新增 `#searchPane`：**搜索时顶替目录/缩略图**，列结果（页码 + 前后文 + 高亮命中词），不搜索自动还原原来的页签。计数与上下键留在框内 |
| 3 | 回车逐个看结果时阅读区闪烁 | 三处叠加：① 每跳一次都把**每一页**的 `searchLayer` innerHTML 清空重建；② 每次跳都调 `flashPage()` 做 720ms 翻页闪白；③ 平滑滚动一路触发惰性渲染。改为：`setSearchMarks` 只重画受影响的页、`setActiveMark` 只切 class、跳转用瞬时滚动并去掉闪白 |
| 4 | Edge 打开看不到标记（同 #1） | 同上 |
| 5 | 空格打开视频还是 Eagle 自带预览 | `manifest.preview` 的 key 是**扩展名**，不是 `"video"`。改成 `"mp4,m4v,mov,webm,mkv,avi,ogv,wmv,flv,mpg,mpeg,ts,3gp"`，按空格进插件（界面与 PDF 一致 + 打点/片段/截帧） |
| 6 | 划词翻译慢，而且好像有 500 字限制 | ① 新增**本地模型（Ollama）**通道：本机 `127.0.0.1:11434`，装了就自动探测可用性，无需密钥、不外传；② 本地模型与有道**竞速**，谁先回用谁，不再一个一个等；③ 长文按句子切成 ≤1200 字的块，最多 3 块并发；④ 放开 4000 字硬上限到 20000 字（面板里的 ⚙ 可填地址与模型名） |
| 7 | 清空数据、还原测试用过的 PDF | 数据整目录归档到 `backup/EagleNoteManager-data-<时间戳>/` 后清空 `docs/ index/ trash/ daily/`；两份被写过高亮的 PDF 用 `pdfbak/` 里的原件覆盖还原（字节级一致） |


### 更新记录 · 3.3.1（修「PDF 里高亮变成实心黄条盖住文字 / 紫色不显示」）

| # | 反馈 | 处理 |
| --- | --- | --- |
| 1 | 写进 PDF 的高亮是一条**实心黄色亮条，把文字整个盖住** | 根因：整页共用**一个**外观流，`BBox` 用了整页大小，而注释的 `/Rect` 只有一行高。规范要求把 `BBox` 映射到 `/Rect`，于是整页色块被压进那一行、还叠了好几层 —— 又粗又实心。改为**一条注释一个外观流，`BBox` 就等于它自己的 `Rect` 尺寸**，缩放恒为 1 |
| 2 | **紫色的条目在 PDF 里没显示出来** | 同上：共用流的颜色取自本页第一条，后面全被染成第一条的颜色，看着像「没写进去」。改为颜色跟着每条自己的 `color` 走，`/C` 与外观流里都是本条的色 |
| 3 | （顺带）高亮太浓，字看着发灰 | 外观流里的透明度从 0.42 调到 **0.38**，与插件内 `.hl` 一致；注释字典上的 `/CA` 去掉，避免与 `ca` 相乘变成 0.14 |
| 4 | （顺带）上一版已经写坏的文件怎么办 | 加**自愈**：`PdfWrite.VERSION`（现为 2）变了以后，第一次打开带高亮的文档会补一次同步，把旧注释整体重写掉；每个版本只做一次 |

新增 3 组回归用例盯着这次的问题：每条注释 `BBox` 与 `Rect` 同尺寸、外观流里有 `gs` 且 `ca ∈ (0.15, 0.75)`、
同页黄+紫两条的 `/C` 各是各的颜色（`test-pdfwrite` 36 项）。


### 更新记录 · 3.3.0（高亮写进 PDF / 常驻搜索 / 视频笔记 / Esc 全链路）

| # | 反馈 | 处理 |
| --- | --- | --- |
| 1 | 阅读栏高亮的文字，要一并高亮在 PDF 本身上并保存；插件里删了 PDF 上也要同步 | 新增 `js/pdfwrite.js` + `vendor/pdflib/pdf-lib.min.js`（1.17.1，随包内置）。每条高亮写成标准 `/Highlight` 注释：`/NM = "eaglenote:<标注id>"` 作**指纹**，`/AP` 外观流里画半透明矩形（`ExtGState` `ca/CA = 0.38`，与插件内 `.hl` 同浓淡；3.3.1 修正过外观参数，见下一条记录），`/QuadPoints` 用 `viewport.transform` 求逆换回用户空间（`/Rotate`、CropBox 偏移都自动正确）。**每次同步先删掉所有带指纹的注释、再按当前数据重写**——所以删除/改色/挪页都会忠实反映到文件里，而别人的注释（Acrobat、Foxit 写的）一条不碰。写前备份到 `<dataDir>/pdfbak/<docKey>.pdf`，`tmp + rename` 原子替换，写完 `countMarks()` 自检条数，不符则报错不改文件；加密 PDF 只存插件不动文件。详见 **§4b** |
| 2 | 搜索要直接显示输入框，不用点一下才出现；而且只有条数没有结果 | 顶栏搜索键换成**常驻输入框** `.search-field`：平时 118px，聚焦展开到 176px，左边放大镜、右边计数、后随 `‹ › ✕`。边输边搜（debounce 220ms），结果浮层按页分组列出命中前后文，点一行即跳。详见 **§3b** |
| 2.1 | 输入时实时显示 PDF 内位置，并在阅读区标出（要与第 1 条的真高亮区分） | 新增 `js/search.js`：建索引时**连几何一起存**（每页 `{text, items[{start,str,width,height,transform}], vp}`），命中 = 「页 + 字符区间」，再用 `Util.transform(vp.transform, item.transform)` 反算归一化矩形。阅读区因此多一层 `.searchLayer`（层序 `canvas → searchLayer → hlLayer → textLayer → pinLayer`，临时标记压在真高亮与文字层之下），画的是橙色半透明临时标记（当前命中更深 + 描边），**只活在内存，绝不写进 PDF**。与 `.hlLayer` 完全分离 |
| 3 | 不同大小的框选出来的图在卡片里等宽，导致图里的文字大小不一 | 根因是截图按「充满卡片宽度」渲染。改为截图统一按 **2 像素 / PDF 点**渲染（`scale = min(2, MAXPX/regionW, MAXPX/regionH)`），展示时按 `naturalWidth / 2` 定宽 —— 于是所有截图里的文字**物理大小一致**，窄图自然窄、宽图自然宽，再靠 `max-width: 100%; height: auto` 兜住窄卡片 |
| 4 | 笔记正在编辑时按 Esc 应弹提示，而不是直接退出插件 | `openComposer` 记下 `originalMd / originalAtts`，新增 `editorDirty()` 比对新旧内容；`tryCloseNoteModal()` 与 `exitPlugin()` 都走它，**只有真改过**才弹「放弃未保存的修改？」确认框，没改直接关 |
| 5 | 回收站「清空回收站」确认框的两个按键看不见 | 根因是 `U.el('button', cls, label)` 传参错位——`U.el` 第二参是**属性对象**，被当成属性后按钮既没 class 也没文字。改成 `U.el('button', { class, text })`；同时 `.cf-acts .danger-btn` 原来是 `background: transparent`，补上实心红底。**所有二次确认框**（清空回收站、删除、覆盖）统一走 `confirmDialog()`，两个键位尺寸/配色一致 |
| 6 | 回收站/知识库/锚点笔记里按 Esc 会直接退出插件 | 新增 `js/esc.js`：一个**显示栈**，谁打开谁 `Esc.push(name, closeFn)`，Esc 永远只弹栈顶。8 个层全部接入（`toolbar / tr / popover / link / picker / noteModal / search / confirm`，加上工作台的 `workbench / kb / trash`），顺序天然「后开先关」。另一个真凶是 `Workbench.close()` 里残留的 `Bridge.closeWindow()`——关工作台会顺手关窗口，已删除 |
| 7 | 知识库卡片边框还是不明显 | `.kbn` 边框 1.5 → **2px**（胶带色 74% 混 `--border-strong`），顶部色条 3 → 4px，再叠一层 `inset 0 0 0 1px` 内描边，深色主题下也能看清边界 |
| 8 | 摘录/笔记要晚生成的在上（由下至上） | 摘录列表 `.sort((a,b) => (b.createdAt||0) - (a.createdAt||0))`；笔记的 `createdAt` 改为**优先取创建时间**（原来取 `updatedAt`，编辑一次就跳顶） |
| 9 | 出新版本时清掉之前所有数据 | 新增 `Store.migrateEpoch()`：`localStorage['eaglenote:epoch']` 记到 `'3.3'` 做一次性判断，触发时先把整个数据目录 `rename` 到 `archive-v32-<YYYYMMDD>/`（**不删，留一手**），再清 `docs/ index/ trash/ daily/` 与 localStorage 里除 `theme / 有道密钥 / epoch` 外的全部 `eaglenote:*`。幂等，重开不会再清 |
| 10 | 3.3 加入视频笔记 | 新增 `js/videoview.js` + `#videoStage`：`<video>` 播放区（与 `#viewport` 互斥显示）、打点（当前时间做成锚点）、片段（`A → B` 区间）、截帧（`captureFrame()` 出 JPEG，直接当摘录图）、倍速、`←→`/`↑↓` 快进、空格暂停、`n` 打点。数据模型**复用 PDF 标注**（`{type, page:1, t, t1, image}`），所以知识库、回收站、检索、卡片全部零改动即通。详见 **§6c** |


### 更新记录 · 3.2.0（顶栏重排 / 图片可选 / 翻译换引擎 / Esc 修 Bug）

| # | 反馈 | 处理 |
| --- | --- | --- |
| 1 | 「适宽」两个字竖向排版了 | 根因是顶栏挤满时按钮被 `flex-shrink` 压到约 1 个字宽，文字就折行。改为 `.topbar button { white-space: nowrap; flex-shrink: 0 }` + `.icon-btn.wide { min-width: 42px }`，任何窗口宽度下都不再竖排 |
| 1.1 | 色板圆点之间距离太近 | `.seg.swatch-bar { gap: 9px; padding: 6px 10px }`、`.swatches { gap: 9px }`，圆点直径从 15 → 14px，间距从 3 → 9px |
| 1.2 | 搜索从左侧栏放回顶部工具栏 | 左栏恢复为**目录 / 缩略图**两页签；顶栏新增独立「搜索」键，点开是贴在键下方的搜索浮层（输入 ≥2 字自动搜、Enter 立即搜、Esc 关闭、`Ctrl+F` / `/` 呼出）。索引逻辑复用原有 `runSearch()` |
| 1.3 | 工作台、浅/深背景各自独立成键 | 两者都不再和别的按钮挤在一个灰底分组里，改成独立的 `.tb.solo` 按钮（带边框、hover 变化），依次排在顶栏最右 |
| 1.4 | 不要浅/深右边的关闭 ✕ | 删除 `#btnQuit`。退出统一走 **Esc**（逐级退出）或窗口自带的关闭按钮 |
| 1.5 | 删掉「选择」「摘录」工具，框选/锚点挪到「摘录并笔记」右边 | 工具组只剩 **框选 / 锚点**，紧接「摘录并笔记」；锚点右侧是**搜索**，再往右是**工作台 / 主题**。色板挪到摘录之前（`页码 → 缩放 → 色板 → 摘录组 → 框选锚点 → 搜索 → 工作台 → 主题`）。**选择成为唯一默认模式**，不再需要手动切回 |
| 1.6 | 「摘录并记录」改成「摘录并笔记」 | 顶栏、悬浮工具条、笔记框标题、空态提示、知识库空态全部改文案（`index.html` / `app.js` / `editor.js` / `workbench.js`） |
| 2 | 点选图片选不到，应该识别到就出悬浮工具栏 | 三层修复：① **命中判定改到 `mousedown`**——PDF 文字层会吃掉 `click`，而选完字后选区未塌陷时 `click` 又会误判为「还在选字」；② 命中容差 4px，去掉了 `<0.4%` 的过严面积过滤（降到 `0.12%`）、最小边 14px → 10px；③ 补上 `paintFormXObjectBegin/End` 的 CTM 叠加与 `paintImageMaskXObjectRepeat` / `paintImageXObjectRepeat` / `paintSolidColorImageMask` 三类算子——**报表和图表页的图大量画在表单 XObject 里**，之前会整页解析不到。另外：悬停即预解析该页图集；首次点击若该页还没解析完，会先解析再重试一次，不再「第一下没反应」 |
| 2.1 | 用锚点时应主动弹笔记框，Esc / ✕ 可关 | 放下锚点直接 `openComposer('ann', id, 'modal')` 打开大笔记框（编辑 + 预览 + 附件），空内容 Esc 直接关，不写就不留空笔记 |
| 2.2 | 只标位置的锚点不要显示「未提取到文字」 | 摘录卡片按类型走文案：锚点（`type: 'note'`）文字为空时**整行不渲染**；框选仍显示「［页面区域］」，纯文字高亮选空时才提示「［未提取到文字］」 |
| 2.3 | 文字与图片的悬浮工具栏要区分 | 文字：**色板 + 摘录 + 摘录并笔记 + 翻译 + 复制**；图片：**摘录 + 摘录并笔记 + 复制**（无色板、无翻译）。用 `#selToolbar[data-mode]` 控制 |
| 2.4 | 翻译太差太慢，能不能接有道；想要实时 | ① 新增**有道智云**通道：翻译面板右上 ⚙ 填一次 `appKey` / `appSecret`（存 localStorage，签名走 `require('crypto')` 的 SHA-256 v3 规范），之后**有道优先**；② 没密钥时按 Google gtx → Google 数组 → MyMemory 降级，每个接口独立超时（4–6s），不再干等一个通不了的域名；③ **实时**：选中即后台预翻译（防抖 320ms），点「翻译」多半直接命中缓存，面板上标出来源与耗时（如 `en → zh-CN · 有道 · 240ms`） |
| 2.5 | 复制译文不关框，存入笔记再关 | `copyTranslation()` 只提示「已复制译文（面板不关闭）」；`saveTranslation()` 两条成功路径都 `hideTr()` |
| 2.6 | 翻译没完成前，复制/存入都不能点 | `setTrBusy(true)` 在发起请求时把 `#btnTrCopy` / `#btnTrSave` 一起禁用；失败也保持禁用，不给空结果可点 |
| 2.7 | Esc 要逐级退出 | 顺序固定为：确认框 → **翻译框** → 搜索浮层 → 回收站/知识库/工作台/笔记框/链接 → **工具条（取消选中并清掉浏览器选区）** → 批注框/选择器 → 退出插件 |
| 2.8 | Esc 退出插件把 Eagle 也最小化到托盘了 | 根因：预览（空格）模式下插件的 webContents **就是 Eagle 主窗口**，`eagle.window.hide()` 隐藏的是 Eagle 本体。`Bridge.closeWindow()` 加了模式判断：**非 window 模式一律不碰窗口**，`exitPlugin()` 在这一形态下只提示「按空格或右上角 ✕ 关闭预览」；顺带确认 Eagle 的 `plugin.window` API 里根本没有 `close`（只有 `show/hide/minimize/maximize/focus/...`），旧代码里的 `w.close()` 是无效分支 |
| 3 | 知识库卡片边界不明显 | `.kbn` 边框 1px → **1.5px**（胶带色 58% 混边框色），并叠一层 `0 0 0 1px` 外发光；hover 时加粗到 80% + 2px 光晕 |
| 3.1 | 知识库各筛选下界面大小要一致且够大 | `.kb-card` 从「宽度固定、高度随内容」改为**固定尺寸** `width: min(1180px, 95vw); height: min(88vh, 900px)`，切「全部/摘要/笔记/每日」不再跳大小 |
| 4 | 下一版加入视频笔记/摘录 | 列入 3.3 计划（见 §11）。做法与 PDF 一致：`<video>` + 时间点锚点 + 区间摘录（`t0–t1`）+ 帧截图，索引仍按 Eagle `itemId` |


### 更新记录 · 3.1.0（13 条实机反馈逐项落地）

| # | 反馈 | 处理 |
| --- | --- | --- |
| 1 | 3.0.0 里看不到 2.2.0 的笔记，之前是测试数据，先清掉 | 旧数据先备份到 `backup/EagleNoteManager-data-<时间戳>/`（12 个文件），再清空 `data/docs/*.json` 与 `index.json`。同时把 `Store.load()` 的回读链改掉：**有数据目录就以它为准，不再回读 sidecar / localStorage**，否则清空后旧数据会「复活」 |
| 2 | 悬浮工具栏最右加「复制」，图标改文字 | 悬浮框变为 `摘录 ｜ 摘录并记录 ｜ 翻译 ｜ 复制`，四个都是纯文字按钮，不再混用图标 |
| 2.1 | 划词实时翻译，译文可存进笔记 | 新增 `js/translator.js`：按源文自动判断方向（中日韩占比 > 0.22 → 译英，否则译中），降级链 `Google gtx (dj=1)` → `Google gtx (二维数组)` → `MyMemory`；结果按 `hashKey(text\|target)` 缓存到 localStorage。译文弹层可「复制 / 存为笔记 / 切换中英」，存为笔记时写入该摘录的 `note`（无摘录则新建独立笔记），带原文引用与页码 |
| 3.1 | 顶栏左侧不显示文档名，只留页码 | 删除 `#docTitle`；顶栏起手就是 `‹ 3 / 48 ›` + 页码输入框，长文件名不再挤占工具区 |
| 3.2 | 「摘录并记录」右侧的搜索按钮不要 | 删除 `#btnSearch`。搜索挪到**左栏第三个页签「搜索」**：输入即搜，命中按页分组并高亮关键词，点击跳页 |
| 3.3 | 工作台右侧不要「打开」，插件里不需要打开本地文件 | 删除 `#btnWbOpenDir` 语义上的「打开」与顶栏 `#btnOpenLocal`、「打开本地 PDF」入口。工作台维护区改为 **「打开索引目录」+「清空全部摘录与笔记」**；空态文案改为「先去 Eagle 资料库导入 PDF 再阅读」，操作流固定为 **先入库、再阅读** |
| 3.4 | 工具栏功能平摊，不重叠 | 顶栏重排为单一 flex 行，`#btnQuit` 推到最右，中间 `.tb-spacer` 吸收多余宽度，每组之间用 `.tb.seg` 竖线分隔：`页码 · 缩放 · 工具 · 色板 · 摘录组 ·（弹性）· 工作台/主题/退出`。无论窗口多宽都不再换行叠压 |
| 4 | PDF 内的**图片**要能选中、摘录、记笔记、复制 | ① `viewer.ensureOverlays()` 用 `page.getOperatorList()` 跟踪 `save/restore/transform` 的 CTM，对 `paintImageXObject` 等按 `Util.transform(vp.transform, ctm)` 求包围盒（过滤 <0.4% 或 >97% 页面的底图、宽高 <14px 的小图标）；② 不用覆盖层（会吃掉文字选择），改为**坐标命中** `findImageAt(page,x,y)` 倒序反查；③ 命中后手型光标 + 细框预览，点击弹「摘录图片 / 复制图片」；④ 摘录用 `captureRegion()` 整页渲染后 `drawImage` 裁剪、宽上限 1200px 存 `ann.image`（PNG dataURL）；⑤ 复制走 Electron `clipboard.writeImage(nativeImage.createFromDataURL)` |
| 5 | 点击 PDF 里的链接，提示「在 Eagle 中打开」或「用默认浏览器打开」 | `page.getAnnotations({intent:'display'})` 过滤 `subtype === 'Link'`，`convertToViewportRectangle` 换算，`findLinkAt()` 命中后弹 `#linkPop`：**在 Eagle 中打开**（`item.addFromURL` → 退化为 `addBookmark`）/ **用默认浏览器打开**（`shell.openExternal`）/ 复制链接。内部跳转（`dest` 指向本文档某页）直接翻页 |
| 5 | 右侧摘要栏与笔记栏都要显示框选的图片，笔记栏里小一点 | 摘录卡 `.ec-img`（宽 100%，圆角 + 细边）；笔记卡 `.nc-img`（`max-height: 120px`，缩略图级别），点图可放大 |
| 6 | 笔记下的摘录文字用斜体，别显示 4 行 | `.nc-source-text` 改 `font-style: italic` + `-webkit-line-clamp: 2`（两行截断，`line-clamp` 兼容 `display:-webkit-box`），完整原文仍可在编辑框里看到 |
| 7 | 没输入文字时「保存笔记」应置灰 | `NoteEditor.hasContent()`：正文 `trim()` 为空且无附件时 `btnSave.disabled = true`，`title` 提示「先写点内容再保存」；`input` / 附件增删 / `setValue` 都会调 `updateSaveState()` |
| 8 | 左右栏先不支持关闭/收起（收起右侧就找不回来） | 删除两栏的折叠按钮与 `collapsed` 状态。左右栏宽度仍可拖 `#splitter` 调整，但**始终可见**；`mode-preview` 下窄于 900px 只收左栏，右栏永不留白 |
| 9 | 不要「全部存入 / 存入 Eagle」，录入即入库、删除即从库里删，且要 **Markdown** 而非图片 | 摘录卡与工具栏里的「存入 Eagle」「全部存入」全部删除。改为**即写即存**：摘录 / 笔记落入插件索引 `docs/<itemId>.json`（原生 JSON + Markdown 文本），笔记正文 1.2s 防抖同步到 Eagle 条目的 `annotation` 字段（**纯 Markdown 文本，不再生成图片条目**，为后续接 AI 留出可读数据）。删除时走同一链路：先移出索引 → 重写 `annotation`（Eagle 侧同步消失）→ 进回收站 |
| 10 | 右侧栏上方加回收站，删除的笔记保留 30 天 | 右栏头部新增 `#btnTrash`。`trash.json` 记录 `kind(excerpt/note) + docKey + payload + deletedAt`；浮层列出条目、显示「剩余 N 天」、可**还原**（`Store.readDocByKey/writeDocByKey` 按 `docKey` 写回原文档）、**彻底删除**、**清空**；`purgeTrash()` 在每次读写时顺手清掉超 30 天的记录 |
| 11 | 知识库要便利贴感觉，不是卡片列表 | 重写为 `.kb-grid` + `columns: 280px` 的瀑布流便利贴墙：`article.kbn` 每张贴纸有 `--tape` 六色胶带轮转、`--tilt` 微倾斜（`rotate(var(--tilt))`）、`break-inside: avoid`，标题、页码、预览文本、来源文件名分层排布；筛选 chips 增加 **每日** |
| 11.1 | 点知识库卡片要在插件内打开对应 PDF，形成溯源 | `gotoEntry()`：卡片带 `docKey` + `page` + `annId`，点击后**在插件内 `openDoc()` 定位到页并选中标注**（`viewer.focusAnnotation`），而不是跳到 Eagle；每日笔记卡片点开回工作台对应日期 |
| 11.2 | 就叫「知识库」，删掉「初级」 | 所有文案（右栏页签、浮层标题、工作台统计卡、空态）统一为「知识库」 |
| 12 | Esc 退出插件；有草稿时先问保存还是直接退 | `exitPlugin()`：`Esc` 按层级逐层关闭 —— 确认框 → 回收站 → 知识库 → 工作台 → 笔记框 → 链接弹层 → 工具条 → 批注浮层 → picker → **退出插件**。退出前 `tryCloseNoteModal()` 检查草稿（`NoteEditor.hasContent()`），有内容弹三选一：**保存并退出 / 不保存 / 取消**。关闭窗口走 `Bridge.closeWindow()`（`eagle.window.close()` → `hide()` → `window.close()`） |
| 13 | 工作台：显示最近阅读、点击进入；点摘录/笔记进知识库 | 新增「最近阅读」区块（`Store.getHistory()` 与索引 `docs` 合并，按 `lastReadAt` 排序），点一行直接 `openDoc()`；统计卡（摘要 / 笔记 / 文档 / 知识库）全部可点，跳到知识库对应筛选 |
| 13.1 | 加时钟和每日笔记 | 头部 `#wbTime`（`HH:MM:SS`，1s 走字）+ `#wbDate`（`10 月 26 日 · 周日`）；`#wbDaily` 是**按天**的 Markdown 文本框，600ms 防抖自动写 `daily.json` 并 `rebuildIndex()`（每日笔记会作为 `kind:'daily'` 进知识库）；底部显示字数与「在知识库中查看」 |
| 13.2 | 研究能不能在 Eagle 界面显示实体按键 | **已核实：不能。** `app.asar` 里 `manifest.sidebar` / `sidebarPlugins` / `plugin.sidebar` / `plugin_toolbar` 均 **0 命中**，插件类型只有 `format / inspector / service / window` 四种，没有侧边栏或工具栏扩展点。替代方案见下方「工作台入口」，并在工作台里给出**快捷键绑定提示** |
| 13.3 | 最近 8 周活动改成年度 | `.wb-heat-year`：`grid-template-rows: repeat(7,1fr)` + `grid-auto-flow: column`，按 `U.dateKey()` 分桶，先按 `first.getDay()` 补空格再铺满整年（365/366 格），图例保留「少→多」五档，副标题显示年份 |
| 13.4 | 工作台支持 Esc 退出并进入对应资料库 | `Workbench.close()`：有文档就回阅读视图，没文档就 `Bridge.closeWindow()` 关掉插件窗口，回到 Eagle 资料库列表 |

**关于「工作台」的入口**：Eagle 4 未向插件开放左侧边栏与主工具栏（见上表 13.2），所以入口做成三层：

1. **插件首屏** —— `manifest.main.runAfterInstall = true`，且窗口打开后若没有可载入的文档、也没有 `?id=` / `?path=`，自动进入工作台；
2. **顶栏「工作台」按钮** —— 阅读中随时可进，`Esc` 逐层退回；
3. **快捷键** —— Eagle 偏好设置 → **快捷键 → 插件** 可给本插件绑全局快捷键（插件面板右键该插件也有「设置快捷键」）。这是 Eagle 官方提供的、唯一能让插件「一键唤出」的方式，工作台维护区里也写了这条提示。


### 更新记录 · 3.0.0（细节体验与数据可靠性）

| # | 反馈 | 处理 |
| --- | --- | --- |
| 1 | 悬浮框里的「高亮」改成「摘录」，点完自动高亮 | 悬浮框改为 **色板 + 摘录 + 摘录并记录**。选色只决定「下一笔用什么颜色」，落笔时机交给按钮 |
| 1.1.2 | 「摘录并记录」要弹大笔记框，支持附件 | 新增 `#noteModal`（880px，左编辑右预览）。附件支持**本地文件**与**Eagle 库搜索**，只记录地址：本地存绝对路径，Eagle 存 `itemId`，不复制文件本体 |
| 1.2 | 阅读器顶部也要有这两个按钮 | 顶栏新增「摘录 / 摘录并记录」，作用于当前选区 |
| 2 | 高亮选中后的边框点别处不消失 | `PdfViewer` 命中失败时回调 `onPageClick(null)`，外层 `clearSelection()` 清掉 active 态 |
| 3 | 笔记栏里笔记在下、摘录在上 | 卡片改为「笔记正文（13px）在上 → 来源摘录（11px，带 `摘自第 N 页`）在下」 |
| 4 | Markdown 要随打随变 | 编辑器改成 `textarea + 实时预览` 双栏，`input` 事件即渲染（`requestAnimationFrame` 节流），工具栏插入的语法同样即时可见 |
| 5 | 标题下拉要 1/2/3/正文 | 顺序改为 标题 1 → 标题 2 → 标题 3 → 正文 |
| 6 | 笔记栏只放当前 PDF，另加「初级知识库」 | 右栏三个页签：摘录 / 笔记 / 知识库。知识库页签给出汇总卡片，点「打开初级知识库」弹出大浮层，以卡片管理**全库**摘要与笔记（筛选、搜索、打开原文、删除） |
| 7 | 阅读历史只保留 Eagle 条目 | `Store.pushHistory` 拒绝没有 `itemId` 的条目；本地文件不再进历史 |
| 7.1 | 笔记同步到 Eagle 注释，摘录不写 | 保存笔记后自动（1.2s 防抖）把**全部笔记正文**、以空行分隔写入 `annotation`；摘录不写入。手动「同步」按钮保留 |
| 8 | 中文摘录的字间空格 | `U.normalizeText()` 新增 CJK 挤压：只删中日韩字符之间的空格与行首尾空格，**不跨行**，中英文之间的空格保留 |
| 9 | 索引存在哪里？库改名/移动会不会丢 | 改为按 **Eagle `itemId`** 存放于 `<userData>/Plugins/EagleNoteManager/data/`，与资料库名字、路径完全解耦。详见 §7 |
| 10 | 改名 | 「Eagle 笔记管理」 |
| 11 | 想要「工作台」统计 | 见下 |

**关于「工作台」放在哪**：Eagle 4.0 没有向插件开放左侧边栏（`全部 / 未分类 / 文件夹`）的扩展点——
在 `app.asar` 里搜 `manifest.sidebar`、`sidebarPlugins`、`plugin.sidebar` 均为 0 命中，
插件只能拥有「独立窗口」和「预览视图」两种宿主形态。所以工作台做成了**插件首屏**：
窗口模式打开插件、且没有可载入的文档时自动进入，顶栏也常驻「工作台」按钮。
内容包括：资料库文件数、PDF 数、已批注文档数、摘要数、笔记数、文件类型分布、
最近 8 周活动热力图、最近摘录/笔记流、以及索引目录的实际路径。
（**3.1.0 起**热力图改为**年度**，并追加时钟、每日笔记、最近阅读三个区块，见本文档开头的 3.1.0 更新记录。）


### 更新记录 · 2.2.0（修 2.1.0 的三个遗留问题）

| 反馈 | 根因 | 处理 |
| --- | --- | --- |
| 拖入无效、「打开本地 PDF」无反应、点按钮无反应 | **同一个根因**：2.1.0 的 `boot()` 先 `await Bridge.ready()` 才 `bindUI()`。而 `ready()` 在 `plugin-create` 之前调用了 `library.info()`，Eagle 的 `ipcRenderer.r2r` 守卫会直接 reject（`This method can only be used after the 'plugin-create' event is triggered`）；等它走完才绑定，界面在 2.5 秒看门狗到点时还是一片「没有事件监听」的死页面 | 启动拆成两段：**第一段纯同步、不碰任何 Eagle API**（主题 → 阅读器 → 拖拽 → 全部按钮），脚本加载当帧就完成；第二段才异步连 Eagle。看门狗判据 `__PDFWORK_BOOTED` 改为脚本一启动就置位，只在脚本真的没加载时才提示 |
| 按空格打开插件后仍是「打开本地 PDF」 | ① 同上（载入流程压根没跑到）；② 预览窗口里 `plugin-create` 未必到达，`getById` 取不到就整条链判失败 | `Bridge.whenCreated(timeout)`：预览模式只等 1.2 秒，窗口模式等 2.5 秒；`getById` 取不到视为「跳过」而非失败，直接降级到 `?path=` 本地读取；载入失败时空态显示**一行诊断**（模式 / Eagle / create / id / path / 插件目录 / 资源库）+「重试载入」 |
| 空格预览与独立窗口颜色仍不一致 | 2.1.0 让插件**跟随 Eagle 主题**：预览 URL 带 `theme=` 所以是 Eagle 色，独立窗口在 `plugin-create` 前读不到 `app.theme` 就退回浅色 → 两种入口必然两种色系 | 回到 v1 的固定配色：页面默认深色、不跟随 Eagle 主题，`manifest.main.backgroundColor` 与 `eagle.window.setBackgroundColor()` 统一为 `#18191c`，`--eagle-bg` 也注入同一值。需要浅色时点顶栏 ◐ 手动切换 |

顺带：取真实路径改用 `webUtils.getPathForFile()`（Electron 32 起已移除 `File.path`），并支持从 `dt.items` 兜底取文件；原生对话框「取消」不再二次弹出 `<input>` 选择框。


### 更新记录 · 2.1.0（对应实机反馈）

| 反馈 | 原因 | 处理 |
| --- | --- | --- |
| 拖入文件无效、点「打开本地 PDF」无反应 | 旧实现用 `<input type=file>` + 程序化 `click()`，在 Electron 的 webview 里经常弹不出原生对话框；拖拽监听只挂在 `document` 冒泡阶段，内部元素 `stopPropagation` 就会失效 | 改用 `eagle.dialog.showOpenDialog` 原生对话框（`<input>` 仅作浏览器兜底）；拖拽改为 `window` **捕获阶段**监听，`dragover` 无条件 `preventDefault` |
| 按空格进插件但不载入文档 | `?path=` 可能带 `file://` 前缀或被编码两次，交给 `fs` 直接失败；且只试了 `item.getById` 一条路 | `cleanPath()` 统一还原（去 `file://`、解二次编码、`path.normalize`）；载入改为**降级链**：`id` → `path` → 当前选中项；失败时在空态直接显示原因并提供「重试载入」 |
| 点按钮无反应（如无文档时切换目录/缩略图） | ① `bindUI()` 里任意一个节点缺失或抛错，会中断后面全部绑定；② 无文档时两个面板本来就是空的，切换后毫无视觉变化 | 绑定改为 `on()` / `onAll()` 逐条独立 + `boot()` 分步 `step()` 容错；两个面板与摘录/笔记列表都补了「尚未打开文档」占位文案 |
| 空格预览与独立窗口边框颜色不一致 | 预览 webview 与独立窗口的原生底色由不同路径设置（Eagle 对前者用 `themeColors`：LIGHT `#f3f4f6`、DARK `#18191c`…） | 新增 `Bridge.eagleBg()` / `syncWindowBg()`：按 Eagle 自己的主题色表设置 `eagle.window.setBackgroundColor()`，并把同一颜色注入 CSS 变量 `--eagle-bg` 供页面底色使用；`manifest.main.backgroundColor` 同步改为 `#f3f4f6` |

**诊断能力**：`boot()` 的每一步、窗口级 `error` / `unhandledrejection`、以及 2.5 秒引导看门狗
（脚本整体没跑起来时触发）都会把原因显示在顶部红色诊断条上，不再出现「看起来正常但点不动」的页面。

**开发时看日志**：`manifest.devTools` 出厂为 `false`（不会每次弹开发者工具）。
需要看控制台时，在插件窗口菜单里选「视图 → 切换开发者工具」或按 `Ctrl+Shift+I`。
拖拽如果仍不生效，控制台会打印 `[drop] 收到 { types: [...], files: n }`，
把那行发来即可判断是「事件没到」还是「事件到了但没带文件」。

## 2. 安装（本地开发调试）

1. 主窗口按 `P` 打开 **插件面板**（或工具栏「插件」）。
2. 点击底部 **开发者选项…** → **导入本地项目**；
   也可以在面板空白处右键 → **导入本地项目**（同一入口）。
3. 选中本文件夹 **`EaglePDFReader`**（必须是含 `manifest.json` 的那一层，**不要选它的父目录**）。
4. 面板「开发」分区出现「Eagle 笔记管理」，点击即运行。

> 导入本地项目只是把**绝对路径**记进 Eagle 的 `PLUGIN_LOCAL_PLUGINS` 列表，**不会复制文件**，
> 所以改完源码不用重新导入。

**改完代码怎么生效**

- 插件窗口内按 `Ctrl + R`（macOS `⌘ + R`）重载窗口；
- 或在插件面板右键该插件 → **重新加载**（会重新读取 `manifest.json`，**改了 manifest 必须走这一步**）；
- **`manifest.preview` 是安装/启动时注册的**，改动后需重载插件或重启 Eagle，空格预览才会指向新阅读器；
- 若列表没变化，退出 Eagle 重开（面板缓存了插件清单）。

**调试**：本版 `manifest.json` 的 `devTools` 为 **`false`**（不自动弹开发者工具，避免每次开窗都被打断）。
需要看控制台时，在插件窗口里按 `Ctrl+Shift+I`，或菜单「视图 → 切换开发者工具」；
调试源码时把它改回 `true` 更省事。预览 webview 的 DevTools 在预览窗口内按 `F12` 打开。

出问题时先看顶部红色诊断条——它会显示初始化失败的具体阶段与错误信息；
控制台里 `[Bridge]` / `[boot:*]` 开头的日志分别对应宿主连接与启动各阶段。

**卸载**：插件面板右键 → **卸载**（只从列表移除，不动源码目录）。

**打包分发**：面板右键 → **打包插件**；或在仓库根目录执行 `python pack-plugin.py`
（生成 `Eagle 笔记管理-<版本>.eagleplugin`，并校验 `manifest.json` 位于压缩包根目录）。
当前版本产出的安装包是 `Eagle 笔记管理-<版本>.eagleplugin`（旧版留在 `backup/`）。

`.eagleplugin` 本质是 zip，**要求 `manifest.json` 位于压缩包根目录**，
Eagle 解包后安装到 `%APPDATA%\Eagle\Plugins\<manifest.id>\`。

## 3. 界面布局

```
┌────────────────────────────────────────────────────────────────────────────┐
│ ‹ 3/48 › │ − 100% + 适宽 │ ● ● ● ● ● │ [摘录][摘录并笔记][框选][锚点] │ ⌕ 搜索全文…………………… 3/17 ‹ › ✕ │ [工作台][◐] │
├───────────┬──────────────────────────────┬─────────────────────────────────┤
│ 目录/缩略图 │                            │ 摘录 笔记 知识库        🗑 回收站 │
│ （页签）    │        PDF 阅读区            │                                 │
├───────────┤                            │   卡片 / 便利贴卡片墙            │
│ 历史记录    │                            │                                 │
└───────────┴──────────────────────────────┴─────────────────────────────────┘
```

**视频模式下**左栏的目录/缩略图整块收起，只剩「历史记录」撑满；顶栏只留缩放组、
工作台、明暗切换（见 **§6c**）。

**顶栏是一行平摊的七段**（3.2.0 重排，中间 `.tb-spacer` 吸收多余宽度，永不重叠换行）：

`页码 ｜ 缩放（含「适宽」）｜ 色板 ｜ 摘录 · 摘录并笔记 · 框选 · 锚点（四个独立键）｜ 搜索框（常驻、占满剩余宽度）｜ 工作台 · 主题`

- **搜索是常驻输入框，不是按钮**（3.3.0）：`⌕` 图标 + 输入框 + `n/N` 计数 + `‹ › ✕`，
  点一下就能打，见 **§3b**。
- **四个动作键各自独立**（3.3.3）：摘录 / 摘录并笔记 / 框选 / 锚点 都是独立的胶囊按钮
  （`.tb.solo.act`），不再两两挤在一个灰色分组里，误点率明显低。
- **搜索框吃掉剩余宽度**（3.3.3）：`flex: 1` + `margin: 0 -6px`，左顶「锚点」、右顶「工作台」。

- **左侧不再显示文档名**：只留 `‹ 页码 ›`，文件名在左栏与工作台里都能看到。
- **退出**：只按 `Esc`（逐级），或用窗口自带的关闭按钮；顶栏不再放 ✕（3.2.0）。
- **没有「选择」模式键**：选择是默认模式，框选/锚点用完自动回到选择（3.2.0）。
- **左栏**：两个页签 **目录 / 缩略图**，下接历史记录。
  - *目录*：PDF 内嵌 outline（没有则显示「此文档没有目录」）；
  - *缩略图*：按当前缩放惰性渲染每页缩略图，点击跳页。
- **左栏下半**：**历史记录**（3.4.0 前的「阅读历史」）——`localStorage`（`eaglenote:history`）只记路径与页码，不记内容。
- **中间**：阅读区。`#splitter` 可拖动调整左栏宽度，双击复位。
- **右栏**：`摘录 / 笔记 / 知识库` 三个页签 + 头部 **回收站** 按钮；宽度可拖拽，**不支持折叠**（3.1.0）。
  - *摘录*：本 PDF 的全部标注（摘录为主、批注为辅，框选的图片缩略显示）
  - *笔记*：**仅本 PDF** 的笔记（笔记正文在上、来源摘录在下，摘录斜体两行截断）
  - *知识库*：全库便利贴卡片墙
- **工作台**：插件首屏（顶栏「工作台」随时可进），资料库与笔记数据的总览 + 时钟 + 每日笔记。

**打开文档**（3.1.0 起**只有 Eagle 资料库这一个入口**）

| 方式 | 说明 |
| --- | --- |
| 空格预览 | 资源库选中 PDF（或视频，3.3.0）按空格，直接进入本插件 |
| 插件窗口 | 选中 PDF → `P` → 「Eagle 笔记管理」，自动载入选中项 |
| 知识库卡片 | 点卡片在插件内打开对应 PDF 并定位到该页 / 该标注（溯源） |
| 工作台最近阅读 | 点一行直接进入那篇 PDF |
| 拖入（保留） | 从系统文件管理器把 PDF 拖到界面任意位置，仅用于临时查看 |

拖入的优先级：`webUtils.getPathForFile(file)`（Electron 32 起 `File.path` 已移除）→ `dataTransfer.getData('text/uri-list')`。
拿不到真实路径时降级为只读打开。

> 已移除的入口：「打开本地 PDF」「搜索 Eagle 资源库」（3.3.0 起全文搜索改为顶栏常驻输入框，见 §3b）。
> 文件的唯一来源是 Eagle 资料库——**先导入 Eagle（可分类），再在插件里阅读**。

## 3b. 全文搜索（3.3.0 起，3.3.2 改版）

顶栏那个位置**一直是个输入框**，而且是**吃掉剩余宽度**的：从「锚点」右边一路铺到「工作台」左边，
不再是一小截固定宽度。计数 `3/17` 与 `‹ › ✕` 都在框内右侧。

**结果列表在左栏，不在浮层**：一搜索，左栏的「目录 / 缩略图」就被 `#searchPane` 顶替，
列出页码 + 命中前后文（命中词高亮）；清空搜索或按 `Esc`，左栏自动还原来你刚才看的那一页签。

| 操作 | 结果 |
| --- | --- |
| 点输入框 / `Ctrl+F` / `/` | 聚焦，直接打字 |
| 打字 | debounce 220ms 自动搜（≥1 字即搜），输入框右侧实时显示 `3/17` 这样的命中计数 |
| `Enter` / `↓` `‹` | 下一个命中，翻页并瞬时滚到位（不闪） |
| `Shift+Enter` / `↑` `›` | 上一个命中 |
| `Esc` | 清空结果并退出搜索（左栏还原成目录/缩略图，**不会**退出插件） |
| 点左栏结果里的某一行 | 跳到那一处，同时把该命中设成高亮态 |

**两套标记，互不干扰**（对应 3.3.0 反馈第 1 条 vs 第 2.1 条）：

| 层 | class | 颜色 | 是否写进 PDF |
| --- | --- | --- | --- |
| 搜索临时标记 | `.searchLayer .search-mark` | 半透明琥珀 `rgba(255,196,0,.26)`，当前命中 `rgba(255,138,0,.52)` + 橙色描边 | **绝不**，只活在内存，清空搜索即消失 |
| 真高亮 | `.hlLayer .hl` | 色板五色，可点选、可编辑、可删除 | **会**，见 §4b |

**为什么不闪**：切「当前命中」只改一个 class（`setActiveMark`），
不动 DOM 结构、不重建每一页的标记层、不触发 720ms 的翻页闪白，滚动也用瞬时而非平滑——
平滑滚动会一路唤醒惰性渲染，看起来就是一串闪白。

**索引怎么建**：`Search.build()` 逐页 `getTextContent()`，把每段文字连同 `transform / width / height` 一起存进内存
（`{text, items[{start, str, width, height, transform}], vp}`），页面文本拼成一条长串以便跨行匹配。
命中就是「页号 + 字符区间」，`rectsFor(hit)` 再把这个区间反算成一组归一化矩形——
所以一个词跨两行时会画出**两块**标记，而不是一个大框。
索引按文档缓存（`Search.reset()` 在换文档时清），大文件第一次搜会先显示「正在建索引…」。

## 4. 标注

| 操作 | 方式 | 结果 |
| --- | --- | --- |
| **摘录** | 拖选文字 → 浮动框点「摘录」（或选色后按「摘录」） | 生成高亮块并进入右侧摘录列表，**不**弹笔记框 |
| **摘录并记录** | 拖选文字 → 点「摘录并记录」 | 同上，并立刻弹出大笔记框（带原文引用 + 附件） |
| **复制** | 拖选文字 → 浮动框点「复制」 | 先按 CJK 规则清洗字间空格，再写入剪贴板（3.1.0 由图标改为文字按钮） |
| **翻译** | 拖选文字 → 浮动框点「翻译」 | 右侧/就近弹层显示译文，可复制、可「存为笔记」、可切换中↔英 |
| **图片摘录** | 直接点页面里的图片（3.2.0 修好命中） | 悬停显示细框 → 点一下弹悬浮工具条（摘录 / 摘录并笔记 / 复制），摘录自动裁剪为 PNG 存入 `ann.image` |
| 框选摘录 | 工具「框选」→ 在页面上拖出矩形 | 生成区域标注，自动截图存 `ann.image` |
| 页面锚点 | 工具「锚点」→ 点击页面任意位置 | 生成笔记锚点，弹出批注框 |
| 打开链接 | 直接点页面里的超链接（3.1.0 新增） | 弹「在 Eagle 中打开 / 用默认浏览器打开 / 复制链接」；指向本文档的内部跳转直接翻页 |
| 取消选中 | 点击页面空白处 | 高亮边框消失（3.0.0 修复） |

跨栏、跨行、**跨页**选区都会被正确处理：跨页时自动拆成多条标注（每页一条，文本按页切分）。

双击任意标注可编辑备注；`Ctrl/⌘ + Enter` 保存，点击外部自动保存。

### 图片与链接是怎么被「点到」的（3.1.0）

不做 DOM 覆盖层——覆盖层会挡住文字选择与双链选区。改为**坐标命中**：

1. `ensureOverlays(n)` 在渲染完一页后遍历 `page.getOperatorList()`，跟踪
   `save / restore / transform` 维护 CTM，遇到 `paintImageXObject` 一类算子就用
   `Util.transform(vp.transform, ctm)` 换算，再用 `applyTransform([0,0])` 与 `applyTransform([1,1])` 求包围盒，
   过滤掉面积 <0.4% 或 >97% 页面（整页底图）以及宽高 <14px（小图标）的噪声。
2. 链接走 `page.getAnnotations({ intent: 'display' })`，筛 `subtype === 'Link'`，
   用 `vp.convertToViewportRectangle(rect)` 换算成视口坐标。
3. 命中在 **`mousedown` + `mouseup`** 里做（不是 `click`）：文字层会吃掉 `click`，
   而选完字后选区没塌陷时 `click` 又会被误判成「还在选字」。按下与抬起位移 ≤6px 才算「点中图片」，
   拖动超过 6px 视为选字/框选。
4. `findLinkAt` → `findImageAt` **倒序**查找（后画的内容盖在上面），容差 4px；
   都没命中才当作「点空白」清掉选中。该页图片几何还没解析完时，会先解析再重试一次。

### 高亮准确性（v2 重点修复）

旧版有两个问题，v2 均已修正：

1. **选中的字没亮** — 原因是 `Range.getBoundingClientRect()` 只返回整体的外包矩形，
   遇到两端对齐、字间距不均、双栏排版时会算偏。
   v2 改为用 `TreeWalker` 遍历选区内的**每个文本节点**，对每段取 `Range.getClientRects()`，
   得到的是浏览器真实排版后的逐行矩形，再用 `mergeLineRects(rects, gapTol)` 按「同 top 归行 +
   行内间隙 ≤ 中位行高×0.9 才合并」的规则拼合——跨栏不会被误连成一条长条。
2. **划过已有高亮选不动字** — 原因是旧的标注层在最上面且 `pointer-events: auto`，
   鼠标一进高亮区就被它吃掉。v2 重排了层级：

   ```
   （同一张页面内，按 DOM 顺序从下往上）
   canvas（页面图像）
   .searchLayer  搜索临时标记，pointer-events: none（3.3.0）
   .hlLayer      真高亮色块，pointer-events: none
   .textLayer    透明文字层，选字发生在这里
   .pinLayer     仅笔记锚点可点
   ```

   高亮画在文字**下面**，永远不会挡住选区；点击命中也改为按坐标反查（`onPageClick`），
   而不是依赖 DOM 命中。

矩形坐标最终以归一化值（0–1，相对页面）存盘，因此缩放 / 换机 / 不同 DPI 下位置一致。

## 4b. 高亮写进 PDF 文件本身（3.3.0）

插件里的高亮**不再只是插件的数据**：每加一条、改一次颜色、删一条，都会同步写回磁盘上那个 `.pdf`。
把文件拖到 Acrobat / 预览 / 浏览器里打开，高亮照样在；反过来，高亮在 PDF 里删掉，插件重开也会跟着没有。

### 为什么整篇重写，而不是追加增量更新

PDF 的增量更新（append + 新 xref）看起来省钱，但要自己处理 xref 流、对象流、压缩对象、加密字典的 `/ID`，
任何一步写错文件就打不开了。所以走的是 **pdf-lib `load → 改 → save` 整篇重写**：
输入输出都是完整合法的 PDF，兼容性最好。代价是每次写都会重排一遍文件（几十 MB 的 PDF 大约几百毫秒，有防抖兜着）。

### 一条高亮的形态

标准 `/Highlight` 注释，字段如下（`/NM` 就是我们的**指纹**）：

```
<< /Type /Annot  /Subtype /Highlight
   /NM (eaglenote:an_1a2b3c)          ← 指纹，前缀 eaglenote:
   /Rect [...]  /QuadPoints [...]
   /C [0.96 0.77 0.26]                ← 色板对应的 RGB
   /F 4                               ← Print
   /AP << /N <Form XObject> >>        ← 外观流：ExtGState(ca/CA .38) + 若干 re f 矩形
   /T (Eagle 笔记管理)  /M (D:20261027...) >>
```

- **`/NM` 指纹是同步的关键**：每次同步，先扫所有页的 `/Annots`，把 `nameOf(dict)` 以 `eaglenote:` 开头的**全部摘掉**，
  再把当前数据里还存在的重写一遍。于是「删一条」「改色」「换页」都不需要额外的 diff 逻辑——重写即真相。
- **别人的注释一条不碰**：Acrobat 的便签、Foxit 的批注、上标链接，只要 `/NM` 不是我们的前缀，原样保留（有测试用例守着）。
- **`/AP` 必须有**：没有外观流的注释，很多阅读器直接不画。外观流是一个 Form XObject，内容只有五行左右：
  `q` → **`/GS0 gs`**（`ExtGState` 的 `ca = CA = 0.45`、`BM = /Multiply`）→ `<r> <g> <b> rg` → 若干 `re` → `f Q`。
  注意 `gs` 的操作数是**资源名**，必须带斜杠；写成 `0.38 gs` 会被 PDFium 判为非法（整条外观流不画）、被 WPS 丢弃 AP 退回实心 `/C`。
- **一条注释一个外观流，且 BBox 必须等于它自己的 `/Rect` 尺寸**。这是 3.3.1 修的两个 bug，见下面「踩过的坑」。
- 注释字典上**不写** `/CA`：它会同外观流里的 `ca` 相乘（0.45 × 0.45 ≈ 0.20，几乎看不见），
  而给了 `/AP` 之后阅读器本来就以 AP 为准。

### 踩过的坑：写进 PDF 的高亮变成「实心黄条盖住字」（3.3.1 修）

3.3.0 上线后实机反馈：**PDF 里的高亮是一条实心黄色亮条，把文字整个盖住；紫色的条目干脆没出现。**
两个独立的原因，都出在外观流上：

| 现象 | 根因 | 修法 |
| --- | --- | --- |
| 实心亮条盖住文字、位置和粗细都不对 | 整页**共用一个**外观流，`BBox` 用的是**整页**的包围盒，而每条注释的 `/Rect` 只有一行高。PDF 规范规定「注释外观绘制时把 BBox 映射到 Rect」——于是整页的色块被压进那一行里，还叠了好几层，0.38 的透明度叠两三次就接近实心 | **一条注释一个外观流**，`BBox = [0, 0, w, h]` 就取这条自己的 bbox 宽高，缩放因子恒为 1，不再变形 |
| 紫色的高亮在 PDF 里看不到（显示成黄色，或被黄条盖住） | 同上：共用流的颜色取自 `built[0]`（本页第一条），后面所有条目都被染成第一条的颜色 | 颜色跟着每条自己的 `item.color` 走，`/C` 与外观流里同时用这个色 |
| 改色后 PDF 里不变 | 同上 | 同上 |

顺带修的：注释字典上不再写 `/CA`（会和外观流里的 `ca` 相乘，变成 0.14 的「看不见」）；
新增**自愈**逻辑——`PdfWrite.VERSION` 变了以后，第一次打开带高亮的文档会补一次同步，
把老文件里那些错误注释整体重写掉（每个版本只做一次，不反复动文件）。

回归用例守着这三件事：每条注释的 `BBox` 必须与自己的 `Rect` 同尺寸（±0.6pt）、
外观流里必须有 `gs`（且 `ca` 在 0.15–0.75 之间）、同页黄+紫两条的 `/C` 必须各是各的颜色。

### 为什么现在和 WPS 的高亮是同一个观感（3.3.3）

WPS 自己的「高亮文本」之所以像荧光笔，靠的不是更浓的颜色，而是**正片叠底**：
色块和页面相乘，白纸被染成色带、黑字仍然是黑字。普通混合做不到这一点 ——
透明度一高，字就被染成一层淡淡的同色，看起来"发灰"；透明度低，色带又淡得像没画。

所以 3.3.3 把外观流改成同一套配方：

| 参数 | 之前 | 现在 |
| --- | --- | --- |
| 混合模式 | `Normal` | **`Multiply`**（`ExtGState` 里的 `BM`） |
| 不透明度 `ca` | 0.38 | **0.45** |
| `/C`（不认 AP 的阅读器的后路） | 提亮 50%，洗成糖水色 | **只提亮 20%**，色相与插件色板一致 |

`BM` 不被支持的阅读器会退回 `Normal`，此时 0.45 仍然能看清字 —— 这是一条只降级不崩的路。

### 坐标怎么换算回去

数据里存的是归一化矩形（相对页面的 0–1）。写文件时要换回 PDF **用户空间**：

```
viewport = page.getViewport({ scale: 1 })     // 已含 /Rotate 与 CropBox 偏移
inv      = invert(viewport.transform)         // 用户空间 → 显示空间 的逆
[x1, y1] = apply(inv, nx * vp.width, ny * vp.height)
```

因为 `transform` 本身就编码了旋转和裁剪偏移，横版旋转页（`/Rotate 90`）和带 CropBox 的页也不会画错位。

### 安全机制（四层）

| 层 | 做法 |
| --- | --- |
| 备份 | 第一次改某个文件前，把原文件复制到 `<dataDir>/pdfbak/<docKey>.pdf`；之后一直覆盖这一份，即「最初的样子」。`PdfWrite.restore()` 可一键还原 |
| 原子替换 | 先写 `xxx.pdf.tmp`，`fs.renameSync` 覆盖正式文件——中途崩溃不会留下半个 PDF |
| 自检 | 写完后 `countMarks(out)` 数一遍，条数必须等于「本页应写条数」；不符直接报 `verify` 失败，**不落盘** |
| 不写加密文档 | `PDFDocument.load(..., { ignoreEncryption: false })` 抛错时返回 `reason: 'encrypted'`，文件一字不动，只在插件里保留高亮，并 toast 说明 |

### 什么时候触发

`addAnnotation / updateAnnotation / removeAnnotation` 都会调 `schedulePdfSync()`（900ms 防抖），
另外用 `highlightSig()`（`id|页|色|矩形|备注长度` 拼接）比对——**内容没变就不写盘**，只是翻页、切文档不会产生写操作。

失败时的 toast 文案区分三种：`已写入 PDF（N 处高亮）` / `这是加密 PDF，只在插件里保留高亮` / `写入失败（原因）`。


## 5. 摘录与笔记的去向（3.1.0 起：只有一条链路）

**没有「存入 Eagle」按钮了。** 摘录产生的那一刻就已经落地，删除的那一刻就已经消失：

```
拖选 / 点图  →  ann 加入 docs/<itemId>.json（摘录 + 可选的图片 PNG + 笔记 Markdown）
                    ↓ 1.2s 防抖
              笔记正文同步写入 Eagle 条目的 annotation 字段（纯 Markdown 文本）
                    ↓ 2.6s 防抖（内容没变就跳过）
              整篇重写成 <资料库>/_notes/<itemId>-<书名>.md（3.11.0 起，图片落 assets/）
删除         →  移出索引 → 重写 annotation（Eagle 侧同步消失）→ 进 trash.json（30 天）
              →  MD 整篇重写（对应段落与 png 一起消失）
```

| 项 | 旧做法（≤3.0.0） | 现在（3.1.0） |
| --- | --- | --- |
| 入库方式 | 手动点「存入 Eagle」/「全部存入」 | 即写即存，无手动步骤 |
| 载体 | 每条约 2–4.5× 重渲染的**卡片长图**，作为独立图片条目 | **Markdown 纯文本**写入该 PDF 条目的 `annotation`，摘录与笔记数据留在结构化索引里 |
| 删除 | 只从插件列表移除 | 同步改写 `annotation`，并在 Eagle 侧保持一致；插件内进回收站 |
| 后续接 AI | 图片无法直接读 | `docs/<itemId>.json` 是结构化 JSON + Markdown，直接可喂给模型 |

- `annotation` 上限 10000 字符，超出截断并标注「…（已截断）」。
- 多条笔记之间用空行分隔，同步是**整段覆盖**而非累加，重复触发不会叠加。
- 本地文件（未入库、没有 `itemId`）没有 `annotation` 可写，只保存在插件索引里，并如实提示。

每条摘录卡片提供：**定位 / 写笔记 / 复制 / 删除**（图片摘录额外有「复制图片」）。

> v1 曾出现「显示未连接 Eagle」：检测用 `typeof window.eagle.item === 'object'` 判定，
> 而 Eagle 注入的 `item` 是 **class（`typeof` 为 `function`）**，于是永远判为未连接。
> v2 的判定改为「`eagle.item && eagle.library` 存在即可用」，不再做类型判断。

### Markdown 副本（3.11.0 起）

除上面的结构化索引与 `annotation`，插件还会把每篇文档的摘录与笔记**另存一份 Markdown**，放在资料库自己的目录里：

```
<资料库>/_notes/<itemId>-<书名>.md      ← 一篇文档一份，可读、可编辑、可被任意工具读取
<资料库>/_notes/assets/<itemId>/*.png   ← 区域截图 / 笔记配图，正文里用相对路径引用
<资料库>/_notes/.eaglenote-manifest.json ← 内部清单：内容哈希、文件名、图片清单
```

**为什么放资料库里面，而不是新建一个"笔记资料库"**：Eagle 的插件 API 只有 `library.info()` / `name` / `path` / `modificationTime`，**没有建库、切库、枚举库的能力**；而且 Eagle 不索引文件正文，把 `.md` 当条目塞进新库，在 Eagle 里既搜不到内容、缩略图还是文件图标。放在当前资料库的 `_notes` 下，资料库搬家、改名、整体备份时笔记自动跟着走，又不占 Eagle 条目。

**它只是副本，不是源**：

- 权威数据始终是 `docs/<itemId>.json`（坐标、颜色、时间轴、附件都只在这里）；
- MD 是每次保存时**整篇重写**的投影，删掉、改坏都能从 JSON 重建（工作台的「重建全部 Markdown」）；
- 删掉 MD 不影响插件里的摘录与笔记，插件也不会从 MD 回读。

frontmatter 带 `eagle`（条目 id）、`library`、`file`、`tags`、`excerpts` / `notes` 计数，外部脚本靠 `eagle` 就能把 MD 与 Eagle 条目对上：

```markdown
---
eagle: "MV11TX2DS5BHY"
library: "DY - Clinical Surgery"
file: "膜解剖实战 - 保脾胰体尾切除术"
kind: "pdf"
tags: ["肝胆", "解剖"]
updated: 2026-10-28T21:36:45+08:00
excerpts: 12
notes: 3
---

## 摘录

### p.42

> 胆囊三角由胆囊管、肝总管和肝下缘共同构成……

**笔记**

这里容易和 Calot 三角混淆

![框选 · 蓝](assets/MV11TX2DS5BHY/anxxxx.png)
```

几个实现上的取舍：

- **图片必须落盘**。索引里的 `image` 是 dataURL，一篇带几张截图的文档光 JSON 就 140KB；写进 MD 会变成几 MB 的单文件，Obsidian 和模型都难受。落成 png/jpg 后，一篇 12 条摘录的文档 MD 通常只有几 KB。
- **整篇重写而非追加**。省掉"删除一条就要精确删掉 MD 里对应几行"的对账逻辑，天然不会出现 MD 与 JSON 不一致。
- **哈希幂等**。内容没变就不重写（打字停 2.6s 才落盘），避免把同步盘写爆。
- **改名跟着删旧文件**，摘录删了对应的 png 也一起清；`_notes` 里你自己放的文件一律不碰。

开关和路径在 **工作台 → 索引与维护**：显示当前 `_notes` 目录、勾选「生成 Markdown 副本」、打开目录、重建全部。关掉开关只是停止继续写，已经生成的不会自动删。

> 视频条目一样有副本，`###` 标题按时间轴分组（`01:15–01:30`），超过一小时带小时位。

### 回收站（30 天）

右栏头部的 `🗑` 打开回收站浮层：

- 条目显示类型（摘录 / 笔记）、来源文档、删除时间与**「剩余 N 天」**；
- **还原**：按 `docKey` 写回原文档（`Store.readDocByKey / writeDocByKey`），文档已被移除也能还原到索引；
- **彻底删除 / 清空**：直接抹掉 `trash.json` 对应记录；
- 每次读写都会顺手 `purgeTrash()`，超 30 天的记录自动消失。

## 6. 笔记

右栏「笔记」页上下分区：

**上半：新建 / 编辑笔记（Markdown 实时预览 + 附件）**

编辑器由 `js/editor.js` 提供，同一套组件挂载在两处：右栏（快速记）与大浮层（摘录并记录 / 编辑既有笔记）。

- **左编辑、右预览**，`input` 即渲染，输入 `**粗体**` 立刻变粗，不再需要「保存后才生效」。
- 工具栏：

  | 按钮 | 语法 | 说明 |
  | --- | --- | --- |
  | **B** / *I* | `**粗**` / `*斜*` | 加粗 / 斜体（`Ctrl+B`、`Ctrl+I`） |
  | == | `==高亮==` | 荧光标记 |
  | S̶ | `~~删除线~~` | 删除线 |
  | 标题 | `#` ~ `###` | 下拉顺序 **标题 1 → 标题 2 → 标题 3 → 正文**（选「正文」会去掉行首 `#`） |
  | 字号 | `<span style="font-size:Npx">` | 特大 / 大 / 中 / 小 |
  | ❝ / ≡ / — | `> ` / `- ` / `---` | 引用 / 列表 / 分割线 |
  | 引用摘录 | — | 把这条笔记对应的摘录（或最近一条摘录）以 `> ` 块插入，附页码 |

- **`Ctrl+Enter` 保存**：按钮上就印着 `Ctrl ↵`。焦点在正文、预览区、附件区，或者干脆
  点过阅读区之后再按，都能保存手头这一份（模态框优先）；拼音输入法选词那一下不算。

- **附件**：`＋ 本地文件`（系统文件对话框，可多选）与 `＋ Eagle 库`（搜索条目后勾选）。
  附件**不复制文件本体**，只记录来源：
  - 本地文件 → 绝对路径
  - Eagle 条目 → **`itemId`**（Eagle 内部按 id 组织文件，条目在库里换文件夹也仍然有效）

- **空内容时「保存笔记」置灰**（3.1.0）：`NoteEditor.hasContent()` 判定正文 `trim()` 为空且没有附件时
  `btnSave.disabled = true`，`title` 显示「先写点内容再保存」；输入、加附件、外部 `setValue` 都会重新判定。
  这样「点开笔记框 → 手滑点保存 → 落一条空笔记」这条路被堵死。

**下半：已记笔记列表（仅本 PDF）**

卡片结构按「笔记为主、来源为辅」排：

```
┌ 摘录笔记   p.12   ⧉ 2        3 小时前 ┐
│ 笔记正文（13px，Markdown 全文渲染）      │
│ [框选图片缩略图，最高 120px]             │
│ ┌ 摘自第 12 页 ────────────────┐       │
│ │ 摘录原文（11px，斜体，两行截断）│       │
│ └──────────────────────────────┘       │
└ 编辑  复制  定位            删除 ┘
```

两处 3.1.0 的观感调整：

- **来源摘录改斜体**：`.nc-source-text { font-style: italic; -webkit-line-clamp: 2 }`——
  之前 4 行灰字会把卡片撑得很长，现在固定两行、斜体与正文区分，完整原文在编辑框里才展开。
- **框选图片在笔记栏是小图**：`.nc-img { max-height: 120px }`（摘录栏里是 `.ec-img` 通栏大图），点图可放大。

两个页签是同一份数据的两个视角，不重复存储：

| 页签 | 主体 | 附带 |
| --- | --- | --- |
| **摘录** | 摘录原文（大字、带高亮色条）+ 图片原尺寸缩略 | 你写的批注（小字、Markdown 渲染） |
| **笔记** | 你的笔记（大字） | 来源摘录（斜体小字，带页码）+ 图片小图 |

**同步到 Eagle 注释**

保存笔记后自动（1.2s 防抖）把**全部笔记正文**写入该条目的 `annotation` 字段：

- 只写笔记内容，**摘录不写入**；
- 多条笔记之间用空行分隔，重复同步是整段覆盖而非累加；
- `annotation` 上限 10000 字符，超出会截断并标注「…（已截断）」。

**导出**

- **导出 .md**：写到 PDF 同目录，文件名 `文件名-工作笔记-YYYYMMDD.md`（无写权限时退化为浏览器下载）
- **复制**：按「引用 + 正文」拼成 Markdown 纯文本
- ~~生成笔记卡片~~：3.1.0 已移除，笔记不再产出图片

**其它**：顶栏「搜索」（全文检索，命中按页分组，`Ctrl+F` / `/` 呼出）、明暗主题、缩放（适宽 / 适页 / 百分比）。

**快捷键**

```
← → / PgUp PgDn   翻页        + -      缩放
0  适宽            1:1        Ctrl+F 或 /  顶栏搜索
A 框选  N 锚点  V 回到选择     Ctrl+S   立即保存标注
Ctrl+Enter 保存手头这一份：笔记编辑器 / 批注浮层 / 笔记大框 / 译文存笔记 / 每日笔记
Ctrl+Z 撤销上一步（新增/删除/修改摘录或笔记）  Ctrl+Shift+Z / Ctrl+Y 重做
Delete 删除选中的摘录 / 笔记 / 视频时间轴标记（PDF 里的高亮一并抹掉）
Esc 逐级关闭：翻译框 → 搜索 → 各浮层 → 取消选中 → 退出插件（有草稿先问保存）
```

`Ctrl+Enter` 不看焦点在哪：笔记编辑器的正文、预览区、附件区，甚至点了阅读区之后按，
存的都是「手头正在写的那一份」。按层级优先：批注浮层 / 笔记大框（模态）→ 光标所在的
编辑器 → 翻译框（存译文）→ 右栏编辑器。用拼音输入法选词时那一下 `Enter` 不算保存。

## 6b. 划词翻译（3.3.3 起「开箱即用 + 对冲调度」）

选中文字 → 悬浮工具条点「翻译」，弹层里给三样东西：原文、译文、来源与耗时。

| 顺序 | 引擎 | 需要密钥 | 实测 | 说明 |
| --- | --- | --- | --- | --- |
| 1 | **本地模型（Ollama）** | 否 | 200–800ms | 本机 `127.0.0.1:11434`，不外传；长句、术语最准。装了 Ollama 就能用 |
| 2 | **有道智云** | 是 | 150–300ms | 国内直连、质量稳定。⚙ 里填 `appKey` / `appSecret` |
| 3 | **有道「免密钥」** | **否** | **50–300ms** | `aidemo.youdao.com`，网页端在用的公开接口。**默认主力**，什么都不配就能跑 |
| 4 | Google gtx | 否 | 国内多数超时 | 只在前面 1.2 秒都没回时对冲放出 |
| 5 | MyMemory | 否 | 700–900ms | 公共兜底，仅保证「有结果」 |

1–3 是**一线引擎**，一起发；Google / MyMemory 是**兜底**，一线 1.2 秒没回才被唤醒。
任何一线返回，兜底的请求结果直接丢弃。

**500 字限制到底是什么**

不是插件设的，是接口的硬顶：MyMemory 超过 500 字直接回 `QUERY LENGTH LIMIT EXCEEDED`，
有道免密钥超过约 1000 字回 `errorCode 103`。上一版按 **1200 字**切块，长一点的选区必然踩线，
所以看起来就像"插件只让翻 500 字"。

现在：主线路按 **900 字**切块（3 块并发，保持在不踩线的位置），
MyMemory 自己在内部再切到 **300（中文）/ 450（英文）**。上限 20000 字，选一整页也能翻。

**本地模型怎么用（可选）**

1. 装 Ollama：<https://ollama.com>，装完 `ollama pull qwen2.5:7b`（或任何你喜欢的模型）；
   **建议再装一个视觉模型 `ollama pull qwen2.5vl:7b`**，图片 OCR 要用（见 §6c）；
2. 插件里点「翻译」→ ⚙ → 地址 `http://127.0.0.1:11434`，模型名**可以留空** → **保存并重试**；
3. 面板会显示 `本地模型 · 320ms`。

模型配置（`eaglenote:trlocal`）与有道密钥（`eaglenote:tryoudao`）分开存，互不覆盖。
插件启动时不探测、只在真正翻译前探一次 `/api/tags`（结果缓存 30s）。

**选哪个模型**（3.4.0 调整）：留空时**优先挑视觉模型**。原因是显存：这台 12 GB 卡上
翻译模型 5.6 GB、视觉模型 6.2 GB 装不下两个，换载一次 3.9 秒；而视觉模型做纯文本翻译
只要 0.3–0.5 秒，质量相当。所以让它一个顶两个用，翻译和 OCR 都不换载。
显式填了模型名就尊重你的选择。配置里的模型被删了会自动退回列表里能用的那个。

**为什么现在快**（3.3.3）

| 做法 | 之前 | 现在 |
| --- | --- | --- |
| 主力 | 没有密钥 / Google 被墙时只能落到 MyMemory | 有道免密钥接口，国内直连、50–300ms |
| 调度 | 一线全失败后，Google 超时 4s → 再超时 4s → 才轮 MyMemory（一次 8s 起） | **对冲**：一线先跑，1.2s 没回就把公共接口一起放出去，谁先回用谁 |
| 分块 | 1200 字一块，长文必然撞 500 字限制 | 900 字一块 + MyMemory 内部再切到 300/450 |
| 缓存 | 按「文本 + 目标语言」存 localStorage | 不变（同一句话第二次 0ms） |

实测（本机，中文网络）：

```
855 字 EN→ZH   296ms   有道免密钥   1 块
单句           54ms    有道免密钥
2400 字（撞频控后降级） 919ms  MyMemory  3 块
```

**将来接 OCR / 视频实时转译**：这些都只需要一个「本地 HTTP 服务」，
插件这一侧已经是抽象的 `ollama()` 适配器（`/api/chat` 说白话就行）。
把 PaddleOCR / faster-whisper 包成同样形状的服务，挂在同一个「本地模型」通道上即可，
前端不用再改。

**怎么配有道**（一次即可）：

**怎么配有道**（一次即可）：

1. 打开 <https://ai.youdao.com>，注册后在「自然语言翻译 → 文本翻译」创建应用，拿到 **应用ID（appKey）** 与 **应用密钥（appSecret）**；
2. 插件里选中任意文字 → 点「翻译」→ 点右上 **⚙** → 粘贴两个值 → **保存并重试**；
3. 面板右上角会显示 `en → zh-CN · 有道 · 240ms`，说明走通了。

签名按有道 v3 规范：`sha256(appKey + truncate(q) + salt + curtime + appSecret)`，
`truncate` 规则为「长度 ≤20 原样，否则头 10 + 长度 + 尾 10」。签名用 `require('crypto')` 计算，
所以只在 Eagle（nodeIntegration 打开）里有效，纯浏览器打开会提示「无法计算签名」。

**「实时」是怎么做到的**

- 选中文字后立刻在后台预翻译（防抖 320ms），不阻塞任何界面动作；
- 结果按「文本 + 目标语言」缓存到 localStorage（最多 300 条），同一段话第二次 0 延迟；
- 每个引擎独立超时（有道 5s / Google 4s / MyMemory 6s），失败立刻换下一个，不干等；
- 翻译未完成时「复制译文」「存入笔记」都是**禁用**状态（灰掉），不会让你点到一个空结果；
- 复制译文**不关闭**面板，存入笔记后**自动关闭**面板。

**失败时**：面板里显示「翻译失败：当前网络访问不到翻译接口」，并提示「可点 ⚙ 填入有道密钥后重试」——
不会假装翻成功，也不会把英文原样当中文回显（MyMemory 的原样回显会被判失败）。

## 6c. 视频笔记（3.3.0 起，3.4.0 重做操作区）

**怎么进**：资源库里选中视频 **按空格**（3.3.2 起 `manifest.preview` 注册了
`mp4 / mov / m4v / webm / mkv / avi / ogv / wmv / flv / mpg / mpeg / ts / 3gp`），
或者在插件窗口里 `P` 打开。进入**视频阅读区**（`#videoStage`，与 PDF 的 `#viewport` 互斥显示）。

### 3.4.0 的界面：一块播放器 + 一排标注键

视频模式下界面会**自动精简**，只留下看视频和记东西要用的东西：

| 区域 | 视频模式 | PDF 模式 |
| --- | --- | --- |
| 顶栏左侧 | 只有缩放组（缩放比例 + 适宽），作用于视频显示倍率 | 翻页 + 缩放 + 色板 |
| 顶栏右侧 | 工作台、明暗切换 | 同 |
| 顶栏中间 | —（无搜索、无摘录/框选/锚点） | 四个动作键 + 全文搜索框 |
| 左栏 | 只有「历史记录」，撑满 | 目录 / 缩略图 / 搜索面板 + 历史记录 |
| 播放器下方 | 6 个标注键 + 倍速 + 时间 | — |

**空格键分工**：在 Eagle 资料库里按空格是「打开插件」，那一下的按键有可能跟着送进来，
所以**打开后 600ms 内的空格被忽略**，不会一进来就自己播；之后按空格才是播放/暂停。
退出仍走右上角 X 或 Esc。

### 6 个标注键

| 按钮 | 产生什么 | 会自动暂停吗 |
| --- | --- | --- |
| **截图** | 当前帧成一张图片摘录（`t` 固定、`t1=null`），不弹笔记 | 不暂停（不打断观看） |
| **截图并笔记** | 同上 + 直接弹笔记框（这就是 3.3 时代的「打点」） | 暂停 → 关闭笔记框后继续 |
| **框选** | 在画面上拖一个矩形，只截这块区域 | 暂停 → 完成/取消后继续 |
| **框选并笔记** | 框选 + 弹笔记框 | 暂停 → 关闭笔记框后继续 |
| **节选片段** | 按一次记 A（继续播），播到终点再按一次记 B → `00:32 → 01:07` | 取 A 不暂停；取 B 暂停 → 完成后继续 |
| **节选片段并笔记** | 同上 + 弹笔记框 | 同上 |

暂停/恢复由 `pauseForVideo()` / `resumeVideo()` 负责，**只在"开始前本来在播"时恢复**，
不会把已经暂停的视频弄成自动播放。截图或框选被 Esc 取消时也会恢复。

### 框选的坐标怎么算

`<video>` 是 `object-fit: contain`，元素框比画面宽时左右有黑边，直接用 `clientX` 会偏。
所以先把屏幕矩形按「实际画面区」换算：

```js
const k = Math.min(rect.width / videoWidth, rect.height / videoHeight);
const offX = (rect.width - videoWidth * k) / 2;      // 黑边宽度
const x = (boxLeft - offX) / k;                       // 回到视频原始像素
```

再 `drawImage(video, x, y, w, h, 0, 0, cw, ch)` 裁出来，所以框哪儿就截哪儿。

### 图片 OCR（3.4.0）

视频截图本质是图片，里面的板书 / 幻灯片文字没法直接选中。图片摘录卡片上多了一个
**OCR** 按钮：点一下走本机 Ollama 的视觉模型把文字提出来，结果写进摘录正文，
之后可以「复制」或「写笔记」带走。

```bat
:: 一次性装个视觉模型（约 6 GB）
ollama pull qwen2.5vl:7b
```

代码会自动在 `/api/tags` 里挑带 `vl` / `vision` / `llava` / `minicpm-v` 的模型，不用手填名字。
**整张图不出本机**——没装视觉模型时直接报错并给出 pull 命令，不会偷偷退回联网 OCR
（截图里可能有不该外传的内容）。识别过的条目按钮会变成「重新识别」。

实测（1280×720 的讲课幻灯片，中英混排 5 行）：

| 项 | 结果 |
| --- | --- |
| 汉字命中率 | **100%**（原文 5 行、含「≠」「（）」全部正确） |
| 热态耗时 | **1.4–1.5 秒** |
| 冷启动 | 14.4 秒（模型首次进显存，之后 3 分钟内复用） |
| 分行 | 5 行完整保留，两行相同输入结果一致 |
| 英文 | 原样保留，不会被翻成中文 |

一个后处理：`qwen2.5vl` 稳定会在每两行之间塞一个空行，原文并没有这种排版。
`tidyOcr()` 判断「空行数 ≥ 正文行数 − 1」时折叠掉，真正的段落空行（行数少）保留。

**显存只有一份：一个模型顶两个用。** 实测这台 12 GB 卡：翻译模型 5.6 GB、视觉模型 6.2 GB，
**装不下两个**，每换一次模型要 3.9 秒重新加载。而视觉模型做纯文本翻译只要 0.3–0.5 秒，
质量与纯文本模型相当（"bounding box" 反而更准）。所以：

- 用户没指定模型时，`probeLocal()` **优先挑视觉模型**，翻译和 OCR 共用它，永不换载；
- 用户显式填了模型（比如 `qwen2.5:7b`）就尊重选择，此时 OCR 会触发一次换载。

交替实测（预热后连续 翻译→OCR→翻译→OCR→翻译）：

```
翻译 1    313 ms  local
OCR  2   1447 ms  vision
翻译 3    233 ms  （有道更快就让它赢）
OCR  4   1463 ms  vision
翻译 5    117 ms
```

### 数据模型（没变）

标注结构本来就是 `{id, type, page, rects[], text, note, image, color, createdAt}`，视频只需要两个新字段：

```
{ type: 'note' | 'area', page: 1, t: 12.4, t1: 47.9 | null, image: 'data:image/jpeg;base64,...' }
```

`page` 恒为 1，`t / t1` 是秒。`Store.normalize()` 会兜底补齐这两个字段，
`rebuildIndex()` 也把它们带进索引条目，于是**知识库、回收站、检索、排序、导出、Esc 链路全部零改动即通**。
卡片上的位置标签是唯一的差异点：

```js
typeof e.t === 'number' ? '⏱ ' + VideoView.fmt(e.t) : 'p.' + e.page
```

**键盘**：`空格` 播放/暂停 · `←/→` ∓5s · `↑/↓` ∓30s · `n` 截图并笔记 · `Esc` 退出。

### 时间轴与片段计时（3.5.0）

原生 `<video controls>` 的进度条画不了标记，所以在画面上另外加了一条 `#vsTrack`：

```
┌──────────────────────────────────────────────┐
│▍        ██        ████████         ▍          │  ← 色块＝已记录的截图/框选/片段
└──────────────────────────────────────────────┘
   ▲ 当前位置（竖线）      ██＝片段区间（A→B）
```

- **颜色**就是记录时选中的标记色，所以「这条紫色框选」在轴上也是紫的，一眼能对上右栏卡片。
- **拖动即定位**：按下跳到该点，按住连续拖动。片段进行中同样可用 —— 不必等视频真的播到 B 点。
- **片段计时**：点「节选片段」后画面左上角出现计时器，从 `00:00` 起算，同时显示 `A → B`，
  现在截了多长一眼可见；再点一次收尾。`Esc` 取消。

### 空格为什么会被 Eagle 抢走（3.5.0）

Eagle 的「空格关预览」是主窗口的行为，插件跑在 iframe 里。**焦点还在 Eagle 那边时，
键盘事件根本不会进本页面**，所以插件里 `preventDefault` 也没用 —— 表现就是"再按空格直接退出"。

对策不是拦事件，而是**先把焦点要过来**：

```js
document.addEventListener('keydown', onKeyDown, true)   // 捕获阶段，先于原生 video 控件
document.addEventListener('pointerdown', () => window.focus(), true)

function grabKeys() {                 // 打开视频时调用
  window.focus();
  document.getElementById('videoStage').focus({ preventScroll: true });  // tabindex="-1"
}
```

`keyup` 上的空格也一并 `preventDefault`，防止宿主在抬起时判关闭。
万一某个环境里 `window.focus()` 被跨源策略挡住，**点一下画面**再按空格即可（点击一定会把焦点带进来）。

### 视频源为什么需要兜底

`<video src="file:///...">` 在 Eagle 的 `webSecurity: true` 下会被拒。所以 `open()` 先试直连，
`error` 事件里再退到 `fallbackBlob()`：用 `require('fs')` 把文件读成 `Blob` + `createObjectURL`。
`file://` 能通的情况下不会走这条路（大文件不会多占一份内存）。

顺带：视频体积大，右侧栏不预览视频，只显示摘录文字 + 截帧缩略图；`p.1` 这种页码在视频下没有意义，已换掉。

## 7. 数据存储（索引在哪、为什么不怕库改名）

### 3.1.0 起：数据格式 v4，按 Eagle `itemId` 存放

```
<userData>/Plugins/EagleNoteManager/data/
├── docs/
│   └── <itemId>.json        ← 单篇文档的摘录 + 笔记 + 附件（含框选图片 dataURL）
├── index.json               ← 全库压平索引（知识库 / 工作台用）
├── trash.json               ← 回收站（摘录 / 笔记，保留 30 天）
└── daily.json               ← 每日笔记（按 YYYY-MM-DD 存 Markdown）
```

- `<userData>` 在 Windows 是 `%APPDATA%\Eagle`，macOS 是 `~/Library/Application Support/Eagle`。
  实际路径可以在「工作台 → 索引与维护」里直接看到，也能一键打开目录。
- **键是 Eagle 的 `itemId`**，不是文件路径、也不是资料库名字。所以：
  - 资料库改名 → 不影响（id 不变）
  - 整个资料库换盘/换目录 → 不影响（id 不变）
  - 文件在 Eagle 内部换文件夹 → 不影响（id 不变）
- 唯一会失效的情况：**换一个资料库**（不同 library 的 item id 空间不同）。跨库索引导出暂未实现。
- 本地文件（未入库）没有 `itemId`，退化为 `local_<路径短哈希>`，这类文档本来就不参与知识库统计。
- `rebuildIndex()` 会把**每日笔记**也压成 `kind: 'daily'` 的条目塞进索引，所以知识库的「每日」筛选、
  工作台的年度热力图、最近活动流都能统计到它。

### 旧数据兼容（3.1.0 收紧）

早期版本把标注写在 PDF 同目录的 `_eagle-pdf-annotations.json`，并用 `localStorage` 兜底。
3.1.0 起改为 **有数据目录就以数据目录为准**：

```js
function load(meta) {
  const df = docFile(meta);
  if (df) {
    if (fs.existsSync(df)) return normalize(JSON.parse(fs.readFileSync(df, 'utf8')), meta);
    return emptyData(meta);          // 目录在、文件不在 → 就是空的
  }
  /* 只有拿不到 Node（浏览器调试）时才退回 localStorage */
}
```

原因是「先清空旧测试数据」时发现：只要还留回读逻辑，删掉 `docs/*.json` 后旧数据会从 sidecar
或 localStorage 里复活，出现「删了还在」的错觉。要清就清干净，
`Store.clearAll()` 会同时抹掉 `docs/*.json`、`index.json`、`trash.json` 和相关 localStorage 键。

```json
{
  "version": 5,
  "itemId": "EM2ABCDEFG",
  "fileName": "认知盈余.pdf",
  "annotations": [
    { "id": "an_x1", "type": "highlight", "page": 12, "color": "yellow",
      "rects": [{ "x": 0.1, "y": 0.2, "w": 0.5, "h": 0.03 }],
      "text": "摘录原文（已清洗中文字间空格）",
      "note": "这条摘录上的笔记", "attachments": [],
      "image": "",                       // 3.1.0：框选 / 图片摘录的 PNG dataURL
      "translation": { "target": "en", "text": "…" }   // 3.1.0：划词翻译结果
    },
    { "id": "an_v1", "type": "area", "page": 1, "color": "blue",
      "rects": [], "text": "", "image": "data:image/jpeg;base64,…",
      "t": 32.5, "t1": 67.2             // 3.3.0：视频时间轴（秒）；打点 t1 = null
    }
  ],
  "notes": [
    { "id": "nt_1", "md": "独立笔记（Markdown）", "quote": "关联的摘录原文",
      "page": 12, "annId": null, "image": "",
      "attachments": [
        { "kind": "eagle", "itemId": "EM2ZZZ", "name": "参考文献.pdf", "ext": "pdf" },
        { "kind": "file", "path": "D:////资料////补充材料.xlsx", "name": "补充材料.xlsx", "ext": "xlsx" }
      ] }
  ],
  "reading": { "page": 12, "zoomMode": "fit-width", "zoom": 1 }
}
```

`normalize()` 会为老记录补齐 `image` / `translation` 字段为空值，所以 v3 的 `docs/*.json` 能直接读。

阅读历史仍是纯浏览痕迹，存在 `localStorage`（`eaglenote:history`），**只记 Eagle 条目**；
工作台的「最近阅读」把这个历史和索引里的 `docs` 合并后按 `lastReadAt` 排序。

另外两项数据不属于「笔记」，单独存放：

| 路径 | 内容 | 说明 |
| --- | --- | --- |
| `<dataDir>/pdfbak/<docKey>.pdf` | 每个被改过的 PDF 的**原始副本** | 只留第一份，之后不再覆盖；`PdfWrite.restore()` 可还原 |
| `<dataDir>/archive-v32-<YYYYMMDD>/` | 3.3.0 清库时整体搬走的老数据 | 不删，只归档；确认不要了可以手动清 |

### 3.3.0 起：换大版本即清库（`migrateEpoch`）

按反馈「下一版本生成的同时，清掉之前的所有数据」，清库做成**一次性、幂等**的迁移：

```js
localStorage['eaglenote:epoch']     // 上次运行时的纪元，3.3.0 写 '3.3'
if (saved !== EPOCH) {
  1) 整个 data 目录 rename → archive-v32-<YYYYMMDD>/      // 先留一手，不 rm
  2) 重建空的 docs/ index/ trash/ daily/
  3) 清 localStorage 里所有 eaglenote:*，但保留 theme / 有道密钥 / epoch
  4) 写回 epoch = '3.3'
}
```

它挂在 `Bridge.setDataDir()` 之后执行（那时才知道数据目录在哪），结果记在 `state.epochWiped`，
并在控制台打印一行「已按 3.3 纪元清空旧数据」。因为是**比对纪元**而不是「每次都清」，重开插件不会反复抹数据。
保留主题与有道密钥，是因为它们属于「偏好」而不是「笔记」——清库不该让人重新配一遍翻译。

## 8. 实现要点

- **PDF.js 3.11.174 legacy**：对应 Eagle 4.0 的 Chromium 107 / Electron 22 运行时。
- **Worker 走 Blob**：`file://` 下 `new Worker('.../pdf.worker.js')` 会被 Chromium 拦截，
  因此读取本地 worker 源码后用 `Blob` + `createObjectURL` 注入。
- **中文 CMap 走 Node 直读**：很多中文 PDF 用 `UniGB-UCS2-H` 等预定义 CMap 且不嵌字体，
  默认实现通过 XHR 取 `cmaps/*.bcmap`，在 `file://` 下失败会导致**整篇文字为空**。
  插件注入自定义 `CMapReaderFactory` / `StandardFontDataFactory`，用 `fs` 读随包资源。
- **虚拟化渲染**：按 `getViewport(scale:1)` 预算全部页面尺寸撑出占位；
  `IntersectionObserver` + 可视区计算按需渲染，离当前页 8 页以上释放 canvas 位图。
- **缩放竞态**：缩放时取消在飞的 `RenderTask`，用「页面→目标缩放」令牌避免重复渲染。
- **图片 / 链接命中用坐标反查**，不做 DOM 覆盖层（会挡住文字选择），详见 §4 末尾。
- **翻译降级链**（`js/translator.js`）：有道智云（配了密钥时）→ Google gtx（`dj=1`）→ Google gtx（二维数组）→ MyMemory；
  每个引擎独立超时，失败给出 `{ok:false, error, detail, hint}` 并在浮层里显示原因，不会静默失败。
  有道签名用 `require('crypto')` 的 SHA-256（v3 规范），只在 Eagle 的 nodeIntegration 环境可用。
- **classic script 的 `const` 不挂 `window`**：`NoteEditor` / `Translator` / `Workbench` /
  `KnowledgeBase` / `Trash` 都在文件末尾显式 `window.X = X`，否则 `App` 拿到的永远是 `undefined`。
- **Markdown 自研渲染**（`js/markdown.js`，无第三方依赖）：标题、有序/无序列表、引用、代码块、
  表格、`**粗**` `*斜*` `==高亮==` `~~删~~`、行内代码、链接，以及**白名单**的
  `<span style="font-size:Npx">`。其余 HTML 一律转义，杜绝笔记内容注入。
- **`el()` 的 `html` 分支**：`U.el({ html })` 走 `innerHTML`，笔记卡片才能渲染 Markdown。
- **`U.el(tag, attrs, html)` 第二参是属性对象**（`{class, text, html}`），不是 class 字符串。
  3.3.0 修的那个「确认框两个按钮看不见」就是这里传错了参——按钮既没 class 也没文字。
- **Esc 用显示栈，不用 if-else 阶梯**（`js/esc.js`）：谁打开谁 `Esc.push(name, closeFn)`，Esc 只弹栈顶。
  比逐层判断好在**顺序天然等于「后开先关」**，加新浮层只要 push 一行，不会漏。
  栈空才允许 `exitPlugin()`。
- **搜索索引带几何**（`js/search.js`）：只存文本无法定位，所以每段文字连 `transform / width / height`
  与当页 `vp.transform` 一起存；命中是「页 + 字符区间」，`rectsFor()` 反算矩形。
- **写 PDF 整篇重写**（`js/pdfwrite.js`）：`load → 删指纹注释 → 重建 → save → 自检 → tmp+rename`，
  不做增量更新（xref 流 / 对象流 / 加密字典最容易出错），详见 §4b。
- **视频源兜底**（`js/videoview.js`）：`file://` 直连失败时用 `fs` 读成 `Blob` + `createObjectURL`，
  绕开 `webSecurity` 对本地媒体文件的拦截。

## 9. 目录结构

```
EaglePDFReader/
├─ manifest.json          插件清单（main 窗口 + preview 预览扩展）
├─ logo.png               128×128 图标
├─ index.html             界面骨架（顶栏 / 左右栏 / 知识库 / 回收站 / 工作台 / 各类浮层）
├─ css/app.css            布局、侧栏、面板、Markdown 排版、浮层、便利贴卡片墙、年度热力图
├─ css/viewer.css         页面/高亮层/文字层/锚点层/链接悬停框 的层级
├─ js/utils.js            DOM/几何/时间 工具（含 mergeLineRects、dateKey、cjkRatio、fmtClock）
├─ js/markdown.js         轻量 Markdown → HTML
├─ js/store.js            索引读写（v5）、回收站、每日笔记、阅读历史、clearAll、migrateEpoch
├─ js/bridge.js           Eagle API 封装（窗口/预览/浏览器三种模式）+ 剪贴板图片 + 关窗 + 纪元迁移入口
├─ js/esc.js              显示栈：谁打开谁入栈，Esc 只弹栈顶（3.3.0）
├─ js/pdfdoc.js           文档加载、Worker、CMap 工厂、目录
├─ js/pdfwrite.js         把高亮写回 PDF 文件（pdf-lib 整篇重写 + 指纹注释 + 备份/自检，3.3.0）
├─ js/search.js           全文索引（带每段几何）与命中矩形反算（3.3.0）
├─ js/videoview.js        视频阅读区：打点/片段/截帧/倍速/Blob 兜底（3.3.0）
├─ js/viewer.js           渲染、虚拟化、缩放、选区几何、缩略图、图片/链接命中、搜索标记层
├─ js/annotations.js      标注数据 → 覆盖层（高亮在下、锚点在上）
├─ js/exporter.js         区域截图、Markdown 导出
├─ js/translator.js       划词翻译（有道优先 → Google → MyMemory，含预翻译与缓存）
├─ js/editor.js           Markdown 编辑器组件（实时预览、附件、空内容置灰）
├─ js/workbench.js        工作台（时钟/每日笔记/最近阅读/年度热力图）+ 知识库 + 回收站
├─ js/app.js              应用逻辑与界面绑定
└─ vendor/
   ├─ pdfjs/              pdf.min.js、worker、cmaps、standard_fonts
   └─ pdflib/             pdf-lib.min.js（1.17.1，写回 PDF 用，3.3.0）
```

## 10. 已知限制

### 工作台没法变成 Eagle 界面上的实体按钮（已核实）

`app.asar`（109 MB）里逐个检索，**没有一个命中**：

| 关键字 | 命中数 |
| --- | --- |
| `manifest.sidebar` | 0 |
| `sidebarPlugins` | 0 |
| `plugin.sidebar` | 0 |
| `pluginModule.sidebar` | 0 |
| `plugin_toolbar` | 0 |

Eagle 的插件只有四种类型（来自语言包 `modal.createPlugin.type.*`）：
**格式扩展 / 检查器扩展 / 背景服务 / 窗口插件**——没有「侧边栏插件」「工具栏插件」。
`sidebar*` 系列标识符（`sidebarGroup` / `sidebarContainer` / `sidebarPanels` 等 2500+ 处）
全部是 Eagle 自己的资料库左侧栏实现，不对插件开放。

所以能做到的上限就是这三层入口（插件首屏 + 顶栏按钮 + **快捷键**）。
快捷键是 Eagle 官方给插件的唯一「一键唤出」能力：
**偏好设置 → 快捷键 → 插件**，或插件面板里右键本插件 → **设置快捷键**。

### 其它

- 只支持文字型 PDF 的文本层标注；扫描件（纯图片）只能用「框选」截图或点图摘录，无 OCR。
- 摘录与笔记不再生成 Eagle 图片条目，而是写进该 PDF 条目的 `annotation`（Markdown 纯文本）；
  Eagle 自己的「注释」面板显示的是纯文本，不会渲染 Markdown 语法。
- `annotation` 上限 10000 字符，笔记特别多时会截断（完整内容始终在结构化索引里）。
- **写回 PDF 是整篇重写**：文件会变大一点点（pdf-lib 重排对象），几十 MB 的 PDF 单次写入约几百毫秒；
  900ms 防抖 + 内容签名比对让连续操作只写一次。改了原文件后，**已经在别的阅读器里打开的那一份不会自动刷新**，要重新打开。
- **加密 PDF 不写**：只把高亮留在插件里，并弹提示说明；插件不会去猜密码，也不会破坏文件。
- 写回的是 `/Highlight` 注释（合规、跨阅读器），不是把色块画进内容流——所以「拍平」（flatten）成像素这种事不做，
  好处是随时可逆（删掉注释即恢复原样）。
- 原文件被占用/只读时写入会失败，此时高亮仍保留在插件里，toast 会给出原因，不静默丢数据。
- 视频笔记的时间轴依附于**同一个文件**：源视频被替换/剪辑后，`t` 会指向不准确的位置。
- 搜索只索引文本层，扫描件（无文字层）搜不到，与标注的限制一致。
- 高亮的最终长相由**阅读器**决定：我们给的是标准 `/Highlight` + 半透明 `/AP` + 淡色 `/C`，
  Acrobat / PDFium（Edge、Chrome）/ WPS / 预览理论上都该显示成半透明色带；
  若某个阅读器仍显示为实心，多半是它既忽略 `/AP` 又不认透明度，此时 `/C` 的淡色版至少保证文字不被盖住。
- 视频预览依赖 Eagle 的 `preview` 扩展机制：Eagle 先把该扩展名的默认预览替换成插件；
  如果 Eagle 版本不支持视频类的 preview 覆盖，就只能用 `P` 从插件窗口打开。
- 本地模型翻译需要用户自己装 Ollama 并 pull 模型；没装时会自动跳过这一路，不影响其它引擎。
- 附件只记地址、不复制文件：本地文件被移动/删除后，附件会变成失效引用。Eagle 条目按 id 解析，不受影响。
- 预览扩展（空格）与窗口插件是**两个独立 webview**，同时开着读同一篇时，
  各自的修改要重载窗口后才互相看到（有写盘，但没有跨窗口实时同步）。
- 拖入的资源库外文件若拿不到真实磁盘路径，只能只读浏览（无法落盘标注）。
- 划词翻译需要联网：国内网络下 Google 基本不可达、MyMemory 质量一般，**建议配一次有道密钥**（见 §6b）；
  都没配好时面板会明确报错并给出提示，不影响其它功能。

## 11. 后续可扩展方向

- **AI 摘要 / 问答**：`docs/<itemId>.json` 已经是「结构化摘录 + Markdown 笔记」，可直接做摘要、知识点抽取；
  视频笔记的 `t / t1` 也能一并喂进上下文（「这段 12 分钟里讲了什么」）
- 检查器插件：Eagle 右侧栏直接展示该 PDF / 视频的摘录时间线（比快捷键更「原生」的入口）
- 扫描件 OCR（接系统 OCR 或云端接口）——顺带能把扫描件也纳入搜索索引
- 写回 PDF 的注释加 `/IRT`（回复关系）与标签分类，这样在 Acrobat 的注释列表里也能按类型筛
- 摘录双向链接：摘录记录源条目 ID + 页码，知识库卡片互相引用
- 多文档标签页 / 分屏对照
- 预览与窗口插件之间的实时同步（`BroadcastChannel` 或文件监听）
- 翻译换自建/可控接口（当前公共接口稳定性一般）
