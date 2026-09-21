# Host、安装、Release 与 Session 持久化设计

状态：`DESIGN-CANDIDATE / RUNTIME-HOST-RELEASE-01`

本文把 HumanAgent 从“仓库内可运行的 Harness”收口成“可以从任意 project workspace 启动、恢复和发布的运行时”。它不改变已有的 `core`、`runtime`、Journal、Agent Template 或 Memory owner，也不把 DSH 提升为高层依赖。

## 1. 设计结论

HumanAgent 有两个 cwd 和两个事实面，但只有一个持久化 root：

```text
control plane / explicit Agent cwd
  ~/.humanagent
  ├── internal.toml       系统维护，不由普通用户覆盖
  ├── config.toml         用户 Agent roster 和策略
  ├── user/               全局用户画像
  ├── memory/global/      已批准的跨项目知识
  ├── main/sessions/         显式 Agent 的长期对话 session
  └── sessions/<project-key>/ 每个 workspace 的执行 session、任务历史和项目记忆

execution workspace
  当前命令 cwd 或 --workspace
  └── 只代表本次项目输入和 worker 操作边界，不承载 HumanAgent 持久化
```

显式 Agent 的 `cwd` 永远是 `~/.humanagent`。`~/.humanagent` 是全部持久化数据的唯一 root；项目路径只作为 canonical `workspaceCwd` 进入本次运行上下文。workspace 内禁止写入 session、journal、checkpoint、index、artifact、memory、user profile 和 runtime lock。worker/worktree 必须另行记录，不能通过改变显式 Agent cwd 偷渡控制面。

高层状态仍由 HumanAgent Journal 和 checkpoint 所有；Session Store 只负责宿主进程启动、恢复、退出和跨进程交接。Session 记录必须引用 task/checkpoint，而不能取代它们。

## 2. 运行目录和路径算法

### 2.1 Control root

默认 control root 为 `path.join(os.homedir(), '.humanagent')`。`HUMANAGENT_HOME` 只用于测试或明确的宿主部署配置；普通用户 CLI 不从当前目录猜测 control root。解析后记录 `controlRoot`, `agentCwd`，并要求二者相等。

### 2.2 Project key

启动时将 `cwd` 或 `--workspace` 解析成 canonical absolute path：

1. `realpath` 已存在路径；不存在路径直接拒绝，避免两个拼写指向两个 session。
2. 规范化分隔符为 `/`，保留根路径语义。
3. 将每个 `/` 替换为 `-`；空结果使用 `-`。
4. 将原始 canonical path 写进 `project.json`。如果可读 key 与已有 `project.json` 冲突，在可读 key 后追加 canonical path 的短 digest；目录名不是安全边界，`project.json` 才能证明目录对应哪个 workspace。

macOS 示例：

```text
/Volumes/extension/code/humanagent
→ -Volumes-extension-code-humanagent
```

不允许使用相对路径恢复 session。路径不存在、realpath 失败、project manifest 与 canonical path 不一致，都在 `project-resolve` 阶段失败；不能静默新建另一个 project key。跨平台实现可将 `\\` 归一化成 `/`，但 POSIX 的 `/ → -` 是稳定兼容规则。

### 2.3 Project storage（仍位于 control root）

```text
~/.humanagent/sessions/<project-key>/
  project.json                  canonical path 和 project identity
  config.toml                   可选项目覆盖，只能缩小用户权限
  sessions/
    <session-id>.jsonl           宿主 session 事实
  journal/                       project-scoped domain journal
  checkpoints/                   recovery state 和提交关系
  index/                        可重建 projection
  artifacts/                    不可变大对象引用
  memory/
    project/                     项目长期记忆
    tasks/<task-id>/             单任务记忆
  locks/                         active session lock
  run-notes/                     当前执行交接记录
```

每个新 project 首次启动用原子 `mkdir`/`rename` 创建目录和 `project.json`；已有目录必须先核验 canonical path。不能以 session 文件名反推 project identity。

这里的 “project” 是 control-root 下的 project namespace，不是 project workspace 下的目录。workspace 只读/执行；所有持久化路径必须由 `controlRoot` 和 `projectKey` 拼出，并在启动阶段校验其前缀位于 `~/.humanagent` 内。

