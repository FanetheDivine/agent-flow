# CLAUDE.md

本文件指导在此仓库工作的 AI 助手。用户与代码注释主要使用中文，回复也请用中文。

## 项目性质

VSCode 插件 `agent-flow`：**用 Agent 编排工作流**。工作流（Flow）是 Agent 作为节点的有向图，每个 Agent 通过 `@anthropic-ai/claude-agent-sdk` 独立运行，拥有自己的上下文；Agent 之间通过 `shareValues`（MCP 工具）共享数据，通过 `outputs[i].next_agent` 决定下一跳。

**不要误解"工作流生成 Agent"的 `agent_prompt`**：这类 Agent 的产物是"可被映射为 Flow 节点的步骤列表"，不是"执行用户需求的结果"。举例：任务是"拆分用户需求"，用户输入"写周报"时应输出拆分步骤，**不要**真的去写周报。

## 常用命令

```bash
pnpm watch          # esbuild + tsc watch 并行
pnpm compile        # check-types + lint + esbuild（一次性）
pnpm package        # 生产构建（minify）
pnpm check-types    # tsc --build（不产出 JS，只产声明）
pnpm lint           # eslint src
pnpm format         # prettier --write .
```

构建产物：[dist/extension.js](dist/extension.js)（node cjs）+ [dist/webview/index.js](dist/webview/index.js)（iife）+ `.css`。

## 三层源码结构

项目用三个独立的 tsconfig 分别编译 —— 跨层导入只能通过 [src/common/](src/common/)。

| 目录                             | 运行环境                 | tsconfig                                           | 说明                                                                     |
| -------------------------------- | ------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------ |
| [src/common/](src/common/)       | 共享                     | [tsconfig.common.json](tsconfig.common.json)       | Zod schemas、类型、事件契约、prompt 构建。**唯一可被双方 import 的层**。 |
| [src/extension/](src/extension/) | Node（VSCode 扩展宿主）  | [tsconfig.extension.json](tsconfig.extension.json) | `FlowRunnerManager`、`ClaudeExecutor`、`PersistedDataController`。       |
| [src/webview/](src/webview/)     | 浏览器（VSCode Webview） | [tsconfig.webview.json](tsconfig.webview.json)     | React 19 + Ant Design + `@xyflow/react` + `zustand` + `immer`。          |

构建规则见 [esbuild.mjs](esbuild.mjs)：extension 端将 `vscode` 和 `@anthropic-ai/claude-agent-sdk` 标记为 external（后者在运行时从 `node_modules` 加载），webview 端用 `tailwindPlugin` 处理 CSS。

只有 extension 可以 import `@/common/extension`（MCP server 构建，依赖 SDK）。webview 应 import `@/common`（不含 SDK 依赖）。

## 核心领域模型（[src/common/index.ts](src/common/index.ts)）

- **`Flow`** = `{ id, name, agents? }`
- **`Agent`** = `{ id, agent_name, model, effort?, agent_prompt[], outputs?, auto_allowed_tools?, must_confirm_tools?, auto_complete? }`
  - `agent_name` flow 内唯一（仅展示 / 便于区分），`id` 才是引用的主键
  - `auto_allowed_tools: true | string[]` —— `true` 放行全部；数组中的 `"MCP"` 通配所有 `mcp__*` 工具
  - `must_confirm_tools: string[]` —— 优先级高于 auto_allowed；同样支持 `"MCP"` 通配
  - `auto_complete: false` —— 调用 `AgentComplete` 前必须先 `AskUserQuestion` 确认
- **`Output`** = `{ output_name, output_desc?, next_agent? }`
  - `next_agent` 存的是 **agent.id**，不是 `agent_name`；查找时用 `flow.agents.find(a => a.id === ...)`
  - `next_agent === agent.id` 合法（自环），省略 = 工作流终点

