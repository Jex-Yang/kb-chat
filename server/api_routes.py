"""KBChat REST / SSE 路由：契约 §4 全部 21 个接口。"""
from __future__ import annotations

import hashlib
import json
import re
import time
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, Response, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import chunker, config, db, llm, parsers, tokens

router = APIRouter(prefix="/api")

MAX_UPLOAD_BYTES = 20 * 1024 * 1024
MAX_ATTACHMENTS = 500
# 聊天模式单个附件注入上限（字符）；token 由 DeepSeek 分词器精确计算
CHAT_ATTACHMENT_MAX_CHARS = 150_000
# 单次请求全部附件注入上限（字符），避免大量大文件把请求撑爆
CHAT_ATTACHMENT_TOTAL_CHARS = 600_000
KB_SYSTEM_TEMPLATE = "你是企业知识库助手。仅依据以下资料回答，资料不足时明确说明。\n【参考资料】\n{refs}"
KB_SYSTEM_EMPTY = "你是企业知识库助手。当前知识库中未检索到相关资料，请明确告知用户未找到依据，并基于常识谨慎回答。"
PLAIN_SYSTEM = "你是一个乐于助人的中文 AI 助手"
EXPORT_VERSION = 1


# ---------- 请求模型 ----------
class SettingsUpdate(BaseModel):
    baseUrl: str | None = None
    apiKey: str | None = Field(default=None, description="空串=不修改")
    model: str | None = None
    quota: int | None = Field(default=None, ge=0)
    depth: str | None = None


class FolderCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    parentId: int | None = None


class FolderUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    parentId: int | None = None


class SearchReq(BaseModel):
    query: str = Field(min_length=1)
    topK: int = Field(default=chunker.TOP_K, ge=1, le=50)


class ConversationCreate(BaseModel):
    title: str = Field(default="新对话", min_length=1, max_length=200)
    mode: str = Field(default="chat", description="chat=聊天模式 / kb=知识库模式")


class ConversationUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    mode: str | None = Field(default=None, description="chat / kb")
    pinned: bool | None = Field(default=None, description="置顶")


class TurnVersionReq(BaseModel):
    version: int = Field(gt=0, description="要激活的轮次版本号")


class FileUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=255)


class FileCopy(BaseModel):
    folderId: int | None = None
    name: str | None = Field(default=None, max_length=255)


class FileMove(BaseModel):
    folderId: int | None = None


class FolderCopy(BaseModel):
    parentId: int | None = None
    name: str | None = Field(default=None, max_length=100)


class FolderMove(BaseModel):
    parentId: int | None = None


class ChatAttachment(BaseModel):
    name: str = Field(min_length=1, max_length=300)
    kind: str = Field(default="text", description="text=文本附件全文注入 / image=图片(base64)")
    ext: str = Field(default="", max_length=20)
    size: int = Field(default=0, ge=0)
    tokens: int | None = Field(default=None, ge=0)
    text: str = Field(default="", max_length=200_000)
    dataUrl: str | None = Field(default=None, max_length=12_000_000,
                                description="图片 dataURL（data:image/...;base64,...）")
    thumb: str | None = Field(default=None, max_length=300_000,
                              description="图片缩略图 dataURL（仅用于历史卡片展示）")
    preview: str | None = Field(default=None, max_length=3_000_000,
                                description="图片预览 dataURL（已压缩，用于历史预览）")


class ChatReq(BaseModel):
    conversationId: int
    message: str = Field(default="", max_length=2_000_000)
    displayMessage: str | None = Field(default=None, max_length=200_000,
                                       description="气泡中展示的原文（附件注入内容不展示）")
    mode: str | None = Field(default=None, description="chat / kb；缺省取会话自身 mode")
    useKb: bool | None = None  # 兼容旧契约：True→kb，False→chat
    model: str | None = None
    depth: str | None = None
    attachments: list[ChatAttachment] = Field(default_factory=list, max_length=MAX_ATTACHMENTS)


# ---------- #1 health ----------
@router.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


# ---------- #2/#3 settings ----------
def _current_settings() -> dict[str, str]:
    return config.get_settings(db.get_setting)


def _settings_response() -> dict[str, Any]:
    data = config.public_settings(_current_settings())
    data["tokenizer"] = tokens.precision()
    data["tokenizerModel"] = "DeepSeek（内置词表）"
    return data


@router.get("/settings")
def get_settings() -> dict[str, Any]:
    return _settings_response()


@router.put("/settings")
def put_settings(body: SettingsUpdate) -> dict[str, Any]:
    kv: dict[str, str] = {}
    if body.baseUrl is not None:
        kv["base_url"] = body.baseUrl.strip().rstrip("/")
    if body.apiKey:  # 空串/None = 不覆盖
        kv["api_key"] = body.apiKey.strip()
    if body.model is not None:
        model = body.model.strip()
        if not model:
            raise HTTPException(400, "模型名称不能为空")
        if len(model) > 100:
            raise HTTPException(400, "模型名称过长")
        kv["model"] = model
    if body.quota is not None:
        kv["quota"] = str(body.quota)
    if body.depth is not None:
        if body.depth not in config.DEPTHS:
            raise HTTPException(400, f"depth 仅支持 {'、'.join(config.DEPTHS)}")
        kv["depth"] = body.depth
    if kv:
        db.save_settings(kv)
    return _settings_response()


