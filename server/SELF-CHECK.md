> 历史报告：部分接口/UI 已迭代（新增全文搜索、消息版本、纯文本导出等），最新说明见 README.md。

# KBChat 后端自测报告（SELF-CHECK）

- 执行人：backend-engineer-python（彭森宇）
- 日期：2026-10-27
- 环境：macOS / Python 3.13.12 / 项目内 venv `.venv/`（依赖来自 requirements.txt，未改动其顺序）
- 服务启动：`bash start.sh`（等价于 `.venv/bin/uvicorn server.main:app --host 0.0.0.0 --port 8321`）
- 契约源：docs/ARCHITECTURE.md 契约冻结版（§2/§3/§4/§5/§7）

## 一、执行过的命令

```bash
python3 -m venv .venv
./.venv/bin/pip install -q -r requirements.txt
./.venv/bin/python -m compileall -q server/          # 语法检查通过
# 单元冒烟（chunker/parsers，见下文断言）
./.venv/bin/python -c "..."                          # all-ok
./.venv/bin/python -m server.bench_search 5000 200   # 检索压测
# 端到端（/tmp/kbchat-e2e.sh，38 项断言）
/tmp/kbchat-e2e.sh
# 断连落库验证：curl --max-time 3 发起 chat 后主动断开
```

## 二、单元冒烟结果

- `chunker.chunk('a'*1300)` → `[600, 600, 300]`（块 600 字 / 重叠 100，末块截断）✓
- `chunker.chunk('')` → `[]` ✓
- `parsers.parse('txt'/'csv')` 正常；csv 转 Markdown 表格 ✓
- `parsers.parse('doc', ...)` → `ValueError("不支持 .doc 老格式，请另存为 docx 后再上传")` ✓
- 索引 add/remove/search：命中后 `remove_file` 再检索为空 ✓

## 三、检索压测（BE-03 验收：P95 ≤ 200ms）

```
$ ./.venv/bin/python -m server.bench_search 5000 200
chunks=5000 queries=200 build=0.42s p50=2.07ms p95=3.41ms
PASS (P95 门槛 200ms)
```

## 四、端到端 curl 验证（38/38 通过）

启动后按契约 §4 顺序验证，关键证据片段：

### 1. 健康检查 / 设置 / 用量
```
GET /api/health   → {"ok":true}
GET /api/settings → {"baseUrl":"https://token.sensenova.cn/v1","apiKeyMasked":"sk-***fP1",
                     "model":"deepseek-flash","quota":1000000,"depth":"high",
                     "models":["deepseek-flash"]}
PUT /api/settings {"quota":2000000} → quota=2000000 生效（settings 表持久化覆盖）
PUT /api/settings {"apiKey":""}     → apiKeyMasked 不变（空串=不覆盖）✓
GET /api/usage    → {"quota":1000000,"used":0,"remaining":1000000,"ratio":0.0}
```

### 2. 目录树 / 文件
```
POST /api/folders {"name":"测试目录","parentId":null} → {"id":1}
POST /api/files/upload (txt) → {"id":1,"name":"kbchat-sample.txt","chunkCount":8}
POST /api/files/upload (xlsx) → {"id":2,"name":"kbchat-sample.xlsx","chunkCount":1}
POST /api/files/upload (.doc) → 400 {"detail":"不支持 .doc 老格式，请另存为 docx 后再上传"}
GET  /api/files/2/preview → {"name":"kbchat-sample.xlsx","content":"| 部门 | 预算(万元) | 负责人 |...}
```

### 3. 检索
```
POST /api/kb/search {"query":"bigram 倒排索引 分块检索"} → 命中 txt，score=0.497
POST /api/kb/search {"query":"研发部 预算 负责人"}       → 命中 xlsx，text 含"研发部"
```

