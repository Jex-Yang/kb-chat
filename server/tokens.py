"""精确 token 计数：优先加载工作区自带的 DeepSeek 官方分词器。

分词器位置（按顺序探测）：
  <workspace>/deepseek_v4_tokenizer/tokenizer.json
  <kb-chat>/deepseek_v4_tokenizer/tokenizer.json
  <kb-chat>/tokenizer/tokenizer.json

找不到 tokenizers 依赖或词表时自动退回「字符数 × 0.6」估算，
并通过 available()/precision() 让前端明确展示当前计数方式（不再显示 ≈）。
"""
from __future__ import annotations

import logging
import threading
from pathlib import Path

logger = logging.getLogger("kbchat.tokens")

_ROOT = Path(__file__).resolve().parent.parent          # kb-chat/
_WORKSPACE = _ROOT.parent                                # Knowledge/
_CANDIDATES = (
    _WORKSPACE / "deepseek_v4_tokenizer" / "tokenizer.json",
    _ROOT / "deepseek_v4_tokenizer" / "tokenizer.json",
    _ROOT / "tokenizer" / "tokenizer.json",
)


class _LazyTokenizer:
    def __init__(self) -> None:
        self._loaded = False
        self._tok = None
        self._lock = threading.Lock()

    def get(self):
        if self._loaded:
            return self._tok
        with self._lock:
            if self._loaded:
                return self._tok
            self._loaded = True
            try:
                from tokenizers import Tokenizer  # type: ignore
            except Exception as exc:  # pragma: no cover - 依赖缺失时的降级路径
                logger.warning("tokenizers 未安装，token 计数将使用估算：%s", exc)
                return None
            for path in _CANDIDATES:
                if not path.is_file():
                    continue
                try:
                    self._tok = Tokenizer.from_file(str(path))
                    logger.info("DeepSeek tokenizer 已加载：%s", path)
                    return self._tok
                except Exception as exc:  # pragma: no cover
                    logger.warning("tokenizer 加载失败 %s：%s", path, exc)
            logger.warning("未找到 DeepSeek tokenizer.json，token 计数将使用估算")
            return None


_lazy = _LazyTokenizer()


def available() -> bool:
    return _lazy.get() is not None


def precision() -> str:
    return "exact" if available() else "estimate"


def count(text: str | None) -> int:
    """返回文本的 token 数（空串为 0）。

    有分词器时是精确值；否则为 max(1, round(chars×0.6)) 的估算值。
    """
    if not text:
        return 0
    tok = _lazy.get()
    if tok is None:
        return max(1, round(len(text) * 0.6))
    try:
        return len(tok.encode(text, add_special_tokens=False).ids)
    except Exception:  # pragma: no cover
        return max(1, round(len(text) * 0.6))


def count_many(texts) -> list[int]:
    return [count(t) for t in texts]
