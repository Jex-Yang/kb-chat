# KBChat 后端任务列表（契约源：ARCHITECTURE.md 冻结版）
> 历史文档（2026-10-27 的任务/交付记录）。当前实现、部署与已知变更见 README.md 与 docs/ARCHITECTURE.md §0。

负责工程师：全部 `backend-engineer-python`（Python 3.13 + FastAPI + uvicorn，stdlib sqlite3）
实现顺序建议：BE-01 → (BE-02 ∥ BE-03) → BE-04 → BE-05 → (BE-06 ∥ BE-07) → BE-08；关键路径：BE-01→BE-05→BE-06→BE-08。

## BE-01 配置与数据库层
- 依赖：无。文件：`server/config.py`、`server/db.py`、`requirements.txt`、`start.sh`、`.env.example`
- 验收：
  1. config.py 读 `.env`（API_BASE_URL/API_KEY/DEFAULT_MODEL/TOKEN_QUOTA）+ settings 表，环境变量优先；含 `get_settings()`/`save_settings(dict)`，apiKey 空串=不覆盖
  2. db.py 建表 7 张，DDL 字段与契约 §3 逐字段一致（folders/files/chunks/conversations/messages/usage_daily/settings）；连接启用 `PRAGMA journal_mode=WAL`、`PRAGMA foreign_keys=ON`
  3. 提供 DAO：folder/file/chunk/conversation/message/usage 的增删改查函数，chunk 支持 `by_file(file_id)`、message 支持 `recent(conv_id, n=20)`（role∈user/assistant，不含 reasoning）
  4. `bash start.sh` 后 `sqlite3 data/kb.db .tables` 输出 7 张表；uvicorn 启动 0.0.0.0:8321

## BE-02 文档解析器
- 依赖：BE-01。文件：`server/parsers.py`
- 验收：
  1. `parse(ext, bytes) -> str`：txt/md/csv 原生读取（utf-8，容错 gbk fallback）；pdf→pypdf 逐页拼接；docx→python-docx 段落文本；xlsx→openpyxl 单元格制表符拼接、行换行
  2. 扩展名白名单 {txt,md,csv,pdf,docx,xlsx}，白名单外抛 `ValueError("不支持的文件类型，.doc 请另存为 docx")`（契约 §7）
  3. 解析失败抛异常且异常 message 可直接作为 `{detail}` 返回；10MB 内 PDF 解析 ≤10s

## BE-03 分块与 bigram 检索
- 依赖：BE-01。文件：`server/chunker.py`
- 验收：
  1. `chunk(text) -> list[str]`：按 600 字分块、相邻块重叠 100 字；空文本返回 []
  2. `build_index(chunks)`：启动/入库时全量加载进内存，构建字符 bigram 倒排（dict[bigram→dict[chunk_idx→tf]]）
  3. `search(query, top_k=8) -> [{file_id, file_name, score, text}]`：bigram 倒排评分 + 原文长度归一化，按 score 降序；score 保留 4 位小数
  4. 性能：10MB 语料检索 P95 ≤ 200ms（附 `bench_search.py` 压测脚本）；文件删除后对应 chunk 从索引移除（提供 `remove_file(file_id)`）

## BE-04 LLM 上游流式客户端
- 依赖：BE-01。文件：`server/llm.py`
- 验收：
  1. httpx 异步流式 POST `{base_url}/chat/completions`，请求体含 `stream:true`、`stream_options:{include_usage:true}`、`reasoning_effort`∈{none,low,high,max}（默认 high）、messages 列表
  2. 429/5xx 指数退避重试 3 次（1s/2s/4s+随机抖动 ≤0.5s），每次重试前 yield `("retry", attempt)`；3 次后抛异常
  3. 逐块解析 OpenAI SSE：`choices[0].delta.reasoning_content`→("reasoning", str)；`choices[0].delta.content`→("content", str)；`usage`→("usage", dict)；返回 async generator
  4. 400 且报文含 reasoning/thinking 关键字时去除 reasoning_effort 参数重试一次（契约 §7）

