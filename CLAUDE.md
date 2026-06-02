# CLAUDE.md

中文回复。Agent schema 字段保持 snake_case 与 prompt 对齐。优先用 `ts-pattern` 的 `match` + `.exhaustive()` 替代嵌套三元 / `if-else` / `switch`。

**功能变动后必须同步本文件**：改动事件契约、reducer 行为、运行时层级、work_mode 行为、ShareValues 链路、易踩坑硬约束 → 改完代码后回查相关章节并更新；新增硬约束追加到「易踩坑」节。文档与代码不一致即视为 bug。

**写作约定**：本文是导航地图,只留「标题 + 一句话约束 + 文件路径」,具体字段名/调用链/步骤写在对应代码注释里。新增条目先把细节落到代码注释,本文只引用。**只收录与 AI 对话核心链路相关的硬约束**(消息流 / 状态机 / 事件契约 / ShareValues / fork / 消息派发);单点小约束、UI 杂项、字段映射不进本文。只描述当前状态,不用"改为 xxx"/"不再走 xxx"等变化句式——历史变化属于 commit message。

## 项目性质

VSCode 插件 `agent-flow`：用 Agent 编排工作流。Flow 是 Agent 作为节点的有向图，每个 Agent 通过 `@anthropic-ai/claude-agent-sdk` 独立运行，按 `outputs[i].next_agent` 决定下一跳，通过 Flow 的 `shareValues`（按 key 授权读写）共享数据。

## 三层源码结构

跨层 import 只能经 [src/common/](src/common/)。三个独立 tsconfig：

- [src/common/](src/common/) — 共享层（Zod schema / 类型 / 事件契约 / prompt 构建），webview 应 import `@/common`（不含 SDK）
- [src/extension/](src/extension/) — Node / VSCode 扩展宿主，可 import `@/common/extension`（含 SDK）
- [src/webview/](src/webview/) — React 19 + AntD + `@xyflow/react` + `zustand`(immer)

领域定义与校验在 [src/common/index.ts](src/common/index.ts)。Flow 定义持久化到 `.agent-flows.json`(`os.homedir()`);`FlowRunState` 仅内存,extension 端 [FlowRunStateManager](src/extension/FlowRunStateManager.ts) 镜像;UI 状态仅 webview。

## Extension ↔ Webview 事件契约

事件定义见 [src/common/event.ts](src/common/event.ts)。`flow.command.*` = webview → extension,`flow.signal.*` = extension → webview。`match(e).with({ type: P.string.startsWith(...) }, ...)` 分发。

标识符：

- `flowId` —— Flow 主键
- `runId` —— 一次 Agent 运行的主键,所有载荷以此寻址。来源:`flowStart` 由 webview 生成,`next_agent` / `fork` 由 extension 生成
- `sessionId` —— Claude SDK session id,挂在 `AgentRun.sessionId`,每切 Agent 换一次;不出现在事件载荷上,由 `aiMessage` 内 SDK 原生 `session_id` 回填

## 单一 reducer

[updateFlowRunState](src/common/flowRunState.ts) 是 Flow 运行态唯一 reducer,signal / command 两条路径上 extension 与 webview 各 reduce 一次,共用同一份保证两端同步。webview 镜像在 [useFlowStore](src/webview/store/flow.ts),extension 镜像在 [FlowRunStateManager](src/extension/FlowRunStateManager.ts)。

`FlowPhase` / `AgentPhase` 同构:`idle | starting | running | result | interrupted | awaiting-question | awaiting-tool-permission | awaiting-complete-confirm | completed | stopped | error`,共用 `aggregatePhase(runs)`。Phase 不存字段,由 [getRunPhase / getAgentPhase / getFlowPhase](src/common/flowRunState.ts) 推断。

`FlowRunState` 数据结构、`MessageEffect` 6 个 reason、终态守卫见 [flowRunState.ts](src/common/flowRunState.ts) 顶部注释。

## 运行时层级

