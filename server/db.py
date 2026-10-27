"""KBChat 数据库层：SQLite（stdlib sqlite3，WAL），7 张表与契约 §3 逐字段一致。

单连接 + check_same_thread=False + 写操作 threading.Lock。
"""
from __future__ import annotations

import json
import re
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from . import tokens

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "kb.db"

_conn: sqlite3.Connection | None = None
_lock = threading.Lock()

DDL = """
CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id INTEGER,
  name TEXT NOT NULL,
  ext TEXT NOT NULL,
  size INTEGER NOT NULL,
  path TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  chunk_count INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL,
  folder_id INTEGER,
  seq INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'chat',
  pinned INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  reasoning TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  display_content TEXT,
  attachments TEXT,
  cache_hit_tokens INTEGER,
  cache_miss_tokens INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS turn_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id INTEGER NOT NULL,
  turn_index INTEGER NOT NULL,
  version INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(conv_id, turn_index, version)
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id, id);
CREATE INDEX IF NOT EXISTS idx_turn_versions_conv ON turn_versions(conv_id, turn_index);
CREATE TABLE IF NOT EXISTS usage_daily (
  date TEXT PRIMARY KEY,
  tokens INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
"""


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def init(db_path: Path = DB_PATH) -> None:
    """建表 + 开启 WAL / 外键 + 轻量迁移。幂等。"""
    global _conn
    db_path.parent.mkdir(parents=True, exist_ok=True)
    if _conn is not None:
        return
    _conn = sqlite3.connect(str(db_path), check_same_thread=False)
    _conn.row_factory = sqlite3.Row
    _conn.execute("PRAGMA journal_mode=WAL")
    _conn.execute("PRAGMA synchronous=NORMAL")
    _conn.execute("PRAGMA busy_timeout=5000")
    _conn.execute("PRAGMA cache_size=-20000")
    _conn.execute("PRAGMA temp_store=MEMORY")
    _conn.execute("PRAGMA foreign_keys=ON")
    _conn.executescript(DDL)
    _migrate(_conn)
    _backfill_file_tokens(_conn)
    _backfill_titles(_conn)
    _conn.commit()


def _migrate(c: sqlite3.Connection) -> None:
    """增量迁移：会话模式/排序、消息附件元数据、文件精确 token 数。"""
    cols = {r["name"] for r in c.execute("PRAGMA table_info(conversations)")}
    if "mode" not in cols:
        c.execute("ALTER TABLE conversations ADD COLUMN mode TEXT NOT NULL DEFAULT 'chat'")
    if "sort_order" not in cols:
        c.execute("ALTER TABLE conversations ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")
    if "pinned" not in cols:
        c.execute("ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0")

    msg_cols = {r["name"] for r in c.execute("PRAGMA table_info(messages)")}
    if "display_content" not in msg_cols:
        c.execute("ALTER TABLE messages ADD COLUMN display_content TEXT")
    if "attachments" not in msg_cols:
        c.execute("ALTER TABLE messages ADD COLUMN attachments TEXT")
    if "cache_hit_tokens" not in msg_cols:
        c.execute("ALTER TABLE messages ADD COLUMN cache_hit_tokens INTEGER")
    if "cache_miss_tokens" not in msg_cols:
        c.execute("ALTER TABLE messages ADD COLUMN cache_miss_tokens INTEGER")

    file_cols = {r["name"] for r in c.execute("PRAGMA table_info(files)")}
    if "tokens" not in file_cols:
        c.execute("ALTER TABLE files ADD COLUMN tokens INTEGER NOT NULL DEFAULT 0")


def _backfill_titles(c: sqlite3.Connection) -> None:
    """把占位标题（新对话 / 纯数字）补成可辨识标题。"""
    rows = c.execute("SELECT id, title FROM conversations").fetchall()
    for row in rows:
        title = (row["title"] or "").strip()
        if title and title != "新对话" and not title.isdigit():
            continue
        msgs = c.execute(
            "SELECT content FROM messages WHERE conv_id=? AND role='user' ORDER BY id",
            (row["id"],)).fetchall()
        chosen = ""
        for m in msgs:
            content = m["content"] or ""
            if not content.strip():
                continue
            hit = re.search(r"【附件：([^】\n]+)】", content)
            if hit:
                chosen = hit.group(1).strip()
                break
            first_line = content.splitlines()[0].strip()
            if len(first_line) >= 4 and not first_line.isdigit():
                chosen = first_line
                break
        if not chosen and msgs:
            chosen = (msgs[0]["content"] or "").splitlines()[0].strip()
        chosen = re.sub(r"\s+", " ", chosen).strip()
        if not chosen or chosen == title:
            continue
        c.execute("UPDATE conversations SET title=? WHERE id=?",
                  (chosen[:24], row["id"]))


