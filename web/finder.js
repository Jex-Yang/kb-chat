/**
 * finder.js — 访达式知识库窗口
 * 列表/图标视图、名称/日期/大小/种类排序、双击打开、拖放导入与移动、
 * 复制粘贴、重命名、批量删除、拖放导入。
 */
import { state } from './state.js';
import { api } from './api.js';
import { icon, fileIcon } from './icons.js';
import { openFilePreview, downloadFile } from './preview.js';
import {
  TEXT_EXTS, extOf, fmtBytes, fmtDateTime, toast,
  confirmDialog, promptDialog, openMenu, debounce,
} from './util.js';

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_IMPORT_FILES = 500;
const COLLATOR = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });

const KIND_LABEL = {
  txt: 'TXT 文稿', md: 'Markdown 文稿', csv: 'CSV 表格',
  pdf: 'PDF 文档', docx: 'Word 文稿', xlsx: 'Excel 表格',
};

const LS_VIEW = 'kb.finder.view';
const LS_SORT = 'kb.finder.sort';

let currentId = null;
let stack = [];
let stackIndex = -1;
let selected = new Set();
let anchorKey = null;
let view = 'list';
let sortKey = 'name';
let sortDir = 1;
let search = '';
let clipboard = null;
let importing = false;
let importTotal = 0;
let importDone = 0;
let dragKeys = null;
let dragDepth = 0;
let folderIndex = new Map();

const $ = (id) => document.getElementById(id);

/* ---------- 数据工具 ---------- */
function folders() { return state.tree.folders || []; }
function files() { return state.tree.files || []; }

function folderById(id) {
  return folders().find((f) => Number(f.id) === Number(id)) || null;
}

