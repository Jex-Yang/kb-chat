/**
 * topbar.js — 顶栏：模型下拉 / 思考档位 / token 用量 / 快速定位开关
 */
import { state, DEPTH_LABELS } from './state.js';
import { api } from './api.js';
import { fmtInt, fmtPct, fmtTokens, fmtTps, promptDialog, toast } from './util.js';
import { icon } from './icons.js';

let usageSeq = 0;
let depthSaveTimer = null;

export function setDepth(depth, { persist = true } = {}) {
  if (!(depth in DEPTH_LABELS)) depth = 'high';
  state.depth = depth;
  document.querySelectorAll('.depth-seg .seg-btn[data-depth]').forEach((btn) => {
    const on = btn.dataset.depth === depth;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-checked', String(on));
  });
  if (persist) {
    clearTimeout(depthSaveTimer);
    depthSaveTimer = setTimeout(() => {
      api.putSettings({ depth }).then((s) => {
        state.settings = { ...(state.settings || {}), ...s };
      }).catch(() => { /* 静默：下次请求仍会带上当前档位 */ });
    }, 300);
  }
}

function initDepthSegs() {
  document.querySelectorAll('.depth-seg .seg-btn[data-depth]').forEach((btn) => {
    btn.addEventListener('click', () => setDepth(btn.dataset.depth));
  });
  setDepth(state.depth, { persist: false });
}

/* ---------- 模型下拉 ---------- */
function renderModelMenu() {
  const menu = document.getElementById('model-menu');
  const label = document.getElementById('model-select-label');
  menu.innerHTML = '';
  const models = [...new Set([
    ...(state.models || []),
    ...(state.model ? [state.model] : []),
  ])];
  if (!models.length) {
    label.textContent = '无可用模型';
    return;
  }
  if (!state.model) state.model = models[0];
  models.forEach((m) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'dropdown-item' + (m === state.model ? ' selected' : '');
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(m === state.model));
    item.innerHTML = `<span class="model-name"></span>` + (m === state.model ? `<span class="check">${icon('check', 13)}</span>` : '');
    item.querySelector('.model-name').textContent = m;
    item.addEventListener('click', () => setModel(m));
    menu.appendChild(item);
  });

  const custom = document.createElement('button');
  custom.type = 'button';
  custom.className = 'dropdown-item model-custom';
  custom.innerHTML = `<span class="model-name"></span>`;
  custom.querySelector('.model-name').textContent = '自定义模型…';
  custom.addEventListener('click', () => chooseCustomModel());
  menu.appendChild(custom);

  label.textContent = state.model;
}

function setModel(model) {
  const m = String(model || '').trim();
  if (!m) return;
  state.model = m;
  const label = document.getElementById('model-select-label');
  if (label) label.textContent = m;
  const menu = document.getElementById('model-menu');
  if (menu) menu.hidden = true;
  document.getElementById('model-select-btn')?.setAttribute('aria-expanded', 'false');
  renderModelMenu();
  api.putSettings({ model: m }).catch(() => toast('模型设置保存失败', 'error'));
}

async function chooseCustomModel() {
  const name = await promptDialog({
    title: '自定义模型',
    label: '模型名称',
    value: state.model || '',
    placeholder: '例如 deepseek-flash',
    okText: '使用',
  });
  if (name == null) return;
  const m = name.trim();
  if (!m) { toast('模型名称不能为空', 'error'); return; }
  setModel(m);
}

function initModelDropdown() {
  const btn = document.getElementById('model-select-btn');
  const menu = document.getElementById('model-menu');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) renderModelMenu();
    menu.hidden = !menu.hidden;
    btn.setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) {
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) {
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    }
  });
}

export async function loadModels() {
  try {
    const res = await api.getModels();
    state.models = Array.isArray(res.models) ? res.models : [];
  } catch {
    state.models = state.model ? [state.model] : [];
  }
  if (!state.model && state.models.length) state.model = state.models[0];
  renderModelMenu();
}

/* ---------- token 用量 ---------- */
export async function refreshUsage(convId = state.currentConvId) {
  const seq = ++usageSeq;
  const target = convId || null;
  try {
    const u = await api.getUsage(target);
    if (seq !== usageSeq) return; // 丢弃过期响应（快速切换会话时）
    state.usage = {
      quota: Number(u.quota) || 0,
      used: Number(u.used) || 0,
      remaining: Number(u.remaining) || 0,
      ratio: Number(u.ratio) || 0,
    };
    state.conversationUsage = u.conversation || {
      turns: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
    };
    state.contextTokens = state.usage.used;
    state.tokenizer = u.tokenizer || state.tokenizer;
    renderUsage();
    document.dispatchEvent(new CustomEvent('usage-change'));
  } catch (e) {
    console.warn('usage refresh failed:', e);
  }
}

export function setSpeed(tps, live = false) {
  const box = document.getElementById('status-speed');
  const val = document.getElementById('speed-value');
  if (!box || !val) return;
  const n = Number(tps);
  box.classList.toggle('live', !!live);
  if (Number.isFinite(n) && n > 0) {
    val.textContent = fmtTps(n);
    box.title = `输出速度 ${fmtTps(n)} tok/s${live ? '（生成中）' : ''}`;
  } else {
    val.textContent = live ? '0.0' : '—';
    box.title = live ? '生成中…' : '输出速度（tokens / 秒）';
  }
}

