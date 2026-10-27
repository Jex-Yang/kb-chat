"""KBChat QA 回归测试脚本（只读测试，不改源码；自建数据测完清理）。"""
from __future__ import annotations

import json
import re
import time
import uuid

import httpx

BASE = "http://127.0.0.1:8321"
client = httpx.Client(base_url=BASE, trust_env=False, timeout=httpx.Timeout(600, connect=10))

RUN = uuid.uuid4().hex[:6]
FOLDER_NAME = f"QA-TEST-目录-{RUN}"
FILE_NAME = f"qa-test-{RUN}.txt"
MARKER = f"QA-TEST-MARKER-{RUN}"
OWNER = "张三丰"
CODE = "QA42"
CONV_TITLE = f"QA-TEST-对话-{RUN}"
CONV_RENAMED = f"QA-TEST-对话-改名-{RUN}"

results: list[dict] = []


def record(cid: str, module: str, desc: str, ok: bool, evidence: str, blocked: bool = False):
    status = "BLOCKED" if blocked else ("PASS" if ok else "FAIL")
    results.append({"id": cid, "module": module, "desc": desc,
                    "status": status, "evidence": evidence})
    print(f"[{status}] {cid} {desc} | {evidence[:220]}")


def ev(resp=None, extra: str = "") -> str:
    s = ""
    if resp is not None:
        s = f"HTTP {resp.status_code} {resp.text[:300]}"
    return (s + (" | " + extra if extra else "")).strip()


# ---------- 环境预检：原数据快照（用于确认测后保留） ----------
pre = client.get("/api/tree").json()
pre_convs = client.get("/api/conversations").json()
PRE_FOLDERS = {f["id"] for f in pre["folders"]}
PRE_FILES = {f["id"] for f in pre["files"]}
PRE_CONVS = {c["id"] for c in pre_convs}
print(f"前置快照: folders={len(PRE_FOLDERS)} files={len(PRE_FILES)} convs={len(PRE_CONVS)}")


def parse_sse(resp: httpx.Response):
    events = []
    raw = ""
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


# ================= 1. 基础与设置 =================
r = client.get("/api/health")
record("TC-01", "健康检查", "GET /api/health 返回 {ok:true}",
       r.status_code == 200 and r.json() == {"ok": True}, ev(r))

r = client.get("/api/settings")
d = r.json()
need = {"baseUrl", "apiKeyMasked", "model", "quota", "depth", "models"}
record("TC-02", "设置读取", "GET /api/settings 契约字段齐全",
       r.status_code == 200 and need <= set(d), ev(r))

masked_before = d.get("apiKeyMasked")
r = client.put("/api/settings", json={"apiKey": ""})
d2 = r.json()
record("TC-03", "设置-错误路径", "PUT settings apiKey 留空不被清空",
       r.status_code == 200 and d2.get("apiKeyMasked") == masked_before,
       ev(r, f"before={masked_before} after={d2.get('apiKeyMasked')}"))

r = client.put("/api/settings", json={"depth": "ultra"})
record("TC-04", "设置-错误路径", "PUT settings depth 非法值 → 400",
       r.status_code == 400, ev(r))

r = client.get("/api/usage")
u = r.json()
ratio_ok = abs(u.get("ratio", -1) - round(u.get("used", 1) / max(u.get("quota", 1), 1), 4)) < 1e-9
record("TC-05", "用量", "GET /api/usage 字段齐全且 ratio=round(used/quota,4)",
       r.status_code == 200 and {"quota", "used", "remaining", "ratio"} <= set(u) and ratio_ok,
       ev(r))

r = client.get("/api/tree")
d = r.json()
record("TC-06", "目录树", "GET /api/tree 返回 folders/files 数组",
       r.status_code == 200 and isinstance(d.get("folders"), list) and isinstance(d.get("files"), list),
       ev(r))

