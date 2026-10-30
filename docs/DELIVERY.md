# KBChat 交付手册

> 版本：1.0 ｜ 维护人：常守恒（运维工程师） ｜ 适用环境：macOS / Linux 单机
> 本手册假设读者未参与开发，所有命令可直接复制执行。项目根目录以 `<ROOT>` 代指：`/Users/jex/Desktop/Knowledge/kb-chat`（实际部署时替换为你的路径）。

## 1. 交付物清单

| 交付物 | 路径 | 说明 |
|--------|------|------|
| 启动脚本 | `<ROOT>/start.sh` | 一键创建虚拟环境、安装依赖、启动 uvicorn（0.0.0.0:8321） |
| 后端源码 | `<ROOT>/server/` | FastAPI 应用：main.py 入口，config.py / db.py / parsers.py / chunker.py / llm.py / routes/ |
| 前端源码 | `<ROOT>/web/` | 零构建原生 JS SPA：index.html、app.js、style.css、vendor/marked.min.js |
| 依赖清单 | `<ROOT>/requirements.txt` | 8 个 Python 依赖（fastapi / uvicorn / httpx / python-multipart / pypdf / python-docx / openpyxl / python-dotenv） |
| 环境变量模板 | `<ROOT>/.env.example` | 5 项变量模板，复制为 `.env` 后填写 |
| 环境变量实际值 | `<ROOT>/.env` | 当前默认值（含商汤 API Key，禁止提交到 git，已在 .gitignore 排查范围外，部署时人工确认） |
| 运行时数据 | `<ROOT>/data/` | kb.db（SQLite 数据库）+ uploads/（上传的原始文件），部署后自动创建 |
| 架构契约 | `<ROOT>/docs/ARCHITECTURE.md` | 前后端唯一契约源 |
| 交付手册 | `<ROOT>/docs/DELIVERY.md` | 本文档 |
| 运维手册 | `<ROOT>/docs/OPS.md` | 监控 / 日志 / 备份 / 故障预案 |

## 2. 环境要求

| 组件 | 版本 | 用途 | 备注 |
|--------|------|----------|------|
| Python | 3.13（3.11 及以上可运行） | 运行后端 | 命令为 `python3`，需在 PATH 中 |
| pip | 随 Python 附带 | 安装依赖 | 由 start.sh 自动调用，无需手动操作 |
| 操作系统 | macOS 12+ 或 Linux（glibc 2.28+） | 运行环境 | Windows 需在 WSL2 中执行 |
| 磁盘 | 空闲 ≥ 200 MB | 代码 + 虚拟环境 + 数据 | 数据随上传文件增长，按 uploads 实际大小预估 |
| 网络 | 可访问 API_BASE_URL 指向的域名 | 调用 LLM 上游 | 默认 `https://token.sensenova.cn` |
| 端口 | 8321 未被占用 | 服务监听 | 检查方式见 §7 常见问题 |
| 浏览器 | Chrome / Edge / Safari 最新两个大版本 | 访问页面 | 需支持 SSE（EventSource） |

## 3. 环境变量

`.env` 共 5 项，全部可在页面"设置"中覆盖（写入 settings 表后以表为准，环境变量与 .env 仅作默认值）。优先级：**页面设置（settings 表） > 真实环境变量 > .env 文件**。

| 变量名 | 默认值 | 说明 | 是否可页面覆盖 |
|--------|--------|------|----------------|
| API_BASE_URL | `https://token.sensenova.cn/v1` | 上游 LLM 的 OpenAI 兼容端点根地址，不含 /chat/completions | 可以（页面设置 → 服务地址） |
| API_KEY | `sk-your-key-here`（真实密钥只写入本地 `.env` 或页面设置，禁止提交到仓库） | 上游 API 密钥，后端只在内存中使用，接口输出时掩码为前 3 后 3 位 | 可以（页面设置 → API Key；留空表示不修改已有 Key） |
| DEFAULT_MODEL | `deepseek-flash` | 默认对话模型，默认建议值：`deepseek-flash`；设置中可输入其他模型名 | 可以（页面设置 → 模型，及对话框内模型下拉） |
| TOKEN_QUOTA | `1000000` | Token 月度配额上限，用于 /api/usage 用量比例计算，单位：token | 可以（页面设置 → 配额） |
| DEFAULT_DEPTH | `high` | 默认推理深度，可选值：`none`、`low`、`high`、`max` | 可以（对话框内深度选择） |

修改 `.env` 后必须重启服务生效：`kill` 旧进程后重新 `bash start.sh`。

## 4. 部署步骤（从零到可访问）

以下命令逐条复制执行（macOS / Linux，假设部署到默认路径）：

```bash
# 1. 进入项目目录（如部署到其他路径，替换为实际路径）
cd /Users/jex/Desktop/Knowledge/kb-chat

# 2. 配置环境变量（若已有 .env 则跳过；新环境先复制模板再编辑）
cp .env.example .env
vi .env   # 将 API_KEY 改为真实 Key，其余 4 项保持默认值即可

# 3. 一键启动（首次运行自动创建 .venv 虚拟环境并安装依赖，耗时约 1-2 分钟）
bash start.sh
```

启动成功的判定标志：终端输出 `[KBChat] 启动服务: http://localhost:8321`，且随后出现 uvicorn 的 `Uvicorn running on http://0.0.0.0:8321` 日志。

```bash
# 4. 健康检查（新开一个终端执行）
curl -s http://localhost:8321/api/health
```

预期响应（HTTP 200）：`{"ok":true}`

