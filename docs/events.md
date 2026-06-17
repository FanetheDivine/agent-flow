# 事件契约补充说明

本文件补充 [src/common/event.ts](../src/common/event.ts) 中未展开的契约细节。

## 事件命名约定

- `flow.command.*`：webview → extension（命令，驱动 runner / 状态变更）
- `flow.signal.*`：extension → webview（信号，镜像状态 / 通知 UI）

两者共享同一 `flowId` 命名空间。`runId` 标识单次 Agent 运行，`agentId` 标识 Flow 中的节点。

## 事件载荷约束

- `flow.signal.aiMessage` 的 `message` 字段来自 SDK `stream_event`，结构与 SDK 原生一致（`type: 'stream_event'`）。非流式消息（`type: 'result'` / `'assistant'` 等）走 `flushMessages.flush()` 立即发送，不进入节流队列。
- `flow.command.sendUserMessage` / `flow.command.interruptAgent` / `flow.command.answerToolPermission` 必须携带 `runId`，store 不做末位 run 推断。
- `flow.signal.toolPermissionResult` 与 `flow.command.toolPermissionResult` 语义一致，入口不同：silent_task 自动应答走 signal，人工回答走 command。
- `openFile.cwd` 用于 webview 行内 code 文件引用的相对路径解析；extension 端优先按绝对路径打开，否则以 `cwd` 或 workspace root 拼接。
- `flow.command.fork` 由 extension 顶层 `handleFork` 处理；`flow.signal.fork` 由 webview 创建新 Flow 并切换视图，详见 [fork.md](fork.md)。
- `openCodeEditor`（webview → extension）在 VSCode 编辑器中打开 Code 节点代码（生成 `.js` 临时文件 + JSDoc 类型声明）；`codeEditorUpdate`（extension → webview）文件保存时同步代码回表单
- `closeCodeEditor`（webview → extension）仅在 Drawer 关闭时清理临时文件并关闭 VSCode editor tab；extension 仅监听 `onDidSaveTextDocument`（不监听 tab 关闭与文件编辑）。
- `flow.signal.agentComplete` 的 `overwrite` 字段携带上游 code 节点返回的 `AgentOverwrite`，reducer 据此写入新 `AgentRun.overwrite`；省略时新 run 无 overwrite。

## 硬约束

- `FlowRunnerManager.handleCommand` 必须用 `keyof` + `.exhaustive()` 写完整 `flow.command.*` 分支，禁止使用吞错兜底。
- 命令派发的 `runId` 传递规则（`sendUserMessage` / `interruptAgent` / `answerToolPermission` 必传，store 不做末位 run 推断）详见 [webview-state.md](webview-state.md)。
