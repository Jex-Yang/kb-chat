# KBChat 架构文档（契约冻结版）

> 本文档是前后端唯一契约源。契约字段一旦实现不得私自变更，变更必须经主理人中转。

## 1. 技术选型（已拍板）

| 层 | 选型 | 理由 |
|----|------|------|
| 后端 | Python 3.13 + FastAPI + uvicorn | PDF/Word/Excel 解析生态成熟，SSE 支持好 |
| 存储 | SQLite（stdlib sqlite3，WAL 模式），文件落盘 data/uploads | 单机企业内部工具，零运维 |
| 解析 | pypdf（pdf）、python-docx（docx）、openpyxl（xlsx）、原生（txt/md/csv） | 纯 Python，安装简单 |
| 上游调用 | httpx 异步流式转发，OpenAI 兼容 /chat/completions | 商汤端点 OpenAI 兼容 |
| 前端 | 零构建原生 JS SPA（web/index.html + app.js + style.css） | 启动快、部署简单、无 node 依赖 |
| Markdown 渲染 | 本地 vendored marked.min.js（web/vendor/） | 不依赖 CDN |
| 检索 | Python 内存字符 bigram 倒排评分 Top-K（K=8），启动时全量加载分块 | 满足"快"，中文友好 |

## 2. 模块划分

```
kb-chat/
├── .env                    # API_BASE_URL / API_KEY / DEFAULT_MODEL / TOKEN_QUOTA
├── requirements.txt
├── start.sh                # 一键启动
├── server/
│   ├── main.py             # FastAPI 入口、静态托管 web/、路由注册
│   ├── config.py           # 读 .env + settings 表，环境变量优先
│   ├── db.py               # SQLite 初始化、DAO
│   ├── parsers.py          # pdf/docx/xlsx/csv/txt/md → 纯文本
│   ├── chunker.py          # 分块（600 字，重叠 100）+ bigram 倒排检索
│   ├── llm.py              # 上游流式调用 + 429/5xx 指数退避重试(3次:1s/2s/4s+抖动)
│   └── routes/             # api_routes.py（全部 REST/SSE 路由）
├── web/
│   ├── index.html / app.js / style.css
│   └── vendor/marked.min.js
└── data/ (gitignore)       # kb.db + uploads/
```

## 3. 数据模型（SQLite DDL 摘要）

- folders(id INTEGER PK, name TEXT, parent_id INTEGER NULL, created_at TEXT)
- files(id PK, folder_id TEXT/INT, name, ext, size, path, content TEXT, chunk_count, created_at)
- chunks(id PK, file_id, folder_id, seq, text)
- conversations(id PK, title, created_at, updated_at)
- messages(id PK, conv_id, role, content, reasoning, prompt_tokens, completion_tokens, elapsed_ms, display_content, attachments, cache_hit_tokens, cache_miss_tokens, content_tokens, created_at)：`content_tokens` 为正文精确分词缓存，启动时按需回填
- compactions(id PK, conv_id, summary, start_message_id, end_message_id, shadowed_count, shadowed_tokens, summary_tokens, model, source, created_at)：每个会话只保留最新一条检查点
- providers(id PK, name, base_url, api_key, models JSON, created_at, updated_at)：自定义 OpenAI 兼容提供商；首次启动种入 DeepSeek（`api.deepseek.com/v1`）与商汤 SenseNova（`token.sensenova.cn/v1`），旧 base_url/api_key 按地址迁移；第三方地址保留为独立自定义提供商，启动时会修复旧版误命名为商汤的条目
- usage_daily(date TEXT PK, tokens INTEGER)
- settings(key TEXT PK, value TEXT)：`provider_id`、`model`、`quota`、`depth`

## 4. REST 接口契约（字段级，全部前缀 /api）

