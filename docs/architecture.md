# 架构边界

## 项目性质

VSCode 插件 `agent-flow` 用 Agent 编排工作流。Flow 是 Agent 节点组成的有向图，每个 Agent 独立运行，按 `outputs[i].next_agent` 决定下一跳，通过 Flow 的 `shareValues` 共享数据。

## 三层源码结构

跨层 import 只能经 [`../src/common/`](../src/common/)。三个独立 tsconfig 对应三层源码：

- [`../src/common/`](../src/common/) — 共享层，包含 Zod schema、类型、事件契约、prompt 构建；webview 应 import `@/common`。
- [`../src/extension/`](../src/extension/) — Node / VSCode 扩展宿主，可 import `@/common/extension` 使用 SDK 相关能力。
- [`../src/webview/`](../src/webview/) — React 19 + AntD + `@xyflow/react` + `zustand`(immer)。

## 状态归属

- Flow 定义按作用域持久化，详见 [persistence.md](persistence.md)。
- `FlowRunState` 是运行态，extension 端由 [`../src/extension/FlowRunStateManager.ts`](../src/extension/FlowRunStateManager.ts) 镜像，webview 端由 [`../src/webview/store/flow.ts`](../src/webview/store/flow.ts) 镜像。
- UI 状态只归属 webview，不写入 Flow 定义。
- `cwd` 只存 `FlowRunState`，详见 [flow-run-state.md](flow-run-state.md)。

## 硬约束

- 跨层 import 只能经 `src/common/`，webview 禁止直接 import SDK / Node-only 模块。
- `node_type='agent'` 走 ClaudeExecutor，`node_type='code'` 走 CodeExecutor；二者字段与运行行为分离。
- `Flow.project` 是内存/UI 标记，保存前由 `stripFlowRuntimeFields` 剥离，详见 [persistence.md](persistence.md)。
