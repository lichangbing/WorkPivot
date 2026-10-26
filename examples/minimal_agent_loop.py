#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
最小可用 Agent 循环（DeepSeek 版）
=================================

零第三方依赖，只用标准库直连 DeepSeek 的 OpenAI 兼容接口。

跑通的最小链路：
    用户指令 -> 模型思考 -> 调用工具 -> 观察结果 -> 回到模型 -> ... -> 最终回答

用法
----
    # 1) 设置 key（推荐环境变量，别写进文件）
    $env:DEEPSEEK_API_KEY = "sk-xxxxxx"        # PowerShell
    export DEEPSEEK_API_KEY="sk-xxxxxx"        # bash

    # 2) 运行（联网真实调用）
    python minimal_agent_loop.py "看一下 workspace 里有哪些文件，写一份 README 说明"

    # 3) 不联网自检：用假响应驱动同一套循环，验证工具与环路是否正确
    python minimal_agent_loop.py --dry-run "测试任务"

本文件与 LangGraph 的对应关系（后续迁移时直接对照）
--------------------------------------------------
    while True 手写循环      -> StateGraph + conditional_edges
    messages 列表            -> State.messages（配 Checkpointer 后自动持久化/断点续跑）
    工具表 + 分发 switch     -> ToolNode 或 @tool
    is_repeat 重复调用拦截   -> 框架没有，必须自己写（下方保留）
    MAX_STEPS 预算           -> recursion_limit（LangGraph 无时长预算，需自建）
