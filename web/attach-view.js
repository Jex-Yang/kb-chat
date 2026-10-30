/**
 * attach-view.js — 附件卡片的统一渲染（草稿条 / 用户消息内 / 历史消息）
 * 横向滑动 + 左右箭头 + 精确 token 数，不再用 ≈
 */
import { icon, fileIcon } from './icons.js';
import { fmtBytes, fmtTokens } from './util.js';

export function attachmentCard(att, opts = {}) {
  const { compact = false, removable = false, onRemove = null, onPreview = null } = opts;
  const el = document.createElement('div');
  const kind = att.kind === 'image' ? 'image' : 'text';
  el.className = 'attach-card' +
    (compact ? ' compact' : '') +
    (kind === 'image' ? ' image' : '') +
    (att.status === 'parsing' ? ' pending' : '') +
    (att.status === 'error' ? ' error' : '');
  el.setAttribute('role', 'listitem');
  el.title = onPreview ? `点击预览：${att.name || ''}` : (att.name || '');
  if (onPreview) {
    el.classList.add('previewable');
    el.tabIndex = 0;
    el.setAttribute('aria-label', `预览附件 ${att.name || ''}`);
    el.addEventListener('click', (e) => {
      if (e.target.closest('.attach-remove')) return;
      onPreview(att);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onPreview(att);
      }
    });
  }

  const thumb = att.thumb || (kind === 'image' ? att.dataUrl : null);
  if (kind === 'image' && thumb) {
    const img = document.createElement('img');
    img.className = 'attach-thumb';
    img.src = thumb;
    img.alt = att.name || '';
    el.appendChild(img);
  } else {
    const ico = document.createElement('span');
    ico.className = 'attach-ico' + (kind === 'image' ? ' image' : '');
    ico.innerHTML = fileIcon(att.ext || att.name, compact ? 15 : 17);
    el.appendChild(ico);
  }

  const info = document.createElement('span');
  info.className = 'attach-info';
  const name = document.createElement('span');
  name.className = 'attach-name';
  name.textContent = att.name || '未命名附件';
  const meta = document.createElement('span');
  meta.className = 'attach-meta';
  meta.textContent = attachmentMetaText(att);
  info.appendChild(name);
  info.appendChild(meta);
  el.appendChild(info);

  if (removable) {
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'attach-remove';
    rm.title = '移除附件';
    rm.setAttribute('aria-label', `移除附件 ${att.name || ''}`);
    rm.innerHTML = icon('close', 11);
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      if (onRemove) onRemove(att);
    });
    el.appendChild(rm);
  }
  return el;
}

export function attachmentMetaText(att) {
  if (att.status === 'parsing') return '解析中…';
  if (att.status === 'error') return att.error || '解析失败';
  const parts = [];
  const ext = String(att.ext || '').toUpperCase();
  if (ext) parts.push(ext);
  if (att.size) parts.push(fmtBytes(att.size));
  if (att.kind === 'image') {
    parts.push(att.tokens != null ? `~${fmtTokens(att.tokens)}` : '图片');
  } else if (att.tokens != null) {
    parts.push(fmtTokens(att.tokens));
  }
  return parts.join(' · ');
}

/**
 * 横向附件条：支持触控板横向滚动、滚轮横滚、鼠标拖拽、左右箭头。
 * 返回 { el, track }。
 */
export function attachmentRow(list, opts = {}) {
  const { compact = false, removable = false, onRemove = null, onPreview = null, className = '' } = opts;
  const row = document.createElement('div');
  row.className = 'attach-row' + (compact ? ' compact' : '') + (className ? ' ' + className : '');
  if (!list || !list.length) return { el: row, track: null };

  const left = document.createElement('button');
  left.type = 'button';
  left.className = 'attach-nav left';
  left.setAttribute('aria-label', '向左滚动附件');
  left.innerHTML = icon('chevronRight', 13);
  left.style.transform = 'scaleX(-1)';

  const right = document.createElement('button');
  right.type = 'button';
  right.className = 'attach-nav right';
  right.setAttribute('aria-label', '向右滚动附件');
  right.innerHTML = icon('chevronRight', 13);

  const track = document.createElement('div');
  track.className = 'attach-track';
  track.setAttribute('role', 'list');
  list.forEach((att) => track.appendChild(attachmentCard(att, {
    compact, removable, onRemove,
    onPreview: onPreview ? (a) => onPreview(a, list) : null,
  })));

  row.appendChild(left);
  row.appendChild(track);
  row.appendChild(right);

  const update = () => {
    const overflow = track.scrollWidth - track.clientWidth > 4;
    row.classList.toggle('overflow', overflow);
    const atStart = track.scrollLeft <= 2;
    const atEnd = track.scrollLeft + track.clientWidth >= track.scrollWidth - 2;
    row.classList.toggle('at-start', atStart);
    row.classList.toggle('at-end', atEnd);
  };

  const step = () => Math.max(180, Math.round(track.clientWidth * 0.8));
  left.addEventListener('click', () => track.scrollBy({ left: -step(), behavior: 'smooth' }));
  right.addEventListener('click', () => track.scrollBy({ left: step(), behavior: 'smooth' }));
  track.addEventListener('scroll', update, { passive: true });

  // 滚轮：优先横滚，不劫持纵向页面滚动之外的场景
  track.addEventListener('wheel', (e) => {
    if (track.scrollWidth <= track.clientWidth) return;
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!d) return;
    e.preventDefault();
    track.scrollLeft += d;
  }, { passive: false });

  // 鼠标拖拽横滑
  let down = false, startX = 0, startLeft = 0, moved = false, captured = false;
  track.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('button')) return;
    down = true; moved = false; captured = false;
    startX = e.clientX; startLeft = track.scrollLeft;
  });
  track.addEventListener('pointermove', (e) => {
    if (!down) return;
    const dx = e.clientX - startX;
    if (Math.abs(dx) > 3) {
      moved = true;
      if (!captured) {
        captured = true;
        track.classList.add('dragging');
        try { track.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      }
    }
    if (moved) track.scrollLeft = startLeft - dx;
  });
  const endDrag = (e) => {
    if (!down) return;
    down = false;
    track.classList.remove('dragging');
    if (captured) {
      try { track.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      captured = false;
    }
  };
  track.addEventListener('pointerup', endDrag);
  track.addEventListener('pointercancel', endDrag);
  track.addEventListener('click', (e) => {
    if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; }
  }, true);

  requestAnimationFrame(update);
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(update);
    ro.observe(track);
  }
  return { el: row, track };
}

/** 把历史消息里的附件元数据补齐成卡片需要的字段 */
export function normalizeAttachmentMeta(att) {
  if (!att || typeof att !== 'object') return null;
  return {
    name: att.name || '未命名附件',
    kind: att.kind === 'image' ? 'image' : 'text',
    ext: att.ext || '',
    size: Number(att.size) || 0,
    tokens: att.tokens == null ? null : Number(att.tokens),
    thumb: att.thumb || null,
    preview: att.preview || null,
    text: typeof att.text === 'string' ? att.text : null,
    status: 'ready',
  };
}
