# Control block 消融候选：入口与收口证据

对象：项目 D19 / bug `69f2101`。状态：静态调用核查及现有编译测试回放；不是生产缺陷复现，也不是删除方案或删除授权。

## 当前结论

- 有效需求 `humanagent-generic-reorientation-prompt-and-boolean-stop-control` v2 要求移除重复模型 control block，简单问答直接结束，复杂任务根据已有任务真相决定是否继续。`appsdk requirements show` 本次确认该条 active。
- `packages/app/src/cli.ts:1907` 在 `serve` 启动时创建 `createServeRuntimeComposition`；`packages/app/src/serve-runtime.ts:169-179` 创建的是带 `createRequest` 闭包的 `agentIo` 对象。创建闭包不等于调用该闭包。
- `packages/app/src/cli.ts:1967-2000` 传入 UI runtime 的相关能力是 `createTaskAssembly`；`packages/app/src/ui-runtime/index.ts:558-560` 继续传递该能力。在仓库 `packages/`、`tests/` 的 TS/JS/MJS 文本检索中，未发现 `agentIo.createRequest` 生产调用，`AgentIoRequestCoordinator.create` 的直接调用位于该闭包及 `tests/runtime/agent-io/agent-io.test.ts`。公开导出、动态访问、外部消费者及实际运行时调用仍未排除。
- 若调用到该 coordinator，`packages/runtime/src/agent-io/request.ts:324-354` 会解码并发布 control block。`:374-407` 对缺少非空 `summary` 进入 repair，超过策略上限后以 `protocol-noncompliant` 关闭；`:415-421` 接受含 summary 的结束。summary 是该组件的收口条件，并非可以连同解析器直接删除而不改变行为。
- 因此，当前证据支持“代码与可组装入口保留已撤回机制”；不支持“当前 UI 的真实请求已走入此分支”或“线上真实用户请求已受影响”。`docs/dagpipe/turn-continuation-request.graph.json:26` 明确目标续推无 model control block，需按实际消费者先判定这个遗留对象是否属于同一对象流。

## 验证回执与局限

- 调用关系：`/opt/homebrew/bin/nn-code calls --repo /Volumes/extension/code/humanagent --entry-file packages/app/src/serve-runtime.ts --entry-symbol createServeRuntimeComposition --max-depth 1 --scope packages/app/src --compact` 返回 `achieved/complete`。它覆盖静态深度 1；闭包成员及 runtime 跨 scope 的调用关系以上述源码与仓库文本搜索另行核查，不冒称工具解析结果。
- 运行已存在的编译测试：`node --test --test-name-pattern 'missing end-turn summary enters bounded repair' dist/tests/runtime/agent-io/tests/runtime/agent-io/agent-io.test.js` 通过。源码断言在 `tests/runtime/agent-io/agent-io.test.ts:708-733`：缺 summary 先要求 repair，超过上限进入 failed。未重建编译产物，不能据此证明当前源码与产物完全一致，也不是用户入口黑盒。

## 交给执行者的验证条件

1. 从正式 `serve` 的新建任务和简单直答入口捕获实际被调用的 coordinator/turn owner，覆盖直接引用、注入和动态访问，确认本组件是否可达；外部消费者或历史入口未清前保留候选状态。
2. 若该路径可达，以当前源码构建的隔离候选重现不带 control block 的正常响应：验证是否进入 repair 或关闭；验证已完成任务及未完成续推的真实任务状态。
3. 按需求先校正受影响图，再比对保留的任务真相、提交及恢复语义；针对可达失败模式先红测，再按唯一 owner 实施。不可简单移除 summary 条件后伪造任务完成。
4. 用真实用户入口验证简单直答、复杂任务完成、未完成续推、错误与副作用；核对 stop、checkpoint 和恢复责任。最终只删除无独立保障的专属代码及测试。
