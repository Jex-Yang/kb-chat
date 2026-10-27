/**
 * chat.js — 对话流：历史渲染 / SSE 流式 / 思维链 / 附件卡片 /
 *           单条 token 明细 / 对话末尾 token 汇总 / 右侧快速定位
 */
import { state, MAX_ATTACHMENTS } from './state.js';
import { api } from './api.js';
import { icon } from './icons.js';
import {
  fmtInt, fmtDuration, fmtSeconds, fmtPct, fmtTps,
  mdRender, throttle, toast, copyText, isNearBottom, scrollToBottom,
  extOf, isImageFile, uid,
} from './util.js';
import { attachmentRow, normalizeAttachmentMeta } from './attach-view.js';
import { openAttachmentPreview } from './attach-preview.js';
import { prepareAttachment, isDuplicateAttachment } from './attach-add.js';
import { refreshUsage, setSpeed } from './topbar.js';

let abortController = null;
let stickToBottom = true;
let navRaf = null;
let pinnedNavIndex = null;
let lastReasoningAt = 0;

/* ============================================================
   历史 / 空态
   ============================================================ */
export function clearChat() {
  const wrap = document.getElementById('messages');
  const empty = document.getElementById('chat-empty');
  wrap.innerHTML = '';
  wrap.hidden = true;
  empty.hidden = false;
  state.currentMessages = [];
  setSpeed(null, false);
  updateQuickNav();
}

function showMessages() {
  document.getElementById('chat-empty').hidden = true;
  document.getElementById('messages').hidden = false;
}

export function renderHistory(messages) {
  pinnedNavIndex = null;
  clearQnPad();
  const wrap = document.getElementById('messages');
  wrap.innerHTML = '';
  state.currentMessages = Array.isArray(messages) ? messages.slice() : [];
  if (!state.currentMessages.length) {
    clearChat();
    return;
  }
  state.currentMessages.forEach((m) => {
    if (m.role === 'user') {
      wrap.appendChild(buildUserBlock(m));
    } else if (m.role === 'assistant') {
      wrap.appendChild(buildAiBlock({
        content: m.content,
        reasoning: m.reasoning,
        promptTokens: m.promptTokens,
        completionTokens: m.completionTokens,
        elapsedMs: m.elapsedMs,
        cacheHitTokens: m.cacheHitTokens,
        cacheMissTokens: m.cacheMissTokens,
        messageId: m.id,
        createdAt: m.createdAt,
      }).el);
    }
  });
  showMessages();
  stickToBottom = true;
  updateQuickNav();
  scrollToBottom(document.getElementById('chat-scroll'));
  const last = [...state.currentMessages].reverse().find((m) => m.role === 'assistant');
  setSpeed(last ? tpsOf(last.completionTokens, last.elapsedMs) : null, false);
}

/* ============================================================
   用户消息
   ============================================================ */
function legacyAttachments(content) {
  const text = String(content || '');
  const out = [];
  const re = /【附件：([^】\n]+)】/g;
  let m;
  while ((m = re.exec(text))) {
    const name = m[1].trim();
    if (!name) continue;
    out.push({ name, kind: 'text', ext: extOf(name), size: 0, tokens: null, status: 'ready' });
  }
  return out;
}

function attachmentsOf(m) {
  const meta = (m && Array.isArray(m.attachments) ? m.attachments : [])
    .map(normalizeAttachmentMeta).filter(Boolean);
  if (meta.length) return meta;
  return legacyAttachments(m && m.content);
}

function displayTextOf(m) {
  const atts = attachmentsOf(m);
  let text = m && m.displayContent != null ? String(m.displayContent) : String((m && m.content) || '');
  if (m && m.displayContent == null) {
    const idx = text.search(/\n?【附件：/);
    if (idx >= 0) text = text.slice(0, idx);
    if (atts.length && text.trim() === '请阅读并分析以上附件内容') text = '';
    if (atts.length && /^请阅读并分析以上附件内容\s*$/.test(text)) text = '';
  }
  return text.trim();
}

async function switchTurnVersion(m, targetVersion) {
  if (state.sending) { toast('请等待当前回复完成或先停止', 'error'); return; }
  const turnIndex = Number(m.turnIndex);
  if (!Number.isInteger(turnIndex) || turnIndex < 0) {
    toast('找不到该消息的轮次', 'error');
    return;
  }
  try {
    const conv = await api.activateTurnVersion(state.currentConvId, turnIndex, targetVersion);
    state.currentMessages = conv.messages || [];
    state.conversationUsage = conv.usage || state.conversationUsage;
    if (conv.title) state.currentConvTitle = conv.title;
    renderHistory(state.currentMessages);
    refreshUsage(state.currentConvId);
    const blocks = [...document.querySelectorAll('#messages .msg-user-wrap')];
    blocks[turnIndex]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    toast(`已切换到第 ${targetVersion} 版`, 'success', 1400);
  } catch (e) {
    toast('切换版本失败：' + e.message, 'error');
  }
}

