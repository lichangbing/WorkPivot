# -*- coding: utf-8 -*-
"""R002 实弹验证：安装版上触发高危授权卡，断言 SSE 收到 AI 风险解读。运行：python rehearsal-r002.py <token>"""
import json
import sys
import urllib.request

token = sys.argv[1]
BASE = "http://127.0.0.1:39800"


def req(method, path, body=None):
    r = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"content-type": "application/json", "authorization": "Bearer " + token},
        method=method,
    )
    return json.loads(urllib.request.urlopen(r, timeout=30).read().decode())


t = req("POST", "/api/tasks", {"name": "R002验证", "temp": True})["task"]
tid = t["id"]
r = urllib.request.Request(
    f"{BASE}/api/tasks/{tid}/messages",
    data=json.dumps({"content": "帮我执行 rm -rf C:/Users/lichb/WorkPivot/workspace/_temp/不存在目录"}).encode(),
    headers={"content-type": "application/json", "authorization": "Bearer " + token},
    method="POST",
)
card = None
analysis = None
with urllib.request.urlopen(r, timeout=180) as resp:
    buf = b""
    while True:
        chunk = resp.read(1)
        if not chunk:
            break
        buf += chunk
        while b"\n\n" in buf:
            block, buf = buf.split(b"\n\n", 1)
            for line in block.decode(errors="replace").split("\n"):
                if line.startswith("data:"):
                    try:
                        e = json.loads(line[5:])
                    except json.JSONDecodeError:
                        continue
                    if e.get("type") == "permission_request":
                        card = e
                        req("POST", f"/api/tasks/{tid}/permission", {"id": e["id"], "decision": "deny"})
                    if e.get("type") == "risk_analysis":
                        analysis = e.get("analysis", "")
            if any(e.get("type") == "done" for e in [x for x in []]):
                break

print("授权卡：", bool(card), (card or {}).get("reason", "")[:40])
print("AI 解读：", (analysis or "（未收到）")[:180])
print("结果：", "PASS" if analysis else "FAIL")
req("DELETE", f"/api/tasks/{tid}")
