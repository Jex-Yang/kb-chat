/**
 * preview.js — 文件预览弹窗（知识库侧边栏与访达窗口共用）
 */
import { api } from './api.js';
import { fmtBytes } from './util.js';
import { openAttachmentPreview } from './attach-preview.js';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif']);

let currentFile = null;

export function openFilePreview(file) {
  if (file && IMAGE_EXTS.has(String(file.ext || '').toLowerCase())) {
    openAttachmentPreview({
      name: file.name, kind: 'image',
      preview: api.fileDownloadUrl(file.id),
    }, []);
    return;
  }
  currentFile = file;
  const mask = document.getElementById('preview-modal');
  document.getElementById('preview-title').textContent = file.name;
  const parts = [String(file.ext || '').toUpperCase()];
  if (file.size != null) parts.push(fmtBytes(file.size));
  if (file.chunkCount != null) parts.push(`${file.chunkCount} 个分块`);
  document.getElementById('preview-meta').textContent = parts.join(' · ');
  document.getElementById('preview-content').textContent = '加载中…';
  const dl = document.getElementById('btn-preview-download');
  if (dl) dl.hidden = false;
  mask.hidden = false;
  api.getFilePreview(file.id).then((res) => {
    document.getElementById('preview-content').textContent = res.content || '（空文件）';
  }).catch((e) => {
    document.getElementById('preview-content').textContent = '预览失败：' + e.message;
  });
}

export function downloadFile(file) {
  if (!file) return;
  const a = document.createElement('a');
  a.href = api.fileDownloadUrl(file.id);
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function initPreview() {
  const close = () => { document.getElementById('preview-modal').hidden = true; };
  document.getElementById('btn-preview-close').addEventListener('click', close);
  document.getElementById('preview-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });
  document.getElementById('btn-preview-download').addEventListener('click', () => {
    if (currentFile) downloadFile(currentFile);
  });
}
