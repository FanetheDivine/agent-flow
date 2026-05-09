# CLAUDE.md

本文件指导在此仓库工作的 AI 助手。用户与代码注释主要使用中文，回复也请用中文。

## 项目性质

VSCode 插件 `agent-flow`：**用 Agent 编排工作流**。工作流（Flow）是 Agent 作为节点的有向图，每个 Agent 通过 `@anthropic-ai/claude-agent-sdk` 独立运行，拥有自己的上下文；Agent 之间通过 `shareValues`（MCP 工具）共享数据，通过 `outputs[i].next_agent` 决定下一跳。

## 代码风格

Agent schema 字段用 snake_case 与 prompt 对齐，**不要**改成 camelCase。

**优先用 `ts-pattern` 的 `match` / `P` 代替嵌套三元、冗长 `if/else` / `switch`**：对判别联合、枚举字面量、多值共享分支（`P.union(...)`），用 `.with(...)` + `.exhaustive()`，让新增分支时编译器强制补全。

## 三层源码结构

项目用三个独立的 tsconfig 分别编译 —— 跨层导入只能通过 [src/common/](src/common/)。

| 目录                             | 运行环境                 | tsconfig                                           | 说明                                                                     |
| -------------------------------- | ------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------ |
| [src/common/](src/common/)       | 共享                     | [tsconfig.common.json](tsconfig.common.json)       | Zod schemas、类型、事件契约、prompt 构建。**唯一可被双方 import 的层**。 |
| [src/extension/](src/extension/) | Node（VSCode 扩展宿主）  | [tsconfig.extension.json](tsconfig.extension.json) | `FlowRunnerManager`、`ClaudeExecutor`、`PersistedDataController`。       |
| [src/webview/](src/webview/)     | 浏览器（VSCode Webview） | [tsconfig.webview.json](tsconfig.webview.json)     | React 19 + Ant Design + `@xyflow/react` + `zustand` + `immer`。          |

只有 extension 可以 import `@/common/extension`（MCP server 构建，依赖 SDK）。webview 应 import `@/common`（不含 SDK 依赖）。

## 核心领域模型

`Flow` / `Agent` / `Output` 的字段定义与 [validateFlow](src/common/index.ts) 校验语义见 [src/common/index.ts](src/common/index.ts)。[PersistedDataController](src/extension/PersistedDataController/index.ts) 加载时若解析/校验失败，会整体回退到 `defaultStore`（不保留部分）。

## Extension ↔ Webview 事件契约（[src/common/event.ts](src/common/event.ts)）

消息类型由 `TypeWithPrefix<Payload, 'flow.signal.' | 'flow.command.'>` 生成；`match(e).with({ type: P.string.startsWith(...) }, ...)` 分发。

- **方向**：`flow.command.*` 是 webview → extension，`flow.signal.*` 是 extension → webview
- **标识符**：`flowId`(哪个 Flow) / `runKey`(webview 生成，校验 signal 归属，防止旧 runId 的信号污染新 run) / `runId`(extension 生成，代表本次运行) / `sessionId`(Claude SDK session id，**每切一次 Agent 就换一次**)。消息交互必须在两端 sessionId 对齐下发生。

**启动握手**：

1. webview 生成 `runKey`，发 `flow.command.flowStart`
2. extension 中断旧 runner → 新建 `FlowRunner` → `ClaudeExecutor` 首次从 SDK 拿到 `session_id` → 回调外部 → 发 `flow.signal.flowStart{runKey, runId, sessionId}`
3. webview 验证 `runKey` 一致后存 `runId/sessionId`

**Agent 切换**（[FlowRunner.onAgentComplete](src/extension/FlowRunnerManager/FlowRunner/index.ts)）：`agentComplete` 携带 `output.newSessionId`；extension 端必须先 `killCurrentExecutor()` 再把 `currentSessionId = null`，否则旧 executor 仍能 resolve 旧 sessionId 下的 command。

## 运行时层级

**extension 端**：

