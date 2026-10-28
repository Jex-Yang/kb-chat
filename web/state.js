/**
 * state.js — 全局状态（唯一来源，禁止 window 污染）
 */
export const state = {
  /* 设置与模型 */
  settings: { baseUrl: '', apiKeyMasked: '', model: '', quota: 0, depth: 'high' },
  models: [],
  modelProviders: [],
  providerId: null,
  model: '',
  depth: 'high',

  /* 知识库 */
  tree: { folders: [], files: [] },
  treeReady: false,

  /* 对话 */
  conversations: [],
  currentConvId: null,
  currentConvTitle: '',
  convMode: 'chat',       // chat | kb
  currentMessages: [],
  compactions: [],        // 当前会话的上下文压缩检查点（通常只有最新一条）
  conversationUsage: { turns: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
    cacheHitTokens: 0, cacheMissTokens: 0, cacheHitRate: null, cacheKnown: false },
  contextTokens: 0,

  /* 用量 */
  usage: {
    quota: 0, used: 0, remaining: 0, ratio: 0,
    estimated: 0, estimateRatio: 0, estimatedRemaining: 0,
    breakdown: {
      systemTokens: 0, textTokens: 0, imageTokens: 0, messageTokens: 0,
      estimatedTokens: 0,
    },
    compaction: null, compactionPolicy: null,
  },
  tokenizer: 'exact',

  /* 交互 */
  sidebarOpen: true,
  sending: false,
  compacting: false,
  quotaFull: false,
  retryAttempt: 0,
  showQuickNav: true,
  attachments: [],        // 待发附件（聊天模式）
  lastTurn: null,         // 最近一次发送的快照，供失败原位重试
  ready: false,
};

export const MAX_ATTACHMENTS = 500;

/** 深度档位 ↔ 文案 */
export const DEPTH_LABELS = { none: '关', low: '标准', high: '深度', max: '极深' };

export const LS_KEYS = {
  sidebarWidth: 'kb.sidebarWidth.v3',
  quickNav: 'kb.showQuickNav',
  sidebarCollapsed: 'kb.sidebarCollapsed',
};
