/**
 * conversations.js — 对话列表：搜索 / 新建 / 切换 / 置顶 / 批量管理 / 重命名 / 删除
 */
import { state } from './state.js';
import { api } from './api.js';
import {
  formatTime, dayGroup, toast, confirmDialog, promptDialog,
} from './util.js';
import { icon } from './icons.js';
import { renderHistory, clearChat } from './chat.js';
import { refreshUsage } from './topbar.js';
import { exportSingleConversation } from './export-text.js';


export function markSelected() {
  document.querySelectorAll('.conv-item').forEach((el) => {
    el.classList.toggle('selected', Number(el.dataset.convId) === Number(state.currentConvId));
  });
}

function groupConversations(list) {
  const order = ['置顶', '今天', '昨天', '本周', '更早'];
  const map = new Map();
  list.forEach((c) => {
    const key = c.pinned ? '置顶' : dayGroup(c.updatedAt || c.createdAt);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(c);
  });
  return order.filter((k) => map.has(k)).map((k) => ({ label: k, items: map.get(k) }));
}

export function renderConvList() {
  const listEl = document.getElementById('conv-list');
  if (!listEl) return;
  listEl.innerHTML = '';
  const all = state.conversations;
  const countEl = document.getElementById('conv-count');
  if (countEl) countEl.textContent = state.conversations.length ? String(state.conversations.length) : '';

  if (!all.length) {
    const empty = document.createElement('div');
    empty.className = 'conv-empty';
    empty.innerHTML = '还没有对话<br>点上面「开启新对话」开始';
    listEl.appendChild(empty);
  } else {
    groupConversations(all).forEach((group) => {
      const label = document.createElement('div');
      label.className = 'conv-group';
      label.innerHTML = (group.label === '置顶' ? `<span class="conv-group-pin">${icon('star', 10)}</span>` : '') +
        `<span></span>`;
      label.querySelector('span:last-child').textContent = group.label;
      listEl.appendChild(label);
      group.items.forEach((c) => listEl.appendChild(buildConvItem(c)));
    });
  }
  updateBatchBar();
  const manageBtn = document.getElementById('btn-conv-manage');
  if (manageBtn) {
    manageBtn.classList.toggle('active', state.convSelectionMode);
    manageBtn.setAttribute('aria-pressed', String(state.convSelectionMode));
    manageBtn.title = state.convSelectionMode ? '完成批量管理' : '批量管理';
  }
}


function buildConvItem(c) {
  const selecting = state.convSelectionMode;
  const checked = state.convSelected.has(Number(c.id));
  const item = document.createElement('div');
  item.className = 'conv-item' +
    ((!selecting && Number(c.id) === Number(state.currentConvId)) ? ' selected' : '') +
    (checked ? ' checked' : '') +
    (selecting ? ' selecting' : '');
  item.dataset.convId = c.id;
  item.setAttribute('role', 'option');
  item.setAttribute('aria-selected', String(Number(c.id) === Number(state.currentConvId)));

  item.innerHTML =
    (selecting ? `<span class="conv-check">${checked ? icon('check', 11) : ''}</span>` : '') +
    `<span class="conv-mode" title="${c.mode === 'kb' ? '知识库模式' : '聊天模式'}">${icon(c.mode === 'kb' ? 'book' : 'chat', 12)}</span>` +
    `<span class="conv-main">` +
    `<span class="conv-title"></span>` +
    `<span class="conv-meta">` +
    (c.pinned ? `<span class="conv-pin" title="已置顶">${icon('star', 9)}</span>` : '') +
    `<span class="conv-time"></span>` +
    `</span>` +
    `</span>` +
    (selecting ? '' :
      `<span class="conv-actions">` +
      `<button type="button" class="icon-btn" title="${c.pinned ? '取消置顶' : '置顶'}" data-act="pin">${icon('star', 12)}</button>` +
      `<button type="button" class="icon-btn" title="导出（txt）" data-act="export">${icon('download', 12)}</button>` +
      `<button type="button" class="icon-btn" title="重命名" data-act="rename">${icon('pencil', 12)}</button>` +
      `<button type="button" class="icon-btn" title="删除" data-act="del">${icon('trash', 12)}</button>` +
      `</span>`);
  item.querySelector('.conv-title').textContent = c.title || '未命名对话';
  item.querySelector('.conv-time').textContent = formatTime(c.updatedAt || c.createdAt);

  item.addEventListener('click', (e) => {
    if (e.target.closest('.conv-actions')) return;
    if (state.convSelectionMode) {
      toggleChecked(c.id);
      return;
    }
    selectConversation(c.id);
  });

  if (!selecting) {
    item.querySelector('[data-act="pin"]').addEventListener('click', (e) => {
      e.stopPropagation();
      togglePin(c);
    });
    item.querySelector('[data-act="export"]').addEventListener('click', (e) => {
      e.stopPropagation();
      exportConversation(c);
    });
    item.querySelector('[data-act="rename"]').addEventListener('click', (e) => {
      e.stopPropagation();
      renameConversation(c);
    });
    item.querySelector('[data-act="del"]').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteConversation(c);
    });
  } else {
    item.querySelector('.conv-check').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleChecked(c.id);
    });
  }
  return item;
}

