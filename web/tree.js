/**
 * tree.js — 侧边栏知识库树（30% 区域）
 * 与访达窗口（finder.js）共用同一份 state.tree，二者互相刷新。
 */
import { state, LS_KEYS } from './state.js';
import { api } from './api.js';
import { icon, fileIcon } from './icons.js';
import {
  fmtBytes, toast, confirmDialog, promptDialog, openMenu,
} from './util.js';
import { openFinder } from './finder.js';
import { openFilePreview, downloadFile } from './preview.js';

let selectedFolderId = null;

function folderById(id) {
  return (state.tree.folders || []).find((f) => Number(f.id) === Number(id)) || null;
}

function childFolders(parentId) {
  const pid = parentId == null ? null : Number(parentId);
  return (state.tree.folders || []).filter(
    (f) => (f.parentId == null ? null : Number(f.parentId)) === pid);
}

function folderPath(id) {
  const byId = new Map((state.tree.folders || []).map((f) => [Number(f.id), f]));
  const out = [];
  let cur = id == null ? null : byId.get(Number(id));
  let guard = 0;
  while (cur && guard < 30) {
    out.unshift(cur);
    cur = cur.parentId == null ? null : byId.get(Number(cur.parentId));
    guard++;
  }
  return out;
}

function loadExpanded() {
  if (state.expandedFoldersLoaded) return;
  state.expandedFoldersLoaded = true;
  try {
    const raw = localStorage.getItem(LS_KEYS.expanded);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        state.expandedFolders = new Set(arr.map(Number));
        return;
      }
    }
  } catch { /* ignore */ }
  childFolders(null).forEach((f) => state.expandedFolders.add(Number(f.id)));
}

function saveExpanded() {
  try {
    localStorage.setItem(LS_KEYS.expanded, JSON.stringify([...state.expandedFolders]));
  } catch { /* ignore */ }
}

/* ---------- 渲染 ---------- */
export function renderTree() {
  const tree = document.getElementById('tree');
  const empty = document.getElementById('tree-empty');
  if (!tree) return;
  loadExpanded();
  tree.innerHTML = '';
  const folders = state.tree.folders || [];
  const files = state.tree.files || [];
  const hasAny = folders.length > 0 || files.length > 0;
  if (empty) empty.hidden = hasAny;

  if (selectedFolderId != null && !folderById(selectedFolderId)) selectedFolderId = null;

  const filesOf = new Map();
  files.forEach((f) => {
    const key = f.folderId == null ? 'root' : Number(f.folderId);
    if (!filesOf.has(key)) filesOf.set(key, []);
    filesOf.get(key).push(f);
  });

  const frag = document.createDocumentFragment();
  const walk = (parentId, depth) => {
    childFolders(parentId).forEach((folder) => {
      const id = Number(folder.id);
      const open = state.expandedFolders.has(id);
      frag.appendChild(folderRow(folder, depth, open));
      if (open) walk(id, depth + 1);
    });
    (filesOf.get(parentId == null ? 'root' : Number(parentId)) || []).forEach((file) => {
      frag.appendChild(fileRow(file, depth));
    });
  };
  walk(null, 0);
  tree.appendChild(frag);
  renderStats(files, folders);
  updateLocation();
}

