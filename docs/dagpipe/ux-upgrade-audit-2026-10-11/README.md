# HumanAgent UX 图册：语义分层、双端排版与四角配置

需求库版本 13。默认入口：[面向人的 UX 图与展示示意](index.html)。内部产品运行图保留在 [运行结构图册](runtime-design.html)，不与默认展示层级堆放。

[分层显示正文](../../ui/human-readable-layered-ux-design-2026-10-11.md)逐层说明用途、必须显示什么、出现条件与默认隐藏项。手机以下方抽屉进入下一层，桌面旁侧展开；主动配置在四个角落。示意内容有明确标签，不是实际任务或产品验收。

## 从提问到结果：只展示这次交互需要的内容

对话先服务用户问题。普通问答直接回答；需要持续处理的需求才出现任务目标与进展。信息缺口只问具体问题，不把整个内部任务模型变成输入表单。

```mermaid
flowchart TB
 I[说出问题或需求]:::derived
 D{这次是否需要持续处理}:::derived
 A[直接回答问题]:::derived
 Z[本次问答结束<br/>不出现空任务卡或执行流程]:::derived
 T[整理要完成的事<br/>只补充无法可靠获知的必要信息]:::derived
 C[任务已收到<br/>显示人类可读目标与当前状态]:::derived
 P[真实进展／结果／必要决定]:::derived
 R[获得成果或清楚知道未完成原因]:::derived
 I --> D
 D -->|普通问答| A --> Z
 D -->|需要持续处理| T --> C --> P --> R

classDef truth fill:#dbeafe,stroke:#1d4ed8,color:#1e3a8a,stroke-width:2px;
classDef derived fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e;
classDef design fill:#fef3c7,stroke:#d97706,color:#78350f,stroke-dasharray:5 3;
classDef gap fill:#fee2e2,stroke:#dc2626,color:#7f1d1d,stroke-width:2px;
classDef evidence fill:#f1f5f9,stroke:#64748b,color:#334155;
```

## 逐层阅读：每层有用途，不必逐层走完

层级是用户选择的阅读深度。概要不复制全部细节；需要决定的内容、结果与重要失败可直接访问。技术记录只有明确需要时出现。 桌面按主内容旁的面板展开；手机下一层统一从底部抽屉进入，返回上一层保留位置。

```mermaid
flowchart TB
 A[对话入口<br/>用途：说需求、得到答案<br/>显示：问题、回答、必要追问]:::derived
 B[任务总览<br/>用途：找到需要关注的事<br/>显示：目标、状态、必要行动、结果入口]:::derived
 C[任务详情<br/>用途：理解并处理这一件事<br/>显示：当前工作、已有结果、影响与下一步]:::derived
 D[处理经过<br/>用途：理解结论和方案变化<br/>显示：真实步骤、原因、阶段回顾]:::derived
 E[资料与证据<br/>用途：查成果、核对依据<br/>显示：名称、摘要、关联结论、内容]:::derived
 F[技术记录<br/>用途：定位实现问题<br/>仅明确要求时打开]:::evidence
 A -->|存在复杂任务或主动查看| B
 B -->|打开某件事| C
 C -->|需要解释过程| D
 C -->|直接取得成果或核对| E
 D -->|查看对应依据| E
 E -.->|明确需要技术诊断| F

classDef truth fill:#dbeafe,stroke:#1d4ed8,color:#1e3a8a,stroke-width:2px;
classDef derived fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e;
classDef design fill:#fef3c7,stroke:#d97706,color:#78350f,stroke-dasharray:5 3;
classDef gap fill:#fee2e2,stroke:#dc2626,color:#7f1d1d,stroke-width:2px;
classDef evidence fill:#f1f5f9,stroke:#64748b,color:#334155;
```

## 桌面与手机：同一语义，不同展开方式

阅读层级和语义不变。桌面让主内容与下一层并列，手机用同一个底部抽屉递进；返回上一层保留阅读位置，关闭回到原入口，不堆叠多个抽屉。

```mermaid
flowchart TB
 I[点击任务、结果或过程入口]:::derived
 D{当前阅读设备}:::derived
 W[桌面：主内容保留<br/>旁侧面板展开下一层]:::derived
 M[手机：底部弹出抽屉<br/>显示当前层内容]:::derived
 N[再打开下一层<br/>保持任务与来源关联]:::derived
 B[返回上一层<br/>保留选择与阅读位置]:::derived
 C[关闭展开内容<br/>回到原入口并恢复焦点]:::derived
 I --> D
 D -->|桌面| W --> N
 D -->|手机| M --> N
 N --> B
 B --> C

classDef truth fill:#dbeafe,stroke:#1d4ed8,color:#1e3a8a,stroke-width:2px;
classDef derived fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e;
classDef design fill:#fef3c7,stroke:#d97706,color:#78350f,stroke-dasharray:5 3;
classDef gap fill:#fee2e2,stroke:#dc2626,color:#7f1d1d,stroke-width:2px;
classDef evidence fill:#f1f5f9,stroke:#64748b,color:#334155;
```

