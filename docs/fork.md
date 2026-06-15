# fork 链路

## 关键文件

- [`../src/extension/index.ts`](../src/extension/index.ts) — `handleFork`、locate、transcript 映射、signal 发送。
- [`../src/extension/FlowRunnerManager/index.ts`](../src/extension/FlowRunnerManager/index.ts) — `spawnForFork`。
- [`../src/extension/FlowRunnerManager/FlowRunner/index.ts`](../src/extension/FlowRunnerManager/FlowRunner/index.ts) — lazy executor。
- [`../src/webview/store/flow.ts`](../src/webview/store/flow.ts) — `flow.signal.fork` 后注入新 Flow 与切换 active。
- [`../src/webview/components/ChatDrawer/ChatPanel/MessageBubble.tsx`](../src/webview/components/ChatDrawer/ChatPanel/MessageBubble.tsx) — `deriveForkUuid` 与 fork 按钮。
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
5. `setRunState` 写入新 FlowRunState。
6. `spawnForFork` 启动 FlowRunner + lazy executor。
7. 发送 `flow.signal.fork`。

## webview 路径

webview 收到 `flow.signal.fork` 后：

- push 新 Flow。
- 切 active flow。
- 打开 ChatDrawer。
- 用户首次发消息走 `sendUserMessage`，不经 `flowStart`。

## fork 锚点

`deriveForkUuid` 只取有 uuid 的消息：

- text / thinking / tool_use：取自身 uuid。
- user / turn_end：向前回溯到最近一条有 uuid 的消息。
- agent_complete / error：无 uuid，不能作 fork 锚点。
- streaming 消息 uuid 未定稿，不能作回溯命中。

## 限制

- SDK 不支持把 AskUserQuestion 作 fork 终点。
- 来自 subAgent 的 tool_use 不能 fork，避免 fork 到无法寻址的消息位置。
- 检测子消息归属时必须确保当前 fork 消息有 `toolUseId`。
- code 节点不支持作 fork 起点。
- ChatPanel 跨 Flow / 跨 run 切换必须 unmount，详见 [webview-state.md](webview-state.md)。