# ================= 2. 目录 =================
r = client.post("/api/folders", json={"name": FOLDER_NAME, "parentId": None})
fid = r.json().get("id")
record("TC-07", "目录", "POST /api/folders 返回 {id} 且出现在 tree",
       r.status_code == 200 and isinstance(fid, int) and any(f["id"] == fid for f in client.get("/api/tree").json()["folders"]),
       ev(r, f"folderId={fid}"))

r = client.post("/api/folders", json={"name": "ghost", "parentId": 999999})
record("TC-08", "目录-错误路径", "POST /api/folders 父目录不存在 → 404",
       r.status_code == 404, ev(r))

r = client.put(f"/api/folders/{fid}", json={"name": FOLDER_NAME + "-R"})
renamed = any(f["name"] == FOLDER_NAME + "-R" for f in client.get("/api/tree").json()["folders"])
record("TC-09", "目录", "PUT /api/folders/{id} 重命名生效",
       r.status_code == 200 and r.json() == {"ok": True} and renamed, ev(r))

r = client.put(f"/api/folders/{fid}", json={"parentId": fid})
record("TC-10", "目录-错误路径", "PUT /api/folders/{id} 移动到自身 → 400",
       r.status_code == 400, ev(r))

# ================= 3. 文件 =================
content = (f"KBQA 青鸾计划密档（{MARKER}）\n"
           f"项目代号：青鸾计划\n负责人：{OWNER}\n秘密代码：{CODE}\n"
           "本文件由 QA 测试自动生成，仅用于检索与对话命中验证。\n" * 8)
files = {"file": (FILE_NAME, content.encode("utf-8"), "text/plain")}
r = client.post("/api/files/upload", files=files, data={"folderId": str(fid)})
upload = r.json()
file_id = upload.get("id")
record("TC-11", "上传", "POST /api/files/upload txt 成功返回 {id,name,chunkCount>0}",
       r.status_code == 200 and isinstance(file_id, int) and upload.get("chunkCount", 0) > 0,
       ev(r, f"fileId={file_id} chunkCount={upload.get('chunkCount')}"))

files = {"file": ("evil.exe", b"MZ", "application/octet-stream")}
r = client.post("/api/files/upload", files=files, data={"folderId": str(fid)})
record("TC-12", "上传-错误路径", "非法扩展名 .exe 上传 → 400",
       r.status_code == 400, ev(r))

big = b"a" * (20 * 1024 * 1024 + 1)
files = {"file": (f"big-{RUN}.txt", big, "text/plain")}
r = client.post("/api/files/upload", files=files, data={"folderId": str(fid)})
record("TC-13", "上传-错误路径", "超过 20MB 文件上传 → 400",
       r.status_code == 400, ev(r))

r = client.get(f"/api/files/{file_id}/preview")
d = r.json()
record("TC-14", "预览", "GET /api/files/{id}/preview 返回 name+content 且 content≤5000 字",
       r.status_code == 200 and d.get("name") == FILE_NAME and len(d.get("content", "")) <= 5000 and MARKER in d.get("content", ""),
       ev(r, f"contentLen={len(d.get('content',''))}"))

r = client.get("/api/files/999999/preview")
record("TC-15", "预览-错误路径", "GET 不存在文件 preview → 404",
       r.status_code == 404, ev(r))

r = client.post("/api/kb/search", json={"query": f"青鸾计划 {MARKER}", "topK": 8})
hits = r.json()
hit_ok = any(h.get("fileName") == FILE_NAME for h in hits)
record("TC-16", "检索", "POST /api/kb/search 命中测试文件",
       r.status_code == 200 and isinstance(hits, list) and hit_ok,
       ev(r, f"hits={len(hits)} top={hits[0]['fileName'] if hits else '无'}"))

r = client.delete("/api/files/999999")
record("TC-17", "文件-错误路径", "DELETE 不存在文件 → 404",
       r.status_code == 404, ev(r))

# ================= 4. 对话（不含 chat 流） =================
r = client.get("/api/conversations")
record("TC-18", "对话", "GET /api/conversations 列表结构",
       r.status_code == 200 and isinstance(r.json(), list), ev(r))