def _backfill_file_tokens(c: sqlite3.Connection) -> None:
    """老数据补齐精确 token 数（只扫描 tokens=0 的文件，幂等）。"""
    rows = c.execute("SELECT id, content FROM files WHERE tokens=0").fetchall()
    if not rows:
        return
    for row in rows:
        c.execute("UPDATE files SET tokens=? WHERE id=?",
                  (tokens.count(row["content"] or ""), row["id"]))


def conn() -> sqlite3.Connection:
    if _conn is None:
        init()
    return _conn  # type: ignore[return-value]


def _exec(sql: str, params: Iterable[Any] = ()) -> sqlite3.Cursor:
    """写操作加锁；返回 cursor（可取 lastrowid）。"""
    with _lock:
        cur = conn().execute(sql, tuple(params))
        conn().commit()
        return cur


def query(sql: str, params: Iterable[Any] = ()) -> list[sqlite3.Row]:
    return conn().execute(sql, tuple(params)).fetchall()


# ---------- settings ----------
def get_setting(key: str) -> str | None:
    row = conn().execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row["value"] if row else None


def save_settings(kv: dict[str, str]) -> None:
    with _lock:
        for key, value in kv.items():
            conn().execute(
                "INSERT INTO settings(key,value) VALUES(?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, value),
            )
        conn().commit()


# ---------- folders ----------
def create_folder(name: str, parent_id: int | None) -> int:
    cur = _exec("INSERT INTO folders(name,parent_id,created_at) VALUES(?,?,?)",
                (name, parent_id, now()))
    return int(cur.lastrowid)


def rename_folder(folder_id: int, name: str) -> None:
    _exec("UPDATE folders SET name=? WHERE id=?", (name, folder_id))


def move_folder(folder_id: int, parent_id: int | None) -> None:
    _exec("UPDATE folders SET parent_id=? WHERE id=?", (parent_id, folder_id))


def delete_folder(folder_id: int) -> None:
    """级联：递归删除子目录及其下文件、分块。返回被删的 file_id 列表供索引清理。"""
    ids = _folder_and_descendants(folder_id)
    file_ids = [r["id"] for r in query(
        f"SELECT id FROM files WHERE folder_id IN ({','.join('?' * len(ids))})", ids)]
    with _lock:
        for fid in file_ids:
            conn().execute("DELETE FROM chunks WHERE file_id=?", (fid,))
        conn().execute(f"DELETE FROM files WHERE folder_id IN ({','.join('?' * len(ids))})", ids)
        conn().execute(f"DELETE FROM folders WHERE id IN ({','.join('?' * len(ids))})", ids)
        conn().commit()
    return file_ids  # type: ignore[return-value]


def _folder_and_descendants(folder_id: int) -> list[int]:
    result: list[int] = []
    stack = [folder_id]
    while stack:
        fid = stack.pop()
        result.append(fid)
        stack.extend(int(r["id"]) for r in query(
            "SELECT id FROM folders WHERE parent_id=?", (fid,)))
    return result


# ---------- files ----------
def create_file(folder_id: int | None, name: str, ext: str, size: int,
                path: str, content: str, chunk_count: int,
                token_count: int | None = None) -> int:
    if token_count is None:
        token_count = tokens.count(content)
    cur = _exec(
        "INSERT INTO files(folder_id,name,ext,size,path,content,chunk_count,tokens,created_at) "
        "VALUES(?,?,?,?,?,?,?,?,?)",
        (folder_id, name, ext, size, path, content, chunk_count, token_count, now()))
    return int(cur.lastrowid)