## 3. 配置模型

配置遵循：

```text
authoring → parse → validate → compile → load
```

当前 MVP 的 compile/load 边界由 `packages/config` 负责：它复用 `packages/agent-templates` 的角色 ceiling 校验，生成确定的 roster 结果；下一阶段再把这个结果物化为独立的不可变 manifest 文件。runtime 只加载编译后的 manifest，不扫描任意目录。优先级为：

```text
built-in defaults
  → internal.toml
  → ~/.humanagent/config.toml
  → sessions/<project-key>/config.toml
  → 本次 CLI 显式 workspace/profile 参数
```

CLI 只能设置用户可覆盖字段。以下字段永远来自 internal 层：control root、agent cwd、session/journal 根路径、plugin lock、schema 版本、lifecycle gate、控制协议和安全权限上限。

### 3.1 `internal.toml`

系统维护的最小内容：

```toml
schemaVersion = 1
controlRoot = "~/.humanagent"
agentCwd = "~/.humanagent"
sessionRoot = "~/.humanagent/sessions"
pluginManifest = "~/.humanagent/plugins/manifest.json"
releaseChannel = "stable"
configPolicy = "internal-overrides-user"
```

真实路径由 loader 根据 control root 展开；配置中的 `~` 不是 session identity。

### 3.2 `config.toml`

用户可编辑内容：

```toml
schemaVersion = 1

[[agents]]
agentId = "interaction-default"
roleId = "interaction"
templateRef = "builtin/interaction@1.0.0"
driverRef = "fake"
skills = ["input-normalization", "task-matching", "confirmation"]
tools = ["input.receive", "task.query", "proposal.render"]
permissions = ["task.read", "task.propose"]
memoryScopes = ["task", "organ", "approved-global"]
resourceClass = "foreground"

[[agents]]
agentId = "orchestration-default"
roleId = "orchestration"
templateRef = "builtin/orchestration@1.0.0"
driverRef = "fake"
skills = ["stage-planning", "resource-planning", "result-checking"]
tools = ["task.query", "queue.query", "assignment.create", "result.submit"]
permissions = ["task.read", "assignment.create", "review.schedule"]
memoryScopes = ["task", "organ", "approved-global"]
resourceClass = "background"

[project]
defaultAgent = "interaction-default"
reviewRequired = true

[execution]
maxConcurrentTasks = 1
stopTimeoutMs = 30000
```

Agent roster 是显式白名单。每个 `agentId`、role、template、driver、skills、tools、permissions 和 memory scope 都必须通过对应模板及 internal capability ceiling；未知 agent、重复 id、越权 tool 或不能满足 template 的 driver 直接使 config 无效。

## 4. 启动链条

```text
CLI entry
  → resolve controlRoot / agentCwd
  → resolve and canonicalize workspace
  → derive projectKey and verify project.json
  → read internal.toml
  → read user/project config.toml
  → parse + validate + compile immutable runtime manifest
  → resolve plugin manifest and dependency lock
  → probe configured Agent Driver capabilities
  → create/open project storage
  → acquire session lock
  → verify session tail and replay domain checkpoint
  → assemble fixed Harness + Agent roster + Memory ports
  → publish ready
  → accept input / run cycles
```

每阶段都有 owner 和持久化状态：

| 阶段 | owner | 失败状态 | 恢复动作 |
|---|---|---|---|
| `control-resolve` | host | `control-root-invalid` | 修复 home/权限后重试 |
| `workspace-resolve` | host | `workspace-invalid` | 使用存在的绝对 workspace |
| `config-compile` | config loader | `config-invalid` | 修正文件，保留原文件和错误行 |
| `plugin-load` | Cordis host | `plugin-invalid` | 按 lock 安装/回滚，不能 fake fallback |
| `provider-probe` | driver adapter | `provider-unavailable` | 等待依赖或切换已批准 profile |
| `session-open` | session store | `session-corrupt`/`session-locked` | verify/人工处理锁，禁止覆盖活动 session |
| `checkpoint-recall` | runtime | `recovery-blocked` | 保留 Journal，阻断新 operation，生成 Attention |
| `runtime-ready` | Harness | `health-blocked` | 根据 probe 结果恢复或等待 |
| `cycle` | runtime | `waiting`/`failed`/`stopped` | checkpoint completion + next action |