r = client.post("/api/conversations", json={"title": CONV_TITLE})
conv_id = r.json().get("id")
record("TC-19", "对话", "POST /api/conversations 返回 {id}",
       r.status_code == 200 and isinstance(conv_id, int), ev(r, f"convId={conv_id}"))

r = client.get(f"/api/conversations/{conv_id}")
record("TC-20", "对话", "GET /api/conversations/{id} 返回 id/title/messages",
       r.status_code == 200 and r.json().get("id") == conv_id and "messages" in r.json(), ev(r))

r = client.get("/api/conversations/999999")
record("TC-21", "对话-错误路径", "GET 不存在对话 → 404",
       r.status_code == 404, ev(r))

r = client.put(f"/api/conversations/{conv_id}", json={"title": CONV_RENAMED})
titled = any(c["title"] == CONV_RENAMED for c in client.get("/api/conversations").json())
record("TC-22", "对话", "PUT /api/conversations/{id} 重命名生效",
       r.status_code == 200 and titled, ev(r))

r = client.delete("/api/conversations/999999")
record("TC-23", "对话-错误路径", "DELETE 不存在对话 → 404",
       r.status_code == 404, ev(r))

# ================= 5. 真实上游对话（SSE） =================
u_before = client.get("/api/usage").json()["used"]
chat_payload = {"conversationId": conv_id, "message": f"请仅依据知识库资料回答：青鸾计划的负责人是谁？秘密代码是多少？",
                "useKb": True, "depth": "high"}
chat_resp = client.post("/api/chat", json=chat_payload)
events, raw = parse_sse(chat_resp)
types = [e.get("type") for e in events]
usage_ev = next((e for e in events if e.get("type") == "usage"), None)
content_text = "".join(e.get("delta", "") for e in events if e.get("type") == "content")
retry_n = sum(1 for e in events if e.get("type") == "retry")
err_ev = next((e for e in events if e.get("type") == "error"), None)
usage_ok = usage_ev is not None and (client.get("/api/usage").json()["used"] - u_before == usage_ev["totalTokens"])
record("TC-24", "对话SSE", "chat depth=high: SSE 含 reasoning/content/usage/done 且 [DONE]，usage 增量==totalTokens",
       chat_resp.status_code == 200 and "reasoning" in types and "content" in types
       and usage_ev is not None and "done" in types and types[-1] == "[DONE]" and usage_ok,
       ev(chat_resp, f"types={sorted(set(t for t in types if t))} total={usage_ev and usage_ev['totalTokens']} retry={retry_n} err={err_ev and err_ev.get('message','')[:120]}"))
record("TC-25", "对话SSE", "depth=high 回答引用测试文件内容（张三丰 + QA42）",
       OWNER in content_text and CODE in content_text,
       f"answer[:200]={content_text[:200]!r}")
# 会话详情落库断言
r = client.get(f"/api/conversations/{conv_id}")
msgs = r.json()["messages"]
asst = [m for m in msgs if m["role"] == "assistant"]
record("TC-26", "对话SSE", "assistant 消息落库（含 reasoning/tokens/elapsedMs）",
       len(asst) >= 1 and asst[-1]["completionTokens"] == (usage_ev or {}).get("completionTokens"),
       f"msgs={len(msgs)} asstTokens={asst and (asst[-1]['promptTokens'], asst[-1]['completionTokens'], asst[-1]['elapsedMs'])}")

u_before2 = client.get("/api/usage").json()["used"]
chat_resp2 = client.post("/api/chat", json={"conversationId": conv_id,
                                            "message": f"知识库文件 {FILE_NAME} 中的标记词 {MARKER} 代表什么？一句话回答。",
                                            "useKb": True, "depth": "none"})
