# AI 托管模式

## 业务要求

1. **托管入口**:Flow 列表中每个 Flow 项右侧操作区(DatabaseOutlined 旁)新增"AI 托管"入口 icon
2. **进入托管的两种分流**:
   - 若 `flow.host_model` 未配置:自动打开 FlowEditor 抽屉 + antd notification 提示"请先选择托管模型"
   - 若已配置:切换 activeFlowId 到当前 flow + 呼出 ChatDrawer,显示空的 host MessageList,**不立即启动**,等用户在 ChatInput 输入首条消息后再正式 flowStart(mode='host')
   - **入口分流增强**:已配置 host_model 且存在子 run 处于 awaiting-tool-permission / awaiting-question / result / error 时,**直接切到该子 run 面板**,不弹通知,也不切到 host run;destroy 该子 run 的待办通知
3. **托管 AI**:由 `host_model` / `host_effort` / `host_prompt` 驱动;`buildHostSystemPrompt` 已含调度规则;MCP 仅暴露 `runAgent` 一个工具;host AI 视为 never_complete 风格,不能自我完成,Flow 结束靠用户主动 killFlow
4. **runAgent 调度能力**:host AI 可串联/并发调度多个 Agent,可重复调度同一 Agent;每次调用对应一个独立的 AgentRun
5. **模式互斥**:同一 Flow 同一时刻仅能在 manual 或 host 一种模式下运行;用户尝试在另一种模式启动时,**仅弹通知提示**(不强制操作)
6. **入口 icon 闪烁(v3 扩宽)**:`hostShouldBlink = runState?.mode === 'host' && hostFlowPhase !== 'idle'` —— 只有 idle 与非 host 模式不闪烁,completed / stopped / error / result / awaiting-\* / running / starting 等全部闪烁。**闪烁与按钮组可见性解耦**:外层 span 不再随闪烁强制 opacity-100;复制 / 删除 / 数据库 / Typography.Text(copyable) 等其他按钮全部走 group-hover:opacity-100 hover 显示语义;仅 RobotOutlined 在 hostShouldBlink 时持续可见 + animate-pulse,其余在 hover 上时才显示。
7. **单 ChatDrawer 实例 + 双 state 架构**:
   - host run 与子 run 拆到两个独立 state:`hostDrawer` 与 `subAgentDrawer`,但 webview 仅挂一份 `<ChatDrawer>` 实例,按 `subAgentDrawer ?? hostDrawer` 选取展示 state(子 Drawer 优先)
   - host Drawer 默认宽度 **700**;sub agent Drawer 共用同一 Drawer 实例(切换不同子 run 时通过 ChatPanel `key=runId` 强制重挂载)
   - sub agent Drawer 关闭后视觉自然回到 host Drawer
   - ChatInput 全局唯一(单 Drawer 实例 + `forceRender` 保证),onSend / onCancel 派发目标按当前 viewRun 决定
   - 入口:点击 host run 内 `runAgent` tool_use 节点 / SortableFlowItem 点 host icon 命中 awaiting 子 run / 通知点击 → openSubAgentDrawer
8. **画布表现**:host 模式下 AgentFlow 画布**不再**高亮 Agent 节点;通知行为照搬 manual
9. **fork**:host run 的消息可正常 fork(message/text/thinking/turn_end);子 run **禁止 fork**;fork 出的新 Flow 继承 mode='host'
10. **子 run 首屏回显**:host 通过 `runAgent` 注入的 `message` 与 `values` 在子 run 的 MessageList 首条 user 消息中可见(reducer 据此把 host 注入的 message + values 序列化成两条 user aiMessage 写入子 run.messages 首屏)
11. **HOST_AGENT_ID agentName 兜底**:reducer pushEffect 与 extension notifyHandler 在拼通知文案时,识别 `agentId === HOST_AGENT_ID`,固定显示 `'AI 托管'`
12. **runAgent 节点文案分状态(v3 新增)**:host run 中 runAgent tool_use 节点显示文案按子 run phase 区分:`running → 「子 Agent 运行中…」`、`awaiting-question → 「等待回答」`、`awaiting-tool-permission → 「等待授权」`、`result → 「等待继续」`、`error → 「子 Agent 出错」`、`stopped/interrupted → 「已停止」`、`completed → 「已完成」`、`starting → 「子 Agent 启动中…」`、`idle → 「子 Agent 待启动」`,phase 缺失兜底 `「点击查看子 Agent 对话 →」`。
13. **子 run lazy resume(v3 新增)**:host run interrupt 时 `cascadeKillSubExecutors` 把所有子 executor `kill + executors.delete`,reducer 通过 `forceStopped` 把子 run 投影为 `stopped`。用户在 sub Drawer 继续向已 stopped/interrupted 的子 run 发消息时:
    - ChatDrawer.inputState 在 `isSubRun && (stopped || interrupted)` 时投影 `ready`;onSend 走 sendUserMessage(viewRunId) 而非 startFlow(后者会清空整个 host flow)
    - FlowRunner.handleUserMessage 在 executor 不存在时 → `tryResumeSubRun`:通过 `getRunInfo(runId)` 拿到 sessionId / agentId / parentToolUseId,新建 lazy ClaudeExecutor 并 push 消息;仅处理子 run(parentToolUseId 存在)
    - reducer 在 `flow.command.userMessage` 上识别 forceStopped 子 run 并清掉标记,getRunPhase 重新走 running 路径
    - 子 AgentComplete 时 pendingRunAgentHandlers 已被 reject,onHostSubAgentComplete 跳过 resolve 只 fire signal —— host AI 不会再次收到该子 run 结果(host run 已 interrupt,无人接收),这是预期的脱离语义