function folderPath(id) {
  const byId = new Map(folders().map((f) => [Number(f.id), f]));
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

function childFolders(id) {
  const pid = id == null ? null : Number(id);
  return folders().filter((f) => (f.parentId == null ? null : Number(f.parentId)) === pid);
}

function childFiles(id) {
  const pid = id == null ? null : Number(id);
  return files().filter((f) => (f.folderId == null ? null : Number(f.folderId)) === pid);
}

function isFolderKey(key) { return String(key).startsWith('folder:'); }
function keyId(key) { return Number(String(key).split(':')[1]); }

function totalKbBytes() {
  return files().reduce((sum, f) => sum + (Number(f.size) || 0), 0);
}

function refreshSidebarBrief() {
  // 侧边栏自己的统计由 tree.js 负责；这里只保留给 app 初始化调用
}

/* ---------- 视图数据 ---------- */
function visibleItems() {
  const q = search.trim().toLowerCase();
  const list = [];
  childFolders(currentId).forEach((f) => {
    if (!q || f.name.toLowerCase().includes(q)) list.push({ kind: 'folder', data: f });
  });
  childFiles(currentId).forEach((f) => {
    if (!q || f.name.toLowerCase().includes(q)) list.push({ kind: 'file', data: f });
  });
  list.sort(sortItems);
  return list;
}

function sortItems(a, b) {
  if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
  const da = a.data;
  const db = b.data;
  let va;
  let vb;
  switch (sortKey) {
    case 'date':
      va = new Date(da.createdAt || 0).getTime();
      vb = new Date(db.createdAt || 0).getTime();
      break;
    case 'size':
      va = a.kind === 'folder' ? -1 : Number(da.size) || 0;
      vb = b.kind === 'folder' ? -1 : Number(db.size) || 0;
      break;
    case 'kind':
      va = a.kind === 'folder' ? '' : (da.ext || '');
      vb = b.kind === 'folder' ? '' : (db.ext || '');
      break;
    case 'name':
    default:
      va = da.name || '';
      vb = db.name || '';
      break;
  }
  if (typeof va === 'string') {
    const cmp = COLLATOR.compare(va, vb);
    return cmp === 0 ? 0 : cmp * sortDir;
  }
  if (va === vb) return COLLATOR.compare(da.name || '', db.name || '') * sortDir;
  return va < vb ? -sortDir : sortDir;
}

function kindLabel(item) {
  if (item.kind === 'folder') return '文件夹';
  return KIND_LABEL[item.data.ext] || `${String(item.data.ext || '').toUpperCase()} 文件`;
}

function sizeLabel(item) {
  return item.kind === 'folder' ? '—' : fmtBytes(item.data.size);
}

/* ---------- 加载 / 打开 ---------- */
export async function loadKb({ silent = false } = {}) {
  try {
    const data = await api.getTree();
    state.tree = {
      folders: Array.isArray(data.folders) ? data.folders : [],
      files: Array.isArray(data.files) ? data.files : [],
    };
    state.treeReady = true;
    refreshSidebarBrief();
    rebuildFolderIndex();
    if (!$('finder-modal').hidden) render();
    document.dispatchEvent(new CustomEvent('kb-data-changed'));
    return state.tree;
  } catch (e) {
    if (!silent) toast('知识库加载失败：' + e.message, 'error');
    return null;
  }
}

export async function refreshKb() {
  await loadKb({ silent: true });
}

export async function openFinder({ folderId = null } = {}) {
  if (importing) { toast('正在导入，请稍候', 'error'); return; }
  const modal = $('finder-modal');
  if (!state.treeReady) await loadKb({ silent: true });
  if (folderId != null && folderById(folderId)) currentId = Number(folderId);
  else if (currentId != null && !folderById(currentId)) currentId = null;
  if (!stack.length) { stack = [currentId]; stackIndex = 0; }
  modal.hidden = false;
  render();
  $('finder-body').focus();
}

function closeFinder() {
  if (importing) { toast('正在导入，请稍候', 'error'); return; }
  $('finder-modal').hidden = true;
  selected.clear();
}

function rebuildFolderIndex() {
  folderIndex = new Map();
  folders().forEach((f) => {
    const key = `${f.parentId == null ? 'root' : f.parentId}/${f.name}`;
    if (!folderIndex.has(key)) folderIndex.set(key, Number(f.id));
  });
}

function navigate(id, { push = true } = {}) {
  if (importing) return;
  currentId = id == null ? null : Number(id);
  selected.clear();
  anchorKey = null;
  search = '';
  const input = $('finder-search');
  if (input) input.value = '';
  if (push) {
    stack = stack.slice(0, stackIndex + 1);
    stack.push(currentId);
    stackIndex = stack.length - 1;
  } else if (stackIndex >= 0) {
    stack[stackIndex] = currentId;
  } else {
    stack = [currentId];
    stackIndex = 0;
  }
  render();
}

/* ---------- 渲染 ---------- */
function render() {
  if (!$('finder-modal') || $('finder-modal').hidden) return;
  const path = folderPath(currentId);
  $('finder-title').textContent = path.length ? `${path[path.length - 1].name} — 知识库` : '知识库';
  $('finder-back').disabled = stackIndex <= 0;
  $('finder-forward').disabled = stackIndex < 0 || stackIndex >= stack.length - 1;
  $('finder-view-list').classList.toggle('active', view === 'list');
  $('finder-view-grid').classList.toggle('active', view === 'grid');
  $('finder-list-head').hidden = view !== 'list';
  updateSortUI();
  renderCrumbs(path);

  const items = visibleItems();
  const body = $('finder-body');
  const scroll = body.scrollTop;
  body.innerHTML = '';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'finder-empty';
    empty.innerHTML = search
      ? `<b>没有匹配「${escapeText(search)}」的项目</b><span>换个关键词试试</span>`
      : '<b>这个文件夹是空的</b><span>把文件或文件夹拖进来即可入库</span>';
    body.appendChild(empty);
  } else if (view === 'list') {
    items.forEach((item) => body.appendChild(buildRow(item)));
  } else {
    const grid = document.createElement('div');
    grid.className = 'finder-grid';
    items.forEach((item) => grid.appendChild(buildCard(item)));
    body.appendChild(grid);
  }
  body.scrollTop = scroll;
  updateStatus(items);
}