export function buildUserBlock(m) {
  const wrap = document.createElement('div');
  wrap.className = 'msg-user-wrap';
  if (m.id != null) wrap.dataset.msgId = m.id;
  const text = m.displayContent != null ? String(m.displayContent) : displayTextOf(m);
  const atts = attachmentsOf(m);

  if (atts.length) {
    const row = attachmentRow(atts, {
      compact: false, className: 'msg-attach-row',
      onPreview: (att, list) => openAttachmentPreview(att, list, m),
    });
    wrap.appendChild(row.el);
  }

  const bubble = document.createElement('div');
  bubble.className = 'msg-user';
  bubble.textContent = text;
  wrap.appendChild(bubble);

  const canEdit = !atts.some((a) => a.kind === 'image');
  const vCount = Math.max(1, Number(m.versionCount) || 1);
  const vActive = Math.min(vCount, Math.max(1, Number(m.activeVersion) || 1));
  const actions = document.createElement('div');
  actions.className = 'msg-user-actions';
  actions.innerHTML =
    `<button type="button" class="msg-action icon-only" data-act="copy" title="复制" aria-label="复制">${icon('copy', 13)}</button>` +
    (canEdit ? `<button type="button" class="msg-action icon-only" data-act="edit" title="修改" aria-label="修改">${icon('pencil', 13)}</button>` : '') +
    (vCount > 1
      ? `<span class="msg-version-nav">` +
        `<button type="button" class="msg-ver-btn" data-act="prev" title="上一版本" aria-label="上一版本"${vActive <= 1 ? ' disabled' : ''}>${icon('chevronLeft', 12)}</button>` +
        `<span class="msg-ver-label">${vActive}/${vCount}</span>` +
        `<button type="button" class="msg-ver-btn" data-act="next" title="下一版本" aria-label="下一版本"${vActive >= vCount ? ' disabled' : ''}>${icon('chevronRight', 12)}</button>` +
        `</span>`
      : '');
  wrap.appendChild(actions);

  const verPrev = actions.querySelector('[data-act="prev"]');
  const verNext = actions.querySelector('[data-act="next"]');
  if (verPrev) verPrev.addEventListener('click', (e) => {
    e.stopPropagation();
    switchTurnVersion(m, vActive - 1);
  });
  if (verNext) verNext.addEventListener('click', (e) => {
    e.stopPropagation();
    switchTurnVersion(m, vActive + 1);
  });

  actions.querySelector('[data-act="copy"]').addEventListener('click', async () => {
    const content = text || atts.map((a) => a.name).join('\n');
    const ok = await copyText(content);
    toast(ok ? '已复制' : '复制失败，请检查剪贴板权限', ok ? 'success' : 'error');
  });
  const editBtn = actions.querySelector('[data-act="edit"]');
  if (editBtn) {
    editBtn.addEventListener('click', async () => {
      if (state.sending) { toast('请等待当前回复完成或先停止', 'error'); return; }
      let live = null;
      const domId = wrap.dataset.msgId;
      if (domId != null) {
        live = state.currentMessages.find((x) => String(x.id) === String(domId));
      }
      if (!live) {
        // 最新一条消息的气泡建立时可能还没有 id；发完后 state 里已有 id，但闭包仍是旧的。
        try {
          const conv = await api.getConversation(state.currentConvId);
          state.currentMessages = conv.messages || [];
          state.conversationUsage = conv.usage || state.conversationUsage;
          if (conv.title) state.currentConvTitle = conv.title;
          const id = wrap.dataset.msgId;
          if (id != null) {
            live = state.currentMessages.find((x) => String(x.id) === String(id));
          }
          if (!live) {
            const blocks = [...document.querySelectorAll('#messages .msg-user-wrap')];
            const pos = blocks.indexOf(wrap);
            const users = state.currentMessages.filter((x) => x.role === 'user');
            if (pos >= 0 && pos < users.length) live = users[pos];
          }
          if (live) wrap.dataset.msgId = live.id;
        } catch { /* 未保存消息保持原状 */ }
      }
      startEditUserMessage(wrap, live || m);
    });
  }
  return wrap;
}

/** 从旧消息 content 中还原文本附件全文，供“修改”后一起重发 */
function rebuildAttachmentsFromMessage(m) {
  const meta = attachmentsOf(m).filter((a) => a.kind !== 'image');
  const blocks = [];
  const re = /【附件：([^】\n]+)】\n```\n([\s\S]*?)\n```/g;
  let x;
  while ((x = re.exec(String(m.content || '')))) {
    blocks.push({ name: x[1], text: x[2] });
  }
  return meta.map((a) => {
    const block = blocks.find((b) => b.name === a.name);
    if (!block) return null;
    return {
      name: a.name, kind: 'text', ext: a.ext || extOf(a.name),
      size: a.size || 0, tokens: a.tokens ?? null,
      text: block.text, status: 'ready',
    };
  }).filter(Boolean);
}

let activeEditAdd = null;

