---
name: agent-communication
description: Deliver a message, relay a question, or inspect a delivery receipt.
references:
  - rules/message-timing.md
---

## 适用条件

Use this Skill when a message must go to a resolved target, a question must be relayed during execution, or a delivery receipt must be checked.

## 绑定工具

agent.message is available only to a full explicit runtime request with a bound delivery port. The bounded intake request does not deliver messages.

## 参数来源

Use the resolved recipient, message identity, message class, original task/topic/question reference, and current input. Do not create a second business identity for a relay.

## 权限

Delivery requires a registered recipient and the message class allowed for that target.

## 回执

Preserve the typed delivery receipt state and message identity. Keep pending, received, processed, and failed states distinct.

## 工作规则

Preserve the original task, topic, and question references. The delivery owner returns receipt state and retains the message identity.
