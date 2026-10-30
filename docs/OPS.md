# KBChat 运维手册

## 0. 当前部署形态（2026-10-30）

- 生产实例：Debian 13，目录 `/home/jex/kb-chat`，systemd 单元 `kbchat`，监听 `0.0.0.0:8000`，`User=jex`。
  - 状态 / 重启：`sudo systemctl status kbchat`、`sudo systemctl restart kbchat`
  - 日志：`journalctl -u kbchat -f`
- 首次部署需 `sudo apt install python3-venv`（Debian 默认没有 ensurepip，建不了 venv）。
- **已开启访问密码**：除 `/api/auth/*` 与登录页外，所有 `/api/*` 都需要 `kbchat_session` Cookie。本文档后面的裸 `curl` 会返回 401，巡检前先登录：

  ```bash
  curl -s -c /tmp/kb.cookie -X POST http://127.0.0.1:8000/api/auth/login \
       -H 'Content-Type: application/json' -d '{"password":"…"}'
  curl -s -b /tmp/kb.cookie http://127.0.0.1:8000/api/health
  ```

- 本机开发仍可 `bash start.sh` 跑在 8321；服务器是 8000。
- 会话保存在进程内存：重启服务后所有人需要重新登录。
- 改完代码/换密码后必须 `systemctl restart kbchat` 才生效（uvicorn 未开 `--reload`）。


> 版本：1.0 ｜ 维护人：常守恒（运维工程师） ｜ 适用环境：macOS / Linux 单机部署（uvicorn 前台进程）
> 本手册假设读者未参与开发。`<ROOT>` 代指项目根目录：`/Users/jex/Desktop/Knowledge/kb-chat`。

## 1. 系统架构概览

```
浏览器 (web/ 零构建 SPA)
   │  HTTP / SSE
   ▼
uvicorn (0.0.0.0:8321) ── server/main.py
   ├── server/routes/      REST + SSE 路由
   ├── server/parsers.py   pdf/docx/xlsx/csv/txt/md 解析
   ├── server/chunker.py   600 字分块 + bigram 倒排内存检索（启动全量加载）
   ├── server/llm.py       httpx 流式调用上游 + 429/5xx 指数退避重试 3 次
   │        │  HTTPS (OpenAI 兼容 /chat/completions)
   │        ▼
   │   上游 LLM（默认商汤 SenseNova，可页面覆盖 base URL / Key / 模型）
   ▼
SQLite WAL (data/kb.db) + 文件落盘 (data/uploads/)
```

单进程、单机、无外部中间件。故障面收敛为 4 项：进程、上游 LLM、SQLite、磁盘。

## 2. 监控指标

| 指标 | 采集方式 | 正常值 | 告警阈值 | 告警级别 | 处理动作 |
|------|----------|--------|----------|----------|----------|
| 进程存活 | `lsof -ti:8321` 有输出即存活 | 存在 1 个 PID | 命令无输出 | P1（服务中断） | 按 §6 P0 重启 |
| 健康检查 | `curl -s http://localhost:8321/api/health` | `{"ok":true}`，响应 < 1s | 非 200 或超时 5s | P1（服务中断） | 按 §6 P0 重启 |
| 磁盘用量（data/ 所在分区） | `df -h <ROOT>/data \| tail -1 \| awk '{print $5}'` | < 60% | ≥ 80% | P2（容量风险） | 按 §6 P2 清理 uploads |
| 磁盘用量（系统根分区） | `df -h / \| tail -1 \| awk '{print $5}'` | < 80% | ≥ 90% | P1（影响全机） | 清理日志与临时文件，必要时扩容磁盘 |
| 上游限流（429） | 对话时 SSE `retry` 事件 / 页面"限流重试中"提示 | 无 | 同一会话重试 3 次后仍 error | P2（功能降级） | 按 §6 P1 换端点或模型 |
| Token 用量 | `curl -s http://localhost:8321/api/usage` 的 ratio | < 0.8 | ratio ≥ 1.0 | P2（配额耗尽） | 页面设置调高配额，或联系上游提额 |
| WAL 文件体积 | `ls -l <ROOT>/data/kb.db-wal` | < 10 MB | > 100 MB 持续 1 小时 | P3（检查点滞后） | 按 §6 P3 处理 |

### 定时巡检脚本（复制即用）

