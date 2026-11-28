<!-- project-memory:v1 {"category":"knowledge","created_at":"2026-11-07T13:28:04.341221+00:00","entry_kind":"fact","id":"mvp-gate2-simple-answer-leak-20261107","importance":0,"memory_level":3,"review_evidence":[],"review_status":"unreviewed","rule_control":null,"source_refs":[],"tags":["gate2","issue","mia","mvp"],"updated_at":"2026-11-28T05:48:07.960352+00:00"} -->

# MVP gate 2 当前失败：简单问答泄漏无关任务摘要与内部请求序号

Mia 2026-11-07 在真实前端 http://127.0.0.1:10086/ 输入“1 加 1 等于几？请直接给出答案。”，页面未返回 2，显示“本次请求已直接回答/未创建任务”，正文却是“当前候选任务里尚无已完成的任务”等无关任务摘要，并出现“第 57 次请求”内部序号。证据 issue a4982b8（open，P1），截图 docs/verification/mia-user-perspective-mvp-20261107/shots/simple-1plus1-after-65s.png；修复任务 p1-explicit-brain-simple-answer-leak-20261107 已交 Emma。该结果违反用户 gate 2（简单任务直接回答）并构成内部状态泄漏，MVP 当前不可判可交付。
<!-- project-memory:end -->
