/**
 * settings.js — 设置弹窗：接口 / 上下文 / 界面
 */
import { state, DEPTH_LABELS } from './state.js';
import { api } from './api.js';
import { toast } from './util.js';
import { icon } from './icons.js';
import { setDepth, refreshUsage } from './topbar.js';

let currentDepth = 'high';

async function openSettings() {
  const mask = document.getElementById('settings-modal');
  const baseUrlEl = document.getElementById('set-baseurl');
  const keyEl = document.getElementById('set-apikey');
  const modelEl = document.getElementById('set-model');
  const quotaEl = document.getElementById('set-quota');
  const note = document.getElementById('tokenizer-note');
  mask.hidden = false;
  baseUrlEl.value = '';
  keyEl.value = '';
  keyEl.type = 'password';
  quotaEl.value = '';

  try {
    const s = await api.getSettings();
    state.settings = s;
    if (Array.isArray(s.models) && s.models.length) state.models = s.models;
    baseUrlEl.value = s.baseUrl || '';
    keyEl.placeholder = s.apiKeyMasked ? `已保存：${s.apiKeyMasked}（留空不修改）` : '未设置，留空则不修改';
    quotaEl.value = s.quota ?? '';
    state.tokenizer = s.tokenizer || state.tokenizer;

    modelEl.value = s.model || state.model || '';
    const listEl = document.getElementById('model-options');
    listEl.innerHTML = '';
    const models = Array.isArray(s.models) && s.models.length
      ? s.models : (state.models.length ? state.models : [s.model].filter(Boolean));
    models.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m;
      listEl.appendChild(opt);
    });

    currentDepth = s.depth in DEPTH_LABELS ? s.depth : state.depth;
    syncSettingsDepth();

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
  const baseUrl = document.getElementById('set-baseurl').value.trim();
  const apiKey = document.getElementById('set-apikey').value;
  const model = document.getElementById('set-model').value.trim();
  const quotaRaw = document.getElementById('set-quota').value;
  const quota = quotaRaw === '' ? undefined : Number(quotaRaw);
  if (!model) {
    toast('模型名称不能为空', 'error');
    return;
  }
  if (quota !== undefined && (!Number.isFinite(quota) || quota < 1)) {
    toast('上下文上限必须为正整数', 'error');
    return;
  }

  const payload = { baseUrl, model, depth: currentDepth };
  if (quota !== undefined) payload.quota = Math.round(quota);
  if (apiKey.trim() !== '') payload.apiKey = apiKey;

  try {
    const s = await api.putSettings(payload);
    state.settings = s;
    if (s.model) state.model = s.model;
    if (Array.isArray(s.models) && s.models.length) state.models = s.models;
    state.tokenizer = s.tokenizer || state.tokenizer;
    setDepth(currentDepth, { persist: false });
    const label = document.getElementById('model-select-label');
    if (label && state.model) label.textContent = state.model;
    closeSettings();
    toast('设置已保存', 'success', 2000);
    refreshUsage(state.currentConvId);
  } catch (e) {
    toast('保存失败：' + e.message, 'error');
  }
}

function closeSettings() {
  document.getElementById('settings-modal').hidden = true;
}

export function initSettings() {
  const gear = document.getElementById('btn-settings-top');
  gear.addEventListener('click', openSettings);

  document.getElementById('btn-key-toggle').innerHTML = icon('info', 14);
  // 眼睛图标
  document.getElementById('btn-key-toggle').innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 3C4.5 3 1.9 5.4 1 8c.9 2.6 3.5 5 7 5s6.1-2.4 7-5c-.9-2.6-3.5-5-7-5Zm0 8.3A3.3 3.3 0 1 1 8 4.7a3.3 3.3 0 0 1 0 6.6ZM8 6.4A1.6 1.6 0 1 0 8 9.6 1.6 1.6 0 0 0 8 6.4Z"/></svg>';

  document.getElementById('btn-settings-cancel').addEventListener('click', closeSettings);
  document.getElementById('btn-settings-save').addEventListener('click', saveSettings);
  document.getElementById('settings-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSettings();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('settings-modal').hidden) closeSettings();
  });

  document.getElementById('btn-key-toggle').addEventListener('click', () => {
    const keyEl = document.getElementById('set-apikey');
    keyEl.type = keyEl.type === 'password' ? 'text' : 'password';
  });

  document.querySelectorAll('#depth-seg-settings .seg-btn[data-depth]').forEach((btn) => {
    btn.addEventListener('click', () => {
      currentDepth = btn.dataset.depth;
      syncSettingsDepth();
    });
  });
}
