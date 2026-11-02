# 架构审计与计划验证记录

日期：2026-10-24（America/Los_Angeles）。本轮目标仅为架构检查、最小分层测试方案、DAG 缺口图与执行计划。

## 输入与边界

- 当前项目：`/Volumes/extension/code/humanagent`。
- 起始 `git status --short` 无输出；`git log -6 --oneline` 自然回执的最新条目为 `8a6fe5dea`。
- package.json：`version=0.1.40`、`releaseVersion=0.1.0040`。
- `.appsdk/requirements.json`：version 19，19 次变更，按 requirement_id 折叠后为 17 项当前需求。
- 本地 main 相对缓存的 origin/main ahead 12；未 fetch，不据此声称实时远端状态。note 中另有待整体审查工作，未替其推送。
- 没有产品代码修改、构建、产品测试、真实 Provider 调用、业务任务创建、安装或重启。

## 已执行检查

| 检查 | 实际结果 | 证明边界 |
|---|---|---|
| `node scripts/dagpipe-validate-graphs.mjs` | `validated 30 DAGpipe graph(s)`，无错误 | 现有业务图拓扑、中文标签、owner 文件与绑定形状；不证明调用/运行 |
| `dagpipe graph validate docs/dagpipe/mvp-test-path-2026-10-24/acceptance.graph.json` | valid DAG，12 nodes、15 edges、8 waves | 新增验收依赖图单源单汇与无环拓扑 |
| `dagpipe graph inspect docs/dagpipe/mvp-test-path-2026-10-24/acceptance.graph.json` | 12 个 operator 标签与 8 个执行依赖批次可读 | 仅审计责任标签；未注册/运行新的 Runtime Operator |
| 有效需求与标签定向检查 | 17 项有效需求；图的每个节点均有中文标签 | 文档/机器图一致性 |

现有图校验原始回执已移交到同目录 [existing-dag-validation.log](existing-dag-validation.log)。本文件保留交付所需的结果与边界。

## 核实的静态事实

- `packages/config/src/index.ts` 已有 default product 读写与产品 root 解析。
- `packages/app/src/ui-runtime/service.ts` 的 `persistAuthorizedExecutionPlan` 已调用 subscription port.create。
- `packages/app/src/ui-runtime/server.ts` 和 `docs/ui/runtime-api.js` 已有 checkpoint reentry/context correction 接口。
- `packages/runtime/src/agent-loop/inspection-turn-boundary.ts` 已实现并被 App inspection composition 使用。
- `packages/app/src/supervisor/supervisor.ts` 的 lease 仅保留最近 takeover；`packages/app/src/explicit-brain-runtime.ts` 用该记录比对旧 turn owner。
- `packages/app/src/ui-runtime/index.ts` 仍组装 InMemoryAttentionPort；持久 Attention 的实际恢复影响本次未测试。
- `tests/app/real-ui-provider-loop.mjs` 只选择 responses/openai，持久 root 位于其 tmp 目录、receipt 默认 dist，并包含源码摘要计算。该脚本本次未运行。
- package/scripts/release 的显式测试链没有包含报告 G03 所列五组关键 consumer；批量文件名筛选结果仅作候选定位，未声称所有未列文件均无其他入口。

## 未执行与原错区分

note.md 记载的跨代入口锁死、delta 无进展、14 项 compiled-services 失败和 ui-runtime cancelled 是历史证据。本次没有重放或重跑。报告分别标为机制静态确认、历史事故待复现或历史 gate 失败待复核。

Mermaid 以中文业务标签和一致色彩表达。源码已检查；未进行浏览器渲染验收。新图是执行计划，不是产品业务实现，也不计入现有 30 张业务图的运行证明。

本轮独立 Planner 使用外部 AGY CLI、新会话、只读合同。请求及 init 实际型号均为 `gemini-4-argon-medium`，显式 effort medium。conversation_id 为 `a394f410-3bf0-4384-8210-d7c02fb4ae4a`；完整结果由宿主接收后落入执行计划。它是独立规划，不是代码 milestone Review。

首稿接收发现 contracts 测试输出目录错误、失败路径进入正式 Review/交付的歧义，以及尚未动态证实就预定 Attention 存储改造的问题。独立 Planner 续修后已纠正；首稿未作为执行依据。首轮与修订轮均返回 result SUCCESS、CLI exit 0。宿主另按项目当前规则校准了交付顺序、单任务成功与失败用例的区分，以及标准停止和可恢复中断的不同语义。

最终文件链接、代码块闭合、行尾空白与命令名做了定向检查，通过。执行计划中的 contracts 输出路径已对照 tests/contracts/tsconfig.json 校正为 dist/tests/tests/contracts。报告未把测试命令存在记作测试通过。

本轮只创建文档与独立规划进程，没有创建产品 worktree、测试 Task、Provider 请求或服务实例。两个自有规划进程已退出。必要校验回执和修订后的计划已移交仓库；外置临时规划目录在移交后按本任务归属清理，不触碰现有 worktree 或他人记录。