"""

import json
import os
import sys
import urllib.request
from collections import Counter
from pathlib import Path

# ---------------------------------------------------------------- 配置

DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")   # 也可在此直接填 "sk-xxxx"
BASE_URL = "https://api.deepseek.com"
MODEL = "deepseek-chat"                                 # deepseek-reasoner 为推理模型
MAX_STEPS = 20                                          # 循环步数预算
REPEAT_WARN, REPEAT_STOP = 3, 5                         # 同一调用重复 N 次的提醒/拦截阈值

# 工具只能在这个目录内活动（路径穿越防护）
WORKDIR = Path(__file__).parent / "workspace"
WORKDIR.mkdir(exist_ok=True)

SYSTEM_PROMPT = (
    "你是一个能使用工具的助手。需要了解文件或写入内容时必须调用工具，不要凭空猜测。\n"
    "约定：\n"
    "1. 一次可以并行调用多个工具；\n"
    "2. 工具返回的内容即为事实依据，依据它继续推理；\n"
    "3. 已经拿到的信息不要重复获取，重复调用会被拦截；\n"
    "4. 任务完成后直接给出结论，不要再调用工具。"
)

# ---------------------------------------------------------------- 工具定义

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "list_files",
            "description": "列出工作目录下的文件与目录（相对路径）。",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "读取指定文件的文本内容。",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "相对工作目录的文件路径"},
                    "limit": {"type": "integer", "description": "最多读取的字符数，默认 8000"},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "把内容写入文件（覆盖），自动创建父目录。",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "相对工作目录的文件路径"},
                    "content": {"type": "string", "description": "要写入的完整内容"},
                },
                "required": ["path", "content"],
            },
        },
    },
]


def safe_path(rel: str) -> Path:
    """把相对路径限定在 WORKDIR 内，防止 ../ 穿越。"""
    p = (WORKDIR / rel).resolve()
    if not str(p).startswith(str(WORKDIR.resolve())):
        raise ValueError(f"路径越界: {rel}")
    return p


def tool_list_files(_args=None):
    items = sorted(str(p.relative_to(WORKDIR)) for p in WORKDIR.rglob("*"))
    return "\n".join(items) if items else "(空目录)"


def tool_read_file(args):
    p = safe_path(args["path"])
    if not p.exists():
        return f"错误：文件不存在 {args['path']}"
    text = p.read_text(encoding="utf-8", errors="replace")
    limit = int(args.get("limit", 8000))
    if len(text) > limit:
        text = text[:limit] + f"\n...[已截断，共 {len(text)} 字符]"
    return text


def tool_write_file(args):
    p = safe_path(args["path"])
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(args["content"], encoding="utf-8")
    return f"已写入 {p.relative_to(WORKDIR)}（{len(args['content'])} 字符）"


TOOL_IMPL = {
    "list_files": tool_list_files,
    "read_file": tool_read_file,
    "write_file": tool_write_file,
}

# ---------------------------------------------------------------- 模型调用

_enable_dry_run = False
_dry_step = 0


def chat(messages, tools):
    """调用 DeepSeek 对话接口。返回 assistant 消息 dict。"""
    if _enable_dry_run:  # 自检模式：不联网，返回脚本化的假响应
        global _dry_step
        _dry_step += 1
        if _dry_step == 1:
            return {
                "role": "assistant",
                "content": None,
                "tool_calls": [{
                    "id": "call_demo_1", "type": "function",
                    "function": {"name": "list_files", "arguments": "{}"},
                }],
            }
        return {"role": "assistant", "content": "自检完成：循环、工具分发与收敛均正常。", "tool_calls": None}

    if not DEEPSEEK_API_KEY:
        sys.exit("未检测到 DEEPSEEK_API_KEY，请先设置环境变量。")

    payload = json.dumps({
        "model": MODEL,
        "messages": messages,
        "tools": tools,
        "tool_choice": "auto",
        "temperature": 0.2,
        "stream": False,
    }).encode("utf-8")

    req = urllib.request.Request(
        f"{BASE_URL}/chat/completions",
        data=payload,
        headers={"Authorization": f"Bearer {DEEPSEEK_API_KEY}",
                 "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data["choices"][0]["message"]

# 换成官方 SDK 时，上面整个 chat() 可替换为：
#   from openai import OpenAI
#   client = OpenAI(api_key=DEEPSEEK_API_KEY, base_url=BASE_URL)
#   def chat(messages, tools):
#       return client.chat.completions.create(
#           model=MODEL, messages=messages, tools=tools, tool_choice="auto", temperature=0.2
#       ).choices[0].message.model_dump()

# ---------------------------------------------------------------- Agent 循环


def run(task: str) -> None:
    messages = [{"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": task}]
    seen = Counter()

    for step in range(1, MAX_STEPS + 1):
        msg = chat(messages, TOOLS)
        messages.append(msg)

        calls = msg.get("tool_calls") or []
        if not calls:                                   # 没有工具调用 = 收敛，结束
            print(f"\n===== 最终回答（第 {step} 步）=====\n{msg.get('content') or '(空)'}")
            return

        for call in calls:
            name = call["function"]["name"]
            raw = call["function"].get("arguments") or "{}"
            try:
                args = json.loads(raw)
            except json.JSONDecodeError:
                args = {}

            # 重复调用拦截：与 WorkPivot loop.ts 同思路（框架不提供，须自建）
            fp = name + "|" + json.dumps(args, sort_keys=True, ensure_ascii=False)
            seen[fp] += 1
            n = seen[fp]

            if n == REPEAT_WARN:
                result = "提醒：该调用已重复 3 次，若信息已足够请直接给出结论。"
            elif n >= REPEAT_STOP:
                result = "已拦截：该调用重复超过 5 次，终止本次工具执行。"
            elif name not in TOOL_IMPL:
                result = f"错误：未知工具 {name}"
            else:
                try:
                    result = TOOL_IMPL[name](args)
                except Exception as e:                  # 工具报错也要回给模型，让它改路径
                    result = f"工具执行失败：{type(e).__name__}: {e}"

            print(f"[step {step}] {name}({raw[:80]}) -> {str(result)[:200]}")
            messages.append({"role": "tool", "tool_call_id": call["id"],
                             "name": name, "content": str(result)})

    print(f"\n===== 达到步数上限 {MAX_STEPS}，强制收尾 =====")


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "--dry-run":
        _enable_dry_run = True
        args = args[1:]
    task = " ".join(args) or "列出当前文件，然后写一个 hello.txt，内容为 hello from agent"
    print(f"任务: {task}\n工作目录: {WORKDIR}\n")
    run(task)
