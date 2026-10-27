"""KBChat 配置层：.env 作默认值，settings 表持久化覆盖（PUT /api/settings 后以表为准）。

优先级（每键独立合并）：settings 表 > 环境变量 / .env。
API Key 永不明文输出，仅在内存中参与上游调用。
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
DB_PATH = DATA_DIR / "kb.db"

load_dotenv(PROJECT_ROOT / ".env")  # 不覆盖已存在的真实环境变量

DEFAULTS: dict[str, str] = {
    "base_url": os.getenv("API_BASE_URL", "https://token.sensenova.cn/v1"),
    "api_key": os.getenv("API_KEY", ""),
    "model": os.getenv("DEFAULT_MODEL", "deepseek-flash"),
    "quota": os.getenv("TOKEN_QUOTA", "1000000"),
    "depth": os.getenv("DEFAULT_DEPTH", "high"),
}

MODELS: list[str] = ["deepseek-flash"]
DEPTHS: list[str] = ["none", "low", "high", "max"]

_SETTINGS_KEYS = ("base_url", "api_key", "model", "quota", "depth")


def get_settings(db_get: Any = None) -> dict[str, str]:
    """合并 .env 默认值与 settings 表持久化值（db_get(key) -> str|None）。

    db_get 由调用方注入 db.py 的 get_setting，避免循环依赖。
    """
    merged = dict(DEFAULTS)
    if db_get is not None:
        for key in _SETTINGS_KEYS:
            value = db_get(key)
            if value is not None and value != "":
                merged[key] = value
    merged["quota"] = int(merged["quota"])
    return merged


def mask_key(api_key: str) -> str:
    """前 3 + *** + 后 3；长度 ≤8 全掩码。空串返回空串。"""
    if not api_key:
        return ""
    if len(api_key) <= 8:
        return "***"
    return f"{api_key[:3]}***{api_key[-3:]}"


def public_settings(s: dict[str, str]) -> dict[str, Any]:
    """转换为契约 #2 响应结构（apiKey 掩码）。"""
    return {
        "baseUrl": s["base_url"],
        "apiKeyMasked": mask_key(s["api_key"]),
        "model": s["model"],
        "quota": int(s["quota"]),
        "depth": s["depth"],
        "models": MODELS,
    }