/* 中途修改：原位替换输入框，附件可增删，保存后截断该消息之后的消息并重发 */
function startEditUserMessage(userWrap, m) {
  const original = attachmentsOf(m);
  const originalTextCount = original.filter((a) => a.kind !== 'image').length;
  let editAtts = rebuildAttachmentsFromMessage(m).map((a) => ({
    ...a, id: a.id || uid('edit'),
  }));
  const missing = Math.max(0, originalTextCount - editAtts.length);

  const editor = document.createElement('div');
  editor.className = 'msg-edit-box';
  editor.innerHTML =
    `<textarea class="msg-edit-textarea" aria-label="修改消息"></textarea>` +
    `<div class="msg-edit-atts" hidden></div>` +
    `<div class="msg-edit-bar">` +
    `<button type="button" class="msg-edit-attach" data-act="attach" title="添加附件">${icon('paperclip', 13)}附件</button>` +
    `<span class="msg-edit-hint"></span>` +
    `<span class="flex-spacer"></span>` +
    `<button type="button" class="btn btn-ghost btn-sm" data-act="cancel">取消</button>` +
    `<button type="button" class="btn btn-danger btn-sm" data-act="overwrite" title="删除此消息及之后的对话并重新发送">覆盖并发送</button>` +
    `</div>`;

  const ta = editor.querySelector('.msg-edit-textarea');
  const attBox = editor.querySelector('.msg-edit-atts');
  const hint = editor.querySelector('.msg-edit-hint');
  const attachBtn = editor.querySelector('[data-act="attach"]');
  ta.value = displayTextOf(m);

  const scrollEditorIntoView = () => {
    const sc = document.getElementById('chat-scroll');
    if (!sc) return;
    const r = editor.getBoundingClientRect();
    const sr = sc.getBoundingClientRect();
    if (r.bottom > sr.bottom - 12) {
      sc.scrollBy({ top: r.bottom - sr.bottom + 20, behavior: 'smooth' });
    } else if (r.top < sr.top + 12) {
      sc.scrollBy({ top: r.top - sr.top - 16, behavior: 'smooth' });
    }
  };

  const updateHint = () => {
    const n = editAtts.length;
    const parts = ['保存会删除这条消息及之后的对话并重新计算 token；旧版本可在消息下方左右切换'];
    if (n) parts.push(`${n} 个附件会一起重发`);
    if (missing) parts.push(`有 ${missing} 个旧附件无法还原`);
    hint.textContent = parts.join('，');
    attachBtn.disabled = n >= MAX_ATTACHMENTS || state.sending;
  };

  const renderEditAtts = () => {
    attBox.innerHTML = '';
    if (!editAtts.length) {
      attBox.hidden = true;
    } else {
      attBox.hidden = false;
      const row = attachmentRow(editAtts, {
        compact: true,
        removable: true,
        onPreview: (att, list) => openAttachmentPreview(att, list, m),
        onRemove: (att) => {
          editAtts = editAtts.filter((x) => x.id !== att.id);
          renderEditAtts();
        },
      });
      attBox.appendChild(row.el);
    }
    updateHint();
  };

  const addFiles = async (files) => {
    for (const file of files) {
      if (editAtts.length >= MAX_ATTACHMENTS) {
        toast(`附件最多 ${MAX_ATTACHMENTS} 个`, 'error');
        break;
      }
      if (!file || !file.name || file.name === '.DS_Store' || file.name.startsWith('._')) continue;
      if (isDuplicateAttachment(editAtts, file)) {
        toast(`已添加过：${file.name}`, 'error');
        continue;
      }
      const item = {
        id: uid('edit'), name: file.name,
        kind: isImageFile(file) ? 'image' : 'text',
        ext: extOf(file.name), size: file.size,
        tokens: null, status: 'parsing', text: '',
      };
      editAtts.push(item);
      renderEditAtts();
      try {
        const ready = await prepareAttachment(file, item.id);
        Object.assign(item, ready);
        item.status = 'ready';
        if (ready.truncated) toast(`${file.name} 过长，已截断到单附件上限`, 'info', 3000);
      } catch (e) {
        editAtts = editAtts.filter((x) => x.id !== item.id);
        toast(e.message || `添加失败：${file.name}`, 'error');
      }
      renderEditAtts();
      setTimeout(scrollEditorIntoView, 0);
    }
  };

  activeEditAdd = addFiles;
  userWrap.replaceWith(editor);
  renderEditAtts();
  ta.focus();
  const resize = () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
  };
  resize();
  ta.addEventListener('input', resize);
  setTimeout(scrollEditorIntoView, 0);

  const cleanup = () => {
    if (activeEditAdd === addFiles) activeEditAdd = null;
  };

  attachBtn.addEventListener('click', () => {
    const input = document.getElementById('edit-attach-input');
    if (input) {
      input.value = '';
      input.click();
    }
  });

  const validate = () => {
    const newText = ta.value.trim();
    if (!newText && !editAtts.length) { toast('内容不能为空', 'error'); return null; }
    if (state.sending) { toast('请等待当前回复完成或先停止', 'error'); return null; }
    if (missing) {
      toast(`有 ${missing} 个旧附件内容无法还原，暂时不能保存`, 'error');
      return null;
    }
    if (editAtts.some((a) => a.status !== 'ready')) {
      toast('附件还在解析中，请稍候', 'error');
      return null;
    }
    return {
      newText,
      meta: editAtts.map((a) => ({
        name: a.name, kind: a.kind, ext: a.ext || '', size: a.size || 0,
        tokens: a.tokens ?? null, thumb: a.thumb || null, preview: a.preview || null, text: a.text || null,
      })),
    };
  };

  const sendEdited = async (newText, meta) => {
    const newBlock = buildUserBlock({
      id: null, content: newText, displayContent: newText, attachments: meta,
    });
    let node = editor;
    while (node.nextElementSibling) node.nextElementSibling.remove();
    editor.replaceWith(newBlock);
    showMessages();
    stickToBottom = true;
    scrollToBottom(document.getElementById('chat-scroll'));
    state.lastTurn = {
      text: newText, displayText: newText, attachments: editAtts, mode: state.convMode,
    };
    await sendStream(newText, {
      attachments: editAtts, displayText: newText, anchor: newBlock,
    });
  };

  const saveOverwrite = async () => {
    const checked = validate();
    if (!checked) return;
    const users = state.currentMessages.filter((x) => x.role === 'user');
    let turnIndex = Number.isInteger(Number(m.turnIndex))
      ? Number(m.turnIndex)
      : users.findIndex((x) => String(x.id) === String(m.id));
    if (m.id == null) turnIndex = users.length;

    // 先把旧版本存下来（用户消息 + 对应回答 + token），左右箭头可以切回。
    if (m.id != null && turnIndex >= 0) {
      try {
        await api.snapshotTurn(state.currentConvId, turnIndex);
      } catch (e) {
        toast('保存旧版本失败：' + e.message, 'error');
        return;
      }
    }

    if (m.id != null) {
      try {
        await api.truncateMessages(state.currentConvId, m.id);
      } catch (e) {
        toast('删除后续消息失败：' + e.message, 'error');
        return;
      }
      const idx = state.currentMessages.findIndex((x) => String(x.id) === String(m.id));
      if (idx >= 0) state.currentMessages = state.currentMessages.slice(0, idx);
    }

    cleanup();
    toast('已删除后续消息，正在重新计算 token', 'info', 2500);
    await sendEdited(checked.newText, checked.meta);

    if (turnIndex >= 0) {
      try {
        await api.snapshotTurn(state.currentConvId, turnIndex);
      } catch { /* 新版本保存失败时仍保留旧版本 */ }
      try {
        const conv = await api.getConversation(state.currentConvId);
        state.currentMessages = conv.messages || [];
        state.conversationUsage = conv.usage || state.conversationUsage;
        if (conv.title) state.currentConvTitle = conv.title;
        renderHistory(state.currentMessages);
        refreshUsage(state.currentConvId);
        const blocks = [...document.querySelectorAll('#messages .msg-user-wrap')];
        blocks[turnIndex]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } catch { /* 忽略刷新失败 */ }
    }
  };

  editor.querySelector('[data-act="cancel"]').addEventListener('click', () => {
    cleanup();
    editor.replaceWith(buildUserBlock(m));
  });
  editor.querySelector('[data-act="overwrite"]').addEventListener('click', saveOverwrite);
}

