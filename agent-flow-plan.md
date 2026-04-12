# Agent Flow

## 核心概念

- **Agent**：具有多轮对话能力的独立任务执行单元。用户可与当前 Agent 自由对话，Agent 通过 Claude Agent SDK 执行任务。Agent 自行决定任务是否完成，以及输出的类型。
- **Flow**：Agent 作为节点构成的有向图。一个Agent的output可以指向下一个Agent，这种关系构成了图的边。
- **运行约束**：同一时间只能存在一个活跃的 Agent。允许从任意 Agent 开启任务。允许设置不能从某个Agent开启任务。

### 1. 类型定义

```typescript
/** Agent 的输出分支，同时定义有向图中的一条边 */
type Output = {
  output_name: string // 分支名称（在当前 agent 内唯一）
  output_desc: string // 分支描述（写入提示词，指导 AI 选择）
  next_agent?: string // 目标 agent 的 agent_name；省略则表示终点
}

/** Agent = 具有多轮对话能力的独立任务执行单元 */
type Agent = {
  agent_name: string // 唯一标识
  agent_prompt: string // 提示词，描述 agent 行为
  not_entry?: boolean // 是否可作为 Flow 的入口 Agent
  outputs: Output[] // 输出分支（同时定义该节点到其他节点的边）
}

/** Flow = Agent 作为节点构成的有向图 */
type Flow = {
  name: string
  agents: Agent[] // agents[i].outputs[].next_agent 构成所有边
}

/** 单条消息记录 */
type Message = {
  role: 'user' | 'agent'
  content: string
  timestamp: string
}

/** 单步执行记录（一个 Agent 的完整执行过程） */
type Step = {
  agentName: string
  messages: Message[]
  outputName?: string // AI 选择的分支名
  outputContent: string // AI 的输出文本
}

/** 运行状态 */
type RunState = {
  id: string
  flow: Flow
  currentAgent: string // 当前活跃的 agent（同时仅一个）
  status: 'running' | 'completed' | 'error'
  steps: Step[]
  shareValues: Record<string, string> // Flow 全局共享上下文，agent 间通过 MCP tool 读写
}
```

**设计要点**：

- `Agent.outputs` 既是业务语义（输出分支），也是图的边定义——无需单独的边结构
- `Agent.is_entry` 标记该 Agent 是否可作为入口：UI 据此过滤可选起点，`startRun` 据此校验
- `Step` 包含完整对话记录 `messages[]`，体现 Agent 的多轮对话本质
- `RunState.currentAgent` 单值，强制"同一时间仅一个活跃 Agent"
- `RunState.shareValues` 为字符串键值对，生命周期与单次 Run 绑定，不跨 Run 持久化
- 无缓存/持久化——RunState 仅存在于运行期内存

### 2. Flow 校验

校验规则如下

| 规则                                           | 级别  |
| ---------------------------------------------- | ----- |
| `agent_name` 在 flow 内唯一                    | error |
| `next_agent` 引用的 agent 存在                 | error |
| `output_name` 在同一 agent 内唯一              | error |
| Flow 中至少有一个非 `not_entry: true` 的 agent | error |

### 3. FlowRunner

`FlowRunner` 是 Flow 的控制器，采用双向事件接口——`.on()` 订阅 Flow 向外发出的事件，`.emit()` 向 Flow 发出指令：

```typescript
class FlowRunner {
  /**
   * 传入 Flow 对象创建实例。
   */
  constructor(flow: Flow)

  // 订阅Flow事件
  on(event: 'agentStart', cb: (agent: Agent, input: string) => void): this
  on(event: 'agentOutput', cb: (chunk: string) => void): this
  on(event: 'agentToolUse', cb: (tool: string, input: unknown) => void): this
  on(event: 'agentToolResult', cb: (result: unknown) => void): this
  on(
    event: 'agentComplete',
    cb: (agentName: string, outputName: string, content: string) => void,
  ): this
  on(event: 'flowComplete', cb: (finalOutput: string) => void): this
  on(event: 'error', cb: (err: Error) => void): this

  // 向Flow发出指令
  emit(event: 'start', payload: { agentName: string; input: string }): void
  emit(event: 'userMessage', payload: { message: string }): void
  emit(event: 'cancel'): void

  // 同步状态查询
  getState(): RunState | null // 未 start 前返回 null
}
```

**设计要点**：

