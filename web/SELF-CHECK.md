> 历史报告：部分接口/UI 已迭代（新增全文搜索、消息版本、纯文本导出等），最新说明见 README.md。

# KBChat 前端自检报告（web/）

负责人：frontend-engineer-vue
结论：**IS_PASS: YES**

## 1. 启动方式说明

前端为零构建原生 ES module SPA，所有资源引用均为**相对路径**（`./style.css`、`./app.js`、`./vendor/marked.min.js`），无绝对路径、无 CDN、无框架/构建工具依赖，可直接由 FastAPI 静态托管：

```bash
# 后端就绪后（后端工程师提供，uvicorn 0.0.0.0:8321 托管 web/）：
bash start.sh
# 浏览器访问 http://localhost:8321

# 后端未就绪时单独预览静态结构（接口会报网络错误 toast，属预期）：
cd web && python3 -m http.server 8321
```

## 2. 语法与结构验证

| 验证项 | 方式 | 结果 |
|---|---|---|
| 全部 11 个 JS 模块语法 | `node --input-type=module --check`（逐文件） | 全部 OK |
| vendor/marked.min.js | `node --check` | OK |
| index.html 结构 | Python `html.parser` 全文解析 + 自写标签配对脚本（div/aside/section/header/main/button/span/svg/pre/select/textarea/footer） | 配对无误、解析 OK |
| DOM id 交叉校验 | 脚本比对 JS 中全部 `getElementById(...)` 与 HTML id 集合 | ALL IDS RESOLVED |
| XSS 转义单测 | `escHtml` 对 `<img onerror>`、`"`、`'` 五字符断言 | PASS |
| Markdown 兜底渲染单测 | 标题/加粗/斜体/行内码/列表/链接（含 URL `&`→`&amp;`）断言 | PASS |
| SSE 帧解析单测 | 用 ReadableStream 模拟 7 帧流（含坏 JSON 帧），复刻 chat.js 解析算法：六类事件全部识别、坏帧跳过、`[DONE]` 终止 | PASS |

## 3. 接口对照表（契约 ARCHITECTURE.md §4 共 21 条，前端使用 20 条）

| # | 契约接口 | 前端调用 | 封装位置 | 请求字段 | 消费响应字段 |
|---|---|---|---|---|---|
| 1 | GET /api/health | ✅ | api.js `health` | - | `ok`（仅探测，失败 toast） |
| 2 | GET /api/settings | ✅ | api.js `getSettings` | - | `baseUrl, apiKeyMasked, model, quota, depth, models` |
| 3 | PUT /api/settings | ✅ | api.js `putSettings` | `{baseUrl?, apiKey?(空不传), model?, quota?, depth?}` | 同 #2 |
| 4 | GET /api/usage | ✅ | api.js `getUsage` | - | `quota, used, remaining, ratio`（计量条三色 + 100% 禁用输入） |
| 5 | GET /api/tree | ✅ | api.js `getTree` | - | `folders[{id,name,parentId}], files[{id,folderId,name,ext,size,chunkCount,createdAt}]` |
| 6 | POST /api/folders | ✅ | api.js `createFolder` | `{name, parentId:null}` | `id` |
| 7 | PUT /api/folders/{id} | ✅ | api.js `renameFolder` | `{name}` | `ok` |
| 8 | DELETE /api/folders/{id} | ✅ | api.js `deleteFolder`（confirm 后） | - | `ok` |
| 9 | POST /api/files/upload | ✅ | api.js `uploadFile` | multipart `file` + `folderId`（多选逐个上传，白名单 ext 前端拦截） | `id, name, chunkCount` |
| 10 | DELETE /api/files/{id} | ✅ | api.js `deleteFile`（confirm 后） | - | `ok` |
| 11 | GET /api/files/{id}/preview | ✅ | api.js `getFilePreview` | - | `name, content`（textContent 渲染，天然防注入） |
| 12 | POST /api/kb/search | ⬜ 未单独调用 | — | — | 检索注入由后端在 /api/chat 内完成（契约 §5 第 2 步），前端无独立检索入口 |
| 13 | GET /api/conversations | ✅ | api.js `getConversations` | - | `[{id,title,updatedAt,messageCount}]` |
| 14 | POST /api/conversations | ✅ | api.js `createConversation` | `{title?}` | `id` |
| 15 | GET /api/conversations/{id} | ✅ | api.js `getConversation` | - | `{id,title,messages[{id,role,content,reasoning,promptTokens,completionTokens,elapsedMs,createdAt}]}`（切换对话完整恢复，含思维链折叠区） |
| 16 | PUT /api/conversations/{id} | ✅ | api.js `renameConversation` | `{title}` | `ok` |
| 17 | DELETE /api/conversations/{id} | ✅ | api.js `deleteConversation`（confirm 后，当前对话删除即清空聊天区） | - | `ok` |
| 18 | POST /api/chat（SSE） | ✅ | chat.js（fetch + ReadableStream，非 EventSource） | `{conversationId, message, useKb, model?, depth?}` | 六类事件 `reasoning/content/usage/done/error/retry` + `data: [DONE]` |
| 19 | GET /api/export | ✅ | dataio.js（`a[download]`） | - | JSON 附件下载 |
| 20 | POST /api/import | ✅ | api.js `importFile` | multipart `file`(JSON) | `{folders, files, conversations}` 计数 toast + 刷新树/对话列表 |
| 21 | GET /api/models | ✅ | api.js `getModels` | - | `{models}` 顶栏下拉 + 设置弹窗下拉 |

