---
name: agent-addressing
description: Resolve a project or named member into one communication target.
---

## 适用条件

Use this Skill when a project name or named member must become one communication or task target.

## 绑定工具

agent.query can read registered agent facts only in a full explicit runtime request with a bound executor. The bounded intake request does not execute address resolution.

## 参数来源

Use the current workspace, project, member name, and user input. Preserve the machine/project/member hierarchy supplied by the runtime.

## 权限

Target lookup requires the registered agent read scope. The model may not invent, broadcast, or silently replace an address.

## 回执

Return one resolved typed target, or the original typed ambiguity, unregistered, or unreachable error. Do not collapse multiple targets into one guess.

## 工作规则

Build the address from the current workspace, machine, project, and user input. Use one resolved target.
