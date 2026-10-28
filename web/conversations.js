/**
 * conversations.js — 对话列表：新建 / 切换 / 置顶 / 重命名 / 删除
 * 侧边栏风格对齐 DeepSeek Harness：一行标题 + 时间，悬停出现操作。
 */
import { state } from './state.js';
import { api } from './api.js';
import {
  formatTime, dayGroup, toast, confirmDialog, promptDialog,
} from './util.js';
import { icon } from './icons.js';
import { renderHistory, clearChat } from './chat.js';
import { refreshUsage } from './topbar.js';

function emptyUsage() {
  return {
    turns: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
    cacheHitTokens: 0, cacheMissTokens: 0, cacheHitRate: null, cacheKnown: false,
  };
}

export function markSelected() {
  let current = null;
  document.querySelectorAll('.conv-item').forEach((el) => {
    const on = Number(el.dataset.convId) === Number(state.currentConvId);
    el.classList.toggle('selected', on);
    el.setAttribute('aria-selected', String(on));
    if (on) current = el;
  });
  current?.scrollIntoView({ block: 'nearest' });
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
    empty.innerHTML = `<span class="conv-empty-ico">${icon('chat', 18)}</span>`
      + '<span>还没有对话</span><span class="conv-empty-sub">点击上方「新对话」开始</span>';
    listEl.appendChild(empty);
  } else {
    groupConversations(all).forEach((group) => {
      const label = document.createElement('div');
      label.className = 'conv-group';
      if (group.label === '置顶') {
        label.innerHTML = `<span class="conv-group-pin">${icon('star', 10)}</span><span></span>`;
        label.querySelector('span:last-child').textContent = group.label;
      } else {
        label.textContent = group.label;
      }
      listEl.appendChild(label);
      group.items.forEach((c) => listEl.appendChild(buildConvItem(c)));
    });
  }

  const selected = listEl.querySelector('.conv-item.selected');
  if (selected) selected.scrollIntoView({ block: 'nearest' });
}

function buildConvItem(c) {
  const item = document.createElement('div');
  item.className = 'conv-item' + (Number(c.id) === Number(state.currentConvId) ? ' selected' : '');
  item.dataset.convId = c.id;
  item.setAttribute('role', 'option');
  item.setAttribute('aria-selected', String(Number(c.id) === Number(state.currentConvId)));
  item.title = c.title || '未命名对话';

  item.innerHTML =
    `<span class="conv-dot" aria-hidden="true"></span>` +
    `<span class="conv-title"></span>` +
    `<span class="conv-meta">` +
    (c.pinned ? `<span class="conv-pin" title="已置顶">${icon('star', 9)}</span>` : '') +
    `<span class="conv-time"></span>` +
    `</span>` +
    `<span class="conv-actions">` +
    `<button type="button" class="conv-act" title="${c.pinned ? '取消置顶' : '置顶'}" data-act="pin">${icon('star', 13)}</button>` +
    `<button type="button" class="conv-act" title="重命名" data-act="rename">${icon('pencil', 13)}</button>` +
    `<button type="button" class="conv-act danger" title="删除" data-act="del">${icon('trash', 13)}</button>` +
    `</span>`;

  item.querySelector('.conv-title').textContent = c.title || '未命名对话';
  item.querySelector('.conv-time').textContent = formatTime(c.updatedAt || c.createdAt);

  item.addEventListener('click', (e) => {
    if (e.target.closest('.conv-actions')) return;
    selectConversation(c.id);
  });
  item.addEventListener('dblclick', (e) => {
    if (e.target.closest('.conv-actions')) return;
    renameConversation(c);
  });

  item.querySelector('[data-act="pin"]').addEventListener('click', (e) => {
    e.stopPropagation();
    togglePin(c);
  });
  item.querySelector('[data-act="rename"]').addEventListener('click', (e) => {
    e.stopPropagation();
    renameConversation(c);
  });
  item.querySelector('[data-act="del"]').addEventListener('click', (e) => {
    e.stopPropagation();
    deleteConversation(c);
  });
  return item;
}

async function togglePin(conv) {
  try {
    await api.updateConversation(conv.id, { pinned: !conv.pinned });
    await loadConversations();
    toast(conv.pinned ? '已取消置顶' : '已置顶', 'success');
  } catch (e) { toast('置顶失败：' + e.message, 'error'); }
}

/* ---------- 数据 ---------- */
export async function loadConversations() {
  try {
    const list = await api.getConversations();
    state.conversations = Array.isArray(list) ? list : [];
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
    state.conversationUsage = conv.usage || emptyUsage();
    state.attachments = [];
    state.lastTurn = null;
    document.dispatchEvent(new CustomEvent('attachments-change'));
    document.dispatchEvent(new CustomEvent('conv-mode-change'));
    document.dispatchEvent(new CustomEvent('conv-changed'));

    markSelected();
    renderHistory(conv.messages || [], conv.compactions || []);
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
    state.compactions = [];
    state.conversationUsage = emptyUsage();
    state.attachments = [];
    state.lastTurn = null;
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
      state.compactions = [];
      state.conversationUsage = emptyUsage();
      clearChat();
      refreshUsage(null);
      document.dispatchEvent(new CustomEvent('conv-changed'));
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
  document.getElementById('btn-new-conv')?.addEventListener('click', newConversation);
  const newIco = document.getElementById('conv-new-ico');
  if (newIco) newIco.innerHTML = icon('plus', 15);
  document.addEventListener('conversations-refresh', () => { loadConversations(); });
}
