/**
 * topbar.js — 顶栏：模型下拉 / 思考档位 / token 用量 / 快速定位开关
 */
import { state, DEPTH_LABELS } from './state.js';
import { api } from './api.js';
import { fmtInt, fmtPct, fmtTokens, fmtTps, fmtCompact, promptDialog, toast } from './util.js';
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
  if (!menu || !label) return;
  menu.innerHTML = '';
  const groups = Array.isArray(state.modelProviders) ? state.modelProviders : [];
  if (!groups.length) {
    label.textContent = '无可用模型';
    return;
  }
  if (!state.providerId && groups.length) state.providerId = Number(groups[0].id);
  if (!state.model) {
    const active = groups.find((p) => Number(p.id) === Number(state.providerId)) || groups[0];
    state.model = (active.models && active.models[0]) || '';
  }

  let any = false;
  groups.forEach((p) => {
    const header = document.createElement('div');
    header.className = 'dropdown-group';
    header.innerHTML =
      `<span class="model-group-dot ${p.hasKey ? 'ok' : 'off'}"></span>` +
      `<span class="model-group-name"></span>` +
      (p.active ? `<span class="model-group-active">当前</span>` : '');
    header.querySelector('.model-group-name').textContent = p.name;
    menu.appendChild(header);
    const models = Array.isArray(p.models) ? p.models : [];
    if (!models.length) {
      const empty = document.createElement('div');
      empty.className = 'dropdown-empty';
      empty.textContent = '还没有模型';
      menu.appendChild(empty);
    }
    models.forEach((m) => {
      any = true;
      const selected = m === state.model && Number(p.id) === Number(state.providerId);
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'dropdown-item' + (selected ? ' selected' : '');
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(selected));
      item.innerHTML = `<span class="model-name"></span>` +
        (selected ? `<span class="check">${icon('check', 13)}</span>` : '');
      item.querySelector('.model-name').textContent = m;
      item.addEventListener('click', () => setModel(m, p.id));
      menu.appendChild(item);
    });
  });
  if (!any && !state.model) {
    label.textContent = '无可用模型';
    return;
  }

  const custom = document.createElement('button');
  custom.type = 'button';
  custom.className = 'dropdown-item model-custom';
  custom.innerHTML = `<span class="model-name"></span>`;
  custom.querySelector('.model-name').textContent = '自定义模型…';
  custom.addEventListener('click', () => chooseCustomModel());
  menu.appendChild(custom);

  label.textContent = state.model || '选择模型';
  const active = groups.find((p) => Number(p.id) === Number(state.providerId));
  const btn = document.getElementById('model-select-btn');
  if (btn) btn.title = active ? `${active.name} / ${state.model || ''}` : '选择模型';
}

function setModel(model, providerId = state.providerId) {
  const m = String(model || '').trim();
  if (!m) return;
  state.model = m;
  if (providerId != null) state.providerId = Number(providerId);
  const provider = (state.modelProviders || []).find(
    (p) => Number(p.id) === Number(state.providerId));
  if (provider && !provider.hasKey) {
    toast(`${provider.name} 尚未配置 API Key，请先在设置中填写`, 'info', 3200);
  }
  state.modelProviders = (state.modelProviders || []).map((p) => ({
    ...p,
    active: Number(p.id) === Number(state.providerId),
  }));
  const label = document.getElementById('model-select-label');
  if (label) label.textContent = m;
  const menu = document.getElementById('model-menu');
  if (menu) menu.hidden = true;
  document.getElementById('model-select-btn')?.setAttribute('aria-expanded', 'false');
  renderModelMenu();
  api.putSettings({ providerId: state.providerId, model: m })
    .then((s) => {
      state.settings = s;
    })
    .catch(() => toast('模型设置保存失败', 'error'));
}

