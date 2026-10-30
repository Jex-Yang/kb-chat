/**
 * login.js — 登录页脚本：已登录直接进应用，提交密码换会话 Cookie。
 * 密码只发往本机服务的 /api/auth/login，不做任何前端硬编码。
 */
const form = document.getElementById('login-form');
const input = document.getElementById('password');
const errEl = document.getElementById('err');
const submit = document.getElementById('btn-submit');
const toggle = document.getElementById('toggle-pw');

function setError(msg) {
  errEl.textContent = msg || '';
}

function setBusy(busy) {
  submit.disabled = busy;
  submit.textContent = busy ? '验证中…' : '登录';
}

async function alreadyLoggedIn() {
  try {
    const res = await fetch('/api/auth/status', { headers: { Accept: 'application/json' } });
    if (!res.ok) return false;
    const s = await res.json();
    return !s.enabled || s.authenticated;
  } catch {
    return false;
  }
}

toggle?.addEventListener('click', () => {
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  toggle.textContent = show ? '隐藏' : '显示';
  toggle.setAttribute('aria-pressed', String(show));
  input.focus();
});

form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (submit.disabled) return;
  const password = input.value;
  if (!password) {
    setError('请输入访问密码');
    input.focus();
    return;
  }
  setError('');
  setBusy(true);
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      location.replace('/');
      return;
    }
    let detail = '';
    try {
      const j = await res.json();
      detail = typeof j.detail === 'string' ? j.detail : '';
    } catch { /* 非 JSON */ }
    if (res.status === 401) setError(detail || '密码错误');
    else if (res.status === 429) setError(detail || '尝试次数过多，请稍后再试');
    else setError(detail || `登录失败（HTTP ${res.status}）`);
    input.select();
  } catch {
    setError('网络请求失败，请确认服务已启动');
  } finally {
    setBusy(false);
  }
});

// 已登录（或未开启密码）就不要停在登录页
if (await alreadyLoggedIn()) {
  location.replace('/');
} else {
  input?.focus();
}
