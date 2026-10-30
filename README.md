# KBChat

本地知识库 + 对话应用：FastAPI + SQLite + 零构建原生 ES Modules SPA。

## 快速启动

```bash
cd kb-chat
bash start.sh
# 打开 http://localhost:8321
```

- 首次运行会创建 `.venv` 并安装 `requirements.txt` 依赖。
- 模型提供商在页面「设置 → 模型」中管理：默认内置 **DeepSeek**（`https://api.deepseek.com/v1`）与 **商汤 SenseNova**（`https://token.sensenova.cn/v1`）两个条目，填入各自的 API Key 即可使用；如果你之前配置的是第三方网关（如 qnaigc），它会保留为独立的「qnaigc / 自定义」提供商，不会冒充商汤；API 地址、模型目录可编辑，也支持「获取可用模型」。默认模型 `deepseek-flash`，目录外模型可在顶栏「自定义模型…」直接输入。
- `.env` 仍可作为首次运行的默认值（`API_BASE_URL`、`API_KEY`、`DEFAULT_MODEL`、`TOKEN_QUOTA`、`DEFAULT_DEPTH`）；首次启动会把旧接口迁移到匹配的提供商，之后以页面设置为准。
- 数据默认在 `data/kb.db`，原始上传文件在 `data/uploads/`。

## 访问密码（可选）

单用户登录保护：未登录时只能看到登录页，所有 `/api/*` 返回 401，静态页面重定向回登录页。

```bash
# 生成哈希（交互输入，密码不会进 shell 历史）
./.venv/bin/python -m server.auth hash
# 把输出的 WEB_PASSWORD_HASH=... 写进 .env，然后重启 start.sh
```

- 密码只以 PBKDF2-SHA256 哈希形式保存在 `.env`；`.env` 已被 `.gitignore` 排除，**不会**进入仓库。
- 会话用 HttpOnly + SameSite=Strict Cookie，默认 7 天滑动续期；会话存在进程内存里，重启服务需重新登录。
- 同一 IP 连续失败 8 次锁定 15 分钟；登录接口对失败有固定延迟。
- 未配置 `WEB_PASSWORD_HASH`（也没有 `WEB_PASSWORD`）时登录保护关闭，方便本地开发。
- 设置弹窗左下角提供「退出登录」。
- 注意：这是「防陌生人随手访问」级别的保护，不是多用户权限系统；Cookie 走 HTTP 时（局域网 IP 访问）不加密，公网部署请务必套 HTTPS 反向代理。

### 推到 GitHub 前

- `.gitignore` 已排除 `.env`、`.env.*`、`data/`、`*.db`：访问密码与 API Key 都不会进仓库。
- 仓库自带 pre-commit 钩子，检测到 `.env`、真实密码哈希或 `sk-` 密钥会直接阻止提交：

  ```bash
  git config core.hooksPath .githooks   # 每个克隆执行一次
  ```

- 推送前自查（应无输出）：

  ```bash
  git grep -nE 'pbkdf2_sha256[$]|sk-[A-Za-z0-9]{16,}'
  ```

- 如果曾经误把 `.env` 提交过，改密码并重写历史（`git filter-repo`）比删除文件更可靠。

## 部署（systemd，可选）

以 Debian 为例，把项目放到 `/home/jex/kb-chat`（`python3-venv` 需先 `sudo apt install python3-venv`）：

```ini
# /etc/systemd/system/kbchat.service
[Unit]
Description=KBChat
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=jex
WorkingDirectory=/home/jex/kb-chat
Environment=PYTHONUNBUFFERED=1
ExecStart=/home/jex/kb-chat/.venv/bin/uvicorn server.main:app --host 0.0.0.0 --port 8000
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now kbchat
journalctl -u kbchat -f          # 看日志
sudo systemctl restart kbchat    # 改代码/换密码后重启
```

服务里跑的是单进程 uvicorn；会话存在内存，重启后需要重新登录。数据库连接是每线程一条（WAL），所以并发请求不会互相踩。

## 功能