任何失败都必须带 `ownerId`, `errorCode`, `nextAction` 和 evidence ref。启动失败不生成 `ready` 或成功 session。

## 5. Session 持久化

Session 是宿主控制面的一次进程生命周期，推荐状态：

```text
created → opening → ready → running → stopping → stopped
                    └────→ failed
```

JSONL 逐条追加，每条至少包含：

```json
{
  "schemaVersion": 1,
  "sessionId": "session-20260912-001",
  "seq": 3,
  "type": "session.checkpoint",
  "controlCwd": "/Users/me/.humanagent",
  "agentCwd": "/Users/me/.humanagent",
  "workspaceCwd": "/Volumes/extension/code/humanagent",
  "projectKey": "-Volumes-extension-code-humanagent",
  "state": "ready",
  "runtimeManifestDigest": "sha256:...",
  "checkpointRef": "checkpoint:task-1:4",
  "ownerId": "host",
  "occurredAt": "2026-09-12T00:00:00.000Z"
}
```

写入协议：单行 JSON、追加后 flush、写入临时尾部时不推进 seq；open 时逐行解析，重复/断 seq、identity 不一致或非法 terminal transition 显式失败。最后一条不完整 JSON 只能被标记为 recoverable tail 并截断到上一个完整记录，不能当作成功；已提交记录不能被静默改写。

Session resume 只恢复宿主事实和 domain checkpoint；DSH session resume 是否支持由 DSH adapter 单独声明。若 provider 不支持 resume，HumanAgent 只能从自己的 checkpoint 启动新 provider execution，并记录 replay reason。

MVP 的 `run` 完成 create/opening/ready 后交还宿主，session 保持 `ready`，不会伪造已完成的 task；`resume` 是显式的重启入口，只能重新打开同一 project 下的非 terminal session，并重新取得 session lock。真正的 task cycle、checkpoint recall 和 provider replay 由后续 runtime/adapter 阶段接管。

## 6. Memory 分层与画像边界

### 6.1 全局位置

```text
~/.humanagent/user/
  profile.toml          稳定用户偏好、沟通和执行默认
  preferences.jsonl     带来源的偏好变更
  corrections.jsonl     用户纠正，待审核或已确认

~/.humanagent/memory/global/
  journal.jsonl         跨项目已批准知识
  index/                可重建索引
  artifacts/            证据和大对象
  summaries/            有界窗口投影
```

### 6.2 项目位置

```text
~/.humanagent/sessions/<project-key>/memory/
  project/journal.jsonl
  project/index/
  project/artifacts/
  project/summaries/
  tasks/<task-id>/journal.jsonl
  tasks/<task-id>/index/
  tasks/<task-id>/artifacts/
  tasks/<task-id>/summaries/
```

边界固定为：

| 层 | 保存 | 默认写入者 | 用户批准 |
|---|---|---|---|
| user profile | 稳定偏好和纠正后的默认 | profile owner | 是，或明确用户纠正 |
| approved-global | 跨项目复用知识/批准 skill | memory review + registry owner | 必须 |
| project | 项目架构、事实、错误模式和 project skill candidate | memory runtime | candidate 不入全局 |
| task | 单任务历史、重复性、证据引用 | task memory runtime | skill 入库时必须 |
| session | 运行事实、输入输出、checkpoint、operation | host/runtime | 否，不能当长期记忆 |

可见性从窄到宽：`task-local → project → approved-global → user-profile`。Agent context injection 只接受 scope、role、layer、budget 和 source digest；L4 原始细节默认不注入。Index 可删除后重建，任何摘要不能替代 session/domain recovery state。

## 7. Release 链条

当前 release version 的唯一规则见 [`release-version.md`](release-version.md)。标准
release build 使用 `pnpm build:release`：它要求 clean worktree，自动 bump patch
version，同步 package metadata 和本架构记录，提交版本变更，然后执行完整的
checkpointed regression/release chain。它不是普通 `pnpm build` 的别名。