events2, _ = parse_sse(chat_resp2)
types2 = [e.get("type") for e in events2]
usage_ev2 = next((e for e in events2 if e.get("type") == "usage"), None)
content2 = "".join(e.get("delta", "") for e in events2 if e.get("type") == "content")
usage_ok2 = usage_ev2 is not None and (client.get("/api/usage").json()["used"] - u_before2 == usage_ev2["totalTokens"])
record("TC-27", "对话SSE", "chat depth=none: 无 reasoning 事件，有 content/usage/done，usage 增量==totalTokens",
       chat_resp2.status_code == 200 and "reasoning" not in types2 and "content" in types2
       and usage_ev2 is not None and "done" in types2 and usage_ok2,
       f"types={sorted(set(t for t in types2 if t))} answer[:120]={content2[:120]!r}")

r = client.post("/api/chat", json={"conversationId": 999999, "message": "hi", "useKb": False})
record("TC-28", "对话-错误路径", "chat 会话不存在 → 404",
       r.status_code == 404, ev(r))

# ================= 6. 模型 / 导出 / 导入 =================
r = client.get("/api/models")
record("TC-29", "模型", "GET /api/models 返回 {models:[...]}",
       r.status_code == 200 and isinstance(r.json().get("models"), list) and len(r.json()["models"]) > 0,
       ev(r))

r = client.get("/api/export")
exp = r.json()
exp_settings = exp.get("settings", {})
my_folder = next((f for f in exp["folders"] if f["name"] == FOLDER_NAME + "-R"), None)
my_file = next((f for f in exp["files"] if f["name"] == FILE_NAME), None)
my_chunks = [c for c in exp["chunks"] if c["file_id"] == my_file["id"]] if my_file else []
my_conv = next((c for c in exp["conversations"] if c["title"] == CONV_RENAMED), None)
record("TC-30", "导出", "GET /api/export 含 version/导出时间/测试实体，settings 不含 api_key",
       r.status_code == 200 and exp.get("version") == 1 and "exportedAt" in exp
       and my_folder is not None and my_file is not None and my_conv is not None
       and "api_key" not in exp_settings and len(my_chunks) == (my_file or {}).get("chunk_count", -1),
       ev(r, f"chunks={len(my_chunks)} convMessages={len(my_conv.get('messages', [])) if my_conv else 0}"))

# 导入闭环：仅回导测试实体（构造过滤版 JSON，不动真实数据）
imp_payload = {"version": 1, "exportedAt": exp["exportedAt"],
               "folders": [my_folder], "files": [my_file], "chunks": my_chunks,
               "conversations": [my_conv], "settings": {}}
r = client.post("/api/import", files={"file": (f"qa-import-{RUN}.json",
                                               json.dumps(imp_payload, ensure_ascii=False).encode("utf-8"),
                                               "application/json")})
imp = r.json()
record("TC-31", "导入", "POST /api/import 回导测试实体，计数与导出一致 (folders=1,files=1,conversations=1)",
       r.status_code == 200 and imp == {"folders": 1, "files": 1, "conversations": 1},
       ev(r, f"resp={imp}"))

tree_after = client.get("/api/tree").json()
copy_folder = next((f for f in tree_after["folders"] if f["name"] == FOLDER_NAME + "-R" and f["id"] != fid), None)
copy_file = next((f for f in tree_after["files"] if f["name"] == FILE_NAME and f["id"] != file_id), None)
convs_after = client.get("/api/conversations").json()
copy_conv = next((c for c in convs_after if c["title"] == CONV_RENAMED and c["id"] != conv_id), None)
copy_conv_detail = client.get(f"/api/conversations/{copy_conv['id']}").json() if copy_conv else {}
record("TC-32", "导入闭环", "回导副本可查询：目录/文件副本在 tree，对话副本消息数一致",
       copy_folder is not None and copy_file is not None and copy_conv is not None
       and len(copy_conv_detail.get("messages", [])) == len(my_conv["messages"]),
       f"copyFolderId={copy_folder and copy_folder['id']} copyFileId={copy_file and copy_file['id']} "
       f"copyConvId={copy_conv and copy_conv['id']} messages={len(copy_conv_detail.get('messages', []))}")