function folderRow(folder, depth, open) {
  const row = document.createElement('div');
  row.className = 'tree-row folder' + (open ? ' open' : '') +
    (Number(folder.id) === selectedFolderId ? ' selected' : '');
  row.style.setProperty('--depth', depth);
  row.dataset.folderId = folder.id;
  row.dataset.kind = 'folder';
  row.setAttribute('role', 'treeitem');
  row.setAttribute('aria-expanded', String(open));
  row.title = `${folder.name}（双击在访达中打开）`;
  row.innerHTML =
    `<span class="tree-twisty">${icon('chevronRight', 10)}</span>` +
    `<span class="tree-ico">${icon('folder', 14)}</span>` +
    `<span class="tree-name"></span>` +
    `<span class="tree-acts">` +
    `<button type="button" class="tree-act" data-act="finder" title="在访达中打开">${icon('expand', 12)}</button>` +
    `<button type="button" class="tree-act" data-act="more" title="更多">${icon('more', 12)}</button>` +
    `</span>`;
  row.querySelector('.tree-name').textContent = folder.name;

  row.addEventListener('click', (e) => {
    if (e.target.closest('.tree-act')) return;
    if (e.detail >= 2) return;
    selectFolder(folder.id);
    if (state.expandedFolders.has(Number(folder.id))) state.expandedFolders.delete(Number(folder.id));
    else state.expandedFolders.add(Number(folder.id));
    saveExpanded();
    renderTree();
  });
  row.addEventListener('dblclick', (e) => {
    if (e.target.closest('.tree-act')) return;
    openFinder({ folderId: Number(folder.id) });
  });
  row.querySelector('[data-act="finder"]').addEventListener('click', (e) => {
    e.stopPropagation();
    openFinder({ folderId: Number(folder.id) });
  });
  row.querySelector('[data-act="more"]').addEventListener('click', (e) => {
    e.stopPropagation();
    selectFolder(folder.id);
    openMenu(e.currentTarget, [
      { label: '在访达中打开', icon: 'expand', onSelect: () => openFinder({ folderId: Number(folder.id) }) },
      { label: '新建子目录', icon: 'folderPlus', onSelect: () => createFolder(Number(folder.id)) },
      { sep: true },
      { label: '重命名', icon: 'pencil', onSelect: () => renameFolder(folder) },
      { label: '删除目录', icon: 'trash', danger: true, onSelect: () => deleteFolder(folder) },
    ]);
  });
  return row;
}

function fileRow(file, depth) {
  const row = document.createElement('div');
  row.className = 'tree-row leaf';
  row.style.setProperty('--depth', depth);
  row.dataset.fileId = file.id;
  row.dataset.kind = 'file';
  row.setAttribute('role', 'treeitem');
  row.title = `${file.name}\n${fmtBytes(file.size)}`;
  row.innerHTML =
    `<span class="tree-twisty leaf"></span>` +
    `<span class="tree-ico">${fileIcon(file.ext, 14)}</span>` +
    `<span class="tree-name"></span>` +
    `<span class="tree-meta">${fmtBytes(file.size)}</span>` +
    `<span class="tree-acts">` +
    `<button type="button" class="tree-act" data-act="more" title="更多">${icon('more', 12)}</button>` +
    `</span>`;
  row.querySelector('.tree-name').textContent = file.name;
  row.addEventListener('click', (e) => {
    if (e.target.closest('.tree-act')) return;
    openFilePreview(file);
  });
  row.querySelector('[data-act="more"]').addEventListener('click', (e) => {
    e.stopPropagation();
    openMenu(e.currentTarget, [
      { label: '预览内容', icon: 'file', onSelect: () => openFilePreview(file) },
      { label: '下载原文件', icon: 'download', onSelect: () => downloadFile(file) },
      { label: '在访达中管理', icon: 'expand', onSelect: () => openFinder({ folderId: file.folderId }) },
      { sep: true },
      { label: '删除文件', icon: 'trash', danger: true, onSelect: () => deleteFile(file) },
    ]);
  });
  return row;
}

function renderStats(files, folders) {
  const totalBytes = files.reduce((sum, f) => sum + (Number(f.size) || 0), 0);
  const count = document.getElementById('kb-title-count');
  if (count) count.textContent = files.length ? String(files.length) : '';
  const stats = document.getElementById('kb-stats');
  if (stats) {
    stats.innerHTML = files.length
      ? `<span>${files.length} 个文件 · ${folders.length} 个目录</span><span>${fmtBytes(totalBytes)}</span>`
      : '<span>暂无文件</span><span></span>';
  }
}

function updateLocation() {
  const el = document.getElementById('kb-location');
  if (!el) return;
  el.textContent = selectedFolderId == null
    ? '全部文件'
    : `位置：${['根目录', ...folderPath(selectedFolderId).map((f) => f.name)].join(' / ')}`;
}

function selectFolder(id) {
  selectedFolderId = id == null ? null : Number(id);
  updateLocation();
  document.querySelectorAll('.tree-row.selected').forEach((el) => {
    el.classList.toggle('selected',
      el.dataset.kind === 'folder' && Number(el.dataset.folderId) === selectedFolderId);
  });
}

/* ---------- 数据 ---------- */
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

