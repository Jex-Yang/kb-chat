/**
 * search.js — 对话全文搜索：搜索所有用户/助手内容，结果定位到具体消息。
 */
import { api } from './api.js';
import { icon } from './icons.js';
import { fmtTime, toast } from './util.js';
import { selectConversation } from './conversations.js';

const $ = (id) => document.getElementById(id);
let seq = 0;
let timer = null;
let results = [];
let activeIndex = -1;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function highlight(text, q) {
  const source = String(text ?? '');
  if (!q) return esc(source);
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  let out = '';
  let last = 0;
  source.replace(re, (m, offset) => {
    out += esc(source.slice(last, offset)) + `<mark>${esc(m)}</mark>`;
    last = offset + m.length;
    return m;
  });
  out += esc(source.slice(last));
  return out;
}

function setActive(i) {
  const nodes = [...document.querySelectorAll('.search-result')];
  if (!nodes.length) return;
  activeIndex = Math.max(0, Math.min(i, nodes.length - 1));
  nodes.forEach((n, idx) => n.classList.toggle('active', idx === activeIndex));
  nodes[activeIndex].scrollIntoView({ block: 'nearest' });
}

function render() {
  const box = $('search-results');
  const count = $('search-count');
  const q = $('search-input').value.trim();
  if (!q) {
    results = [];
    activeIndex = -1;
    box.innerHTML = '<div class="search-empty">输入关键词，搜索所有对话内容</div>';
    count.textContent = '输入关键词，搜索所有对话内容';
    return;
  }
  if (!results.length) {
    box.innerHTML = '<div class="search-empty">没有找到匹配的对话内容</div>';
    count.textContent = '0 条结果';
    return;
  }
  box.innerHTML = '';
  results.forEach((r, idx) => {
    const row = document.createElement('div');
    row.className = 'search-result';
    row.dataset.index = String(idx);
    row.innerHTML =
      `<span class="search-result-ico">${icon('chat', 15)}</span>` +
      `<div class="search-result-main">` +
      `<div class="search-result-head">` +
      `<span class="search-result-title">${highlight(r.title, q)}</span>` +
      `<span class="search-result-time">${esc(fmtTime(r.createdAt))}</span>` +
      `</div>` +
      `<div class="search-result-snippet">${highlight(r.snippet, q)}</div>` +
      `</div>`;
    row.addEventListener('click', () => openResult(r));
    box.appendChild(row);
  });
  count.textContent = `${results.length} 条结果`;
}

async function runSearch() {
  const input = $('search-input');
  const q = input.value.trim();
  const my = ++seq;
  if (!q) { results = []; render(); return; }
  $('search-count').textContent = '搜索中…';
  try {
    const res = await api.search(q);
    if (my !== seq) return;
    results = Array.isArray(res.results) ? res.results : [];
    activeIndex = -1;
    render();
    if (results.length) setActive(0);
  } catch (e) {
    if (my !== seq) return;
    results = [];
    render();
    $('search-count').textContent = '搜索失败：' + e.message;
  }
}

async function openResult(r) {
  closeSearch();
  try {
    await selectConversation(r.conversationId);
    const el = document.querySelector(`#messages [data-msg-id="${r.messageId}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('search-hit');
      setTimeout(() => el.classList.remove('search-hit'), 2200);
    }
  } catch (e) {
    toast('打开对话失败：' + e.message, 'error');
  }
}

export function openSearch() {
  const mask = $('search-modal');
  if (!mask) return;
  mask.hidden = false;
  const input = $('search-input');
  setTimeout(() => { input.focus(); input.select(); }, 20);
  if (input.value.trim()) runSearch();
}

function closeSearch() {
  const mask = $('search-modal');
  if (mask) mask.hidden = true;
}

export function initSearch() {
  const searchBtn = $('btn-open-search');
  if (searchBtn) searchBtn.innerHTML = icon('search', 15);
  const legIco = $('conv-search-ico');
  if (legIco) legIco.innerHTML = icon('search', 13);
  $('search-head-ico').innerHTML = icon('search', 16);
  $('search-close').innerHTML = icon('close', 15);

  searchBtn?.addEventListener('click', openSearch);
  $('search-close').addEventListener('click', closeSearch);
  $('search-modal').addEventListener('click', (e) => {
    if (e.target === $('search-modal')) closeSearch();
  });

  const input = $('search-input');
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(runSearch, 160);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(activeIndex + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(activeIndex - 1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const r = results[activeIndex] || results[0];
      if (r) openResult(r);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('search-modal').hidden) {
      closeSearch();
    }
  });
}