def set_file_tokens(file_id: int, token_count: int) -> None:
    _exec("UPDATE files SET tokens=? WHERE id=?", (token_count, file_id))


def get_file(file_id: int) -> sqlite3.Row | None:
    return conn().execute("SELECT * FROM files WHERE id=?", (file_id,)).fetchone()


def delete_file(file_id: int) -> None:
    _exec("DELETE FROM chunks WHERE file_id=?", (file_id,))
    _exec("DELETE FROM files WHERE id=?", (file_id,))


def rename_file(file_id: int, name: str, ext: str) -> None:
    _exec("UPDATE files SET name=?, ext=? WHERE id=?", (name, ext, file_id))


def move_file(file_id: int, folder_id: int | None) -> None:
    _exec("UPDATE files SET folder_id=? WHERE id=?", (folder_id, file_id))
    _exec("UPDATE chunks SET folder_id=? WHERE file_id=?", (folder_id, file_id))


def all_files() -> list[sqlite3.Row]:
    return query("SELECT * FROM files ORDER BY id")


def chunks_by_file(file_id: int) -> list[sqlite3.Row]:
    return query("SELECT * FROM chunks WHERE file_id=? ORDER BY seq", (file_id,))


def add_chunks(file_id: int, folder_id: int | None, texts: list[str]) -> list[int]:
    ids: list[int] = []
    with _lock:
        for seq, text in enumerate(texts):
            cur = conn().execute(
                "INSERT INTO chunks(file_id,folder_id,seq,text) VALUES(?,?,?,?)",
                (file_id, folder_id, seq, text))
            ids.append(int(cur.lastrowid))
        conn().commit()
    return ids


# ---------- conversations / messages ----------
def create_conversation(title: str, mode: str = "chat") -> int:
    ts = now()
    cur = _exec("INSERT INTO conversations(title,mode,created_at,updated_at) VALUES(?,?,?,?)",
                (title, mode, ts, ts))
    return int(cur.lastrowid)


def touch_conversation(conv_id: int) -> None:
    _exec("UPDATE conversations SET updated_at=? WHERE id=?", (now(), conv_id))


def update_conversation(conv_id: int, title: str | None = None,
                        mode: str | None = None, pinned: bool | None = None) -> None:
    sets, params = [], []
    if title is not None:
        sets.append("title=?"); params.append(title)
    if mode is not None:
        sets.append("mode=?"); params.append(mode)
    if pinned is not None:
        sets.append("pinned=?"); params.append(1 if pinned else 0)
    if not sets:
        return
    sets.append("updated_at=?"); params.append(now())
    params.append(conv_id)
    _exec(f"UPDATE conversations SET {', '.join(sets)} WHERE id=?", params)


def delete_conversation(conv_id: int) -> None:
    _exec("DELETE FROM messages WHERE conv_id=?", (conv_id,))
    _exec("DELETE FROM turn_versions WHERE conv_id=?", (conv_id,))
    _exec("DELETE FROM conversations WHERE id=?", (conv_id,))


def get_conversation(conv_id: int) -> sqlite3.Row | None:
    return conn().execute("SELECT * FROM conversations WHERE id=?", (conv_id,)).fetchone()


def list_conversations() -> list[sqlite3.Row]:
    return query(
        "SELECT c.id, c.title, c.mode, c.pinned, c.updated_at, "
        "(SELECT COUNT(*) FROM messages m WHERE m.conv_id=c.id) AS message_count "
        "FROM conversations c ORDER BY c.pinned DESC, c.sort_order ASC, c.updated_at DESC")


def list_messages(conv_id: int) -> list[sqlite3.Row]:
    return query("SELECT * FROM messages WHERE conv_id=? ORDER BY id", (conv_id,))


def get_message(conv_id: int, message_id: int) -> sqlite3.Row | None:
    return conn().execute(
        "SELECT * FROM messages WHERE conv_id=? AND id=?", (conv_id, message_id)).fetchone()


def last_message(conv_id: int) -> sqlite3.Row | None:
    return conn().execute(
        "SELECT * FROM messages WHERE conv_id=? ORDER BY id DESC LIMIT 1", (conv_id,)).fetchone()