| # | 方法/路径 | 请求 | 响应 |
|---|-----------|------|------|
| 1 | GET /api/health | - | `{ok:true}` |
| 2 | GET /api/settings | - | `{baseUrl, apiKeyMasked, model, providerId, providerName, providers:[{id,name,baseUrl,apiKeyMasked,hasKey,models,active}], quota, depth, models:[...]}`；`baseUrl/apiKeyMasked/model` 为当前提供商 |
| 3 | PUT /api/settings | `{baseUrl?, apiKey?(空串=不改), providerId?, model?, quota?, depth?}` | 同 2；`providerId` 切换当前提供商，未给 `model` 时取该提供商首个模型 |
| 4 | GET /api/usage | `?conversationId=` | `{quota, used, remaining, ratio, estimated, estimateRatio, estimatedRemaining, breakdown:{systemTokens,textTokens,imageTokens,messageTokens,estimatedTokens,compactedTokens}, compaction, compactionPolicy, conversation, ...}`；`used` 为上游实测，`estimated` 为下一轮请求精确分词估算；`textTokens` 只统计上传的文本附件，`imageTokens` 按当前用户消息图片尺寸估算视觉 token，用户输入与助手回复计入 `messageTokens` |
| 5 | GET /api/tree | - | `{folders:[{id,name,parentId}], files:[{id,folderId,name,ext,size,chunkCount,createdAt}]}` |
| 6 | POST /api/folders | `{name, parentId:null}` | `{id}` |
| 7 | PUT /api/folders/{id} | `{name?, parentId?}` | `{ok:true}` |
| 8 | DELETE /api/folders/{id} | - | `{ok:true}`（级联删子目录/文件/分块） |
| 9 | POST /api/files/upload | multipart: file, folderId | `{id, name, chunkCount}` ext 白名单: txt md csv pdf docx xlsx |
| 10 | DELETE /api/files/{id} | - | `{ok:true}` |
| 11 | GET /api/files/{id}/preview | - | `{name, content}` content 截断 5000 字 |
| 12 | POST /api/kb/search | `{query, topK?:8}` | `[{fileId, fileName, score, text}]` |
| 13 | GET /api/conversations | - | `[{id,title,updatedAt,messageCount}]` |
| 14 | POST /api/conversations | `{title?}` | `{id}` |
| 15 | GET /api/conversations/{id} | - | `{id,title,messages:[{id,role,content,reasoning,promptTokens,completionTokens,elapsedMs,createdAt}], compactions:[{id,summary,shadowedCount,shadowedTokens,summaryTokens,startMessageId,endMessageId,source,createdAt}], usage, contextTokens}` |
| 16 | PUT /api/conversations/{id} | `{title}` | `{ok:true}` |
| 17 | DELETE /api/conversations/{id} | - | `{ok:true}` |
| 18 | POST /api/chat | `{conversationId, message, useKb:bool, providerId?, model?, depth?}` | **SSE 流**，见 §5；缺省使用当前提供商的地址与密钥 |
| 19 | GET /api/models | - | `{models:[...], providers:[{id,name,models,hasKey,active}], activeProviderId, model}` 供顶栏分组下拉 |
| 20 | POST /api/conversations/{id}/compact | - | 手动压缩：`{ok, compacted, compaction, reason, usage}`；历史不足时 `compacted:false` 并给 `reason` |
| 21 | GET /api/providers | - | `{providers:[...], activeProviderId}` |
| 22 | POST /api/providers | `{name, baseUrl, apiKey?, models:[...]}` | `{ok, id, providers, activeProviderId}` |
| 23 | PUT /api/providers/{id} | `{name?, baseUrl?, apiKey?(空串=不改), models?}` | `{ok, providers, activeProviderId}` |
| 24 | DELETE /api/providers/{id} | - | `{ok, providers, activeProviderId}`；至少保留一个 |
| 25 | POST /api/providers/{id}/models | - | 用保存的地址/密钥请求 `{base_url}/models`，返回 `{models:[...]}` |
| 26 | POST /api/providers/fetch-models | `{baseUrl, apiKey?}` | 用表单里尚未保存的地址/密钥获取模型，返回 `{models:[...]}` |

> 对话/知识库 JSON 导出与导入接口已移除；只保留 TXT 下载（侧边栏「下载对话」）。

错误约定：非流式接口统一 `{detail: "..."}` + HTTP 4xx/5xx。

## 5. POST /api/chat SSE 事件流