function escapeText(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderCrumbs(path) {
  const box = $('finder-crumbs');
  box.innerHTML = '';
  const root = document.createElement('button');
  root.type = 'button';
  root.className = 'crumb' + (path.length === 0 ? ' current' : '');
  root.textContent = '知识库';
  root.addEventListener('click', () => navigate(null));
  bindCrumbDrop(root, null);
  box.appendChild(root);
  path.forEach((folder, idx) => {
    const sep = document.createElement('span');
    sep.className = 'crumb-sep';
    sep.textContent = '/';
    box.appendChild(sep);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'crumb' + (idx === path.length - 1 ? ' current' : '');
    btn.textContent = folder.name;
    btn.title = folder.name;
    btn.addEventListener('click', () => navigate(folder.id));
    bindCrumbDrop(btn, folder.id);
    box.appendChild(btn);
  });
}

function bindCrumbDrop(el, folderId) {
  el.addEventListener('dragover', (e) => {
    if (dragKeys) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('drop-hover');
    }
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-hover'));
  el.addEventListener('drop', async (e) => {
    if (!dragKeys) return;
    e.preventDefault();
    el.classList.remove('drop-hover');
    await moveItems(dragKeys, folderId);
  });
}

function itemKey(item) {
  return `${item.kind}:${item.data.id}`;
}

function buildRow(item) {
  const key = itemKey(item);
  const row = document.createElement('div');
  row.className = 'finder-row' + (item.kind === 'folder' ? ' folder' : '') + (selected.has(key) ? ' selected' : '');
  row.dataset.key = key;
  row.draggable = true;
  row.innerHTML =
    `<span class="fr-name"><span class="fr-ico">${item.kind === 'folder' ? icon('folder', 15) : fileIcon(item.data.ext, 15)}</span><span class="fr-label"></span></span>` +
    `<span class="fr-date">${escapeText(fmtDateTime(item.data.createdAt))}</span>` +
    `<span class="fr-size">${escapeText(sizeLabel(item))}</span>` +
    `<span class="fr-kind">${escapeText(kindLabel(item))}</span>`;
  row.querySelector('.fr-label').textContent = item.data.name;
  bindItemEvents(row, item);
  return row;
}

function buildCard(item) {
  const key = itemKey(item);
  const card = document.createElement('div');
  card.className = 'finder-card' + (item.kind === 'folder' ? ' folder' : '') + (selected.has(key) ? ' selected' : '');
  card.dataset.key = key;
  card.draggable = true;
  card.innerHTML =
    `<span class="fc-ico">${item.kind === 'folder' ? icon('folder', 34) : fileIcon(item.data.ext, 34)}</span>` +
    `<span class="fc-name"></span>` +
    `<span class="fc-meta">${escapeText(item.kind === 'folder' ? '文件夹' : `${sizeLabel(item)} · ${kindLabel(item)}`)}</span>`;
  card.querySelector('.fc-name').textContent = item.data.name;
  bindItemEvents(card, item);
  return card;
}

function bindItemEvents(el, item) {
  const key = itemKey(item);
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.shiftKey) selectRange(key);
    else if (e.metaKey || e.ctrlKey) toggleSelect(key);
    else { selected = new Set([key]); anchorKey = key; }
    updateSelectionUI();
  });
  el.addEventListener('dblclick', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openItem(item);
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!selected.has(key)) { selected = new Set([key]); anchorKey = key; updateSelectionUI(); }
    showItemMenu(e.currentTarget, item);
  });
  el.addEventListener('dragstart', (e) => {
    if (importing) { e.preventDefault(); return; }
    dragKeys = selected.has(key) ? [...selected] : [key];
    selected = new Set(dragKeys);
    anchorKey = key;
    updateSelectionUI();
    e.dataTransfer.effectAllowed = 'copyMove';
    try {
      e.dataTransfer.setData('application/x-kb-items', JSON.stringify(dragKeys));
      e.dataTransfer.setData('text/plain', dragKeys.join('\n'));
    } catch { /* ignore */ }
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => {
    dragKeys = null;
    el.classList.remove('dragging');
    document.querySelectorAll('.finder-row.drop-target, .finder-card.drop-target, .crumb.drop-hover')
      .forEach((x) => x.classList.remove('drop-target', 'drop-hover'));
  });
  if (item.kind === 'folder') {
    el.addEventListener('dragover', (e) => {
      if (!dragKeys && !(e.dataTransfer && [...e.dataTransfer.types].includes('Files'))) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = dragKeys ? 'move' : 'copy';
      el.classList.add('drop-target');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', async (e) => {
      if (!dragKeys && !(e.dataTransfer && [...e.dataTransfer.types].includes('Files'))) return;
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('drop-target');
      if (dragKeys) {
        await moveItems(dragKeys, Number(item.data.id));
      } else {
        const overlay = $('finder-drop');
        if (overlay) overlay.hidden = true;
        dragDepth = 0;
        await importDataTransfer(e.dataTransfer, Number(item.data.id));
      }
    });
  }
}