def delete_messages_from(conv_id: int, message_id: int) -> int:
    """删除 message_id 及其后所有消息（原位编辑/重新生成的截断），返回删除条数。"""
    with _lock:
        cur = conn().execute(
            "DELETE FROM messages WHERE conv_id=? AND id>=?", (conv_id, message_id))
        conn().commit()
        return cur.rowcount


def _turn_ranges(conv_id: int) -> list[tuple[int, int]]:
    """返回每个用户轮次的消息 id 区间 [start_id, end_id]（含用户和随后的助手消息）。"""
    rows = list_messages(conv_id)
    ranges: list[tuple[int, int]] = []
    start = None
    last = None
    for m in rows:
        if m["role"] == "user":
            if start is not None:
                ranges.append((start, last))
            start = int(m["id"])
        last = int(m["id"])
    if start is not None:
        ranges.append((start, last if last is not None else start))
    return ranges


def turn_index_of_message(conv_id: int, message_id: int) -> int | None:
    user_pos = 0
    for m in list_messages(conv_id):
        if m["role"] == "user":
            if int(m["id"]) == int(message_id):
                return user_pos
            user_pos += 1
    return None


def turn_snapshot(conv_id: int, turn_index: int) -> list[dict[str, Any]]:
    ranges = _turn_ranges(conv_id)
    if turn_index < 0 or turn_index >= len(ranges):
        return []
    start, end = ranges[turn_index]
    out = []
    for m in list_messages(conv_id):
        if start <= int(m["id"]) <= end:
            out.append({
                "role": m["role"], "content": m["content"],
                "reasoning": m["reasoning"],
                "prompt_tokens": int(m["prompt_tokens"] or 0),
                "completion_tokens": int(m["completion_tokens"] or 0),
                "elapsed_ms": int(m["elapsed_ms"] or 0),
                "display_content": m["display_content"],
                "attachments": m["attachments"],
                "cache_hit_tokens": m["cache_hit_tokens"],
                "cache_miss_tokens": m["cache_miss_tokens"],
            })
    return out


def snapshot_turn(conv_id: int, turn_index: int) -> dict[str, Any]:
    data = json.dumps(turn_snapshot(conv_id, turn_index), ensure_ascii=False)
    if data == "[]":
        raise ValueError("轮次不存在")
    rows = query(
        "SELECT * FROM turn_versions WHERE conv_id=? AND turn_index=? ORDER BY version",
        (conv_id, turn_index))
    for existing in rows:
        if existing["data"] == data:
            _exec("UPDATE turn_versions SET active=0 WHERE conv_id=? AND turn_index=?",
                  (conv_id, turn_index))
            _exec("UPDATE turn_versions SET active=1 WHERE id=?", (existing["id"],))
            return {"version": int(existing["version"]), "total": len(rows)}
    last = rows[-1] if rows else None
    version = (int(last["version"]) + 1) if last else 1
    _exec("UPDATE turn_versions SET active=0 WHERE conv_id=? AND turn_index=?",
          (conv_id, turn_index))
    _exec(
        "INSERT INTO turn_versions(conv_id,turn_index,version,active,data,created_at) "
        "VALUES(?,?,?,1,?,?)",
        (conv_id, turn_index, version, data, now()))
    return {"version": version, "total": len(rows) + 1}


def activate_turn_version(conv_id: int, turn_index: int, version: int) -> bool:
    row = query(
        "SELECT * FROM turn_versions WHERE conv_id=? AND turn_index=? AND version=?",
        (conv_id, turn_index, version))
    if not row:
        return False
    ranges = _turn_ranges(conv_id)
    if turn_index < 0 or turn_index >= len(ranges):
        return False
    start, end = ranges[turn_index]
    msgs = json.loads(row[0]["data"])
    with _lock:
        conn().execute(
            "DELETE FROM messages WHERE conv_id=? AND id>=? AND id<=?",
            (conv_id, start, end))
        for m in msgs:
            conn().execute(
                "INSERT INTO messages(conv_id,role,content,reasoning,prompt_tokens,"
                "completion_tokens,elapsed_ms,display_content,attachments,"
                "cache_hit_tokens,cache_miss_tokens,created_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (conv_id, m.get("role"), m.get("content", ""), m.get("reasoning"),
                 int(m.get("prompt_tokens") or 0), int(m.get("completion_tokens") or 0),
                 int(m.get("elapsed_ms") or 0), m.get("display_content"),
                 m.get("attachments"), m.get("cache_hit_tokens"),
                 m.get("cache_miss_tokens"), now()))
        conn().execute(
            "UPDATE turn_versions SET active=0 WHERE conv_id=? AND turn_index=?",
            (conv_id, turn_index))
        conn().execute(
            "UPDATE turn_versions SET active=1 WHERE conv_id=? AND turn_index=? AND version=?",
            (conv_id, turn_index, version))
        conn().commit()
    touch_conversation(conv_id)
    return True