/* ============================================================
   AI 消息
   ============================================================ */
function cacheRateOf(hit, miss) {
  const h = Number(hit);
  const m = Number(miss);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  if (h + m <= 0) return null;
  return h / (h + m);
}

function tpsOf(completionTokens, elapsedMs) {
  const c = Number(completionTokens) || 0;
  const ms = Number(elapsedMs) || 0;
  if (!c || !ms) return null;
  return c / (ms / 1000);
}

function tokenText(promptTokens, completionTokens, elapsedMs, cacheHit, cacheMiss) {
  const p = Number(promptTokens) || 0;
  const c = Number(completionTokens) || 0;
  if (!p && !c) return '';
  const parts = [`输入 ${fmtInt(p)}`, `输出 ${fmtInt(c)}`, `合计 ${fmtInt(p + c)} tokens`];
  const tps = tpsOf(c, elapsedMs);
  if (tps) parts.push(`${fmtTps(tps)} tok/s`);
  if (elapsedMs) parts.push(fmtDuration(elapsedMs));
  const rate = cacheRateOf(cacheHit, cacheMiss);
  if (rate != null) parts.push(`缓存 ${fmtPct(rate)}`);
  return parts.join(' · ');
}

function setAiTokens(ai, promptTokens, completionTokens, elapsedMs, cacheHit, cacheMiss) {
  ai.promptTokens = Number(promptTokens) || 0;
  ai.completionTokens = Number(completionTokens) || 0;
  if (cacheHit !== undefined) ai.cacheHitTokens = cacheHit;
  if (cacheMiss !== undefined) ai.cacheMissTokens = cacheMiss;
  const ms = elapsedMs ?? ai.elapsedMs;
  ai.tps = tpsOf(ai.completionTokens, ms);
  const text = tokenText(ai.promptTokens, ai.completionTokens, ms,
    ai.cacheHitTokens, ai.cacheMissTokens);
  ai.tokens.textContent = text;
  ai.tokens.hidden = !text;
}

export function buildAiBlock(init = {}) {
  const el = document.createElement('div');
  el.className = 'msg-ai';
  if (init.messageId != null) el.dataset.msgId = init.messageId;
  el.innerHTML =
    `<button type="button" class="think-toggle" hidden aria-expanded="false">` +
    `<span class="think-caret">${icon('chevronRight', 10)}</span>` +
    `<span class="think-label"></span></button>` +
    `<div class="think-body"></div>` +
    `<div class="md-body"></div>` +
    `<div class="msg-retry" hidden></div>` +
    `<div class="msg-error" hidden><span></span><button type="button" class="link-btn">重试</button></div>` +
    `<div class="typing" hidden><i></i><i></i><i></i></div>` +
    `<div class="msg-foot">` +
    `<div class="msg-actions">` +
    `<button type="button" class="msg-action" data-act="copy">${icon('copy', 11)}复制</button>` +
    `<button type="button" class="msg-action" data-act="regen">${icon('refresh', 11)}重新生成</button>` +
    `</div>` +
    `<div class="msg-tokens" hidden></div>` +
    `</div>`;

  const toggle = el.querySelector('.think-toggle');
  const thinkBody = el.querySelector('.think-body');
  const body = el.querySelector('.md-body');
  const retry = el.querySelector('.msg-retry');
  const errorBox = el.querySelector('.msg-error');
  const typing = el.querySelector('.typing');
  const actions = el.querySelector('.msg-actions');
  const tokens = el.querySelector('.msg-tokens');

  const ai = {
    el, toggle, thinkBody, body, retry, errorBox, typing, actions, tokens,
    contentRaw: init.content || '',
    reasoningRaw: init.reasoning || '',
    promptTokens: Number(init.promptTokens) || 0,
    completionTokens: Number(init.completionTokens) || 0,
    elapsedMs: Number(init.elapsedMs) || 0,
    cacheHitTokens: init.cacheHitTokens ?? null,
    cacheMissTokens: init.cacheMissTokens ?? null,
    observedTokens: 0,
    tps: null,
    streaming: false,
    finalized: false,
    createdAt: init.createdAt || null,
  };

  if (ai.reasoningRaw) {
    toggle.hidden = false;
    toggle.querySelector('.think-label').textContent =
      `已深度思考（用时 ${Math.max(1, fmtSeconds(ai.elapsedMs))} 秒）`;
    thinkBody.textContent = ai.reasoningRaw;
  } else {
    toggle.hidden = true;
  }
  toggle.addEventListener('click', () => {
    if (ai.streaming) return;
    const open = toggle.classList.toggle('open');
    thinkBody.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
  });

  body.innerHTML = mdRender(ai.contentRaw);
  setAiTokens(ai, ai.promptTokens, ai.completionTokens, ai.elapsedMs, ai.cacheHitTokens, ai.cacheMissTokens);

  actions.querySelector('[data-act="copy"]').addEventListener('click', async () => {
    const ok = await copyText(ai.contentRaw || '');
    toast(ok ? '已复制' : '复制失败，请检查剪贴板权限', ok ? 'success' : 'error');
  });
  actions.querySelector('[data-act="regen"]').addEventListener('click', () => {
    if (state.sending) { toast('请等待当前回复完成或先停止', 'error'); return; }
    regenerateInPlace(ai);
  });
  errorBox.querySelector('.link-btn').addEventListener('click', () => {
    if (state.sending) { toast('请等待当前回复完成或先停止', 'error'); return; }
    retryFailedInPlace(ai);
  });

  return ai;
}

