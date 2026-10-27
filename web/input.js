/**
 * input.js — 底部输入框：附件草稿横向卡片（最多 50 个）、精确 token 合计、
 *            聊天 / 知识库模式、Enter 发送、拖拽 / 粘贴附件
 */
import { state, MAX_ATTACHMENTS } from './state.js';
import { icon } from './icons.js';
import {
  fmtInt, toast, confirmDialog, extOf, isImageFile, uid,
} from './util.js';
import { attachmentRow } from './attach-view.js';
import { prepareAttachment, isDuplicateAttachment } from './attach-add.js';
import { openAttachmentPreview } from './attach-preview.js';
import { sendMessage, stopGenerating } from './chat.js';

const MAX_HEIGHT = 132;

let overflow = false;

const $ = (id) => document.getElementById(id);

/* ---------- 输入框高度 ---------- */
function autoResize() {
  const ta = $('chat-input');
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, MAX_HEIGHT)}px`;
}

/* ---------- 附件草稿 ---------- */
function textTokensOf(list) {
  return list.reduce((sum, a) => sum + (Number(a.tokens) || 0), 0);
}

function remainingContext() {
  const quota = Number(state.usage.quota) || 0;
  if (!quota) return Infinity;
  return Math.max(0, quota - (Number(state.usage.used) || 0));
}

function renderAttachments() {
  const strip = $('attachment-strip');
  strip.innerHTML = '';
  if (!state.attachments.length) {
    strip.hidden = true;
  } else {
    strip.hidden = false;
    const row = attachmentRow(state.attachments, {
      compact: true,
      removable: true,
      onPreview: (att, list) => openAttachmentPreview(att, list),
      onRemove: (att) => {
        if (state.sending) return;
        state.attachments = state.attachments.filter((x) => x.id !== att.id);
        renderAttachments();
        updateSendState();
      },
    });
    strip.appendChild(row.el);
  }
  updateAttachSummary();
}

function updateAttachSummary() {
  const summary = $('attach-summary');
  const warning = $('attach-warning');
  const list = state.attachments;
  if (!list.length) {
    summary.hidden = true;
    warning.hidden = true;
    summary.textContent = '';
    warning.textContent = '';
    summary.classList.remove('over');
    return;
  }
  const total = textTokensOf(list);
  const images = list.filter((a) => a.kind === 'image').length;
  const parts = [`附件 ${list.length}/${MAX_ATTACHMENTS}`];
  if (total) parts.push(`合计 ${fmtInt(total)} tokens`);
  if (images) parts.push(`${images} 张图片按上游计费`);
  summary.hidden = false;
  summary.textContent = parts.join(' · ');

  const remain = remainingContext();
  overflow = Number.isFinite(remain) && total > remain;
  summary.classList.toggle('over', overflow);
  if (overflow) {
    warning.hidden = false;
    warning.textContent = `超出剩余上下文 ${fmtInt(total - remain)} tokens`;
  } else if (Number.isFinite(remain) && remain > 0 && total > remain * 0.8) {
    warning.hidden = false;
    warning.textContent = `接近剩余上下文（剩 ${fmtInt(remain)} tokens）`;
  } else {
    warning.hidden = true;
    warning.textContent = '';
  }
}

function placeholderText() {
  if (state.quotaFull) return '上下文已达上限，请在设置中调大上限或新建对话';
  if (state.convMode === 'kb') return '向知识库提问，自动检索相关资料后回答';
  return '给 DeepSeek 发送消息（也可以只发附件）';
}

function updateSendState() {
  const ta = $('chat-input');
  const btn = $('btn-send');
  const attachBtn = $('btn-attach');
  ta.placeholder = placeholderText();
  attachBtn.disabled = state.convMode !== 'chat' || state.sending;
  attachBtn.title = state.convMode === 'kb'
    ? '知识库模式不使用附件'
    : '添加附件（最多 50 个，支持文档与图片）';

  const has = !!(ta.value.trim() || state.attachments.length);
  const clearBtn = $('btn-clear-draft');
  if (clearBtn) clearBtn.hidden = !has || state.sending;
  if (state.sending) {
    btn.disabled = false;
    return;
  }
  btn.disabled = !has || state.quotaFull || overflow;
  btn.title = btn.disabled ? (overflow ? '附件超出剩余上下文' : '发送') : '发送';
}

/* ---------- 添加附件 ---------- */
async function addAttachmentFiles(fileList) {
  if (state.convMode !== 'chat') {
    toast('知识库模式不使用附件，请切换到聊天模式', 'error');
    return;
  }
  const files = Array.from(fileList || []);
  for (const file of files) {
    if (state.attachments.length >= MAX_ATTACHMENTS) {
      toast(`附件最多 ${MAX_ATTACHMENTS} 个`, 'error');
      break;
    }
    if (!file || !file.name || file.name === '.DS_Store' || file.name.startsWith('._')) continue;
    if (isDuplicateAttachment(state.attachments, file)) {
      toast(`已添加过：${file.name}`, 'error');
      continue;
    }

    const item = {
      id: uid('att'), name: file.name,
      kind: isImageFile(file) ? 'image' : 'text',
      ext: extOf(file.name), size: file.size,
      tokens: null, status: 'parsing', text: '',
    };
    state.attachments.push(item);
    renderAttachments();
    updateSendState();
    try {
      const ready = await prepareAttachment(file, item.id);
      Object.assign(item, ready);
      item.status = 'ready';
      if (ready.truncated) toast(`${file.name} 过长，已截断到单附件上限`, 'info', 3000);
    } catch (e) {
      state.attachments = state.attachments.filter((x) => x.id !== item.id);
      toast(e.message || `添加失败：${file.name}`, 'error');
    }
    renderAttachments();
    updateSendState();
  }
  updateAttachSummary();
}

/* ---------- 模式切换 ---------- */
function renderMode() {
  const chatBtn = $('mode-chat');
  const kbBtn = $('mode-kb');
  const chatOn = state.convMode === 'chat';
  chatBtn.classList.toggle('active', chatOn);
  kbBtn.classList.toggle('active', !chatOn);
  chatBtn.setAttribute('aria-selected', String(chatOn));
  kbBtn.setAttribute('aria-selected', String(!chatOn));
  updateSendState();
}

async function switchMode(mode) {
  if (state.sending) { toast('生成中不能切换模式', 'error'); return; }
  if (state.convMode === mode) return;
  if (mode === 'kb' && state.attachments.length) {
    const ok = await confirmDialog(
      '知识库模式不会发送附件，切换后会清空本次待发的附件。',
      { title: '切换模式', okText: '切换并清空', danger: false },
    );
    if (!ok) return;
    state.attachments = [];
    document.dispatchEvent(new CustomEvent('attachments-change'));
  }
  state.convMode = mode;
  renderMode();
  if (state.currentConvId) {
    api.updateConversation(state.currentConvId, { mode }).catch((e) => {
      toast('模式保存失败：' + e.message, 'error');
    });
  }
}

/* ---------- 发送 ---------- */
function doSend() {
  const ta = $('chat-input');
  const text = ta.value.trim();
  if (!text && !state.attachments.length) return;
  if (state.quotaFull) { toast('上下文已达上限', 'error'); return; }
  if (overflow) { toast('附件超出剩余上下文，请减少附件', 'error'); return; }
  ta.value = '';
  autoResize();
  updateSendState();
  sendMessage(text);
}

/* ---------- 拖拽 / 粘贴 ---------- */
function bindDrop() {
  const composer = $('composer');
  let depth = 0;
  ['dragenter', 'dragover'].forEach((evt) => {
    composer.addEventListener(evt, (e) => {
      if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      if (evt === 'dragenter') depth++;
      composer.classList.add('drop-active');
    });
  });
  composer.addEventListener('dragleave', (e) => {
    if (!e.dataTransfer) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0 || e.target === composer) composer.classList.remove('drop-active');
  });
  composer.addEventListener('drop', async (e) => {
    if (!e.dataTransfer) return;
    e.preventDefault();
    depth = 0;
    composer.classList.remove('drop-active');
    await addAttachmentFiles(e.dataTransfer.files);
  });

  $('chat-input').addEventListener('paste', async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (const item of items) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      await addAttachmentFiles(files);
    }
  });
}

/* ---------- 初始化 ---------- */
export function initInput() {
  const ta = $('chat-input');
  const btn = $('btn-send');

  // 回形针图标：直接用路径，避免图标库缺项
  $('btn-attach').innerHTML =
    '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M11.5 4.5v6a3.5 3.5 0 1 1-7 0V5a2.5 2.5 0 0 1 5 0v5.5a1.5 1.5 0 0 1-3 0V5.5a.5.5 0 0 1 1 0v5a.5.5 0 0 0 1 0V5a1.5 1.5 0 0 0-3 0v5.5a2.5 2.5 0 0 0 5 0V4.5a2.5 2.5 0 0 0-5 0V10"/></svg>';
  btn.innerHTML = icon('arrowUp', 16);

  ta.addEventListener('input', () => { autoResize(); updateSendState(); });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (state.sending) return;
      doSend();
    }
  });

  btn.addEventListener('click', () => {
    if (state.sending) { stopGenerating(); return; }
    doSend();
  });

  $('btn-clear-draft').addEventListener('click', () => {
    if (state.sending) return;
    ta.value = '';
    state.attachments = [];
    document.dispatchEvent(new CustomEvent('attachments-change'));
    autoResize();
    updateSendState();
    ta.focus();
  });

  $('btn-attach').addEventListener('click', () => {
    if (state.convMode !== 'chat') {
      toast('知识库模式不使用附件，请切换到聊天模式', 'error');
      return;
    }
    $('chat-attach-input').click();
  });
  $('chat-attach-input').addEventListener('change', async (e) => {
    await addAttachmentFiles(e.target.files);
    e.target.value = '';
  });

  $('mode-chat').addEventListener('click', () => switchMode('chat'));
  $('mode-kb').addEventListener('click', () => switchMode('kb'));

  document.addEventListener('attachments-change', () => {
    renderAttachments();
    updateSendState();
  });
  document.addEventListener('conv-mode-change', renderMode);
  document.addEventListener('conv-changed', () => {
    ta.value = '';
    autoResize();
    renderAttachments();
    renderMode();
  });
  document.addEventListener('chat-sending-change', updateSendState);
  document.addEventListener('quota-change', updateSendState);
  document.addEventListener('usage-change', updateAttachSummary);

  bindDrop();
  renderAttachments();
  renderMode();
  updateSendState();
  autoResize();
}
