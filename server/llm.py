"""KBChat 上游 LLM 流式客户端（OpenAI 兼容 /chat/completions）。

- httpx.AsyncClient 流式 POST，stream:true + stream_options.include_usage:true
- 429/5xx/超时：指数退避重试 3 次（1s/2s/4s + 随机抖动 ≤0.5s），重试前 yield ("retry", attempt)
- 400 且报文含 reasoning/thinking：去除 reasoning_effort 后重试一次
- 逐行解析 SSE，yield ("reasoning", s) / ("content", s) / ("usage", dict)
"""
from __future__ import annotations

import asyncio
import json
import random
from collections.abc import AsyncGenerator
from typing import Any

import httpx

DEFAULT_TIMEOUT = httpx.Timeout(120.0, connect=15.0)
BACKOFF_STEPS = [1.0, 2.0, 4.0, 8.0, 10.0]  # 429/5xx 无限重试：退避逐步升至 10s 后封顶
BACKOFF_CAP = 10.0
JITTER_MAX = 1.0


async def stream_chat(
    base_url: str,
    api_key: str,
    model: str,
    messages: list[dict[str, Any]],
    depth: str = "high",
    max_tokens: int | None = None,
    max_retries: int | None = None,
) -> AsyncGenerator[tuple[str, Any], None]:
    """异步生成器：yield ("retry", n) | ("reasoning", str) | ("content", str)
    | ("usage", dict) | ("finish", reason)。

    429/5xx/超时/网络错误：默认无限重试直到成功（退避封顶 10s），每次尝试
    yield ("retry", attempt)；传入 max_retries 时最多重试该次数后抛错
    （压缩等后台辅助调用不希望永久挂起）。
    401/403/400（去参重试后仍失败）→ 抛 RuntimeError（message 可作为 SSE error 事件）。
    """
    url = f"{base_url.rstrip('/')}/chat/completions"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "stream": True,
        "stream_options": {"include_usage": True},
        "reasoning_effort": depth,
    }
    # DeepSeek / qnaigc：关闭思考要发 thinking.type=disabled；reasoning_effort 只控制
    # 强度（low/high/max），传 none 会被忽略，模型仍会输出 reasoning_content。
    if depth == "none":
        payload.pop("reasoning_effort", None)
        payload["thinking"] = {"type": "disabled"}
    if max_tokens is not None:
        payload["max_tokens"] = int(max_tokens)

    attempt = 0
    while True:
        try:
            async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
                async with client.stream("POST", url, headers=headers,
                                         json=payload) as resp:
                    if resp.status_code == 400:
                        body = (await resp.aread()).decode("utf-8", errors="replace")
                        lower = body.lower()
                        # 兼容不支持 thinking / reasoning_effort 的 OpenAI 兼容端点：
                        # 逐个去掉可选参数再试，避免因为一个字段直接失败。
                        if "thinking" in payload and (
                                "thinking" in lower or "reasoning" in lower):
                            payload.pop("thinking", None)
                            continue
                        if "reasoning_effort" in payload and (
                                "reasoning" in lower or "thinking" in lower):
                            payload.pop("reasoning_effort", None)
                            continue
                        raise RuntimeError(f"上游返回 400：{body[:300]}")
                    if resp.status_code == 429 or resp.status_code >= 500:
                        await resp.aread()
                        raise _RetryableError(f"上游返回 {resp.status_code}")
                    if resp.status_code != 200:
                        body = (await resp.aread()).decode("utf-8", errors="replace")
                        raise RuntimeError(f"上游返回 {resp.status_code}：{body[:300]}")

                    # —— 200，流式解析 ——
                    async for event in _iter_sse(resp):
                        yield event
                    return

        except _RetryableError as exc:
            attempt += 1
            if max_retries is not None and attempt > max_retries:
                raise RuntimeError(f"上游重试 {max_retries} 次仍失败：{exc}") from exc
            delay = min(BACKOFF_STEPS[min(attempt - 1, len(BACKOFF_STEPS) - 1)],
                        BACKOFF_CAP) + random.uniform(0, JITTER_MAX)
            yield ("retry", attempt)
            await asyncio.sleep(delay)
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            attempt += 1
            if max_retries is not None and attempt > max_retries:
                raise RuntimeError(f"上游重试 {max_retries} 次仍失败：{exc}") from exc
            delay = min(BACKOFF_STEPS[min(attempt - 1, len(BACKOFF_STEPS) - 1)],
                        BACKOFF_CAP) + random.uniform(0, JITTER_MAX)
            yield ("retry", attempt)
            await asyncio.sleep(delay)


class _RetryableError(Exception):
    """可重试的上游错误（429/5xx）。"""


async def _iter_sse(resp: httpx.Response) -> AsyncGenerator[tuple[str, Any], None]:
    """逐行解析 OpenAI 兼容 SSE：data: {...}。"""
    buffer = ""
    async for chunk in resp.aiter_text():
        buffer += chunk
        while "\n" in buffer:
            line, buffer = buffer.split("\n", 1)
            line = line.strip()
            if not line or line.startswith(":"):
                continue
            if not line.startswith("data:"):
                continue
            data = line[len("data:"):].strip()
            if data == "[DONE]":
                return
            try:
                obj = json.loads(data)
            except json.JSONDecodeError:
                continue
            if isinstance(obj.get("usage"), dict) and obj["usage"]:
                yield ("usage", obj["usage"])
            choices = obj.get("choices") or []
            if not choices:
                continue
            delta = choices[0].get("delta") or {}
            reasoning = delta.get("reasoning_content")
            if reasoning:
                yield ("reasoning", reasoning)
            content = delta.get("content")
            if content:
                yield ("content", content)
            finish = choices[0].get("finish_reason")
            if finish:
                yield ("finish", str(finish))
