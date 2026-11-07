# 功能自查对照表（v4.5.1）

> 生成方式：`node verify-features.js`。每一项都对着**源码**找实现点，
> 再去 `test-*.js` 里找有没有对应断言。**这是静态核对，不是界面实测** ——
> 需要你真的点一下才能确认的，单独列在最后一节。

| 图例 | 含义 |
| --- | --- |
| ✅ | 实现点齐 + 有自动测试覆盖 |
| 🟡 | 实现点齐，但没有自动测试（多半是纯界面行为） |
| ❌ | 找不到实现点（要修） |

**合计 122 项：✅ 91 · 🟡 31 · ❌ 0**

## A. 打开与切换

| | 功能 | 实现位置 | 测试命中 |
| --- | --- | --- | --- |
| ✅ | 空格预览直接进插件 | `js/bridge.js` `js/app.js` | 3 处 |
| ✅ | 插件窗口载入当前选中项 | `js/bridge.js` `js/app.js` | 1 处 |
| ✅ | 启动器（LB7NOTEWB01）单图标进工作台 | `EagleNoteWorkbench/wb-launch.js` `EagleNoteWorkbench/manifest.json` | 48 处 |
| 🟡 | 从系统拖入 PDF（getPathForFile 兜底） | `js/app.js` | — |
| ✅ | 工作台 / 阅读界面互切 | `index.html` `js/app.js` | 46 处 |
| ✅ | 最近阅读 → 直接进那篇 | `js/store.js` `js/workbench.js` | 1 处 |

## B. 阅读

| | 功能 | 实现位置 | 测试命中 |
| --- | --- | --- | --- |
| 🟡 | 页码跳转 / 上一页下一页 | `js/app.js` | — |
| 🟡 | 缩放（加减 / 适宽 / Ctrl+滚轮） | `js/app.js` `js/viewer.js` | — |
| ✅ | 目录（PDF outline） | `js/pdfdoc.js` `js/app.js` | 75 处 |
| ✅ | 缩略图惰性渲染 | `js/app.js` | 13 处 |
| ✅ | 目录 / 缩略图弹出面板（v4.1，原左栏） | `js/app.js` `css/app.css` | 5 处 |
| ✅ | 全文搜索（常驻框 + 计数 + 弹出结果面板） | `js/search.js` `js/app.js` | 65 处 |
| 🟡 | 搜索临时标记不进 PDF | `css/app.css` `js/app.js` | — |
| 🟡 | 内部链接翻页 / 外部链接三选一 | `js/app.js` | — |
| ✅ | 明暗主题切换（记忆） | `js/store.js` `js/app.js` | 1 处 |

## C. 摘录与标注

| | 功能 | 实现位置 | 测试命中 |
| --- | --- | --- | --- |
| ✅ | 摘录文字（不弹笔记框） | `js/app.js` | 79 处 |
| 🟡 | 摘录并笔记（直接开大笔记框） | `js/app.js` | — |
| 🟡 | 复制（CJK 字间空格清洗） | `js/utils.js` | — |
| 🟡 | 划词翻译（就近弹层） | `js/app.js` `js/translator.js` | — |
| ✅ | 内嵌图片坐标命中（mousedown+mouseup） | `js/viewer.js` | 1 处 |
| ✅ | 图片摘录 → 收进右栏（不弹另存） | `js/app.js` | 5 处 |
| ✅ | PDF 框选 → 收进右栏 + 位置兜底 | `js/viewer.js` `js/app.js` | 6 处 |
| ✅ | 页面锚点（放下就开笔记框） | `js/app.js` | 2 处 |
| ✅ | 跨页选区拆成多条 | `js/viewer.js` `js/app.js` | 1 处 |
| ✅ | 五色色板 | `index.html` | 1 处 |
| ✅ | 双击编辑备注 / Ctrl+Enter 保存 | `js/annotations.js` `js/editor.js` | 44 处 |
| ✅ | 撤销（Ctrl+Z） | `js/undo.js` `js/app.js` | 21 处 |
| ✅ | 高亮写进 PDF 文件本身 | `js/pdfwrite.js` `js/app.js` | 3 处 |
| 🟡 | 同步到 Eagle 条目注释 | `js/app.js` `js/bridge.js` | — |