用 [validateFlow](src/common/index.ts#L114) 校验语义（id/name 唯一、output_name 同 agent 内唯一、`next_agent` 必须存在）。[PersistedDataController](src/extension/PersistedDataController/index.ts) 加载时若解析/校验失败，会整体回退到 `defaultStore`（不保留部分）。

## Extension ↔ Webview 事件契约（[src/common/event.ts](src/common/event.ts)）

消息类型由 `TypeWithPrefix<Payload, 'flow.signal.' | 'flow.command.'>` 生成；`match(e).with({ type: P.string.startsWith(...) }, ...)` 分发。

**方向**：

- `flow.command.*` webview → extension（`flowStart`、`userMessage`、`interrupt`、`answerQuestion`、`toolPermissionResult`）
- `flow.signal.*` extension → webview（`flowStart`、`aiMessage`、`agentComplete`、`agentInterrupted`、`agentError`、`error`、`toolPermissionRequest`）

**标识符**（文档见 [src/common/event.ts:77-97](src/common/event.ts#L77-L97)）：

- `flowId` —— 哪个 Flow
- `runKey` —— webview 生成，用于校验 signal 归属（防止旧 runId 的信号污染新 run）
- `runId` —— extension 生成，代表本次运行
- `sessionId` —— Claude SDK 的 session id，**每切一次 Agent 就换一次**；消息交互必须在两端 sessionId 对齐下发生

**启动握手**：

1. webview 生成 `runKey`，发 `flow.command.flowStart`
2. extension 中断旧 runner → 新建 `FlowRunner` → `ClaudeExecutor` 首次从 SDK 拿到 `session_id` → 回调外部 → 发 `flow.signal.flowStart{runKey, runId, sessionId}`
3. webview 验证 `runKey` 一致后存 `runId/sessionId`

**Agent 切换**（[FlowRunner.onAgentComplete](src/extension/FlowRunnerManager/FlowRunner/index.ts#L291)）：`agentComplete` 携带 `output.newSessionId`；extension 端必须先 `killCurrentExecutor()` 再把 `currentSessionId = null`，否则旧 executor 仍能 resolve 旧 sessionId 下的 command。

## Claude SDK 集成（[src/extension/FlowRunnerManager/FlowRunner/ClaudeExecutor.ts](src/extension/FlowRunnerManager/FlowRunner/ClaudeExecutor.ts)）

- `systemPrompt: { type: 'preset', preset: 'claude_code', append: buildAgentSystemPrompt(agent) }`
  —— Agent 拥有 Claude Code 的内建工具（`AskUserQuestion`、`Bash`、`Read` 等）
- `prompt` 是一个 `AsyncIterable`（`createMessageChannel`），支持多轮对话；`interrupt()` 只 `queryInstance.interrupt()`，保留 `sessionId` 供下次 `sendUserMessage` 以 `options.resume` 恢复
- `canUseTool`：`AskUserQuestion` 挂起到 `pendingPermissions`（等 `answerQuestion()` 填充 `updatedInput.answers`）；其他工具按 `must_confirm_tools` → `auto_allowed_tools` → 兜底挂起顺序判定
- 完成信号通过 MCP 工具 `AgentComplete` 返回（不解析文本）

## 注入给 Agent 的 MCP 工具（[src/common/extension.ts](src/common/extension.ts)）

每个 Agent 创建独立的 `AgentControllerMcp` server：

- `AgentComplete` —— 出参 `output_name` 被动态约束为 agent.outputs 的枚举；`outputs` 为空时改为无 `output_name` 参数的变体
- `setShareValues` / `getShareValues` / `getAllShareValues` —— `shareValues` 对象**以引用传入**，写入即时对当次 Run 的后续 Agent 可见
- `validateFlow` —— 供"工作流生成 Agent"自我校验产物

## Agent System Prompt 规则（[buildAgentSystemPrompt](src/common/index.ts#L216)）

`buildAgentSystemPrompt` 处理**所有通用规则**（用户消息是材料不是任务、AskUserQuestion 用法、AgentComplete 语义、shareValues 工具），写 `agent_prompt` 时**只需聚焦本 Agent 的产物形态**。别在 `agent_prompt` 里重写通用规则。

## 代码风格

[.prettierrc](.prettierrc)：`singleQuote`、`jsxSingleQuote`、`semi: false`、`trailingComma: all`、`printWidth: 100`、`tabWidth: 2`。Import 顺序：`react` → `react.*` → `antd` → `@ant-design/*` → 第三方 → `@/xxx` → `@/xxx/*` → 相对路径。

[eslint.config.mjs](eslint.config.mjs) 关了 `@typescript-eslint/no-explicit-any` 和 `camelcase`（因为 Agent schema 字段用 snake_case 与 prompt 对齐）。**不要**把 `agent_name`、`output_name` 等改成 camelCase。

其他高频依赖：`ts-pattern`（穷尽匹配）、`zod`（schema 同时产出 TS 类型）、`immer` + `zustand`（webview 状态）、`ahooks`（React hooks）。

## 易踩坑

- **next_agent 是 id 不是 name**：复制 Agent 节点时（[useFlowStore.copyAgents](src/webview/store/flow.ts#L556)）必须重新生成 id 并通过 `idMap` 重映射 `next_agent` 引用
- **破坏性编辑锁**：`phase === 'starting' | 'running'` 时禁止删节点 / 删边 / 改连接（[flowIsDestructiveReadOnly](src/webview/store/flow.ts#L180)）
- **ExtensionMessage 的 sessionId 索引**：[ExtensionMessage.ts](src/webview/utils/ExtensionMessage.ts) 按 `sessionId` 分桶保存消息；没有 `sessionId` 的 signal（如 `flow.signal.error`）不会进桶
- **Persist 存的是 Flow 定义**，运行时 `RunState` 只在内存。`.agent-flows.json` 放在 `os.homedir()`
- **ChatPanel 的"开始运行"**：`phase === 'idle'` 直接启动，非 idle 非 awaiting 要 modal 确认（会清空运行数据），见 [ChatDrawer.onSend](src/webview/components/ChatDrawer.tsx#L21)
- **webview 粘贴双路径**：`<AgentFlow>` 内粘贴 = 粘贴 Agent（保留内部连接、ID 重映射）；画布空白 / App 层粘贴 = 作为 Flow JSON 导入
- **代码片段（CodeRef）的 `line`**：`line?: [number, number]`，整个文件时为 `undefined`。Tag 仅在 `line` 存在时展示行范围；点击 Tag 触发 `openFile`，`line` 为 `undefined` 时只打开文件不选中行。快捷键 `Ctrl+Shift+L`（Mac: `Cmd+Shift+L`）：有选中文字时注入带行范围的片段，**无选中时注入整个文件**（`line` 省略）。
