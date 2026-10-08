# 静态语义观测 Tour 浏览器验收

验收对象：`docs/ui/semantic-observation-tour.html`。输入基线：`9d1f39c53f09e31a4636fa75f97042c18e8bb114`。最终 HTML SHA256：`558fd1f961f54ecc6787e85cf045c896a798e8b65c44715f58655d619078f91a`。2026-10-08，Ego TaskSpace 7 / p1，从父候选实际 `file://` 入口读取；Mock，不连接正式 API 或 Provider。所有最终 JSON 均记录同一 artifactSha256。

## 行为结果

| 场景 | 实际结果 | 回执 |
| --- | --- | --- |
| 系统→项目→任务、功能/Agent | 真实控件到达对应 scope；实例绑定限制生效，未绑定任务显式报错 | tour-final-desktop.json、deep-final.json |
| 三模板与动态修订 | 长程、巡检、单次均展示必要阶段与终点；各自 v1→v2→v3；历史事实与 occurrence 保留 | tour-final-desktop.json 第4–6、10–14、17站 |
| 计划历史 | 第12站 current=3/view=1；深链候选 current=1/view=2，明确尚未发布；查看不改当前执行版本 | tour-final-desktop.json、deep-final.json |
| Stable/live | 成功与失败追加 stable；只收拢匹配活动；其他并行活动和任务保留 | refs-final.json、tour-final-desktop.json 第8–9站 |
| 完成/失败终态 | Task 与 Agent 同一语义投影；completed 和 failed 无 live；失败图、原因、下一步保留 | tour-final-desktop.json 第19、21、23站 |
| 关注发布 | 原生键盘将 n-revision 标记失败；任务仍 live、attention=true；系统 attention 包含该任务；n-history/n-instance-verify 保持 active | refs-final.json |
| 依赖与计划切换 | v2 接线成功→v3，n-review 从旧 active 重新成为 waiting；n-revision 失败后 n-review=blocked，独立并行分支仍 active；81站全部公开当前图的 active 前置均 done | refs-final.json、两份 tour-final JSON 的 dependencyErrors |
| 共享 payload | 新 ref 发布；旧 ref 内容不变；未变 fact 复用；project/task/agent 同一 task；两个订阅者收到同 ref；退订后计数不增；深冻结 | refs-final.json |
| Evidence | 原生 Enter 打开 ev-projection；Esc 后关闭、hash 清除 evidence，焦点回同一证据控件 | focus-final.json |
| Node/raw | 第15站自动打开节点 dialog；第16站主动 raw；关闭后继续 Tour | tour-final-desktop.json |
| 深链与异常 | 13例；初次加载恢复指定 task/candidate/agent×task/node；未知实体、版本、节点、证据、站点、畸形编码和未绑定任务显式错误，壳可返回 | deep-final.json |
| 导览控制 | 目录跳站、前后、重来、退出和重新打开；重访模拟成功站不重复事实；重来不伪造业务重置 | tour-controls-final.json |
| 响应式 | 1440/768/390 各27站，共81站；原生下一站可达；页面 body/document 无横向溢出；SVG namespace 正确；无对象字符串 | tour-final-desktop.json、tour-final-responsive.json |
| 原生鼠标与 motion | 核验 ev-projection 按钮中心的 DOM 命中后，原生 CSS 坐标鼠标打开 dialog；reduced-motion 生效，无动画；HTTP资源为空 | pointer-motion-final.json |

回执来源为只读 DOM 与公开 consumer；业务推进通过可见原生控件触发。JSON 保留实际 hash、正文、状态、节点与宽度；SVG 枚举归并为实测 namespace 结果与数量；BODY/HTML 焦点只记录 tag，避免保存隐藏 script 的 textContent。未用私有 MockDriver 调用替代行为入口。

## 反证与限制

原稿 `ba012414…` 的浏览器结果 FAIL。它丢失 ver、误称未来修订为历史、failed 残留 live、Esc 焦点错误且 hash 未清、失败 attention 未发布。独立 HTML 作者修 owner 后，父从同一入口重验上述受影响行为。语法检查和作者 exit0 均未作为浏览器 PASS。

独立复盘随后发现 `860f2595…` 的 n-review 在 v2→v3 后保留旧 active，而新前置未完成。该反证导致最终 review 暂停。独立作者在 MockDriver.reconcile 修正一行，使未收拢 active 也按当前依赖判定；父重新遍历81站并增加依赖断言，原生成功→修订→失败序列通过。done/failed 事实、旧引用和独立并行活动保持。

完整验收脚本先保存了81站、依赖、引用与焦点回执；其后关闭 Tour 将焦点移至 header，页面回到顶部，证据按钮中心 y1026 超出1000 viewport，原生鼠标的命中前置检查失败。父只读 rect 确认后用自然原生 wheel 滚到按钮，命中为 true，续验鼠标、motion、13深链和 Tour 生命周期通过。未修改产品，也未重复有效的81站检查。任务根 browser-final.log 和 browser-additional.log 分别保留此边界，不能把第一个脚本 exit1 冒充整体 PASS。

Ego selector 自动滚动点击 ev-projection 曾报 div/article 拦截；同位置的 `elementFromPoint` 命中真实按钮，原生坐标鼠标和键盘均打开同一 dialog。因此没有据此改 CSS，也没有认定页面布局是根因。该 SDK 自动定位路径仍未确认。

`Page.captureScreenshot` 多次 CDP timeout，未生成可用截图。截图视觉审查保持 **UNVERIFIED**。行为与尺寸回执不冒充截图证据。

原型中的 Arc 合同只证明进程内不可变共享引用。它不证明 Rust `Arc<T>`、原子引用计数或跨进程零拷贝。生产 context-events 消费、任务模板/计划历史、Agent/项目权威身份、推理提交边界和真实运行验收仍 OPEN。正式10086 API观察为 `auth.session.missing`；本轮没有正式任务 receipt。