- 界面：参考 DeepSeek Harness 的深色工作台。侧边栏 =「新对话 / 知识库 / 对话列表 / 设置 · 下载对话」，顶栏 = 模型、思考档位；没有工作区、没有归档，对话悬停即可置顶/重命名/删除。
- 模型提供商：设置页直接列出提供商（绿点=已配置 Key，红点=未配置），支持添加/编辑/删除/设为当前；顶栏模型菜单按提供商分组，切换模型会同步切换提供商；聊天/压缩都使用当前提供商的 API 地址与密钥。
- 知识库：点侧边栏「知识库」打开访达窗口，列表/图标视图、搜索、排序、拖放导入、复制/移动/重命名、删除、预览、下载；侧边栏显示文件数与体积。
- 对话：置顶、重命名、下载当前/全部对话（纯 `.txt`，无 Markdown 角色标题）；不提供导入对话/知识库 JSON，也不再有批量管理模式。
- 附件：最多 500 个，支持文件夹选择 / 拖拽（递归读取），txt/md/csv/pdf/docx/xlsx 与图片，横向滑动、单删、取消、编辑消息时增删附件；图片和文本文件都支持点击快速预览（草稿 / 已发送 / 编辑框），文本附件使用精确 token。
- Token：DeepSeek 分词器精确计数。底部状态栏显示 tok/s、上下文占用、缓存命中；点开用量弹层可以看到：
  - **上下文占用**：下一轮请求要发的 prompt = 系统提示词 + 上传文本 + 图片 + 对话消息；压缩后立即变小。进度条按「已用 ÷ 窗口上限」填充，未用部分留空。
  - **本会话累计**：输入 / 输出，输出包含思考（另标「其中思考」），只增不减，用于对账计费。
  - 缓存命中 / 未缓存输入 / 缓存读取。
  - **上传文本占用 = 上传的文本附件全文占用的提示词 token**，不是用户输入的文字；图片按尺寸估算视觉 token 单独计数。
  - 输入 token 里含上游网关的固定模板开销（不同网关不同，实测 qnaigc 关思考约 4、开思考约 30），所以「只发一个字」也会显示几十 token；输出里的思考不会回放进下一轮上下文。
- 上下文压缩（compaction）：接近上下文窗口时自动把较早消息摘要成一条检查点，只保留近期原文继续对话；也可在用量弹层点「压缩对话」或输入 `/compact` 手动压缩。原始消息不删除，界面显示可展开的检查点卡片；搜索、下载、版本切换仍看到完整历史。
- 消息版本：编辑消息时保存为第 N 版，消息下方用 `1/N` 左右箭头切换，旧回答和 token 一起切回；不会新建对话。
- 全文搜索：对话区标题右侧的搜索图标打开弹窗，搜索所有用户/助手内容（含思考内容），结果高亮并可定位到消息。
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

# 全量接口回归（自建测试数据、跑完清理；带访问密码的实例用环境变量）
KBC_BASE=http://localhost:8321 KBC_PASSWORD='你的访问密码' ./.venv/bin/python qa_test/run_tests.py

# 前端语法/DOM id 静态检查可由 Node + Playwright 执行
# 本地实测：全文搜索 5000 条消息 p95 ≈ 6ms；分块检索 p95 ≈ 3ms
# 最近一次全量回归（debian:8000，36 项）：36 PASS / 0 FAIL
```

## 注意

- 版本切换、消息截断、搜索均只读写本地 SQLite；删除后的已消耗上游 token 不会回退（真实计费）。切换消息版本会按原消息 id 写回，轮次仍留在原位置。
- 编辑消息的「覆盖并发送」会删除该消息及之后的内容；旧版本保留在该消息的版本切换中。
- 压缩是「替换上游 prompt 中的旧历史」，不是删除本地消息；摘要由模型生成，会消耗一次额外的上游调用（输入为被压缩的历史，输出受 `max_tokens` 限制）。编辑/删除消息或切换消息版本会使相关摘要失效并自动清除。
- 消息正文的精确 token 数会落库缓存（`messages.content_tokens`），长会话估算上下文、压缩选区时不再反复分词；旧数据首次启动自动回填。
- 下载的 TXT 只包含对话内容；模型提供商与 API Key 不参与下载。
- 图片 token 由前端按图片尺寸估算（OpenAI 兼容的 85 + 170×tiles），上游实际计费仍以返回的 usage 为准。
- 项目为本地单用户工具，默认绑定 `0.0.0.0:8321`，请勿直接暴露到公网；需要对外访问时先配置「访问密码」并套 HTTPS 反向代理。
- 自动压缩阈值是窗口的 80%（默认 1M → 800K）：每轮请求前估算 prompt，超过才触发。它只压缩对话消息，不压缩附件正文，所以附件占比很高时压缩省不了多少。
- 静态资源（`.js`/`.css`/`.html`）以 `Cache-Control: no-store` 返回，入口脚本带 `?v=` 版本号：部署后刷新即可，不会被浏览器旧缓存卡住。