# ---------- #4 usage（语义：当前会话上下文占用，1M 为模型上下文长度，非每日配额） ----------
@router.get("/usage")
def usage(conversationId: int | None = None) -> dict[str, Any]:
    s = _current_settings()
    quota = int(s["quota"])
    used = db.context_tokens(conversationId) if conversationId else 0
    remaining = max(quota - used, 0)
    ratio = used / quota if quota > 0 else 0.0
    conv = db.conversation_usage(conversationId) if conversationId else {
        "promptTokens": 0, "completionTokens": 0, "totalTokens": 0, "turns": 0}
    return {
        "quota": quota,
        "used": used,
        "remaining": remaining,
        "ratio": ratio,
        "conversation": conv,
        "outputTokens": conv["completionTokens"],
        "todayTokens": db.today_usage(),
        "totalTokens": db.total_usage(),
        "tokenizer": tokens.precision(),
    }


# ---------- #5~8 目录树 / folders ----------
@router.get("/search")
def search_conversations(q: str = "", limit: int = 80) -> dict[str, Any]:
    q = (q or "").strip()[:200]
    if not q:
        return {"query": "", "results": []}
    return {"query": q, "results": db.search_messages(q, limit)}


@router.get("/tree")
def tree() -> dict[str, Any]:
    folders = [{"id": r["id"], "name": r["name"], "parentId": r["parent_id"],
                "createdAt": r["created_at"]}
               for r in db.query("SELECT * FROM folders ORDER BY id")]
    files = []
    for r in db.all_files():
        token_count = int(r["tokens"] or 0)
        if not token_count and r["content"]:
            token_count = tokens.count(r["content"])
            db.set_file_tokens(r["id"], token_count)
        files.append({"id": r["id"], "folderId": r["folder_id"], "name": r["name"],
                      "ext": r["ext"], "size": r["size"], "chunkCount": r["chunk_count"],
                      "tokens": token_count, "estTokens": token_count,
                      "createdAt": r["created_at"]})
    return {"folders": folders, "files": files}


@router.post("/folders")
def create_folder(body: FolderCreate) -> dict[str, int]:
    if body.parentId is not None and not db.query(
            "SELECT id FROM folders WHERE id=?", (body.parentId,)):
        raise HTTPException(404, f"父目录不存在：{body.parentId}")
    return {"id": db.create_folder(body.name, body.parentId)}


@router.put("/folders/{folder_id}")
def update_folder(folder_id: int, body: FolderUpdate) -> dict[str, bool]:
    if not db.query("SELECT id FROM folders WHERE id=?", (folder_id,)):
        raise HTTPException(404, f"目录不存在：{folder_id}")
    if body.name is not None:
        db.rename_folder(folder_id, body.name)
    if body.parentId is not None:
        descendants = set(db._folder_and_descendants(folder_id))
        if body.parentId in descendants:
            raise HTTPException(400, "不能把目录移动到自身或其子目录下")
        if body.parentId != folder_id and not db.query(
                "SELECT id FROM folders WHERE id=?", (body.parentId,)):
            raise HTTPException(404, f"目标父目录不存在：{body.parentId}")
        db.move_folder(folder_id, body.parentId)
    return {"ok": True}


@router.delete("/folders/{folder_id}")
def delete_folder(folder_id: int) -> dict[str, bool]:
    if not db.query("SELECT id FROM folders WHERE id=?", (folder_id,)):
        raise HTTPException(404, f"目录不存在：{folder_id}")
    ids = db._folder_and_descendants(folder_id)
    placeholders = ",".join("?" * len(ids))
    rows = db.query(f"SELECT * FROM files WHERE folder_id IN ({placeholders})", ids)
    file_ids = db.delete_folder(folder_id)
    for fid in file_ids:
        chunker.remove_file(fid)
    for row in rows:
        try:
            (config.PROJECT_ROOT / row["path"]).unlink(missing_ok=True)
        except OSError:
            pass
    return {"ok": True}


# ---------- #9~11 files ----------
def _upload_common(file: UploadFile, folder_id: int | None) -> dict[str, Any]:
    ext = (file.filename or "").rsplit(".", 1)[-1].lower()
    parsers.check_ext(ext)
    data = file.file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(400, "文件超过 20MB")
    text = parsers.parse(ext, data)
    token_count = tokens.count(text)
    pieces = chunker.chunk(text)
    # 原文件落盘（供下载）；文件名冲突加序号
    safe_name = file.filename
    dest = config.UPLOAD_DIR / safe_name
    i = 1
    while dest.exists():
        stem, dot, suffix = safe_name.rpartition(".")
        base = stem or safe_name
        suffix = ("." + suffix) if dot else ""
        dest = config.UPLOAD_DIR / f"{base}-{i}{suffix}"
        i += 1
    try:
        dest.write_bytes(data)
    except OSError:
        pass  # 落盘失败不阻塞入库，下载时会提示原文件不存在
    path = f"data/uploads/{dest.name}"
    file_id = db.create_file(folder_id, file.filename, ext, len(data), path,
                             text, len(pieces), token_count)
    chunk_ids = db.add_chunks(file_id, folder_id, pieces)
    chunker.add_file(file_id, file.filename, chunk_ids, pieces)
    return {"id": file_id, "name": file.filename, "chunkCount": len(pieces),
            "tokens": token_count, "estTokens": token_count}