14. **FlowEditor 跨 flow 切换不闪烁(v3 新增)**:Drawer 不再使用 `key={flow.id}`(避免重挂载触发 transition);表单字段同步用 useLayoutEffect(`form.resetFields()` + `setFieldsValue`)在 paint 前完成,不会让用户看到旧 flow 字段闪一帧再切新值。

## 业务验证方式

1. 给一个未配置 host_model 的 flow,点 AI icon → FlowEditor 自动打开 + 提示"请选择托管模型"
2. 配置 host_model 后再点 AI icon → host Drawer 打开,显示空的 host MessageList;首次输入消息后,host AI 开始响应
3. host AI 调用 `runAgent` → 子 Agent run 创建,host run 中可见 runAgent tool_use 节点(文案按子 run phase 显示);点击该节点 → **打开 sub agent Drawer**,子 run MessageList 首条 user 消息显示 host 注入的 `message` 与 `values`
4. host AI 多次调用 runAgent(包括同一 Agent 多次)→ 每次创建独立子 run,均可点击切换查看
5. 子 run 进入 result / interrupted 时,在 sub agent Drawer 内发消息 → 子 Agent 多轮对话直到 AgentComplete
6. **host run interrupt → 所有正在运行的子 executor 被直接 kill,子 run 进入 stopped phase;在 sub Drawer 内继续给该子 run 发消息 → 子 executor lazy resume 成功,继续与子 Agent 对话直到 AgentComplete(host AI 不会再收到结果)**
7. flow 在 host 运行中点 manual 启动按钮 → 弹通知;反之亦然
8. host 运行非 idle(包括 running / completed / stopped / error / result / awaiting-\*)时 → AI icon 持续闪烁,且其他按钮(复制/删除)依然走 hover 显示语义
9. host 模式下画布无 Agent 节点高亮
10. host run 上的 fork 操作 → 新 Flow 仍为 host 模式;子 run **不显示** fork 入口
11. 子 run 进入 result / awaiting 时,点击 host icon 直接打开 sub agent Drawer 进入该子 run,不弹通知
12. host run / 子 run 触发的通知文案 agentName 不为空(host run 显示 'AI 托管')
13. **runAgent 节点文案随子 run phase 实时切换**(running ↔ awaiting-question ↔ result ↔ completed 等)
14. **跨 flow 连点托管 icon 时 FlowEditor 抽屉不闪烁**

## 代码要求

### A. 数据模型与协议

1. `src/common/flowRunState.ts`:`FlowRunState` 顶层有 `mode: 'manual' | 'host'`(默认 manual);AgentRun 有 `parentToolUseId?` 与 `forceStopped?`;HOST_AGENT_ID 在 flowRunState.ts 避免循环 import;reducer 的 clearPendings 拆为 clearAllPendings + clearPendingsForRun
2. `src/common/event.ts`:`flow.command.flowStart` 与 `flow.signal.fork` payload 含 `mode` 字段;`flow.signal.subAgentStarted{ runId, subRunId, subAgentId, parentToolUseId, initMessage, values? }`
3. reducer 在 `flow.command.flowStart` 分支落地 mode;killFlow 不重置 mode;agentComplete 在 mode==='host' 时不追加 next_agent run、不触发 flow-completed 通知
4. **(v3)** reducer 在 `flow.command.userMessage` 上识别 `run.forceStopped === true` 时清掉标记,让 getRunPhase 跳出 stopped 重回 running 路径

### B. 入口 icon 与互斥提示