## BE-05 REST 路由（非流式全部）
- 依赖：BE-01/BE-02/BE-03。文件：`server/routes/api_routes.py`
- 验收：契约 §4 中除 #18 外全部 20 个接口字段级一致：
  1. GET /api/health→`{ok:true}`；GET/PUT /api/settings 响应含 baseUrl/apiKeyMasked(掩码如 `sk-***abc`)/model/quota/depth/models 数组；GET /api/usage→`{quota,used,remaining,ratio}`（ratio=used/quota 4 位小数）
  2. 目录树 GET /api/tree 响应结构 `{folders:[{id,name,parentId}],files:[{id,folderId,name,ext,size,chunkCount,createdAt}]}`；POST/PUT/DELETE /api/folders、DELETE 级联删子目录+文件+分块并清内存索引
  3. POST /api/files/upload（multipart file+folderId）：>20MB 拒绝 `{"detail":"文件超过 20MB"}`；成功落盘 data/uploads 并返回 `{id,name,chunkCount}`
  4. GET /api/files/{id}/preview→`{name,content}` content 截断 5000 字；POST /api/kb/search→契约 #12 数组结构
  5. conversations 五个接口（list/create/get/put/delete）响应字段与契约 #13–17 一致，messageCount 与 messages 字段名按驼峰
  6. GET /api/models→`{models:["deepseek-flash"]}`
  7. 错误统一 `{detail:"..."}` + 对应 4xx/5xx

## BE-06 Chat SSE 流式接口
- 依赖：BE-04/BE-05。文件：`server/routes/api_routes.py`（/api/chat）、`server/db.py`（落库）
- 验收：
  1. FastAPI StreamingResponse，media_type=`text/event-stream`；每行 `data: {json}\n\n`，结束 `data: [DONE]`
  2. 流程：取会话最近 20 条历史→useKb=true 时检索 Top-8 注入 system（文案按契约 §5 原文）→调 BE-04
  3. 事件类型 reasoning/content/usage/done/error 字段级符合契约 §5；usage 事件触发后累加 usage_daily（按日期 UPSERT）
  4. done 前将 assistant 消息（content+reasoning+promptTokens+completionTokens+elapsedMs）落库，done 携带 messageId 与 elapsedMs
  5. 客户端断连（断开生成）时仍落库已生成部分并终止上游请求

## BE-07 导入/导出
- 依赖：BE-01/BE-05。文件：`server/routes/api_routes.py`（#19/#20）
- 验收：
  1. GET /api/export 返回 JSON 附件（Content-Disposition），结构 `{version,exportedAt,folders,files(含content),chunks,conversations(含messages),settings(不含apiKey)}`
  2. POST /api/import 校验 JSON version 字段；合并导入，id 冲突重新分配并维护 folder_id/file_id/chunk_id/message.conv_id 外键映射；响应 `{folders,files,conversations}` 三计数
  3. 导入成功后全量重建内存索引；导出文件可直接再导入且三方计数一致

## BE-08 main 入口与静态托管
- 依赖：BE-05。文件：`server/main.py`、`start.sh`
- 验收：
  1. FastAPI 实例注册全部路由；挂载 `web/` 静态目录，`GET /` 返回 index.html
  2. 启动时执行 db 初始化 + chunker 全量加载索引（data/kb.db 存在分块时）
  3. `pip install -r requirements.txt && bash start.sh` 后：`curl localhost:8321/api/health`→`{"ok":true}`；`curl localhost:8321/`返回 HTML 200

## 全局实现要点
- SQLite 全程 WAL 模式，单连接 + `check_same_thread=False` + 写操作加 `threading.Lock`，避免 uvicorn 多线程写锁
- SSE 必须用 `StreamingResponse` + async generator，禁用响应缓冲中间件；每事件显式 `\n\n` 结尾
- 内存索引加载时机：进程启动（BE-08）+ 上传解析完成（BE-05 调 chunker.add）+ 导入完成（BE-07 重建），删除文件即时移除（BE-05/BE-03.remove_file）
- API Key 掩码规则：前 3 + `***` + 后 3，长度 ≤8 时全掩码；任何日志/响应不得输出明文 Key（PRD §7 安全项）
