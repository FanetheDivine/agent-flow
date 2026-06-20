# tool permission 链路

## 关键文件

- [`../src/common/event.ts`](../src/common/event.ts) — `toolPermissionRequest` / `toolPermissionResult` 事件。
- [`../src/common/flowRunState.ts`](../src/common/flowRunState.ts) — pending / answered 队列与 phase 推断。
- [`../src/extension/FlowRunnerManager/FlowRunner/ClaudeExecutor.ts`](../src/extension/FlowRunnerManager/FlowRunner/ClaudeExecutor.ts) — `preToolUseHook`（硬拒绝）与 `canUseTool`（Agent Flow 确认 / silent 自动应答）。
- [`../src/extension/FlowRunnerManager/FlowRunner/CodeExecutor.ts`](../src/extension/FlowRunnerManager/FlowRunner/CodeExecutor.ts) — code 节点 `askUserQuestion` 的 permission 请求 / 回答。
- [`../src/webview/components/ChatDrawer/ChatPanel/MessageBubble.tsx`](../src/webview/components/ChatDrawer/ChatPanel/MessageBubble.tsx) — tool_use 气泡与权限卡片路由。
- [`../src/webview/components/ChatDrawer/ChatPanel/ToolUseDetails.tsx`](../src/webview/components/ChatDrawer/ChatPanel/ToolUseDetails.tsx) — toolName 展示转换。

## 统一机制

AskUserQuestion、CompleteTask(require_confirm)、ExitPlanMode、must_confirm_tools 四类挂起共用一套机制：

- 一个 `pendingToolPermissions` 队列。
- 一个 `answeredToolPermissions` 记录。
- 一个 `awaiting-tool-permission` phase。
- 一对 `toolPermissionRequest` / `toolPermissionResult` 事件。
- 一个 `answerToolPermission(toolUseId, allow, opts?)` 方法。

挂起、回答、回显统一走 reducer 通道；CodeExecutor 内的 `askUserQuestion` 也复用同一组 `toolPermissionRequest` / `toolPermissionResult` 事件与 `answerToolPermission` 回答入口；工具是否挂起由下方决策链决定。

## 工具鉴权决策链

分两阶段：**preToolUseHook**（硬拒绝，优先级高于 Claude Code）→ Claude Code 原生鉴权 → **canUseTool**（Agent Flow 逻辑，仅在原生鉴权未决策时介入）。

**preToolUseHook**：

1. subAgent 调用 AgentControllerMcp：直接拒绝。
2. `deny_tools`：`matchToolRule` 黑名单语义，任一子命令命中即拒绝；拒绝理由由「任务引用 + 收尾引用」拼成，两部分条件独立：任务引用为 `依据<task_description>执行任务`（有 `agent_prompt` 且非 chat）或 `执行用户指定的任务`（无 `agent_prompt` 或 chat）；非 chat（task/silent_task 必有 `<completion_contract>`）时追加 `，按<completion_contract>收尾`，chat 不追加。整体形如 `禁止使用 <denyDesc>，<任务引用><收尾引用?>`。
3. 其余 `{ continue: true }`，交给 Claude Code 原生鉴权。

**canUseTool**（Claude Code 原生鉴权未决策时）：

1. AskUserQuestion：silent_task 自动应答；其余挂起等用户确认。
2. CompleteTask：先用 `buildCompleteTaskInputShape(agent)` 构建 schema 做 Zod `safeParse`，非法即 deny（消息前缀「参数错误：」）；require_confirm 时挂起等用户确认；否则直接放行。
3. ExitPlanMode：先校验 `{ planFilePath: string, allowedPrompts?: any[] }`，非法即 deny（消息前缀「参数错误：」）；silent_task 自动接受；其余挂起等用户确认。
4. `must_confirm_tools`：`matchToolRule`；silent_task 自动拒绝，其余挂起。
5. 其余工具：直接放行。

`matchTool` 是白名单语义，要求所有子命令匹配；`matchToolRule` 是黑名单语义，任一子命令匹配即命中；两者共用 `matchToolImpl`。

## silent_task 自动处理

- AskUserQuestion：自动回答，走 `flow.signal.toolPermissionResult` 回显卡片。
- ExitPlanMode：自动接受，走 `flow.signal.toolPermissionResult` 回显卡片，不触发 `pushEffect`。
- must_confirm_tools：自动拒绝，因无人确认禁止使用。
- 普通工具授权：不命中 `must_confirm_tools` 时走 `canUseTool` 第 5 条直接 allow，静默处理。
- 自动续轮、AskUserQuestion 自动应答、ExitPlanMode 自动接受、must_confirm 自动拒绝共享 `SILENT_MAX_AUTO_REPLIES = 30` per-run 上限；如需调整改 `ClaudeExecutor.ts` 底部常量。