```text
clean candidate
  → version / lock verification
  → build
  → focused tests
  → runtime integration
  → config/template/plugin compile
  → artifact assembly
  → digest + release manifest
  → isolated package install
  → arbitrary-cwd smoke
  → session persistence/restart smoke
  → Astra review
  → user-authorized commit/publish
```

Release manifest 必须绑定：`releaseVersion`、source commit、config schema version、plugin manifest digest、DSH baseline（若该 release 包含 DSH）、artifact digest、测试命令和 review id。发布候选只能从 clean worktree 构建；工作树 dirty、依赖 lock 漂移、缺少真实入口验证或 Astra 未通过时，最多是 local candidate，不是 release。

编译 gate 使用同一份 checkpoint manifest，位置为：

```text
~/.humanagent/build/checkpoints/<project-key>/manifest.json
```

固定 stage 顺序：

```text
typecheck → compile → regression → ci → package → package-smoke
```

其中 `regression` 执行完整 `pnpm test`，`ci` 执行仓库定义的 `pnpm run ci:check`（类型检查加 release-gate 自测），`package` 组装候选 tarball，`package-smoke` 在隔离 prefix 和任意临时 workspace 中安装并验证 doctor/run/session inspect。它们都是独立 checkpoint stage；本轮只要 identity 未变化就复用 PASS，不把“编译命令成功”当作回归或 CI 成功。

每个 stage 的执行 identity 由 `stage name + owner + argv + explicit env + input digest + dependency PASS identities` 组成；可复用证据还绑定声明的 output path digest。输入、执行语义、依赖身份和输出 evidence 未变且上次为 PASS 时标记 `reused`；输出被篡改、缺失或首次失败的 stage 及其下游不复用，修复后从该 stage 重跑。实际执行的 stage 会产生新的 evidence identity，确保依赖的 smoke/review gate 不会复用旧执行结果。前置 PASS stage 不重跑。每个 stage 记录 owner、argv、状态、时间、退出码、stdout/stderr artifact、首个偏离和下一动作；禁止 shell 拼接和吞错。

因此重复执行 `pnpm build:release` 的语义是增量 gate，不是无条件全量回归。依赖、配置、代码、测试或脚本输入发生变化时，identity 传播到受影响 stage；孤立且仍有效的 PASS 保留。

全局安装必须先读取并通过 `release-manifest.json` 的 `release:check`，然后只安装 manifest 绑定且 digest 已验证的绝对 candidate artifact；不按目录中“最新” tarball 选择，也不直接把当前 checkout 的 source link 当 release。安装后验证：

```text
which humanagent
humanagent --version
cd /tmp/another-workspace && humanagent doctor
humanagent run --workspace /tmp/another-workspace --plan default
humanagent resume --workspace /tmp/another-workspace --session <session-id>
restart → session list/resume → checkpoint recall
```

显式对话始终属于显式 Agent，不使用项目执行 session。启动 `serve` 后打开命令
输出的 loopback URL，或直接访问 `/interaction.html`；页面首条业务输入会创建并
持久化显式交互到：

```text
~/.humanagent/main/sessions/explicit-brain.jsonl
```

项目任务 session 则写入：

```text
~/.humanagent/sessions/<project-key>/<session-id>.jsonl
```

卸载只移除本次安装 prefix 中的 CLI；不得删除 `~/.humanagent/main`、
`~/.humanagent/sessions`、user profile 或 memory。数据清理必须有独立命令和明确
target。

## 8. MVP 实现边界和验收

本次 runtime-host slice 完成 iff：

- 任意已存在 workspace 可通过同一 CLI 解析为稳定 project key。
- `controlCwd === agentCwd === ~/.humanagent`，`workspaceCwd` 单独记录。
- internal/user/project config 分层加载，越权覆盖和重复 Agent 显式失败。
- session JSONL 可 create/open/append/close，重启可恢复，损坏尾行不伪造成功。
- user profile、global memory、project memory、task memory 和 session 路径相互分离。
- release build 生成带 digest 的 manifest，并可用相同 artifact 做 isolated install/smoke。
- 启动、release、session、memory 的失败都有 owner、错误码、下一动作；未完成 DSH 验证不被本 slice 升级为 DSH release。

本次不声称：DSH clean version binding、真实 provider resume、生产签名、多节点高可用、RAG/vector backend 或 UI 完成。