@router.post("/files/upload")
def upload_file(
    file: UploadFile = File(...),
    folderId: str = Form(default=""),
) -> dict[str, Any]:
    folder_id: int | None = None
    if folderId not in ("", "null", "None"):
        folder_id = int(folderId)
    try:
        return _upload_common(file, folder_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.delete("/files/{file_id}")
def delete_file(file_id: int) -> dict[str, bool]:
    row = db.get_file(file_id)
    if not row:
        raise HTTPException(404, f"文件不存在：{file_id}")
    db.delete_file(file_id)
    chunker.remove_file(file_id)
    try:
        (config.PROJECT_ROOT / row["path"]).unlink(missing_ok=True)
    except OSError:
        pass
    return {"ok": True}


@router.get("/files/{file_id}/preview")
def preview_file(file_id: int) -> dict[str, Any]:
    row = db.get_file(file_id)
    if not row:
        raise HTTPException(404, f"文件不存在：{file_id}")
    return {"name": row["name"], "content": row["content"][:5000]}


@router.post("/files/parse")
async def parse_file_only(file: UploadFile = File(...)) -> dict[str, Any]:
    """仅解析不入库（聊天模式附件）：返回文本与 token 估算，供前端随消息注入。"""
    ext = (file.filename or "").rsplit(".", 1)[-1].lower()
    parsers.check_ext(ext)
    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(400, "文件超过 20MB")
    try:
        text = parsers.parse(ext, data)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    full_chars = len(text)
    truncated = full_chars > CHAT_ATTACHMENT_MAX_CHARS
    if truncated:
        text = text[:CHAT_ATTACHMENT_MAX_CHARS] + "\n…（附件过长，已截断）"
    return {"name": file.filename, "ext": ext, "chars": full_chars,
            "truncated": truncated, "tokens": tokens.count(text),
            "estTokens": tokens.count(text), "text": text}


# ---------- 文件/文件夹：重命名 / 移动 / 复制（Finder 式管理） ----------
def _clean_name(name: str) -> str:
    return str(name or "").replace("/", " ").replace("\\", " ").strip()


def _existing_names(table: str, parent_col: str, parent_id: int | None) -> set[str]:
    rows = db.query(
        f"SELECT name FROM {table} WHERE {parent_col} IS ?", (parent_id,))
    return {r["name"] for r in rows}


def _unique_name(name: str, existing: set[str], is_dir: bool = False) -> str:
    if name not in existing:
        return name
    if is_dir:
        candidate = f"{name} 副本"
        i = 2
        while candidate in existing:
            candidate = f"{name} 副本 {i}"
            i += 1
        return candidate
    stem, dot, suffix = name.rpartition(".")
    if dot:
        stem, ext = stem, "." + suffix
    else:
        stem, ext = name, ""
    candidate = f"{stem} 副本{ext}"
    i = 2
    while candidate in existing:
        candidate = f"{stem} 副本 {i}{ext}"
        i += 1
    return candidate


def _unique_upload_path(name: str):
    dest = config.UPLOAD_DIR / name
    i = 1
    while dest.exists():
        stem, dot, suffix = name.rpartition(".")
        base = stem or name
        suffix = ("." + suffix) if dot else ""
        dest = config.UPLOAD_DIR / f"{base}-{i}{suffix}"
        i += 1
    return dest


def _copy_file_record(row: Any, folder_id: int | None, name: str) -> int:
    src = config.PROJECT_ROOT / row["path"]
    try:
        data = src.read_bytes() if src.is_file() else (row["content"] or "").encode("utf-8")
    except OSError:
        data = (row["content"] or "").encode("utf-8")
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else row["ext"]
    dest = _unique_upload_path(name)
    try:
        config.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
    except OSError:
        pass
    token_count = int(row["tokens"] or 0) or tokens.count(row["content"] or "")
    new_id = db.create_file(folder_id, name, ext, len(data),
                            f"data/uploads/{dest.name}", row["content"] or "",
                            int(row["chunk_count"] or 0), token_count)
    pieces = [c["text"] for c in db.chunks_by_file(row["id"])]
    if pieces:
        chunk_ids = db.add_chunks(new_id, folder_id, pieces)
        chunker.add_file(new_id, name, chunk_ids, pieces)
    return new_id


def _copy_folder_tree(src_id: int, parent_id: int | None, name: str) -> dict[str, int]:
    new_id = db.create_folder(name, parent_id)
    folder_count, file_count = 0, 0
    existing_files: set[str] = set()
    for row in db.query("SELECT * FROM files WHERE folder_id=? ORDER BY id", (src_id,)):
        child_name = _unique_name(row["name"], existing_files)
        existing_files.add(child_name)
        _copy_file_record(row, new_id, child_name)
        file_count += 1
    for sub in db.query("SELECT * FROM folders WHERE parent_id=? ORDER BY id", (src_id,)):
        child_name = _unique_name(sub["name"], _existing_names("folders", "parent_id", new_id), True)
        res = _copy_folder_tree(int(sub["id"]), new_id, child_name)
        folder_count += res["folders"] + 1
        file_count += res["files"]
    return {"id": new_id, "folders": folder_count, "files": file_count}


@router.put("/files/{file_id}")
def rename_file(file_id: int, body: FileUpdate) -> dict[str, Any]:
    row = db.get_file(file_id)
    if not row:
        raise HTTPException(404, f"文件不存在：{file_id}")
    name = _clean_name(body.name)
    if not name:
        raise HTTPException(400, "文件名不能为空")
    if name != row["name"] and name in _existing_names("files", "folder_id", row["folder_id"]):
        raise HTTPException(400, f"同名文件已存在：{name}")
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else row["ext"]
    db.rename_file(file_id, name, ext)
    chunker.rename_file(file_id, name)
    return {"ok": True, "name": name, "ext": ext}


@router.post("/files/{file_id}/move")
def move_file(file_id: int, body: FileMove) -> dict[str, bool]:
    row = db.get_file(file_id)
    if not row:
        raise HTTPException(404, f"文件不存在：{file_id}")
    if body.folderId is not None and not db.query(
            "SELECT id FROM folders WHERE id=?", (body.folderId,)):
        raise HTTPException(404, f"目标目录不存在：{body.folderId}")
    db.move_file(file_id, body.folderId)
    return {"ok": True}


@router.post("/files/{file_id}/copy")
def copy_file(file_id: int, body: FileCopy) -> dict[str, Any]:
    row = db.get_file(file_id)
    if not row:
        raise HTTPException(404, f"文件不存在：{file_id}")
    if "folderId" in body.model_fields_set:
        folder_id = body.folderId
    else:
        folder_id = row["folder_id"]
    if folder_id is not None and not db.query(
            "SELECT id FROM folders WHERE id=?", (folder_id,)):
        raise HTTPException(404, f"目标目录不存在：{folder_id}")
    name = _clean_name(body.name) if body.name else _unique_name(
        row["name"], _existing_names("files", "folder_id", folder_id))
    if name in _existing_names("files", "folder_id", folder_id):
        name = _unique_name(name, _existing_names("files", "folder_id", folder_id))
    new_id = _copy_file_record(row, folder_id, name)
    return {"ok": True, "id": new_id, "name": name}


@router.post("/folders/{folder_id}/move")
def move_folder_endpoint(folder_id: int, body: FolderMove) -> dict[str, bool]:
    row = db.query("SELECT * FROM folders WHERE id=?", (folder_id,))
    if not row:
        raise HTTPException(404, f"目录不存在：{folder_id}")
    target = body.parentId
    if target is not None:
        if not db.query("SELECT id FROM folders WHERE id=?", (target,)):
            raise HTTPException(404, f"目标目录不存在：{target}")
        descendants = set(db._folder_and_descendants(folder_id))
        if target in descendants or target == folder_id:
            raise HTTPException(400, "不能把目录移动到自身或其子目录下")
    db.move_folder(folder_id, target)
    return {"ok": True}


@router.post("/folders/{folder_id}/copy")
def copy_folder(folder_id: int, body: FolderCopy) -> dict[str, Any]:
    row = db.query("SELECT * FROM folders WHERE id=?", (folder_id,))
    if not row:
        raise HTTPException(404, f"目录不存在：{folder_id}")
    if "parentId" in body.model_fields_set:
        parent_id = body.parentId
    else:
        parent_id = row[0]["parent_id"]
    if parent_id is not None and not db.query(
            "SELECT id FROM folders WHERE id=?", (parent_id,)):
        raise HTTPException(404, f"目标目录不存在：{parent_id}")
    descendants = set(db._folder_and_descendants(folder_id))
    if parent_id in descendants or parent_id == folder_id:
        raise HTTPException(400, "不能把目录复制到自身或其子目录下")
    name = _clean_name(body.name) if body.name else _unique_name(
        row[0]["name"], _existing_names("folders", "parent_id", parent_id), True)
    if name in _existing_names("folders", "parent_id", parent_id):
        name = _unique_name(name, _existing_names("folders", "parent_id", parent_id), True)
    res = _copy_folder_tree(folder_id, parent_id, name)
    return {"ok": True, "id": res["id"], "folders": res["folders"] + 1,
            "files": res["files"], "name": name}


@router.delete("/conversations/{conv_id}/messages/{message_id}")
def truncate_messages(conv_id: int, message_id: int) -> dict[str, Any]:
    """原位编辑/重新生成：删除 message_id 及其后所有消息。"""
    _get_conv_or_404(conv_id)
    if not db.get_message(conv_id, message_id):
        raise HTTPException(404, f"消息不存在：{message_id}")
    turn_index = db.turn_index_of_message(conv_id, message_id)
    deleted = db.delete_messages_from(conv_id, message_id)
    if turn_index is not None:
        db.clear_turn_versions_after(conv_id, turn_index + 1)
    return {"ok": True, "deleted": deleted}


@router.post("/conversations/{conv_id}/turns/{turn_index}/snapshot")
def snapshot_turn_version(conv_id: int, turn_index: int) -> dict[str, Any]:
    _get_conv_or_404(conv_id)
    try:
        res = db.snapshot_turn(conv_id, turn_index)
    except ValueError as e:
        raise HTTPException(404, str(e))
    return {"ok": True, **res}


@router.post("/conversations/{conv_id}/turns/{turn_index}/activate")
def activate_turn_version(conv_id: int, turn_index: int, body: TurnVersionReq) -> dict[str, Any]:
    _get_conv_or_404(conv_id)
    if not db.activate_turn_version(conv_id, turn_index, body.version):
        raise HTTPException(404, "该轮次版本不存在")
    return get_conversation(conv_id)


# ---------- #9c 原文件下载 ----------
TEXT_LIKE_EXTS = {"txt", "md", "csv"}


def _content_disposition(filename: str) -> str:
    """中文文件名安全：ASCII 回退 + RFC 5987 filename*。"""
    from urllib.parse import quote
    fallback = filename.encode("ascii", "ignore").decode("ascii").replace('"', "") or "download"
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quote(filename)}"