/* ---------- 批量选择 ---------- */
export function setSelectionMode(on) {
  state.convSelectionMode = !!on;
  if (!on) state.convSelected.clear();
  const btn = document.getElementById('btn-conv-manage');
  if (btn) {
    btn.classList.toggle('active', !!on);
    btn.setAttribute('aria-pressed', String(!!on));
    btn.title = on ? '完成批量管理' : '批量管理';
  }
  renderConvList();
}

function toggleChecked(id) {
  const num = Number(id);
  if (state.convSelected.has(num)) state.convSelected.delete(num);
  else state.convSelected.add(num);
  renderConvList();
}

function updateBatchBar() {
  const bar = document.getElementById('conv-batch');
  if (!bar) return;
  const on = state.convSelectionMode;
  bar.hidden = !on;
  if (!on) return;
  const selected = state.convSelected;
  document.getElementById('conv-batch-count').textContent = `已选 ${selected.size} 项`;
  const ids = [...selected];
  const allPinned = ids.length > 0 && ids.every((id) => {
    const c = state.conversations.find((x) => Number(x.id) === Number(id));
    return c && c.pinned;
  });
  document.getElementById('conv-batch-pin').textContent = allPinned ? '取消置顶' : '置顶';
  document.getElementById('conv-batch-del').disabled = ids.length === 0;
  document.getElementById('conv-batch-pin').disabled = ids.length === 0;
}

async function togglePin(conv) {
  try {
    await api.updateConversation(conv.id, { pinned: !conv.pinned });
    await loadConversations();
    toast(conv.pinned ? '已取消置顶' : '已置顶', 'success');
  } catch (e) { toast('置顶失败：' + e.message, 'error'); }
}

async function batchPin() {
  const ids = [...state.convSelected];
  if (!ids.length) return;
  const allPinned = ids.every((id) => {
    const c = state.conversations.find((x) => Number(x.id) === Number(id));
    return c && c.pinned;
  });
  const target = !allPinned;
  let ok = 0;
  for (const id of ids) {
    try {
      await api.updateConversation(id, { pinned: target });
      ok++;
    } catch (e) {
      toast('置顶失败：' + e.message, 'error');
    }
  }
  await loadConversations();
  toast(target ? `已置顶 ${ok} 项` : `已取消置顶 ${ok} 项`, 'success');
}