## D. 右栏

| | 功能 | 实现位置 | 测试命中 |
| --- | --- | --- | --- |
| ✅ | 摘录 / 笔记 / 知识库 三页签 | `index.html` `js/app.js` | 4 处 |
| ✅ | 回收站（可恢复 / 30 天） | `js/store.js` `js/app.js` | 4 处 |
| ✅ | 卡片「另存原图」（按字节复制） | `js/app.js` | 2 处 |
| 🟡 | 卡片 OCR | `js/app.js` | — |
| 🟡 | 卡片翻译 | `js/app.js` | — |
| ✅ | 卡片图片不可拖动 | `js/app.js` `css/app.css` | 4 处 |
| 🟡 | 卡片溯源：点卡片回到该页 | `js/app.js` | — |
| ✅ | 多选批量操作 | `js/multiselect.js` | 1 处 |

## E. 笔记

| | 功能 | 实现位置 | 测试命中 |
| --- | --- | --- | --- |
| ✅ | 大笔记框（Markdown 实时预览） | `js/editor.js` `js/markdown.js` | 12 处 |
| 🟡 | 笔记配图（拖入 / 粘贴） | `js/editor.js` | — |
| ✅ | Markdown 副本落到 _notes/ | `js/projection.js` | 46 处 |
| 🟡 | 笔记可导出 | `js/exporter.js` `js/app.js` | — |

## F. 视频

| | 功能 | 实现位置 | 测试命中 |
| --- | --- | --- | --- |
| ✅ | 播放器 + 进度 / 音量 / 倍速 | `js/videoview.js` `index.html` | 8 处 |
| ✅ | 六个标注键（截图 / 框选 / 片段 × 并笔记） | `index.html` | 3 处 |
| ✅ | 截图 / 框选按原分辨率取帧 | `js/videoview.js` `js/app.js` | 4 处 |
| ✅ | 片段录制（mp4 优先，退 webm） | `js/clipexport.js` `js/app.js` | 3 处 |
| ✅ | 实时字幕（本地识别 + 精修） | `js/subtitle.js` `js/asr.js` | 27 处 |
| ✅ | 字幕一键存为笔记 | `js/app.js` | 25 处 |
| ✅ | 标注暂停 / 自动续播 | `js/app.js` | 4 处 |
| 🟡 | 视频源多路兜底 | `js/videoview.js` | — |

## G. AI 能力

| | 功能 | 实现位置 | 测试命中 |
| --- | --- | --- | --- |
| 🟡 | 划词翻译双引擎 + 对冲调度 | `js/translator.js` | — |
| 🟡 | OCR（视觉模型 / 状态可见） | `js/app.js` | — |
| 🟡 | 术语表（提升识别与翻译一致性） | `js/translator.js` `js/subtitle.js` | — |
| ✅ | 专业领域词表（医学 / 生命科学） | `js/domainterms.js` `js/subtitle.js` | 3 处 |
| ✅ | AI 总结双通道（本地 Ollama / 自定义 OpenAI 兼容） | `js/aisummary.js` | 34 处 |
| ✅ | 双链笔记（[[书名]] 语法 + 出链索引 + 反链聚合 + 跳转） | `js/wikilink.js` `js/projection.js` `js/app.js` | 14 处 |
| ✅ | AI 回复 Markdown 渲染呈现（入库保存原始 md） | `js/aisummary.js` | 34 处 |
| ✅ | 自定义 OpenAI 兼容接口（默认预填智谱免费档） | `js/aisummary.js` | 27 处 |
| ✅ | 长文 map-reduce（超预算分页分段提炼再合并） | `js/aisummary.js` | 8 处 |
| ✅ | 总结 / 回答 / 摘句一键存入笔记 | `js/aisummary.js` `js/app.js` | 2 处 |
| ✅ | 本地模型（ollama）自动发现与预热 | `js/app.js` | 12 处 |
| 🟡 | 首次启动环境检查（缺什么说清楚） | `js/app.js` | — |

## H. 工作台

