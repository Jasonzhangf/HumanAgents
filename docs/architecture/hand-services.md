# Hand 基础服务与自检边界

状态：`MVP-IMPLEMENTATION / TASK-GATEWAY-DESIGN-REVISION`
范围：Hand Task Gateway 的服务契约、Function Harness、自检与 Memory Agent 边界

完整的任务级设计、模型路由、recipe、递归状态机和动态服务注册见
[`hand-task-gateway.md`](hand-task-gateway.md)。本文保留 `code.search` 的具体服务契约，作为第一条已实现服务的实现基线；不得再把 Hand 解释为只有一个搜索 route 的薄 wrapper。

## 1. 在线职责

Hand 对外提供的是能减少主 Agent 连续工具调用的高层任务服务，不是原子工具目录，也不只是一次 operation 的委任入口。一个服务可以内部调用多个函数、多个 operation、多个模型轮次，并在最终交付前完成验证和失败收拢。

```text
编排 Agent
  → Hand Task Gateway / semantic service
  → route snapshot + task state machine
  → Operation Gateway
  → route / Function Harness / model executor
  → verifier
  → 完整任务报告 artifact
```

Hand 不对外暴露 `read_file`、`grep`、`list_files`、`diff` 或 `apply_patch`。这些是服务内部可以使用的函数。只有把多个步骤、范围控制、结果汇总和完整性判断封装成一个可复现服务，才有资格注册为 Hand service。

第一条基础服务是 `code.search@1.0.0`。它验证了 Hand 服务必须同时拥有高层输入契约、内部 function harness、范围控制、完整性报告、失败分类、route 注册和 verifier。后续 `code.edit`、`code.test`、`code.build` 和 `git.workflow` 必须满足同一资格线，不能只注册一个模型工具名。

`code.search` 高层输入使用 `CodeSearchRequest`，结果使用 `CodeSearchReport`，并固定区分：

- `matchesFound`：实际发现的匹配总数；
- `matches`：返回的匹配集合，受 `maxResults` 限制；
- `searchComplete`：请求范围是否完整检查；
- `unresolvedPaths`：未能检查的路径；
- `status`：服务是否接受了可信结果。

因此“找到一个结果”和“完成指定范围内的搜索”不会被混成一个成功标志。`requireComplete=true` 时，只要范围不完整就返回结构化 `search-incomplete` 失败；否则可以返回 `status=succeeded` 且 `searchComplete=false` 的部分结果，交给上层决定是否继续。

## 2. 基础自检标准

每个服务至少要有四类自检：

1. 输入契约：版本、路径边界、查询类型和参数范围；
2. 正常能力：递归搜索、符号边界、上下文、排序和结果上限；
3. 不完整与失败：读取失败、范围逃逸、无效表达式，必须保留原始影响并稳定返回；
4. 生命周期集成：一次 Hand operation 覆盖内部多次函数调用，成功、失败、replay 和 Gateway Journal 均可验证。

`runCodeSearchBenchmark` 是服务级回放入口。耗时只作为观测数据，不作为正确性补偿；正确性以固定报告断言为准。性能筛选另行记录首结果、完整结果和总耗时，不能因为超时把不完整结果包装成成功。

服务有界并发读取，但不接受无界 workspace 扫描：默认最多准入 20,000 个候选文件。内部 discovery 发现第 20,001 个候选时立即早停，先返回受深度/节点数限制的 `pathTree`，同时以 `scope-too-large` 明确报告范围过大，且不读取文件；上层根据 tree 把 `path` 收窄到源码目录或具体模块后重试。这样大仓库仍可搜索，历史 worktree、控制面和生成物混在根目录时也不会把 Hand 变成长时间后台扫描。`pathTree` 是本次报告的 bounded 结果，不是 Harness 的权威持久化 artifact；完整报告和恢复事实仍由 Task Journal/`~/.humanagent` 保存。

## 3. Memory Agent 边界

基础服务在线运行不依赖 Memory Agent。没有记忆服务时，`code.search` 的契约、自检、harness、verifier、注册和失败报告仍必须完整可用。

Memory Agent 是低优先级 idle 工作，不能修改当前 operation 的已绑定版本，也不能插入 Hand 成功路径。它有三项职责：

1. 读取已有 Gateway service 的历史执行、失败、重试、耗时和完整性数据，统计稳定性并提出优化候选；
2. 读取编排 Agent 的历史，发现反复出现且能减少主 Agent 调用量的连续任务，形成新的 service/harness/verifier/benchmark/registration 候选；
3. 在候选通过回放、回归、权限和完整性检查后，提出版本升级或注册上线建议。

候选服务必须经过固定版本、benchmark 和 review 才能上线。Memory Agent 只能产出 review/candidate，不能无审查地直接改 active service。历史分析失败只产生 Memory attention，不降低当前 Hand service 的验收标准，也不伪造优化完成。
