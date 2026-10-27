/**
 * app.js — 入口：初始化顺序、全局弹窗、首屏数据
 */
import { state } from './state.js';
import { api } from './api.js';
import { icon } from './icons.js';
import { toast } from './util.js';
import { initLayout } from './layout.js';
import { initTopbar, loadModels, refreshUsage, setDepth } from './topbar.js';
import { initTree, loadTree } from './tree.js';
import { initFinder } from './finder.js';
import { initPreview } from './preview.js';
import { initAttachmentPreview } from './attach-preview.js';
import { initConversations, loadConversations, selectConversation } from './conversations.js';
import { initChat, clearChat } from './chat.js';
import { initInput } from './input.js';
import { initSettings } from './settings.js';
import { initDataio } from './dataio.js';
import { initSearch } from './search.js';

function bindModalChrome() {
  document.querySelectorAll('.modal-head [data-close], .modal-head .icon-btn[data-close]').forEach((btn) => {
    if (!btn.innerHTML.trim()) btn.innerHTML = icon('close', 14);
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-close');
      const mask = id ? document.getElementById(id) : btn.closest('.modal-mask');
      if (!mask) return;
      mask.hidden = true;
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // 先让浮层（右键菜单 / 右侧定位 / 用量弹层）自己处理 Esc
    if (document.querySelector('.ctx-menu')) return;
    const qnPanel = document.getElementById('qn-panel');
    if (qnPanel && !qnPanel.hidden) return;
    const usagePop = document.getElementById('usage-pop');
    if (usagePop && !usagePop.hidden) return;
    for (const id of ['search-modal', 'settings-modal', 'preview-modal', 'finder-modal']) {
      const mask = document.getElementById(id);
      if (!mask || mask.hidden) continue;
      mask.hidden = true;
      return;
    }
  });

  // 防止把文件拖到窗口其它地方时浏览器直接打开文件
  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault();
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.sending) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

async function loadBootSettings() {
  try {
    const s = await api.getSettings();
    state.settings = s;
    state.model = s.model || state.model;
    state.tokenizer = s.tokenizer || state.tokenizer;
    if (s.depth) setDepth(s.depth, { persist: false });
    if (Array.isArray(s.models) && s.models.length) state.models = s.models;
  } catch (e) {
    console.warn('settings load failed', e);
  }
}

async function bootstrap() {
  // 1. 组件初始化（事件绑定；layout 先读取持久化布局）
  initLayout();
  initTopbar();
  initTree();
  initFinder();
  initPreview();
  initAttachmentPreview();
  initConversations();
  initChat();
  initInput();
  initSettings();
  initDataio();
  initSearch();
  bindModalChrome();

  // 2. 健康检查（失败仅提示，不阻塞界面）
  try {
    await api.health();
  } catch (e) {
    toast('后端服务未就绪：' + e.message, 'error', 5000);
  }

  // 3. 设置 / 模型 / 用量 / 目录树 / 对话列表
  await loadBootSettings();
  await Promise.allSettled([
    loadModels(),
    refreshUsage(),
    loadTree({ silent: true }),
    loadConversations(),
  ]);

  // 4. 默认打开最近一条对话
  if (state.conversations.length) {
    const withMessages = state.conversations.find((c) => Number(c.messageCount) > 0);
    await selectConversation((withMessages || state.conversations[0]).id);
  } else {
    clearChat();
    refreshUsage(null);
  }

  state.ready = true;
  document.dispatchEvent(new CustomEvent('app-ready'));
  document.getElementById('chat-input')?.focus();
}

bootstrap().catch((e) => {
  console.error(e);
  toast('页面初始化失败：' + e.message, 'error', 6000);
});