- [FlowRunnerManager](src/extension/FlowRunnerManager/index.ts) —— 全局唯一，持有当前活跃的 `FlowRunner`
- [FlowRunner](src/extension/FlowRunnerManager/FlowRunner/index.ts) —— 一个 Flow 的一次运行，按 `outputs[i].next_agent` 编排 Agent 切换，为每个 Agent 创建/销毁 `ClaudeExecutor`
- [ClaudeExecutor](src/extension/FlowRunnerManager/FlowRunner/ClaudeExecutor.ts) —— 封装 `@anthropic-ai/claude-agent-sdk` 的 `query`，负责单个 Agent 的 prompt 流、消息收发、interrupt/resume、canUseTool 判定
- [AgentControllerMcp](src/common/extension.ts) —— per-Agent 的 MCP server，作为 SDK `mcpServers` 配置注入；提供 `AgentComplete` / `setShareValues` / `getShareValues` / `getAllShareValues` / `validateFlow` 工具

**webview 端**：组件树由 [App](src/webview/App.tsx) 起，`<AgentFlow>`（xyflow 画布）+ `<ChatDrawer>`（右侧对话抽屉）为两块主区域。所有状态收敛到单一 zustand store [useFlowStore](src/webview/store/flow.ts)（用 `immer` 写 reducer），同时持有持久化的 Flow 定义和运行时 `RunState`；从 extension 来的 signal 也由 store 收敛处理（含上述通知/自动打开 ChatPanel 的副作用）。

`shareValues` 对象在整个 Run 内**以引用**贯穿所有 Agent 的 `AgentControllerMcp`，写入即时对后续 Agent 可见。

## 与用户的特殊交互

收到 AI 消息时除了写入状态机，还会触发**用户交互层面的副作用**：

- **通知**：`awaiting-message` / `awaiting-question` / `flow-completed` / `agent-error` 四类 signal 触发通知（[updateFlowRunState](src/common/flowState.ts) 产出 `NotifyEffect[]`）。extension 端在 webPanel 不可见时弹 VSCode 通知；webview 端在页面隐藏 / 不在当前 Flow / 不在当前 Agent 对话时弹 antd notification（[fireNotifications](src/webview/store/flow.ts)）。
- **自动打开 ChatPanel**：前三类 signal 若收消息时 `activeFlowId` 与之相同且 ChatDrawer 未开则自动打开；`agentComplete` 时 ChatDrawer 若停在已完成的 agent 上则自动跟随切到下一个。

## 易踩坑

- **next_agent 是 id 不是 name**：复制 Agent 节点时（[useFlowStore.copyAgents](src/webview/store/flow.ts)）必须重新生成 id 并通过 `idMap` 重映射 `next_agent` 引用
- **破坏性编辑锁**：`phase === 'starting' | 'running'` 时禁止删节点 / 删边 / 改连接（[flowIsDestructiveReadOnly](src/webview/store/flow.ts)）
- **ExtensionMessage 的 sessionId 索引**：[ExtensionMessage.ts](src/webview/utils/ExtensionMessage.ts) 按 `sessionId` 分桶保存消息；没有 `sessionId` 的 signal（如 `flow.signal.error`）不会进桶
- **状态分层**：Flow 定义持久化到 `.agent-flows.json`（`os.homedir()`）；`FlowRunState` 仅在内存，extension 端由 [FlowRunStateManager](src/extension/FlowRunStateManager.ts) 镜像（webview 关闭重开后能继续接 AI 消息）；UI 状态（`activeFlowId`、`chatDrawer` 等）仅存在于 webview
- **ChatPanel 的"开始运行"**：`phase === 'idle'` 直接启动，非 idle 非 awaiting 要 modal 确认（会清空运行数据），见 [ChatDrawer.onSend](src/webview/components/ChatDrawer.tsx)
- **webview 粘贴双路径**：`<AgentFlow>` 内粘贴 = 粘贴 Agent（保留内部连接、ID 重映射）；画布空白 / App 层粘贴 = 作为 Flow JSON 导入
- **代码片段（CodeRef）的 `line`**：`line?: [number, number]`，整个文件时为 `undefined`。Tag 仅在 `line` 存在时展示行范围；点击 Tag 触发 `openFile`，`line` 为 `undefined` 时只打开文件不选中行。快捷键 `Ctrl+Shift+L`（Mac: `Cmd+Shift+L`）：有选中文字时注入带行范围的片段，**无选中时注入整个文件**(`line` 省略)。