```bash
# 1. 创建巡检脚本
cat > <ROOT>/ops_check.sh <<'EOF'
#!/bin/bash
ROOT="/Users/jex/Desktop/Knowledge/kb-chat"
ALERT=""
# 1. 进程存活
if [ -z "$(lsof -ti:8321)" ]; then ALERT="${ALERT}[P1] 进程未运行; "; fi
# 2. 健康检查
H=$(curl -s -m 5 http://localhost:8321/api/health)
[ "$H" != '{"ok":true}' ] && ALERT="${ALERT}[P1] health 异常: ${H}; "
# 3. 磁盘用量
U=$(df -h "$ROOT/data" | tail -1 | awk '{print $5}' | tr -d '%')
[ "$U" -ge 80 ] && ALERT="${ALERT}[P2] data 分区磁盘 ${U}%; "
# 4. Token 配额
R=$(curl -s http://localhost:8321/api/usage | sed -n 's/.*"ratio":\([0-9.]*\).*/\1/p')
awk "BEGIN{exit !($R >= 1.0)}" && ALERT="${ALERT}[P2] token 配额已用尽; "
if [ -n "$ALERT" ]; then echo "$(date '+%F %T') ALERT: $ALERT" >> "$ROOT/ops_alert.log"; else echo "$(date '+%F %T') OK" >> "$ROOT/ops_check.log"; fi
EOF
chmod +x <ROOT>/ops_check.sh

# 2. 加入 crontab，每 5 分钟巡检一次（首次执行 crontab -e 添加下面一行）
*/5 * * * * /Users/jex/Desktop/Knowledge/kb-chat/ops_check.sh
```

告警文件：`<ROOT>/ops_alert.log`（有内容即需人工介入）；正常记录：`<ROOT>/ops_check.log`。

## 3. 日志与排查

**日志形态**：uvicorn 输出到 stdout，即 `bash start.sh` 的那个前台终端。该终端关闭则日志丢失，长期运行时建议 tee 落盘：

```bash
# 以日志落盘方式启动（替代直接 bash start.sh）
cd /Users/jex/Desktop/Knowledge/kb-chat
bash start.sh 2>&1 | tee -a ops_uvicorn.log
```

**常用排查命令**：

| 目的 | 命令 |
|------|------|
| 查看实时日志 | 直接观察 start.sh 终端，或 `tail -f ops_uvicorn.log` |
| 查找报错 | `grep -nE "ERROR\|Traceback\|500" ops_uvicorn.log \| tail -50` |
| 查看某次请求 | `grep -n "POST /api/chat" ops_uvicorn.log` |
| 确认上游重试 | 日志中搜索 `429`，出现 3 条后接 `error` 即重试耗尽 |
| 查看数据库内容 | `sqlite3 <ROOT>/data/kb.db "SELECT date, tokens FROM usage_daily ORDER BY date DESC LIMIT 7;"` |
| 查看 WAL 大小 | `ls -lh <ROOT>/data/kb.db*` |

**注意**：运行期间禁止直接编辑 kb.db；排查用只读方式：`sqlite3 "file:<ROOT>/data/kb.db?mode=ro"`。

## 4. 扩容与缩容

| 场景 | 判定依据 | 操作 |
|------|----------|------|
| 检索变慢（上传文件 > 2000 个） | 检索接口响应 > 2s（`time curl -s -X POST http://localhost:8321/api/kb/search -H 'Content-Type: application/json' -d '{"query":"测试"}'`） | 当前为内存 bigram 检索，超出设计容量；拆分多个 KBChat 实例按目录分流，每实例独立端口（复制项目目录，改 start.sh 中 `--port` 为 8322，负载由使用者按目录选择实例） |
| 并发对话卡顿 | 多人同时对话时 SSE 首包延迟 > 5s | uvicorn 默认单 worker；在 start.sh 的 uvicorn 命令后追加 ` --workers 2` 后重启（SQLite WAL 支持多进程读写，写入冲突由 SQLite 锁机制处理） |
| 磁盘空间不足 | 磁盘用量 ≥ 80% | 按 §6 P2 清理 uploads |
| 缩容（降配） | 单人使用、内存占用 < 500 MB | 无需调整，服务本身即最小配置；可关闭巡检 cron 释放零星资源 |

## 5. 备份与恢复

### 5.1 备份策略

| 对象 | 方式 | 频率 | 保留 |
|------|------|------|------|
| kb.db（数据库） | sqlite3 在线备份（不锁库） | 每天 02:30 | 30 天 |
| uploads/（上传文件） | tar 打包 | 每天 02:30 | 30 天 |
| 全量导出（页面） | 页面右上"导出"按钮，下载 JSON | 每周手动 1 次 | 保留最近 4 份 |