function updateSelectionUI() {
  document.querySelectorAll('#finder-body [data-key]').forEach((el) => {
    el.classList.toggle('selected', selected.has(el.dataset.key));
  });
  updateStatus(visibleItems());
}

function updateStatus(items) {
  const list = items || visibleItems();
  $('finder-status').textContent = `${list.length} 个项目`;
  $('finder-total').textContent = `全库 ${files().length} 个文件 · ${fmtBytes(totalKbBytes())}`;
  $('finder-selection').textContent = selected.size ? `已选 ${selected.size} 项` : '';
  const actions = $('finder-status-actions');
  const hasSel = selected.size > 0;
  actions.hidden = !hasSel && !clipboard;
  $('finder-act-open').disabled = selected.size !== 1;
  $('finder-act-rename').disabled = selected.size !== 1;
  $('finder-act-copy').disabled = !hasSel;
  $('finder-act-paste').disabled = !clipboard || importing;
  $('finder-act-delete').disabled = !hasSel;
  if (!hasSel) {
    $('finder-selection').textContent = '';
  }
  $('finder-hint').textContent = importing
    ? `正在导入 ${importDone}/${importTotal}`
    : (clipboard ? `已复制 ${clipboard.items.length} 项，⌘/Ctrl+V 粘贴` : '拖入文件 / 文件夹即可入库');
  $('finder-back').disabled = stackIndex <= 0;
  $('finder-forward').disabled = stackIndex < 0 || stackIndex >= stack.length - 1;
}

function updateSortUI() {
  const label = sortKey === 'name' ? '名称' : sortKey === 'date' ? '修改日期'
    : sortKey === 'size' ? '大小' : '种类';
  const arrow = sortDir > 0 ? '↑' : '↓';
  $('finder-sort-btn').textContent = `${label} ${arrow}`;
  document.querySelectorAll('#finder-list-head .fh').forEach((btn) => {
    const active = btn.dataset.sort === sortKey;
    btn.classList.toggle('active', active);
    const ind = btn.querySelector('.sort-ind');
    if (ind) ind.textContent = active ? arrow : '';
  });
}

/* ---------- 选择 ---------- */
function toggleSelect(key) {
  if (selected.has(key)) selected.delete(key);
  else selected.add(key);
  anchorKey = key;
}

function selectRange(key) {
  const keys = visibleItems().map(itemKey);
  const from = keys.indexOf(anchorKey ?? key);
  const to = keys.indexOf(key);
  if (from < 0 || to < 0) { selected = new Set([key]); anchorKey = key; return; }
  const [a, b] = from <= to ? [from, to] : [to, from];
  selected = new Set(keys.slice(a, b + 1));
  anchorKey = key;
}

function selectAll() {
  selected = new Set(visibleItems().map(itemKey));
  updateSelectionUI();
}

/* ---------- 打开 / 预览 ---------- */
function openItem(item) {
  if (item.kind === 'folder') navigate(item.data.id);
  else openFilePreview(item.data);
}

/* ---------- 右键菜单 ---------- */
function showItemMenu(anchor, item) {
  const one = selected.size === 1;
  const items = [
    { label: item.kind === 'folder' ? '打开文件夹' : '打开预览', icon: item.kind === 'folder' ? 'folder' : 'file',
      disabled: !one, onSelect: () => openItem(item) },
    { sep: true },
    { label: '重命名', icon: 'pencil', disabled: !one, onSelect: () => renameSelection() },
    { label: '复制', icon: 'copy', hint: '⌘C', onSelect: copySelection },
    { label: '粘贴到当前文件夹', icon: 'download', hint: '⌘V', disabled: !clipboard, onSelect: pasteClipboard },
    item.kind === 'file'
      ? { label: '下载原文件', icon: 'download', disabled: !one, onSelect: () => downloadFile(item.data) }
      : { label: '新建子文件夹', icon: 'folderPlus', onSelect: () => createFolder(item.data.id) },
    { sep: true },
    { label: `删除${selected.size > 1 ? ` ${selected.size} 项` : ''}`, icon: 'trash', danger: true, onSelect: deleteSelection },
  ];
  openMenu(anchor, items, { alignRight: true });
}

function showBlankMenu(anchor) {
  openMenu(anchor, [
    { label: '新建文件夹', icon: 'folderPlus', onSelect: () => createFolder(currentId) },
    { label: '粘贴', icon: 'download', hint: '⌘V', disabled: !clipboard, onSelect: pasteClipboard },
    { sep: true },
    { label: '全选', icon: 'check', hint: '⌘A', onSelect: selectAll },
    { label: '刷新', icon: 'refresh', onSelect: () => loadKb() },
  ]);
}