## 主动配置：四个角落入口

四角持续可见的按钮是主动配置入口，内容中的结果/决定/阅读入口是当前工作的一部分，不是第五个全局配置按钮。每个表面沿用同一位置和职责；配置内容只列当前真实可用项，不改变阅读层级或绕过原任务控制 owner。该位置已进入设计，产品壳目前尚未实现。

```mermaid
flowchart TB
 L[左上配置按钮<br/>范围：当前对话／任务]:::derived
 R[右上配置按钮<br/>查看：当前进展／历史]:::derived
 C[中心：当前内容<br/>问题／答案／目标／结果／必要行动<br/>没有无关设置栏]:::derived
 B[左下配置按钮<br/>显示：字号／主题]:::derived
 I[右下配置按钮<br/>输入：输入方式]:::derived
 P[点击配置按钮展开<br/>手机底部抽屉，桌面旁侧面板]:::derived
 L --> P
 R --> P
 B --> P
 I --> P
 P -->|仅改变对应偏好或查看选择| C

classDef truth fill:#dbeafe,stroke:#1d4ed8,color:#1e3a8a,stroke-width:2px;
classDef derived fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e;
classDef design fill:#fef3c7,stroke:#d97706,color:#78350f,stroke-dasharray:5 3;
classDef gap fill:#fee2e2,stroke:#dc2626,color:#7f1d1d,stroke-width:2px;
classDef evidence fill:#f1f5f9,stroke:#64748b,color:#334155;
```

## 当前层显示什么：按用户问题决定必要性

只显示服务当前阅读/决定的信息；无内容区域、重复摘要、纯内部字段不显示。隐藏技术细节不隐藏失败、未知或影响。

```mermaid
flowchart LR
 I[同一份真实任务语义]:::truth
 Q{是否帮助当前层回答<br/>发生什么／得到什么／需我决定吗<br/>能做什么／依据是什么}:::derived
 S[必要：在当前区域显示<br/>用清楚的业务语言]:::derived
 D[只对深入阅读有用<br/>按需展开，不堆在概要]:::derived
 H[不必要／重复／无当前内容<br/>不渲染该区域]:::evidence
 I --> Q
 Q -->|直接有用| S
 Q -->|深入时有用| D
 Q -->|没有用途或没有内容| H

classDef truth fill:#dbeafe,stroke:#1d4ed8,color:#1e3a8a,stroke-width:2px;
classDef derived fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e;
classDef design fill:#fef3c7,stroke:#d97706,color:#78350f,stroke-dasharray:5 3;
classDef gap fill:#fee2e2,stroke:#dc2626,color:#7f1d1d,stroke-width:2px;
classDef evidence fill:#f1f5f9,stroke:#64748b,color:#334155;
```

## 从真实工作到人类可读呈现

语义来自共同事实链，界面只按当前用途组织与呈现。未知保持未知；不把一次请求结束或一个工具结果翻译成任务已完成。详细实现 owner 在设计正文中，默认阅读图不露出代码名。

```mermaid
flowchart LR
 I[已确认的工作事实与责任]:::truth
 S[统一解释发生了什么<br/>保留来源、条件和未知]:::derived
 V[按当前阅读层组织<br/>目标／状态／结果／必要行动]:::derived
 F[选出当前必要区域<br/>其余不显示或按需展开]:::derived
 U[人类可读标题、句子与操作]:::derived
 E[主动打开资料或技术记录]:::evidence
 I --> S --> V --> F --> U
 U -->|核对依据时| E

classDef truth fill:#dbeafe,stroke:#1d4ed8,color:#1e3a8a,stroke-width:2px;
classDef derived fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e;
classDef design fill:#fef3c7,stroke:#d97706,color:#78350f,stroke-dasharray:5 3;
classDef gap fill:#fee2e2,stroke:#dc2626,color:#7f1d1d,stroke-width:2px;
classDef evidence fill:#f1f5f9,stroke:#64748b,color:#334155;
```

## 状态与行动：在用户需要的时候出现

以下是表达结构而非新增状态机。需要决定、暂停、未知、过期都必须说明其真实影响；操作只显示当前实际允许的动作。

