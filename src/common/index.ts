import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { groupBy } from 'lodash-es'
import { z } from 'zod'

// ── Flow Schemas & Types ────────────────────────────────────────────────────────────────

/** Agent 的输出分支，同时定义有向图中的一条边 */
export const OutputSchema = z.object({
  /** 分支名称（在当前 agent 内唯一） */
  output_name: z.string(),
  /** 分支描述（写入提示词，指导 AI 选择） */
  output_desc: z.string(),
  /** 下一个进入的agent，省略则表示终点，可以是当前agent */
  next_agent: z.string().optional(),
})

/** @see {@link OutputSchema} */
export type Output = z.infer<typeof OutputSchema>

/** Agent，具有多轮对话能力的独立任务执行单元 */
export const AgentSchema = z.object({
  /** Agent使用的模型 */
  model: z.string().optional(),
  /** Agent名称，唯一标识 */
  agent_name: z.string(),
  /** 提示词，描述 agent 行为 */
  agent_prompt: z.array(z.string()),
  /** 是否可作为 Flow 的入口 Agent */
  is_entry: z.boolean().optional(),
  /** 输出分支，可以连接任意数量的agent */
  outputs: z.array(OutputSchema).optional(),
})

/** @see {@link AgentSchema} */
export type Agent = z.infer<typeof AgentSchema>

/** Agent 作为节点构成的有向图 */
export const FlowSchema = z.object({
  /** Flow 名称 */
  name: z.string(),
  /** 当前Flow内的agent，其outputs定义了边 */
  agents: z.array(AgentSchema).optional(),
})

/** @see {@link FlowSchema} */
export type Flow = z.infer<typeof FlowSchema>

/** 单条消息记录 */
export const MessageSchema = z.object({
  role: z.enum(['user', 'agent']),
  content: z.string(),
  timestamp: z.string(),
})

/** @see {@link MessageSchema} */
export type Message = z.infer<typeof MessageSchema>

/** 单步执行记录，一个 Agent 的执行过程 */
export const StepSchema = z.object({
  /** Agent 名称 */
  agentName: z.string(),
  /** 消息列表 */
  messages: z.array(MessageSchema),
  /** agent完成后，AI选择的输出分支名及输出内容 */
  output: z
    .object({
      /** 输出分支名 */
      output_name: z.string().optional(),
      /** 输出内容 */
      content: z.string(),
    })
    .optional(),
})

/** @see {@link StepSchema} */
export type Step = z.infer<typeof StepSchema>

/** 运行状态 */
export const RunStateSchema = z.object({
  /** 当前活跃的 agent，最多一个 */
  currentAgent: z
    .object({
      name: z.string(),
      /**
       * 运行状态\
       * preparing - agent 正在准备\
       * ready - 可以接受用户输入\
       * generating - AI 正在输出\
       * completed - 已完成
       */
      status: z.enum(['preparing', 'ready', 'generating', 'completed']),
    })
    .optional(),
  /** 执行步骤列表 */
  steps: z.array(StepSchema),
  /** Flow 全局共享上下文，agent 间通过 MCP tool 读写 */
  shareValues: z.record(z.string(), z.string()),
})

/** @see {@link RunStateSchema} */
export type RunState = z.infer<typeof RunStateSchema>

// ── Flow 校验 ──────────────────────────────────────────────────────────────────

/** Flow 语义校验结果 */
export type FlowValidationResult = {
  /** 重复的 agent_name 列表 */
  duplicateAgentNames?: string[]
  /** 引用了不存在 agent 的 output，按源 agent_name 分组，值为非法引用的 next_agent 名称数组 */
  invalidNextAgent?: Record<string, string[]>
  /** 同一 agent 内重复的 output_name，按 agent_name 分组，值为重复的 output_name 数组 */
  duplicateOutputNames?: Record<string, string[]>
  /** 是否缺少入口 agent（没有任何 is_entry 为 true 的 agent） */
  noEntry?: boolean
}

/**
 * 校验 Flow 合法性
 *
 * 语义校验规则：
 * - agent_name 在 flow 内唯一
 * - output_name 在同一 agent 内唯一
 * - next_agent 引用的 agent 存在
 * - Flow 中至少有一个 is_entry: true 的 agent
 *
 * @param flow - 待校验的 Flow 对象
 */
