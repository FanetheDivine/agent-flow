import { groupBy } from 'lodash-es'
import { z } from 'zod'

export * from './event'

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

/** Agent的系统提示词 */
export const FlowPrompt: string[] = [
  '你是一个工作流中的 Agent，通过**任务描述**和多轮对话完成一项任务。',
  '当前工作流的所有 Agent 共享一份全局数据（**shareValues**），你可以使用 AgentControllerMcp 提供的工具来读写共享数据：',
  ' - getShareValues：按键读取之前 Agent 设置的数据',
  ' - getAllShareValues：读取全部共享数据',
  ' - setShareValues：写入键值对到共享数据，供后续 Agent 读取',
  '当你认为任务**已完成**时，先查看 AgentControllerMcp 提供的 AgentComplete 工具的相关信息——它定义了 0 个或多个输出分支。',
  '通过调用 AgentComplete，你可以提交任务结果并选择一个输出分支（如果有的话）。',
  '**重要**：在你实际调用 AgentComplete 之前，**必须**先使用 AskUserQuestion 工具，让用户确认任务结果和输出分支。',
  '如果用户没有确认，**禁止**调用 AgentComplete。',
  '\n**任务描述**：',
]