extension 端：[FlowRunnerManager](src/extension/FlowRunnerManager/index.ts)（全局唯一，`Map<flowId, FlowRunner>`）→ [FlowRunner](src/extension/FlowRunnerManager/FlowRunner/index.ts)（一个 Flow，`Map<runId, ClaudeExecutor | CodeExecutor>`，host 模式下 host run + 多个子 run 并发，manual 模式 `size <= 1`）→ 按 `agent.node_type` 分流：`agent` 走 [ClaudeExecutor](src/extension/FlowRunnerManager/FlowRunner/ClaudeExecutor.ts)（封装 SDK `query`），`code` 走 [CodeExecutor](src/extension/FlowRunnerManager/FlowRunner/CodeExecutor.ts)（把 `agent.code` 当 `async function (input, values, runCommand)` 函数体执行，不走 SDK）。**路由职责由 FlowRunner 承担**：所有 command 在 `executors: Map<runId, Executor>` 中按 runId 寻址；Executor 自身不持有 runId/agentId。FlowRunner 不持有 Flow 字段，统一通过 `getLatestFlow()` 取最新引用。per-Agent MCP server 在 [src/common/extension.ts](src/common/extension.ts)：`CompleteTask`(chat 模式不挂) / `validateFlow` / `getFlowJSONSchema`，task / silent_task 额外加 `TerminateTask`。host 模式独立的 `buildHostMcpServer`(仅 `runAgent`)。

webview 端：[App](src/webview/App.tsx) → `<AgentFlow>`（xyflow）+ 单 `<ChatDrawer>` 实例（按 `subAgentDrawer ?? hostDrawer` 选取展示 state，子 Drawer 优先；`defaultSize=700`），状态收敛到 [useFlowStore](src/webview/store/flow.ts)。

**用户当前要看的 agent = `runs.at(-1)?.agentId`**:reducer 处理 `agentComplete` 切 next_agent 时立刻追加新 run 到末位。AgentNode 高亮 / ChatDrawer 自动切换 / `viewRunId` 同会话追问判定都按这条规则在调用点内联,不要重新引入跨场景 `getActiveAgentId` 工具。

## ShareValues 授权读写

Flow 级共享存储,Agent 视角是按 key 授权的 `values` 契约。链路细节见对应代码:

- `Flow.shareValuesKeys`（`{key, desc?}[]`，[ShareValueKeySchema](src/common/index.ts)）声明全集。`desc` 仅设计期标注，不进 prompt / MCP schema。删 key 自动从所有 Agent 的 `allowed_read/write_values_keys` 清理。
- 读：[buildAgentSystemPrompt](src/common/index.ts) 把可读写 / 可读 key + 当前值（缺失为 `null`）以 JSON 注入「# 可读写数据」+「# 可用数据」节，**prompt 时点快照、不重读**，运行中改值需切下一 agent 生效。
- 写：仅 [CompleteTask](src/common/extension.ts) 的 `values` 参数，schema 由 `allowed_write_values_keys` 动态生成；未授权 key 静默丢弃。`chat` 模式无 CompleteTask 故无法写。
- 授权范围：`allowed_read/write_values_keys` 仅约束 `node_type='agent'`；`node_type='code'` 节点全量读、返回 values 与现有 shareValues 合并（不受 allowed_write 约束）。
- 事件：`flow.signal.agentComplete.values`（reducer 合并到 `state.shareValues`）；`flow.command.setShareValues`（full replace，无 runId，未运行也能编辑）。无 `shareValuesChanged` signal、无 `get/setShareValues` MCP 工具。
- 运行时取值经 `getLatestShareValues(flowId)` → `FlowRunStateManager.getFlowRunStates()[flowId]?.shareValues`，`FlowRunner` 不持有副本。
- UI：[FlowEditor](src/webview/components/FlowEditor/index.tsx) 抽屉编辑 Flow 名称、`host_model` / `host_effort` / `host_prompt`（托管模型 / 努力程度 / 提示词；提示词在右侧 edit/preview 切换面板，仿 AgentEditor）、`shareValuesKeys`（拖拽列表，每项支持 `key` / `desc` 编辑、重复校验、清空按钮）以及运行中各 key 当前值；[AgentEditor](src/webview/components/AgentEditor/index.tsx) 用 multi-select 维护两个授权列表，标签 `key(desc)`，提交只用 key。
- 命名：Flow 视角 = `shareValues`（`FlowRunState.shareValues` / `Flow.shareValuesKeys` / `setShareValues` / `getLatestShareValues`），Agent 视角 = `values`（`allowed_read/write_values_keys` / `CompleteTask.values` / `agentComplete.values` / `currentValues`）。

## work_mode 三态

仅 `node_type='agent'` 节点适用;`node_type='code'` 走 CodeExecutor,不读 work_mode / agent_prompt / model 等字段。

- **task**:常规推进。系统提示词注入「任务描述 / 完成任务 / 输出分支」,AskUserQuestion 允许、CompleteTask 必须、TerminateTask 在极端情况下可中止任务
- **chat**:长期对话。CompleteTask 不挂载、可写 values 节不注入,`agent_prompt` 视为长期规则
- **silent_task**:无人值守。AskUserQuestion 自动应答 / result 自动续轮 / canUseTool 默认 deny / `pushEffect` 仅放行 `agent-error` / `flow-completed` / `awaiting-complete-confirm` / 暴露 `TerminateTask` MCP / AgentEditor 首次切换弹 warning。详见 [ClaudeExecutor.ts](src/extension/FlowRunnerManager/FlowRunner/ClaudeExecutor.ts) 与 reducer `pushEffect`

