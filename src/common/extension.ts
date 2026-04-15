import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { type Agent } from '.'

// 仅extension可用

// ── MCP Server ─────────────────────────────────────────────────────────────

export type AgentMcpServerOptions = {
  agent: Agent
  shareValues: Record<string, string>
  onComplete: (output: { content: string; output_name?: string }) => void
}

/**
 * 构建 Agent 控制用 MCP Server
 *
 * 内置工具：
 * - `AgentComplete` — 完成任务并选择输出分支
 * - `setShareValues` — 批量写入 Flow 共享上下文
 * - `getShareValues` — 按键读取共享上下文
 * - `getAllShareValues` — 读取全部共享上下文
 */
export function buildAgentMcpServer({ agent, shareValues, onComplete }: AgentMcpServerOptions) {
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
        async ({ output_name, content }) => {
          onComplete({ output_name, content })
          return {
            content: [{ type: 'text', text: `任务完成，输出分支：${output_name}` }],
          }
        },
      )
    : tool(
        'AgentComplete',
        '当前任务已完成时调用此工具。提交任务结果。无输出分支。',
        {
          content: z.string().describe('任务结果'),
        },
        async ({ content }) => {
          onComplete({ content })
          return {
            content: [{ type: 'text', text: '任务完成，无后续输出。' }],
          }
        },
      )

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
      return {
        content: [{ type: 'text', text: '写入成功' }],
      }
    },
  )

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
        content: [{ type: 'text', text: JSON.stringify(result) }],
      }
    },
  )

  const getAllShareValuesTool = tool(
    'getAllShareValues',
    '读取 Flow 全局共享上下文的全部键值对',
    {},
    async () => {
      return {
        content: [{ type: 'text', text: JSON.stringify(shareValues) }],
      }
    },
  )

  return createSdkMcpServer({
    name: 'AgentControllerMcp',
    version: '1.0.0',
    tools: [agentCompleteTool, setShareValuesTool, getShareValuesTool, getAllShareValuesTool],
  })
}