@router.get("/files/{file_id}/download")
def download_file(file_id: int) -> Response:
    row = db.get_file(file_id)
    if not row:
        raise HTTPException(404, f"文件不存在：{file_id}")
    path = config.PROJECT_ROOT / row["path"]
    if path.is_file():
        body = path.read_bytes()
    elif row["ext"] in TEXT_LIKE_EXTS and row["content"]:
        # 旧版本上传的纯文本文件未落盘：用已解析文本兜底
        body = row["content"].encode("utf-8")
    else:
        raise HTTPException(404, "原文件已不存在（早期上传未落盘），请重新上传该文件")
    return Response(
        content=body,
        media_type="application/octet-stream",
        headers={"Content-Disposition": _content_disposition(row["name"])},
    )


# ---------- #12 kb/search ----------
@router.post("/kb/search")
def kb_search(body: SearchReq) -> list[dict[str, Any]]:
    return chunker.search(body.query, body.topK)


# ---------- #13~17 conversations ----------
MODES = ("chat", "kb")


@router.get("/conversations")
def list_conversations() -> list[dict[str, Any]]:
    return [{"id": r["id"], "title": r["title"], "mode": r["mode"],
             "pinned": bool(r["pinned"]), "updatedAt": r["updated_at"],
             "messageCount": r["message_count"]} for r in db.list_conversations()]


