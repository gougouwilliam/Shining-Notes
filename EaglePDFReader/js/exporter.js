/* 导出层：把一篇文档的摘录与笔记拼成 Markdown 文本（复制到剪贴板 / 存 .md 用）。
 *
 * 这里原本还有「摘录卡片合成」与「笔记长图」两套 canvas 排布（composeExcerptCard /
 * composeNoteCard），那是 3.3 之前「存入 Eagle 为图片」时代的产物。3.3 改成
 * 即写即存、只留 Markdown 之后，这两个函数再没人调用，依赖的 FONT_STACK / BRAND /
 * wrapLines / contextRect / clampRect 也跟着变成死代码 —— 一并删掉。
 * 区域截图另有实现（app.js 的 captureRegion），不在这里。 */
const Exporter = (function () {
  /* Markdown 文本 */
  function buildMarkdown(meta, data) {
    const name = U.stripExt(meta.name || data.fileName || '未命名');
    const anns = (data.annotations || []).slice().sort((a, b) => (a.page - b.page) || (a.createdAt - b.createdAt));
    const notes = (Array.isArray(data.notes) ? data.notes : []).slice()
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const lines = [];
    lines.push(`# 《${name}》工作笔记`);
    lines.push('');
    lines.push(`- 导出时间：${new Date().toLocaleString('zh-CN')}`);
    lines.push(`- 摘录数量：${anns.length}`);
    lines.push(`- 笔记数量：${notes.length}`);
    if (meta.filePath) lines.push(`- 文件位置：\`${meta.filePath}\``);
    lines.push('');

    lines.push('## 摘录');
    lines.push('');
    if (!anns.length) {
      lines.push('_（暂无摘录）_');
      lines.push('');
    }
    let lastPage = null;
    for (const a of anns) {
      if (a.page !== lastPage) {
        lines.push(`### 第 ${a.page} 页`);
        lines.push('');
        lastPage = a.page;
      }
      if (a.type === 'highlight' && a.text) {
        lines.push(`> ${a.text.split('\n').join('\n> ')}`);
        lines.push('');
      } else if (a.type === 'area') {
        lines.push(`- **[框选图片]** ${a.text ? a.text : '（已保存为图片，可在 Eagle 中查看）'}`);
        lines.push('');
      }
      if (a.note) {
        const label = a.type === 'note' ? '页面批注' : (a.type === 'area' ? '区域笔记' : '摘录笔记');
        lines.push(`**${label}**：${a.note.split('\n').join(' ')}`);
        lines.push('');
      }
    }

    lines.push('## 笔记');
    lines.push('');
    if (!notes.length) {
      lines.push('_（暂无笔记）_');
      lines.push('');
    }
    for (const n of notes) {
      const head = [n.page ? `第 ${n.page} 页` : '独立笔记', n.quote ? '摘录笔记' : ''].filter(Boolean).join(' · ');
      lines.push(`### ${head || '笔记'}`);
      lines.push('');
      if (n.quote) {
        lines.push(`> ${n.quote.split('\n').join('\n> ')}`);
        lines.push('');
      }
      lines.push(n.md || '');
      lines.push('');
    }
    return lines.join('\n');
  }

  return { buildMarkdown };
})();