5. `src/webview/components/FlowListPanel/SortableFlowItem.tsx`:
   - 在 DatabaseOutlined 旁加 RobotOutlined(AI 托管 icon)
   - 点击逻辑按 host_model 是否存在分流
   - **(v3)** 闪烁条件 `hostShouldBlink = runState?.mode === 'host' && hostFlowPhase !== 'idle'`
   - **(v3)** 外层 span 不再随闪烁强制 opacity-100;每个按钮自管 opacity:RobotOutlined `hostShouldBlink ? animate-pulse + opacity-100 : opacity-0 group-hover:opacity-100`,DatabaseOutlined / BlockOutlined / Typography.Text(包一层 span) / DeleteOutlined 全部 `opacity-0 group-hover:opacity-100`
   - onClickHostIcon 增强:先扫 `state.runs.filter(r => r.parentToolUseId)` 中处于 awaiting-tool-permission / awaiting-question / result / error 的子 run,有 → openSubAgentDrawer + destroyRunNotifications;无 → 切到 host run
6. **互斥触发点**:在 `useStartFlow` 集中校验:Flow 当前已在另一种 mode 非终态运行时弹 antd notification(不阻断,但不发起新启动);host icon 入口在 SortableFlowItem 单独校验对方 manual 模式

### C. FlowEditor 自动唤起 + 跨 flow 切换

7. store action `openFlowEditor(flowId, opts?: { focus?: 'host_model' })`;FlowEditor 收到 focus 时 scrollIntoView 并尝试聚焦该 field;入口处通过 antd notification 提示"请先选择托管模型"
8. **(v3)** Drawer 不使用 `key={flow.id}` —— 避免跨 flow 切换时整个抽屉重挂载触发 transition 闪烁
9. **(v3)** 表单同步使用 `useLayoutEffect`(替代 useEffect):`form.resetFields()` + `setFieldsValue` 在 paint 前同步完成,不会让用户看到旧 flow 字段闪一帧

### D. ChatDrawer 与 ChatInput

10. store 拆分 `hostDrawer?: ChatDrawerState` 与 `subAgentDrawer?: ChatDrawerState`,但 webview 仅挂一份 `<ChatDrawer>`,按 `drawerState = subAgentDrawer ?? hostDrawer` 选取展示 state
11. ChatInput 全局唯一(单 Drawer 实例 + forceRender),onSend / onCancel 路由按当前 viewRun 决定
12. ChatPanel 中 `agentId === HOST_AGENT_ID` 时 agentName 显示 'AI 托管';新增 toolUseIdToSubRunId / subRunPhaseByToolUseId / onSubRunClick 注入 BubbleCtx;onSubRunClick 调用 `openSubAgentDrawer`
13. MessageBubble 中 `tool_use(name='mcp__AgentControllerMcp__runAgent')` 渲染为带紫色边框的可点击节点,**(v3)** 文案用 `subRunStatusLabel(phase)` 按 9 种子 run phase 输出差异化提示
14. App.tsx activeFlowId useEffect:host 模式默认开 hostDrawer;store agentComplete 自动跟随逻辑加 `state.mode !== 'host'` 守卫
15. **(v3)** ChatDrawer.inputState 在 `isSubRun && (stopped || interrupted)` 时投影 `ready`;onSend 在 `viewRunId && (result || interrupted || (isSubRun && stopped))` 时走 sendUserMessage(viewRunId) 而非 startFlow

### E. 运行时:FlowRunner 与 ClaudeExecutor

16. FlowRunner:解除 executors.size <= 1 约束;按 runId 寻址多 executor 并发;新增 runMode / pendingRunAgentHandlers / subRunToHost / runAgentToolUseIdQueue 状态机
17. ClaudeExecutor 启动模式区分:新增 ExecutorOverrides { systemPromptOverride, mcpServerFactory };host run 用 buildHostSystemPrompt + buildHostMcpServer(仅 runAgent);子 run 走原 buildAgentSystemPrompt + buildAgentMcpServer
18. `src/common/extension.ts`:`buildHostMcpServer({ onRunAgent })` 工厂仅暴露 runAgent 工具,toolUseId 队列法

- `makeRunAgentHandler` 必须把 `consumePendingRunAgentToolUseId` 调用提前到 `findAgentById` 校验之前(或在 throw 前 consume 出队丢弃),避免 id 校验失败时 toolUseId 残留导致下次错位

19. FlowRunner.makeRunAgentHandler 创建子 run 后 fire `flow.signal.subAgentStarted`,携带 `initMessage` 与 `values`(子 run 的实际首条 user 消息),reducer 据此把 subInitMessage + values 作为 user aiMessage 写入子 run.messages
20. **(v3 新增)** FlowRunnerOptions 新增 `getRunInfo?: (runId) => { sessionId?, agentId, parentToolUseId? }`;FlowRunnerManager 构造函数新增 `getRunInfo: (flowId, runId) => ...` 参数;extension/index.ts 注入读 FlowRunStateManager 的实现
21. **(v3 新增)** FlowRunner.handleUserMessage 在 executor 不存在时 → `tryResumeSubRun`:通过 getRunInfo 拿 sessionId/agentId/parentToolUseId,新建 lazy ClaudeExecutor + push 消息;仅处理子 run(parentToolUseId 存在),manual / host-parent 走原静默丢弃路径

