/**
 * state.js — 全局状态（唯一来源，禁止 window 污染）
 */
export const state = {
  /* 设置与模型 */
  settings: { baseUrl: '', apiKeyMasked: '', model: '', quota: 0, depth: 'high' },
  models: [],
  model: '',
  depth: 'high',

  /* 知识库 */
  tree: { folders: [], files: [] },
  expandedFolders: new Set(),
  treeReady: false,

  /* 对话 */
  conversations: [],
  currentConvId: null,
  currentConvTitle: '',
  convSelectionMode: false,
  convSelected: new Set(),
  convMode: 'chat',       // chat | kb
  currentMessages: [],
  conversationUsage: { turns: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
    cacheHitTokens: 0, cacheMissTokens: 0, cacheHitRate: null, cacheKnown: false },
  contextTokens: 0,

  /* 用量 */
  usage: { quota: 0, used: 0, remaining: 0, ratio: 0 },
  tokenizer: 'exact',

  /* 交互 */
  sidebarOpen: true,
  sending: false,
  quotaFull: false,
  retryAttempt: 0,
  showQuickNav: true,
  attachments: [],        // 待发附件（聊天模式）
  lastTurn: null,         // 最近一次发送的快照，供失败原位重试
  uploadDirId: null,      // 上传弹窗当前目录
  ready: false,
};

export const MAX_ATTACHMENTS = 500;

/** 深度档位 ↔ 文案 */
export const DEPTH_LABELS = { none: '关', low: '标准', high: '深度', max: '极深' };

export const LS_KEYS = {
  sidebarWidth: 'kb.sidebarWidth.v2',
  kbRatio: 'kb.kbRatio',
  expanded: 'kb.expandedFolders',
  quickNav: 'kb.showQuickNav',
  sidebarCollapsed: 'kb.sidebarCollapsed',
};
