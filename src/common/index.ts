import { groupBy } from 'lodash-es'
import { match, P } from 'ts-pattern'
import { z } from 'zod'

export * from './event'
export * from './flowRunState'

// ── Flow Schemas & Types ────────────────────────────────────────────────────────────────

/** Agent 的输出分支，同时定义有向图中的一条边 */
export const OutputSchema = z.object({
  output_name: z.string().describe('分支名称（在当前 agent 内唯一）'),
  output_desc: z.string().optional().describe('分支描述（写入提示词，指导 AI 选择正确的输出分支）'),
  next_agent: z.string().optional().describe('下一个进入的 agent 的 id，省略则表示工作流终点'),
})

/** @see {@link OutputSchema} */
export type Output = z.infer<typeof OutputSchema>

/** Agent，具有多轮对话能力的独立任务执行单元 */
export const AgentSchema = z.object({
  id: z.string().describe('Agent 唯一 ID'),
  model: z.string().min(1).describe('使用的模型，可选 "sonnet"（复杂推理）或 "haiku"（快速简单）'),
  effort: z
    .enum(['low', 'medium', 'high', 'xhigh', 'max'])
    .optional()
    .describe('AI 思考的努力程度，影响响应速度与质量的权衡'),
  agent_name: z.string().describe('Agent 名称，flow 内唯一'),
  agent_desc: z.string().optional().describe('Agent 简介，简要描述该 Agent 的职责与定位'),
  agent_prompt: z.string().describe('系统提示词，定义 Agent 的行为与职责，要具体可执行'),
  outputs: z.array(OutputSchema).optional().describe('输出分支，可以连接任意数量的 agent'),
  auto_allowed_tools: z
    .union([z.literal(true), z.array(z.string())])
    .optional()
    .describe(
      '自动允许执行的工具：true 表示全部放行；字符串数组为白名单。特殊值 "MCP" 匹配所有 mcp__* 工具',
    ),
  must_confirm_tools: z
    .array(z.string())
    .optional()
    .describe(
      '必须用户确认的工具名；优先级高于 auto_allowed_tools。特殊值 "MCP" 匹配所有 mcp__* 工具',
    ),
  work_mode: z
    .enum(['auto_complete', 'require_confirm', 'never_complete'])
    .describe(
      '工作方式：auto_complete（自动完成）任务达成后直接调用 AgentComplete；require_confirm（用户确认后完成）调用 AgentComplete 前必须先用 AskUserQuestion 确认；never_complete（永不完成）禁止调用 AgentComplete，agent_prompt 视作长期对话规则而非一次性任务',
    ),
  no_input: z
    .boolean()
    .optional()
    .describe(
      '无输入启动：true 时节点操作区显示启动按钮，点击时始终以"开始"为初始消息自动运行（忽略用户实际输入）',
    ),
  enable_share_values: z
    .boolean()
    .optional()
    .describe(
      '启用共享存储：true 时注入 setShareValues / getShareValues / getAllShareValues 工具与提示词；默认 false 时本 Agent 看不到也不会被告知共享存储',
    ),
})

/** @see {@link AgentSchema} */
export type Agent = z.infer<typeof AgentSchema>

/** Agent 作为节点构成的有向图 */
export const FlowSchema = z.object({
  id: z.string().describe('Flow 唯一标识'),
  name: z.string().describe('Flow 名称'),
  agents: z.array(AgentSchema).optional().describe('当前 Flow 内的 agent，其 outputs 定义了连接边'),
})

/** @see {@link FlowSchema} */
export type Flow = z.infer<typeof FlowSchema>

/** AskUserQuestion 工具的 input 结构（SDK 内建工具，claude_code 预设提供） */
export type AskUserQuestionOption = {
  label: string
  description: string
  preview?: string
}
export type AskUserQuestionItem = {
  question: string
  header: string
  multiSelect?: boolean
  options: AskUserQuestionOption[]
}
export type AskUserQuestionInput = {
  questions: AskUserQuestionItem[]
}
export type AskUserQuestionOutput = {
  questions: AskUserQuestionItem[]
  /** 每个 question 对应的答案；多选以英文逗号分隔 */
  answers: Record<string, string>
  annotations?: Record<string, { notes?: string; preview?: string }>
}

/** 持久化到本地的 flows */
export const PersistedDataSchema = z.object({ flows: z.array(FlowSchema) })

/** @see {@link PersistedDataSchema} */
export type PersistedData = z.infer<typeof PersistedDataSchema>

// ── Flow 校验 ──────────────────────────────────────────────────────────────────

/** Flow 语义校验结果 */
export type FlowValidationResult = {
  /** 重复的 agent id 列表 */
  duplicateAgentIds?: string[]
  /** 重复的 agent_name 列表 */
  duplicateAgentNames?: string[]
  /** 引用了不存在 agent 的 output，按源 agent_name 分组，值为非法引用的 next_agent id 数组 */
  invalidNextAgent?: Record<string, string[]>
  /** 同一 agent 内重复的 output_name，按 agent_name 分组，值为重复的 output_name 数组 */
  duplicateOutputNames?: Record<string, string[]>
}

/**
 * 校验 Flow 合法性
 *
 * 语义校验规则：
 * - id 在 flow 内唯一
 * - agent_name 在 flow 内唯一
 * - output_name 在同一 agent 内唯一
 * - next_agent 引用的 agent id 存在
 *
 * @param flow - 待校验的 Flow 对象
 */
