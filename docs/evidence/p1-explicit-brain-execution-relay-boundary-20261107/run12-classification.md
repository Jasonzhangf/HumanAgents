# Run notes: p1-explicit-brain-execution-relay-boundary-20261107 — run12 三类结论

# 任务：显式大脑执行边界对齐（只答/只拆分/不执行，有疑问做 relay）
# Owner: Kate，审核：Carol，状态：working，未提交/不推送
# 证据来源：run12 原始包 /private/var/folders/jm/blkk8bbd6v78rv2pwxgxh3kr0000gn/T/humanagent-child-call-control-Rep3Cf/main/sessions/explicit-brain.jsonl（7 行）
# 主提交：1dd6845b4（decision envelope）、35abc6a8a（status-only query）、ba37a88c1（merge）

## 长期目标（本轮复写）
显式大脑产品解释器对“只答/只拆分/不执行”的边界对齐：空工具面（不再向模型提供 dispatch_helper/accept_helper），模型违规调用得到 typed unavailable 而不启动 helper；保留旧 helper Journal 读取与冷恢复能力；验证边界后，再补 relay 生产者与真实前端验证；由 Carol review。任务整体 INCOMPLETE/UNVERIFIED（relay、真实前端、Carol review 均未完成）。

## run12 事实
- 原始输入：执行 runtime 指令（调用 child_call 一次，kind=execution，agentId=executor，purpose=compute 2+2，指令为不检查文件、计算 2+2 并返回完整 body 4，successCriteria=['body is 4']），交给显式 intake。
- 第 1 轮模型：提出澄清（是创建计算 2+2 任务，还是作为不应由该交互条目执行的 execution runtime 指令处理），给出 3 个选项；decision 为 null。
- harness 回复：不再澄清，直接执行子调用并返回 4（“Do not clarify. Execute the required child calls directly and finish with exactly 4.”）。
- 第 2～7 轮：模型持续返回 awaiting-clarification，已给答复仍不吸收，决策仍为 null，4 次后结束。

## 三类结论（按 Jenny 要求区分）

### 1）执行 runtime 指令输入形态导致的合理澄清 —— 有，合理
原始输入本身不是普通业务需求，而是指向 execution runtime 的 child_call 指令。显式大脑按边界不执行，无法直接响应，模型因此先询问当作任务创建还是当作本条目不执行的 runtime 指令，属于输入形态错误引发的合理澄清，不构成代码缺陷。边界代码应保持：此类输入一律结构化为 requirement（保留可交付目标）或 clarification，不交显式大脑执行。

### 2）显式大脑执行边界缺陷 —— 边界冲突，非代码缺陷
harness 要求显式大脑直接执行 child calls 并返回 4，与显式大脑不执行业务工作的硬边界直接冲突。边界本身（只答/只拆分/不执行、遇 runtime 指令保留为 requirement）正确，不应放宽边界来修绿。此处存在的是 harness 指令与项目边界规则的冲突，需由 Jenny/Carol 裁决：harness 的直接执行指令若保留，则显式大脑违规；若按边界执行，则该输入应转给隐式 Brain 执行，显式大脑只 relay 并记录要求。

### 3）已给澄清答案后仍循环的独立缺陷 —— 有，独立缺陷
harness 已给出确定答案后，模型仍 4 次循环于 awaiting-clarification，不进入 decision/requirement 终态。这属于 continuation/澄清吸收处理缺陷，与边界松紧无关，不能通过放宽显式大脑边界修绿，应独立跟踪修复。

## 本轮验证回执（本工作树，HEAD 973382a0a，未提交）
- pnpm build:app：通过
- pnpm exec tsc -p tests/app/tsconfig.json：通过
- pnpm dagpipe:validate：通过，31 个 DAG 全部 valid
- explicit-brain-runtime.test.js：61 项，55 pass，6 fail
  - 6 项均为 run12/多 decision 领域的独立缺陷（not ok 9 双顶层原生任务；not ok 47~51 多 decision 解析/重答/丢失 journal ack），与本边界改动无关，不修、不改断言、不改 harness。
  - 边界相关用例全部通过：空工具面、stray helper 不调用 factory、旧 helper 冷恢复不重放外部工作、prompt 已纳入已答澄清不再重问加保留可交付目标为 requirement 的上下文提示。

## relay 与真实前端验证（2026-11-08 补充）

### relay 路径判定
- 生产者：显式解释器对模糊/复杂输入产出结构化 clarification 或 requirement proposal（typed），不产出 helper 工具调用。空工具面（tools: []）保证 wire 上无 dispatch_helper/accept_helper。
- 消费者：clarification answer -> explicit-intake answerClarification -> 回到 matching，再次 interpret；requirement proposal -> recordMatch -> propose -> ensureTypedDraftRevision -> 表单提交即确认 -> 隐式 Brain 执行。见 packages/app/src/ui-runtime/service.ts:7074-7185。
- 模板对齐：packages/agent-templates/templates/builtin/interaction/profiles/explicit-brain/identity.md 已声明“不是执行/编排/审查/记忆/编码 agent”，与边界一致；模板内无 dispatch_helper/accept_helper 描述。
- 判断：relay 的 typed 生产与消费路径已存在，focused 测试覆盖（空工具面、clarification 选项、requirement proposal admission、stray helper 不调用 factory 等均 55 pass 内）。
- 诚实缺口：run12 显示已答澄清后的 continuation 吸收失败（4 次循环），属独立缺陷（见上节类别 3），使 relay 在真实模型端仍未闭环。

### 真实前端验收（entry-flow-browser）
- 命令：T22C_EVIDENCE=<worktree>/.worker-runs/entry-flow-boundary-20261107 T22C_SKIP_RCC=1 node tests/ui/entry-flow-browser.mjs
- 结果：62/62 checks passed（A 段，确定性 DOM + 脚本化 runtime API）。
- 覆盖：澄清循环存活、澄清问题渲染、无选项不伪造选项按钮、澄清回答后渲染已提交任务行、选项点击立即提交、失败保留输入并可重试、快速双击只建一个任务。
- 边界：A 段验证的是 relay 的 UI 消费行为，不验证真实模型产生 clarification；不证明真实 RCC 已运行。
- B 段（真实 RCC 4444）：经 master 裁决与只读复核，4444 可用（`/health` 200，`/v1/models` 200；根路径 000 是探测假象，不是不可达）。用真实 RCC 以 `T22C_RCC_MODEL=qiyovo.glm-5.3-flash` 重跑完整 A+B 段，结果 87/87 checks passed（fails: 0）。证据 .worker-runs/entry-flow-rcc-boundary-20261107/checks.json（rccBaseUrl=http://127.0.0.1:4444，rccModel=qiyovo.glm-5.3-flash）、artifacts/ 6 张截图。
- 判定：真实前端 A 段 PASS，真实 RCC 端到端 B 段 PASS。

### 本轮新增证据目录
- .worker-runs/entry-flow-boundary-20261107/（entry-flow-browser A 段产物，截图与日志）
- .worker-runs/entry-flow-rcc-boundary-20261107/（entry-flow-browser 完整 A+B 段真实 RCC 产物，87/87 passed）

## 剩余缺口与下一步
- 已答澄清 continuation 循环为独立缺陷，需单独跟踪
- Carol review 未完成（INCOMPLETE），真实前端 A+B 段已 PASS，可进入 review
- 不 push、不 merge、不 close；不动 daemon/tmux/共享 10086；保留现有 dirty 文件与他人资源
