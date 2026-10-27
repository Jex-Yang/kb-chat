#!/bin/bash
# KBChat 一键启动
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  echo "[KBChat] 首次运行，创建虚拟环境并安装依赖..."
  python3 -m venv .venv
  ./.venv/bin/pip install -q -r requirements.txt
fi
echo "[KBChat] 启动服务: http://localhost:8321"
exec ./.venv/bin/uvicorn server.main:app --host 0.0.0.0 --port 8321