@router.post("/conversations")
def create_conversation(body: ConversationCreate) -> dict[str, int]:
    if body.mode not in MODES:
        raise HTTPException(400, f"mode 仅支持 {' / '.join(MODES)}")
    return {"id": db.create_conversation(body.title, body.mode)}


def _get_conv_or_404(conv_id: int) -> Any:
    row = db.get_conversation(conv_id)
    if not row:
        raise HTTPException(404, f"会话不存在：{conv_id}")
    return row


def _parse_attachments(raw: Any) -> list[dict[str, Any]]:
    if not raw:
        return []
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except (TypeError, ValueError):
        return []
    return data if isinstance(data, list) else []


_LEGACY_ATTACHMENT_RE = re.compile(
    r"【附件：([^】\n]+)】\n```\n(.*?)\n```|\[图片附件：([^\]]+)\]", re.S)


def _legacy_attachments(content: str) -> list[dict[str, Any]]:
    """旧版本消息把附件全文直接写进 content；这里还原卡片元数据并补精确 token。"""
    out: list[dict[str, Any]] = []
    for match in _LEGACY_ATTACHMENT_RE.finditer(content or ""):
        text_name, body, image_name = match.group(1), match.group(2), match.group(3)
        if image_name:
            out.append({"name": image_name.strip(), "kind": "image",
                        "ext": (image_name.rsplit(".", 1)[-1].lower()
                                if "." in image_name else "image"),
                        "size": 0, "tokens": None})
            continue
        name = (text_name or "").strip()
        ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
        out.append({"name": name, "kind": "text", "ext": ext, "size": 0,
                    "tokens": tokens.count(body or "")})
    return out


@router.get("/conversations/{conv_id}")
def get_conversation(conv_id: int) -> dict[str, Any]:
    row = _get_conv_or_404(conv_id)
    messages = []
    version_summary = db.turn_version_summary(conv_id)
    user_index = 0
    for m in db.list_messages(conv_id):
        atts = _parse_attachments(m["attachments"] if "attachments" in m.keys() else None)
        if not atts and m["role"] == "user":
            atts = _legacy_attachments(m["content"])
        version_info = None
        if m["role"] == "user":
            info = version_summary.get(user_index) or {}
            version_info = {
                "turnIndex": user_index,
                "versionCount": max(1, int(info.get("count") or 1)),
                "activeVersion": max(1, int(info.get("active") or 1)),
            }
            user_index += 1
        messages.append({
            "id": m["id"], "role": m["role"], "content": m["content"],
            "displayContent": m["display_content"] if "display_content" in m.keys() else None,
            "attachments": atts,
            "reasoning": m["reasoning"], "promptTokens": m["prompt_tokens"],
            "completionTokens": m["completion_tokens"],
            "totalTokens": int(m["prompt_tokens"] or 0) + int(m["completion_tokens"] or 0),
            "cacheHitTokens": m["cache_hit_tokens"] if "cache_hit_tokens" in m.keys() else None,
            "cacheMissTokens": m["cache_miss_tokens"] if "cache_miss_tokens" in m.keys() else None,
            "elapsedMs": m["elapsed_ms"], "createdAt": m["created_at"],
            **(version_info or {})})
    return {"id": row["id"], "title": row["title"],
            "mode": row["mode"] if "mode" in row.keys() else "chat",
            "messages": messages,
            "usage": db.conversation_usage(conv_id),
            "contextTokens": db.context_tokens(conv_id)}


@router.put("/conversations/{conv_id}")
def update_conversation(conv_id: int, body: ConversationUpdate) -> dict[str, bool]:
    _get_conv_or_404(conv_id)
    if body.mode is not None and body.mode not in MODES:
        raise HTTPException(400, f"mode 仅支持 {' / '.join(MODES)}")
    db.update_conversation(conv_id, body.title, body.mode, body.pinned)
    return {"ok": True}


