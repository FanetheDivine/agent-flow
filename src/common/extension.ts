import { createSdkMcpServer, SdkMcpToolDefinition, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { toJSONSchema } from 'zod/v4/core'
import { type Agent, AgentSchema, FlowSchema, OutputSchema, validateFlow } from '.'

// 仅extension可用

// ── MCP Server ─────────────────────────────────────────────────────────────

export type AgentMcpServerOptions = {
  agent: Agent
  onComplete: (output: {
    content: string
    outputName?: string
    shareValues?: Record<string, string>
  }) => void
}

type ToolContent = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

/**
 * 统一兜底：handler 内部任何抛错都转成 isError 工具结果，
 * 让 AI 收到明确的失败信号而不是把异常静默掉。
 */
function withErrorBoundary<TArgs>(
  toolName: string,
  handler: (args: TArgs) => Promise<ToolContent>,
): (args: TArgs) => Promise<ToolContent> {
  return async (args) => {
    try {
      return await handler(args)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        content: [{ type: 'text', text: `[${toolName}] 执行失败：${msg}` }],
        isError: true,
      }
    }
  }
}

/**
 * 构建 Agent 控制用 MCP Server
 *
 * 内置工具：
 * - `AgentComplete` — 完成任务并选择输出分支（可选写入 shareValues）
 * - `validateFlow` — 校验工作流定义是否合法
 * - `getFlowJSONSchema` — 获取 Flow 的 JSON Schema 定义
 */
