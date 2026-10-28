/**
 * dataio.js — 下载对话（当前 / 全部，纯 TXT）
 */
import { state } from './state.js';
import { toast, openMenu } from './util.js';
import { icon } from './icons.js';
import { exportAllConversations, exportSingleConversation } from './export-text.js';

async function doExportAllConversations() {
  try {
    const count = await exportAllConversations();
    toast(`已下载 ${count} 个对话（TXT）`, 'success', 3000);
  } catch (e) {
    toast('下载失败：' + e.message, 'error');
  }
}

async function doExportCurrentConversation() {
  if (!state.currentConvId) { toast('请先打开一个对话', 'info'); return; }
  try {
    await exportSingleConversation(state.currentConvId);
    toast('已下载当前对话（TXT）', 'success');
  } catch (e) {
    toast('下载失败：' + e.message, 'error');
  }
}

export function initDataio() {
  const ico = document.getElementById('ico-download-conv');
  if (ico) ico.innerHTML = icon('download', 14);
  const btn = document.getElementById('btn-download-conv');
  btn?.addEventListener('click', (e) => {
    e.stopPropagation();
    openMenu(btn, [
      {
        label: '下载当前对话（TXT）',
        icon: 'download',
        disabled: !state.currentConvId,
        onSelect: doExportCurrentConversation,
      },
      { label: '下载全部对话（TXT）', icon: 'download', onSelect: doExportAllConversations },
    ], { alignRight: true });
  });
}
