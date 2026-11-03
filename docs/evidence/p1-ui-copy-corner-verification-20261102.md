# P1 步骤文案与角落安全边界：候选验收

结论：FAIL / INCOMPLETE，不能交付或合并。验收对象为现有 worktree `/Volumes/Intel/playground/humanagent/p1-ui-copy-corner-20261102`，分支 `codex/p1-ui-copy-corner-20261102`，候选自然提交 `5c74d0d47`、`34258f5e7`、`b1be09a8a`；当前 `origin/main` 已 fetch。`git merge-tree --write-tree origin/main HEAD` 退出 0，表示文本层无冲突，不代替组合后的行为验证。

实际变更文件：`docs/ui/entry.js`、`docs/ui/runtime.css`、`packages/app/src/explicit-brain-runtime.ts`、`tests/app/live-step-feedback.test.ts`、`tests/ui/ui.test.ts`。范围已由 Jenny 更正并确认。未修改产品源码或 `.appsdk`，未新建 worktree，未操作生产服务。

## 执行结果

- `pnpm typecheck`：通过。
- `pnpm build:app`：通过。
- `pnpm exec tsc -p tests/ui/tsconfig.json`：通过；`node --test dist/tests/tests/ui/ui.test.js` 退出 1。`runtime UI consumes typed API without hardcoded success or direct source access` 因 `source.includes('Journal')` 为 true 失败；`entry page presents an answered snapshot as a success result instead of failing` 报 `ReferenceError: renderDirectAnswer is not defined`。原始输出 `/tmp/humanagent-p1-ui-verify-test.log`。尚未证明两项由该候选引入，作者需核对夹具与基线，不能弱化真实行为验收。
- `pnpm exec tsc -p tests/app/tsconfig.json`：通过；`node --test dist/tests/tests/app/live-step-feedback.test.js` 退出 1。`task events stream reports provider request rounds and child lifecycle steps` 等待 live step feedback 超时，任务投影为 failed。单项复跑同样失败；原始输出 `/tmp/humanagent-p1-ui-live-step.log`。尚未确认根因或是否为既有问题。
- `T22C_EVIDENCE=/tmp/humanagent-p1-ui-copy-verify node tests/ui/entry-submit-progress-browser.mjs`：退出 1。该测试用脚本化 explicit-brain API 和浏览器，不能算真实 RCC 用户任务。两项失败：真实 `explicit.step` 第一条摘要未显示、第二条摘要未替换第一条，实际均为 `执行进度`。复跑原始输出 `/tmp/humanagent-p1-ui-browser.log`。
- 浏览器截图：`/tmp/humanagent-p1-ui-copy-verify/step-progress-1280x720.png`、`/tmp/humanagent-p1-ui-copy-verify/step-progress-390x844.png`。移动端截图经目视：卡片和计时器可见，但连续步骤显示同一 `执行进度`，未显示实际步骤含义；顶部及底部角落控件仍在视口内。截图来自脚本化场景，不能证明真实入口或所有角落内容均不被遮挡。

## 首次偏离与后续

`docs/ui/entry.js:265-275` 的 `localizedStepSummary` 对不在固定表中的非空文本统一返回 `执行进度`。现有浏览器反例表明它也吞掉有意义的真实步骤摘要；状态和计时虽变化，用户不能区分当前步骤，偏离用户要求的实时动态信息。请作者按有效需求保留真实有意义的步骤语义，同时避免原样暴露内部英文；先补可抓错的正反例，再复测上述 UI 和 live-step 失败。确认真实 RCC 页面、两种视口、角落不遮挡后，才能送完整候选审查。

本轮为验收，无法确认 UI 单测与 live-step 超时的根因；未触发生产修复。自有截图及日志为必要回执，暂保留在上述 `/tmp` 路径；无自有服务、worktree 或分支需要回收。

## rework-1 受影响复验

作者候选 `7ed2b02b1` 提交后，在同一现有 worktree 执行 `pnpm build:app` 和 `T22C_EVIDENCE=/tmp/humanagent-p1-ui-rework2 node tests/ui/entry-submit-progress-browser.mjs`，均退出 0。脚本化浏览器看到第一步“正在分派模型请求”、第二步“已收到模型推理摘要”；原先两项摘要断言通过。日志 `/tmp/humanagent-p1-ui-rework2.log`，双视口截图目录 `/tmp/humanagent-p1-ui-rework2/`。

这只验证受影响的脚本化步骤展示，不能证明真实 RCC 或完整候选已通过。作者 `result.md` 仍报告原 UI 测试两项失败，未提供 live-step 超时修复及真实入口证据；未重跑或确认这些项已经解决。任务仍为 FAIL / INCOMPLETE，等待作者完成合同规定的测试与真实入口验收。

后续候选 `85f6cf922` 增加了对包含中文的原始 JSON 的处理。本轮重新编译 UI 测试并运行 `node --test --test-name-pattern 'localizedStepSummary hides unknown provider copy and raw JSON' dist/tests/tests/ui/ui.test.js`，该定向测试通过。此项不覆盖之前未解决的完整 UI 测试、live-step 超时或真实入口验收；任务保持 blocked。
