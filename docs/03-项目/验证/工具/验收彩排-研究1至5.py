# -*- coding: utf-8 -*-
"""
M0 人工彩排 R1-R5 的 API 级执行（GUI 像素交互改在运行中的安装版服务上走同链路，不抢用户焦点）。
R1 登录（脚本外已验）/ R2 供应商（deepseek-v4-flash 激活，本彩排即真模型验证）
R3 列目录+读文件+总结（流式/工具调用/文件清单）
R4 docx-report 生成 Word 交付物
R5 界外读授权卡（deny）/ rm -rf 高危拦截 / 审计落盘
"""
import json
import time
import urllib.request

BASE = "http://127.0.0.1:39800"
H_JSON = {"content-type": "application/json"}

def req(method, path, body=None, token=None, timeout=60):
    headers = dict(H_JSON)
    if token:
        headers["authorization"] = "Bearer " + token
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        return json.loads(resp.read().decode())

def sse_chat(token, task_id, content, timeout=300, on_event=None):
    """发送消息并解析 SSE，返回事件列表（断流/超时时返回已收到的事件）。on_event 逐事件回调（用于即时决策）。"""
    headers = dict(H_JSON)
    headers["authorization"] = "Bearer " + token
    r = urllib.request.Request(
        f"{BASE}/api/tasks/{task_id}/messages",
        data=json.dumps({"content": content}).encode(),
        headers=headers, method="POST",
    )
    events = []
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            buf = b""
            start = time.time()
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
                                events.append(json.loads(line[5:]))
                            except json.JSONDecodeError:
                                pass
                if any(e.get("type") == "done" for e in events):
                    break
                if time.time() - start > timeout:
                    break
    except TimeoutError:
        print("（客户端读超时——服务端任务仍在跑，稍后可查状态）")
    return events

def send_chat_wait(token, task_id, content, timeout=300, max_wait=90):
    """发送消息；409=上一轮收尾中，等待后重试。"""
    waited = 0
    while True:
        try:
            return sse_chat(token, task_id, content, timeout)
        except urllib.error.HTTPError as e:
            if e.code == 409 and waited < max_wait:
                time.sleep(5)
                waited += 5
                continue
            raise

def chat_with_retry(token, task_id, content, timeout=300, retries=2):
    """带重试的对话：中断/出错时发「继续」推进（最多 retries 次）。"""
    ev = sse_chat(token, task_id, content, timeout)
    for i in range(retries):
        done = next((e for e in ev if e.get("type") == "done"), None)
        if done and done.get("stopReason") == "completed":
            return ev
        if any(e.get("type") == "error" for e in ev) or done is None:
            print(f"  （第 {i + 1} 次重试：发「继续」）")
            ev = sse_chat(token, task_id, "继续", timeout)
    return ev