export function validateFlow(flow: Flow): FlowValidationResult {
  const result: FlowValidationResult = {}
  const { agents = [] } = flow

  // 校验 id 在 flow 内唯一
  const agentIds = agents.map((a) => a.id)
  const idsGrouped = groupBy(agentIds)
  const duplicateAgentIds = Object.entries(idsGrouped)
    .filter(([, ids]) => ids.length > 1)
    .map(([id]) => id)
  if (duplicateAgentIds.length > 0) {
    result.duplicateAgentIds = duplicateAgentIds
  }

  // 校验"output_name 在同一 agent 内唯一"/"next_agent 引用的 agent id 存在"
  const duplicateOutputNames: Record<string, string[]> = {}
  const invalidNextAgent: Record<string, string[]> = {}
  const validAgentIds = new Set(agentIds)

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
      .filter((na) => !validAgentIds.has(na))
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

  return result
}

/** 通配符：匹配所有 `mcp__*` 工具。用于 auto_allowed_tools / must_confirm_tools 的字符串项 */
export const MCP_WILDCARD = 'MCP'

/** Claude Code 预设提供的常见工具名，用于 AgentEditModal 的候选项 */
export const BUILTIN_TOOL_NAMES = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'AskUserQuestion',
  'SlashCommand',
  'Skill',
  'Agent',
] as const

/**
 * 判断工具名是否命中给定的 pattern 列表。
 *
 * 规则：
 * - 字面量相等（大小写敏感）
 * - 特殊值 "MCP" 匹配所有以 `mcp__` 开头的工具（即任意 MCP 工具）
 */
export function matchTool(toolName: string, patterns: readonly string[]): boolean {
  for (const p of patterns) {
    if (p === MCP_WILDCARD) {
      if (toolName.startsWith('mcp__')) return true
    } else if (p === toolName) {
      return true
    }
  }
  return false
}

/**
 * 构建 Agent 系统提示词
 *
 * 根据 `work_mode` 选取不同的提示词骨架：
 * - `auto_complete` / `require_confirm`：把 `agent_prompt` 视作**任务描述**，
 *   要求 Agent 围绕该任务推进，并在产物达成后调用 AgentComplete（自动 / 用户确认后）
 * - `never_complete`：把 `agent_prompt` 视作**长期对话规则**，
 *   会话不会结束、禁止调用 AgentComplete，用户消息就是新的对话输入
 */
export function buildAgentSystemPrompt(
  agent: Pick<
    Agent,
    | 'agent_prompt'
    | 'outputs'
    | 'work_mode'
    | 'enable_share_values'
    | 'no_input'
    | 'agent_name'
    | 'agent_desc'
  >,
): string {
  const {
    agent_name,
    agent_desc,
    agent_prompt,
    outputs = [],
    work_mode,
    enable_share_values = false,
  } = agent

  const lines: string[] = [
    '始终使用**中文**进行思考和回复。',
    '信息不足时，**禁止**凭空推测，应当尝试读取文件、执行命令行或使用 Tool 获取有效信息，或使用 AskUserQuestion 询问用户。',
    '',
  ]

  // Agent 简介（可选）
  if (agent_desc) {
    lines.push('# Agent 简介', `${agent_name}：${agent_desc}`, '')
  }

  // 共享存储（可选）
  if (enable_share_values) {
    lines.push(
      '# 共享存储',
      '通过 AgentControllerMcp 提供的工具可以读写一份共享数据源（shareValues）：',
      ' - getShareValues / getAllShareValues：按 key 读取 / 全量读取',
      ' - setShareValues：写入键值对',
      '该数据源**并非由你独占**，外部随时可能修改其中的值。当你需要最新数据时，应当**重新调用** getShareValues / getAllShareValues 获取，而不是依赖之前读到的快照。',
      '',
    )
  }

  // 对话规则：长期对话规则 / 围绕任务描述完成任务（含完成任务、输出分支）
  match(work_mode)
    .with('never_complete', () => {
      lines.push('# 对话规则', agent_prompt, '')
    })
    .with(P.union('auto_complete', 'require_confirm'), (mode) => {
      lines.push(
        '# 对话规则',
        '下方「任务描述」是本次对话的**最终目标**，在整个对话过程中固定不变。',
        '你需要围绕该目标与用户进行多轮对话：根据用户输入主动推进、必要时使用 AskUserQuestion 向用户收集信息、读取文件或调用工具补全上下文，直到达成结束条件。',
        '',
        '## 任务描述',
        agent_prompt,
        '',
        '## 完成任务',
      )
      match(mode)
        .with('auto_complete', () =>
          lines.push(
            '如果「任务描述」规定的结束条件已经达成、且与用户对齐之后，调用 AgentControllerMcp 的 AgentComplete 工具提交结果，并选择一个输出分支（如有）。',
            '直接调用 AgentComplete，无需向用户额外确认。',
          ),
        )
        .with('require_confirm', () =>
          lines.push(
            '如果「任务描述」规定的结束条件已经达成时，调用 AgentControllerMcp 的 AgentComplete 工具提交结果，并选择一个输出分支（如有）。',
            '**重要**：调用 AgentComplete 前必须先用 AskUserQuestion 让用户确认结果与输出分支；用户未确认前**禁止**调用 AgentComplete。',
          ),
        )
        .exhaustive()

      lines.push(
        '',
        '## 输出分支',
        match(outputs.length)
          .with(0, () => '此任务没有输出分支。')
          .otherwise(() =>
            outputs
              .map((o) => `  - "${o.output_name}"${o.output_desc ? `: ${o.output_desc}` : ''}`)
              .join('\n'),
          ),
        '',
      )
    })
    .exhaustive()

  return lines.join('\n')
}
