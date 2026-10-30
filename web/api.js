/**
 * api.js — 统一请求层：非 2xx 解析 {detail} 抛错
 * 只有 /api/chat（SSE）在 chat.js 内直接 fetch。
 */
import { state } from './state.js';

async function request(path, { method = 'GET', body, formData, signal } = {}) {
  let res;
  const opt = { method, signal };
  if (formData) {
    opt.body = formData;
  } else if (body !== undefined) {
    opt.headers = { 'Content-Type': 'application/json' };
    opt.body = JSON.stringify(body);
  }
  try {
    res = await fetch(path, opt);
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw new Error('网络请求失败，请确认服务已启动');
  }
  // 会话过期：回到登录页（登录页本身不经过这里）
  if (res.status === 401) {
    location.replace('/login.html');
    throw new Error('登录已过期，请重新登录');
  }
  if (!res.ok) {
    let detail = `请求失败（HTTP ${res.status}）`;
    try {
      const j = await res.json();
      if (j && j.detail) detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
    } catch { /* 非 JSON 响应体 */ }
    throw new Error(detail);
  }
  return res.json();
}

export const api = {
  health: () => request('/api/health'),

  authStatus: () => request('/api/auth/status'),
  logout: () => request('/api/auth/logout', { method: 'POST' }),

  getSettings: () => request('/api/settings'),
  putSettings: (payload) => request('/api/settings', { method: 'PUT', body: payload }),
  getModels: () => request('/api/models'),

  getProviders: () => request('/api/providers'),
  createProvider: (payload) => request('/api/providers', { method: 'POST', body: payload }),
  updateProvider: (id, payload) => request(`/api/providers/${id}`, { method: 'PUT', body: payload }),
  deleteProvider: (id) => request(`/api/providers/${id}`, { method: 'DELETE' }),
  fetchProviderModels: (id) => request(`/api/providers/${id}/models`, { method: 'POST' }),
  fetchModelsByConfig: (payload) => request('/api/providers/fetch-models', { method: 'POST', body: payload }),

  getUsage: (conversationId) => request('/api/usage' +
    (conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : '')),

  getTree: () => request('/api/tree'),
  createFolder: (name, parentId = null) => request('/api/folders', {
    method: 'POST', body: { name, parentId },
  }),
  renameFolder: (id, name) => request(`/api/folders/${id}`, { method: 'PUT', body: { name } }),
  deleteFolder: (id) => request(`/api/folders/${id}`, { method: 'DELETE' }),

  uploadFile: (file, folderId) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('folderId', folderId == null ? '' : String(folderId));
    return request('/api/files/upload', { method: 'POST', formData: fd });
  },
  parseFile: (file) => {
    const fd = new FormData();
    fd.append('file', file);
    return request('/api/files/parse', { method: 'POST', formData: fd });
  },
  deleteFile: (id) => request(`/api/files/${id}`, { method: 'DELETE' }),
  renameFile: (id, name) => request(`/api/files/${id}`, { method: 'PUT', body: { name } }),
  moveFile: (id, folderId) => request(`/api/files/${id}/move`, { method: 'POST', body: { folderId } }),
  copyFile: (id, payload = {}) => request(`/api/files/${id}/copy`, { method: 'POST', body: payload }),
  moveFolder: (id, parentId) => request(`/api/folders/${id}/move`, { method: 'POST', body: { parentId } }),
  copyFolder: (id, payload = {}) => request(`/api/folders/${id}/copy`, { method: 'POST', body: payload }),
  getFilePreview: (id) => request(`/api/files/${id}/preview`),
  fileDownloadUrl: (id) => `/api/files/${id}/download`,

  getConversations: () => request('/api/conversations'),
  createConversation: (opts = {}) => request('/api/conversations', {
    method: 'POST',
    body: {
      title: opts.title || '新对话',
      mode: opts.mode || state.convMode || 'chat',
    },
  }),
  getConversation: (id) => request(`/api/conversations/${id}`),
  updateConversation: (id, payload) => request(`/api/conversations/${id}`, { method: 'PUT', body: payload }),
  deleteConversation: (id) => request(`/api/conversations/${id}`, { method: 'DELETE' }),
  truncateMessages: (convId, messageId) => request(`/api/conversations/${convId}/messages/${messageId}`, { method: 'DELETE' }),
  search: (q) => request(`/api/search?q=${encodeURIComponent(q)}&limit=80`),
  snapshotTurn: (convId, turnIndex) => request(`/api/conversations/${convId}/turns/${turnIndex}/snapshot`, { method: 'POST' }),
  activateTurnVersion: (convId, turnIndex, version) => request(`/api/conversations/${convId}/turns/${turnIndex}/activate`, { method: 'POST', body: { version } }),
  compactConversation: (convId) => request(`/api/conversations/${convId}/compact`, { method: 'POST' }),
};
