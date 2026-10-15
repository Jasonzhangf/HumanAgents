# HumanAgent 原生推理长程执行 goal

状态：ACTIVE / TOTAL-GOAL-INCOMPLETE / PROVIDER-INCREMENT-OPEN。当前推进和证据以唯一进度记录为准；A–G 生产闭环仍未完成。

完整实施计划：[native-reasoning-implementation-plan-2026-10-08.md](native-reasoning-implementation-plan-2026-10-08.md)。
唯一进度记录：[native-reasoning-progress-2026-10-08.md](native-reasoning-progress-2026-10-08.md)。

当前需求绑定：AppSDK `.appsdk/requirements.json` `version = 14`（当前文件已核对）；业务设计参考：[dual-brain-semantic-context-design-2026-10-11.md](../architecture/dual-brain-semantic-context-design-2026-10-11.md)。每轮按账本当前有效原文执行，设计旧版本不覆盖后续决定。本 chat 主责原生 Provider 分层交付；Runtime/Core 拥有业务 turn、context 装配、标准收口与恢复，UX 由另一 peer 负责其界面需求；三方消费同一需求和 Runtime 运行事实，分别保持唯一 owner。Provider 当前 gap 与能力计划：[native-provider-gap-plan-2026-10-11.md](native-provider-gap-plan-2026-10-11.md)，本轮候选、依赖与状态见唯一进度记录。

