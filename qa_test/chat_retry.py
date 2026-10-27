"""KBChat 真实上游对话专项重试脚本（429 退避后重试）。"""
from __future__ import annotations

import json
import time
import uuid

import httpx

BASE = "http://127.0.0.1:8321"
client = httpx.Client(base_url=BASE, trust_env=False, timeout=httpx.Timeout(600, connect=10))

RUN = uuid.uuid4().hex[:6]
FOLDER_NAME = f"QA-CHAT-目录-{RUN}"
FILE_NAME = f"qa-chat-{RUN}.txt"
MARKER = f"QA-CHAT-MARKER-{RUN}"
OWNER = "张三丰"
CODE = "QA42"
CONV_TITLE = f"QA-CHAT-对话-{RUN}"

out: dict = {}


def parse_sse(resp: httpx.Response):
    events, raw = [], ""
    for line in resp.iter_lines():
        if line.startswith("data: "):
            payload = line[len("data: "):]
            raw += line + "\n"
            if payload.strip() == "[DONE]":
                events.append({"type": "[DONE]"})
            else:
                try:
                    events.append(json.loads(payload))
                except json.JSONDecodeError:
                    events.append({"type": "PARSE_ERR", "raw": payload})
    return events, raw


# 建测试数据
fid = client.post("/api/folders", json={"name": FOLDER_NAME, "parentId": None}).json()["id"]
content = (f"KBQA 青鸾计划密档（{MARKER}）\n项目代号：青鸾计划\n负责人：{OWNER}\n"
           f"秘密代码：{CODE}\n本文件由 QA 专项测试生成。\n" * 8)
up = client.post("/api/files/upload", files={"file": (FILE_NAME, content.encode(), "text/plain")},
                 data={"folderId": str(fid)}).json()
file_id = up["id"]
conv_id = client.post("/api/conversations", json={"title": CONV_TITLE}).json()["id"]
out["setup"] = {"folderId": fid, "fileId": file_id, "convId": conv_id, "chunkCount": up["chunkCount"]}
print("setup:", out["setup"])

MAX_ROUNDS = 6
WAIT = 45  # 每轮失败后等待秒数


def run_chat(depth: str, message: str) -> tuple[list, str]:
    resp = client.post("/api/chat", json={"conversationId": conv_id, "message": message,
                                          "useKb": True, "depth": depth})
    return parse_sse(resp)


# ---- 第 1 轮：depth=high ----
for attempt in range(1, MAX_ROUNDS + 1):
    u_before = client.get("/api/usage").json()["used"]
    events, raw = run_chat("high", "请仅依据知识库资料回答：青鸾计划的负责人是谁？秘密代码是多少？")
    types = [e.get("type") for e in events]
    err = next((e for e in events if e.get("type") == "error"), None)
    if err and "429" in err.get("message", ""):
        print(f"round high attempt {attempt}: 429 限流（retry 事件已出现），{WAIT}s 后重试")
        time.sleep(WAIT)
        continue
    usage_ev = next((e for e in events if e.get("type") == "usage"), None)
    content_text = "".join(e.get("delta", "") for e in events if e.get("type") == "content")
    used_after = client.get("/api/usage").json()["used"]
    out["high"] = {
        "attempt": attempt,
        "types": sorted(set(t for t in types if t)),
        "order_ok": types and types[-1] == "[DONE]" and "done" in types
                    and "reasoning" in types and "content" in types and usage_ev is not None,
        "usageDelta": used_after - u_before,
        "totalTokens": usage_ev and usage_ev["totalTokens"],
        "usageMatch": usage_ev is not None and used_after - u_before == usage_ev["totalTokens"],
        "answerHead": content_text[:300],
        "hitOwner": OWNER in content_text,
        "hitCode": CODE in content_text,
        "rawTail": raw[-200:],
    }
    detail = client.get(f"/api/conversations/{conv_id}").json()["messages"]
    asst = [m for m in detail if m["role"] == "assistant"]
    out["high"]["persisted"] = bool(asst) and asst[-1]["completionTokens"] == (usage_ev or {}).get("completionTokens")
    out["high"]["reasoningLen"] = len(asst[-1]["reasoning"] or "") if asst else -1
    break
else:
    out["high"] = {"failed": "连续 6 轮上游 429"}

# ---- 第 2 轮：depth=none ----
for attempt in range(1, MAX_ROUNDS + 1):
    u_before = client.get("/api/usage").json()["used"]
    events, raw = run_chat("none", f"知识库文件 {FILE_NAME} 中的标记词 {MARKER} 代表什么？一句话回答。")
    types = [e.get("type") for e in events]
    err = next((e for e in events if e.get("type") == "error"), None)
    if err and "429" in err.get("message", ""):
        print(f"round none attempt {attempt}: 429 限流，{WAIT}s 后重试")
        time.sleep(WAIT)
        continue
    usage_ev2 = next((e for e in events if e.get("type") == "usage"), None)
    content2 = "".join(e.get("delta", "") for e in events if e.get("type") == "content")
    used_after = client.get("/api/usage").json()["used"]
    out["none"] = {
        "attempt": attempt,
        "types": sorted(set(t for t in types if t)),
        "no_reasoning": "reasoning" not in types,
        "usageDelta": used_after - u_before,
        "totalTokens": usage_ev2 and usage_ev2["totalTokens"],
        "usageMatch": usage_ev2 is not None and used_after - u_before == usage_ev2["totalTokens"],
        "answerHead": content2[:300],
        "hitMarker": MARKER in content2 or MARKER[:12] in content2,
    }
    break
else:
    out["none"] = {"failed": "连续 6 轮上游 429"}

# ---- 清理 ----
client.delete(f"/api/conversations/{conv_id}")
client.delete(f"/api/folders/{fid}")
residue = (any(f["name"].startswith("QA-CHAT-") for f in client.get("/api/tree").json()["folders"] + client.get("/api/tree").json()["files"]),
           any(c["title"].startswith("QA-CHAT-") for c in client.get("/api/conversations").json()))
out["cleanup"] = {"residue": residue}
print("cleanup:", out["cleanup"])
with open("/tmp/qa_chat_retry.json", "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
print(json.dumps(out, ensure_ascii=False, indent=2))