def clear_turn_versions_after(conv_id: int, turn_index: int) -> None:
    _exec("DELETE FROM turn_versions WHERE conv_id=? AND turn_index>?", (conv_id, turn_index))


def turn_version_summary(conv_id: int) -> dict[int, dict[str, int]]:
    rows = query(
        "SELECT turn_index, COUNT(*) AS total, "
        "COALESCE(MAX(CASE WHEN active=1 THEN version END),0) AS active "
        "FROM turn_versions WHERE conv_id=? GROUP BY turn_index", (conv_id,))
    return {int(r["turn_index"]): {"count": int(r["total"]), "active": int(r["active"])}
            for r in rows}


def _search_snippet(text: str, q: str, width: int = 150) -> str:
    raw = str(text or "").replace("\r", "")
    low = raw.casefold()
    needle = q.casefold()
    idx = low.find(needle)
    if idx < 0:
        return raw[:width].replace("\n", " ").strip()
    start = max(0, idx - 60)
    end = min(len(raw), idx + len(q) + 100)
    body = raw[start:end].replace("\n", " ").strip()
    return ("…" if start > 0 else "") + body + ("…" if end < len(raw) else "")


def search_messages(q: str, limit: int = 80) -> list[dict[str, Any]]:
    q = (q or "").strip()
    if len(q) < 1:
        return []
    limit = max(1, min(int(limit or 80), 200))
    rows = query(
        "SELECT m.id, m.conv_id, m.role, m.content, m.display_content, m.reasoning, "
        "m.created_at, c.title FROM messages m "
        "JOIN conversations c ON c.id=m.conv_id "
        "WHERE m.role IN ('user','assistant') AND ("
        "instr(lower(COALESCE(m.content,'')), lower(?))>0 OR "
        "instr(lower(COALESCE(m.display_content,'')), lower(?))>0 OR "
        "instr(lower(COALESCE(m.reasoning,'')), lower(?))>0) "
        "ORDER BY m.id DESC LIMIT ?", (q, q, q, limit))
    out = []
    for r in rows:
        content = r["content"] or ""
        display = r["display_content"] or ""
        reasoning = r["reasoning"] or ""
        source = content
        needle = q.casefold()
        if needle not in content.casefold():
            if needle in display.casefold():
                source = display
            elif needle in reasoning.casefold():
                source = reasoning
        out.append({
            "conversationId": int(r["conv_id"]),
            "title": r["title"] or "未命名对话",
            "messageId": int(r["id"]),
            "role": r["role"],
            "createdAt": r["created_at"],
            "snippet": _search_snippet(source, q),
        })
    return out


def recent_messages(conv_id: int, n: int = 20) -> list[dict[str, str]]:
    """最近 n 条 user/assistant 历史（不含 reasoning），按时间正序返回。"""
    rows = query(
        "SELECT role, content FROM messages WHERE conv_id=? AND role IN ('user','assistant') "
        "ORDER BY id DESC LIMIT ?", (conv_id, n))
    return [{"role": r["role"], "content": r["content"]} for r in reversed(rows)]


def add_message(conv_id: int, role: str, content: str, reasoning: str | None = None,
                prompt_tokens: int = 0, completion_tokens: int = 0,
                elapsed_ms: int = 0, display_content: str | None = None,
                attachments: str | None = None,
                cache_hit_tokens: int | None = None,
                cache_miss_tokens: int | None = None) -> int:
    cur = _exec(
        "INSERT INTO messages(conv_id,role,content,reasoning,prompt_tokens,"
        "completion_tokens,elapsed_ms,display_content,attachments,"
        "cache_hit_tokens,cache_miss_tokens,created_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        (conv_id, role, content, reasoning, prompt_tokens, completion_tokens,
         elapsed_ms, display_content, attachments, cache_hit_tokens,
         cache_miss_tokens, now()))
    touch_conversation(conv_id)
    return int(cur.lastrowid)


