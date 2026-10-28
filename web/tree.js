/**
 * tree.js — 知识库数据加载 + 侧边栏入口。
 * 文件/目录管理在访达窗口（finder.js）；侧边栏只保留入口和文件统计。
 */
import { state } from './state.js';
import { api } from './api.js';
import { icon } from './icons.js';
import { fmtBytes, toast } from './util.js';
import { openFinder } from './finder.js';

function renderNavStats() {
  const files = state.tree.files || [];
  const folders = state.tree.folders || [];
  const navCount = document.getElementById('kb-nav-count');
  if (!navCount) return;
  if (!files.length) {
    navCount.textContent = '';
    navCount.title = '知识库还没有文件';
    return;
  }
  const totalBytes = files.reduce((sum, f) => sum + (Number(f.size) || 0), 0);
  navCount.textContent = `${files.length} 个文件`;
  navCount.title = `${files.length} 个文件 · ${folders.length} 个目录 · ${fmtBytes(totalBytes)}`;
}

export function renderTree() {
  renderNavStats();
}

export async function loadTree({ silent = false } = {}) {
  try {
    const data = await api.getTree();
    state.tree = {
      folders: Array.isArray(data.folders) ? data.folders : [],
      files: Array.isArray(data.files) ? data.files : [],
    };
    state.treeReady = true;
    renderTree();
    document.dispatchEvent(new CustomEvent('kb-tree-loaded'));
    return state.tree;
  } catch (e) {
    if (!silent) toast('知识库加载失败：' + e.message, 'error');
    return null;
  }
}

export function initTree() {
  const navIco = document.getElementById('kb-nav-ico');
  if (navIco) navIco.innerHTML = icon('book', 15);
  document.getElementById('btn-open-kb')?.addEventListener('click', () => {
    if (window.matchMedia('(max-width: 960px)').matches) {
      document.body.classList.remove('sidebar-open');
      const mask = document.getElementById('sidebar-mask');
      if (mask) mask.hidden = true;
    }
    openFinder();
  });
  document.addEventListener('kb-refresh', () => loadTree({ silent: true }));
  document.addEventListener('kb-data-changed', () => renderTree());
}
