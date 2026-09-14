# Goal：HumanAgent 基础开发与运行脚手架

```text
/goal
目标：在 HumanAgent 当前 main 基线之上完成基础开发与运行脚手架，使项目可以在任意 project workspace 通过统一入口完成配置加载、doctor、编译、回归、可重入 release gate、打包和 smoke；不实现 DSH adapter、UI 真实接入或多 Agent 编排。

范围与约束：
- 先读取项目 AGENTS.md、docs/goals/foundation-ui-dsh-plan.md 和现有 package/scripts/tests，复用现有 owner；不得另起第二套配置、checkpoint、release 或启动实现。
- 允许修改：packages/config、packages/app、packages/contracts（仅必要契约）、scripts、tests/release、tests/config、tests/app、package.json、README.md 和与本目标直接相关的 docs。
- 禁止修改：packages/adapters/dsh 的真实适配、UI 产品实现、Memory/RAG、多 Agent 编排、RCC 配置和 secret；不得把 DSH/RCC 类型提升为高层领域类型。
- `~/.humanagent` 是唯一持久化 root；project workspace 只提供执行上下文。session、Journal、checkpoint、index、artifact、memory 和 profile 不得写入 project workspace。
- 保留用户已有 dirty 文档和未相关修改；不在 main、dirty main 或他人 worktree 中开发。需要代码变更时从当前 main 基线创建独立 clean worktree，并只修改声明范围。
- 配置分为用户可编辑的 config.toml 与内部 internal.toml；固定加载顺序、校验错误和敏感字段边界。RCC `~/.rcc` 只读验证，不修改。
- release/checkpoint 必须可重入：输入和依赖未变化且已通过的阶段复用；从第一个失效阶段继续；不得跳过失败或伪造成功。
- 每个启动、构建、release、package 和 smoke 错误都必须有 owner、下一动作和可追溯 evidence；不吞错、不用 fallback 伪造可用。

依据：docs/goals/foundation-ui-dsh-plan.md；现有 scripts/checkpoint-runner.mjs、scripts/check-release.mjs、scripts/build-release.mjs、packages/config 和 packages/app。

实现任务：
1. 盘点当前启动、配置、构建、release 和 smoke 入口，列出唯一 owner 与缺口。
2. 固定并实现 `~/.humanagent` control root、project key、session/checkpoint/artifact/profile 路径派生；用绝对路径验证 project workspace 边界。
3. 完成 internal.toml/config.toml 的最小 schema、加载顺序、校验和错误输出；不得让 UI 或 adapter 各自解析 TOML。
4. 收口统一 CLI/脚本入口：doctor、build、test、ci、release、package 和 smoke；已有命令能复用就不新增同义命令。
5. 将 typecheck、compile、regression、ci、package、package-smoke 纳入同一个可重入 gate；保留每阶段输入/输出 digest、owner、run identity 和复用证据。
6. 为启动链和 release 链补 focused tests：路径隔离、配置优先级、未知字段/缺字段、无效 workspace、重入跳过、从失败处继续、dirty source 拒绝、package smoke 和真实错误出口。
7. 更新最小 README/开发文档，给出从任意项目目录启动、查询状态、运行回归和定位 checkpoint 的可复制命令。

验收：
- `pnpm run typecheck` 通过。
- `pnpm run test:release` 通过，且证明已通过阶段可复用、失败阶段可重入。
- `pnpm run test:config` 与 `pnpm run test:app` 通过；如新增 gate，加入对应 focused test。
- `pnpm run ci:check` 通过。
- `pnpm run build:release`、`pnpm run release:check`、`pnpm run package:smoke` 在 clean candidate 上通过；如当前 release 入口需要显式参数，补齐并记录实际命令。
- 以临时 project workspace 运行 doctor/run smoke，证实持久化文件只落在 `~/.humanagent`，并能从 checkpoint 继续。
- 独立 Astra review PASS；P0/P1 = 0。review 只检查本目标范围，发现问题先修复再重跑受影响 gate。
- merge/push 前报告 commit、origin/main、工作树、测试结果和未完成项；不得宣称 DSH/UI/多 Agent 已完成。

完成信号：
输出 `FOUNDATION_SCAFFOLD_COMPLETE`，并附上：变更文件、命令及退出码、release checkpoint 复用/重入证据、路径隔离证据、Astra review receipt、commit 和远端同步结果。

直接执行本任务，不再为它生成一层提示词。
```