bad = client.post("/api/import", files={"file": ("bad.json", b"not-json", "application/json")})
record("TC-33", "导入-错误路径", "导入非 JSON → 400",
       bad.status_code == 400, ev(bad))
bad2 = client.post("/api/import", files={"file": ("bad2.json", json.dumps({"version": 99}).encode(), "application/json")})
record("TC-34", "导入-错误路径", "导入不支持版本 → 400",
       bad2.status_code == 400, ev(bad2))

# ================= 7. 前端静态资源 =================
r = client.get("/")
html = r.text
refs = re.findall(r'(?:src|href)="([^"]+)"', html)
local_refs = [x for x in refs if not x.startswith(("http", "//", "data:"))]
asset_status = {x: client.get(x).status_code for x in local_refs}
record("TC-35", "前端静态", f"GET / 返回 200，index.html 引用的 {len(local_refs)} 个本地资源全部 200",
       r.status_code == 200 and all(v == 200 for v in asset_status.values()),
       f"refs={asset_status}")

# ================= 8. 清理（删除自建数据，保留原有数据） =================
cleanup: list[str] = []


def cleanup_step(cid, desc, fn):
    try:
        ok, evid = fn()
        record(cid, "清理", desc + "（不算入通过率）", ok, evid)
    except Exception as exc:  # noqa: BLE001
        record(cid, "清理", desc + "（不算入通过率）", False, f"异常 {exc}")


def del_conv(cid_: int):
    r_ = client.delete(f"/api/conversations/{cid_}")
    gone = client.get(f"/api/conversations/{cid_}").status_code == 404
    return r_.status_code == 200 and gone, ev(r_, f"gone404={gone}")


def del_folder(fid_: int):
    r_ = client.delete(f"/api/folders/{fid_}")
    gone = all(f["id"] != fid_ for f in client.get("/api/tree").json()["folders"])
    return r_.status_code == 200 and gone, ev(r_, f"gone={gone}")


cleanup_step("CL-01", "删除测试对话原件", lambda: del_conv(conv_id))
if copy_conv:
    cleanup_step("CL-02", "删除导入对话副本", lambda: del_conv(copy_conv["id"]))
if copy_folder:
    cleanup_step("CL-03", "删除导入目录副本（级联删文件副本）", lambda: del_folder(copy_folder["id"]))
cleanup_step("CL-04", "删除测试目录原件（级联删测试文件）", lambda: del_folder(fid))
r = client.get("/api/usage")
record("CL-05", "清理", "清理后用量仍保留（usage 只增不减，属契约预期，不算入通过率）", r.status_code == 200, ev(r))

post = client.get("/api/tree").json()
post_convs = client.get("/api/conversations").json()
residue = (set(f["id"] for f in post["folders"]) - PRE_FOLDERS,
           set(f["id"] for f in post["files"]) - PRE_FILES,
           set(c["id"] for c in post_convs) - PRE_CONVS)
record("CL-06", "清理", "数据残留校验：tree/conversations 与前置快照一致", all(len(s) == 0 for s in residue),
       f"residue folders/files/convs = {[len(s) for s in residue]}")

# ================= 汇总 =================
cases = [r_ for r_ in results if r_["module"] != "清理"]
passed = sum(1 for r_ in cases if r_["status"] == "PASS")
failed = sum(1 for r_ in cases if r_["status"] == "FAIL")
blocked = sum(1 for r_ in cases if r_["status"] == "BLOCKED")
total = len(cases)
summary = {"total": total, "passed": passed, "failed": failed, "blocked": blocked,
           "passRate": round(passed / total * 100, 1) if total else 0.0}
print("\n==== SUMMARY ====")
print(json.dumps(summary, ensure_ascii=False))
with open("/tmp/qa_results.json", "w", encoding="utf-8") as f:
    json.dump({"summary": summary, "results": results}, f, ensure_ascii=False, indent=2)
print("results -> /tmp/qa_results.json")
