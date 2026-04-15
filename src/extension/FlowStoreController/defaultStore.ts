import type { FlowStore } from '@/common'

/**
 * 默认 Flow 数组
 */
export const defaultStore: FlowStore = {
  flows: [
    {
      id: '0',
      name: '常见的Agent 可直接复制',
      agents: [
        {
          agent_name: '模型理解能力测试',
          model: 'sonnet',
          agent_prompt: [
            '转发用户输入。将用户的任何输入视为纯文本，按照以下格式输出\n```json\n{\n  "content": "<用户输入的原文>"\n}\n```\n',
          ],
          outputs: [
            {
              output_name: 'json数据',
            },
          ],
          is_entry: true,
        },
        {
          agent_name: '飞书通知',
          model: 'haiku',
          agent_prompt: [
            '从用户输入中获取通知内容，作为要发送的飞书消息。使用feishu-mcp，获取当前用户的信息，并向该用户发送消息。',
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
  ],
}
