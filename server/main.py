"""KBChat FastAPI 入口：路由注册 + web/ 静态托管 + 启动初始化（DB + 检索索引）。

启动：bash start.sh（uvicorn 0.0.0.0:8321）
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from . import auth, chunker, config, db
from .api_routes import router
from .auth_routes import router as auth_router

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s %(message)s")
# 屏蔽 uvicorn access 日志中的敏感请求体风险（本服务不打印任何请求体/Key）
logger = logging.getLogger("kbchat")

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
LOGIN_PAGE = WEB_DIR / "login.html"

@asynccontextmanager
async def lifespan(_app: FastAPI):
    db.init()
    config.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    loaded = chunker.load_from_db(db)
    stats = chunker.stats()
    logger.info("KBChat 启动完成：索引加载 %d 个分块 / %d 个 term",
                loaded, stats["terms"])
    if auth.enabled():
        logger.info("访问密码已开启：未登录只能看到登录页，接口返回 401")
    else:
        logger.warning("访问密码未配置（.env 的 WEB_PASSWORD_HASH 为空），任何人都可访问")
    yield


app = FastAPI(title="KBChat", docs_url="/api/docs", redoc_url=None, lifespan=lifespan)
app.include_router(auth_router)
app.include_router(router)


@app.middleware("http")
async def require_login(request: Request, call_next):
    """访问密码中间件：未登录时页面回登录页、接口回 401、静态资源重定向。

    密码未配置（WEB_PASSWORD_HASH / WEB_PASSWORD 均空）时直接放行，
    因此从 GitHub clone 下来不改配置也能本地跑。
    """
    if not auth.enabled():
        return await call_next(request)

    path = request.url.path
    if request.method == "OPTIONS" or auth.is_public(path):
        return await call_next(request)
    if auth.valid_session(request.cookies.get(auth.SESSION_COOKIE)):
        return await call_next(request)

    if path in ("/", "/index.html") and LOGIN_PAGE.exists():
        return FileResponse(LOGIN_PAGE, headers={"Cache-Control": "no-store"})
    if path.startswith("/api/"):
        return JSONResponse({"detail": "未登录或登录已过期"}, status_code=401)
    return RedirectResponse("/login.html", status_code=302)


# index.html 禁止缓存（零构建前端，HTML/JS 版本必须同步），静态资源仍走 ETag 协商缓存
@app.get("/", include_in_schema=False)
def index():
    return FileResponse(WEB_DIR / "index.html", headers={
        "Cache-Control": "no-cache",
    })


# 静态托管 web/（html=True 使 GET / 返回 index.html）；必须在 API 路由之后挂载
if WEB_DIR.exists():
    app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")
else:
    logger.warning("web/ 目录不存在，静态页面未挂载")
