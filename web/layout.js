/**
 * layout.js — 侧边栏宽度、知识库/对话分栏、收起展开、快捷键
 * 两个区块独立滚动：知识库默认 34%（可拖），对话占其余空间。
 */
import { state, LS_KEYS } from './state.js';
import { clamp } from './util.js';

const NARROW = '(max-width: 960px)';
const MIN_SIDEBAR = 260;
const MAX_SIDEBAR = 420;
const MIN_KB_RATIO = 0.18;
const MAX_KB_RATIO = 0.66;

function isNarrow() {
  return window.matchMedia(NARROW).matches;
}

function readNumber(key, fallback) {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

export function applySidebarWidth(width) {
  if (!Number.isFinite(width) || width <= 0) return;
  const w = clamp(width, MIN_SIDEBAR, MAX_SIDEBAR);
  document.documentElement.style.setProperty('--sidebar-w', `${Math.round(w)}px`);
}

export function applyKbRatio(ratio) {
  if (!Number.isFinite(ratio) || ratio <= 0) return;
  const r = clamp(ratio, MIN_KB_RATIO, MAX_KB_RATIO);
  document.documentElement.style.setProperty('--kb-h', `${(r * 100).toFixed(2)}%`);
}

export function resetLayout() {
  try {
    localStorage.removeItem(LS_KEYS.sidebarWidth);
    localStorage.removeItem(LS_KEYS.kbRatio);
    localStorage.removeItem(LS_KEYS.sidebarCollapsed);
  } catch { /* ignore */ }
  document.documentElement.style.removeProperty('--sidebar-w');
  document.documentElement.style.removeProperty('--kb-h');
  document.body.classList.remove('sidebar-collapsed', 'sidebar-open');
  state.sidebarOpen = true;
  document.getElementById('sidebar-mask').hidden = true;
  document.dispatchEvent(new CustomEvent('layout-change'));
}

/* ---------- 收起 / 展开 ---------- */
function syncSidebarState() {
  const mask = document.getElementById('sidebar-mask');
  if (isNarrow()) {
    const open = document.body.classList.contains('sidebar-open');
    state.sidebarOpen = open;
    if (mask) mask.hidden = !open;
  } else {
    const collapsed = document.body.classList.contains('sidebar-collapsed');
    state.sidebarOpen = !collapsed;
    if (mask) mask.hidden = true;
  }
}

export function toggleSidebar() {
  if (isNarrow()) {
    const open = document.body.classList.toggle('sidebar-open');
    state.sidebarOpen = open;
    const mask = document.getElementById('sidebar-mask');
    if (mask) mask.hidden = !open;
  } else {
    const collapsed = document.body.classList.toggle('sidebar-collapsed');
    state.sidebarOpen = !collapsed;
    try { localStorage.setItem(LS_KEYS.sidebarCollapsed, collapsed ? '1' : '0'); } catch { /* ignore */ }
  }
  syncSidebarState();
}

export function closeSidebarOverlay() {
  if (!isNarrow()) return;
  document.body.classList.remove('sidebar-open');
  state.sidebarOpen = false;
  const mask = document.getElementById('sidebar-mask');
  if (mask) mask.hidden = true;
}

/* ---------- 拖拽 ---------- */
function bindSidebarResizer() {
  const handle = document.getElementById('sidebar-resizer');
  if (!handle) return;
  let dragging = false;
  const onDown = (e) => {
    if (isNarrow()) return;
    dragging = true;
    handle.classList.add('dragging');
    document.body.classList.add('resizing');
    handle.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  const onMove = (e) => {
    if (!dragging) return;
    applySidebarWidth(e.clientX);
  };
  const onUp = (e) => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.classList.remove('resizing');
    try { handle.releasePointerCapture?.(e.pointerId); } catch { /* ignore */ }
    const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'), 10) ||
      document.getElementById('sidebar').getBoundingClientRect().width;
    try { localStorage.setItem(LS_KEYS.sidebarWidth, String(Math.round(w))); } catch { /* ignore */ }
  };
  handle.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  handle.addEventListener('dblclick', () => {
    document.documentElement.style.removeProperty('--sidebar-w');
    try { localStorage.removeItem(LS_KEYS.sidebarWidth); } catch { /* ignore */ }
  });
}

function bindKbSplitter() {
  const handle = document.getElementById('sb-splitter');
  const sidebar = document.getElementById('sidebar');
  if (!handle || !sidebar) return;
  let dragging = false;
  const onDown = (e) => {
    if (isNarrow()) return;
    dragging = true;
    handle.classList.add('dragging');
    document.body.classList.add('resizing');
    handle.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  const onMove = (e) => {
    if (!dragging) return;
    const rect = sidebar.getBoundingClientRect();
    if (rect.height <= 0) return;
    const ratio = clamp((e.clientY - rect.top) / rect.height, MIN_KB_RATIO, MAX_KB_RATIO);
    applyKbRatio(ratio);
  };
  const onUp = (e) => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.classList.remove('resizing');
    try { handle.releasePointerCapture?.(e.pointerId); } catch { /* ignore */ }
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--kb-h');
    const ratio = parseFloat(raw) / 100;
    if (Number.isFinite(ratio)) {
      try { localStorage.setItem(LS_KEYS.kbRatio, ratio.toFixed(4)); } catch { /* ignore */ }
    }
  };
  handle.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  handle.addEventListener('dblclick', () => {
    document.documentElement.style.removeProperty('--kb-h');
    try { localStorage.removeItem(LS_KEYS.kbRatio); } catch { /* ignore */ }
  });
}

/* ---------- 快捷键 ---------- */
function bindShortcuts() {
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const key = (e.key || '').toLowerCase();
    if (key === 'b') {
      e.preventDefault();
      toggleSidebar();
    } else if (key === 'k') {
      e.preventDefault();
      document.getElementById('btn-new-conv')?.click();
    }
  });
}

/* ---------- 初始化 ---------- */
export function initLayout() {
  // 读取持久化布局
  const savedWidth = readNumber(LS_KEYS.sidebarWidth, 0);
  if (savedWidth) applySidebarWidth(savedWidth);
  const savedRatio = readNumber(LS_KEYS.kbRatio, 0);
  if (savedRatio) applyKbRatio(savedRatio);

  document.getElementById('btn-hamburger').addEventListener('click', toggleSidebar);
  document.getElementById('btn-collapse-sidebar').addEventListener('click', toggleSidebar);
  document.getElementById('sidebar-mask').addEventListener('click', closeSidebarOverlay);

  if (!isNarrow()) {
    let collapsed = false;
    try { collapsed = localStorage.getItem(LS_KEYS.sidebarCollapsed) === '1'; } catch { /* ignore */ }
    if (collapsed) document.body.classList.add('sidebar-collapsed');
  }
  syncSidebarState();

  bindSidebarResizer();
  bindKbSplitter();
  bindShortcuts();

  const mq = window.matchMedia(NARROW);
  const onChange = () => {
    document.body.classList.remove('sidebar-open', 'sidebar-collapsed');
    if (isNarrow()) {
      const mask = document.getElementById('sidebar-mask');
      if (mask) mask.hidden = true;
      state.sidebarOpen = false;
    } else {
      let collapsed = false;
      try { collapsed = localStorage.getItem(LS_KEYS.sidebarCollapsed) === '1'; } catch { /* ignore */ }
      if (collapsed) document.body.classList.add('sidebar-collapsed');
      state.sidebarOpen = !collapsed;
    }
  };
  if (mq.addEventListener) mq.addEventListener('change', onChange);

  document.addEventListener('layout-change', syncSidebarState);
}
