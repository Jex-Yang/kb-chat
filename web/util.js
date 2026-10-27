/**
 * util.js — 公共工具：转义 / 数字与时间格式 / Markdown / toast / 确认框 / 输入框 / 菜单
 */
import { icon } from './icons.js';

/* ---------- 字符串 ---------- */
export function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
export const escAttr = escHtml;

export function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ---------- 数字 ---------- */
export function fmtInt(n) {
  if (n == null || n === '' || !Number.isFinite(Number(n))) return '—';
  return Number(n).toLocaleString('en-US');
}

export function fmtTokens(n) {
  if (n == null || n === '') return '—';
  return `${fmtInt(n)} tokens`;
}

export function fmtBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(2)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function fmtPct(ratio) {
  const n = Number(ratio);
  if (!Number.isFinite(n) || n <= 0) return '0%';
  const p = n * 100;
  if (p < 0.01) return '<0.01%';
  return `${p.toFixed(2)}%`;
}

export function fmtDuration(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n < 1000) return `${Math.round(n)} ms`;
  const sec = n / 1000;
  if (sec < 60) return `${sec.toFixed(1)} 秒`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m} 分 ${s} 秒`;
}

export function fmtSeconds(ms) {
  return Math.max(0, Math.round((Number(ms) || 0) / 1000));
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/* ---------- 时间 ---------- */
function pad(n) { return n < 10 ? '0' + n : '' + n; }

export function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const sameDay = sameYear && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return pad(d.getHours()) + ':' + pad(d.getMinutes());
  const md = pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  return sameYear ? md + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
                  : d.getFullYear() + '-' + md;
}

export const fmtTime = formatTime;

export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
  if (sameDay) return '今天 ' + hm;
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${hm}`;
}