# ---------- usage ----------
def add_usage(tokens: int) -> None:
    _exec(
        "INSERT INTO usage_daily(date,tokens) VALUES(?,?) "
        "ON CONFLICT(date) DO UPDATE SET tokens=tokens+excluded.tokens",
        (today(), tokens))


def context_tokens(conv_id: int) -> int:
    """会话当前上下文占用 = 最近一次有 usage 的 assistant 的 prompt+completion。

    prompt_tokens 由上游统计，天然包含 system 注入、历史消息与附件全文。
    中断生成的消息没有 usage 时，回退到更早一条有计数的回答，避免进度条突然归零。
    """
    row = conn().execute(
        "SELECT prompt_tokens, completion_tokens FROM messages "
        "WHERE conv_id=? AND role='assistant' "
        "AND (prompt_tokens > 0 OR completion_tokens > 0) "
        "ORDER BY id DESC LIMIT 1", (conv_id,)).fetchone()
    if not row:
        return 0
    return int(row["prompt_tokens"] or 0) + int(row["completion_tokens"] or 0)


def conversation_usage(conv_id: int) -> dict[str, Any]:
    """本会话累计真实消耗：每轮请求的 prompt + 每轮回答的 completion 之和。"""
    row = conn().execute(
        "SELECT COALESCE(SUM(prompt_tokens),0) AS p, "
        "COALESCE(SUM(completion_tokens),0) AS c, "
        "COALESCE(SUM(CASE WHEN role='assistant' AND (COALESCE(prompt_tokens,0)+COALESCE(completion_tokens,0))>0 THEN 1 ELSE 0 END),0) AS turns, "
        "COALESCE(SUM(CASE WHEN cache_hit_tokens IS NOT NULL THEN cache_hit_tokens ELSE 0 END),0) AS hit, "
        "COALESCE(SUM(CASE WHEN cache_miss_tokens IS NOT NULL THEN cache_miss_tokens ELSE 0 END),0) AS miss, "
        "COALESCE(SUM(CASE WHEN cache_hit_tokens IS NOT NULL THEN 1 ELSE 0 END),0) AS cache_known "
        "FROM messages WHERE conv_id=?", (conv_id,)).fetchone()
    prompt = int(row["p"] or 0)
    completion = int(row["c"] or 0)
    hit = int(row["hit"] or 0)
    miss = int(row["miss"] or 0)
    known = int(row["cache_known"] or 0) > 0
    rate = (hit / (hit + miss)) if known and (hit + miss) > 0 else None
    return {"promptTokens": prompt, "completionTokens": completion,
            "totalTokens": prompt + completion, "turns": int(row["turns"] or 0),
            "cacheHitTokens": hit, "cacheMissTokens": miss,
            "cacheHitRate": rate, "cacheKnown": known}


def total_usage() -> int:
    row = conn().execute("SELECT COALESCE(SUM(tokens),0) AS t FROM usage_daily").fetchone()
    return int(row["t"] or 0)


def today_usage() -> int:
    row = conn().execute(
        "SELECT COALESCE(tokens,0) AS t FROM usage_daily WHERE date=?", (today(),)).fetchone()
    return int(row["t"] or 0) if row else 0


# ---------- export/import ----------
def export_all() -> dict[str, Any]:
    def rows(table: str, order: str = "id") -> list[dict[str, Any]]:
        return [dict(r) for r in query(f"SELECT * FROM {table} ORDER BY {order}")]

    return {
        "folders": rows("folders"),
        "files": rows("files"),
        "chunks": rows("chunks"),
        "conversations": rows("conversations"),
        "messages": rows("messages"),
        "usage_daily": rows("usage_daily", order="date"),
        "settings": {k: v for k, v in ((r["key"], r["value"])
                                       for r in query("SELECT * FROM settings"))
                     if k != "api_key"},
    }
