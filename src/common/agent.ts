import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { Agent } from './index'

// ── Prompt ─────────────────────────────────────────────────────────────────

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

/** 将 Agent 的 prompt 片段拼接为完整提示词 */
export function buildAgentPrompt(agent: Agent): string {
  return FlowPrompt.concat(agent.agent_prompt).join('\n')
}

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
  const outputDescs = outputs.map((o) => `  - "${o.output_name}": ${o.output_desc}`).join('\n')

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