/* ---------- 操作 ---------- */
async function createFolder(parentId = currentId) {
  if (importing) return;
  const name = await promptDialog({
    title: '新建文件夹',
    label: parentId == null ? '将在知识库根目录创建' : `将在「${folderById(parentId)?.name || ''}」中创建`,
    placeholder: '文件夹名称',
    okText: '创建',
  });
  if (name == null) return;
  const trimmed = name.trim();
  if (!trimmed) { toast('文件夹名不能为空', 'error'); return; }
  try {
    const res = await api.createFolder(trimmed, parentId);
    await loadKb({ silent: true });
    if (parentId === currentId) {
      selected = new Set([`folder:${res.id}`]);
    } else {
      navigate(parentId);
    }
    render();
    toast('文件夹已创建', 'success');
  } catch (e) { toast('创建失败：' + e.message, 'error'); }
}

async function renameSelection() {
  if (selected.size !== 1) return;
  const key = [...selected][0];
  const id = keyId(key);
  const folder = isFolderKey(key);
  const item = folder ? folderById(id) : files().find((f) => Number(f.id) === id);
  if (!item) return;
  const name = await promptDialog({
    title: folder ? '重命名文件夹' : '重命名文件',
    label: '名称',
    value: item.name,
    okText: '保存',
  });
  if (name == null) return;
  const trimmed = name.trim();
  if (!trimmed || trimmed === item.name) return;
  try {
    if (folder) await api.renameFolder(id, trimmed);
    else await api.renameFile(id, trimmed);
    await loadKb({ silent: true });
    selected = new Set([key]);
    render();
    toast('已重命名', 'success');
  } catch (e) { toast('重命名失败：' + e.message, 'error'); }
}

function selectedDescriptors() {
  return [...selected].map((key) => {
    const id = keyId(key);
    const kind = isFolderKey(key) ? 'folder' : 'file';
    const data = kind === 'folder' ? folderById(id) : files().find((f) => Number(f.id) === id);
    return { key, kind, id, name: data ? data.name : '' };
  }).filter((x) => x.name);
}

function copySelection() {
  const items = selectedDescriptors();
  if (!items.length) return;
  clipboard = { items, mode: 'copy' };
  updateStatus();
  toast(`已复制 ${items.length} 项`, 'success');
}

async function pasteClipboard() {
  if (!clipboard || !clipboard.items.length || importing) return;
  const target = currentId;
  let ok = 0;
  let fail = 0;
  for (const item of clipboard.items) {
    try {
      if (item.kind === 'folder') {
        await api.copyFolder(item.id, { parentId: target });
      } else {
        await api.copyFile(item.id, { folderId: target });
      }
      ok++;
    } catch (e) {
      fail++;
      toast(`复制「${item.name}」失败：${e.message}`, 'error');
    }
  }
  if (ok) {
    await loadKb({ silent: true });
    render();
    toast(`已粘贴 ${ok} 项${fail ? `，失败 ${fail} 项` : ''}`, fail ? 'error' : 'success');
  }
}

async function deleteSelection() {
  if (!selected.size || importing) return;
  const items = selectedDescriptors();
  if (!items.length) return;
  const ok = await confirmDialog(
    `确认删除选中的 ${items.length} 项？文件夹会连同其中内容一起删除，且不可恢复。`,
    { title: '删除项目', okText: '删除' },
  );
  if (!ok) return;
  let done = 0;
  let fail = 0;
  for (const item of items) {
    try {
      if (item.kind === 'folder') await api.deleteFolder(item.id);
      else await api.deleteFile(item.id);
      done++;
    } catch (e) {
      fail++;
      toast(`删除「${item.name}」失败：${e.message}`, 'error');
    }
  }
  selected.clear();
  await loadKb({ silent: true });
  render();
  toast(`已删除 ${done} 项${fail ? `，失败 ${fail} 项` : ''}`, fail ? 'error' : 'success');
}

