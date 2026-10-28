# KBChat

本地知识库 + 对话应用：FastAPI + SQLite + 零构建原生 ES Modules SPA。

## 快速启动

```bash
cd kb-chat
bash start.sh
# 打开 http://localhost:8321
```

- 首次运行会创建 `.venv` 并安装 `requirements.txt` 依赖。
- 接口/Key/模型名可在页面「设置」中修改，模型名是可直接输入的文本框（`deepseek-flash` 只是建议值）；也可用 `.env` 提供默认值（`API_BASE_URL`、`API_KEY`、`DEFAULT_MODEL`、`TOKEN_QUOTA`、`DEFAULT_DEPTH`）。
- 数据默认在 `data/kb.db`，原始上传文件在 `data/uploads/`。

## 功能

- 知识库：30% 侧栏树 + 访达窗口，列表/图标视图、搜索、排序、拖放导入、复制/移动/重命名、删除、预览、下载。
- 对话：置顶、批量管理、单条导出、全部导出（纯 `.txt`，无 Markdown 角色标题）。
- 附件：最多 500 个，支持文件夹选择 / 拖拽（递归读取），txt/md/csv/pdf/docx/xlsx 与图片，横向滑动、单删、取消、编辑消息时增删附件；图片和文本文件都支持点击快速预览（草稿 / 已发送 / 编辑框），文本附件使用精确 token。
- Token：DeepSeek 分词器精确计数；底部状态栏显示 tok/s、上下文、缓存命中；点击查看当前上下文、本会话累计、输入/输出、缓存明细。今日/历史累计不展示。
- 消息版本：编辑消息时保存为第 N 版，消息下方用 `1/N` 左右箭头切换，旧回答和 token 一起切回；不会新建对话。
- 全文搜索：左侧「搜索对话」打开弹窗，搜索所有用户/助手内容（含思考内容），结果高亮并可定位到消息。
- 深色主题、响应式（桌面 / 窄屏侧栏浮层）。

## 目录

```text
server/   FastAPI 路由、SQLite、分词器、分块检索、解析器
web/      零构建前端（index.html + ES modules + CSS）
data/     运行数据（DB、上传文件）
qa_test/  接口/回归测试脚本
docs/     架构/需求/运维文档
```

## 测试与性能

```bash
# Python 语法
./.venv/bin/python -m compileall -q server

# 分块检索压测（BE-03）
./.venv/bin/python -m server.bench_search 5000 200

# 前端语法/DOM id 静态检查可由 Node + Playwright 执行
# 本地实测：全文搜索 5000 条消息 p95 ≈ 6ms；分块检索 p95 ≈ 3ms
```

## 注意

- 版本切换、消息截断、搜索均只读写本地 SQLite；删除后的已消耗上游 token 不会回退（真实计费）。
- 编辑消息的「覆盖并发送」会删除该消息及之后的内容；旧版本保留在该消息的版本切换中。
- 项目为本地单用户工具，默认绑定 `0.0.0.0:8321`，请勿直接暴露到公网。