function showAiError(ai, message) {
  ai.errorBox.hidden = false;
  ai.errorBox.querySelector('span').textContent = message ? `生成失败：${message}` : '生成失败，请重试';
  ai.typing.hidden = true;
}

function finalize(ai, { stopped = false } = {}) {
  if (ai.finalized) return;
  ai.finalized = true;
  ai.streaming = false;
  ai.typing.hidden = true;
  ai.retry.hidden = true;
  ai.body.innerHTML = mdRender(ai.contentRaw);
  if (ai.reasoningRaw) {
    ai.toggle.hidden = false;
    ai.toggle.classList.remove('studio', 'streaming');
    ai.toggle.classList.remove('open');
    ai.thinkBody.classList.remove('open');
    ai.toggle.setAttribute('aria-expanded', 'false');
    const label = ai.elapsedMs
      ? `已深度思考（用时 ${Math.max(1, fmtSeconds(ai.elapsedMs))} 秒）`
      : (stopped ? '已深度思考（已停止）' : '已深度思考');
    ai.toggle.querySelector('.think-label').textContent = label;
  }
  if (stopped && !ai.contentRaw && !ai.reasoningRaw) {
    ai.body.innerHTML = '<p style="color:var(--text-3)">已停止生成</p>';
  }
  ai.actions.hidden = false;
  setAiTokens(ai, ai.promptTokens, ai.completionTokens, ai.elapsedMs, ai.cacheHitTokens, ai.cacheMissTokens);
}

/* ============================================================
   发送 / SSE
   ============================================================ */
function attachmentPayload(list, mode) {
  if (mode !== 'chat') return [];
  return (list || []).map((a) => {
    if (a.kind === 'image') {
      return {
        name: a.name, kind: 'image', ext: a.ext || '', size: a.size || 0,
        tokens: a.tokens || null, dataUrl: a.dataUrl || null, thumb: a.thumb || null,
        preview: a.preview || null,
      };
    }
    return {
      name: a.name, kind: 'text', ext: a.ext || '', size: a.size || 0,
      tokens: a.tokens || null, text: a.text || '',
    };
  });
}

export async function sendMessage(text) {
  const content = String(text ?? '').trim();
  const snapshot = state.attachments.slice();
  if ((!content && !snapshot.length) || state.sending || state.quotaFull) return;

  if (!state.currentConvId) {
    try {
      const res = await api.createConversation({ mode: state.convMode });
      state.currentConvId = Number(res.id);
      state.convMode = state.convMode === 'kb' ? 'kb' : 'chat';
      document.dispatchEvent(new CustomEvent('conv-mode-change'));
      document.dispatchEvent(new CustomEvent('conversations-refresh'));
    } catch (e) { toast('创建对话失败：' + e.message, 'error'); return; }
  }

  state.lastTurn = {
    text: content,
    displayText: content,
    attachments: snapshot,
    mode: state.convMode,
  };
  state.attachments = [];
  document.dispatchEvent(new CustomEvent('attachments-change'));

  const meta = snapshot.map((a) => ({
    name: a.name, kind: a.kind, ext: a.ext || '', size: a.size || 0,
    tokens: a.tokens ?? null, thumb: a.thumb || null,
    preview: a.preview || null, text: a.text || null,
  }));
  const wrap = document.getElementById('messages');
  showMessages();
  const userBlock = buildUserBlock({
    id: null, content, displayContent: content, attachments: meta,
  });
  wrap.appendChild(userBlock);
  stickToBottom = true;
  scrollToBottom(document.getElementById('chat-scroll'));

  await sendStream(content, {
    attachments: snapshot, displayText: content, anchor: userBlock,
  });
}

