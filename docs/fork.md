# fork 链路

## 关键文件

- [`../src/extension/index.ts`](../src/extension/index.ts) — `handleFork`、locate、transcript 映射、signal 发送。
- [`../src/extension/FlowRunnerManager/index.ts`](../src/extension/FlowRunnerManager/index.ts) — `spawnForFork` / `spawnForRestore`。
- [`../src/extension/FlowRunnerManager/FlowRunner/index.ts`](../src/extension/FlowRunnerManager/FlowRunner/index.ts) — lazy executor。
- [`../src/webview/store/flow.ts`](../src/webview/store/flow.ts) — `flow.signal.fork` 后注入新 Flow 与切换 active。
- [`../src/webview/components/ChatDrawer/ChatPanel/MessageBubble.tsx`](../src/webview/components/ChatDrawer/ChatPanel/MessageBubble.tsx) — `buildForkIcon` 与 fork 按钮。
- [`../src/webview/components/ChatDrawer/index.tsx`](../src/webview/components/ChatDrawer/index.tsx) — ChatPanel key unmount。

## command / signal

- `flow.command.fork.target = { runId, messageUuid }`，target 带 `runId`，不带 `agentId`。
- `flow.signal.fork` 只带新 runState；webview 从 `newRunState.runs.at(-1).agentId` 反推当前 agent。

## extension 路径

fork 走 `handleFork`：

1. 根据 `runId` 与 `messageUuid` 定位源消息。
2. 并发取源 session 与新 session transcript。
3. 按位置建立 `srcUuid → newUuid` 映射。
4. 替换 slicedMessages 中所有带 uuid 的 SDK 消息。
5. 判定 reask：切片末端为三工具（AskUserQuestion / ExitPlanMode / Edit）tool_use 时走 reask 路径。
6. `setRunState` 写入新 FlowRunState。
7. `spawnForFork` 启动 FlowRunner + lazy executor（executor 保持 lazy 不启动，等用户交互后才注入 tool_result）。
8. 发送 `flow.signal.fork`。

新 run 由 `structuredClone(targetRun)` 复制，继承源 run 的 `shareValuesSnapshot`（会话开始时点快照）与 `overwrite`。lazy executor 首次启动经 `getRunSnapshot(runId)` 从 state 读此快照作 `currentValues`，经 `getRunOverwrite(runId)` 读取源 run 的临时改写配置，复现 fork 起点的 system prompt、ReadShareValue、work_mode 与 `outputs[].require_confirm`，与历史自洽；旧持久化 run 无快照字段时兜底 `getLatestShareValues()`。restore 路径（`spawnForRestore`）同源共用此 lazy executor 机制。

## webview 路径

webview 收到 `flow.signal.fork` 后：

- push 新 Flow。
- 切 active flow。
- 打开 ChatDrawer。
- 用户首次发消息走 `sendUserMessage`，不经 `flowStart`。

## fork 锚点

fork 按钮入口分两条路径：

**已完成消息**（[`MessageBubble.tsx`](../src/webview/components/ChatDrawer/ChatPanel/MessageBubble.tsx) `buildForkIcon`）：

- 仅 `status: 'done'` 的 text / thinking / tool_use 消息展示 fork 按钮。
- 直接取 `message.uuid` 作为 fork 切片终点。

**active 权限卡片**（[`ChatPanel/index.tsx`](../src/webview/components/ChatDrawer/ChatPanel/index.tsx) `buildPendingForkButton` + `findForkUuid`）：

- 底部固定的 pending 权限卡片（AskUserQuestion / must_confirm_tools / CompleteTask 等）可挂 fork 按钮。
- `findForkUuid` 按 `runId` + `toolUseId` 反查 tool_use 消息的 assistant uuid 作为 fork 切片终点。
- reask 路径下 fork 直接切到悬空 tool_use（status 已重置为 pending），`pendingToolPermissions` 预填该项，webview 立即展示权限卡片（不启动 SDK）。

**不可作 fork 锚点的消息**：

- user / turn_end / agent_complete / error：无 fork 按钮。
- subAgent 消息：`buildForkIcon` 检测 `parentToolUseId` 后返回 null。
- streaming 消息：uuid 未定稿，`findForkUuid` 返回 undefined。

## reask 路径

切片末端为三工具（AskUserQuestion / ExitPlanMode / Edit）的 tool_use 时走 reask 路径：

- `isReaskTool` helper 判定工具类型：Edit 精确等值（内置工具名），ExitPlanMode / AskUserQuestion 用 `.includes` 兼容 mcp 前缀。
- 构造 newRun 时 `interrupted: false`，末端 tool_use 重置为 `pending`（清空 result），删除 `answeredToolPermissions` 中该 toolUseId 的旧答案。
- `pendingToolPermissions` 预填一项 `{runId, toolUseId, toolName, input}`，`getRunPhase` 直接推断 `awaiting-tool-permission`，webview 底部立即展示权限卡片。
- executor 保持 lazy 不启动（SDK resume 悬空 tool_use 不会重新触发 canUseTool，此路径已失效）；用户回答卡片后由子任务 2 注入 tool_result 触发 SDK resume。
- 三工具不产生 subagent，`locateFork` 子消息逻辑不触发，`messageIdx` 即 tool_use 自身。

非三工具的 tool_use（如普通工具）和其他消息类型保持 interrupted 行为不变。

## 限制

- 来自 subAgent 的 tool_use 不能 fork，避免 fork 到无法寻址的消息位置。
- 检测子消息归属时必须确保当前 fork 消息有 `toolUseId`。
- code 节点不支持作 fork 起点。
- ChatPanel 跨 Flow / 跨 run 切换必须 unmount，详见 [webview-state.md](webview-state.md)。