## 易踩坑(硬约束,不要回退)

每条「标题 → 文件 → 一句话约束」,具体语义看对应代码注释。**只收录涉及核心链路的硬约束**;实现细节在代码注释里。

### 状态机与命令派发

- **handleCommand 必须 `keyof` + `.exhaustive()`** → [FlowRunnerManager.handleCommand](src/extension/FlowRunnerManager/index.ts):分支写完整 `flow.command.*`,不要 `.otherwise`(短名错配会静默吞 → executor 残留烧 token / interrupt 失效)
- **killFlow vs flowStart 语义对照** → [flowRunState.ts](src/common/flowRunState.ts) `killFlow` / `flowStart` 分支:killFlow 保留 messages / shareValues、保留 `mode`(停掉重启仍是 host);flowStart 清 messages、shareValues 透传、覆盖 mode;shareValues 仅在 phase→completed 时清空
- **store 命令派发必须传 runId** → [useFlowStore](src/webview/store/flow.ts):`sendUserMessage` / `interruptAgent` / `answerQuestion` / `answerToolPermission` 调用方明确传 `runId`,store 不做"末位非终态 run 回退"(多 run 会乱派发);ChatDrawer 用 `viewRunId`、answerQuestion 用 `pendingQuestion.runId`、answerToolPermission 按 toolUseId 反查
- **`flow.signal.answerQuestion` 与 `flow.command.answerQuestion` 同语义** → silent_task 自动应答走 signal,人工回答走 command,reducer 两条分支处理一致;不要合并(入口区分对未来场景过滤有用)
- **next_agent 是 id 不是 name** → [useFlowStore.copyAgents](src/webview/store/flow.ts):复制 Agent 必须重新生成 id 并通过 `idMap` 重映射 `next_agent`
- **zustand selector 禁止返回新数组 / 新对象** → `s.x.filter(...)` / `... ?? []` 每次新引用 → `useSyncExternalStore` 用 `Object.is` 判定 → 死循环 `Maximum update depth exceeded`;取原始引用稳定字段,过滤在 `useMemo`,空结果用模块级常量(如 `EMPTY_PENDING_QUESTIONS`)

### 消息流与 Executor 生命周期

- **CompleteTask.content 作为 next agent 首条消息回显** → [reducer agentComplete 分支](src/common/flowRunState.ts):创建新 `AgentRun` 时 `messages` 预置一条 user `aiMessage`(content = `nextAgent.no_input ? '开始' : data.content`),与 `FlowRunner.doOnCompleteTask` 喂 SDK 的 `nextInitMessage` 同源,改链路两端同改
- **CompleteTask 后 SDK result 不走 onMessage** → [ClaudeExecutor / FlowRunner / reducer](src/common/flowRunState.ts):CompleteTask 已暂存时跳过该 result onMessage,通过 onComplete 上抛;reducer 不单独包成 aiMessage(result 挂 `agentComplete.data.result` 随 signal 进 messages),buildRenderItems 在 agentComplete 分支调 `applyResultToCache(data.result)` 取 token;避免 phase 误切到 result 触发"生成完毕"通知
- **shareValues 是 prompt 快照** → [FlowRunner.doOnCompleteTask](src/extension/FlowRunnerManager/FlowRunner/index.ts):切下一 agent 时手动 `{ ...getLatestShareValues(), ...result.values }` 拼快照,否则 nextAgent systemPrompt 看到旧值
- **FlowRunner 不持有 Flow 字段,统一通过 `getLatestFlow()` 取** → [FlowRunner](src/extension/FlowRunnerManager/FlowRunner/index.ts) / [FlowRunnerManager.createRunner](src/extension/FlowRunnerManager/index.ts):webview save 整体替换 `currentFlows` 后持有快照会读到过时 agents / shareValuesKeys;findAgentById / shareValueKeys 所有读取链路都走 `getLatestFlow()`,与 `getLatestShareValues` 设计一致
- **Executor 路由由 FlowRunner 承担** → [FlowRunner](src/extension/FlowRunnerManager/FlowRunner/index.ts):用 `executors.get(runId)` 寻址,Executor 不持有 runId/agentId;回调闭包用 `executors.get(runId) !== getExecutor()` 判定过期避免污染新 run
- **ClaudeExecutor 启动模式 `eager` / `lazy`** → [ClaudeExecutor.ts](src/extension/FlowRunnerManager/FlowRunner/ClaudeExecutor.ts):构造函数 `(mode, getOptions)`;eager 构造时即调 getOptions + createQuery + push initMessage;lazy 用于 fork / 子 run resume,构造时不调 getOptions,等首次 sendUserMessage 触发首次 createQuery 时才调 —— 调用方在闭包内动态返回最新 agent / shareValues
- **CodeExecutor 与 ClaudeExecutor 同构** → [CodeExecutor.ts](src/extension/FlowRunnerManager/FlowRunner/CodeExecutor.ts):`node_type='code'` 时 FlowRunner.runAgent 分流 CodeExecutor;函数签名 `async function (input, values, runCommand)`,`input` = 上游 CompleteTask.content / no_input 时 `'开始'`,`values` = 完整 shareValues(全量读),`runCommand` = `async (command, timeout?) => Promise<string>`(VSCode workspaceFolder 下执行 shell,返回 stdout+stderr,默认 10 分钟);返回 `{ output_name?, content?, values? }` 驱动下一跳与 shareValues 合并(不受 allowed_write 约束);严格只产出 agentComplete 信号 —— 不发 assistant 气泡 / 不发 result onMessage,成功挂 onComplete.resultMessage 供 token 统计,错误走 logError + onError 切 error;不挂 MCP / 不走 SDK / 不支持作 fork 起点
- **assistant 跨 ID 重复** → [buildRenderItems.ts](src/webview/components/ChatDrawer/ChatPanel/buildRenderItems.ts):某些模型(glm-5.1)发 `stop_reason: null` 完整重述消息且 `message.id` ≠ streaming ID;已处理(移除 trailing streaming items + 按 `stop_reason` 标记 streaming),修改务必保留

