# ShareValues 授权读写

## 关键文件

- [`../src/common/index.ts`](../src/common/index.ts) — `Flow.shareValuesKeys`、prompt 注入、schema 清理。
- [`../src/common/extension.ts`](../src/common/extension.ts) — `CompleteTask.values` 动态 schema。
- [`../src/common/flowRunState.ts`](../src/common/flowRunState.ts) — values 合并与 setShareValues reducer。
- [`../src/extension/FlowRunStateManager.ts`](../src/extension/FlowRunStateManager.ts) — extension 端运行态读取。
- [`../src/extension/FlowRunnerManager/FlowRunner/index.ts`](../src/extension/FlowRunnerManager/FlowRunner/index.ts) — next agent prompt 快照拼接。

## 命名

- Flow 视角：`shareValues`。
- Agent 视角：`values`。

## 声明

`Flow.shareValuesKeys` 声明共享数据 key。删除 key 时，相关 `allowed_read_values_keys` / `allowed_write_values_keys` 自动清理。

## 读

`buildAgentSystemPrompt` 注入「可读写数据」与「可用数据」节。可读值是 prompt 时点快照，运行中更新值需要切到下一 agent 后生效。

## 写

- `node_type='agent'`：仅 `CompleteTask.values` 可写；schema 由 `allowed_write_values_keys` 动态生成，未授权 key 静默丢弃。
- `work_mode='chat'`：无 CompleteTask，无法写 values。
- `node_type='code'`：全量读取 shareValues；返回的 `values` 仅提交代码显式修改的 key，delta 合并到 shareValues，不受 allowed_write 约束。

## 事件与运行时取值

- `flow.signal.agentComplete.values`：reducer 合并到 `state.shareValues`。
- `flow.command.setShareValues`：full replace，无 `runId`，未运行时也能编辑。
- extension 端通过 `getLatestShareValues(flowId)` 读取 `FlowRunStateManager` 最新值。
- `FlowRunner` 不持有 shareValues 副本。

## 硬约束

- shareValues 是 prompt 快照；切下一 agent 时必须手动 `{ ...getLatestShareValues(), ...result.values }` 拼接。
- `allowed_read_values_keys` / `allowed_write_values_keys` 仅约束 `node_type='agent'`。
- code 节点全量读、delta 写。
- `setShareValues` 是 full replace，调用方负责传完整对象。
- CompleteTask 的 MCP 参数 schema 见 [common-domain.md](common-domain.md)；CompleteTask 驱动下一 agent 的运行时流程见 [extension-runtime.md](extension-runtime.md)。