@router.delete("/conversations/{conv_id}")
def delete_conversation(conv_id: int) -> dict[str, bool]:
    _get_conv_or_404(conv_id)
    db.delete_conversation(conv_id)
    return {"ok": True}


# ---------- #18 chat SSE ----------
def _sse(obj: dict[str, Any]) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False, separators=(',', ':'))}\n\n"


def _resolve_mode(conv_row: Any, body: ChatReq) -> str:
    """请求 mode > 旧契约 useKb > 会话自身 mode > chat。"""
    if body.mode in MODES:
        return body.mode
    if body.useKb is True:
        return "kb"
    if body.useKb is False:
        return "chat"
    row_mode = conv_row["mode"] if "mode" in conv_row.keys() else "chat"
    return row_mode if row_mode in MODES else "chat"


def _usage_breakdown(payload: dict[str, Any]) -> tuple[int, int, int, int | None, int | None]:
    """兼容 DeepSeek / OpenAI 的 usage 字段，拆出 prompt / completion / 缓存命中。"""
    prompt = int(payload.get("prompt_tokens") or 0)
    completion = int(payload.get("completion_tokens") or 0)
    total = int(payload.get("total_tokens") or (prompt + completion))
    details = payload.get("prompt_tokens_details") or {}
    hit = payload.get("prompt_cache_hit_tokens")
    if hit is None:
        hit = payload.get("cache_hit_tokens")
    if hit is None:
        hit = payload.get("cached_tokens")
    if hit is None and isinstance(details, dict):
        hit = details.get("cached_tokens")
        if hit is None:
            hit = details.get("cache_hit_tokens")
    if hit is None:
        return prompt, completion, total, None, None
    hit_i = int(hit or 0)
    miss = payload.get("prompt_cache_miss_tokens")
    if miss is None:
        miss = payload.get("cache_miss_tokens")
    miss_i = int(miss) if miss is not None else max(prompt - hit_i, 0)
    return prompt, completion, total, hit_i, miss_i


def _attachment_text_message(message: str, attachments: list[ChatAttachment],
                             include_image_placeholder: bool = True) -> str:
    """把文本附件拼进用户消息，并对单附件/总注入量做双重截断。"""
    parts = [message] if message else []
    used = len(message or "")
    for att in attachments:
        if att.kind == "image":
            if include_image_placeholder:
                parts.append(f"\n[图片附件：{att.name}]")
            continue
        text = att.text or ""
        if len(text) > CHAT_ATTACHMENT_MAX_CHARS:
            text = text[:CHAT_ATTACHMENT_MAX_CHARS] + "\n…（附件过长，已截断）"
        remaining = CHAT_ATTACHMENT_TOTAL_CHARS - used
        if remaining <= 0:
            parts.append("\n…（附件总量超出单次注入上限，后续附件已省略）")
            break
        if len(text) > remaining:
            text = text[:remaining] + "\n…（附件总量超出单次注入上限，已截断）"
        block = f"\n【附件：{att.name}】\n```\n{text}\n```"
        parts.append(block)
        used += len(block)
    return "\n".join(parts).strip()


def _compose_user_content(message: str, attachments: list[ChatAttachment]) -> str:
    """落库内容：文本附件全文注入；图片以占位符落库（图片本体只随本次上游请求发送）。"""
    return _attachment_text_message(message, attachments, include_image_placeholder=True)


def _build_user_upstream_content(
    message: str, attachments: list[ChatAttachment], mode: str
) -> str | list[dict[str, Any]]:
    """构造最终发给上游的 user content。

    聊天模式且带图片 → content 数组（图片在前、文本在后，OpenAI 兼容视觉格式）；
    其余情况 → 纯文本字符串（含文本附件全文）。
    """
    text = _attachment_text_message(message, attachments, include_image_placeholder=False)
    images: list[dict[str, Any]] = []
    if mode == "chat":
        for att in attachments:
            if att.kind == "image" and att.dataUrl:
                images.append({"type": "image_url", "image_url": {"url": att.dataUrl}})
    if images:
        return [*images, {"type": "text", "text": text or "请描述这些图片。"}]
    return text


def _attachment_metadata(attachments: list[ChatAttachment]) -> list[dict[str, Any]]:
    """消息附件元数据（不含全文，供历史消息渲染卡片）。"""
    metas: list[dict[str, Any]] = []
    for att in attachments:
        kind = "image" if att.kind == "image" else "text"
        ext = (att.ext or (att.name.rsplit(".", 1)[-1] if "." in att.name else "")).lower()[:16]
        if kind == "image":
            token_count = int(att.tokens) if att.tokens else None
        else:
            token_count = tokens.count((att.text or "")[:CHAT_ATTACHMENT_MAX_CHARS])
        meta: dict[str, Any] = {"name": att.name, "kind": kind, "ext": ext,
                                "size": int(att.size or 0), "tokens": token_count}
        if att.thumb:
            meta["thumb"] = att.thumb
        if att.preview:
            meta["preview"] = att.preview
        metas.append(meta)
    return metas


