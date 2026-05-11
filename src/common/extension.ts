import { createSdkMcpServer, SdkMcpToolDefinition, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { toJSONSchema } from 'zod/v4/core'
import { type Agent, AgentSchema, FlowSchema, OutputSchema, validateFlow } from '.'

// 仅extension可用

// ── MCP Server ─────────────────────────────────────────────────────────────

export type AgentMcpServerOptions = {
  agent: Agent
  shareValues: Record<string, string>
  onComplete: (output: { content: string; outputName?: string }) => void
  onShareValuesChanged?: (shareValues: Record<string, string>) => void
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
 * - `AgentComplete` — 完成任务并选择输出分支
 * - `setShareValues` — 批量写入 Flow 共享上下文
 * - `getShareValues` — 按键读取共享上下文
 * - `getAllShareValues` — 读取全部共享上下文
 * - `validateFlow` — 校验工作流定义是否合法
 * - `getFlowJSONSchema` — 获取 Flow 的 JSON Schema 定义
 */
export function buildAgentMcpServer({ agent, shareValues, onComplete, onShareValuesChanged }: AgentMcpServerOptions) {
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

    const agentCompleteTool = hasOutputs
      ? tool(
          'AgentComplete',
          `当前任务已完成时调用此工具。选择输出分支并提交任务结果。\n可选分支：\n${outputDescs}`,
          {
            output_name: z.enum(outputNames as [string, ...string[]]).describe('选择的输出分支名'),
            content: z.string().describe('输出任务结果，将传递给下一个 Agent 或作为最终结果'),
          },
          withErrorBoundary('AgentComplete', async ({ output_name, content }) => {
            onComplete({ outputName: output_name, content })
            return {
              content: [{ type: 'text', text: `任务完成，输出分支：${output_name}` }],
            }
          }),
        )
      : tool(
          'AgentComplete',
          '当前任务已完成时调用此工具。提交任务结果。无输出分支。',
          {
            content: z.string().describe('任务结果'),
          },
          withErrorBoundary('AgentComplete', async ({ content }) => {
            onComplete({ content })
            return {
              content: [{ type: 'text', text: '任务完成，无后续输出。' }],
            }
          }),
        )
    tools.push(agentCompleteTool)
  }
  if (agent.enable_share_values) {
    const setShareValuesTool = tool(
      'setShareValues',
      '批量写入键值对到 Flow 全局共享上下文（shareValues），供后续 Agent 读取',
      {
        values: z
          .record(z.string(), z.string())
          .describe('要写入的键值对，例如：{ "result": "foo", "status": "done" }'),
      },
      withErrorBoundary('setShareValues', async ({ values }) => {
        Object.assign(shareValues, values)
        onShareValuesChanged?.(shareValues)
        return {
          content: [{ type: 'text', text: '写入成功' }],
        }
      }),
    )

    const getShareValuesTool = tool(
      'getShareValues',
      '按键列表读取 Flow 全局共享上下文中的值，缺失的键返回 null',
      {
        keys: z.array(z.string()).describe('要读取的键名数组，例如：["result", "status"]'),
      },
      withErrorBoundary('getShareValues', async ({ keys }) => {
        const result: Record<string, string | null> = {}
        for (const key of keys) {
          result[key] = shareValues[key] ?? null
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        }
      }),
    )

    const getAllShareValuesTool = tool(
      'getAllShareValues',
      '读取 Flow 全局共享上下文的全部键值对',
      {},
      withErrorBoundary('getAllShareValues', async () => {
        return {
          content: [{ type: 'text', text: JSON.stringify(shareValues) }],
        }
      }),
    )
    tools.push(setShareValuesTool, getShareValuesTool, getAllShareValuesTool)
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
