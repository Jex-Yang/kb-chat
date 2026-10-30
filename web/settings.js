/**
 * settings.js — 设置：模型提供商 / 上下文
 * 只保留自定义 OpenAI Chat Completions 提供商，不接第三方目录。
 */
import { state, DEPTH_LABELS } from './state.js';
import { api } from './api.js';
import { toast, confirmDialog } from './util.js';
import { icon } from './icons.js';
import { setDepth, refreshUsage, loadModels } from './topbar.js';

const EYE_SVG =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 3C4.5 3 1.9 5.4 1 8c.9 2.6 3.5 5 7 5s6.1-2.4 7-5c-.9-2.6-3.5-5-7-5Zm0 8.3A3.3 3.3 0 1 1 8 4.7a3.3 3.3 0 0 1 0 6.6ZM8 6.4A1.6 1.6 0 1 0 8 9.6 1.6 1.6 0 0 0 8 6.4Z"/></svg>';

let currentDepth = 'high';
let providers = [];
let editingProviderId = null;
let editModels = [];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function setStateFromSettings(s) {
  state.settings = s;
  providers = Array.isArray(s.providers) ? s.providers : [];
  if (s.providerId != null) state.providerId = Number(s.providerId);
  if (s.model) state.model = s.model;
  if (Array.isArray(s.models) && s.models.length) state.models = s.models;
  state.tokenizer = s.tokenizer || state.tokenizer;
}

/* ---------- 提供商列表 ---------- */
function renderProviders() {
  const list = document.getElementById('provider-list');
  if (!list) return;
  list.innerHTML = '';
  if (!providers.length) {
    const empty = document.createElement('div');
    empty.className = 'provider-model-empty';
    empty.textContent = '还没有模型提供商';
    list.appendChild(empty);
    return;
  }
  providers.forEach((p) => {
    const card = document.createElement('div');
    card.className = 'provider-card' + (p.active ? ' active' : '');
    card.dataset.providerId = String(p.id);
    card.innerHTML =
      `<span class="provider-status-dot ${p.hasKey ? 'ok' : ''}"></span>` +
      `<div class="provider-main">` +
      `<div class="provider-name"><span class="provider-name-text"></span>` +
      `<span class="provider-badge ${p.hasKey ? 'ok' : 'off'}">${p.hasKey ? '已配置' : '未配置'}</span>` +
      (p.active ? '<span class="provider-badge active">当前</span>' : '') +
      `</div>` +
      `<div class="provider-meta"></div>` +
      `</div>` +
      `<div class="provider-actions">` +
      (!p.active ? '<button type="button" class="provider-act primary" data-act="use">使用</button>' : '') +
      `<button type="button" class="provider-act" data-act="edit">编辑</button>` +
      `<button type="button" class="provider-act danger" data-act="del">删除</button>` +
      `</div>`;
    card.querySelector('.provider-name-text').textContent = p.name;
    const models = Array.isArray(p.models) ? p.models : [];
    card.querySelector('.provider-meta').textContent =
      `${p.baseUrl} · ${models.length} 个模型` + (p.active ? ' · 当前使用' : '');
    card.querySelector('.provider-meta').title = models.length ? models.join(', ') : p.baseUrl;
    card.querySelector('[data-act="edit"]').addEventListener('click', () => openProviderModal(p));
    card.querySelector('[data-act="del"]').addEventListener('click', () => deleteProvider(p));
    card.querySelector('[data-act="use"]')?.addEventListener('click', () => useProvider(p));
    list.appendChild(card);
  });
}

async function useProvider(p) {
  try {
    const model = (p.models && p.models[0]) || state.model;
    await api.putSettings({ providerId: p.id, model });
    const s = await api.getSettings();
    setStateFromSettings(s);
    renderProviders();
    loadModels();
    refreshUsage(state.currentConvId);
    toast(`已切换到 ${p.name}`, 'success');
  } catch (e) {
    toast('切换提供商失败：' + e.message, 'error');
  }
}

async function deleteProvider(p) {
  if (providers.length <= 1) { toast('至少保留一个模型提供商', 'info'); return; }
  const ok = await confirmDialog(
    `确认删除「${p.name}」？该提供商保存的 API 密钥会一并删除。`,
    { title: '删除模型提供商', okText: '删除' },
  );
  if (!ok) return;
  try {
    const res = await api.deleteProvider(p.id);
    providers = res.providers || [];
    const s = await api.getSettings();
    setStateFromSettings(s);
    renderProviders();
    loadModels();
    refreshUsage(state.currentConvId);
    toast('提供商已删除', 'success');
  } catch (e) {
    toast('删除失败：' + e.message, 'error');
  }
}

