> 历史报告：部分接口/UI 已迭代（新增全文搜索、消息版本、纯文本导出等），最新说明见 README.md。

# KBChat 测试报告

> 测试人：查无漏（QA）· 测试时间：2026-10-27 · 服务：http://127.0.0.1:8321（uvicorn，启动日志：索引加载 9 分块/132 term）
> 测试脚本：`qa_test/run_tests.py`（35 用例主套件）、`qa_test/chat_retry.py`（真实上游专项，含 429 退避重试）
> 结果原始数据：`/tmp/qa_results.json`、`/tmp/qa_chat_retry.json`

## 1. 测试概览

| 项 | 内容 |
|----|------|
| 测试范围 | 契约 21 条接口全部覆盖（含错误路径）· 真实上游 SSE 对话（depth=high/none）· token 计量断言 · 前端静态资源 · 导入导出闭环 |
| 用例总数 | 35 |
| 通过 / 失败 / 阻塞 | 35 / 0 / 0 |
| 通过率 | 100.0% |
| 结论 | **PASS，放行交付：YES** |

说明：首轮主套件执行时真实上游连续 429（TC-24~TC-27 首轮失败），retry 事件按契约出现（attempt 1/2/3 后 error），符合 FR-12 设计；经退避后专项脚本补验全部通过。429 为上游限流预期行为，不计缺陷。

## 2. 用例与结果

| 编号 | 模块 | 用例 | 预期 | 实际 | 结果 |
|------|------|------|------|------|------|
| TC-01 | 健康检查 | GET /api/health | `{ok:true}` | HTTP 200 `{"ok":true}` | PASS |
| TC-02 | 设置 | GET /api/settings 契约字段 | baseUrl/apiKeyMasked/model/quota/depth/models 齐全 | 全部存在，model=deepseek-flash，depth=high | PASS |
| TC-03 | 设置·错误路径 | PUT settings apiKey 留空 | apiKey 不被清空 | before/after 均为 `sk-***fP1` | PASS |
| TC-04 | 设置·错误路径 | PUT settings depth=ultra | 400 | 400 `depth 仅支持 none、low、high、max` | PASS |
| TC-05 | 用量 | GET /api/usage | 四字段齐全且 ratio=round(used/quota,4) | used=2427, ratio=0.0024 计算一致 | PASS |
| TC-06 | 目录树 | GET /api/tree | folders/files 数组 | 结构正确 | PASS |
| TC-07 | 目录 | POST /api/folders | 返回 {id} 且出现在 tree | id=3，tree 可见 | PASS |
| TC-08 | 目录·错误路径 | 父目录不存在 | 404 | 404 `父目录不存在：999999` | PASS |
| TC-09 | 目录 | PUT 重命名 | `{ok:true}` 且 tree 生效 | 名称变更为 -R 后缀 | PASS |
| TC-10 | 目录·错误路径 | 移动到自身 | 400 | 400 `不能把目录移动到自身或其子目录下` | PASS |
| TC-11 | 上传 | 上传自建 txt | `{id,name,chunkCount>0}` | fileId=5, chunkCount=2 | PASS |
| TC-12 | 上传·错误路径 | 非法扩展 .exe | 400 | 400 `不支持的文件类型：.exe…` | PASS |
| TC-13 | 上传·错误路径 | >20MB 文件 | 400 | 400 `文件超过 20MB` | PASS |
| TC-14 | 预览 | GET /api/files/{id}/preview | name+content≤5000 字且含测试标记 | contentLen=498，含标记 | PASS |
| TC-15 | 预览·错误路径 | 不存在文件 | 404 | 404 `文件不存在：999999` | PASS |
| TC-16 | 检索 | POST /api/kb/search | 命中测试文件 | Top1 fileName=测试文件，score=0.7186 | PASS |
| TC-17 | 文件·错误路径 | DELETE 不存在文件 | 404 | 404 | PASS |
| TC-18 | 对话 | GET /api/conversations | 列表结构 | 结构正确（原有 2 条对话保留可见） | PASS |
| TC-19 | 对话 | POST /api/conversations | `{id}` | convId=4 | PASS |
| TC-20 | 对话 | GET /api/conversations/{id} | id/title/messages | 一致 | PASS |
| TC-21 | 对话·错误路径 | 不存在对话 | 404 | 404 `会话不存在：999999` | PASS |
| TC-22 | 对话 | PUT 重命名 | ok 且列表生效 | 生效 | PASS |
| TC-23 | 对话·错误路径 | DELETE 不存在对话 | 404 | 404 | PASS |
| TC-24 | 对话 SSE | chat depth=high useKb=true | 事件含 reasoning/content/usage/done + [DONE]；/api/usage 增量==usage.totalTokens | 事件类型 `[DONE]/content/done/reasoning/retry/usage` 齐全（先 429 触发 retry 后成功）；增量 2108 == totalTokens 2108 | PASS |
| TC-25 | 对话 SSE | depth=high 回答引用测试文件 | 含「张三丰」与「QA42」 | 回答原文："青鸾计划负责人是**张三丰**，秘密代码是**QA42**" | PASS |
| TC-26 | 对话 SSE | assistant 落库 | 含 reasoning/tokens/elapsedMs，completionTokens==usage 事件 | persisted=true，reasoning 长度 93，completionTokens=80 一致 | PASS |
| TC-27 | 对话 SSE | chat depth=none | 无 reasoning 事件，有 content/usage/done，增量==totalTokens | 类型 `[DONE]/content/done/usage`，无 reasoning；增量 2370 == totalTokens 2370 | PASS |
| TC-28 | 对话·错误路径 | chat 会话不存在 | 404 | 404 | PASS |
| TC-29 | 模型 | GET /api/models | `{models:[...]}` | 2 个模型 | PASS |
| TC-30 | 导出 | GET /api/export | version/exportedAt/含测试实体，settings 不含 api_key | version=1，测试目录/文件/分块(2)/对话(2 消息)均在，settings 无 api_key | PASS |
| TC-31 | 导入 | POST /api/import 回导测试实体 | `{folders:1,files:1,conversations:1}` | 完全一致 | PASS |
| TC-32 | 导入闭环 | 回导副本可查询 | 目录/文件副本在 tree，对话副本消息数与导出一致 | copyFolderId=4/copyFileId=6/copyConvId=5，消息数 2 一致 | PASS |
| TC-33 | 导入·错误路径 | 非 JSON | 400 | 400 `导入文件不是合法 JSON…` | PASS |
| TC-34 | 导入·错误路径 | 不支持版本 99 | 400 | 400 `不支持的导出演出版本：99…` | PASS |
| TC-35 | 前端静态 | GET / 及引用资源 | 200 且 ./style.css、./app.js、./vendor/marked.min.js 全 200 | 三资源均 200 | PASS |