export function validateFlow(flow: Flow): FlowValidationResult {
  const result: FlowValidationResult = {}
  const { agents = [] } = flow
  const agentNames = agents.map((a) => a.agent_name)
  // 校验 agent_name 在 flow 内唯一
  const agentsGroupedByName = groupBy(agentNames)
  const duplicateAgentNames = Object.entries(agentsGroupedByName)
    .filter(([, names]) => names.length > 1)
    .map(([agent_name]) => agent_name)
  if (duplicateAgentNames.length > 0) {
    result.duplicateAgentNames = duplicateAgentNames
    // 其余错误必须在agent_name唯一的情况下进行描述
    return result
  }

  // 校验"output_name 在同一 agent 内唯一"/"next_agent 引用的 agent 存在"
  const duplicateOutputNames: Record<string, string[]> = {}
  const invalidNextAgent: Record<string, string[]> = {}

  for (const agent of agents) {
    const { agent_name, outputs = [] } = agent
    const outputsGroupedByName = groupBy(outputs, (v) => v.output_name)
    const dupOutputs = Object.entries(outputsGroupedByName)
      .filter(([, items]) => items.length > 1)
      .map(([output_name]) => output_name)
    if (dupOutputs.length > 0) {
      duplicateOutputNames[agent_name] = dupOutputs
    }

    const badNextAgents = outputs
      .map((o) => o.next_agent)
      .filter((na): na is string => na !== undefined)
      .filter((na) => !agentNames.includes(na))
    if (badNextAgents.length > 0) {
      invalidNextAgent[agent_name] = badNextAgents
    }
  }

  if (Object.keys(duplicateOutputNames).length > 0) {
    result.duplicateOutputNames = duplicateOutputNames
  }
  if (Object.keys(invalidNextAgent).length > 0) {
    result.invalidNextAgent = invalidNextAgent
  }

  // Flow 中至少有一个 is_entry: true 的 agent
  if (!agents.some((a) => a.is_entry)) {
    result.noEntry = true
  }

  return result
}

// ── Flow 事件 ─────────────────────────────────────────────────────────────

/**
 * AI消息类型 — 会话中一切事件的统一类型（判别联合），
 * 包含用户消息、AI回复、流式事件、系统通知、工具进度等全部子类型，
 * 可用 `SDKMessage[]` 完整描述整个会话流。
 *
 * @see sdk-message-types.md
 */
export type AIMessageType = SDKMessage
/**
 * 用户消息类型 — 可表述一切用户行为，
 * 支持文本、图片、文档、工具结果返回、中止工具调用等。
 *
 * @see sdk-message-types.md
 */
export type UserMessageType = SDKUserMessage

/**
 * webview 与 extension 间的事件
 */
export type ExtensionEvents = {
  /** 加载Flow */
  loadFlow: [flow: Flow]

  /**
   * Flow 事件定义
   *
   * 事件参数中的标识符：
   * - id: extension 端分配的运行 ID，标识一次 Flow 运行实例
   * - key: webview 端分配的 key，传入 flow 内部用于校验响应归属
   * - session_id: 当前 agent session 的标识，消息交互必须在两端 session_id 对齐的基础上发生
   *
   * 开启 Flow 的流程：
   * 1. webview 生成 key，发起 flowStart command
   * 2. extension 中断当前 Flow，将 key 传入新 Flow 内部进行校验，分配新 id，创建 agent session，发出 flowStart signal
   * 3. webview 校验 signal 中的 key 与自己发出的一致后，保存 id 和 session_id
   *    （用户可随时开始新 Flow，通过 key 校验确保 id 对应当前请求）
   *
   * 消息交互：
   * - 所有消息（AI/用户）均携带 id + session_id，确保归属明确
   * - flow 收到 userMessage command 后，通过 userMessage signal 回显，保证两端数据一致
   *
   * Agent 切换：
   * - agent 选择 output 后，agentComplete 携带新 session_id 供后续交互使用
   */

  // ── signal: Flow 发出的信号 ──────────────────────────────────────────

  /** Flow 启动成功，携带 key 供 webview 校验归属 */
  'flow.signal.flowStart': [id: string, key: string, session_id: string, agentName: string]
  /** AI 输出（流式），必须在 id + session_id 对齐下发生 */
  'flow.signal.aiMessage': [id: string, session_id: string, message: AIMessageType]
  /** 回显用户消息，确保 webview 与 flow 数据一致 */
  'flow.signal.userMessage': [id: string, session_id: string, message: UserMessageType]
  /** Agent 执行完成，选择了输出分支；output.session_id 为下一轮交互的新 session */
  'flow.signal.agentComplete': [
    id: string,
    session_id: string,
    content: string,
    output?: { name: string; session_id: string },
  ]
  /** Agent被中断了 */
  'flow.signal.agentInterruptted': [id: string, session_id: string]
  /** agent错误 */
  'flow.signal.agentError': [id: string, agentName: string, err: Error]
  /** flow运行错误 */
  'flow.signal.error': [msg: string]

  // ── command: Flow 接收的指令 ─────────────────────────────────────────

  /** webview 发起启动，key 传入 flow 内部用于校验响应归属 */
  'flow.command.flowStart': [key: string, agentName: string]
  /** 向当前 Agent 发送用户消息，必须在 id + session_id 对齐下发生 */
  'flow.command.userMessage': [id: string, session_id: string, message: UserMessageType]
  /** 中断当前 Agent，使其等待用户输入 */
  'flow.command.interrupt': [id: string, session_id: string]
}

/** Flow 发出的信号 */
export type FlowSignalEvents = {
  [K in keyof ExtensionEvents as K extends `flow.signal.${string}` ? K : never]: ExtensionEvents[K]
}

/** Flow 接收的指令 */
export type FlowCommandEvents = {
  [K in keyof ExtensionEvents as K extends `flow.command.${string}` ? K : never]: ExtensionEvents[K]
}