- `FlowRunner` 取代原有 `Orchestrator` + `Run` 两个类，职责合并、接口对称
- 构造时校验代替 `loadFlow()`，失败即早抛出，无法创建非法实例
- `.on()` 返回 `this` 支持链式调用
- `emit("start")` 内部校验目标 Agent 的 `is_entry: true`，不满足则触发 `error` 事件（不抛出，保持异步一致性）
- `emit("userMessage")` 在 `status !== "running"` 时静默忽略
- `emit("cancel")` 幂等，重复调用无副作用
- `RunState.shareValues` 在 `emit("start")` 时初始化为 `{}`，整个运行周期唯一；切换 Agent 时将同一引用传入 `executor.start()`

### 4. Claude Agent SDK 执行器

通过 `@anthropic-ai/claude-agent-sdk` 的 `query()` 函数与 Claude 交互，接收结构化的 `SDKMessage` 事件流。
**完成信号通过注入自定义 MCP tool `AgentComplete` 实现**——AI 自主决定何时调用该工具结束当前 Agent，无需解析文本标记。
同时注入三个 **ShareValues 工具**，供 Agent 读写 `RunState.shareValues` 全局共享上下文。

#### 4.1 MCP Tool Schema

| 工具名              | 描述                              | 入参                                             | 返回                             |
| ------------------- | --------------------------------- | ------------------------------------------------ | -------------------------------- |
| `AgentComplete`     | 标记当前 Agent 完成并选择输出分支 | `output_name: string`（枚举）, `content: string` | `void`（确认文本）               |
| `setShareValues`    | 批量写入键值对到共享上下文        | `values: Record<string, string>`                 | `void`（确认文本）               |
| `getShareValues`    | 按键列表读取共享上下文            | `keys: string[]`                                 | `Record<string, string>`（JSON） |
| `getAllShareValues` | 读取共享上下文全部键值对          | _(无)_                                           | `Record<string, string>`（JSON） |

```typescript
// setShareValues
input:  { values: { [key: string]: string } }
output: { content: [{ type: "text", text: "已写入 N 个键：key1, key2, ..." }] }

// getShareValues
input:  { keys: string[] }
output: { content: [{ type: "text", text: "{\"key1\":\"val1\", ...}" }] }
//       缺失的键以 null 填充：{ "missing_key": null }

// getAllShareValues
input:  {}
output: { content: [{ type: "text", text: "{\"key1\":\"val1\", ...}" }] }
```

#### 4.2 实现