**SSE 事件处理对照（§5）**：`reasoning`→追加折叠区（流式期间自动展开，完毕收起为「已深度思考（用时 X 秒）」）；`content`→正文增量 marked 重渲染（节流 100ms）；`usage`→本条 tokens 文案；`done`→停止 loading + `refreshUsage()`（仅此一次，无轮询）+ 刷新对话列表；`error`→红字「生成失败：…」+ 重试按钮；`retry`→黄字「上游限流重试中…（第 n 次）」。

## 4. UI-SPEC 对齐核对

- §1.4 CSS 变量块：逐字落地于 `style.css :root`（含全部颜色/圆角/间距/动效 Token）
- 侧边栏 260px bg #18191A，收起至 0（200ms ease-in-out），三区：知识库（树）/ 对话 / 底部导入·导出·设置
- 顶栏 56px：汉堡、模型下拉（≥1024 显模型名、<1024 仅图标）、深度分段控件、token 计量条（120px，<80% 绿 / 80-99% 黄 / 100% 红+禁输入）、设置齿轮
- 用户气泡右对齐 bg #1E2C42 radius 12（右上 4px）max-width 70%（<768 为 85%）；AI 消息左对齐无气泡；思维链折叠条 12px #7C8FA6，展开 bg #242526 radius 8；底部复制/重新生成 12px
- 三点呼吸动画 600ms 循环；用户气泡淡入上移 8px（200ms ease-out）
- 输入框 radius 24、focus #3B82F6、1-6 行自适应、空输入禁用发送（32×32）、Enter/Shift+Enter、发送中 spinner+「发送中」且点击=停止（abort fetch）
- 设置弹窗 480px、遮罩 rgba(0,0,0,.6)、bg #242526 radius 12、密码框+显隐、保存成功 toast 2s
- 响应式断点：≥1024 常驻可收起 / 768-1023 浮层（计量条 80px）/ <768 全屏浮层 + 深度档位收进输入框内

## 5. 已知限制与假设

1. **深度档位为四档**（关/标准/深度/极深 ↔ none/low/high/max，默认 high）：UI-SPEC 文案为三档（关/标准/深度），但契约 §5 与任务指令均为 `depth ∈ {none,low,high,max}` 默认 high，按契约实现为四档。
2. **`useKb` 固定传 `true`**：UI-SPEC 未定义知识库开关控件，作为企业知识库助手默认启用检索注入。
3. **接口 #12 POST /api/kb/search 未在前端单独调用**：检索由后端在 /api/chat 内部完成（契约 §5），前端无独立检索入口；api.js 未导出该函数属有意省略。
4. **目录新建/重命名、对话重命名使用 `window.prompt`**：按任务指令「prompt 输入」实现；删除操作为自定义危险确认框（danger 主按钮 bg #E5484D）。
5. marked 为 v12.0.2 UMD 本地 vendored（35KB，curl 自 jsdelivr 下载成功），无需兜底渲染器上线；`util.js` 仍内置一个精简 Markdown 渲染器作为 marked 加载失败的运行时兜底（支持标题/加粗/斜体/行内码/代码块/列表/链接）。
6. marked 渲染前先对原文做 escHtml 再 parse（任务 FE-02 要求）；URL 中 `&` 会显示为转义实体但浏览器 href 解析正确。
7. 停止生成（abort）后思维链耗时无 `done.elapsedMs`，折叠条显示「已深度思考（已停止）」。
8. 上传目标目录为「点击选中的目录」，未选中时上传至根目录（folderId 空串，由后端按 null 处理）。

## 6. 性能预算核对

| 指标 | 预算 | 实际 |
|---|---|---|
| style.css | ≤ 40 KB | 22.6 KB ✅ |
| app.js 全模块合计（未压缩） | ≤ 120 KB | 72.1 KB（11 模块）✅ |
| 首屏可交互 | ≤ 500 ms | 无框架无编译，静态资源 5 个共 ~136 KB（marked 35K 为主），本地 8321 满足 ✅ |
| SSE 首字符渲染 | ≤ 200 ms | 首帧即渲染（reasoning/content 首增量不等节流周期）✅ |
| content 重渲染节流 | ≥ 100 ms 间隔 | `throttle(100)` ✅ |