```mermaid
flowchart TB
 I[当前真实状态与已确认结果]:::truth
 A[处理中<br/>显示正在做什么与已得到什么<br/>没有成果时不放空成果栏]:::derived
 D[需要决定<br/>显示原因、影响与必要选项<br/>不把决定埋在过程里]:::derived
 P[暂停或结果未确认<br/>说明已知影响、未知部分与可用下一步]:::derived
 Z[已完成<br/>成果优先，过程按需查看<br/>不再显示进行中动画]:::derived
 S[新进展暂不可读<br/>保留上次内容并说明尚未更新]:::derived
 I -->|有实际活动| A
 I -->|确需用户决定| D
 I -->|暂停／未知| P
 I -->|真实完成| Z
 I -->|读取失败／过期| S

classDef truth fill:#dbeafe,stroke:#1d4ed8,color:#1e3a8a,stroke-width:2px;
classDef derived fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e;
classDef design fill:#fef3c7,stroke:#d97706,color:#78350f,stroke-dasharray:5 3;
classDef gap fill:#fee2e2,stroke:#dc2626,color:#7f1d1d,stroke-width:2px;
classDef evidence fill:#f1f5f9,stroke:#64748b,color:#334155;
```

## 处理经过：展示真实工作，不展示固定角色骨架

只有用户要理解过程或恢复时展开。多次探索/计划等显示为实际业务进展与调整原因，不变成四个永远占位的角色卡。查看旧回顾不改变正在执行的状态。

```mermaid
flowchart LR
 I[用户打开处理经过]:::derived
 W[真实发生的工作与结果<br/>例如补充查找、核对、整理]:::derived
 C[确有方案变化时<br/>说明为什么改、改了什么]:::derived
 H[确有已保存进展时<br/>阶段回顾：当时目标、已做工作<br/>结果与接下来打算]:::derived
 V[当前进展与正在看的旧记录<br/>分别标明，查看只读]:::derived
 I --> W
 W -->|发生过调整| C
 W -->|需要复盘或恢复| H --> V

classDef truth fill:#dbeafe,stroke:#1d4ed8,color:#1e3a8a,stroke-width:2px;
classDef derived fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e;
classDef design fill:#fef3c7,stroke:#d97706,color:#78350f,stroke-dasharray:5 3;
classDef gap fill:#fee2e2,stroke:#dc2626,color:#7f1d1d,stroke-width:2px;
classDef evidence fill:#f1f5f9,stroke:#64748b,color:#334155;
```

## 资料与证据：先看内容，技术记录最后展开

成果可从任务详情直接打开。资料层回答这份材料是什么、支持哪个结论；代码/结构化文件如果本来就是成果可直接看。原始协议和内部标识仅用于主动技术诊断。

```mermaid
flowchart LR
 I[用户打开成果或结论依据]:::derived
 N[名称与内容摘要<br/>说明这份材料有什么用]:::derived
 C[查看实际内容<br/>关联它支持的结论]:::derived
 Q[需要定位实现问题时<br/>主动打开技术记录]:::evidence
 R[查看相关原始记录与关联信息<br/>不回流成业务状态]:::evidence
 I --> N --> C
 C -.->|明确需要技术细节| Q --> R

classDef truth fill:#dbeafe,stroke:#1d4ed8,color:#1e3a8a,stroke-width:2px;
classDef derived fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e;
classDef design fill:#fef3c7,stroke:#d97706,color:#78350f,stroke-dasharray:5 3;
classDef gap fill:#fee2e2,stroke:#dc2626,color:#7f1d1d,stroke-width:2px;
classDef evidence fill:#f1f5f9,stroke:#64748b,color:#334155;
```

## 设计 owner 与来源

| 产品真相／派生结果 | 唯一 owner |
|---|---|
| 生命周期、Brain 队列规则、错误策略、steer、恢复许可 | packages/core |
| 分类/准入、Pipeline、调度、窗口、checkpoint、恢复编排 | packages/runtime |
| 权威 Organ Journal | packages/adapters/jsonl |
| 不可变资产与工具输出 | packages/adapters/filesystem |
| 共同 canonical/pairing/narrative/digest | packages/context-events |
| 展示投影、产品控件、viewed 选择 | packages/ui 与既有 docs/ui 产品壳 |
| 配置、项目/control-root 路径、展示偏好配置合同 | packages/config |
| 公开 API 与组装 | packages/app |

- [UX 核心框架](../../ui/ux-core-framework-2026-10-10.md)
- [框架修订：真相与派生、模式与视角分离](../../ui/ux-core-framework-amendment-2026-10-11.md)
- [权威 UX 需求](../../ui/semantic-observation-audit-2026-10-07.md)
- [项目 owner 规则](../../../AGENTS.md)

本图册只修正文档表达。后台错误消费、三模板、revision 历史、多视角与 checkpoint 产品查询等黄色边仍是待实现/待证实设计，不能当作已落地能力。展示偏好的持久边已在图 12 落地：`packages/config` 的 `[ui.display]` 存 `<controlRoot>/config.toml`，`packages/app` 暴露 `/api/ui/display-preference` 的 GET/PUT/DELETE，共享控制器挂载在 task-dashboard 与 observation 两个表面；整体事件与共享消费者边、其他共享壳页面接入仍未闭合。





UX 对象流 `human-readable-ux-reading.graph.json` 只做静态拓扑检查，未声称生产接线或行为验收。