### 4. 真实对话（商汤上游，depth=high，useKb=true）
```
POST /api/chat {"conversationId":1,"message":"KBChat 支持哪些文件格式？..."}
SSE 事件统计：reasoning ×14、content ×8、usage ×1、done ×1，末尾 data: [DONE]
data: {"type":"usage","promptTokens":2373,"completionTokens":54,"totalTokens":2427}
data: {"type":"done","messageId":3,"elapsedMs":1128}
```
- 回答正确引用了上传文档内容（"KBChat 支持上传 pdf、docx、xlsx、csv、txt、md 格式的文档。"），说明 KB 注入生效
- 另一轮真实调用中观测到上游 429 → `data: {"type":"retry","attempt":1}` / `"attempt":2` 后成功（指数退避重试验证 ✓）

### 5. token 计量累加
```
GET /api/usage（对话后）→ {"quota":1000000,"used":2427,"remaining":997573,"ratio":0.0024}
used: 0 → 2427（与 usage 事件 totalTokens 一致）✓
```

### 6. 消息落库（含 reasoning）
```
GET /api/conversations/1 → messages 含 assistant：
  reasoning 非空、promptTokens/completionTokens>0、elapsedMs>0（驼峰字段）✓
```

### 7. 断连落库（BE-06 验收 5）
```
curl --max-time 3 发起 chat 后主动断开 →
GET /api/conversations/3 →
  role=assistant reasoning_len=424 elapsedMs=3000（已生成部分落库，连接终止）✓
```

### 8. 导出 / 导入
```
GET /api/export → JSON 附件（Content-Disposition: attachment），结构含
  version/exportedAt/folders/files(含content)/chunks/conversations(含messages)/settings(不含apiKey)
  且全文不含明文 apiKey（grep sk-nwjAl 无命中）✓
删除全部文件/目录/对话 → tree 为空、kb/search 为空（索引同步清理）✓
POST /api/import → {"folders":1,"files":2,"conversations":1} 计数一致 ✓
导入后 kb/search 恢复命中 xlsx、对话与 reasoning 恢复 ✓
```

### 9. 静态托管
```
GET / → 200（web/ 已由前端同学填充 index.html；后端 StaticFiles html=True 挂载）
GET /api/models → {"models":["deepseek-flash"]} ✓
```

## 五、关键实现说明

- **异步/并发**：SSE 用 StreamingResponse + async generator，事件以紧凑 JSON `data: {...}\n\n` 输出；上游 httpx.AsyncClient 流式转发；SQLite 单连接 + WAL + 写锁
- **配置优先级**：settings 表（PUT /api/settings 持久化）> 环境变量/.env（仅默认值）
- **检索评分**：score = 匹配查询 bigram 占比 × (600/(600+len(text)))，保留 4 位小数；上传/删除/导入三个时机同步增删/重建内存索引
- **重试策略**：429/5xx/超时退避 1s/2s/4s + ≤0.5s 抖动共 3 次，每次重试前发 `retry` 事件；400 含 reasoning/thinking 时去 reasoning_effort 重试一次
- **API Key 安全**：掩码规则前3+***+后3；明文 Key 不出现在任何日志、响应、导出文件

## 六、已知限制

1. **检索评分公式**：契约仅要求"匹配 bigram 占比 × 归一化"，具体归一化因子（600/(600+len)）为本实现选定，属【假设】项
2. **docx 表格**：python-docx 按段落优先、表格追加方式输出（非严格文档流顺序），内容不丢失
3. **usage 断连时**：客户端中途断开时上游 usage 块通常未到达，该条消息 prompt/completionTokens 落库为 0（已生成文本仍保留）
4. **exports 中的 files.path**：导出/导入保留原 path 字符串；上传物理文件不入导出包（content 已全量包含，检索不受影响）
5. **GET /api/docs**：FastAPI 自带 OpenAPI 文档挂载在 /api/docs，仅开发用

## 七、IS_PASS 判定

**IS_PASS: YES**

依据：契约 §4 全部 21 接口字段级实现并经 curl 实测；§5 SSE 事件全类型（reasoning/content/usage/done/error 通道 + retry）实测出现；真实商汤上游对话成功且 token 计量累加一致；export→删除→import 恢复闭环通过；38/38 断言通过、单元冒烟与压测通过；API Key 全程无明文泄漏。