async function batchDelete() {
  const ids = [...state.convSelected];
  if (!ids.length) return;
  const ok = await confirmDialog(
    `确认删除选中的 ${ids.length} 个对话？其中的消息会一并删除。`,
    { title: '批量删除对话', okText: '删除' },
  );
  if (!ok) return;
  let done = 0;
  for (const id of ids) {
    try {
      await api.deleteConversation(id);
      done++;
      if (Number(id) === Number(state.currentConvId)) {
        state.currentConvId = null;
        state.currentConvTitle = '';
        state.currentMessages = [];
        state.conversationUsage = { turns: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
        clearChat();
      }
    } catch (e) {
      toast('删除失败：' + e.message, 'error');
    }
  }
  state.convSelected.clear();
  toast(`已删除 ${done} 个对话`, 'success');
  await loadConversations();
  if (state.currentConvId == null && state.conversations.length) {
    await selectConversation(state.conversations[0].id);
  } else {
    refreshUsage(state.currentConvId);
  }
}

/* ---------- 数据 ---------- */
export async function loadConversations() {
  try {
    const list = await api.getConversations();
    state.conversations = Array.isArray(list) ? list : [];
    const ids = new Set(state.conversations.map((c) => Number(c.id)));
    [...state.convSelected].forEach((id) => { if (!ids.has(Number(id))) state.convSelected.delete(id); });
    renderConvList();
  } catch (e) {
    toast('对话列表加载失败：' + e.message, 'error');
  }
}

export async function selectConversation(id) {
  if (state.sending) { toast('请等待当前回复完成或先停止', 'error'); return; }
  const numeric = Number(id);
  if (!Number.isFinite(numeric)) return;
  try {
    const conv = await api.getConversation(numeric);
    state.currentConvId = Number(conv.id);
    state.currentConvTitle = conv.title || '新对话';
    state.convMode = conv.mode === 'kb' ? 'kb' : 'chat';
    state.conversationUsage = conv.usage || {
      turns: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
      cacheHitTokens: 0, cacheMissTokens: 0, cacheHitRate: null, cacheKnown: false,
    };
    state.attachments = [];
    state.lastTurn = null;
    document.dispatchEvent(new CustomEvent('attachments-change'));
    document.dispatchEvent(new CustomEvent('conv-mode-change'));
    document.dispatchEvent(new CustomEvent('conv-changed'));

    markSelected();
    renderHistory(conv.messages || []);
    refreshUsage(state.currentConvId);
    if (window.matchMedia('(max-width: 960px)').matches) {
      document.body.classList.remove('sidebar-open');
      document.getElementById('sidebar-mask').hidden = true;
    }
  } catch (e) {
    toast('对话加载失败：' + e.message, 'error');
  }
}

export async function newConversation() {
  if (state.sending) { toast('请等待当前回复完成或先停止', 'error'); return; }
  try {
    const res = await api.createConversation({ mode: state.convMode });
    state.currentConvId = Number(res.id);
    state.currentConvTitle = '新对话';
    state.currentMessages = [];
    state.conversationUsage = {
      turns: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
      cacheHitTokens: 0, cacheMissTokens: 0, cacheHitRate: null, cacheKnown: false,
    };
    state.attachments = [];
    state.lastTurn = null;
    state.convSelectionMode = false;
    state.convSelected.clear();
    document.dispatchEvent(new CustomEvent('attachments-change'));
    await loadConversations();
    markSelected();
    clearChat();
    document.dispatchEvent(new CustomEvent('conv-changed'));
    refreshUsage(state.currentConvId);
    document.getElementById('chat-input').focus();
    if (window.matchMedia('(max-width: 960px)').matches) {
      document.body.classList.remove('sidebar-open');
      document.getElementById('sidebar-mask').hidden = true;
    }
  } catch (e) {
    toast('新建对话失败：' + e.message, 'error');
  }
}

async function exportConversation(conv) {
  try {
    await exportSingleConversation(conv.id);
    toast('已导出 TXT', 'success');
  } catch (e) { toast('导出失败：' + e.message, 'error'); }
}

async function renameConversation(conv) {
  const title = await promptDialog({
    title: '重命名对话', label: '对话标题', value: conv.title || '', okText: '保存',
  });
  if (title == null) return;
  const trimmed = title.trim();
  if (!trimmed || trimmed === conv.title) return;
  try {
    await api.updateConversation(conv.id, { title: trimmed });
    if (Number(conv.id) === Number(state.currentConvId)) state.currentConvTitle = trimmed;
    await loadConversations();
  } catch (e) { toast('重命名失败：' + e.message, 'error'); }
}

async function deleteConversation(conv) {
  const ok = await confirmDialog(
    `确认删除对话「${conv.title || '未命名对话'}」？其中的消息会一并删除。`,
    { title: '删除对话', okText: '删除' },
  );
  if (!ok) return;
  try {
    await api.deleteConversation(conv.id);
    if (Number(conv.id) === Number(state.currentConvId)) {
      state.currentConvId = null;
      state.currentConvTitle = '';
      state.currentMessages = [];
      state.conversationUsage = {
        turns: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
        cacheHitTokens: 0, cacheMissTokens: 0, cacheHitRate: null, cacheKnown: false,
      };
      clearChat();
      refreshUsage(null);
    }
    toast('对话已删除', 'success');
    await loadConversations();
    if (state.currentConvId == null && state.conversations.length) {
      await selectConversation(state.conversations[0].id);
    }
  } catch (e) { toast('删除失败：' + e.message, 'error'); }
}

/* ---------- 初始化 ---------- */
export function initConversations() {
  document.getElementById('btn-new-conv').addEventListener('click', newConversation);
  document.getElementById('conv-new-ico').innerHTML = icon('plus', 13);
  const manageBtn = document.getElementById('btn-conv-manage');
  manageBtn.innerHTML = icon('checklist', 15);
  manageBtn.addEventListener('click', () => setSelectionMode(!state.convSelectionMode));
  document.getElementById('conv-batch-all').addEventListener('click', () => {
    const ids = state.conversations.map((c) => Number(c.id));
    if (ids.length && ids.every((id) => state.convSelected.has(id))) {
      state.convSelected.clear();
    } else {
      state.convSelected = new Set(ids);
    }
    renderConvList();
  });
  document.getElementById('conv-batch-pin').addEventListener('click', batchPin);
  document.getElementById('conv-batch-del').addEventListener('click', batchDelete);
  document.getElementById('conv-batch-cancel').addEventListener('click', () => setSelectionMode(false));
  document.addEventListener('conversations-refresh', () => { loadConversations(); });
}