async function sendStream(text, { attachments = [], displayText = text, anchor = null } = {}) {
  clearQnPad();
  const content = String(text ?? '').trim();
  if ((!content && !attachments.length) || state.sending) return;

  const wrap = document.getElementById('messages');
  showMessages();
  if (!anchor) {
    // 原位重试/重新生成：不新增用户气泡
    anchor = wrap.lastElementChild && wrap.lastElementChild.classList.contains('msg-user-wrap')
      ? wrap.lastElementChild : null;
  }

  const ai = buildAiBlock({});
  ai.streaming = true;
  ai.typing.hidden = false;
  wrap.appendChild(ai.el);
  stickToBottom = true;
  scrollToBottom(document.getElementById('chat-scroll'));

  state.sending = true;
  setSendButtonSending(true);
  document.dispatchEvent(new CustomEvent('chat-sending-change'));

  abortController = new AbortController();
  const startedAt = Date.now();
  setSpeed(0, true);
  const speedTimer = setInterval(() => {
    const sec = (Date.now() - startedAt) / 1000;
    if (ai.observedTokens > 0 && sec > 0.25) {
      setSpeed(ai.observedTokens / sec, true);
    }
  }, 350);
  const renderThrottled = throttle(() => {
    ai.body.innerHTML = mdRender(ai.contentRaw);
    if (stickToBottom) scrollToBottom(document.getElementById('chat-scroll'));
  }, 90);

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: abortController.signal,
      body: JSON.stringify({
        conversationId: state.currentConvId,
        message: content,
        displayMessage: displayText,
        mode: state.convMode,
        model: state.model || undefined,
        depth: state.depth,
        attachments: attachmentPayload(attachments, state.convMode),
      }),
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        if (j && j.detail) detail = j.detail;
      } catch { /* ignore */ }
      throw new Error(detail);
    }
    if (!res.body) throw new Error('当前浏览器不支持流式响应');

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let gotDone = false;
    let hadError = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const payloads = [];
        for (const line of frame.split('\n')) {
          const clean = line.replace(/\r$/, '');
          if (clean.startsWith('data: ')) payloads.push(clean.slice(6));
          else if (clean.startsWith('data:')) payloads.push(clean.slice(5));
        }
        for (const p of payloads) {
          if (p === '[DONE]') { gotDone = true; break; }
          let evt;
          try { evt = JSON.parse(p); } catch { continue; }
          handleEvent(evt, ai, renderThrottled, startedAt);
          if (evt && evt.type === 'error') hadError = true;
        }
        if (gotDone) break;
      }
      if (gotDone || hadError) break;
    }
    if (hadError) showAiError(ai);
  } catch (e) {
    if (e && e.name === 'AbortError') {
      ai.elapsedMs = Date.now() - startedAt;
      finalize(ai, { stopped: true });
      toast('已停止生成', 'info');
    } else {
      ai.elapsedMs = Date.now() - startedAt;
      showAiError(ai, e.message);
    }
  } finally {
    clearInterval(speedTimer);
    if (!ai.elapsedMs) ai.elapsedMs = Date.now() - startedAt;
    finalize(ai, {});
    if (ai.tps) setSpeed(ai.tps, false);
    else setSpeed(null, false);
    state.sending = false;
    setSendButtonSending(false);
    abortController = null;
    document.dispatchEvent(new CustomEvent('chat-sending-change'));
    refreshUsage(state.currentConvId);
    document.dispatchEvent(new CustomEvent('conversations-refresh'));
    await syncMessageIds(ai);
      updateQuickNav();
  }
}

function handleEvent(evt, ai, renderThrottled, startedAt) {
  switch (evt.type) {
    case 'reasoning': {
      if (evt.delta) ai.observedTokens += 1;
      ai.reasoningRaw += evt.delta || '';
      ai.toggle.hidden = false;
      ai.typing.hidden = false;
      ai.thinkBody.textContent = ai.reasoningRaw;
      ai.thinkBody.classList.add('open');
      ai.toggle.classList.add('open', 'streaming');
      ai.toggle.setAttribute('aria-expanded', 'true');
      ai.toggle.querySelector('.think-label').textContent = '深度思考中…';
      lastReasoningAt = Date.now();
      ai.thinkBody.scrollTop = ai.thinkBody.scrollHeight;
      if (stickToBottom) scrollToBottom(document.getElementById('chat-scroll'));
      break;
    }
    case 'content': {
      if (evt.delta) ai.observedTokens += 1;
      if (ai.toggle.classList.contains('streaming')) {
        ai.toggle.classList.remove('streaming');
      }
      ai.contentRaw += evt.delta || '';
      ai.typing.hidden = true;
      renderThrottled();
      break;
    }
    case 'usage': {
      ai.elapsedMs = ai.elapsedMs || (Date.now() - startedAt);
      setAiTokens(ai, evt.promptTokens, evt.completionTokens, ai.elapsedMs,
        evt.cacheHitTokens, evt.cacheMissTokens);
      if (ai.tps) setSpeed(ai.tps, false);
      break;
    }
    case 'retry': {
      state.retryAttempt = evt.attempt ?? 0;
      ai.retry.hidden = false;
      ai.retry.textContent = `上游限流，自动重试中…（第 ${evt.attempt ?? '?'} 次，会一直重试直到成功）`;
      break;
    }
    case 'error': {
      state.retryAttempt = 0;
      ai.retry.hidden = true;
      ai.elapsedMs = Date.now() - startedAt;
      if (evt.conversation) state.conversationUsage = evt.conversation;
      showAiError(ai, evt.message || '');
      break;
    }
    case 'done': {
      state.retryAttempt = 0;
      ai.retry.hidden = true;
      ai.typing.hidden = true;
      if (evt.messageId != null) ai.el.dataset.msgId = evt.messageId;
      ai.elapsedMs = Number(evt.elapsedMs) || (Date.now() - startedAt);
      if (evt.usage) {
        setAiTokens(ai, evt.usage.promptTokens, evt.usage.completionTokens, ai.elapsedMs,
          evt.usage.cacheHitTokens, evt.usage.cacheMissTokens);
      }
      if (evt.conversation) state.conversationUsage = evt.conversation;
      if (evt.contextTokens != null) {
        state.contextTokens = evt.contextTokens;
        state.usage.used = evt.contextTokens;
      }
      break;
    }
    default:
      break;
  }
}

