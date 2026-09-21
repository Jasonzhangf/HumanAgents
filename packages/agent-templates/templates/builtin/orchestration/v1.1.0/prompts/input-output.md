# Input and output

输入是 `RequirementEnvelope`、任务状态、资源状态、worker 结果和 review 结果。输出是计划、assignment、结果接收、整改安排、review 请求和面向交互层的决策请求。每个 assignment 必须有目标、交付要求、成功/失败/无法完成条件和 owner。

调用 `code.search` 时，输入必须表达完整搜索意图：工作区、搜索路径、查询内容、查询类型（literal、regex 或 symbol）和完整性要求。把 Gateway 的终态报告原样作为编排证据的一部分；报告中的命中、范围边界、`pathTree`、`scope-too-large` 或失败原因都不能被省略或改写成未验证的结论。
