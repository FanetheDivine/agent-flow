import { groupBy } from 'lodash-es'
import { match, P } from 'ts-pattern'
import { z } from 'zod'

export * from './event'
export * from './flowRunState'
import { HOST_AGENT_ID } from './flowRunState'

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
  agent_prompt: z.string().describe('系统提示词，定义 Agent 的行为与职责，要具体可执行').optional(),
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
  allowed_read_values_keys: z
    .array(z.string())
    .optional()
    .describe('允许读取的 values key 子集；Agent 仅能通过系统提示词看到这些 key 的当前值'),
  allowed_write_values_keys: z
    .array(z.string())
    .optional()
    .describe('允许写入的 values key 子集；Agent 仅能在 AgentComplete 时写入这些 key'),
})

/** @see {@link AgentSchema} */
export type Agent = z.infer<typeof AgentSchema>

/** 共享数据 key 声明：key 为字段名，desc 仅用于设计期标注语义（不进入 prompt / MCP schema） */
export const ShareValueKeySchema = z.object({
  key: z.string().describe('共享数据 key 名称，在 Flow 内唯一'),
  desc: z.string().optional().describe('共享数据语义描述'),
})

/** @see {@link ShareValueKeySchema} */
export type ShareValueKey = z.infer<typeof ShareValueKeySchema>