### Fork 链路

- **fork 走 handleFork 路径** → [handleFork](src/extension/index.ts):`setRunState` + `spawnForFork` 起 FlowRunner + lazy executor → 发 `flow.signal.fork`;webview push 新 Flow / 切 active / 打开 ChatDrawer。用户首次发消息走 `sendUserMessage` 不经 `flowStart`。fork target 仅 `kind: 'message'`(SDK 不支持 askUserQuestion 作 fork 终点);code 节点无 SDK session 不支持 fork
- **fork target 带 runId 不带 agentId** → `flow.command.fork.target = { kind: 'message', runId, messageUuid }`:webview RenderItem 知道自己属于哪个 run(MessageList 按 run 维度遍历),extension `locateFork` 单 loop 按 runId 查;`flow.signal.fork` 也只带 runId,webview 从 `newRunState.runs.at(-1).agentId` 反推
- **fork 切片 uuid 用双 transcript 映射** → [handleFork](src/extension/index.ts):并发取源 session 与新 session transcript,按位置建 `srcUuid→newUuid` 映射,替换 slicedMessages 中所有带 uuid 的 SDK 消息;不用 webview 序列顺序对齐(webview echo 无 uuid 会错位),否则二次 fork 报 `Message <uuid> not found`
- **findPrevUuid 必须排除 stream_event uuid** → [buildRenderItems.findPrevUuid](src/webview/components/ChatDrawer/ChatPanel/buildRenderItems.ts):仅放行 SDKUserMessage / SDKUserMessageReplay / SDKAssistantMessage,误命中 stream_event uuid 会让 forkSession 报 `Message <uuid> not found`;`turn_end.messageUuid` 取本回合最后带 uuid 的 SDK 消息(result.uuid 不在 transcript),user item 取上一条 SDK 消息 uuid
- **ChatPanel 跨 Flow / 跨 run 切换必须 unmount** → [ChatDrawer](src/webview/components/ChatDrawer/index.tsx):给 ChatPanel 加 `key={`${flowId}-${agentId}-${runId ?? ''}`}`,避免 AskUserQuestionCard selections / motion.div ask-card key 在新旧 Flow / run 间被复用(fork 出的新 Flow 与源 Flow toolUseId 相同,SDK forkSession 不 remap)

### host 模式