def _build_messages(conv_id: int, user_content: str | list[dict[str, Any]],
                    mode: str) -> list[dict[str, Any]]:
    # 当前这轮的 user 消息已经落库；从历史里去掉它，避免同一句话在 prompt 里出现两次
    history = db.recent_messages(conv_id, 21)
    if history and history[-1]["role"] == "user":
        history = history[:-1]
    if mode == "kb":
        query_text = user_content if isinstance(user_content, str) else ""
        hits = chunker.search(query_text, chunker.TOP_K) if query_text else []
        if hits:
            refs = "\n\n".join(
                f"【资料{i + 1}】（来源：{h['fileName']}）\n{h['text']}"
                for i, h in enumerate(hits))
            system = KB_SYSTEM_TEMPLATE.format(refs=refs)
        else:
            system = KB_SYSTEM_EMPTY
    else:
        system = PLAIN_SYSTEM
    return [{"role": "system", "content": system}, *history,
            {"role": "user", "content": user_content}]


def _auto_title(conv_row: Any, message: str, attachments: list[ChatAttachment]) -> None:
    """首条消息自动命名会话，避免侧边栏一排「新对话」。"""
    title = (conv_row["title"] or "").strip()
    if title and title != "新对话":
        return
    src = (message or "").strip()
    if not src and attachments:
        src = attachments[0].name
    if not src:
        return
    src = re.sub(r"\s+", " ", src).strip()
    if not src:
        return
    db.update_conversation(conv_row["id"], title=src[:24])


@router.post("/chat")
async def chat(body: ChatReq) -> StreamingResponse:
    conv_row = _get_conv_or_404(body.conversationId)
    s = _current_settings()
    if not s["api_key"]:
        raise HTTPException(400, "未配置 API Key，请先在设置中填写")
    model = body.model or s["model"]
    depth = body.depth or s["depth"]
    if depth not in config.DEPTHS:
        raise HTTPException(400, f"depth 仅支持 {'、'.join(config.DEPTHS)}")
    mode = _resolve_mode(conv_row, body)
    if mode == "chat" and not body.message and not body.attachments:
        raise HTTPException(400, "请输入消息或添加附件")

    # 落库内容：文本附件全文注入；图片仅存占位符（图片本体只随本次上游请求发送）
    persisted = _compose_user_content(body.message, body.attachments) if mode == "chat" \
        else body.message
    display_text = body.displayMessage if body.displayMessage is not None else body.message
    metadata = _attachment_metadata(body.attachments) if mode == "chat" else []
    meta_json = json.dumps(metadata, ensure_ascii=False) if metadata else None

    # 原位重试/重新生成：末尾已是同一句 user 消息时不重复插入
    last = db.last_message(body.conversationId)
    if not (last and last["role"] == "user" and last["content"] == persisted):
        db.add_message(body.conversationId, "user", persisted,
                       display_content=display_text, attachments=meta_json)
    _auto_title(conv_row, body.message, body.attachments)

    # 上游内容：聊天模式图片 → 视觉 content 数组；知识库模式 → 纯文本
    user_upstream = _build_user_upstream_content(body.message, body.attachments, mode) \
        if mode == "chat" else (body.message or "请回答。")
    upstream_messages = _build_messages(body.conversationId, user_upstream, mode)

    async def gen():
        content_parts: list[str] = []
        reasoning_parts: list[str] = []
        prompt_tokens = completion_tokens = 0
        cache_hit: int | None = None
        cache_miss: int | None = None
        start = time.monotonic()
        finalized = False  # 落库幂等标记：正常/异常/断连三路径只落库一次

        def _persist() -> int:
            return _persist_assistant(
                body.conversationId, "".join(content_parts),
                "".join(reasoning_parts), prompt_tokens, completion_tokens,
                int((time.monotonic() - start) * 1000), cache_hit, cache_miss)

        try:
            async for kind, payload in llm.stream_chat(
                    s["base_url"], s["api_key"], model, upstream_messages, depth):
                if kind == "retry":
                    yield _sse({"type": "retry", "attempt": int(payload)})
                elif kind == "reasoning":
                    reasoning_parts.append(str(payload))
                    yield _sse({"type": "reasoning", "delta": payload})
                elif kind == "content":
                    content_parts.append(str(payload))
                    yield _sse({"type": "content", "delta": payload})
                elif kind == "usage":
                    (prompt_tokens, completion_tokens, total,
                     cache_hit, cache_miss) = _usage_breakdown(payload)
                    db.add_usage(total)
                    yield _sse({"type": "usage", "promptTokens": prompt_tokens,
                                "completionTokens": completion_tokens,
                                "totalTokens": total,
                                "cacheHitTokens": cache_hit,
                                "cacheMissTokens": cache_miss,
                                "cacheKnown": cache_hit is not None})
            # —— 正常结束：落库 + done（附带会话累计，供末尾汇总卡直接使用） ——
            message_id = _persist()
            finalized = True
            conv_usage = db.conversation_usage(body.conversationId)
            yield _sse({"type": "done", "messageId": message_id,
                        "elapsedMs": int((time.monotonic() - start) * 1000),
                        "usage": {"promptTokens": prompt_tokens,
                                  "completionTokens": completion_tokens,
                                  "totalTokens": prompt_tokens + completion_tokens,
                                  "cacheHitTokens": cache_hit,
                                  "cacheMissTokens": cache_miss,
                                  "cacheKnown": cache_hit is not None},
                        "conversation": conv_usage,
                        "contextTokens": db.context_tokens(body.conversationId)})
            yield "data: [DONE]\n\n"
        except Exception as exc:  # 上游失败：发 error 事件，已生成部分落库
            if not finalized and (content_parts or reasoning_parts):
                _persist()
                finalized = True
            yield _sse({"type": "error", "message": str(exc)[:500],
                        "conversation": db.conversation_usage(body.conversationId)})
            yield "data: [DONE]\n\n"
        finally:
            # 客户端断连（GeneratorExit/CancelledError）兜底：已生成部分落库一次
            if not finalized and (content_parts or reasoning_parts):
                _persist()
                finalized = True

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


