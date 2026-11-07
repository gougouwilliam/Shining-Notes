# 闪灵笔记 · Eagle 阅读笔记插件

在 [Eagle](https://eagle.cool)（素材管理工具）内完成 PDF 的**阅览 → 摘录 → 笔记 → 回流资源库**闭环，外加跨文档「知识库」、统计「工作台」、30 天回收站、划词翻译与视频笔记。

**零外部依赖、离线可用**：PDF.js、pdf-lib、CJK 字符映射、标准字体全部随插件本地打包，除划词翻译（可接本地 Ollama）外不联网。

> 由两个 Eagle 插件组成，**版本号永远一致、需一起安装**：
> - `EaglePDFReader/` —— 主插件「闪灵笔记」（阅读 / 摘录 / 笔记 / 知识库 / 工作台）
> - `EagleNoteWorkbench/` —— 工作台面板插件「闪灵面板」

## 功能速览

- **PDF 阅读**：目录 / 缩略图 / 全文搜索 / 明暗主题，PDF.js 渲染
- **摘录**：划选文字或框选区域即摘录，高亮**写回 PDF 文件本身**（换阅读器也在）；摘录自动带出处，可一键回跳原文
- **笔记**：Markdown 编辑器（`[[` 双链、附件、贴图、视频嵌入），粘贴的截图转存进笔记库
- **知识库**：跨文档聚合全部笔记，三层搜索（资料内 → 全局 → Eagle 数据库）
- **随库迁移**：笔记数据存放在 Eagle 资料库内（`<库>/.eaglenote/`），整个库文件夹拷到另一台电脑，装好 Eagle + 插件即恢复全部数据
- **视频笔记**：视频文件帧级框选截图并写笔记
- **AI 加持**：本地 AI 摘要（Ollama）、本地语音转写（可选）
- **工作台**：写作时钟、每日笔记、统计面板

## 安装

1. 下载最新 Release 中的两个 `.eagleplugin` 文件（或本仓库 `EaglePDFReader/`、`EagleNoteWorkbench/` 两个目录）
2. Eagle → 顶栏「插件」→ 右上角 ⋯ →「导入插件」，两个文件分别导入
3. 任意 PDF 上打开插件面板即可使用

## 开发

```bash
# 跑全量回归（57 套件，按版本命名）
for f in test-*.js; do node $f; done

# 功能清单自检（✅/❌ 计数）
node verify-features.js

# 打包 .eagleplugin（自动同步双插件版本号）
python pack-plugin.py
```

测试套件按插件版本命名（`test-v4216.js` 对应 4.2.16），历史套件全部保留、全量可跑——改任何一行代码，57 个套件就是回归底线。

## 第三方组件

| 组件 | 用途 | 许可证 |
|------|------|--------|
| [PDF.js](https://github.com/mozilla/pdf.js) | PDF 渲染 | Apache-2.0 |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | 高亮写回 PDF | MIT |
| [pinyin-pro](https://github.com/zh-lx/pinyin-pro) | 拼音搜索 | MIT |

以上组件以源码/构建产物形式随插件分发于 `EaglePDFReader/vendor/`，各自许可证以其上游仓库为准（待核实处以官方 README 为准）。

## 许可证

本项目自身代码以 MIT 许可证发布，见 [LICENSE](LICENSE)。
