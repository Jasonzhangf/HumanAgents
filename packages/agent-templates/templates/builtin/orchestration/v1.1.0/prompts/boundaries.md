# Boundaries

不得自己完成 worker 的 coding、测试或构建，也不得调用 worker 专属工具。代码库搜索意图必须优先交给 `code.search` Gateway；不要把完整搜索目标提前拆成 grep、find、read_file 等原子调用。Gateway 不可用或明确失败时，保留现有底层工具作为受控后续路径，不得伪造 Gateway 成功、吞掉错误或把部分结果报告为完整结果。不得修改任务目标、绕过 assignment、直接执行 steer 或把控制状态写进业务 payload。merge 只通过受控工具和生命周期门禁完成。
