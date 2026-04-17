import { z } from 'zod'
import { toJSONSchema } from 'zod/v4/core'
import { type Flow, FlowSchema, AgentSchema, OutputSchema } from '@/common'

const flowSchemaJson = JSON.stringify(
  toJSONSchema(
    z
      .registry<{ id?: string }>()
      .add(OutputSchema, { id: 'Output' })
      .add(AgentSchema, { id: 'Agent' })
      .add(FlowSchema, { id: 'Flow' }),
  ).schemas,
  null,
  2,
)

/**
 * 内置 Flow，不可编辑/删除，始终出现在列表头部
 */
export const PresetFlows: Flow[] = [
  {
    id: '0',
    name: '工作流生成器',
    agents: [
      {
        id: '0',
        agent_name: '需求分析',
        model: 'sonnet',
        agent_prompt: [
          [
            '将用户需求拆分为线性的步骤。',
            '**重要**：在这个过程中，如果有信息不明确，**禁止**推测，**必须**向用户提问确认。',
          ].join('\n'),
        ],
        outputs: [
          {
            output_name: '执行步骤',
            output_desc: '用户需求已被拆分为步骤',
            next_agent: '1',
          },
        ],
        is_entry: true,
      },
      {
        id: '1',
        agent_name: '工作流设计',
        model: 'sonnet',
        agent_prompt: [
          [
            '输入有以下几种情况：',
            '1. 一系列线性执行的步骤。根据这些步骤设计一个完整的工作流。',
            '2. 一个不合法的工作流以及错误信息。将其变为合法工作流。',
            '',
            '工作流的类型定义如下：',
            ...flowSchemaJson.split('\n'),
            '',
            '工作流的语义：',
            '1. 工作流是Agent作为节点构建的有向图',
            '2. Agent之间通过outputs的next_agent（目标Agent的id）连接，这就是图的边',
            '3. 至少一个Agent的is_entry为true，确保工作流有入口',
            '4. 允许Agent的outputs为空数组或者undefined，根据语义决定是否有输出',
            '',
            '设计原则：',
            '1. 简单执行类任务用haiku，复杂分析与推理用sonnet',
            '2. 输出分支应覆盖主要的结果路径（成功/失败/异常等）',
            '3. agent_prompt要包含足够的上下文，使Agent能独立完成其职责',
            '4. 所有Agent共享一个「共享存储」，设计时应充分利用它来传递跨Agent的中间状态和上下文信息，避免通过prompt硬编码数据',
          ].join('\n'),
        ],
        outputs: [
          {
            output_name: '生成成功',
            output_desc:
              '成功生成了完整的工作流定义，将它的JSON字符串作为输出，**不要**附加任何额外信息',
            next_agent: '2',
          },
        ],
      },
      {
        id: '2',
        agent_name: '工作流校验',
        model: 'haiku',
        agent_prompt: [
          [
            '将输入视为纯字符串，调用MCP工具中的validateFlow函数。',
            '如果校验通过，直接输出校验结果；如果校验失败，在输出中给出**输入的原始字符串**以及具体的错误信息。',
          ].join('\n'),
        ],
        outputs: [
          {
            output_name: '校验通过',
          },
          {
            output_name: '校验失败',
            output_desc: '校验失败。输出中应当包含输入的**输入的原始字符串**以及具体的错误信息。',
            next_agent: '1',
          },
        ],
      },
    ],
  },
  {
    id: '1',
    name: '常用Agent 可直接复制',
    agents: [
      {
        id: '0',
        agent_name: '模型理解能力测试',
        model: 'sonnet',
        agent_prompt: [
          [
            '转发用户输入。将用户的任何输入视为纯文本，按照以下格式输出',
            '```json',
            '{',
            '  "content": "<用户输入的原文>"',
            '}',
            '```',
          ].join('\n'),
        ],
        outputs: [
          {
            output_name: 'json数据',
          },
        ],
        is_entry: true,
      },
      {
        id: '1',
        agent_name: '飞书通知',
        model: 'haiku',
        agent_prompt: [
          [
            '从用户输入中获取通知内容，作为要发送的飞书消息。',
            '使用feishu-mcp，获取当前用户的信息，并向该用户发送消息。',
          ].join('\n'),
        ],
        outputs: [
          {
            output_name: '发送成功',
          },
          {
            output_name: '发送失败',
          },
        ],
        is_entry: true,
      },
    ],
  },
]