### 5.2 定时备份命令（复制即用）

```bash
# 1. 创建备份脚本
cat > <ROOT>/ops_backup.sh <<'EOF'
#!/bin/bash
ROOT="/Users/jex/Desktop/Knowledge/kb-chat"
BK="$ROOT/backups"
mkdir -p "$BK"
D=$(date +%Y%m%d)
# 数据库在线备份（WAL 模式安全，无需停服）
sqlite3 "$ROOT/data/kb.db" ".backup '$BK/kb-$D.db'"
# 上传文件打包
tar -czf "$BK/uploads-$D.tar.gz" -C "$ROOT/data" uploads
# 清理 30 天前的备份
find "$BK" -name "kb-*.db" -mtime +30 -delete
find "$BK" -name "uploads-*.tar.gz" -mtime +30 -delete
echo "$(date '+%F %T') backup done: $BK" >> "$ROOT/ops_backup.log"
EOF
chmod +x <ROOT>/ops_backup.sh

# 2. 加入 crontab（macOS 需先给终端授予完全磁盘访问权限；crontab 中 % 必须转义为 \%）
crontab -e
# 添加这一行：
# 30 2 * * * /Users/jex/Desktop/Knowledge/kb-chat/ops_backup.sh

# 3. 手动验证一次备份（执行后检查 backups/ 目录出现 2 个当日文件）
bash <ROOT>/ops_backup.sh
ls -lh <ROOT>/backups/
```

sqlite3 依赖 macOS/Linux 自带；若提示 command not found：macOS 执行 `xcode-select --install`，Debian/Ubuntu 执行 `sudo apt-get install -y sqlite3`。

### 5.3 页面导出 JSON 说明

页面右上角"导出"按钮调用 `GET /api/export`，下载的 JSON 包含：文件夹、文件（含全文）、分块、会话（含消息）、设置（不含 API Key）。用于：跨机迁移、人为误删后的兜底恢复。恢复方式：页面右上角"导入"按钮选择该 JSON，导入为合并模式，id 冲突自动重新分配。注意：导出 JSON 不含 API Key，迁移后需在页面设置中重新填写 Key。

### 5.4 恢复流程（数据库损坏 / 误删数据时）

```bash
# 1. 停止服务
kill $(lsof -ti:8321)

# 2. 隔离损坏数据（不直接删除，留作事后分析）
mv <ROOT>/data/kb.db <ROOT>/data/kb.db.broken-$(date +%Y%m%d-%H%M%S)
rm -f <ROOT>/data/kb.db-wal <ROOT>/data/kb.db-shm

# 3. 拷回备份（<D> 替换为备份日期，如 20250101）
cp <ROOT>/backups/kb-<D>.db <ROOT>/data/kb.db

# 4. 恢复上传文件（可选，仅当 uploads 也受损时执行；先隔离现有目录）
mv <ROOT>/data/uploads <ROOT>/data/uploads.broken-$(date +%Y%m%d-%H%M%S)
tar -xzf <ROOT>/backups/uploads-<D>.tar.gz -C <ROOT>/data

# 5. 启动并验证
bash start.sh
curl -s http://localhost:8321/api/health        # 预期 {"ok":true}
curl -s http://localhost:8321/api/tree          # 文件数量应与备份时间点一致
```

## 6. 故障预案

### P0：服务无响应（进程挂掉）

- **现象**：页面打不开；`lsof -ti:8321` 无输出；`curl -s http://localhost:8321/api/health` 连接拒绝。
- **原因**：启动终端被关闭导致前台进程随终端退出；或代码异常崩溃（查 ops_uvicorn.log 末尾 Traceback）。
- **步骤**：
  1. `cd /Users/jex/Desktop/Knowledge/kb-chat`
  2. 确认端口空闲：`lsof -i:8321`（应无输出）
  3. 重启：`nohup bash start.sh > ops_uvicorn.log 2>&1 &`
  4. 验证：`curl -s http://localhost:8321/api/health` 返回 `{"ok":true}`
  5. 若启动即崩溃：`tail -50 ops_uvicorn.log` 定位 Traceback，按报错修复后重复步骤 3；修复前可用回滚方案（见 DELIVERY.md §8）

### P1：上游 429 持续失败 / LLM 不可用