/* ---------- 设置弹窗 ---------- */
async function openSettings() {
  const mask = document.getElementById('settings-modal');
  const quotaEl = document.getElementById('set-quota');
  const note = document.getElementById('tokenizer-note');
  if (!mask) return;
  mask.hidden = false;
  quotaEl.value = '';
  try {
    const s = await api.getSettings();
    setStateFromSettings(s);
    quotaEl.value = s.quota ?? '';
    currentDepth = s.depth in DEPTH_LABELS ? s.depth : state.depth;
    syncSettingsDepth();
    renderProviders();
    if (note) {
      note.textContent = s.tokenizer === 'exact'
        ? 'Token 计数：DeepSeek 官方分词器（精确到 1 token），用于对话上下文、附件与用量汇总。'
        : 'Token 计数：未加载分词器，当前为字符数估算。';
    }
  } catch (e) {
    toast('设置读取失败：' + e.message, 'error');
  }
}

function syncSettingsDepth() {
  document.querySelectorAll('#depth-seg-settings .seg-btn[data-depth]').forEach((btn) => {
    const on = btn.dataset.depth === currentDepth;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-checked', String(on));
  });
}

async function saveSettings() {
  const quotaRaw = document.getElementById('set-quota').value;
  const quota = quotaRaw === '' ? undefined : Number(quotaRaw);
  if (quota !== undefined && (!Number.isFinite(quota) || quota < 1)) {
    toast('上下文上限必须为正整数', 'error');
    return;
  }
  const payload = { depth: currentDepth };
  if (quota !== undefined) payload.quota = Math.round(quota);
  try {
    const s = await api.putSettings(payload);
    setStateFromSettings(s);
    setDepth(currentDepth, { persist: false });
    closeSettings();
    toast('设置已保存', 'success', 2000);
    refreshUsage(state.currentConvId);
  } catch (e) {
    toast('保存失败：' + e.message, 'error');
  }
}

function closeSettings() {
  const mask = document.getElementById('settings-modal');
  if (mask) mask.hidden = true;
}

/* ---------- 提供商编辑弹窗 ---------- */
function renderModelRows() {
  const box = document.getElementById('prov-models');
  if (!box) return;
  box.innerHTML = '';
  if (!editModels.length) {
    const empty = document.createElement('div');
    empty.className = 'provider-model-empty';
    empty.textContent = '模型选择器中将不显示任何模型；目录外 ID 仍可直接发送。';
    box.appendChild(empty);
    return;
  }
  editModels.forEach((model, index) => {
    const row = document.createElement('div');
    row.className = 'provider-model-row';
    row.innerHTML = `<input class="input" type="text" autocomplete="off">` +
      `<button type="button" class="icon-btn" title="移除">${icon('trash', 13)}</button>`;
    const input = row.querySelector('input');
    input.value = model;
    input.placeholder = '模型 ID，例如 deepseek-flash';
    input.addEventListener('input', () => { editModels[index] = input.value; });
    row.querySelector('button').addEventListener('click', () => {
      editModels.splice(index, 1);
      renderModelRows();
    });
    box.appendChild(row);
  });
}

function openProviderModal(provider = null) {
  editingProviderId = provider ? Number(provider.id) : null;
  editModels = provider && Array.isArray(provider.models) ? provider.models.slice() : [];
  const mask = document.getElementById('provider-modal');
  const title = document.getElementById('provider-modal-title');
  const nameEl = document.getElementById('prov-name');
  const baseEl = document.getElementById('prov-baseurl');
  const keyEl = document.getElementById('prov-apikey');
  const keyHint = document.getElementById('prov-key-hint');
  if (!mask) return;
  title.textContent = provider ? '编辑模型提供商' : '添加模型提供商';
  nameEl.value = provider ? provider.name : '';
  baseEl.value = provider ? provider.baseUrl : '';
  keyEl.value = '';
  keyEl.type = 'password';
  keyEl.placeholder = provider && provider.hasKey
    ? `已保存：${provider.apiKeyMasked}（留空不修改）`
    : '输入 API 密钥';
  if (keyHint) {
    keyHint.textContent = provider && provider.hasKey
      ? '留空表示不修改已保存的密钥。'
      : '密钥只保存在本地 SQLite 中，不会回显。';
  }
  renderModelRows();
  mask.hidden = false;
  setTimeout(() => nameEl.focus(), 30);
}

