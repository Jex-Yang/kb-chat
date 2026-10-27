"""KBChat FastAPI 入口：路由注册 + web/ 静态托管 + 启动初始化（DB + 检索索引）。

启动：bash start.sh（uvicorn 0.0.0.0:8321）
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from . import chunker, db
from .api_routes import router

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s %(message)s")
# 屏蔽 uvicorn access 日志中的敏感请求体风险（本服务不打印任何请求体/Key）
logger = logging.getLogger("kbchat")

WEB_DIR = Path(__file__).resolve().parent.parent / "web"

@asynccontextmanager
async def lifespan(_app: FastAPI):
    db.init()
    loaded = chunker.load_from_db(db)
    stats = chunker.stats()
    logger.info("KBChat 启动完成：索引加载 %d 个分块 / %d 个 term",
                loaded, stats["terms"])
    yield


app = FastAPI(title="KBChat", docs_url="/api/docs", redoc_url=None, lifespan=lifespan)
app.include_router(router)


# 静态托管 web/（html=True 使 GET / 返回 index.html）；必须在 API 路由之后挂载
if WEB_DIR.exists():
    app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")
else:
    logger.warning("web/ 目录不存在，静态页面未挂载")
