"""KBChat 认证接口：/api/auth/status · /api/auth/login · /api/auth/logout。

只允许三件事：查询登录状态、用口令换取会话 Cookie、注销当前会话。
口令本身永不出现在响应或日志中。
"""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from . import auth

logger = logging.getLogger("kbchat.auth")
router = APIRouter(prefix="/api/auth", tags=["auth"])

FAILED_DELAY = 0.35  # 失败固定延迟，减轻暴力破解与计时侧信道


class LoginBody(BaseModel):
    password: str = Field(default="", max_length=auth.MAX_PASSWORD_LEN)


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _is_https(request: Request) -> bool:
    if request.url.scheme == "https":
        return True
    proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
    return proto == "https"


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"


@router.get("/status")
def status(request: Request) -> dict[str, bool]:
    """前端启动时调用：是否需要登录、当前是否已登录。"""
    if not auth.enabled():
        return {"enabled": False, "authenticated": True}
    token = request.cookies.get(auth.SESSION_COOKIE)
    return {"enabled": True, "authenticated": auth.valid_session(token)}


@router.post("/login")
async def login(body: LoginBody, request: Request, response: Response) -> dict[str, bool]:
    _no_store(response)
    if not auth.enabled():
        # 未配置密码时不做拦截，保持本地开发体验
        return {"ok": True, "enabled": False}

    ip = _client_ip(request)
    allowed, retry_after = auth.login_allowed(ip)
    if not allowed:
        minutes = max(1, (retry_after + 59) // 60)
        raise HTTPException(429, f"尝试次数过多，请 {minutes} 分钟后再试")

    if not auth.verify_password(body.password):
        auth.record_failure(ip)
        logger.warning("登录失败：ip=%s", ip)
        await asyncio.sleep(FAILED_DELAY)
        raise HTTPException(401, "密码错误")

    auth.clear_failures(ip)
    token = auth.new_session()
    response.set_cookie(
        auth.SESSION_COOKIE,
        token,
        max_age=auth.SESSION_TTL,
        path="/",
        httponly=True,
        samesite="strict",
        secure=_is_https(request),
    )
    logger.info("登录成功：ip=%s", ip)
    return {"ok": True, "enabled": True}


@router.post("/logout")
def logout(request: Request, response: Response) -> dict[str, bool]:
    _no_store(response)
    auth.drop_session(request.cookies.get(auth.SESSION_COOKIE))
    response.delete_cookie(auth.SESSION_COOKIE, path="/", httponly=True, samesite="strict")
    return {"ok": True}
