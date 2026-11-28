<!-- project-memory:v1 {"category":"knowledge","created_at":"2026-11-08T19:09:40.281067+00:00","entry_kind":"fact","id":"mia-wake-provider-not-ready-20261108","importance":0,"memory_level":3,"review_evidence":[],"review_status":"unreviewed","rule_control":null,"source_refs":[],"tags":["mia","patrol","provider","wake"],"updated_at":"2026-11-28T05:48:07.780145+00:00"} -->

# Mia 唤醒结果为 provider 未 ready，保留巡检目标

2026-11-08 master Jenny 回执 m1794164947409-4417：已 canonical 唤醒 Mia，durable 消息 m1794164647724-4397 已入其 mailbox，但 desktop bridge 原生拒绝 live 投递，原错 DESKTOP_BRIDGE_NATIVE_REJECTED "App-server task is not ready: model-provider"。即 Mia endpoint 存在但当前 provider 未 ready，不是永久缺失。裁决：保留 P0 测试任务 humanagent-mia-user-perspective-mvp-test-20261107 与 board-idle 巡检目标，不移除；恢复条件为 Mia endpoint 的 model-provider ready 后 collab recv 并复测五条 gate。若下一巡检周期仍 missing，Jenny 改派有真实前端 CLI 的 peer 复测，不伪造 Mia 回执。
<!-- project-memory:end -->