def _persist_assistant(conv_id: int, content: str, reasoning: str,
                       prompt_tokens: int, completion_tokens: int,
                       elapsed_ms: int,
                       cache_hit_tokens: int | None = None,
                       cache_miss_tokens: int | None = None) -> int:
    return db.add_message(conv_id, "assistant", content, reasoning or None,
                          prompt_tokens, completion_tokens, elapsed_ms,
                          cache_hit_tokens=cache_hit_tokens,
                          cache_miss_tokens=cache_miss_tokens)


# ---------- #19/#20 export / import ----------
@router.get("/export")
def export_data() -> StreamingResponse:
    data = db.export_all()
    convs = data["conversations"]
    msg_by_conv: dict[int, list[dict[str, Any]]] = {}
    for m in data["messages"]:
        msg_by_conv.setdefault(m["conv_id"], []).append(m)
    for c in convs:
        c["messages"] = msg_by_conv.get(c["id"], [])
    payload = {
        "version": EXPORT_VERSION,
        "exportedAt": db.now(),
        "folders": data["folders"],
        "files": data["files"],
        "chunks": data["chunks"],
        "conversations": convs,
        "settings": data["settings"],
    }
    body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
    stamp = hashlib.sha1(body).hexdigest()[:8]

    return Response(
        content=body,
        media_type="application/json",
        headers={"Content-Disposition":
                 f'attachment; filename="kbchat-export-{stamp}.json"'},
    )


@router.post("/import")
async def import_data(file: UploadFile = File(...)) -> dict[str, int]:
    raw = await file.read()
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(400, f"导入文件不是合法 JSON：{exc}") from exc
    if not isinstance(data, dict) or "version" not in data:
        raise HTTPException(400, '导入文件缺少 version 字段')
    if data["version"] != EXPORT_VERSION:
        raise HTTPException(400, f"不支持的导出版本：{data['version']}（当前支持 {EXPORT_VERSION}）")

    folder_map: dict[int, int] = {}
    file_map: dict[int, int] = {}
    conv_map: dict[int, int] = {}

    for f in data.get("folders", []):
        new_parent = folder_map.get(f.get("parent_id"))
        # 父目录可能尚未导入（乱序），先全部按原 parent 导入，再二次修正
        new_id = db.create_folder(f["name"], new_parent)
        folder_map[f["id"]] = new_id
    for f in data.get("folders", []):
        if f.get("parent_id") is not None and f["parent_id"] in folder_map:
            db.move_folder(folder_map[f["id"]], folder_map[f["parent_id"]])

    chunk_rows_by_file: dict[int, list[dict[str, Any]]] = {}
    for c in data.get("chunks", []):
        chunk_rows_by_file.setdefault(c["file_id"], []).append(c)
    for f in data.get("files", []):
        new_fid = db.create_file(
            folder_map.get(f.get("folder_id")), f["name"], f["ext"], f["size"],
            f["path"], f.get("content", ""), f.get("chunk_count", 0),
            f.get("tokens") or None)
        file_map[f["id"]] = new_fid
        pieces = [c["text"] for c in sorted(
            chunk_rows_by_file.get(f["id"], []), key=lambda x: x["seq"])]
        if pieces:
            db.add_chunks(new_fid, folder_map.get(f.get("folder_id")), pieces)

    for c in data.get("conversations", []):
        new_cid = db.create_conversation(c["title"], c.get("mode") or "chat")
        conv_map[c["id"]] = new_cid
        if c.get("pinned"):
            db.update_conversation(new_cid, pinned=True)
        for m in c.get("messages", []):
            attachments = m.get("attachments")
            if isinstance(attachments, list):
                attachments = json.dumps(attachments, ensure_ascii=False)
            db.add_message(new_cid, m["role"], m["content"], m.get("reasoning"),
                           m.get("prompt_tokens", 0), m.get("completion_tokens", 0),
                           m.get("elapsed_ms", 0),
                           display_content=m.get("display_content"),
                           attachments=attachments,
                           cache_hit_tokens=m.get("cache_hit_tokens"),
                           cache_miss_tokens=m.get("cache_miss_tokens"))

    for u in data.get("usage_daily", []):
        with db._lock:
            cur = db.conn().execute(
                "INSERT INTO usage_daily(date,tokens) VALUES(?,?) "
                "ON CONFLICT(date) DO UPDATE SET tokens=tokens+excluded.tokens",
                (u["date"], u["tokens"]))
            db.conn().commit()

    imported_settings = {k: v for k, v in data.get("settings", {}).items()
                         if k != "api_key"}
    if imported_settings:
        db.save_settings(imported_settings)

    # 全量重建内存索引
    rows = db.query(
        "SELECT c.id, c.file_id, c.text, f.name AS file_name "
        "FROM chunks c JOIN files f ON f.id=c.file_id ORDER BY c.id")
    chunker.rebuild([{"id": r["id"], "file_id": r["file_id"],
                      "file_name": r["file_name"], "text": r["text"]} for r in rows])

    return {"folders": len(folder_map), "files": len(file_map),
            "conversations": len(conv_map)}


# ---------- #21 models ----------
@router.get("/models")
def models() -> dict[str, list[str]]:
    return {"models": config.MODELS}