- **HOST_AGENT_ID 保留 ID** → 普通 Agent 禁止使用;`flowStart.mode='host'` 时 `agentId` 必须是 `HOST_AGENT_ID`,FlowRunner 用 `buildHostSystemPrompt` + `buildHostMcpServer`(仅 `runAgent`);`runAgent` 不能调度自身、不返回 newRunId。reducer `pushEffect` 拼通知文案识别 `agentId === HOST_AGENT_ID` 固定显示 `'AI 托管'`(host run agentId 不在 flow.agents 中)
- **host 子 run 禁止 fork** → [MessageList](src/webview/components/ChatDrawer/ChatPanel/MessageList.tsx):`isSubRun` 时 `ctx.onFork = undefined`;子 run 的 fork 会让新 Flow 中子 run 找不到 host 接收 promise,造成 CompleteTask 无人接收死锁
- **runAgent toolUseId 队列法** → [FlowRunner.makeRunAgentHandler](src/extension/FlowRunnerManager/FlowRunner/index.ts):必须先 `consumePendingRunAgentToolUseId` 出队,再做 `findAgentById` 校验;否则 id 错时 throw 但 toolUseId 已入队 → 下次正常调用 FIFO 取到错误残留,造成 `parentToolUseId` 错位
- **subAgentStarted 携带 initMessage / values** → FlowRunner.fire 时附带,reducer 据此把 host 注入的 message + values 序列化成两条 user aiMessage 写入子 run.messages 首屏,webview 不需再追加 echo;values 同时通过 systemPrompt「# 可用数据」节真正喂给子 SDK,run.messages 里的 values 块仅用于 UI 显示
- **子 run lazy resume** → [FlowRunner.tryResumeSubRun](src/extension/FlowRunnerManager/FlowRunner/index.ts):host run interrupt 时 `cascadeKillSubExecutors` kill + delete 子 executor,reducer 通过 `forceStopped` 把子 run 投影为 `stopped`;用户在 sub Drawer 继续发消息找不到 executor → `tryResumeSubRun` 用 `getRunInfo(runId)` 拿 sessionId/agentId/parentToolUseId 新建 lazy executor;reducer 在 `userMessage` 上清掉 forceStopped;子 run CompleteTask 时 `pendingRunAgentHandlers` 已 reject,`onHostSubAgentComplete` 跳过 resolve 只 fire signal(host run 已 interrupt 无人接收)
- **单 ChatDrawer 实例 + 双 state** → [ChatDrawer](src/webview/components/ChatDrawer/index.tsx):webview 仅挂一份,按 `drawerState = subAgentDrawer ?? hostDrawer` 选取(子 Drawer 优先);`store.openChatDrawer` 按 `agentId === HOST_AGENT_ID` 自动分流写入 hostDrawer / subAgentDrawer;切换子 run 复用同一实例靠 ChatPanel `key` 重挂载;ChatInput 全局唯一(单实例 + `forceRender`),草稿切换不丢
- **host icon 入口分流** → [SortableFlowItem.onClickHostIcon](src/webview/components/FlowListPanel/SortableFlowItem.tsx):先扫子 run(`parentToolUseId`)中处于 `awaiting-*` / `result` / `error` 的,命中则 `openSubAgentDrawer` + `destroyRunNotifications` 直接进该子 run 不弹通知;否则呼出 host Drawer;manual 模式非 idle 点 host icon 弹互斥通知不启动

### UI 杂项

- **ChatDrawer 开始运行 / 同会话追问** → [ChatDrawer.onSend](src/webview/components/ChatDrawer/index.tsx):`viewRun` 不存在(idle / host idle)直接启动(host 入口 agentId 强制 HOST_AGENT_ID、mode='host');`result` / `interrupted` / 子 run `stopped` 走 `sendUserMessage` 同会话追问;其余经 useStartFlow 弹窗确认覆盖运行
- **ChatDrawer 向 code 节点发送富文本前必须确认** → [ChatDrawer.onSend](src/webview/components/ChatDrawer/index.tsx):`isCodeNode` 且 content 是含非 text 块的数组时弹 Modal 确认,确认后仅提取 text 块拼接为字符串再发送
- **破坏性编辑锁** → [flowIsDestructiveReadOnly](src/common/flowState.ts):当前恒返回 false(已取消运行中只读限制,任意时候允许改图)
- **ExtensionMessage 按 sessionId 分桶** → [ExtensionMessage.ts](src/webview/utils/ExtensionMessage.ts):没有 `sessionId` 的 signal(如 `flow.signal.error`)不入桶
- **webview 粘贴双路径** → `<AgentFlow>` 内 = 粘贴 Agent(保留内部连接、ID 重映射);画布空白 / App 层 = 作为 Flow JSON 导入
- **CodeRef.line** → `line?: [number, number]`,整文件为 `undefined`;Tag 仅 line 存在时显示行号,点击 `openFile` undefined 时只打开不选中;`Ctrl/Cmd+Shift+L` 选中注入带行片段,无选中注入整文件