export function buildAgentMcpServer({ agent, onComplete }: AgentMcpServerOptions) {
  const tools: SdkMcpToolDefinition<any>[] = []
  if (agent.work_mode !== 'never_complete') {
    const outputs = agent.outputs ?? []
    const outputNames = outputs.map((o) => o.output_name)
    const outputDescs = outputs
      .map((o) => {
        const { output_name, output_desc } = o
        let res = `  - "${output_name}"`
        if (output_desc) {
          res += `: ${output_desc}`
        }
        return res
      })
      .join('\n')

    const hasOutputs = outputNames.length > 0
    const writeKeys = agent.allowed_write_share_values_keys ?? []
    const shareValuesSchema =
      writeKeys.length > 0
        ? z.object(
            Object.fromEntries(
              writeKeys.map((k) => [k, z.string().optional().describe(`key: ${k}`)]),
            ),
          )
        : undefined

    // 共享部分：调用语义 + shareValues 提示。两边（systemPrompt 与本工具描述）措辞一致，
    // 让 AI 在 systemPrompt 里读过一遍后，工具描述这里再次强化要点。
    const callSemantics = [
      '## 调用约束',
      '- 调用此工具会**立即终止本 Agent**，不可撤销；只在「任务描述」的结束条件已经达成、且与用户对齐之后调用',
      ...(agent.work_mode === 'require_confirm'
        ? [
            '- **必须**先用 AskUserQuestion 让用户确认结果与输出分支；用户未确认前**禁止**调用本工具',
          ]
        : []),
    ].join('\n')

    const shareValuesNotes =
      writeKeys.length > 0
        ? [
            '## shareValues',
            '当用户要求"记录"、"保存"或"写入"以下任一 key 的值时，**必须**通过 `shareValues` 参数输出，仅在 `content` 里描述不算写入：',
            ...writeKeys.map((k) => `  - "${k}"`),
            '- 仅可写入上述列出的 key',
            '- 部分写入即可：未变化的 key 省略不传；省略不等于清空（要清空请显式传空字符串）',
            '- `content` 是本次任务的结果文本；`shareValues` 用于按 key 记录用户要求保存的值',
          ].join('\n')
        : ''

    const baseDesc = hasOutputs
      ? `当前任务已完成时调用此工具：选择输出分支并提交任务结果。\n## 可选分支\n${outputDescs}`
      : '当前任务已完成时调用此工具，提交任务结果。无输出分支。'

    const completeDesc = [baseDesc, callSemantics, shareValuesNotes].filter(Boolean).join('\n\n')

    const agentCompleteTool = hasOutputs
      ? tool(
          'AgentComplete',
          completeDesc,
          {
            output_name: z.enum(outputNames as [string, ...string[]]).describe('选择的输出分支名'),
            content: z
              .string()
              .describe(
                '本次任务的结果文本。仅文字输出，不要把需要按 key 记录的值塞这里——那是 shareValues 的职责',
              ),
            ...(shareValuesSchema
              ? {
                  shareValues: shareValuesSchema
                    .optional()
                    .describe(
                      '按 key 记录用户要求保存的值；只能写入 allowed_write_share_values_keys 列出的 key。未变化的 key 省略不传',
                    ),
                }
              : {}),
          },
          withErrorBoundary('AgentComplete', async ({ output_name, content, shareValues }) => {
            const filteredSv: Record<string, string> = {}
            if (shareValues && writeKeys.length > 0) {
              for (const key of writeKeys) {
                if (key in shareValues) {
                  filteredSv[key] = shareValues[key]
                }
              }
            }
            onComplete({
              outputName: output_name,
              content,
              ...(Object.keys(filteredSv).length > 0 ? { shareValues: filteredSv } : {}),
            })
            return {
              content: [
                {
                  type: 'text',
                  text:
                    `任务完成，输出分支：${output_name}` +
                    (Object.keys(filteredSv).length > 0
                      ? `，写入 shareValues：${JSON.stringify(filteredSv)}`
                      : ''),
                },
              ],
            }
          }),
        )
      : tool(
          'AgentComplete',
          completeDesc,
          {
            content: z
              .string()
              .describe(
                '本次任务的结果文本。仅文字输出，不要把需要按 key 记录的值塞这里——那是 shareValues 的职责',
              ),
            ...(shareValuesSchema
              ? {
                  shareValues: shareValuesSchema
                    .optional()
                    .describe(
                      '按 key 记录用户要求保存的值；只能写入 allowed_write_share_values_keys 列出的 key。未变化的 key 省略不传',
                    ),
                }
              : {}),
          },
          withErrorBoundary('AgentComplete', async ({ content, shareValues }) => {
            const filteredSv: Record<string, string> = {}
            if (shareValues && writeKeys.length > 0) {
              for (const key of writeKeys) {
                if (key in shareValues) {
                  filteredSv[key] = shareValues[key]
                }
              }
            }
            onComplete({
              content,
              ...(Object.keys(filteredSv).length > 0 ? { shareValues: filteredSv } : {}),
            })
            return {
              content: [
                {
                  type: 'text',
                  text:
                    '任务完成，无后续输出。' +
                    (Object.keys(filteredSv).length > 0
                      ? `，写入 shareValues：${JSON.stringify(filteredSv)}`
                      : ''),
                },
              ],
            }
          }),
        )
    tools.push(agentCompleteTool)
  }
  const validateFlowTool = tool(
    'validateFlow',
    '校验工作流定义是否合法。在生成或修改工作流后调用此工具，确保定义符合规则。',
    {
      flow: z.string().describe('工作流定义的 JSON 字符串，需符合 Flow 类型'),
    },
    withErrorBoundary('validateFlow', async ({ flow }) => {
      const parsed = FlowSchema.parse(JSON.parse(flow))
      const result = validateFlow(parsed)
      const hasErrors = Object.keys(result).length > 0
      return {
        isError: hasErrors,
        content: [
          {
            type: 'text',
            text: hasErrors
              ? `校验未通过：\n${JSON.stringify(result, null, 2)}`
              : '校验通过，工作流定义合法。',
          },
        ],
      }
    }),
  )

  const getFlowJSONSchemaTool = tool(
    'getFlowJSONSchema',
    '获取 Flow 数据结构的 JSON Schema 定义。在生成、修改或理解工作流结构时调用，以获取准确的字段定义与约束。',
    {},
    withErrorBoundary('getFlowJSONSchema', async () => {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              toJSONSchema(
                z
                  .registry<{ id?: string }>()
                  .add(OutputSchema, { id: 'Output' })
                  .add(AgentSchema, { id: 'Agent' })
                  .add(FlowSchema, { id: 'Flow' }),
              ).schemas,
              null,
              2,
            ),
          },
        ],
      }
    }),
  )
  tools.push(validateFlowTool, getFlowJSONSchemaTool)

  return createSdkMcpServer({
    name: 'AgentControllerMcp',
    version: '1.0.0',
    tools,
  })
}
