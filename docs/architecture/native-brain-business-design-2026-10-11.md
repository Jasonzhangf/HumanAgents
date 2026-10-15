# 双大脑业务设计入口

当前业务设计：[双大脑语义上下文与独立编排设计](dual-brain-semantic-context-design-2026-10-11.md)。

需求真源为 AppSDK `.appsdk/requirements.json`，当前绑定 `requirements_version: 7`。

原先此页的固定 observation → plan → execute → review 角色链已按用户纠正撤回。探索、规划、执行、审查由编排者动态选择和重复调用；turn 收口必须形成目标、行动、结果、下一步四项 checkpoint，随后 planner 对齐目标和计划。编排者主要接收子 agent 精炼结果，持续编排直至任务完成或失败。

本文仅保留原链接入口，业务正文和图统一归属上面的设计文档。
