/**
 * attach-preview.js — 聊天附件快速预览：图片灯箱 / 文本文件预览。
 * 草稿条、已发送消息、编辑消息共用。
 */
import { icon } from './icons.js';
import { fmtBytes, fmtTokens } from './util.js';

let images = [];
let imageIndex = 0;
let bound = false;

function $(id) { return document.getElementById(id); }

function extractTextFromMessage(message, name) {
  const content = String(message?.content || '');
  const re = /【附件：([^】\n]+)】\n```\n([\s\S]*?)\n```/g;
  let m;
  while ((m = re.exec(content))) {
    if (m[1] === name) return m[2];
  }
  return '';
}

function textForAttachment(att, message) {
  if (typeof att.text === 'string' && att.text) return att.text;
  if (message) {
    const found = extractTextFromMessage(message, att.name);
    if (found) return found;
  }
  return '';
}

function srcOf(att) {
  return att.preview || att.dataUrl || att.thumb || '';
}

function renderImage() {
  const att = images[imageIndex];
  if (!att) return;
  const src = srcOf(att);
  const img = $('lb-img');
  img.src = src;
  img.alt = att.name || '';
  $('lb-name').textContent = att.name || '图片';
  const isThumbOnly = !att.preview && !att.dataUrl;
  $('lb-index').textContent = `${imageIndex + 1} / ${images.length}${isThumbOnly ? ' · 缩略图' : ''}`;
  $('lb-prev').disabled = imageIndex <= 0;
  $('lb-next').disabled = imageIndex >= images.length - 1;
}

function closeLightbox() {
  $('image-lightbox').hidden = true;
  $('lb-img').removeAttribute('src');
}

function openImageLightbox(list, start = 0) {
  images = (list || []).filter((a) => a && a.kind === 'image' && srcOf(a));
  if (!images.length) return;
  imageIndex = Math.max(0, Math.min(start, images.length - 1));
  renderImage();
  $('image-lightbox').hidden = false;
  $('lb-close').focus();
}

function openTextPreview(att, message) {
  const text = textForAttachment(att, message);
  $('preview-title').textContent = att.name || '附件预览';
  const meta = [];
  if (att.ext) meta.push(String(att.ext).toUpperCase());
  if (att.size) meta.push(fmtBytes(att.size));
  if (att.tokens != null) meta.push(fmtTokens(att.tokens));
  meta.push('文本附件');
  $('preview-meta').textContent = meta.join(' · ');
  $('preview-content').textContent = text || '（该附件只保存了卡片元数据，没有可预览的文本内容）';
  const dl = $('btn-preview-download');
  if (dl) dl.hidden = true;
  $('preview-modal').hidden = false;
}

export function openAttachmentPreview(att, list = [], message = null) {
  if (!att) return;
  if (att.kind === 'image') {
    const all = (list || []).filter((a) => a && a.kind === 'image');
    const idx = Math.max(0, all.indexOf(att));
    openImageLightbox(all, idx);
    return;
  }
  openTextPreview(att, message);
}

export function initAttachmentPreview() {
  if (bound) return;
  bound = true;
  $('lb-close').innerHTML = icon('close', 16);
  $('lb-prev').innerHTML = icon('chevronLeft', 16);
  $('lb-next').innerHTML = icon('chevronRight', 16);

  $('lb-close').addEventListener('click', closeLightbox);
  $('lb-prev').addEventListener('click', () => {
    if (imageIndex > 0) { imageIndex--; renderImage(); }
  });
  $('lb-next').addEventListener('click', () => {
    if (imageIndex < images.length - 1) { imageIndex++; renderImage(); }
  });
  $('image-lightbox').addEventListener('click', (e) => {
    if (e.target === $('image-lightbox')) closeLightbox();
  });
  document.addEventListener('keydown', (e) => {
    if ($('image-lightbox').hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); closeLightbox(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); $('lb-prev').click(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); $('lb-next').click(); }
  });
}
