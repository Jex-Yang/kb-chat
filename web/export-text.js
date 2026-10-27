/**
 * export-text.js — 对话导出为纯文本（.txt）
 * 不输出 Markdown、不输出 🧑 用户 / 🤖 助手 之类角色标题，只保留消息正文。
 * 单条对话与“全部导出”共用。
 */
import { api } from './api.js';

function deriveUserText(m) {
  const display = m.displayContent;
  if (display != null) return String(display).trim();
  const content = String(m.content || '');
  let text = content;
  const idx = content.search(/\n?【附件：/);
  if (idx >= 0) text = content.slice(0, idx);
  text = text.trim();
  if (text === '请阅读并分析以上附件内容') text = '';
  if (!text) {
    const names = (Array.isArray(m.attachments) ? m.attachments : [])
      .map((a) => a && a.name).filter(Boolean);
    if (!names.length) {
      const re = /【附件：([^】\n]+)】/g;
      let x;
      while ((x = re.exec(content))) names.push(x[1]);
    }
    if (names.length) text = `附件：${names.join('、')}`;
  }
  return text;
}

function toPlainText(src) {
  const lines = String(src || '').split('\n');
  const out = [];
  let inCode = false;
  for (let line of lines) {
    if (/^\s*```/.test(line)) { inCode = !inCode; continue; }
    if (inCode) { out.push(line); continue; }
    line = line
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s*>\s?/, '')
      .replace(/^\s*[-*+]\s+/, '· ')
      .replace(/^\s*---{3,}\s*$/, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1（$2）')
      .replace(/\*([^*\n]+)\*/g, '$1');
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function conversationToText(conv, { withTitle = false } = {}) {
  const lines = [];
  if (withTitle && conv.title) {
    lines.push(conv.title, '');
  }
  (conv.messages || []).forEach((m) => {
    if (m.role === 'user') {
      const text = deriveUserText(m);
      if (text) lines.push(text, '');
    } else if (m.role === 'assistant') {
      const text = toPlainText(m.content);
      if (text) lines.push(text, '');
    }
  });
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export async function exportSingleConversation(id) {
  const conv = await api.getConversation(id);
  downloadText(`conversation-${conv.id}.txt`, conversationToText(conv, { withTitle: false }));
  return conv;
}

export async function exportAllConversations() {
  const list = await api.getConversations();
  const chunks = [];
  for (const item of list) {
    try {
      const conv = await api.getConversation(item.id);
      const body = conversationToText(conv, { withTitle: false });
      chunks.push(`===== ${conv.title || '未命名对话'} =====\n\n${body}`.trim() + '\n');
    } catch { /* 跳过单个失败，不阻塞全部导出 */ }
  }
  const text = chunks.join('\n\n').trim() + '\n';
  downloadText(`conversations-${stamp()}.txt`, text || '（暂无对话）\n');
  return list.length;
}