### F. host run interrupt 与 killFlow 级联

22. host run interrupt:reject 所有 pending runAgent handler + 直接 kill 全部子 executor(`cascadeKillSubExecutors`),fire 每个子 run 的 agentInterrupted signal;reducer 在 host run agentInterrupted 处理时识别 mode==='host' && agentId===HOST_AGENT_ID,把所有有 parentToolUseId 的非完成子 run 标记 forceStopped
23. host run killFlow:走 dispose 路径 + 清空状态机
24. 单个子 run interrupt:仅 interrupt 该子 executor;runAgent handler 不 reject,继续等待
25. 单个子 run agentError:reject 该子 run 对应的 runAgent handler;host AI 收到错误继续推理

### G. AgentFlow 画布

26. AgentNode `isAgentActive` 判定加 `state.mode !== 'host'` 守卫

### H. fork 继承 mode

27. `handleFork`:写入 newRunState 时把源 RunState 的 mode 透传;`flow.signal.fork` payload 携带 mode;`spawnForFork` 接收 mode,host run fork 用 host system prompt + host MCP
28. webview 收到 fork signal 后,识别 host agentId 时打开 hostDrawer
29. **子 run 禁止 fork**:MessageList 中 `isSubRun` 时 `ctx.onFork = undefined`

### I. 通知策略

30. host 模式下子 run 完成不触发 `flow-completed` 通知;仅 host run 完成 / killFlow 才视为 Flow 完成;agent-error / awaiting-\* / result 通知仍按现行
31. reducer pushEffect 与 extension notifyHandler 拼通知文案时,识别 `agentId === HOST_AGENT_ID` 时 agentName 固定为 'AI 托管'
32. 点 host icon 命中 awaiting 子 run 直接进入子 Drawer 时,主动 destroy 该子 run 已弹出的通知

## 代码验证方式

1. `pnpm check-types` + `pnpm compile` 通过
2. 端到端跑通 host 调度 runAgent → 子 Agent → 完成 → host 继续 → 用户 killFlow 终结
3. 端到端跑通 host AI 同时/串联调度多个 Agent + 重复调度同一 Agent,各自独立 sub agent Drawer 视图
4. 端到端验证:子 run interrupt → 用户在 sub agent Drawer 继续发消息 → 子 AgentComplete → host AI 收到结果继续推理
5. **(v3)** 端到端验证:host run interrupt → 所有子 executor 被 kill,子 run 进入 stopped phase;**用户在 sub Drawer 继续给已 stopped 的子 run 发消息 → FlowRunner.tryResumeSubRun 重建 lazy executor 并 resume sessionId,子 Agent 继续运行直至 AgentComplete(host AI 不会收到结果)**
6. 互斥通知触发:manual 运行中点 AI icon 弹通知;host 运行中点 manual 启动按钮弹通知
7. **(v3)** 闪烁:host 启动后 AI icon 闪烁(running / awaiting-\* / result / completed / stopped / error 等所有非 idle 状态都闪),host idle 与非 host 模式不闪。**闪烁状态下复制 / 删除 / 数据库等其他按钮仍走 hover 显示**(不在 hover 上时不可见)
8. AgentFlow 画布在 host 模式下无 Agent 节点高亮
9. fork host run,新 Flow 仍是 host 模式,Drawer 正确打开为 hostDrawer;子 run 无 fork 入口
10. 子 run MessageList 首屏正确显示 host 注入的 `initMessage` 与 `values`
11. host run / 子 run 通知文案中 agentName 不为空(host run 显示 'AI 托管')
12. 子 run 进入 result / awaiting 时点 host icon → 直接打开该子 run 的 sub agent Drawer,不弹通知,且对应通知 destroy
13. **(v3)** runAgent tool_use 节点文案随子 run phase 实时切换(running ↔ awaiting-question ↔ awaiting-tool-permission ↔ result ↔ completed 等)
14. **(v3)** 跨 flow 连点托管 icon 时 FlowEditor 抽屉不闪烁(无重挂载 transition,form 字段在 paint 前已切到新值)

## 修订总结

v3 相对 v2 主要 5 项新增/修改:

1. runAgent 节点文案按子 run phase 区分(MessageList + MessageBubble)
2. 子 run stopped/interrupted 后允许在 sub Drawer 继续发消息(ChatDrawer.inputState/onSend + FlowRunner.tryResumeSubRun + reducer 清 forceStopped)
3. FlowEditor 跨 flow 切换抽屉不闪烁(去掉 Drawer key + useLayoutEffect)
4. 闪烁与按钮组解耦(外层 span 不强制 opacity;每个按钮自管 opacity)
5. 闪烁条件扩宽(hostShouldBlink = mode === 'host' && phase !== 'idle')
