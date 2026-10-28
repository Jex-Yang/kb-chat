"""会话压缩（compaction）：把较早的对话摘要成一条检查点，保留近期原文。

实现参考 DeepSeek Harness 的 `@deepseek-ai/dsh-compaction-basic`：

- 压力阈值 `floor(min(W × 0.8, W − O − 65536))`，W 为上下文窗口（设置里的 quota），
  O 为输出预留（这里取 8192），余量 B 为 65536。
- 近期尾部按 `(W − O) × 0.16` 逐字保留；手动压缩（/compact）保留最后一轮，其余全部摘要。
- 摘要调用复用会话自身的 system prompt 与原消息前缀，最后追加一条固定的压缩指令，
  这样上游的 KV cache 能命中前缀；只有摘要输出落库。
- 摘要以 `<compacted-summary>` 标签框定，作为一条 user 检查点消息回放给模型。
  新一次压缩会把旧检查点一起合并，始终只保留最新一条。
- 原始消息一条都不删：界面、搜索、导出、版本切换仍看到完整历史，
  只有发给上游的 prompt 从压缩点之后开始。
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any

from . import db, llm, tokens

logger = logging.getLogger("kbchat.compaction")
_LEGACY_ATTACHMENT_RE = re.compile(
    r"【附件：([^】\n]+)】\n```\n(.*?)\n```", re.S)

# ---------- 与 DSH compaction-basic 对齐的默认策略 ----------
THRESHOLD_RATIO = 0.8
HEADROOM_TOKENS = 65_536
OUTPUT_RESERVE_TOKENS = 8_192
RETAIN_RATIO = 0.16
SUMMARY_MAX_TOKENS = 8_192
DEFAULT_IMAGE_TOKENS = 255
COMPACTION_RETRIES = 1
MESSAGE_OVERHEAD = 4
MIN_PREFIX_MESSAGES = 2

SUMMARY_OPEN_TAG = "<compacted-summary>"
SUMMARY_CLOSE_TAG = "</compacted-summary>"

# 与 DSH 相同的检查点前导（模型看到的“这是背景，不要复述”框架）
CHECKPOINT_PREAMBLE = (
    "This is an automatically generated checkpoint condensing an earlier span of "
    "the conversation to free up context. Treat the captured context as established "
    "background and build on it without restating it. Continue the task directly from "
    "the messages that follow, without acknowledging this checkpoint."
)

# 压缩指令：DSH 原文，仅把 “AI coding assistant” 改为 “AI assistant”，
# 并补一条“用对话本身的语言写摘要”，其余结构与措辞保持一致。
COMPACTION_INSTRUCTION = "\n".join([
    "You are now acting as a compaction engine for this AI assistant. Condense the "
    "conversation ABOVE into a structured checkpoint that lets another model resume "
    "the work with no loss of essential context.",
    "",
    "Output EXACTLY the Markdown structure below: keep every section, in order. Use "
    "terse bullets, not prose paragraphs. Write \"(none)\" for an empty section — "
    "never drop a section.",
    "",
    "## Primary Request and Intent",
    "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
    "",
    "## Key Technical Concepts",
    "- [technologies, frameworks, patterns, and conventions in play]",
    "",
    "## Files and Code",
    "- [exact path: why it matters, key changes or snippets]",
    "",
    "## Errors and Fixes",
    "- [error: how it was resolved, plus any related user feedback]",
    "",
    "## Pending Jobs",
    "- [explicitly requested work not yet completed]",
    "",
    "## Current Work",
    "- [precisely what was in progress at this checkpoint]",
    "",
    "## Next Step",
    "- [the single next action, directly in line with the most recent request, or \"(none)\"]",
    "",
    "## Critical Context",
    "- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]",
    "",
    "Rules:",
    "- Write concise engineering prose. Preserve exact file paths, commands, error strings, "
    "identifiers, numeric values, function signatures, and syntax fragments.",
    "- Capture user feedback and explicit instructions faithfully, especially corrections.",
    "- Write the checkpoint in the dominant language of the conversation (use Chinese for a "
    "Chinese conversation).",
    "- Do NOT mention this summarization request or that the context was compacted.",
    "- Output only the checkpoint text: do not call any tool or take any other action.",
    f"- If the conversation already contains a {SUMMARY_OPEN_TAG} block, it is a PRIOR "
    "checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale "
    "ones, and merge newer information into a single consolidated summary under the same "
    "structure.",
])

_locks: dict[int, asyncio.Lock] = {}


class CompactionError(Exception):
    """可展示给用户的压缩失败（历史不足、摘要为空、上游不可用等）。"""


def _lock_for(conv_id: int) -> asyncio.Lock:
    lock = _locks.get(int(conv_id))
    if lock is None:
        lock = asyncio.Lock()
        _locks[int(conv_id)] = lock
    return lock


# ---------- 预算 ----------
def _window(quota: int | str | None) -> int:
    try:
        return max(int(quota or 0), 1)
    except (TypeError, ValueError):
        return 1


def _reserves(window: int) -> tuple[int, int]:
    """输出预留与压力余量；小窗口按比例缩小，避免 65K 余量吞掉整个窗口。"""
    output = (OUTPUT_RESERVE_TOKENS if window > OUTPUT_RESERVE_TOKENS
              else max(1, int(window * 0.5)))
    headroom = (HEADROOM_TOKENS
                if window - output - HEADROOM_TOKENS > 0
                else max(0, int(window * 0.2)))
    return output, headroom


def threshold_tokens(quota: int | str | None) -> int:
    """触发自动压缩的 token 压力阈值。

    默认 `floor(min(W × 0.8, W − O − 65536))`（与 DSH 一致）；小窗口装不下固定
    余量时按比例缩小 O/B，并把阈值夹在 `W × 0.5` 与 `W × 0.8` 之间，避免
    过早/过晚触发或每轮重复压缩。
    """
    window = _window(quota)
    output, headroom = _reserves(window)
    hard = window - output - headroom
    return max(1, min(int(window * THRESHOLD_RATIO), max(hard, int(window * 0.5))))


def retain_tokens(quota: int | str | None) -> int:
    """自动压缩后逐字保留的近期历史预算（默认 `(W − O) × 0.16`）。"""
    window = _window(quota)
    output, _ = _reserves(window)
    if window <= OUTPUT_RESERVE_TOKENS * 2:
        # 窗口和输出预留同量级时，按窗口 20% 保留，避免只剩最后一轮
        retain = max(1, int(window * 0.2))
    else:
        retain = max(0, int((window - output) * RETAIN_RATIO))
    # 必须明显低于触发阈值，否则压缩完仍然超阈值，会每轮重复压缩
    return min(retain, max(1, int(threshold_tokens(quota) * 0.6)))


def policy(quota: int | str | None) -> dict[str, int]:
    output, headroom = _reserves(_window(quota))
    return {
        "thresholdTokens": threshold_tokens(quota),
        "retainTokens": retain_tokens(quota),
        "headroomTokens": headroom,
        "outputReserveTokens": output,
    }


# ---------- 计量 ----------
def content_text(content: Any) -> str:
    """把 OpenAI 兼容的 content（字符串或分段数组）压成可分词文本。"""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if not isinstance(part, dict):
                continue
            if isinstance(part.get("text"), str):
                parts.append(part["text"])
            elif part.get("type") == "image_url":
                parts.append("[image]")
        return "\n".join(parts)
    return "" if content is None else str(content)


def content_tokens(content: Any) -> int:
    return tokens.count(content_text(content))


def message_tokens(row: Any) -> int:
    cached = 0
    try:
        cached = int(row["content_tokens"] or 0)
    except (IndexError, KeyError):
        cached = 0
    if cached <= 0:
        cached = tokens.count(row["content"] or "")
    return cached + MESSAGE_OVERHEAD


def attachment_text_tokens(row: Any) -> int:
    """消息里上传的文本附件所占 token（用于把「文本提示词」单独归类）。"""
    content = row["content"] or ""
    total = 0
    try:
        raw = row["attachments"]
    except (IndexError, KeyError):
        raw = None
    if raw:
        try:
            items = json.loads(raw) if isinstance(raw, str) else raw
        except (TypeError, ValueError):
            items = []
        if isinstance(items, list):
            for item in items:
                if not isinstance(item, dict):
                    continue
                if (item.get("kind") or "text") != "text":
                    continue
                total += int(item.get("tokens") or 0)
    if total <= 0:
        # 旧消息没有附件元数据：从落库的 ``` 正文里补算文本附件
        total = sum(tokens.count(body) for _name, body
                    in _LEGACY_ATTACHMENT_RE.findall(content))
    return max(0, total)


def attachment_image_tokens(row: Any) -> int:
    """当前用户消息里图片所占的视觉 token（按前端尺寸估算）。"""
    try:
        raw = row["attachments"]
    except (IndexError, KeyError):
        raw = None
    if not raw:
        return 0
    try:
        items = json.loads(raw) if isinstance(raw, str) else raw
    except (TypeError, ValueError):
        return 0
    if not isinstance(items, list):
        return 0
    total = 0
    for item in items:
        if not isinstance(item, dict):
            continue
        if (item.get("kind") or "text") != "image":
            continue
        total += int(item.get("tokens") or 0) or DEFAULT_IMAGE_TOKENS
    return max(0, total)


def checkpoint_text(summary: str) -> str:
    return f"{CHECKPOINT_PREAMBLE}\n\n{SUMMARY_OPEN_TAG}\n{summary.strip()}\n{SUMMARY_CLOSE_TAG}"


def compaction_dict(row: Any) -> dict[str, Any]:
    return {
        "id": int(row["id"]),
        "summary": row["summary"],
        "summaryTokens": int(row["summary_tokens"] or 0),
        "shadowedCount": int(row["shadowed_count"] or 0),
        "shadowedTokens": int(row["shadowed_tokens"] or 0),
        "startMessageId": int(row["start_message_id"]),
        "endMessageId": int(row["end_message_id"]),
        "model": row["model"],
        "source": row["source"],
        "createdAt": row["created_at"],
    }


def latest(conv_id: int) -> dict[str, Any] | None:
    row = db.latest_compaction(conv_id)
    return compaction_dict(row) if row else None


def estimate_prompt_tokens(conv_id: int, system: str,
                           exclude_message_id: int | None = None,
                           extra_content: Any = None) -> int:
    """估算下一轮请求的 prompt token（未压缩前的历史 + 检查点 + 本轮输入）。"""
    rows = db.context_messages(conv_id)
    if exclude_message_id is not None:
        rows = [r for r in rows if int(r["id"]) != int(exclude_message_id)]
    total = tokens.count(system or "") + 4
    prior = db.latest_compaction(conv_id)
    if prior:
        total += int(prior["summary_tokens"] or 0) + MESSAGE_OVERHEAD
    total += sum(message_tokens(r) for r in rows)
    last_user = next((r for r in reversed(rows) if r["role"] == "user"), None)
    if last_user is not None:
        total += attachment_image_tokens(last_user)
    if extra_content is not None:
        total += content_tokens(extra_content) + MESSAGE_OVERHEAD
    return total


def context_breakdown(conv_id: int, system: str) -> dict[str, int]:
    """上下文构成：系统提示词 / 文本提示词 / 图片 / 对话消息（含压缩检查点）。

    「文本提示词」= 上传并注入上下文的文本附件全文；图片按当前用户消息的
    视觉 token 估算单独计数；用户文字与助手回复计入「对话消息」。
    """
    rows = db.context_messages(conv_id)
    text_tokens = 0
    message_tokens_total = 0
    for row in rows:
        total = message_tokens(row)
        attach = min(max(total - MESSAGE_OVERHEAD, 0), attachment_text_tokens(row))
        text_tokens += attach
        message_tokens_total += total - attach
    prior = db.latest_compaction(conv_id)
    if prior:
        message_tokens_total += int(prior["summary_tokens"] or 0) + MESSAGE_OVERHEAD
    last_user = next((r for r in reversed(rows) if r["role"] == "user"), None)
    image_tokens = attachment_image_tokens(last_user) if last_user is not None else 0
    system_tokens = tokens.count(system or "") + 4
    return {
        "systemTokens": system_tokens,
        "textTokens": text_tokens,
        "imageTokens": image_tokens,
        "messageTokens": message_tokens_total,
        "estimatedTokens": system_tokens + text_tokens + image_tokens + message_tokens_total,
        "compactedTokens": int(prior["shadowed_tokens"] or 0) if prior else 0,
    }


# ---------- 选区 ----------
def _select_end(rows: list[Any], retain: int) -> int | None:
    """返回可被摘要的最早区间末下标（区间固定从 0 开始，避免漏掉消息）。

    从后往前累计 token，达到保留预算后把保留起点对齐到一条 user 消息，
    保证近期尾部从完整轮次开始；压缩区间结束于一条 assistant 消息。
    """
    if len(rows) < MIN_PREFIX_MESSAGES:
        return None
    accumulated = 0
    keep_from = len(rows)
    for index in range(len(rows) - 1, -1, -1):
        accumulated += message_tokens(rows[index])
        keep_from = index
        if retain <= 0 or accumulated >= retain:
            break
    while keep_from > 0 and rows[keep_from]["role"] != "user":
        keep_from -= 1
    end = keep_from - 1
    while end >= 0 and rows[end]["role"] != "assistant":
        end -= 1
    if end < 1:
        return None
    if not any(rows[i]["role"] == "user" for i in range(0, end + 1)):
        return None
    return end


# ---------- 摘要 ----------
async def _summarize(settings: dict[str, Any], model: str, system: str,
                     prior: Any, shadowed: list[Any]) -> str:
    messages: list[dict[str, str]] = [{"role": "system", "content": system or ""}]
    if prior is not None:
        messages.append({"role": "user", "content": checkpoint_text(prior["summary"])})
    messages.extend({"role": r["role"], "content": r["content"] or ""} for r in shadowed)
    messages.append({"role": "user", "content": COMPACTION_INSTRUCTION})

    parts: list[str] = []
    finish: str | None = None
    try:
        async for kind, payload in llm.stream_chat(
                settings["base_url"], settings["api_key"], model, messages,
                depth="none", max_tokens=SUMMARY_MAX_TOKENS, max_retries=2):
            if kind == "content":
                parts.append(str(payload))
            elif kind == "finish":
                finish = str(payload)
    except Exception as exc:  # 上游 4xx/5xx/断网
        raise CompactionError(f"摘要请求失败：{exc}") from exc

    summary = "".join(parts).strip()
    if not summary:
        raise CompactionError("模型没有返回摘要内容")
    if finish == "length":
        raise CompactionError("摘要达到输出上限被截断，已放弃本次压缩")
    return summary


# ---------- 压缩主流程 ----------
async def compact(conv_id: int, settings: dict[str, Any], *, system: str,
                  mode: str = "chat", force: bool = False,
                  reason: str = "auto", retain: int | None = None,
                  exclude_message_id: int | None = None,
                  extra_content: Any = None,
                  model: str | None = None) -> dict[str, Any] | None:
    """压缩一次；没有可安全压缩的历史时返回 None。

    force=True 用于手动 /compact 或上下文溢出恢复：跳过压力阈值，
    并把近期保留预算降到最后一轮（手动）或 0（溢出恢复只保留最后一个完整轮次）。
    extra_content 是尚未落库的本轮输入（用于压力估算）。
    """
    async with _lock_for(conv_id):
        quota = int(settings.get("quota") or 0)
        rows = db.context_messages(conv_id)
        if exclude_message_id is not None:
            rows = [r for r in rows if int(r["id"]) != int(exclude_message_id)]
        if len(rows) < MIN_PREFIX_MESSAGES:
            return None

        if not force:
            if quota <= 0:  # 未配置上下文窗口时不自动压缩
                return None
            estimate = estimate_prompt_tokens(
                conv_id, system, exclude_message_id=exclude_message_id,
                extra_content=extra_content)
            if estimate < threshold_tokens(quota):
                return None

        retain_budget = retain if retain is not None else (
            0 if force else retain_tokens(quota))
        end = _select_end(rows, retain_budget)
        if end is None:
            return None
        shadowed = rows[: end + 1]

        prior = db.latest_compaction(conv_id)
        summary = await _summarize(settings, model or settings["model"], system,
                                   prior, shadowed)
        framed = checkpoint_text(summary)
        framed_tokens = tokens.count(framed)
        new_tokens = sum(message_tokens(r) for r in shadowed)
        prior_tokens = int(prior["shadowed_tokens"] or 0) if prior else 0
        # 新摘要替换的是「旧检查点 + 本次被遮蔽的消息」，必须比这两者更短。
        replaced_tokens = new_tokens + (int(prior["summary_tokens"] or 0) if prior else 0)
        if framed_tokens >= replaced_tokens:
            raise CompactionError("摘要没有比原文更短，已放弃本次压缩")

        # 摘要生成期间历史可能被编辑/删除：确认选区仍然存在再落库
        latest_now = db.latest_compaction(conv_id)
        if (int(latest_now["id"]) if latest_now else 0) != (int(prior["id"]) if prior else 0):
            raise CompactionError("压缩期间上下文已变化，已放弃本次压缩")
        current_ids = {int(r["id"]) for r in db.context_messages(conv_id)}
        if any(int(r["id"]) not in current_ids for r in shadowed):
            raise CompactionError("压缩期间消息已被修改，已放弃本次压缩")

        prior_count = int(prior["shadowed_count"] or 0) if prior else 0
        start_message_id = (int(prior["start_message_id"]) if prior
                            else int(shadowed[0]["id"]))
        row = db.add_compaction(
            conv_id=conv_id,
            summary=summary,
            start_message_id=start_message_id,
            end_message_id=int(shadowed[-1]["id"]),
            shadowed_count=prior_count + len(shadowed),
            shadowed_tokens=prior_tokens + new_tokens,
            summary_tokens=framed_tokens,
            model=model or settings["model"],
            source=reason,
        )
        logger.info("compaction[%s] conv=%s shadowed=%s tokens=%s summary=%s",
                    reason, conv_id, len(shadowed), new_tokens, framed_tokens)
        return compaction_dict(row)


async def auto_compact(conv_id: int, settings: dict[str, Any], *, system: str,
                       mode: str = "chat", exclude_message_id: int | None = None,
                       extra_content: Any = None,
                       model: str | None = None) -> dict[str, Any] | None:
    """压力触发：必要时压缩，并最多再收敛一次（对应 DSH compactionRetries=1）。"""
    result: dict[str, Any] | None = None
    quota = int(settings.get("quota") or 0)
    if quota <= 0:
        return None
    for _ in range(COMPACTION_RETRIES + 1):
        estimate = estimate_prompt_tokens(
            conv_id, system, exclude_message_id=exclude_message_id,
            extra_content=extra_content)
        if estimate < threshold_tokens(quota):
            break
        step = await compact(conv_id, settings, system=system, mode=mode,
                             reason="auto", exclude_message_id=exclude_message_id,
                             extra_content=extra_content, model=model)
        if step is None:
            break
        result = step
    return result


async def compact_now(conv_id: int, settings: dict[str, Any], *, system: str,
                      mode: str = "chat", reason: str = "manual",
                      exclude_message_id: int | None = None,
                      model: str | None = None) -> dict[str, Any] | None:
    """手动 /compact：压到只剩最后一轮，跳过压力阈值。"""
    return await compact(conv_id, settings, system=system, mode=mode,
                         force=True, reason=reason, retain=0,
                         exclude_message_id=exclude_message_id, model=model)


def is_context_overflow(error: BaseException | str) -> bool:
    """识别上游确认的上下文窗口溢出（用于压缩后重试一次）。"""
    text = str(error).lower()
    needles = (
        "context length", "context_length_exceeded", "maximum context",
        "context window", "too many tokens", "reduce the length",
        "prompt is too long", "输入过长", "上下文长度", "超过最大",
    )
    return any(n in text for n in needles)