/** 拉取最新消息 id，给本轮用户块/AI 块补 dataset.msgId */
async function syncMessageIds(ai) {
  if (!state.currentConvId) return;
  try {
    const conv = await api.getConversation(state.currentConvId);
    state.currentMessages = conv.messages || [];
    state.conversationUsage = conv.usage || state.conversationUsage;
    if (conv.title) state.currentConvTitle = conv.title;
    document.dispatchEvent(new CustomEvent('conversations-refresh'));
    const aiId = ai.el.dataset.msgId;
    if (aiId != null) {
      const idx = state.currentMessages.findIndex((m) => String(m.id) === String(aiId));
      const userMsg = idx > 0 ? state.currentMessages[idx - 1] : null;
      const userBlock = ai.el.previousElementSibling;
      if (userMsg && userMsg.role === 'user' && userBlock && userBlock.classList.contains('msg-user-wrap')) {
        userBlock.dataset.msgId = userMsg.id;
      }
    }
      updateQuickNav();
    if (stickToBottom) scrollToBottom(document.getElementById('chat-scroll'));
  } catch { /* 静默：不影响主流程 */ }
}

/* ============================================================
   重试 / 重新生成
   ============================================================ */
function prevUserBlock(aiEl) {
  let node = aiEl.previousElementSibling;
  while (node) {
    if (node.classList.contains('msg-user-wrap')) return node;
    node = node.previousElementSibling;
  }
  return null;
}

async function regenerateInPlace(ai) {
  const userBlock = prevUserBlock(ai.el);
  if (!userBlock) { toast('找不到对应的用户消息', 'error'); return; }
  const msgId = userBlock.dataset.msgId;
  const msg = state.currentMessages.find((m) => String(m.id) === String(msgId));
  const content = msg ? String(msg.content || '') : (userBlock.querySelector('.msg-user')?.textContent || '');
  const display = msg ? displayTextOf(msg) : (userBlock.querySelector('.msg-user')?.textContent || '');
  const hadAttachments = msg ? attachmentsOf(msg).length > 0 : false;
  if (!content.trim() && !display.trim()) { toast('原消息为空，无法重新生成', 'error'); return; }

  if (ai.el.dataset.msgId != null) {
    try {
      await api.truncateMessages(state.currentConvId, Number(ai.el.dataset.msgId));
      const idx = state.currentMessages.findIndex((x) => String(x.id) === String(ai.el.dataset.msgId));
      if (idx >= 0) state.currentMessages = state.currentMessages.slice(0, idx);
    } catch (e) { toast('截断失败：' + e.message, 'error'); return; }
  }
  let node = ai.el;
  while (node.nextElementSibling) node.nextElementSibling.remove();
  node.remove();

  if (hadAttachments) toast('重新生成将复用已写入的文字内容，图片附件不会重复发送', 'info', 3000);
  state.lastTurn = { text: content, displayText: display, attachments: [], mode: state.convMode };
  await sendStream(content, { attachments: [], displayText: display, anchor: userBlock });
}

async function retryFailedInPlace(ai) {
  const userBlock = prevUserBlock(ai.el);
  const turn = state.lastTurn;
  const msgId = userBlock?.dataset.msgId;
  const msg = state.currentMessages.find((m) => String(m.id) === String(msgId));
  const text = turn?.text || (msg ? String(msg.content || '') : '');
  const display = turn?.displayText ?? (msg ? displayTextOf(msg) : '');
  const atts = turn?.attachments || [];
  if (!text && !atts.length) { toast('没有可重试的内容', 'error'); return; }
  ai.el.remove();
  await sendStream(text, {
    attachments: atts, displayText: display, anchor: userBlock,
  });
}

/* ============================================================
   对话末尾 token 汇总
   ============================================================ */
/* ============================================================
   右侧快速定位
   ============================================================ */
function userBlocks() {
  return [...document.querySelectorAll('#messages .msg-user-wrap')];
}

export function updateQuickNav() {
  const nav = document.getElementById('quick-nav');
  const panel = document.getElementById('qn-panel');
  if (!nav) return;
  const blocks = userBlocks();
  const sc = document.getElementById('chat-scroll');
  if (!state.showQuickNav || !blocks.length) {
    nav.hidden = true;
    const preview = document.getElementById('qn-preview');
    if (preview) preview.hidden = true;
    return;
  }
  nav.hidden = false;
  if (panel) panel.hidden = false;
  hideQnPreview();
  let active = 0;
  const scRect = sc.getBoundingClientRect();
  if (pinnedNavIndex != null && pinnedNavIndex < blocks.length) {
    active = pinnedNavIndex;
  } else if (isNearBottom(sc, 80)) {
    active = blocks.length - 1;
  } else {
    blocks.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      if (r.top - scRect.top <= 140) active = i;
    });
  }
  const track = document.getElementById('qn-track');
  track.innerHTML = '';
  blocks.forEach((el, i) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'qn-item' + (i === active ? ' active' : '');
    row.dataset.index = String(i);
    row.setAttribute('aria-label', `跳到第 ${i + 1} 轮`);
    row.addEventListener('mouseenter', () => showQnPreview(i, row));
    row.addEventListener('focus', () => showQnPreview(i, row));
    row.addEventListener('mouseleave', hideQnPreview);
    row.addEventListener('blur', hideQnPreview);
    track.appendChild(row);
  });
}

function hideQnPreview() {
  const p = document.getElementById('qn-preview');
  if (p) p.hidden = true;
}