export function fmtTps(tps) {
  const n = Number(tps);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 100) return String(Math.round(n));
  if (n >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

export function dayGroup(iso) {
  if (!iso) return '更早';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '更早';
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = d.getTime();
  if (t >= startToday) return '今天';
  if (t >= startToday - 86400000) return '昨天';
  if (t >= startToday - 86400000 * 7) return '本周';
  return '更早';
}

/* ---------- Markdown ---------- */
export function mdRender(text) {
  const raw = String(text ?? '');
  if (typeof window !== 'undefined' && window.marked && typeof window.marked.parse === 'function') {
    return window.marked.parse(escHtml(raw), { breaks: true, gfm: true, async: false });
  }
  return miniMarkdown(raw);
}

function miniMarkdown(src) {
  const lines = escHtml(src).split(/\r?\n/);
  let html = '', inCode = false, listType = null, inPara = false;
  const closeList = () => { if (listType) { html += '</' + listType + '>'; listType = null; } };
  const closePara = () => { if (inPara) { html += '</p>'; inPara = false; } };
  const inline = (s) => s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  for (const line of lines) {
    if (/^```/.test(line)) {
      closePara(); closeList();
      html += inCode ? '</code></pre>' : '<pre><code>';
      inCode = !inCode; continue;
    }
    if (inCode) { html += line + '\n'; continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closePara(); closeList(); const l = h[1].length; html += `<h${l}>${inline(h[2])}</h${l}>`; continue; }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ul || ol) {
      closePara();
      const t = ul ? 'ul' : 'ol';
      if (listType !== t) { closeList(); html += '<' + t + '>'; listType = t; }
      html += '<li>' + inline((ul || ol)[1]) + '</li>'; continue;
    }
    if (!line.trim()) { closePara(); closeList(); continue; }
    closeList();
    if (!inPara) { html += '<p>'; inPara = true; } else { html += '<br>'; }
    html += inline(line);
  }
  closePara(); closeList();
  if (inCode) html += '</code></pre>';
  return html;
}

/* ---------- 节流 / 防抖 ---------- */
export function throttle(fn, ms) {
  let last = 0, timer = null;
  return function (...args) {
    const now = Date.now();
    const run = () => { last = now; timer = null; fn.apply(this, args); };
    if (now - last >= ms) run();
    else if (!timer) timer = setTimeout(run, ms - (now - last));
  };
}

export function debounce(fn, ms) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

/* ---------- Toast ---------- */
export function toast(msg, type = 'info', duration = 2400) {
  const box = document.getElementById('toast-container');
  if (!box) return;
  while (box.children.length >= 4) box.firstElementChild.remove();
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' error' : type === 'success' ? ' success' : '');
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 180);
  }, type === 'error' ? Math.max(duration, 3600) : duration);
}

/* ---------- 确认框 ---------- */
export function confirmDialog(text, opts = {}) {
  const mask = document.getElementById('confirm-modal');
  const txt = document.getElementById('confirm-text');
  const title = document.getElementById('confirm-title');
  const ok = document.getElementById('btn-confirm-ok');
  const cancel = document.getElementById('btn-confirm-cancel');
  return new Promise((resolve) => {
    txt.textContent = text;
    if (title) title.textContent = opts.title || '请确认';
    ok.textContent = opts.okText || '删除';
    ok.classList.toggle('btn-danger', opts.danger !== false);
    ok.classList.toggle('btn-primary', opts.danger === false);
    mask.hidden = false;
    const done = (v) => { mask.hidden = true; cleanup(); resolve(v); };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onMask = (e) => { if (e.target === mask) done(false); };
    const onKey = (e) => { if (e.key === 'Escape') done(false); };
    function cleanup() {
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      mask.removeEventListener('click', onMask);
      document.removeEventListener('keydown', onKey);
    }
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    mask.addEventListener('click', onMask);
    document.addEventListener('keydown', onKey);
  });
}

/* ---------- 文本输入框（替代 window.prompt） ---------- */
export function promptDialog(opts = {}) {
  const mask = document.getElementById('prompt-modal');
  const title = document.getElementById('prompt-title');
  const label = document.getElementById('prompt-label');
  const input = document.getElementById('prompt-input');
  const ok = document.getElementById('btn-prompt-ok');
  const cancel = document.getElementById('btn-prompt-cancel');
  return new Promise((resolve) => {
    title.textContent = opts.title || '输入';
    label.textContent = opts.label || '';
    label.hidden = !opts.label;
    input.value = opts.value || '';
    input.placeholder = opts.placeholder || '';
    ok.textContent = opts.okText || '确定';
    mask.hidden = false;
    input.focus();
    input.select();
    const done = (v) => { mask.hidden = true; cleanup(); resolve(v); };
    const submit = () => done(input.value);
    const onCancel = () => done(null);
    const onMask = (e) => { if (e.target === mask) done(null); };
    const onKey = (e) => {
      if (e.key === 'Escape') done(null);
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); }
    };
    function cleanup() {
      ok.removeEventListener('click', submit);
      cancel.removeEventListener('click', onCancel);
      mask.removeEventListener('click', onMask);
      document.removeEventListener('keydown', onKey);
    }
    ok.addEventListener('click', submit);
    cancel.addEventListener('click', onCancel);
    mask.addEventListener('click', onMask);
    document.addEventListener('keydown', onKey);
  });
}

/* ---------- 浮动菜单 ---------- */
let menuEl = null;
let menuCleanup = null;

export function closeMenu() {
  if (menuCleanup) menuCleanup();
  if (menuEl) menuEl.remove();
  menuEl = null;
  menuCleanup = null;
}

export function openMenu(anchor, items, opts = {}) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.setAttribute('role', 'menu');
  items.forEach((item) => {
    if (item.sep) {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      menu.appendChild(sep);
      return;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ctx-item' + (item.danger ? ' danger' : '');
    btn.setAttribute('role', 'menuitem');
    if (item.disabled) btn.disabled = true;
    btn.innerHTML = `<span class="ctx-ico">${item.icon ? icon(item.icon, 14) : ''}</span>` +
      `<span class="ctx-label"></span>` +
      (item.hint ? `<span class="ctx-hint"></span>` : '');
    btn.querySelector('.ctx-label').textContent = item.label;
    if (item.hint) btn.querySelector('.ctx-hint').textContent = item.hint;
    btn.addEventListener('click', () => {
      closeMenu();
      if (!item.disabled && item.onSelect) item.onSelect();
    });
    menu.appendChild(btn);
  });
  document.body.appendChild(menu);
  menuEl = menu;

  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth || 180;
  const mh = menu.offsetHeight || 120;
  let left = opts.alignRight ? r.right - mw : r.left;
  left = clamp(left, 8, window.innerWidth - mw - 8);
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  requestAnimationFrame(() => menu.classList.add('show'));

  const onDoc = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) closeMenu(); };
  const onKey = (e) => { if (e.key === 'Escape') closeMenu(); };
  const onScroll = () => closeMenu();
  setTimeout(() => {
    document.addEventListener('pointerdown', onDoc, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
  }, 0);
  menuCleanup = () => {
    document.removeEventListener('pointerdown', onDoc, true);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('scroll', onScroll, true);
  };
  return menu;
}

/* ---------- 剪贴板 ---------- */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      return true;
    } catch {
      return false;
    }
  }
}

/* ---------- 滚动 ---------- */
export function isNearBottom(el, threshold = 120) {
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

export function scrollToBottom(el, smooth = false) {
  if (!el) return;
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

/* ---------- 其他 ---------- */
export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

export function extOf(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  return i >= 0 ? s.slice(i + 1).toLowerCase() : '';
}

export const TEXT_EXTS = ['txt', 'md', 'csv', 'pdf', 'docx', 'xlsx'];
export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];

export function isTextFile(name) {
  return TEXT_EXTS.includes(extOf(name));
}

export function isImageFile(file) {
  return (file && file.type && file.type.startsWith('image/')) ||
    IMAGE_EXTS.includes(extOf(file && file.name));
}

/** 把图片压成小缩略图，供历史卡片与草稿卡片展示 */
function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('图片解码失败'));
    im.src = dataUrl;
  });
}

function drawVariant(img, maxSize, quality) {
  const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', quality);
}

/** 一次解码同时生成 240px 卡片缩略图和 1400px 历史预览图，避免重复读图/解码。 */
export async function makeImageVariants(dataUrl) {
  const img = await loadImage(dataUrl);
  return {
    thumb: drawVariant(img, 240, 0.72),
    preview: drawVariant(img, 1400, 0.8),
  };
}