## 3. 缺陷清单

| 编号 | 严重度 | 优先级 | 模块 | 描述 | 最小复现 | 证据 | 归属 | 建议 |
|------|--------|--------|------|------|----------|------|------|------|
| 无 | - | - | - | 本轮未发现源码缺陷 | - | - | NoOne | - |

环境性观察（非缺陷）：真实上游商汤端点首轮连续 429，服务端按契约发出 `retry 1/2/3` 后 `error` 事件并以 `data: [DONE]` 收尾，已生成部分落库逻辑存在（代码审查确认）；退避后重试成功，FR-12 链路验证通过。

## 4. 性能与安全结论

| 项 | 指标 | 实测 | 结论 |
|----|------|------|------|
| SSE done 耗时 | 首轮 depth=high（含 1 次 429 重试） | elapsedMs=2811（成功轮） | 符合 PRD 首 token ≤3s 量级 |
| 检索命中 | kb/search Top-1 命中自建文件 | score=0.7186，同步返回 | 符合 FR-05 |
| token 计量 | 增量==usage.totalTokens | 2108/2370 两轮均精确一致 | 符合 FR-13 精确到 1 token |
| 越权/注入 | 非法 ext、>20MB、非法 depth、不存在 id（files/folders/conversations/chat）、非法导入 JSON/版本 | 全部 400/404 明确拒绝，无 500 | 本轮未发现注入与信息泄露面；完整 OWASP 扫描未在本轮范围 |
| API Key 保护 | 导出不含 api_key；GET settings 仅返回掩码 | `sk-***fP1` | 符合契约 §4 #19 |

## 5. 智能路由判定

- 判定结果：**NoOne**（无源码缺陷需路由；测试代码自研自测通过）
- 判定依据：35/35 用例通过；错误路径响应码与错误文案全部符合契约 §4 错误约定（`{detail}` + 4xx）；429 重试链为上游限流的预期设计行为。

## 6. 清理与数据安全

| 项 | 结果 |
|----|------|
| 自建对话删除（原件+导入副本） | 完成，删除后 GET 返回 404 |
| 自建目录/文件删除（原件+导入副本，级联分块） | 完成 |
| 数据残留校验 | tree/conversations 与测试前快照逐 id 比对，残留 0/0/0 |
| 原有数据（测试目录2、kbchat-sample.txt/.xlsx、对话 id=2/3） | 全程未改动，测后保留 |
| usage 计量 | 因真实对话 +4478 tokens（2108+2370），属契约"只增不减"预期 |

## 7. 遗留问题与风险

1. depth=low/max 未实测（契约允许四档，本轮按主理人指定覆盖 high/none）；depth=max 消耗大，建议交付后抽查 1 轮。
2. 客户端中断生成（停止按钮 → GeneratorExit 落库路径）未做真实浏览器断连实测，仅代码审查确认；建议 UI 阶段 Playwright 补验。
3. 上游 429 在高峰期可能频发，前端"限流重试中"提示依赖 retry 事件，已验证事件按契约发出；建议保留 .env 中可替换 base URL 作为兜底。
4. 首轮执行时服务处于停止状态（背景进程随会话终止被杀），已按预案重启并全程保持在线；交付脚本 `start.sh` 依赖用户手动执行，属部署约定非缺陷。