- **现象**：对话最终返回 error；日志中连续出现 429（或 5xx）且 `retry` 事件出现 3 次后终止；知识库上传、检索不受影响。
- **原因**：上游商汤端点限流（配额耗尽或服务端压力）、API Key 失效、base URL 不可达。
- **步骤**：
  1. 确认范围：`curl -s -m 5 https://token.sensenova.cn/v1/models -H "Authorization: Bearer $(grep '^API_KEY=' .env | cut -d= -f2)"`，非 200 说明端点或 Key 问题
  2. 页面 → 设置 → 将"服务地址"换为备用 OpenAI 兼容端点，保存后重新提问验证
  3. 若判定 Key 失效：页面 → 设置 → API Key 输入新 Key 保存
  4. 上游恢复后：页面 → 设置改回原端点；若改的是 .env 之外的 settings 表，重启后仍生效，需手动改回
  5. 全程无需重启服务（settings 表即时生效）

### P2：磁盘满 / 磁盘用量 ≥ 80%

- **现象**：ops_alert.log 出现 `[P2] data 分区磁盘 xx%`；或上传文件报错、对话落库失败。
- **原因**：data/uploads 中上传文件累积；ops_uvicorn.log 与备份文件未清理。
- **步骤**：
  1. 定位大头：`du -sh <ROOT>/data/uploads <ROOT>/backups <ROOT>/ops_uvicorn.log`
  2. 备份先行：`bash <ROOT>/ops_backup.sh`（确保清理前有备份）
  3. 清理已删除文档的孤儿文件：页面知识库中删除不需要的文件（接口会同时清分块），再清理 uploads 孤儿：
     `sqlite3 "file:<ROOT>/data/kb.db?mode=ro" "SELECT path FROM files;" > /tmp/keep.txt`
     `cd <ROOT>/data/uploads && for f in *; do grep -q "$f" /tmp/keep.txt || rm "$f"; done`
  4. 清理旧备份：`find <ROOT>/backups -mtime +30 -delete`
  5. 截断日志：`: > <ROOT>/ops_uvicorn.log`
  6. 验证：`df -h <ROOT>/data` 用量降到 80% 以下；`curl -s http://localhost:8321/api/health` 正常

### P3：数据库锁冲突 / WAL 异常增长

- **现象**：日志出现 `database is locked`；或 `kb.db-wal` 超过 100 MB 且长时间不回落。
- **原因**：本项目 SQLite 已启用 WAL 模式（读写不互斥），正常情况单进程不会锁冲突；锁冲突仅出现在多 worker 写入高峰或外部工具以写模式打开库；WAL 不回落是 checkpoint 未触发。
- **步骤**：
  1. 确认无外部进程写库：关闭所有直接打开 kb.db 的数据库客户端（如 DB Browser、DBeaver）
  2. 若配置了多 worker：先回退为单 worker（去掉 start.sh 中 `--workers` 参数）重启验证
  3. 手动触发 checkpoint：`sqlite3 <ROOT>/data/kb.db "PRAGMA wal_checkpoint(TRUNCATE);"`（服务运行中也可执行，短暂阻塞写入）
  4. 验证：`ls -lh <ROOT>/data/kb.db-wal` 体积回落；页面功能正常
  5. 若仍报 locked：停服（`kill $(lsof -ti:8321)`）→ 按 §5.4 恢复到最近备份 → 重启

## 7. 应急预案与升级路径

**联系人矩阵**（按响应顺序）：

| 顺序 | 角色 | 职责 |
|------|------|------|
| 1 | 运维工程师（常守恒） | 进程重启、磁盘清理、备份恢复、本手册所有预案执行 |
| 2 | 后端负责人 | P0 中 Traceback 定位、代码级修复 |
| 3 | 主理人 | 上游端点/Key 变更决策、回滚拍板 |

**RTO / RPO**：

| 指标 | 目标 | 依据 |
|------|------|------|
| RTO（恢复时长） | 5 分钟 | P0 重启 1 条命令；P3 走备份恢复约 4 步命令 |
| RPO（数据丢失上限） | 24 小时 | 数据库每日 02:30 备份；关键操作前可手动执行 ops_backup.sh 将 RPO 降为 0 |

**升级路径**：

1. 升级前备份：`bash <ROOT>/ops_backup.sh`
2. 拉取新代码：`cd <代码仓库> && git pull`
3. 停服 → 重启：`kill $(lsof -ti:8321)` → `bash start.sh`
4. 验证：`curl -s http://localhost:8321/api/health` + 页面上传/对话冒烟测试
5. 失败回滚：按 DELIVERY.md §8 执行（git checkout 旧 commit + 恢复 data/ 备份）