## webview 展示规则

[`../src/webview/components/ChatDrawer/ChatPanel/MessageBubble.tsx`](../src/webview/components/ChatDrawer/ChatPanel/MessageBubble.tsx) 的 `tool_use` 分支按工具类型展示：

- pending 阶段：消息队列返回 null，由底部固定卡片渲染。
- CompleteTask pending：确认卡片直接挂在消息队列内。
- 失败且无 answered：展示默认 tool_use 气泡，不展示权限卡片；此时气泡可挂 fork(Edit/CompleteTask)。
- 成功或用户已回答：展示 ToolPermissionCard 的已回答形态；已回答但 result 未到达时 loading。`answered.message` 存拒绝理由，传给 `ToolPermissionCard` 时映射为 `reason` 字段。
- AskUserQuestion：必须存在 answered 才展示已回答卡片；无 answered 时返回 null。

## fork-reask 权限链路

三工具（AskUserQuestion / ExitPlanMode / Edit）的 tool_use 支持从 active 权限卡片 fork（reask 路径）：

1. 用户点击权限卡片上的 fork 按钮，发送 `flow.command.fork`（target 为该 tool_use 的 assistant uuid）。
2. `handleFork` 创建新 session，切片末端为该 tool_use；构造 newRun 时 `interrupted: false`，tool_use 重置为 `pending`，清空旧 `result` 与 `answeredToolPermissions` 中该 toolUseId 的旧答案。
3. `pendingToolPermissions` 预填一项 `{runId, toolUseId, toolName, input}`，`getRunPhase` 直接推断 `awaiting-tool-permission`，webview 底部立即展示权限卡片。
4. executor 保持 lazy 不启动（SDK resume 悬空 tool_use 不会重新触发 `canUseTool`，原 `startReask()` 路径已失效并移除）。
5. 用户回答卡片后，`FlowRunner.handleToolPermissionResult` 用 `ts-pattern` 分流：`hasPendingPermission` Map 未命中（fork 悬空 tool_use 无 Promise）→ 从 `getRunMessages(runId)` 取 toolName + input，调 `ClaudeExecutor.injectToolResult`：用 `buildToolResultText` 按工具类型生成文本，构造 `SDKUserMessage`（content 为 tool_result 块数组）注入 SDK 触发 resume，走正常 tool_result 处理流程。ExitPlanMode allow 时强制 `permissionMode='default'` 解锁后续写工具。Map 命中 → 走普通 `answerToolPermission` resolve Promise。

依赖关系：reask 不再依赖 SDK resume 触发 `canUseTool`，改为 fork 时直接预填 `pendingToolPermissions` 进卡片态，用户回答后由 FlowRunner 层分流注入 tool_result 驱动 SDK 继续。

## 两条权限应答路径

`FlowRunner.handleToolPermissionResult` 根据 `hasPendingPermission(toolUseId)` 分流，两条路径互不干扰：

- **普通 canUseTool resolve**（Map 命中）：`canUseTool` 挂起时创建 Promise 存入 `executor.pendingToolPermissions` Map；回答时 `answerToolPermission` resolve Promise，SDK 真执行工具（Edit 写文件、ExitPlanMode 切模式等）。
- **fork reask 注入 tool_result**（Map 未命中）：fork 悬空 tool_use 无 Promise（executor lazy 未启动）；回答时从 `getRunMessages(runId)` 取 toolName + input，`injectToolResult` 构造 `SDKUserMessage`（content 为 tool_result 块）+ `events.onMessage` echo，SDK resume 续接。不产生工具副作用（Edit 不写文件）；ExitPlanMode allow 需额外置 `permissionMode='default'` 解锁后续写工具；AskUserQuestion 无副作用。

区分依据：`executor.pendingToolPermissions` Map 命中 = 普通 resolve；未命中 = reask 注入。不可混淆——普通 Edit allow 若走注入路径会导致文件状态漂移。

## 硬约束

- 只有一套 tool permission 机制，禁止为特殊工具新增旁路。
- `ReadShareValue` 走 `canUseTool` 第 5 条兜底放行（"其余工具直接放行"），不新增任何旁路；subagent 调用时 `preToolUseHook` 第 1 条（subAgent 调用 AgentControllerMcp）直接拒绝。
- `flow.signal.toolPermissionResult` 与 `flow.command.toolPermissionResult` 语义一致但入口不同。
- run 结束时未回答的 pending 权限由 `clearPendings` 自动标记为拒绝。
- 工具类型判定必须用 `.includes('CompleteTask'/'ExitPlanMode'/'AskUserQuestion')`，兼容 `mcp__AgentControllerMcp__X`（canUseTool 收到）与 `AgentControllerMcp::X`（parseToolName 转换）两种格式，禁止使用严格等值判断（与 `::` 格式永不相等）。