async function moveItems(keys, targetId) {
  if (!keys || !keys.length || importing) return;
  const items = keys.map((key) => {
    const id = keyId(key);
    const kind = isFolderKey(key) ? 'folder' : 'file';
    const data = kind === 'folder' ? folderById(id) : files().find((f) => Number(f.id) === id);
    return { key, kind, id, name: data ? data.name : '' };
  }).filter((x) => x.name);
  let ok = 0;
  let fail = 0;
  for (const item of items) {
    try {
      if (item.kind === 'folder') {
        if (Number(item.id) === Number(targetId)) continue;
        await api.moveFolder(item.id, targetId);
      } else {
        await api.moveFile(item.id, targetId);
      }
      ok++;
    } catch (e) {
      fail++;
      toast(`移动「${item.name}」失败：${e.message}`, 'error');
    }
  }
  selected.clear();
  dragKeys = null;
  await loadKb({ silent: true });
  render();
  if (ok) toast(`已移动 ${ok} 项`, 'success');
}

/* ---------- 导入 ---------- */
async function ensurePathAsync(relDir, baseId) {
  let segs = String(relDir || '').replace(/\\/g, '/').split('/').filter(Boolean);
  const baseName = baseId == null ? null : folderById(baseId)?.name;
  if (baseName && segs.length && segs[0] === baseName) segs = segs.slice(1);
  let parent = baseId;
  for (const name of segs) {
    const key = `${parent == null ? 'root' : parent}/${name}`;
    let id = folderIndex.get(key);
    if (!id) {
      const res = await api.createFolder(name, parent);
      id = Number(res.id);
      folderIndex.set(key, id);
    }
    parent = id;
  }
  return parent;
}

function collectFromFileList(fileList) {
  const out = [];
  Array.from(fileList || []).forEach((file) => {
    const rel = file.webkitRelativePath || file.name;
    out.push({ kind: 'file', relPath: rel, file });
  });
  return out;
}

async function collectFromEntries(entries) {
  const out = [];
  async function walk(entry, base) {
    const rel = `${base || ''}/${entry.name}`.replace(/\/+/g, '/');
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      out.push({ kind: 'file', relPath: rel, file });
      return;
    }
    if (entry.isDirectory) {
      out.push({ kind: 'dir', relPath: rel });
      const reader = entry.createReader();
      const read = () => new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      let batch = await read();
      while (batch.length) {
        for (const child of batch) await walk(child, rel);
        batch = await read();
      }
    }
  }
  for (const entry of entries) await walk(entry, '');
  return out;
}

export async function importDataTransfer(dataTransfer, baseId = null) {
  if (!dataTransfer || importing) return;
  const target = baseId ?? currentId;
  const entries = [];
  for (const item of Array.from(dataTransfer.items || [])) {
    if (item.kind !== 'file' || !item.webkitGetAsEntry) continue;
    const entry = item.webkitGetAsEntry();
    if (entry) entries.push(entry);
  }
  let list = [];
  if (entries.length) list = await collectFromEntries(entries);
  else list = collectFromFileList(dataTransfer.files);
  await uploadEntries(list, target);
}

async function uploadEntries(list, baseId) {
  const valid = [];
  let skipped = 0;
  for (const entry of list) {
    if (entry.kind === 'file') {
      if (!TEXT_EXTS.includes(extOf(entry.file.name)) || entry.file.size > MAX_UPLOAD_BYTES) {
        skipped++;
        continue;
      }
    }
    valid.push(entry);
  }
  if (valid.length > MAX_IMPORT_FILES) {
    toast(`单次最多导入 ${MAX_IMPORT_FILES} 个文件`, 'error');
    return;
  }
  if (!valid.length) {
    toast('没有可导入的文件（支持 txt/md/csv/pdf/docx/xlsx，≤20MB）', 'error');
    return;
  }
  importing = true;
  importTotal = valid.filter((x) => x.kind === 'file').length;
  importDone = 0;
  updateStatus();
  const dirs = valid.filter((x) => x.kind === 'dir')
    .sort((a, b) => a.relPath.split('/').length - b.relPath.split('/').length);
  const items = valid.filter((x) => x.kind === 'file');
  try {
    for (const dir of dirs) {
      await ensurePathAsync(dir.relPath, baseId);
    }
    for (const entry of items) {
      const relDir = entry.relPath.split('/').slice(0, -1).join('/');
      const folderId = relDir ? await ensurePathAsync(relDir, baseId) : baseId;
      try {
        const res = await api.uploadFile(entry.file, folderId);
        importDone++;
      } catch (e) {
        toast(`导入 ${entry.relPath} 失败：${e.message}`, 'error');
      }
      updateStatus();
    }
    await loadKb({ silent: true });
    toast(`导入完成：${importDone} 个文件` +
      (skipped ? `，跳过 ${skipped} 个不支持的文件` : ''), 'success', 4200);
  } finally {
    importing = false;
    updateStatus();
    render();
  }
}