服务端流程：
1. 取压缩检查点之后、全部 user/assistant 历史（不再固定 20 条）；若存在检查点，则 prompt = `system` + 一条 `<compacted-summary>` user 消息 + 保留的近期历史 + 本轮 user
2. 请求前用 DeepSeek 分词器估算压力：阈值 `floor(min(W×0.8, W−8192−65536))`（小窗口按比例缩小预留并夹在 `W×0.5`–`W×0.8`），W 为设置里的上下文上限；超过阈值先调用一次摘要模型，把较早历史压成检查点，近期尾部按 `(W−8192)×0.16` 逐字保留（小窗口按 `W×0.2`；至少保留最后一轮）
3. useKb=true 时检索 Top-8 分块，注入 system：`你是企业知识库助手。仅依据以下资料回答，资料不足时明确说明。\n【参考资料】\n...`
4. 调上游：`stream:true, stream_options:{include_usage:true}`；`none` → `thinking:{"type":"disabled"}`（DeepSeek 的思考开关，`reasoning_effort:none` 会被忽略）；`low/high/max` → `reasoning_effort`，默认 high。depth∈{none,low,high,max}
5. 429/5xx/超时：指数退避无限重试（封顶 10s；压缩辅助调用最多重试 2 次），重试期间发 `{"type":"retry","attempt":n}`
6. 上游确认上下文溢出（400/长度错误）且尚未输出内容时：强制压缩一次（保留最后一轮）后重试一次
7. 逐块解析 OpenAI 格式：`choices[0].delta.reasoning_content` → 思维链增量；`choices[0].delta.content` → 正文增量；`usage` → token。depth=none 时即使上游仍返回思维链也不展示/不落库

事件（每行 `data: {json}\n\n`，结束 `data: [DONE]`）：
- `{"type":"reasoning","delta":"..."}`
- `{"type":"content","delta":"..."}`
- `{"type":"usage","promptTokens":N,"completionTokens":N,"totalTokens":N}` → 累计入 usage_daily
- `{"type":"compaction","status":"start|done|skipped|error","reason":"auto|overflow","shadowedCount":N,"shadowedTokens":N,"summaryTokens":N,"summary":"...","endMessageId":N}` → 压缩进度；done 时前端插入检查点卡片
- `{"type":"done","messageId":N,"elapsedMs":N}`
- `{"type":"error","message":"..."}`

assistant 消息（content+reasoning+tokens+elapsedMs）在 done 前落库。压缩失败不阻塞本轮对话（`status:"error"` 后继续用完整历史）；摘要请求本身失败则本轮继续使用原历史。

### 5.1 压缩策略（对齐 DSH `compaction-basic`）

| 项 | 默认值 |
|---|---|
| 触发阈值 | `min(W×0.8, W−8192−65536)`；小窗口按比例缩小预留并夹在 `W×0.5`–`W×0.8` |
| 保留尾部 | `(W−8192)×0.16`（小窗口 `W×0.2`），对齐到 user 轮次边界；手动压缩只保留最后一轮 |
| 摘要输出上限 | 8192 tokens；达到 `finish_reason=length` 视为截断并放弃 |
| 摘要请求 | 复用会话 system + 被压缩消息，末尾追加固定压缩指令；`thinking:{"type":"disabled"}`（depth=none），最多重试 2 次 |
| 检查点 | `<compacted-summary>…</compacted-summary>` 框定；新压缩自动合并旧摘要，只保留最新一条 |
| 失效 | 编辑/删除覆盖到该检查点的消息、切换消息版本、删除会话时清除检查点 |

## 6. 部署

- `pip install -r requirements.txt && bash start.sh`（uvicorn 0.0.0.0:8321）
- .env 已含商汤默认值；页面设置可覆盖 base URL/Key/模型（settings 表持久化）
- 健康检查：GET /api/health；回滚：无状态代码 + data/ 目录备份即可

## 7. 风险与对策

| 风险 | 对策 |
|------|------|
| 上游 429 | 指数退避重试 3 次，SSE 事件 `retry` 前端提示"限流重试中" |
| reasoning 参数不被第三方兼容端点支持 | 遇 400 且报文含 reasoning/thinking 关键字时，逐个去掉 `thinking` / `reasoning_effort` 重试 |
| 上游忽略 thinking 开关仍返回思维链 | depth=none 时服务端过滤 `reasoning_content`，不展示也不落库 |
| .doc 老格式无法纯 Python 解析 | 上传校验拒绝并提示另存为 docx（白名单外交互明确报错） |
| 中文检索精度 | bigram 倒排 + 原文长度归一化，Top-8 足够轻量场景 |