```typescript
import {
  query,
  tool,
  createSdkMcpServer,
  type SDKMessage,
  type Query,
} from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

type ExecutorResult = {
  outputName: string // AI 选择的分支名
  outputContent: string // AI 的输出文本
}

type ExecutorEvents = {
  onOutput: (chunk: string) => void // Claude 文本输出 → 转发 UI
  onToolUse: (tool: string, input: any) => void // 工具调用事件 → 转发 UI
  onToolResult: (result: any) => void // 工具结果 → 转发 UI
  onComplete: (result: ExecutorResult) => void // agent 完成
  onError: (err: Error) => void
}

class ClaudeExecutor {
  private queryInstance: Query | null = null
  private abortController: AbortController | null = null
  private completed = false

  /** 启动 Agent SDK query，注入 AgentComplete + ShareValues 三个工具 */
  async start(
    prompt: string,
    outputs: Output[],
    shareValues: Record<string, string>,
    events: ExecutorEvents,
  ): Promise<void> {
    this.completed = false
    this.abortController = new AbortController()

    // ── AgentComplete ──────────────────────────────────────────────────────
    // 根据当前 agent 的 outputs 动态生成 output_name 枚举
    const outputNames = outputs.map((o) => o.output_name)
    const outputDescs = outputs.map((o) => `  - "${o.output_name}": ${o.output_desc}`).join('\n')

    const agentCompleteTool = tool(
      'AgentComplete',
      `当前任务已完成时调用此工具，选择输出分支并提交最终内容。\n可选分支：\n${outputDescs}`,
      {
        output_name: z.enum(outputNames as [string, ...string[]]).describe('选择的输出分支名'),
        content: z.string().describe('输出内容，将传递给下一个 Agent 或作为最终结果'),
      },
      async ({ output_name, content }) => {
        if (!this.completed) {
          this.completed = true
          events.onComplete({ outputName: output_name, outputContent: content })
        }
        return {
          content: [{ type: 'text' as const, text: `已确认完成，分支：${output_name}` }],
        }
      },
    )

    // ── setShareValues ─────────────────────────────────────────────────────
    // 批量写入，避免多次单键调用的开销
    const setShareValuesTool = tool(
      'setShareValues',
      '批量写入键值对到 Flow 全局共享上下文（shareValues），供后续 Agent 读取',
      {
        values: z
          .record(z.string(), z.string())
          .describe('要写入的键值对，例如：{ "result": "foo", "status": "done" }'),
      },
      async ({ values }) => {
        Object.assign(shareValues, values)
        const keys = Object.keys(values).join(', ')
        return {
          content: [
            { type: 'text' as const, text: `已写入 ${Object.keys(values).length} 个键：${keys}` },
          ],
        }
      },
    )

    // ── getShareValues ─────────────────────────────────────────────────────
    // 按需读取，避免无谓地暴露全量数据
    const getShareValuesTool = tool(
      'getShareValues',
      '按键列表读取 Flow 全局共享上下文中的值，缺失的键返回 null',
      {
        keys: z.array(z.string()).describe('要读取的键名数组，例如：["result", "status"]'),
      },
      async ({ keys }) => {
        const result: Record<string, string | null> = {}
        for (const key of keys) {
          result[key] = shareValues[key] ?? null
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        }
      },
    )

    // ── getAllShareValues ──────────────────────────────────────────────────
    // 全量读取，适用于需要完整上下文的场景
    const getAllShareValuesTool = tool(
      'getAllShareValues',
      '读取 Flow 全局共享上下文的全部键值对',
      {},
      async () => {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(shareValues) }],
        }
      },
    )

    // ── 创建内联 MCP 服务器 ────────────────────────────────────────────────
    const mcpServer = createSdkMcpServer({
      name: 'AgentControllerMcp',
      version: '1.0.0',
      tools: [agentCompleteTool, setShareValuesTool, getShareValuesTool, getAllShareValuesTool],
    })

    this.queryInstance = query({
      prompt,
      options: {
        abortController: this.abortController,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        mcpServers: { AgentControllerMcp: mcpServer },
        // 可按需配置：
        // model: "claude-sonnet-4-6",
        // cwd: "/path/to/project",
        // maxBudgetUsd: 5.0,
        // allowedTools: ["Read", "Write", "Edit", "Grep", "Glob", "Bash"],
        // env: { ANTHROPIC_API_KEY: "...", ANTHROPIC_BASE_URL: "..." },
      },
    })

    try {
      for await (const message of this.queryInstance) {
        this.handleMessage(message, events)
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        events.onError(err as Error)
      }
    }
  }

  /** 从 UI 转发用户消息到 SDK（支持多轮对话） */
  async sendUserMessage(message: string): Promise<void> {
    if (!this.queryInstance) return
    await this.queryInstance.streamInput(
      (async function* () {
        yield { type: 'user' as const, message }
      })(),
    )
  }

  /** 终止执行 */
  kill(): void {
    this.abortController?.abort()
    this.queryInstance?.close()
    this.queryInstance = null
  }

  /** 解析 SDK 消息并触发对应事件 */
  private handleMessage(msg: SDKMessage, events: ExecutorEvents): void {
    switch (msg.type) {
      case 'assistant': {
        const content = msg.message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') events.onOutput(block.text)
            if (block.type === 'tool_use') events.onToolUse(block.name, block.input)
          }
        }
        break
      }
      case 'user': {
        if (msg.tool_use_result !== undefined) {
          events.onToolResult(msg.tool_use_result)
        }
        break
      }
      case 'result': {
        if (msg.subtype === 'success') {
          // SDK 正常结束但 AI 未调用 AgentComplete（兜底）
          if (!this.completed) {
            this.completed = true
            events.onComplete({ outputName: '', outputContent: msg.result })
          }
        } else {
          events.onError(new Error(msg.errors?.join('; ') ?? 'Unknown error'))
        }
        break
      }
    }
  }
}
```

**设计要点**：

- `setShareValues` 接受 `Record<string, string>`，支持批量写入，减少工具调用次数
- `getShareValues` 接受 `string[]`，按需返回子集；缺失键显式返回 `null`，避免 AI 误判
- `getAllShareValues` 无参数，返回完整快照，适用于 Agent 需要全量上下文的场景
- 三个工具共享同一个 `shareValues` 对象引用，写入即时对同次 Run 内所有后续 Agent 可见
- `start()` 形参由 `context` 重命名为 `shareValues`，与 `RunState.shareValues` 字段名一致