| | 功能 | 实现位置 | 测试命中 |
| --- | --- | --- | --- |
| ✅ | 资料库总览 + 时钟 | `js/workbench.js` | 53 处 |
| ✅ | 每日笔记（自动保存） | `js/workbench.js` `js/store.js` | 1 处 |
| ✅ | 知识库卡片墙（可打开 / 溯源） | `js/workbench.js` | 13 处 |
| ✅ | 「清除插件数据…」入口 | `index.html` `js/app.js` | 2 处 |
| ✅ | Eagle 注释巡检（全库扫标记注释、官方 API 清空、不依赖索引） | `index.html` `js/app.js` | 7 处 |
| ✅ | Ctrl+N 新建笔记（弹窗已开只聚焦不重置草稿） | `js/app.js` | 12 处 |

## J. 知识库同步

| | 功能 | 实现位置 | 测试命中 |
| --- | --- | --- | --- |
| ✅ | md 投影：锚点 + 手改回读 + 冲突备份 | `js/projection.js` | 72 处 |
| ✅ | 空内容不建 md，内容清空自动回收（手记保留） | `js/projection.js` | 8 处 |
| ✅ | 删光内容回收修复：插件旧注释值不挡回收（hash 比对），仅 md 独有文本保留 | `js/projection.js` | 3 处 |
| ✅ | Eagle 注释栏双向同步（eagle:ec 锚点 + 官方 API 写回） | `js/projection.js` | 2 处 |
| ✅ | OB 文件夹移动/改名自动认领（锚点优先，assets 引用按深度重写） | `js/projection.js` | 15 处 |
| ✅ | 写盘跟手：子文件夹 mkdir + manifest 存相对路径 | `js/projection.js` | 2 处 |
| ✅ | v4.4.2 Eagle 已删条目对账：孤儿识别 + 备份回收 + 墓碑防复活 | `js/projection.js` | 9 处 |
| ✅ | v4.4.2 删除对账自动/手动入口（全库 API 复核 + 工作台按钮） | `js/app.js` `index.html` | 3 处 |
| 🟡 | v4.5.0 OB 块锚点：每条摘录/笔记唯一稳定 ^eaglenote-*，[[书#^ID|显示名]] 精确落到那一条 | `js/projection.js` `js/wikilink.js` `js/editor.js` `js/app.js` | — |
| ✅ | v4.5.0 绝对同步：插件增/删/改即时投影，正文指纹判重不空转重写、不刷新 OB | `js/projection.js` | 3 处 |
| ✅ | v4.5.0 OB 手改只吸收不重写 + 3s 回读 + 启动全量对账 + 退出三处 flush | `js/projection.js` `js/app.js` | 20 处 |
| 🟡 | v4.5.0 OB 排版：折叠说明 / 编号标题 / 批注 callout / 正文标题转义 / 图片限宽 | `js/projection.js` | — |

## I. 窗口与退出

| | 功能 | 实现位置 | 测试命中 |
| --- | --- | --- | --- |
| ✅ | ESC 逐级退出（v4.4.0 起最后一级=关闭插件，决策点唯一） | `js/esc.js` `js/escguard.js` | 116 处 |
| ✅ | ESC 一律吞掉，不漏给 Eagle | `js/app.js` | 116 处 |
| ✅ | v4.4.7 退出走宿主 Exit 消息，零窗口 API（绝不销毁 Eagle 主窗口） | `js/bridge.js` `js/app.js` | 25 处 |
| ✅ | 关不掉时常驻横幅 + 再试/最小化 | `js/app.js` `css/app.css` | 3 处 |
| 🟡 | ESC 空栈走 exitPlugin() 关闭插件（escExitHint 已退役） | `js/app.js` | — |
| ✅ | v4.4.1 关窗身份守卫：绝不把 close/destroy 施加到 Eagle 主窗口 | `js/winguard.js` `js/bridge.js` `js/app.js` | 1 处 |
| ✅ | v4.4.1 宿主恢复兜底：只 restore/show，不 minimize/hide | `js/bridge.js` `js/app.js` | 12 处 |
| 🟡 | v4.4.3 两级许可：预览窗口 windowID≠parentID 时放行 window.close、仍封死 remote | `js/winguard.js` `js/app.js` | — |
| ✅ | v4.4.6 退出诊断：exit.env / exit.hostclose / exit.stillalive | `js/app.js` | 2 处 |
| ✅ | v4.4.6 关闭类 IPC 硬拦截 + 四条历史关窗通道退役 | `js/bridge.js` | 13 处 |
| 🟡 | v4.4.4 退出前摘掉 beforeunload，点击后 window.close 不再被拦 | `js/app.js` | — |
| 🟡 | v4.4.7 预览 ESC 单一出口：一条宿主 Exit + 600ms 串行补发 | `js/app.js` `js/winguard.js` | — |
| ✅ | v4.4.6 hostExit / setHostShortcuts 结果写 debug.log（v4.4.9 改用 log() 包装） | `js/bridge.js` | 18 处 |
| ✅ | v4.4.7 宿主 Exit 改走主窗口 executeJavaScript（guest 顶层文档 parent 不可达） | `js/bridge.js` | 9 处 |
| ✅ | v4.4.6 快捷键隔离：开插件即屏蔽 Eagle 菜单快捷键，退出/卸载即恢复 | `js/bridge.js` `js/app.js` | 25 处 |
| ✅ | v4.4.8 启动接管键盘焦点：主窗口对自己的 webview 调 focus()，5 次重试 + hasFocus 日志 | `js/bridge.js` `js/app.js` | 7 处 |
| ✅ | v4.4.8 宿主 ESC 转发桥：焦点在主窗口时 send 给 guest，不交还宿主、零窗口 API | `js/bridge.js` `js/app.js` | 5 处 |
| ✅ | v4.4.8 guest 接收器把转发 ESC 转合成 keydown，照旧走分级 + 落盘 + 宿主 Exit | `js/bridge.js` `js/app.js` | 2 处 |
| ✅ | v4.4.9 快捷键隔离回执：shortcuts.ok/err/retry + 失败补发 + shortcutsSettled 超时 | `js/bridge.js` | 4 处 |
| 🟡 | v4.4.9 启动 false→true 串行、退出先确认恢复再下线桥、最后才发 Exit | `js/app.js` | — |
| ✅ | v4.4.9 宿主看门狗：webview 消失由主窗口补发 false，三档 remove 防切条目误伤 | `js/bridge.js` | 12 处 |
| ✅ | Ctrl+W 关闭 | `js/app.js` | 14 处 |
| 🟡 | 预览模式紧凑布局（mode-preview） | `css/app.css` | — |
| ✅ | 窗口底色跟随主题（不闪白） | `js/bridge.js` | 1 处 |
| ✅ | 无边框窗口 + 自绘标题栏 | `js/framewin.js` `js/app.js` | 28 处 |

## J. 数据

| | 功能 | 实现位置 | 测试命中 |
| --- | --- | --- | --- |
| ✅ | 按 Eagle itemId 存，库改名不丢 | `js/store.js` | 28 处 |
| 🟡 | 每篇一份 docs/<id>.json | `js/store.js` | — |
| ✅ | 索引里只存图片路径（不存 base64） | `js/app.js` | 9 处 |
| ✅ | 回收站文件 trash.json | `js/store.js` | 9 处 |
| 🟡 | 换大版本自动清库（migrateEpoch） | `js/store.js` | — |
| ✅ | 写 PDF 前先备份（pdfbak） | `js/pdfwrite.js` `js/store.js` | 2 处 |
| ✅ | 清数据连素材副本一起清（media/） | `js/store.js` | 54 处 |
| ✅ | 运行日志 debug.log（200KB 轮转） | `js/dbg.js` | 29 处 |

## K. 稳定性

| | 功能 | 实现位置 | 测试命中 |
| --- | --- | --- | --- |
| 🟡 | 启动分步执行，失败只跳过那一步 | `js/app.js` | — |
| 🟡 | 全局错误 → 页头红条（不再静默） | `js/app.js` | — |
| ✅ | 图片缩略图内存缓存（blob URL） | `js/imgcache.js` | 24 处 |
| ✅ | 另存三态（选了 / 取消 / 弹不出来） | `js/saveas.js` | 12 处 |
| ✅ | 编辑器构造冒烟（防 TDZ 这类错） | `js/editor.js` | 2 处 |

## L. 性能与维护

| | 功能 | 实现位置 | 测试命中 |
| --- | --- | --- | --- |
| ✅ | v4.5.1 大块头 vendor 空闲加载（pdf-lib 525KB / pinyin-pro 326KB 移出首屏） | `js/vendorload.js` `js/app.js` | 15 处 |
| ✅ | v4.5.1 懒加载未就绪时降级、就绪后自动生效（拼音 / PDF 回写） | `js/editor.js` `js/pdfwrite.js` `js/app.js` | 9 处 |
| ✅ | v4.5.1 启动耗时埋点：boot.slow（≥60ms 的步骤）+ boot.done 汇总 | `js/app.js` | 1 处 |
| ✅ | v4.5.1 退出即停后台定时器（显存轮询 / 投影回读 / 删除对账） | `js/app.js` | 6 处 |
| ✅ | v4.5.1 安装包排除 README/FEATURES，部署脚本清理陈旧文件（保留 window-state.json） | `pack-plugin.py` `deploy-plugin.py` | 1 处 |

## 🟡 有实现、但没有自动测试的项

* 从系统拖入 PDF（getPathForFile 兜底）
* 页码跳转 / 上一页下一页
* 缩放（加减 / 适宽 / Ctrl+滚轮）
* 搜索临时标记不进 PDF
* 内部链接翻页 / 外部链接三选一
* 摘录并笔记（直接开大笔记框）
* 复制（CJK 字间空格清洗）
* 划词翻译（就近弹层）
* 同步到 Eagle 条目注释
* 卡片 OCR
* 卡片翻译
* 卡片溯源：点卡片回到该页
* 笔记配图（拖入 / 粘贴）
* 笔记可导出
* 视频源多路兜底
* 划词翻译双引擎 + 对冲调度
* OCR（视觉模型 / 状态可见）
* 术语表（提升识别与翻译一致性）
* 首次启动环境检查（缺什么说清楚）
* v4.5.0 OB 块锚点：每条摘录/笔记唯一稳定 ^eaglenote-*，[[书#^ID|显示名]] 精确落到那一条
* v4.5.0 OB 排版：折叠说明 / 编号标题 / 批注 callout / 正文标题转义 / 图片限宽
* ESC 空栈走 exitPlugin() 关闭插件（escExitHint 已退役）
* v4.4.3 两级许可：预览窗口 windowID≠parentID 时放行 window.close、仍封死 remote
* v4.4.4 退出前摘掉 beforeunload，点击后 window.close 不再被拦
* v4.4.7 预览 ESC 单一出口：一条宿主 Exit + 600ms 串行补发
* v4.4.9 启动 false→true 串行、退出先确认恢复再下线桥、最后才发 Exit
* 预览模式紧凑布局（mode-preview）
* 每篇一份 docs/<id>.json
* 换大版本自动清库（migrateEpoch）
* 启动分步执行，失败只跳过那一步
* 全局错误 → 页头红条（不再静默）

## 资源完整性

`index.html` 里引用的脚本与样式，逐个确认文件存在：

* ✅ 全部存在（含 `js/*.js`、`vendor/*`、`css/*`）
* ✅ `js/` 下每个文件都被页面引用，没有孤儿脚本

## 需要你点一下才能确认的（静态核对证明不了）

| # | 功能 | 怎么做 | 期望 |
| --- | --- | --- | --- |
| 1 | v4.5.0 OB 双链精确落点 | 重启 Eagle → 打开有多条摘录/笔记的文档 → 用 [[ 引用一条「摘录下的批注」→ 到 OB 里点这个链接 | OB 直接滚到那一条批注并高亮，不是只打开整篇 md；链接显示可读别名而不是 ^ID |
| 2 | v4.5.0 插件增删改 → OB 即时同步 | 插件里新建一条笔记 / 改一段批注 / 删一条摘录，各等 1 秒后切到 OB 看 | 对应块立刻出现 / 更新 / 消失，区块计数和 frontmatter 的 synced 同步变化 |
| 3 | v4.5.0 OB 手改不被打断 | 在 OB 里打开一篇 md，改一段批注文字并保持编辑 5 秒以上 | 文字不被插件重写冲掉；插件右栏随后显示改后的文字，debug.log 有 proj.absorb |
| 4 | AI 总结全文（本地） | 打开一篇 PDF → 点顶栏「AI 总结」→ 总结全文（本地模型） | 弹窗流式出总结；总结完可追问；悬停 AI 消息点「加入笔记」/ 选中文字点浮标，笔记列表出现对应条目 |
| 5 | AI 总结（自定义接口，可选） | ⚙ 填 baseURL + Key（推荐智谱 GLM-4-Flash 免费档）→ 切到自定义接口 → 总结 | 流式总结按 Markdown 渲染；失败自动兜底到本地模型且原因可见 |
| 6 | 知识库真的在资源管理器里 | 打开 E:\Notes Collection from Eagle | 每个资料库一个文件夹，每篇文档一份「书名.md」，assets 里有摘录图 |
| 7 | 空内容不建 md | 打开一个从没记过笔记的 PDF/视频再关闭 | E 盘不会多出空壳 md；产生第一条摘录/笔记/注释后才出现文件 |
| 8 | Eagle 注释双向同步 | 在 md 的「Eagle 注释」区块写一句话 → 保存 → 打开插件后看 Eagle 注释栏 | Eagle 注释栏出现同一句话；反过来在 Eagle 里改，下次同步 md 也变 |
| 9 | 手改 MD 能读回插件 | 在 VSCode 里改某条摘录下面的批注 → 保存 → 切回插件打开那篇 | 右栏那条批注变成你改的文字；两边都改过时，插件里旧值会存成 .conflict 文件 |
| 10 | 顶栏 ✕ 真的能关窗 | 打开工作台 → Esc 收起 → 点窗口右上角 ✕ | 窗口直接关掉（和 Ctrl+W 等价）；关不掉会出现常驻横幅，把横幅文字告诉我 |
| 11 | ESC 只往回收一层 | 有浮层 / 搜索有字 / 正在输入时按 Esc | 只关掉最上面那一层，窗口不关；要退出插件用 Ctrl+W |
| 12 | PDF 内嵌图片「摘录」 | 点页面里的图片 → 工具条点「摘录」 | 不弹另存为框；右栏摘录页多一张卡片，图能看到；提示「已收进右栏」 |
| 13 | PDF 框选 | 顶栏「框选」→ 拖一个矩形 | 不弹另存为框；右栏出卡片 + 笔记框（可直接写或 Esc 关掉） |
| 14 | 卡片「另存原图」 | 右栏图片卡片 →「另存原图」 | 这时才弹系统另存为；选好位置后文件在那里，像素与原图一致 |
| 15 | 视频截图 / 框选 | 视频右侧「截图」/「框选」 | 不弹另存为框；右栏出卡片；鼠标移开后底部那条白线没有了（还有的话截局部大图） |
| 16 | 视频片段 | 「节选片段」取 A → 再按取 B | 弹「片段另存为」；生成 mp4（或 webm），卡片显示「▶ 文件名 · 时长」 |
| 17 | 卡片图片不可拖 | 按住卡片里的图片往阅读区拖 | 拖不动，不出现「仅支持 PDF 文件」 |
| 18 | 划词经过行间 | 慢速拖过两行之间 | 不再整段闪一下；松开后只高亮真正划过的字 |
| 19 | 高亮写进 PDF | 摘录几段 → 用 Acrobat/浏览器打开同一个 PDF | 高亮在那里，颜色一致 |
| 20 | 清除插件数据 | 工作台底部「清除插件数据…」 | 确认框讲清楚删什么/不删什么；执行后重开是空库，识别模型还在 |
| 21 | 拖入 PDF | 从资源管理器拖一个 PDF 到界面 | 只读打开，可阅读可摘录 |

> 其中 1～3 是 v4.5.0 本轮改动（OB 绝对同步 / 精确双链 / 排版），优先验；4～10 是历史直接相关项。