```text
/goal
身份：你是 HumanAgent 原生推理完整目标中原生 Provider 分支的编排者。本 chat 主责实际输入合同、独立 binding、三协议请求与工具闭环、Provider/Runtime 协作接口和同入口证据；负责该分支目标拆分、依赖判定、peer 派单、证据验收、集成和自有资源管理。Runtime/Core 与 UX 的共同需求由各自 owner 实现，持续跟踪协同缺口直至完整目标验收。当前宿主是 Codex Desktop/TUI，按 codex-orchestrator 执行；实现交 peer/独立 worker，不亲自实现 peer-owned concrete task。

目标：完成 HumanAgent 自己拥有推理流程的长程运行闭环。先用现有原生 Provider、工具执行、Journal、checkpoint 和 Runtime 做出可用增量，再按必要程度递增到显式/隐式大脑语义历史、子 Agent 交接、历史 checkpoint 前进/回退、路径记忆审计及完整的原生 Provider 机制。ACP、DSH、OpenCode 接入留待后续，不作为本目标依赖或完成条件。

执行前完整读取：
/Volumes/extension/code/humanagent/AGENTS.md
/Volumes/extension/code/humanagent/docs/goals/native-reasoning-implementation-plan-2026-10-08.md
/Volumes/extension/code/humanagent/docs/goals/native-reasoning-progress-2026-10-08.md
/Volumes/extension/code/humanagent/docs/goals/native-provider-gap-plan-2026-10-11.md
/Volumes/extension/code/humanagent/.appsdk/requirements.json
/Volumes/extension/code/humanagent/docs/architecture/provider-adapters.md
/Volumes/extension/code/humanagent/docs/architecture/dual-brain-semantic-context-design-2026-10-11.md
/Users/fanzhang/.agents/skills/codex-orchestrator/SKILL.md
/Users/fanzhang/.agents/skills/codex-orchestrator/references/plan-contract.md
/Users/fanzhang/.agents/skills/codex-orchestrator/references/worker-contract.md

开发原则：整体定义自上而下，实现验证自下而上。基础能力模块化、独立单测、唯一 owner；未证实的基础先补验或修复，不派其上层组合。编排先保核心；每个可用增量验收后，由独立 planner 根据实际结果更新下一增量。不得因局部完成关闭总目标，不提前堆复杂编排。

执行顺序：先消融图节点 → 更新治理程序 → 代码修改。此项前置已按独立计划完成；当前段恢复图与治理引用见 docs/dagpipe/native-turn-segment-recovery.graph.json 及配套 semantic/binding。图仅按实际拓扑变化修订并校验一次，不代替运行证据。当前已接受计划、固定接口、活跃进程与下一可执行任务以唯一进度记录顶部为准；不再等待历史 Planner session 或重复执行已完成前置。

基础能力与后续组合：按唯一进度记录及其引用的已接受独立计划推进。已验收的固定候选可作为下游依赖；已冻结的真实 named 接口可先交接独立开发，不等待整层完成。每条行为在组合后的真实入口分别验收。App/coordinator 最终接线与 Config 保持另一 peer 的单 writer；Provider、Runtime context、Journal 和 save 接口保持本侧明确 owner，边界问题通过 native thread bridge 双向通信。组件编码、纯 controller、受控 fetch 与正常编译只证明对应范围；实际默认入口、完整工具循环、准确五阶段保存、冷恢复和标准交付仍需各自证据。局部证据不关闭完整目标，不以 stub、编译或请求终态宣称自动续推或业务完成。

核心不变量：
1. 主编排上下文由固定身份/规则/有效派单输入、带可信时间和可决策 description 的 checkpoint 历史、完整最新 turn 组成。历史不保留 raw 工具结果；最新 turn 可以包含模型与工具子轮次。Gist 只参考语义记录，不引入其其他算法。
2. 每个实际启用工具都有经过独立审查的语义提取规则。子 Agent 用既有 WorkAssignment/WorkResult 及语义交接引用；派发接受、运行、产物返回、验收通过分别保留事实，不能互相冒充。
3. save 先持久保存准确恢复状态、证据和 checkpoint/closure，再替换历史视图。失败时保留当前 turn、原错和恢复责任。description 足够选择回退点，但不代替恢复状态、权限、operation closure 或验收。
4. Journal 不改写。回退、前进和纠正追加路径事实并创建新执行身份；工具上下文回退与探索路径回退保留结论，外部副作用由原 owner settle/reconcile。Memory Agent 审计路径变化并提出候选，不自行发布规则/记忆。
5. 显式大脑负责用户输入与反馈，可委派受限辅助工作；业务需求仍经 FIFO 和隐式准入。隐式大脑拥有业务子任务编排，模型和子 Agent 不直接改 Journal/Task 控制状态。
6. 原生 Provider 的绑定、配置、能力、请求、协议流、工具返回、错误、stop/settle 与恢复形成可验证闭环。Responses、OpenAI Chat、Anthropic 各自验收；任何 advertised capability 都要有同入口证据。不能把 RCC 入口标签当成厂商身份；不修改 RCC 配置或提交凭据。
7. 检查实际发送请求：上一 turn 的 raw、Provider 隐藏历史和 previous-response 链不能悄悄进入新 turn。协议 continuation 只能服务本 turn 的工具配对；跨 turn 使用 HumanAgent 的语义 checkpoint。
8. 按 AppSDK `.appsdk/requirements.json` 当前版本的有效原文实现双脑业务（当前账本 `version = 14`）：显式大脑保留最新一个 turn 的完整语义，前序任务为任务语义 checkpoints；预算内 N 个隐式 runtime 各自独立编排。探索、plan、review、execute 由编排者选择，可重复和并行调用；主要依赖独立 subagent 执行并接收精炼结果。每次调用建立 checkpoint。turn 结束强制形成目标、做了什么、结果、下一步四项语义 checkpoint，随后 planner 对齐目标和计划；迭代至任务完成或失败。各 subagent 可独立选择 provider/model/context，不继承编排者 context。不得再引入固定四角色顺序。若账本继续变化，以当前账本为准并在受影响实现前更新绑定。
9. 通用临时续推依据显式派单模板与真实任务状态，不要求上下文必有goal/阶段结果字段；只参与当次请求，不进入后续上下文。简单问答由显式大脑直接回答结束；复杂问题整理为标准任务。不得增加重复模型control block或是否简单问答/任务完成布尔标签。

执行与记录：按最新 codex-orchestrator 路由执行。观察/实现默认 fresh gcm，不可用时才用 gemini-3.8-flash 后备；新 Planner/Reviewer 优先独立 AGY Gemini 4，不可用时才用 fresh oauth/gpt-6.1-sol，已有有效计划不重做。observation 落盘后交独立 Planner；采用 peer 优先和新建 worker 合同，不用内置 Agent 槽位、resume/fork 或 Collab 注册作为前提。代码在 /Volumes/Intel/playground/humanagent/<task> 的独立 clean worktree；主树 dirty 分类后保留，不提交他人未归属改动。任务状态与证据更新到上述唯一进度记录，执行前恢复该记录；不依赖聊天历史猜状态。

验收：逐层 focused 单测、负向契约与录制 replay；可用增量完成真实原生入口/黑盒验证后再做适用独立 review。最终必须证明两类大脑长程续跑、语义质量、历史 raw 排除、重启、工具纠正与探索回退/前进、Memory 路径审计、原生协议隔离、失败可见和资源收拢。图拓扑通过不代替运行 PASS。精确记录 candidate、测试数量、真实 receipt、review、main 集成、重建/重启、运行复验、remote 与清理各层证据。

交付：沿项目已授权标准流程自动完成候选、独立 review、main 集成、重建并重启本地实例、修复验证、push origin/main；保留全部适用前置条件。按最新 SESE 生命周期：同域最多一个活动 worktree，续派复用原树；需换树先提取证据和有效改动，再 remove/prune 并确认旧路径消失。多子任务提取为明确候选 commit，经唯一集成分支做标准 Git 合流，不跨散落树手工拷文件。存量先四分类；已合流或废弃且归档后当轮核销自有资源，active/dirty/他人及归属未决资源保留并列原因。缺证据标 UNVERIFIED/INCOMPLETE；新发现改变目标或依赖时重观察并交独立 planner，不伪造 PASS、不静默 fallback。

直接执行该目标，不再为它生成另一层提示词。持续推进直至完整目标验收成立；外部阻塞保留原错、恢复条件与下一可执行动作。
```
