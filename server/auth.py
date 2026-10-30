"""KBChat 访问密码（单用户登录）：口令哈希校验 + 内存会话 + 失败限速。

配置来源（环境变量或 .env，均由 config.py 加载；哈希优先）：
  WEB_PASSWORD_HASH=pbkdf2_sha256$<迭代次数>$<salt_hex>$<hash_hex>
  WEB_PASSWORD=<明文>            # 仅建议本地临时使用

生成哈希（密码不会进入 shell 历史 / 仓库）：
  ./.venv/bin/python -m server.auth hash

安全设计：
- 仓库里永不出现明文：`.env` 已被 .gitignore 排除，这里只接受哈希；
- 会话令牌 `secrets.token_urlsafe(32)`，仅存在服务端内存 + HttpOnly Cookie；
- 口令比较使用 `hmac.compare_digest`（常数时间）；
- 同一 IP 连续失败达上限后锁定一段时间，挡住暴力破解；
- 未配置密码时登录保护自动关闭（本地开发不受影响），启动日志会提示。

注意：会话保存在进程内存中，重启服务或更换 worker 后需要重新登录。
"""
from __future__ import annotations

import getpass
import hashlib
import hmac
import os
import secrets
import sys
import threading
import time

from . import config  # noqa: F401  确保 .env 已加载

SESSION_COOKIE = "kbchat_session"
SESSION_TTL = 7 * 24 * 3600          # 会话有效期（秒），每次访问滑动续期
LOGIN_MAX_FAILS = 8                  # 窗口内允许的失败次数
LOGIN_WINDOW = 10 * 60               # 失败计数窗口（秒）
LOGIN_LOCK = 15 * 60                 # 触发上限后的锁定时长（秒）
PBKDF2_ITERATIONS = 260_000
MAX_PASSWORD_LEN = 256

# 未登录也允许访问的路径（登录页自身 + 认证接口）
PUBLIC_PATHS = frozenset({
    "/api/auth/login",
    "/api/auth/status",
    "/api/auth/logout",
    "/login.html",
    "/login.css",
    "/login.js",
    "/favicon.svg",
})

_sessions: dict[str, float] = {}
_failures: dict[str, list[float]] = {}
_locked_until: dict[str, float] = {}
_lock = threading.Lock()


# ---------------------------------------------------------------- 配置 / 校验

def _configured_secret() -> str | None:
    """当前生效的口令（哈希或明文）；未配置返回 None。"""
    hashed = os.getenv("WEB_PASSWORD_HASH", "").strip()
    if hashed:
        return hashed
    plain = os.getenv("WEB_PASSWORD", "")
    if plain:
        return plain
    return None


def enabled() -> bool:
    """是否开启访问密码。"""
    return _configured_secret() is not None


def is_public(path: str) -> bool:
    return path in PUBLIC_PATHS


def make_hash(password: str, iterations: int = PBKDF2_ITERATIONS) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), iterations)
    return f"pbkdf2_sha256${iterations}${salt}${digest.hex()}"


def verify_password(password: str) -> bool:
    """校验口令；未配置或格式非法一律返回 False（失败即拒绝）。"""
    secret = _configured_secret()
    if not secret or not password:
        return False
    if secret.startswith("pbkdf2_sha256$"):
        parts = secret.split("$")
        if len(parts) != 4:
            return False
        _, rounds, salt, expected = parts
        try:
            rounds_n = int(rounds)
            salt_b = bytes.fromhex(salt)
        except ValueError:
            return False
        if rounds_n <= 0 or rounds_n > 2_000_000:
            return False
        digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt_b, rounds_n).hex()
        return hmac.compare_digest(digest, expected)
    # 明文模式（仅限本地 .env）
    return hmac.compare_digest(password.encode(), secret.encode())


# ---------------------------------------------------------------- 会话

def new_session() -> str:
    token = secrets.token_urlsafe(32)
    now = time.time()
    with _lock:
        expired = [k for k, exp in _sessions.items() if exp <= now]
        for key in expired:
            _sessions.pop(key, None)
        _sessions[token] = now + SESSION_TTL
    return token


def valid_session(token: str | None) -> bool:
    if not token:
        return False
    now = time.time()
    with _lock:
        exp = _sessions.get(token)
        if exp is None:
            return False
        if exp <= now:
            _sessions.pop(token, None)
            return False
        # 剩余不足 1 天时滑动续期，避免使用中掉线
        if exp - now < SESSION_TTL - 24 * 3600:
            _sessions[token] = now + SESSION_TTL
    return True


def drop_session(token: str | None) -> None:
    if not token:
        return
    with _lock:
        _sessions.pop(token, None)


# ---------------------------------------------------------------- 登录限速

def login_allowed(ip: str) -> tuple[bool, int]:
    """返回 (是否允许尝试, 剩余锁定秒数)。"""
    now = time.time()
    with _lock:
        until = _locked_until.get(ip, 0.0)
        if until > now:
            return False, int(until - now) + 1
        if until:
            _locked_until.pop(ip, None)
            _failures.pop(ip, None)
    return True, 0


def record_failure(ip: str) -> None:
    now = time.time()
    with _lock:
        recent = [t for t in _failures.get(ip, []) if now - t < LOGIN_WINDOW]
        recent.append(now)
        if len(recent) >= LOGIN_MAX_FAILS:
            _locked_until[ip] = now + LOGIN_LOCK
            _failures[ip] = []
        else:
            _failures[ip] = recent


def clear_failures(ip: str) -> None:
    with _lock:
        _failures.pop(ip, None)
        _locked_until.pop(ip, None)


# ---------------------------------------------------------------- CLI

def _main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] != "hash":
        print("用法: python -m server.auth hash   # 交互式生成 WEB_PASSWORD_HASH")
        return 2
    password = getpass.getpass("新访问密码: ")
    if len(password) < 8:
        print("密码至少 8 位。")
        return 1
    if password != getpass.getpass("再输入一次: "):
        print("两次输入不一致。")
        return 1
    print("\n将下面一行写入 .env（.env 已被 .gitignore 排除，切勿提交）：\n")
    print("WEB_PASSWORD_HASH=" + make_hash(password))
    return 0


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv))
