# fork 链路

## 关键文件

- [`../src/extension/index.ts`](../src/extension/index.ts) — `handleFork`、locate、transcript 映射、signal 发送。
- [`../src/extension/FlowRunnerManager/index.ts`](../src/extension/FlowRunnerManager/index.ts) — `spawnForFork` / `spawnForRestore`。
- [`../src/extension/FlowRunnerManager/FlowRunner/index.ts`](../src/extension/FlowRunnerManager/FlowRunner/index.ts) — lazy executor。
- [`../src/webview/store/flow.ts`](../src/webview/store/flow.ts) — `flow.signal.fork` 后注入新 Flow 与切换 active。
- [`../src/webview/components/ChatDrawer/ChatPanel/MessageBubble.tsx`](../src/webview/components/ChatDrawer/ChatPanel/MessageBubble.tsx) — `buildForkIcon` 与 fork 按钮。
- [`../src/webview/components/ChatDrawer/index.tsx`](../src/webview/components/ChatDrawer/index.tsx) — ChatPanel key unmount。

## command / signal

- `flow.command.fork.target = { runId, messageUuid, forkToolUse? }`，target 带 `runId`，不带 `agentId`。
  - `forkToolUse = true`：`messageUuid` 传 `tooluse_uuid`（`ToolUseMessage.uuid`），切片终点为悬挂 tool_use（仅 AskUserQuestion / ExitPlanMode / Edit），不含 tool_result。
  - 缺省 / `false`：`messageUuid` 传 `toolResultUuid`，切到 tool_result 之后。
- `flow.signal.fork` 只带新 runState；webview 从 `newRunState.runs.at(-1).agentId` 反推当前 agent。

## extension 路径

fork 走 `handleFork`：

1. `locateFork` 根据 `runId` 与 `messageUuid` 定位源消息：`forkToolUse=true` 时按 `uuid` 直接匹配 tool_use 项；普通工具（`forkToolUse` 缺省 / `false`）按 `toolResultUuid` 匹配 tool_use 项。两者均向下包含 `parentToolUseId` 子消息。
2. 并发取源 session 与新 session transcript。
3. 按位置建立 `srcUuid → newUuid` 映射。
4. 替换 slicedMessages 中所有带 uuid 的 SDK 消息；普通工具（`forkToolUse=false`）的 `toolResultUuid` 一并 remap 到新 session uuid，保证新 Flow 内再次 fork 时切片终点正确。
5. `forkToolUse=true`：切片末端 tool_use 置 `status='pending'`，删 `result` 与 `toolResultUuid`，预填 `pendingToolPermissions`（让 UI 立即展示权限 / 提问卡片，Flow 进入 `awaiting-tool-permission`）。此步在 `markInterrupted` 之后执行，避免 pending 被翻为 interrupted。
6. `setRunState` 写入新 FlowRunState。
7. `spawnForFork` 启动 FlowRunner + lazy executor。
8. 发送 `flow.signal.fork`。

新 run 由 `structuredClone(targetRun)` 复制，继承源 run 的 `shareValuesSnapshot`（会话开始时点快照）与 `overwrite`。lazy executor 首次启动经 `getRunSnapshot(runId)` 从 state 读此快照作 `currentValues`，经 `getRunOverwrite(runId)` 读取源 run 的临时改写配置，复现 fork 起点的 system prompt、ReadShareValue、work_mode 与 `outputs[].require_confirm`，与历史自洽；旧持久化 run 无快照字段时兜底 `getLatestShareValues()`。restore 路径（`spawnForRestore`）同源共用此 lazy executor 机制。

## webview 路径

webview 收到 `flow.signal.fork` 后：

- push 新 Flow。
- 切 active flow。
- 打开 ChatDrawer。
- 用户首次发消息走 `sendUserMessage`，不经 `flowStart`。

## fork 锚点

`buildForkIcon` 按消息类型决定是否渲染 fork 按钮及选用哪个 uuid：

- text / thinking（`status: 'done'`）：取自身 uuid 作 fork 锚点。
- tool_use（`status: 'done'`）：携带两个 uuid —— `tooluse_uuid`（含 tool_use 的 assistant 消息 uuid，即 `ToolUseMessage.uuid`）与 `toolResultUuid`（tool_result 所在 user 消息的 uuid）：
  - 三特殊工具（AskUserQuestion / ExitPlanMode / Edit）：以 `tooluse_uuid` 为锚点，`forkToolUse=true`，新会话停在悬挂 tool_use（等待用户权限 / 提问卡片）。
  - 其余工具：以 `toolResultUuid` 为锚点（缺省 `forkToolUse`），切片到 tool_result 之后；无 `toolResultUuid` 时不渲染 fork 按钮。
- user / turn_end / agent_complete / error：不渲染 fork 按钮。
- 来自 subAgent 的消息（有 `parentToolUseId`）不渲染 fork 按钮。
- streaming 消息 uuid 未定稿，不能作回溯命中。

## 限制

- `forkToolUse=true` 可 fork 到悬挂 tool_use（AskUserQuestion / ExitPlanMode / Edit），其余工具以 tool_result 为切片终点（`forkToolUse` 缺省或 `false`）。
- fork 到悬挂 tool_use 后，`handleFork` 预填 FlowRunState 的 `pendingToolPermissions`（UI 立即展示权限 / 提问卡片），但 executor 内部 Map 为空（lazy executor 未经 `canUseTool`）；用户作答走 `answerToolPermission` 兜底分支，构造 `tool_result` 推入输入流（详见 [tool-permission.md](tool-permission.md)「fork lazy 兜底」）。
- 来自 subAgent 的 tool_use 不能 fork，避免 fork 到无法寻址的消息位置。
- 检测子消息归属时必须确保当前 fork 消息有 `toolUseId`。
- code 节点不支持作 fork 起点。
- ChatPanel 跨 Flow / 跨 run 切换必须 unmount，详见 [webview-state.md](webview-state.md)。