function renderUsage() {
  const { quota, used } = state.usage;
  const pct = quota > 0 ? Math.min(1, used / quota) : 0;

  const full = quota > 0 && used >= quota;
  if (full !== state.quotaFull) {
    state.quotaFull = full;
    document.body.classList.toggle('quota-full', full);
    document.dispatchEvent(new CustomEvent('quota-change'));
  }

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('up-context', `${fmtInt(used)} / ${fmtInt(quota)}`);
  set('up-context-pct', fmtPct(pct));
  const upFill = document.getElementById('up-fill');
  if (upFill) upFill.style.width = `${(pct * 100).toFixed(2)}%`;
  set('up-conv', fmtTokens(state.conversationUsage.totalTokens));
  set('up-prompt', fmtInt(state.conversationUsage.promptTokens));
  set('up-completion', fmtInt(state.conversationUsage.completionTokens));

  const cu = state.conversationUsage || {};
  const cacheKnown = !!cu.cacheKnown;
  const hit = Number(cu.cacheHitTokens) || 0;
  const miss = Number(cu.cacheMissTokens) || 0;
  const cacheRate = cacheKnown && (hit + miss) > 0 ? hit / (hit + miss) : null;
  set('up-cache-rate', cacheRate == null ? '—' : fmtPct(cacheRate));
  set('up-cache-hit', cacheKnown ? fmtInt(hit) : '—');
  set('up-cache-miss', cacheKnown ? fmtInt(miss) : '—');

  const statusContext = document.getElementById('status-context');
  if (statusContext) statusContext.textContent = `${fmtInt(used)} tok`;
  const statusCache = document.getElementById('status-cache');
  if (statusCache) {
    statusCache.textContent = `缓存命中 ${cacheRate == null ? '—' : fmtPct(cacheRate)}`;
  }
  const statusTokens = document.getElementById('status-tokens');
  if (statusTokens) {
    statusTokens.title = `上下文 ${fmtInt(used)} / ${fmtInt(quota)} tokens\n` +
      `缓存命中 ${cacheRate == null ? '暂无数据' : fmtPct(cacheRate)}\n` +
      `未缓存输入 ${cacheKnown ? fmtInt(miss) : '—'} tok · 缓存读取 ${cacheKnown ? fmtInt(hit) : '—'} tok · 输出 ${fmtInt(Number(cu.completionTokens) || 0)} tok`;
  }

  const prec = document.getElementById('up-precision');
  if (prec) {
    prec.textContent = state.tokenizer === 'exact' ? '精确统计' : '估算';
    prec.title = state.tokenizer === 'exact'
      ? '使用 DeepSeek 官方分词器逐字计数'
      : '未找到分词器，按字符数估算';
  }
  const note = document.getElementById('up-note');
  if (note) {
    note.textContent = state.tokenizer === 'exact'
      ? '输入 = 每轮请求的 prompt（含历史与附件），逐轮累加；输出 = 每次回复。计数由 DeepSeek 分词器精确统计，没有取整或约等于。'
      : '输入 = 每轮请求的 prompt；输出 = 每次回复。当前未加载分词器，数值为字符数估算。';
  }
}

export function openUsagePopover() {
  const pop = document.getElementById('usage-pop');
  const statusBtn = document.getElementById('status-tokens');
  if (!pop) return;
  pop.hidden = false;
  statusBtn?.setAttribute('aria-expanded', 'true');
}

function closeUsagePopover() {
  const pop = document.getElementById('usage-pop');
  const statusBtn = document.getElementById('status-tokens');
  if (!pop) return;
  pop.hidden = true;
  statusBtn?.setAttribute('aria-expanded', 'false');
}

function initUsagePopover() {
  const pop = document.getElementById('usage-pop');
  const statusBtn = document.getElementById('status-tokens');
  statusBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (pop.hidden) openUsagePopover();
    else closeUsagePopover();
  });
  document.addEventListener('click', (e) => {
    if (pop.hidden) return;
    if (pop.contains(e.target) || statusBtn?.contains(e.target)) return;
    closeUsagePopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.hidden) closeUsagePopover();
  });
}

/* ---------- 初始化 ---------- */
export function initTopbar() {
  document.getElementById('btn-hamburger').innerHTML = icon('menu', 17);
  document.getElementById('btn-collapse-sidebar').innerHTML = icon('sidebar', 15);
  document.getElementById('model-star').innerHTML = icon('star', 13);
  document.getElementById('model-caret').innerHTML = icon('chevronDown', 11);
  document.getElementById('topbar-export-ico').innerHTML = icon('download', 13);
  document.getElementById('btn-settings-top').innerHTML = icon('settings', 15);
  document.getElementById('status-db').innerHTML = icon('book', 12);

  initDepthSegs();
  initModelDropdown();
  initUsagePopover();
  renderUsage();
  setSpeed(null, false);
}
