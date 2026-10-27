# KBChat 前端任务列表

> 技术栈：零构建原生 JS SPA（web/index.html + web/app.js ES module + web/style.css），marked.min.js 已在 web/vendor/。契约源：ARCHITECTURE.md §4/§5；视觉源：UI-SPEC.md。负责 Agent ID：frontend-engineer-vue（全部任务）。

## 任务列表（按实现顺序）

| # | 任务 | 依赖 | 涉及文件 | 验收标准 |
|---|------|------|---------|---------|
| FE-01 | 全局布局与侧边栏收起 | - | index.html, style.css, app.js(入口模块) | 三栏框架：侧边栏 260px（bg #18191A）可收起至 0（200ms ease-in-out）；顶栏 56px 含汉堡/模型下拉/深度分段控件/token 计量条/设置齿轮；对话流与输入框居中 max-width 760px；UI-SPEC §1.4 CSS 变量块完整落地于 :root；断点行为符合 §4（≥1024 常驻 / 768-1023 浮层 / <768 全屏浮层） |
| FE-02 | 请求层 + 公共工具 | - | app.js/api.js, app.js/util.js | api.js 统一封装 fetch：非 2xx 解析 `{detail}` 抛错并 toast；导出 §4 接口 1-14、16-17、19-21 的调用函数；util.js 含 escAttr/escHtml（&<>"' 五字符转义）、formatTime、mdRender（marked.parse，渲染前先 escHtml 原文，marked 配置 breaks:true）；所有动态 DOM 注入必须经 escHtml |
| FE-03 | 目录树组件（知识库） | FE-02 | app.js/tree.js, style.css | 渲染 GET /api/tree 两级目录树：folder 节点点击展开/收起（箭头 150ms 旋转 90°）；「新建目录」调 POST /api/folders{name,parentId:null}；右键/悬浮菜单支持重命名(PUT)与删除(DELETE，级联，danger 确认框)；「上传」触发 file input，POST /api/files/upload(multipart file+folderId)，白名单外 ext 前端即拦截提示；文件项 hover 显示删除图标 #E5484D；空态文案"暂无文件，点击上传"；点击文件调 /preview 弹层显示截断内容（content 经 escHtml） |
| FE-04 | 对话列表 | FE-02 | app.js/conversations.js | 侧边栏区块二渲染 GET /api/conversations（title+时间小字）；「新建对话」POST /api/conversations 后清空聊天区并选中新项（bg #1E2C42）；点击项 GET /api/conversations/{id} 加载消息；hover 浮出重命名(PUT {title})/删除(DELETE，确认框)图标；删除当前对话后清空聊天区 |
| FE-05 | 聊天流 + SSE 渲染 + 思维链折叠 | FE-02, FE-04 | app.js/chat.js, style.css | POST /api/chat 用 fetch + response.body.getReader() + TextDecoder 流式读取，按 \n\n 分帧、剥离 `data: ` 前缀逐事件处理：reasoning.delta 追加至折叠区、content.delta 追加正文并 mdRender 增量重渲染（节流 ≤100ms）；usage 事件更新本条 token；done 事件停止 loading、显示"已深度思考（用时 X 秒）"折叠条与底部复制/重新生成；error 事件显示红字"生成失败，请重试"+重试按钮；retry 事件显示"限流重试中"；[DONE] 帧终止读取并调 refreshUsage()；发送中用户气泡淡入上移 8px，AI 回复前三点呼吸动画 600ms；用户消息右对齐 bg #1E2C42 radius 12（右上 4px）max-width 70% |
| FE-06 | 输入框 + 发送 | FE-05 | app.js/input.js | 容器 bg #242526 radius 24，focus border #3B82F6；textarea 自适应 1-6 行；空输入禁用发送按钮（32×32 主按钮）；Enter 发送 / Shift+Enter 换行；请求体 {conversationId, message, useKb, model?, depth?}，useKb/depth/model 取全局状态；发送期间按钮 loading 态（spinner+"发送中"）且防重复提交；100% 配额时输入禁用 |
| FE-07 | 顶栏 token 计量条 + 模型/深度选择器 | FE-02, FE-05 | app.js/topbar.js | 计量条宽 120px，数据源 GET /api/usage{quota,used,remaining,ratio}：<80% 绿 #34C77B / 80-99% 黄 #E8A33D / 100% 红 #E5484D 并禁用输入、文字 12px 显示 remaining；每次 SSE done 后刷新（调用 FE-05 暴露的 refreshUsage 钩子）；模型下拉数据源 GET /api/models，≥1024 显示模型名、<1024 仅图标；深度分段控件 关/标准/深度 ↔ depth ∈ none/low/high 映射，选择写入全局状态供 FE-06 使用 |
| FE-08 | 设置弹窗 + 导入导出 | FE-02 | app.js/settings.js, app.js/dataio.js | 设置弹窗 480px、遮罩 rgba(0,0,0,.6)、bg #242526 radius 12：打开时 GET /api/settings 回填 baseUrl/apiKeyMasked/model/quota/depth；API Key 密码框+显隐切换；保存 PUT /api/settings（apiKey 留空则不传该字段）成功 toast 2s；深度分段控件复用 FE-07；导入：file input 选 JSON → POST /api/import(multipart) → toast 返回 {folders,files,conversations} 计数并刷新树与对话列表；导出：window.open 或 a[download] 调 GET /api/export 下载 JSON 附件 |

## 补充实现要点（全体任务遵守）

1. **SSE 解析**：fetch ReadableStream 循环 `reader.read()`，TextDecoder(stream:true)，buffer 累积后按 `\n\n` 切帧；每帧去前缀 `data: `，`[DONE]` 结束；JSON.parse 包 try/catch 跳过坏帧。**禁止用 EventSource**（无法 POST）。
2. **XSS 防护**：所有用户输入/文件名/预览 content/思考内容在 innerHTML 前必须经 escHtml；marked 输出仅用于受控 markdown，原文先行转义。
3. **模块化**：app.js 为 ES module 入口（`<script type="module">`），各模块 `export` 初始化函数与全局状态对象（state = {settings, tree, conversations, currentConvId, usage, depth, model, sidebarOpen}），禁止全局 window 污染。
4. **错误码统一**：所有接口错误经 api.js 抛出，由调用处 toast `{detail}` 文案，文案色 #E5484D。
5. **轮询约定**：usage 仅在每次 done 后刷新一次，不做定时轮询。
6. **状态字典**：depth 映射 关=none / 标准=low / 深度=high，默认 high（契约 §5）。

## 性能预算

| 指标 | 红线 |
|------|------|
| 首屏可交互（本地 8321） | ≤ 500 ms |
| style.css 体积 | ≤ 40 KB |
| app.js 全模块合计（未压缩源码） | ≤ 120 KB |
| SSE 首字节到首字符渲染 | ≤ 200 ms |
| content 增量重渲染节流 | ≥ 100 ms 间隔 |