async function chooseCustomModel() {
  if (!state.providerId) { toast('请先在设置中添加模型提供商', 'info'); return; }
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
  setModel(m, state.providerId);
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
    state.modelProviders = Array.isArray(res.providers) ? res.providers : [];
    if (res.activeProviderId != null) state.providerId = Number(res.activeProviderId);
    if (!state.model) state.model = res.model || state.models[0] || '';
  } catch {
    state.models = state.model ? [state.model] : [];
  }
  if (!state.providerId && state.modelProviders.length) {
    state.providerId = Number(state.modelProviders[0].id);
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
      estimated: Number(u.estimated) || 0,
      estimateRatio: Number(u.estimateRatio) || 0,
      estimatedRemaining: Number(u.estimatedRemaining) || 0,
      breakdown: u.breakdown || {
        systemTokens: 0, textTokens: 0, imageTokens: 0, messageTokens: 0,
        estimatedTokens: 0,
      },
      compaction: u.compaction || null,
      compactionPolicy: u.compactionPolicy || null,
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
  const { quota, used, breakdown, compaction, compactionPolicy } = state.usage;
  const estimated = Math.max(0, Number(state.usage.estimated) || 0);
  const pct = quota > 0 ? Math.min(1, estimated / quota) : 0;

  const full = quota > 0 && estimated >= quota;
  if (full !== state.quotaFull) {
    state.quotaFull = full;
    document.body.classList.toggle('quota-full', full);
    document.dispatchEvent(new CustomEvent('quota-change'));
  }

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('up-context', `~${fmtCompact(estimated)} / ${fmtCompact(quota)}`);
  set('up-context-pct', `${Math.round(pct * 100)}%`);

  // 构成条：系统提示词 / 上传文本占用 / 图片 / 对话消息
  const total = Math.max(1, estimated);
  const seg = (id, value) => {
    const el = document.getElementById(id);
    if (!el) return;
    const n = Math.max(0, Number(value) || 0);
    el.style.width = `${(n / total * 100).toFixed(2)}%`;
    el.hidden = n <= 0;
  };
  const b = breakdown || {};
  seg('up-seg-system', b.systemTokens);
  seg('up-seg-text', b.textTokens);
  seg('up-seg-image', b.imageTokens);
  seg('up-seg-msg', b.messageTokens);
  set('up-system', `~${fmtCompact(b.systemTokens || 0)}`);
  set('up-text', `~${fmtCompact(b.textTokens || 0)}`);
  set('up-image', `~${fmtCompact(b.imageTokens || 0)}`);
  set('up-msg', `~${fmtCompact(b.messageTokens || 0)}`);
  const imageRow = document.getElementById('up-image-row');
  if (imageRow) imageRow.hidden = !(Number(b.imageTokens) > 0);

  // 压缩状态
  const btn = document.getElementById('up-compact-btn');
  const note = document.getElementById('up-compact-note');
  const info = document.getElementById('up-compact-info');
  if (btn) {
    btn.disabled = !!state.sending || !!state.compacting;
    btn.textContent = compaction ? '重新压缩' : '压缩对话';
  }
  if (info) {
    if (compaction) {
      info.hidden = false;
      info.textContent = `已压缩 ${fmtInt(compaction.shadowedCount)} 条 · ` +
        `~${fmtCompact(compaction.shadowedTokens)} → ~${fmtCompact(compaction.summaryTokens)} tok`;
    } else {
      info.hidden = true;
      info.textContent = '';
    }
  }
  if (note) {
    const threshold = Number(compactionPolicy?.thresholdTokens) || 0;
    note.textContent = threshold > 0 && quota > 0
      ? `超过 ~${fmtCompact(threshold)} tok（${Math.round(threshold / quota * 100)}%）自动压缩较早消息`
      : '上下文超过阈值时自动压缩较早消息';
  }

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
  if (statusContext) statusContext.textContent = `${fmtCompact(estimated)} tok`;
  const statusCache = document.getElementById('status-cache');
  if (statusCache) {
    statusCache.textContent = `缓存命中 ${cacheRate == null ? '—' : fmtPct(cacheRate)}`;
  }
  const ring = document.getElementById('status-ring');
  if (ring) ring.style.setProperty('--pct', (pct * 100).toFixed(2));
  set('status-ring-pct', `${Math.round(pct * 100)}%`);

  const statusTokens = document.getElementById('status-tokens');
  if (statusTokens) {
    statusTokens.title = `上下文 ~${fmtInt(estimated)} / ${fmtInt(quota)} tokens（上次上游实测 ${fmtInt(used)}）\n` +
      `系统提示词 ${fmtInt(b.systemTokens || 0)} · 上传文本占用 ${fmtInt(b.textTokens || 0)} · ` +
      `图片 ${fmtInt(b.imageTokens || 0)} · 对话消息 ${fmtInt(b.messageTokens || 0)}\n` +
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
  const upNote = document.getElementById('up-note');
  if (upNote) {
    upNote.textContent = state.tokenizer === 'exact'
      ? '上传文本占用 = 上传的文本附件全文 token；图片按尺寸估算视觉 token。下方输入/输出为本会话逐轮累加。'
      : '上传文本占用 = 上传的文本附件全文 token；图片按尺寸估算视觉 token。当前未加载分词器，数值为字符数估算。';
  }
}

export function setCompactBusy(busy) {
  const btn = document.getElementById('up-compact-btn');
  if (!btn) return;
  btn.disabled = !!busy || !!state.sending;
  btn.textContent = busy ? '压缩中…' : (state.usage.compaction ? '重新压缩' : '压缩对话');
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
  document.getElementById('up-compact-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (state.sending) { toast('请等待当前回复完成或先停止', 'error'); return; }
    document.dispatchEvent(new CustomEvent('compact-request'));
  });
  document.addEventListener('compact-state', (e) => setCompactBusy(!!e.detail?.busy));
  document.addEventListener('chat-sending-change', () => setCompactBusy(false));
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
  document.getElementById('status-db').innerHTML = icon('book', 12);

  initDepthSegs();
  initModelDropdown();
  initUsagePopover();
  renderUsage();
  setSpeed(null, false);
  document.addEventListener('models-refresh', () => { loadModels(); });
}
