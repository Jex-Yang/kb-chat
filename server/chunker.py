"""KBChat 分块与 bigram 倒排检索。

- chunk(text)：600 字/块，相邻块重叠 100 字；空文本返回 []
- 内存 bigram 倒排索引：dict[bigram -> dict[chunk_id -> tf]]
- score = 匹配 bigram 占比 × 长度归一化，保留 4 位小数
"""
from __future__ import annotations

import math
import re
import threading
from typing import Any

CHUNK_SIZE = 600
CHUNK_OVERLAP = 100
TOP_K = 8

# 长度归一化因子：len=600 时 norm=0.5，len≤60 时 norm≥0.91，抑制长块 tf 优势
_NORM_BASE = 600.0

_WORD_RE = re.compile(r"[a-zA-Z0-9]+")

# chunk_id -> {"file_id", "file_name", "text", "length"}
_meta: dict[int, dict[str, Any]] = {}
# bigram -> {chunk_id: tf}
_index: dict[str, dict[int, int]] = {}
_lock = threading.Lock()


# ---------- 分块 ----------
def chunk(text: str, size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """按 size 字分块，相邻块重叠 overlap 字。空/纯空白文本返回 []。"""
    text = (text or "").strip()
    if not text:
        return []
    step = size - overlap
    if step <= 0:
        raise ValueError("chunk size 必须大于 overlap")
    pieces: list[str] = []
    start = 0
    n = len(text)
    while start < n:
        pieces.append(text[start:start + size])
        if start + size >= n:
            break
        start += step
    return pieces


# ---------- 索引 ----------
def _bigrams(text: str) -> list[str]:
    """中文按字符 bigram；连续英文/数字词整体作为一个 token（不跨词切碎）。"""
    tokens: list[str] = []
    pos = 0
    for m in _WORD_RE.finditer(text):
        seg = text[pos:m.start()]
        tokens.extend(_char_bigrams(seg))
        tokens.append(m.group(0).lower())
        pos = m.end()
    tokens.extend(_char_bigrams(text[pos:]))
    return [t for t in tokens if t.strip()]


def _char_bigrams(seg: str) -> list[str]:
    seg = seg.strip()
    if len(seg) == 1:
        return [seg]
    return [seg[i:i + 2] for i in range(len(seg) - 1)]


def add_file(file_id: int, file_name: str, chunk_ids: list[int], texts: list[str]) -> None:
    """上传/导入解析完成后将一个文件的全部分块加入索引。"""
    assert len(chunk_ids) == len(texts)
    with _lock:
        for cid, text in zip(chunk_ids, texts):
            _meta[cid] = {"file_id": file_id, "file_name": file_name,
                          "text": text, "length": len(text)}
            for term, tf in _term_freq(text).items():
                _index.setdefault(term, {})[cid] = tf


def rename_file(file_id: int, file_name: str) -> None:
    """文件重命名后同步检索来源里的文件名。"""
    with _lock:
        for meta in _meta.values():
            if meta.get("file_id") == file_id:
                meta["file_name"] = file_name


def remove_file(file_id: int) -> None:
    """文件删除后将其全部分块从索引移除。"""
    with _lock:
        stale = [cid for cid, m in _meta.items() if m["file_id"] == file_id]
        for cid in stale:
            _meta.pop(cid, None)
        if stale:
            stale_set = set(stale)
            for term in list(_index.keys()):
                postings = _index[term]
                for cid in stale_set:
                    postings.pop(cid, None)
                if not postings:
                    del _index[term]


def rebuild(rows: list[dict[str, Any]]) -> None:
    """从 chunks 表记录全量重建索引（启动/导入后）。

    rows 需含 chunk.id / file_id / text，以及 file_name 映射由调用方补全为
    [{id, file_id, file_name, text}]。
    """
    with _lock:
        _meta.clear()
        _index.clear()
    for r in rows:
        add_file(r["file_id"], r["file_name"], [r["id"]], [r["text"]])


def _term_freq(text: str) -> dict[str, int]:
    tf: dict[str, int] = {}
    for t in _bigrams(text):
        tf[t] = tf.get(t, 0) + 1
    return tf


# ---------- 检索 ----------
def search(query_text: str, top_k: int = TOP_K) -> list[dict[str, Any]]:
    """bigram 倒排评分 + 长度归一化，按 score 降序。

    score = (命中的查询 bigram 数 / 查询 bigram 总数) × (600 / (600 + len(text)))
    """
    q_terms = set(_bigrams(query_text))
    if not q_terms:
        return []
    with _lock:
        candidates: dict[int, int] = {}
        for term in q_terms:
            for cid in _index.get(term, {}):
                candidates[cid] = candidates.get(cid, 0) + 1
        if not candidates:
            return []
        results: list[dict[str, Any]] = []
        for cid, matched in candidates.items():
            m = _meta[cid]
            ratio = matched / len(q_terms)
            norm = _NORM_BASE / (_NORM_BASE + m["length"])
            score = round(ratio * norm, 4)
            if score <= 0:
                continue
            results.append({
                "fileId": m["file_id"],
                "fileName": m["file_name"],
                "score": score,
                "text": m["text"],
            })
    results.sort(key=lambda r: r["score"], reverse=True)
    return results[:top_k]


def load_from_db(db_mod: Any) -> int:
    """进程启动时从 chunks 表全量加载索引，返回加载分块数。"""
    rows = db_mod.query(
        "SELECT c.id, c.file_id, c.text, f.name AS file_name "
        "FROM chunks c JOIN files f ON f.id = c.file_id ORDER BY c.id")
    rebuild([{"id": r["id"], "file_id": r["file_id"],
              "file_name": r["file_name"], "text": r["text"]} for r in rows])
    return len(rows)


def stats() -> dict[str, int]:
    with _lock:
        return {"chunks": len(_meta), "terms": len(_index)}