/* ---------- 拖放（外部） ---------- */
function bindWindowDrop() {
  const finder = $('finder');
  const overlay = $('finder-drop');
  const hasFiles = (e) => !!(e.dataTransfer && [...e.dataTransfer.types].includes('Files'));
  finder.addEventListener('dragenter', (e) => {
    if (dragKeys || !hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    overlay.hidden = false;
  });
  finder.addEventListener('dragover', (e) => {
    if (dragKeys || !hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  finder.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) overlay.hidden = true;
  });
  finder.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    overlay.hidden = true;
    const row = e.target.closest('[data-key]');
    const base = row && isFolderKey(row.dataset.key) ? keyId(row.dataset.key) : currentId;
    await importDataTransfer(e.dataTransfer, base);
  });
  window.addEventListener('dragend', () => { dragDepth = 0; overlay.hidden = true; });
  window.addEventListener('drop', () => { dragDepth = 0; overlay.hidden = true; });
}

/* ---------- 初始化 ---------- */
function bindToolbar() {
  $('finder-refresh').innerHTML = icon('refresh', 15);
  $('finder-new-folder').innerHTML = icon('folderPlus', 15);
  $('finder-view-list').innerHTML = icon('list', 14);
  $('finder-view-grid').innerHTML = icon('grid', 14);
  $('finder-back').innerHTML = icon('chevronRight', 14).replace('<svg', '<svg style="transform:scaleX(-1)"');
  $('finder-forward').innerHTML = icon('chevronRight', 14);
  $('finder-search-ico').innerHTML = icon('search', 13);
  $('finder-drop-ico').innerHTML = icon('upload', 28);
  $('status-db').innerHTML = icon('book', 12);

  $('finder-close').addEventListener('click', closeFinder);
  $('finder-back').addEventListener('click', () => {
    if (stackIndex <= 0) return;
    stackIndex--;
    currentId = stack[stackIndex];
    selected.clear();
    search = '';
    $('finder-search').value = '';
    render();
  });
  $('finder-forward').addEventListener('click', () => {
    if (stackIndex >= stack.length - 1) return;
    stackIndex++;
    currentId = stack[stackIndex];
    selected.clear();
    search = '';
    $('finder-search').value = '';
    render();
  });
  $('finder-new-folder').addEventListener('click', () => createFolder(currentId));
  $('finder-refresh').addEventListener('click', () => loadKb());
  $('finder-view-list').addEventListener('click', () => { view = 'list'; savePrefs(); render(); });
  $('finder-view-grid').addEventListener('click', () => { view = 'grid'; savePrefs(); render(); });
  $('finder-sort-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    openMenu(e.currentTarget, [
      { label: '名称', icon: 'file', hint: sortKey === 'name' ? (sortDir > 0 ? '↑' : '↓') : '', onSelect: () => setSort('name') },
      { label: '修改日期', icon: 'refresh', hint: sortKey === 'date' ? (sortDir > 0 ? '↑' : '↓') : '', onSelect: () => setSort('date') },
      { label: '大小', icon: 'download', hint: sortKey === 'size' ? (sortDir > 0 ? '↑' : '↓') : '', onSelect: () => setSort('size') },
      { label: '种类', icon: 'book', hint: sortKey === 'kind' ? (sortDir > 0 ? '↑' : '↓') : '', onSelect: () => setSort('kind') },
      { sep: true },
      { label: sortDir > 0 ? '改为降序' : '改为升序', icon: 'arrowDown', onSelect: () => { sortDir *= -1; savePrefs(); render(); } },
    ]);
  });
  document.querySelectorAll('#finder-list-head .fh').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (sortKey === btn.dataset.sort) sortDir *= -1;
      else { sortKey = btn.dataset.sort; sortDir = 1; }
      savePrefs();
      render();
    });
  });
  $('finder-search').addEventListener('input', debounce((e) => {
    search = e.target.value.trim();
    render();
  }, 120));
  $('finder-body').addEventListener('click', (e) => {
    if (e.target.closest('[data-key]')) return;
    selected.clear();
    updateSelectionUI();
  });
  $('finder-body').addEventListener('contextmenu', (e) => {
    if (e.target.closest('[data-key]')) return;
    e.preventDefault();
    showBlankMenu({ getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY }), contains: () => false });
  });

  $('finder-act-open').addEventListener('click', () => {
    if (selected.size !== 1) return;
    const key = [...selected][0];
    const id = keyId(key);
    if (isFolderKey(key)) navigate(id);
    else {
      const file = files().find((f) => Number(f.id) === id);
      if (file) openFilePreview(file);
    }
  });
  $('finder-act-rename').addEventListener('click', renameSelection);
  $('finder-act-copy').addEventListener('click', copySelection);
  $('finder-act-paste').addEventListener('click', pasteClipboard);
  $('finder-act-delete').addEventListener('click', deleteSelection);

  $('finder-import').addEventListener('click', (e) => {
    e.stopPropagation();
    openMenu(e.currentTarget, [
      { label: '导入文件', icon: 'file', onSelect: () => $('file-upload-input').click() },
      { label: '导入文件夹', icon: 'folder', onSelect: () => $('folder-upload-input').click() },
    ], { alignRight: true });
  });
  $('file-upload-input').addEventListener('change', async (e) => {
    const list = collectFromFileList(e.target.files);
    e.target.value = '';
    await uploadEntries(list, currentId);
  });
  $('folder-upload-input').addEventListener('change', async (e) => {
    const list = collectFromFileList(e.target.files);
    e.target.value = '';
    await uploadEntries(list, currentId);
  });
}