/* ---------- 操作 ---------- */
async function createFolder(parentId = null) {
  const parent = parentId ?? selectedFolderId ?? null;
  const name = await promptDialog({
    title: parent ? '新建子目录' : '新建目录',
    label: parent ? `将在「${folderById(parent)?.name || ''}」下创建` : '目录名称',
    placeholder: '例如：01_基础原理',
    okText: '创建',
  });
  if (name == null) return;
  const trimmed = name.trim();
  if (!trimmed) { toast('目录名不能为空', 'error'); return; }
  try {
    await api.createFolder(trimmed, parent);
    if (parent != null) state.expandedFolders.add(Number(parent));
    saveExpanded();
    await loadTree({ silent: true });
    toast('目录已创建', 'success');
  } catch (e) { toast('创建失败：' + e.message, 'error'); }
}

async function renameFolder(folder) {
  const name = await promptDialog({
    title: '重命名目录', label: '目录名称', value: folder.name, okText: '保存',
  });
  if (name == null) return;
  const trimmed = name.trim();
  if (!trimmed || trimmed === folder.name) return;
  try {
    await api.renameFolder(folder.id, trimmed);
    await loadTree({ silent: true });
    toast('已重命名', 'success');
  } catch (e) { toast('重命名失败：' + e.message, 'error'); }
}

async function deleteFolder(folder) {
  const ok = await confirmDialog(
    `确认删除目录「${folder.name}」？其中的子目录、文件与分块会一并删除，且不可恢复。`,
    { title: '删除目录', okText: '删除' },
  );
  if (!ok) return;
  try {
    await api.deleteFolder(folder.id);
    if (selectedFolderId === Number(folder.id)) selectedFolderId = null;
    state.expandedFolders.delete(Number(folder.id));
    saveExpanded();
    await loadTree({ silent: true });
    toast('目录已删除', 'success');
  } catch (e) { toast('删除失败：' + e.message, 'error'); }
}

async function deleteFile(file) {
  const ok = await confirmDialog(`确认删除文件「${file.name}」？其分块会一并删除。`, {
    title: '删除文件', okText: '删除',
  });
  if (!ok) return;
  try {
    await api.deleteFile(file.id);
    await loadTree({ silent: true });
    toast('文件已删除', 'success');
  } catch (e) { toast('删除失败：' + e.message, 'error'); }
}

/* ---------- 初始化 ---------- */
function bindMore() {
  document.getElementById('btn-kb-more').addEventListener('click', (e) => {
    e.stopPropagation();
    openMenu(e.currentTarget, [
      { label: '在访达中打开', icon: 'expand', onSelect: () => openFinder({ folderId: selectedFolderId }) },
      { sep: true },
      { label: '导入知识库（JSON）', icon: 'upload', onSelect: () => document.dispatchEvent(new CustomEvent('kb-import')) },
      { label: '导出知识库（JSON）', icon: 'download', onSelect: () => document.dispatchEvent(new CustomEvent('kb-export')) },
      { sep: true },
      {
        label: '展开全部', icon: 'expand',
        onSelect: () => {
          state.tree.folders.forEach((f) => state.expandedFolders.add(Number(f.id)));
          saveExpanded(); renderTree();
        },
      },
      {
        label: '收起全部', icon: 'chevronRight',
        onSelect: () => {
          state.expandedFolders.clear();
          saveExpanded(); renderTree();
        },
      },
      { label: '刷新', icon: 'refresh', onSelect: () => loadTree() },
    ], { alignRight: true });
  });
}

export function initTree() {
  document.getElementById('btn-new-folder').innerHTML = icon('folderPlus', 15);
  document.getElementById('btn-kb-more').innerHTML = icon('more', 15);
  document.getElementById('btn-open-finder').addEventListener('click', () => openFinder({ folderId: selectedFolderId }));
  document.getElementById('btn-new-folder').addEventListener('click', () => createFolder(selectedFolderId));
  document.getElementById('btn-upload-empty').addEventListener('click', () => openFinder({ folderId: selectedFolderId }));
  bindMore();
  document.addEventListener('kb-refresh', () => loadTree({ silent: true }));
  document.addEventListener('kb-data-changed', () => renderTree());
}