function showQnPreview(index, bar) {
  const preview = document.getElementById('qn-preview');
  const blocks = userBlocks();
  if (!preview || !blocks[index]) return;
  const block = blocks[index];
  const bubble = block.querySelector('.msg-user');
  let text = (bubble?.textContent || '').trim();
  const cards = block.querySelectorAll('.attach-card').length;
  if (!text) text = cards ? '图片/文件附件' : '（空消息）';
  if (text.length > 500) text = text.slice(0, 500) + '…';
  document.getElementById('qn-preview-text').textContent = text;

  // 预览该轮对应的助手回答（保留原始 Markdown 文本）
  const userMsgs = state.currentMessages.filter((m) => m.role === 'user');
  const userMsg = userMsgs[index];
  const pos = userMsg ? state.currentMessages.indexOf(userMsg) : -1;
  const next = pos >= 0 ? state.currentMessages[pos + 1] : null;
  const aiText = next && next.role === 'assistant' ? String(next.content || '').trim() : '';
  const aiEl = document.getElementById('qn-preview-ai');
  aiEl.textContent = aiText.length > 900 ? aiText.slice(0, 900) + '…' : aiText;
  aiEl.hidden = !aiText;
  document.getElementById('qn-preview-title').textContent = `跳到第 ${index + 1} 轮`;
  document.getElementById('qn-preview-att').textContent = cards ? `附件 ${cards} 个` : '';
  preview.hidden = false;
  const r = bar.getBoundingClientRect();
  const pw = preview.offsetWidth;
  const ph = preview.offsetHeight;
  let left = r.left - pw - 14;
  if (left < 8) left = 8;
  let top = r.top + r.height / 2 - ph / 2;
  top = Math.max(8, Math.min(top, window.innerHeight - ph - 8));
  preview.style.left = `${Math.round(left)}px`;
  preview.style.top = `${Math.round(top)}px`;
}

function clearQnPad() {
  document.getElementById('qn-scroll-pad')?.remove();
}

function scrollToTurn(index) {
  const blocks = userBlocks();
  if (!blocks.length) return;
  const i = Math.max(0, Math.min(blocks.length - 1, index));
  const sc = document.getElementById('chat-scroll');
  const scRect = sc.getBoundingClientRect();
  const bRect = blocks[i].getBoundingClientRect();
  // 点第 N 条后，把这个用户气泡滚到顶栏下面那条横线附近。
  const target = sc.scrollTop + (bRect.top - scRect.top) - 16;
  clearQnPad();
  const maxBefore = sc.scrollHeight - sc.clientHeight;
  if (target > maxBefore + 1) {
    const pad = document.createElement('div');
    pad.id = 'qn-scroll-pad';
    pad.className = 'qn-scroll-pad';
    pad.style.height = `${Math.ceil(target - maxBefore + 24)}px`;
    document.getElementById('messages').appendChild(pad);
  }
  pinnedNavIndex = i;
  document.querySelectorAll('.qn-item').forEach((el, idx) => {
    el.classList.toggle('active', idx === i);
  });
  // click 事件里 smooth scroll 会被浏览器取消，这里直接定位。
  sc.scrollTop = target;
  hideQnPreview();
}

/* ============================================================
   发送按钮
   ============================================================ */
export function setSendButtonSending(sending) {
  const btn = document.getElementById('btn-send');
  if (!btn) return;
  btn.classList.toggle('sending', sending);
  btn.innerHTML = sending
    ? `${icon('stop', 13)}<span class="spinner" hidden></span>`
    : icon('arrowUp', 16);
  btn.disabled = sending ? false : btn.disabled;
  btn.title = sending ? '停止生成' : '发送';
  btn.setAttribute('aria-label', sending ? '停止生成' : '发送');
}

export function stopGenerating() {
  if (abortController) abortController.abort();
}

/* ============================================================
   初始化
   ============================================================ */
function bindScroll() {
  const sc = document.getElementById('chat-scroll');
  const unpin = () => { pinnedNavIndex = null; clearQnPad(); };
  sc.addEventListener('wheel', unpin, { passive: true });
  sc.addEventListener('touchstart', unpin, { passive: true });
  sc.addEventListener('scroll', () => {
    stickToBottom = isNearBottom(sc, 80);
    if (navRaf) return;
    navRaf = requestAnimationFrame(() => {
      navRaf = null;
      updateQuickNav();
    });
  }, { passive: true });
}

function bindQuickNav() {
  const nav = document.getElementById('quick-nav');
  const preview = document.getElementById('qn-preview');
  if (!nav) return;
  let leaveTimer = null;
  const open = () => {
    clearTimeout(leaveTimer);
    nav.classList.add('open');
    const track = document.getElementById('qn-track');
    if (track && !track.children.length) updateQuickNav();
  };
  const close = () => {
    hideQnPreview();
    if (nav.contains(document.activeElement)) return;
    leaveTimer = setTimeout(() => {
      if (!nav.matches(':hover')) nav.classList.remove('open');
    }, 180);
  };
  nav.addEventListener('mouseenter', open);
  nav.addEventListener('mouseleave', close);
  nav.addEventListener('focusin', open);
  nav.addEventListener('focusout', close);
  // 在 nav 上做事件委托；横线很细，点击时用坐标兜底找到当前横线。
  nav.addEventListener('click', (e) => {
    const fromTarget = e.target.closest?.('.qn-item');
    const fromPoint = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.qn-item');
    const bar = fromTarget || fromPoint;
    if (bar) scrollToTurn(Number(bar.dataset.index));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && preview && !preview.hidden) hideQnPreview();
  });
}

export function initChat() {
  bindScroll();
  bindQuickNav();
  const editInput = document.getElementById('edit-attach-input');
  editInput?.addEventListener('change', async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (activeEditAdd) await activeEditAdd(files);
  });

  document.addEventListener('usage-change', () => {
    });
  document.addEventListener('quicknav-change', () => {
    updateQuickNav();
  });
  document.addEventListener('conv-mode-change', () => {
    });
}