function setSort(key) {
  if (sortKey === key) sortDir *= -1;
  else { sortKey = key; sortDir = 1; }
  savePrefs();
  render();
}

function savePrefs() {
  try {
    localStorage.setItem(LS_VIEW, view);
    localStorage.setItem(LS_SORT, JSON.stringify({ key: sortKey, dir: sortDir }));
  } catch { /* ignore */ }
}

function loadPrefs() {
  try {
    const v = localStorage.getItem(LS_VIEW);
    if (v === 'grid' || v === 'list') view = v;
    const s = JSON.parse(localStorage.getItem(LS_SORT) || 'null');
    if (s && ['name', 'date', 'size', 'kind'].includes(s.key) && (s.dir === 1 || s.dir === -1)) {
      sortKey = s.key; sortDir = s.dir;
    }
  } catch { /* ignore */ }
}

function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    if ($('finder-modal').hidden) return;
    if (document.querySelector('.ctx-menu')) return;
    if (document.querySelector('.modal-mask:not([hidden]):not(#finder-modal)')) return;
    const usagePop = document.getElementById('usage-pop');
    if (usagePop && !usagePop.hidden) return;
    const qnPanel = document.getElementById('qn-panel');
    if (qnPanel && !qnPanel.hidden) return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    const typing = tag === 'INPUT' || tag === 'TEXTAREA';
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'a' && !typing) {
      e.preventDefault();
      selectAll();
      return;
    }
    if (mod && e.key.toLowerCase() === 'c' && !typing) {
      e.preventDefault();
      copySelection();
      return;
    }
    if (mod && e.key.toLowerCase() === 'v' && !typing) {
      e.preventDefault();
      pasteClipboard();
      return;
    }
    if (typing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (selected.size) { selected.clear(); updateSelectionUI(); }
      else closeFinder();
    } else if (e.key === 'Enter') {
      if (selected.size === 1) {
        const key = [...selected][0];
        const id = keyId(key);
        if (isFolderKey(key)) navigate(id);
        else {
          const file = files().find((f) => Number(f.id) === id);
          if (file) openFilePreview(file);
        }
      }
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selected.size) { e.preventDefault(); deleteSelection(); }
    }
  });
}

export function initFinder() {
  loadPrefs();
  bindToolbar();
  bindWindowDrop();
  bindKeyboard();
  $('finder-modal').addEventListener('click', (e) => {
    // 点击遮罩不关闭窗口；红点关闭更符合窗口习惯
    if (e.target === e.currentTarget) e.stopPropagation();
  });
  document.addEventListener('kb-refresh', () => loadKb({ silent: true }));
  document.addEventListener('kb-tree-loaded', () => {
    if (!$('finder-modal').hidden) render();
  });
  document.addEventListener('app-ready', () => { refreshSidebarBrief(); });
}