function closeProviderModal() {
  const mask = document.getElementById('provider-modal');
  if (mask) mask.hidden = true;
  editingProviderId = null;
  editModels = [];
}

async function saveProvider() {
  const name = document.getElementById('prov-name').value.trim();
  const baseUrl = document.getElementById('prov-baseurl').value.trim();
  const apiKey = document.getElementById('prov-apikey').value;
  if (!name) { toast('显示名称不能为空', 'error'); return; }
  if (!baseUrl) { toast('API 地址不能为空', 'error'); return; }
  const models = [...new Set(editModels.map((m) => String(m || '').trim()).filter(Boolean))];
  const payload = { name, baseUrl, models };
  if (apiKey.trim()) payload.apiKey = apiKey;
  const wasEditing = !!editingProviderId;
  try {
    if (editingProviderId) {
      await api.updateProvider(editingProviderId, payload);
    } else {
      await api.createProvider(payload);
    }
    const s = await api.getSettings();
    setStateFromSettings(s);
    providers = s.providers || [];
    renderProviders();
    closeProviderModal();
    loadModels();
    refreshUsage(state.currentConvId);
    toast(wasEditing ? '提供商已保存' : '提供商已添加', 'success');
  } catch (e) {
    toast('保存失败：' + e.message, 'error');
  }
}

async function fetchModels() {
  const baseUrl = document.getElementById('prov-baseurl')?.value.trim() || '';
  const apiKey = document.getElementById('prov-apikey')?.value.trim() || '';
  if (!baseUrl) { toast('请先填写 API 地址', 'info'); return; }
  const btn = document.getElementById('btn-fetch-models');
  if (btn) btn.disabled = true;
  try {
    const res = (editingProviderId && !apiKey)
      ? await api.fetchProviderModels(editingProviderId)
      : await api.fetchModelsByConfig({ baseUrl, apiKey });
    const incoming = Array.isArray(res.models) ? res.models : [];
    const merged = [...new Set([...editModels.map((m) => String(m || '').trim()).filter(Boolean), ...incoming])];
    editModels = merged;
    renderModelRows();
    toast(incoming.length ? `获取到 ${incoming.length} 个模型` : '上游没有返回模型', 'info');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ---------- 初始化 ---------- */
export function initSettings() {
  document.getElementById('btn-settings-side')?.addEventListener('click', openSettings);
  const sideIco = document.getElementById('ico-settings-side');
  if (sideIco) sideIco.innerHTML = icon('settings', 15);

  const addIco = document.getElementById('provider-add-ico');
  if (addIco) addIco.innerHTML = icon('plus', 14);
  const addModelIco = document.getElementById('provider-add-model-ico');
  if (addModelIco) addModelIco.innerHTML = icon('plus', 13);
  document.getElementById('btn-provider-key-toggle').innerHTML = EYE_SVG;

  document.getElementById('btn-settings-cancel')?.addEventListener('click', closeSettings);
  document.getElementById('btn-settings-save')?.addEventListener('click', saveSettings);
  document.getElementById('settings-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSettings();
  });
  document.getElementById('btn-add-provider')?.addEventListener('click', () => openProviderModal());
  document.getElementById('btn-provider-cancel')?.addEventListener('click', closeProviderModal);
  document.getElementById('btn-provider-save')?.addEventListener('click', saveProvider);
  document.getElementById('provider-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeProviderModal();
  });
  document.getElementById('btn-provider-key-toggle')?.addEventListener('click', () => {
    const keyEl = document.getElementById('prov-apikey');
    keyEl.type = keyEl.type === 'password' ? 'text' : 'password';
  });
  document.getElementById('btn-fetch-models')?.addEventListener('click', fetchModels);
  document.getElementById('btn-add-model')?.addEventListener('click', () => {
    editModels.push('');
    renderModelRows();
    const inputs = document.querySelectorAll('#prov-models .provider-model-row input');
    inputs[inputs.length - 1]?.focus();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const pv = document.getElementById('provider-modal');
    if (pv && !pv.hidden) {
      closeProviderModal();
      e.stopImmediatePropagation();
      return;
    }
    const st = document.getElementById('settings-modal');
    if (st && !st.hidden) {
      closeSettings();
      e.stopImmediatePropagation();
    }
  });

  document.querySelectorAll('#depth-seg-settings .seg-btn[data-depth]').forEach((btn) => {
    btn.addEventListener('click', () => {
      currentDepth = btn.dataset.depth;
      syncSettingsDepth();
    });
  });
}