```bash
# 5. 验证核心功能接口（知识库为空时 folders/files 数组为空属正常）
curl -s http://localhost:8321/api/tree
curl -s http://localhost:8321/api/usage
```

预期响应：`/api/tree` 返回 `{"folders":[...],"files":[...]}`；`/api/usage` 返回 `{"quota":1000000,"used":0,"remaining":1000000,"ratio":0.0}`。

```bash
# 6. 浏览器访问
open http://localhost:8321
```

页面可访问即部署完成。上传一个 txt 文件 → 在对话框开启"知识库"开关提问，回答成功即核心链路验收通过。

## 5. 端口与数据目录说明

| 项目 | 值 | 说明 |
|------|-----|------|
| 监听地址 | `0.0.0.0:8321` | 局域网内其他机器可通过 `http://<本机IP>:8321` 访问；仅本机使用时可改用 `http://localhost:8321` |
| 数据库 | `<ROOT>/data/kb.db` | SQLite 数据库，WAL 模式。伴随文件 `kb.db-shm`、`kb.db-wal` 为 WAL 正常产物，勿单独删除 |
| 上传文件 | `<ROOT>/data/uploads/` | 上传文档的原始文件，按文件 id 存放；删除数据库记录不会自动删除此目录文件 |
| 数据目录创建 | 自动 | 首次启动由后端自动创建 `data/` 与 `data/uploads/`，无需手动 mkdir |
| 备份范围 | `data/` 整个目录 | 数据库 + 上传文件一起备份，命令见 OPS.md §5 |

## 6. 上线验收清单

- [ ] `curl -s http://localhost:8321/api/health` 返回 `{"ok":true}`
- [ ] 浏览器打开 `http://localhost:8321`，页面无白屏、控制台无报错
- [ ] 上传 1 个 txt 文件，知识库树中出现该文件且分块数 > 0
- [ ] 对话框开启知识库提问，能收到流式回答（含思维链折叠区属正常）
- [ ] `GET /api/usage` 的 used 数值随对话增长
- [ ] 页面"设置"中 API Key 显示为掩码（前 3 后 3），未明文暴露
- [ ] 重启服务后：文件、对话、设置项全部还在（数据持久化验证）

## 7. 常见问题

**Q1：启动报错 `Address already in use`，端口 8321 被占用？**

```bash
# 查看占用进程
lsof -i:8321
# 确认是旧的 kbchat 残留进程后，按 PID 结束（<PID> 替换为 lsof 输出的 PID 列）
kill <PID>
# 若 kill 无效，强制结束
kill -9 <PID>
# 重新启动
bash start.sh
```

注意：确认该进程确实是 KBChat（lsof 输出的 COMMAND 列应为 python/uvicorn）后再 kill，避免误杀其他服务。

**Q2：上传 .doc 文件提示不支持？**

原因：.doc 是老版二进制格式，纯 Python 生态无法可靠解析。上传白名单仅允许：`txt`、`md`、`csv`、`pdf`、`docx`、`xlsx`。
处理：用 Word/WPS 打开 .doc 文件，另存为 .docx 后重新上传。页面提示文案即为"另存为 docx"，无需联系管理员。

**Q3：对话返回 429 或提示"限流重试中"？**

原因：上游 LLM 服务限流。后端已自动指数退避重试 3 次（间隔 1s / 2s / 4s + 随机抖动），前端会显示 `retry` 事件提示。
处理：单次出现属正常，等待重试结果即可；若重试 3 次后最终返回 `error` 事件，表示上游持续限流，处理方式见 OPS.md §6 故障预案 P1（更换 base URL 或模型）。

**Q4：首次启动 pip 安装很慢？**

```bash
# 使用国内镜像手动预装（start.sh 检测到 .venv 已存在会跳过安装）
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
bash start.sh
```

**Q5：服务正常但页面打不开？**

```bash
# 确认进程存活
lsof -i:8321
# 确认返回 HTML
curl -s -o /dev/null -w "%{http_code}" http://localhost:8321/
```

curl 返回 200 但浏览器打不开：检查浏览器代理设置是否拦截了 localhost；lsof 无输出：服务未启动，回看 start.sh 终端报错日志。

## 8. 回滚方案

KBChat 代码无状态（无数据库迁移脚本），回滚 = 恢复代码版本 + 恢复 data/ 数据备份。

| 步骤 | 命令 | 验证方式 |
|------|------|----------|
| 1. 停止当前服务 | `kill $(lsof -ti:8321)` | `lsof -i:8321` 无输出 |
| 2. 恢复代码版本 | `cd <代码仓库> && git log --oneline -5 && git checkout <回滚目标 commit>` | `git log -1` 显示目标 commit |
| 3. 备份并恢复数据 | `mv data data.broken-$(date +%Y%m%d-%H%M%S)` → `cp -R <备份目录>/data ./data` → `rm -f data/kb.db-wal data/kb.db-shm` | `ls data/` 能看到 kb.db 与 uploads/ |
| 4. 重启服务 | `bash start.sh` | 终端出现 `Uvicorn running on http://0.0.0.0:8321` |
| 5. 验证恢复结果 | `curl -s http://localhost:8321/api/health` + `curl -s http://localhost:8321/api/tree` | health 返回 `{"ok":true}`；tree 返回的文件数与备份前一致 |

说明：步骤 3 中删除 `-wal`/`-shm` 是因为它们对应旧进程的 WAL 缓冲，恢复干净备份后必须清掉，避免数据错乱。若从未做过备份（首次上线即回滚），跳过步骤 3，仅回滚代码即可（data/ 由新代码自动重建，历史数据不存在即预期）。
