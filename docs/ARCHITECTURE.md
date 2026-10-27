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
- messages(id PK, conv_id, role, content, reasoning, prompt_tokens, completion_tokens, elapsed_ms, created_at)
- usage_daily(date TEXT PK, tokens INTEGER)
- settings(key TEXT PK, value TEXT)

## 4. REST 接口契约（字段级，全部前缀 /api）

| # | 方法/路径 | 请求 | 响应 |
|---|-----------|------|------|
| 1 | GET /api/health | - | `{ok:true}` |
| 2 | GET /api/settings | - | `{baseUrl, apiKeyMasked, model, quota, depth, models:["deepseek-flash"]}` |
| 3 | PUT /api/settings | `{baseUrl?, apiKey?(空串=不改), model?, quota?, depth?}` | 同 2 |
| 4 | GET /api/usage | - | `{quota, used, remaining, ratio}` ratio=used/quota 保留4位 |
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
| 15 | GET /api/conversations/{id} | - | `{id,title,messages:[{id,role,content,reasoning,promptTokens,completionTokens,elapsedMs,createdAt}]}` |
| 16 | PUT /api/conversations/{id} | `{title}` | `{ok:true}` |
| 17 | DELETE /api/conversations/{id} | - | `{ok:true}` |
| 18 | POST /api/chat | `{conversationId, message, useKb:bool, model?, depth?}` | **SSE 流**，见 §5 |
| 19 | GET /api/export | - | JSON 附件下载 `{version, exportedAt, folders, files(含content), chunks, conversations(含messages), settings(不含apiKey)}` |
| 20 | POST /api/import | multipart: file(JSON) | `{folders, files, conversations}` 计数（导入为合并，id 冲突重新分配） |
| 21 | GET /api/models | - | `{models:[...]}` 供前端下拉 |

错误约定：非流式接口统一 `{detail: "..."}` + HTTP 4xx/5xx。

## 5. POST /api/chat SSE 事件流

服务端流程：
1. 取会话历史最近 20 条（role user/assistant，不含 reasoning）
2. useKb=true 时检索 Top-8 分块，注入 system：`你是企业知识库助手。仅依据以下资料回答，资料不足时明确说明。\n【参考资料】\n...`
3. 调上游：`stream:true, stream_options:{include_usage:true}, reasoning_effort:<depth>`，depth∈{none,low,high,max}，默认 high
4. 429/5xx 重试 3 次（1s/2s/4s + 随机抖动），重试期间发 `{"type":"retry","attempt":n}`
5. 逐块解析 OpenAI 格式：`choices[0].delta.reasoning_content` → 思维链增量；`choices[0].delta.content` → 正文增量；`usage` → token

事件（每行 `data: {json}\n\n`，结束 `data: [DONE]`）：
- `{"type":"reasoning","delta":"..."}`
- `{"type":"content","delta":"..."}`
- `{"type":"usage","promptTokens":N,"completionTokens":N,"totalTokens":N}` → 累计入 usage_daily
- `{"type":"done","messageId":N,"elapsedMs":N}`
- `{"type":"error","message":"..."}`

assistant 消息（content+reasoning+tokens+elapsedMs）在 done 前落库。

## 6. 部署

- `pip install -r requirements.txt && bash start.sh`（uvicorn 0.0.0.0:8321）
- .env 已含商汤默认值；页面设置可覆盖 base URL/Key/模型（settings 表持久化）
- 健康检查：GET /api/health；回滚：无状态代码 + data/ 目录备份即可

## 7. 风险与对策

| 风险 | 对策 |
|------|------|
| 上游 429 | 指数退避重试 3 次，SSE 事件 `retry` 前端提示"限流重试中" |
| reasoning_effort 不被第三方兼容端点支持 | 遇 400 且报文含 reasoning/thinking 关键字时自动去除该参数重试一次 |
| .doc 老格式无法纯 Python 解析 | 上传校验拒绝并提示另存为 docx（白名单外交互明确报错） |
| 中文检索精度 | bigram 倒排 + 原文长度归一化，Top-8 足够轻量场景 |