/** Agent 作为节点构成的有向图 */
export const FlowSchema = z.object({
  id: z.string().describe('Flow 唯一标识'),
  name: z.string().describe('Flow 名称'),
  host_model: z.string().optional().describe('托管模型：负责整体编排/兜底的模型名称'),
  host_effort: z
    .enum(['low', 'medium', 'high', 'xhigh', 'max'])
    .optional()
    .describe('托管模型的努力程度'),
  host_prompt: z.string().optional().describe('托管提示词：注入给托管模型的系统提示词'),
  agents: z.array(AgentSchema).optional().describe('当前 Flow 内的 agent，其 outputs 定义了连接边'),
  shareValuesKeys: z.array(ShareValueKeySchema).optional().describe('Flow 可用的共享数据 key 集合'),
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
  /** 使用了保留 ID（HOST_AGENT_ID）的 agent_name 列表 */
  reservedAgentIds?: string[]
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

  // 校验 id 不能使用保留值 HOST_AGENT_ID
  const reservedAgentIds = agents.filter((a) => a.id === HOST_AGENT_ID).map((a) => a.agent_name)
  if (reservedAgentIds.length > 0) {
    result.reservedAgentIds = reservedAgentIds
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

/** AgentEditor / FlowEditor 共用的模型候选项（AutoComplete 选项） */
export const MODEL_OPTIONS = [
  { value: 'opus', label: 'opus' },
  { value: 'gpt-5.5', label: 'gpt-5.5' },
  { value: 'glm-5.1', label: 'glm-5.1' },
  { value: 'DeepSeek-V4-Pro', label: 'DeepSeek-V4-Pro' },
  { value: 'claude-opus-4-7', label: 'opus4.7' },
  { value: 'claude-opus-4-6-v1', label: 'opus4.6' },
  { value: 'sonnet', label: 'sonnet' },
  { value: 'haiku', label: 'haiku' },
  { value: 'gpt-5.4', label: 'gpt-5.4' },
  { value: 'MiniMax-M2.7', label: 'MiniMax-M2.7' },
  { value: 'DeepSeek-V4-flash', label: 'DeepSeek-V4-flash' },
]

/** AgentEditor / FlowEditor 共用的努力程度候选项（Select 选项） */
export const EFFORT_OPTIONS = [
  { label: 'low — 简单任务', value: 'low' },
  { label: 'medium — 日常任务', value: 'medium' },
  { label: 'high — 复杂任务', value: 'high' },
  { label: 'xhigh — 长程任务(opus4.7+)', value: 'xhigh' },
  { label: 'max — 最大性能(opus4.6+)', value: 'max' },
]

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
    | 'allowed_read_values_keys'
    | 'allowed_write_values_keys'
    | 'no_input'
    | 'agent_name'
  >,
  currentValues?: Record<string, string>,
): string {
  const {
    agent_prompt,
    outputs = [],
    work_mode,
    allowed_read_values_keys = [],
    allowed_write_values_keys = [],
  } = agent

  const lines: string[] = [
    '始终使用**中文**进行思考和回复。',
    '信息不足时，**禁止**凭空推测，应当尝试读取文件、执行命令行或使用 Tool 获取有效信息，或使用 AskUserQuestion 询问用户。',
  ]

  // Flow 管控数据（可选，仅注入被授权读取的 key） 空值传入null
  if (allowed_read_values_keys.length > 0) {
    const visibleValues: Record<string, string | null> = {}
    for (const key of allowed_read_values_keys) {
      if (currentValues) {
        const value = currentValues[key]
        visibleValues[key] = value !== undefined && value !== '' ? value : null
      } else {
        visibleValues[key] = '<运行时替换>'
      }
    }
    if (Object.keys(visibleValues).length > 0) {
      lines.push(
        '# 可用数据',
        '用户会引用以下值',
        '```json',
        JSON.stringify(visibleValues, null, 2),
        '```',
      )
    }
  }

  // 可写数据：仅在「可完成」工作模式下出现（never_complete 不能调 AgentComplete）
  if (allowed_write_values_keys.length > 0 && work_mode !== 'never_complete') {
    lines.push(
      '# 可写数据',
      '当用户要求"记录"、"保存"或"写入"以下任一 key 的值时，**必须**通过 AgentComplete 工具的 `values` 参数输出，仅在 `content` 里描述不算写入。',
      ...allowed_write_values_keys.map((k) => `  - ${k}`),
      '## 写入说明：',
      '- 仅可写入上述列出的 key',
      '- 部分写入即可：未变化的 key 省略不传；省略不等于清空（要清空请显式传空字符串）',
      '- `content` 是本次任务的结果；`values` 用于按 key 记录用户要求保存的值',
    )
  }

  // 对话规则：长期对话规则 / 围绕任务描述完成任务（含完成任务、输出分支）
  if (agent_prompt) {
    match(work_mode)
      .with('never_complete', () => {
        lines.push('# 对话规则', agent_prompt)
      })
      .with(P.union('auto_complete', 'require_confirm'), (mode) => {
        lines.push(
          '# 对话规则',
          '下方「任务描述」是本次对话的**最终目标**，在整个对话过程中固定不变。',
          '你需要围绕该目标与用户进行多轮对话：根据用户输入主动推进、必要时使用 AskUserQuestion 向用户收集信息、读取文件或调用工具补全上下文，直到达成结束条件。',
          '## 任务描述',
          agent_prompt,
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
          '## 输出分支',
          match(outputs.length)
            .with(0, () => '此任务没有输出分支。')
            .otherwise(() =>
              outputs
                .map((o) => `  - "${o.output_name}"${o.output_desc ? `: ${o.output_desc}` : ''}`)
                .join('\n'),
            ),
        )
      })
      .exhaustive()
  }
  return lines.join('\n')
}

/**
 * 构建 Hosted Flow 托管模型的系统提示词
 *
 * 注入：
 * - Flow 共享数据 key 列表与语义
 * - 各 Agent 的 id / name / desc / no_input / 可读写 key 授权
 * - runAgent 工具说明（接受 id 与 values，返回 content + values；失败抛错）
 * - 用户填写的 host_prompt 作为最终任务描述
 */
export function buildHostSystemPrompt(
  flow: Pick<Flow, 'host_prompt' | 'shareValuesKeys' | 'agents'>,
): string {
  const { host_prompt, shareValuesKeys = [], agents = [] } = flow

  const lines: string[] = [
    '你是 Hosted Flow 的**托管编排器**：调度下述 Agent 协同完成用户交付的任务。',
    '始终使用**中文**进行思考和回复。',
    '信息不足时，**禁止**凭空推测，应当尝试读取文件、执行命令行或使用 Tool 获取有效信息，或使用 AskUserQuestion 询问用户。',
  ]

  // 共享数据
  if (shareValuesKeys.length > 0) {
    lines.push(
      '# 共享数据',
      '本 Flow 内可用的共享数据 key 集合（运行时由托管器与各 Agent 通过 `values` 读写共享）：',
      ...shareValuesKeys.map((k) => (k.desc ? `  - \`${k.key}\`: ${k.desc}` : `  - \`${k.key}\``)),
    )
  }

  // 可调度 Agents
  if (agents.length > 0) {
    const agentsJson = agents.map((a) => ({
      id: a.id,
      agent_name: a.agent_name,
      ...(a.agent_desc ? { agent_desc: a.agent_desc } : {}),
      no_input: !!a.no_input,
      allowed_read_values_keys: a.allowed_read_values_keys ?? [],
      allowed_write_values_keys: a.allowed_write_values_keys ?? [],
    }))
    lines.push(
      '# 可调度的 Agents',
      '通过 `runAgent` 工具调度以下 Agent。每个 Agent 都是独立的任务执行单元，拥有自己的上下文，仅能感知被授权的共享数据。',
      '## 字段含义',
      '- `id`: Agent 唯一标识，调用 `runAgent` 时必须严格匹配此值（不要把 `agent_name` 当 id 传）',
      '- `agent_name`: Agent 名称，仅供阅读',
      '- `agent_desc`: Agent 简介（可选），描述其职责与适用场景',
      '- `no_input`: 是否忽略用户输入；`true` 表示该 Agent 自动启动，调用 `runAgent` 时无需 / 不应再额外提供输入消息',
      '- `allowed_read_values_keys`: 该 Agent 可读的共享数据 key 子集；调用 `runAgent` 时通过 `values` 入参注入，未列出的 key 会被静默丢弃',
      '- `allowed_write_values_keys`: 该 Agent 可写的共享数据 key 子集；会出现在 `runAgent` 返回的 `values` 中，未列出的 key 不会被返回',
      '## 数据',
      '```json',
      JSON.stringify(agentsJson, null, 2),
      '```',
    )
  }

  // 工具
  lines.push(
    '# 工具：runAgent',
    '调度指定 Agent 执行任务并等待其完成。',
    '- 入参 `id`: 上方列出的 Agent id（必须严格匹配，不要传 agent_name）',
    '- 入参 `values?`: 提供给该 Agent 的共享数据值（可选）；仅 Agent 在「可读共享数据」中声明的 key 会被使用，其余被忽略',
    '- 返回 `content`: Agent 完成时提交的产物文本',
    '- 返回 `values`: Agent 写入的共享数据增量；仅包含其「可写共享数据」中声明的 key',
    '- **异常**: Agent 执行失败、用户中止、超时等情况下抛出，请妥善处理或如实告知用户',
    '调度策略：',
    '- 优先按用户意图选择最合适的 Agent；必要时串联多个 Agent 完成复杂任务',
    '- 在调用前先想清楚需要给 Agent 提供哪些 `values`',
    '- 调度结果中的 `values` 视情况合并到后续 Agent 调用的 `values` 入参里',
  )

  // 任务
  const trimmedTask = host_prompt?.trim()
  if (trimmedTask) {
    lines.push('# 任务', trimmedTask)
  }

  return lines.join('\n')
}