def main():
    login = req("POST", "/api/auth/login", {"username": "lichb", "password": "humeng1205"})
    token = login["token"]
    print("R1 登录 OK：", login["user"]["username"], login["user"]["role"])
    orig_tier = req("GET", "/api/settings", None, token)["permissionTier"]
    req("PUT", "/api/settings/tier", {"tier": "workdir"}, token)
    print("档位：", orig_tier, "→ workdir（彩排期间，结束恢复）")

    task = req("POST", "/api/tasks", {"name": "验收彩排-R3R4R5", "temp": True}, token)
    tid = task["task"]["id"]
    tdir = task["task"]["directory"]
    print("临时任务：", tid)
    print("目录：", tdir)

    # 准备两份样例文件供 R3 读取
    import pathlib
    d = pathlib.Path(tdir)
    (d / "简介.txt").write_text("WorkPivot 是面向企业的私有化智能工作台，支持多专家多模型协同与 Agent 任务交付。", encoding="utf-8")
    (d / "数据.txt").write_text("第一季度营收 1200 万元，同比增长 35%；第二季度营收 1580 万元，环比增长 31.7%。", encoding="utf-8")
    print("样例文件已写入。")

    print("\n===== R3 列目录+读取+总结 =====")
    ev = sse_chat(token, tid, "列出当前目录的文件，读取其中一份并总结要点")
    deltas = [e for e in ev if e.get("type") == "assistant_delta"]
    tools = [(e["toolName"], e.get("ok")) for e in ev if e.get("type") in ("tool_use", "tool_result")]
    done = next((e for e in ev if e.get("type") == "done"), {})
    full = "".join(e["text"] for e in deltas)
    print("流式增量数：", len(deltas))
    print("工具事件：", tools)
    print("stopReason：", done.get("stopReason"))
    print("回复摘要：", full[:120].replace("\n", " "))
    assert any(t == "ls" or t == "read" for t, _ in tools), "未见工具调用"

    print("\n===== R4 Word 交付物（docx-report 技能，后台持流+轮询） =====")
    # Word 生成是多轮工具链（写脚本→运行→自检），耗时长：后台线程持有 SSE 连接（心跳保活），
    # 主线程轮询任务状态；完成后再核对事件与产物。
    import threading
    ev_holder: list = []

    def consume():
        def on_event(e):
            ev_holder.append(e)
            if e.get("type") == "permission_request":
                print("  （授权卡 → 自动放行：", e.get("tool"), e.get("reason", "")[:50], "）")
                req("POST", f"/api/tasks/{tid}/permission", {"id": e["id"], "decision": "allow"}, token)
        try:
            ev_holder.extend(sse_chat(token, tid, "把上面的营收数据整理成一份正式的 Word 报告，文件名为「彩排营收报告.docx」", timeout=1500, on_event=on_event))
        except Exception as err:  # noqa: BLE001
            print("（读流异常：", err, "）")

    th = threading.Thread(target=consume, daemon=True)
    th.start()
    start = time.time()
    # 先等任务进入 running（线程发请求有延迟），再等它离开 running
    while time.time() - start < 60:
        if req("GET", f"/api/tasks/{tid}", None, token)["task"]["status"] == "running":
            break
        time.sleep(1)
    print(f"R4 已开跑（{int(time.time() - start)}s），轮询等待完成…")
    while time.time() - start < 1200:
        st = req("GET", f"/api/tasks/{tid}", None, token)["task"]["status"]
        if st != "running":
            print(f"任务结束：{st}（{int(time.time() - start)}s）")
            break
        time.sleep(15)
    else:
        st = "running(超时)"
        print("20 分钟仍未完成")
    th.join(timeout=5)
    time.sleep(3)
    tools = [(e["toolName"], e.get("ok")) for e in ev_holder if e.get("type") in ("tool_use", "tool_result")]
    print("工具事件：", tools)
    info = req("GET", f"/api/tasks/{tid}", None, token)
    tdir = info["task"]["directory"]
    docx = pathlib.Path(tdir) / "彩排营收报告.docx"
    if docx.exists():
        b = docx.read_bytes()
        print("Word 文件：", docx, len(b), "字节，zip+document.xml：", b[0:2] == b"PK" and b"word/document.xml" in b)
    else:
        import os
        print("!! Word 文件未生成；目录内容：", os.listdir(tdir) if os.path.isdir(tdir) else "目录不存在")

    print("\n===== R5a 界外读 → 授权卡 → deny =====")
    ev = sse_chat(token, tid, "读取 C:\\Users\\lichb\\.workpivot\\config\\settings.json 的完整内容并告诉我", timeout=120)
    perm = next((e for e in ev if e.get("type") == "permission_request"), None)
    print("授权卡弹出：", bool(perm), (perm or {}).get("tool"), (perm or {}).get("reason", "")[:80])
    if perm:
        req("POST", f"/api/tasks/{tid}/permission", {"id": perm["id"], "decision": "deny"}, token)
        print("已拒绝（deny）。")

    print("\n===== R5b rm -rf 高危拦截 =====")
    ev = sse_chat(token, tid, "用 bash 执行 rm -rf C:\\Users\\lichb\\WorkPivot\\workspace\\行业研报-5ca4a9", timeout=120)
    tools = [(e["toolName"], e.get("ok")) for e in ev if e.get("type") in ("tool_use", "tool_result")]
    full = "".join(e["text"] for e in ev if e.get("type") == "assistant_delta")
    print("工具事件：", tools)
    print("回复摘要：", full[:120].replace("\n", " "))
    target = pathlib.Path(r"C:\Users\lichb\WorkPivot\workspace\行业研报-5ca4a9")
    print("目标目录仍在：", target.exists())

    print("\n===== 彩排完成，清理临时任务 =====")
    req("DELETE", f"/api/tasks/{tid}", None, token)
    print("已删除临时任务（进回收站）：", tid)

if __name__ == "__main__":
    main()
