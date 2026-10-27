/**
 * dataio.js — 知识库导入/导出 + 当前对话导出 Markdown
 */
import { state } from './state.js';
import { api } from './api.js';
import { toast } from './util.js';
import { refreshKb } from './finder.js';
import { loadConversations } from './conversations.js';
import { refreshUsage } from './topbar.js';
import { exportAllConversations } from './export-text.js';

function downloadHref(href) {
  const a = document.createElement('a');
  a.href = href;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function doKbExport() {
  downloadHref(api.exportUrl);
  toast('知识库导出已开始下载', 'success');
}

async function doKbImport(file) {
  try {
    const res = await api.importFile(file);
    toast(`导入完成：目录 ${res.folders ?? 0}、文件 ${res.files ?? 0}、对话 ${res.conversations ?? 0}`,
      'success', 3200);
    await Promise.all([refreshKb(), loadConversations(), refreshUsage(state.currentConvId)]);
  } catch (e) {
    toast('导入失败：' + e.message, 'error');
  }
}

async function doExportAllConversations() {
  try {
    const count = await exportAllConversations();
    toast(`已导出 ${count} 个对话（TXT）`, 'success', 3000);
  } catch (e) {
    toast('导出失败：' + e.message, 'error');
  }
}

export function initDataio() {
  document.getElementById('file-import-input').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    await doKbImport(file);
  });
  document.getElementById('btn-export-conv').addEventListener('click', doExportAllConversations);

  document.addEventListener('kb-export', doKbExport);
  document.addEventListener('kb-import', () => document.getElementById('file-import-input').click());
}
