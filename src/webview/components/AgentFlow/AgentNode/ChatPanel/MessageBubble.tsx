import { memo } from 'react'
import type { FC } from 'react'
import { Collapse, Tag } from 'antd'
import { CheckCircleOutlined, ToolOutlined } from '@ant-design/icons'
import type { ExtensionToWebviewMessage } from '@/common'

type Props = {
  msg: ExtensionToWebviewMessage
}

const MessageBubbleInner: FC<Props> = ({ msg }) => {
  if (msg.type === 'flow.signal.userMessage') {
    const content =
      typeof msg.data.message.message.content === 'string'
        ? msg.data.message.message.content
        : JSON.stringify(msg.data.message.message.content)
    return (
      <div className='flex justify-end'>
        <div className='max-w-[80%] rounded-lg bg-[#6366f1] px-3 py-2 text-xs text-white'>
          <pre className='m-0 whitespace-pre-wrap font-sans'>{content}</pre>
        </div>
      </div>
    )
  }

  if (msg.type === 'flow.signal.aiMessage') {
    const { message } = msg.data
    if (message.type === 'assistant') {
      const blocks = message.message.content
      if (!Array.isArray(blocks)) return null
      return (
        <div className='flex flex-col gap-1'>
          {blocks.map((block, i) => {
            if (block.type === 'text') {
              return (
                <div key={i} className='max-w-[90%] rounded-lg bg-[#313244] px-3 py-2 text-xs text-[#cdd6f4]'>
                  <pre className='m-0 whitespace-pre-wrap font-sans'>{block.text}</pre>
                </div>
              )
            }
            if (block.type === 'thinking') {
              return (
                <Collapse
                  key={i}
                  size='small'
                  ghost
                  items={[{
                    key: 'thinking',
                    label: <span className='text-[10px] text-[#6c7086]'>思考中...</span>,
                    children: (
                      <pre className='m-0 max-h-40 overflow-auto whitespace-pre-wrap text-[10px] text-[#6c7086]'>
                        {block.thinking}
                      </pre>
                    ),
                  }]}
                />
              )
            }
            if (block.type === 'tool_use' || block.type === 'mcp_tool_use') {
              const toolName = 'server_name' in block ? `${block.server_name}::${block.name}` : block.name
              return (
                <div key={i} className='rounded bg-[#1e1e2e] border border-[#45475a] px-2 py-1 text-[10px]'>
                  <ToolOutlined className='mr-1 text-[#f9e2af]' />
                  <span className='text-[#a6adc8]'>{toolName}</span>
                </div>
              )
            }
            if (block.type === 'mcp_tool_result') {
              return null // tool results are verbose, skip in chat view
            }
            return null
          })}
        </div>
      )
    }
    if (message.type === 'result') {
      const isError = 'error' in message && message.error
      return (
        <div className='flex items-center gap-1 text-[10px] text-[#6c7086]'>
          <CheckCircleOutlined className={isError ? 'text-[#f38ba8]' : 'text-[#a6e3a1]'} />
          <span>{isError ? '执行出错' : '回合结束'}</span>
        </div>
      )
    }
    // stream_event / system / other — skip
    return null
  }

  if (msg.type === 'flow.signal.agentComplete') {
    return (
      <div className='flex items-center gap-2 py-1'>
        <div className='h-px flex-1 bg-[#45475a]' />
        <Tag color='green' className='m-0 text-[10px]'>
          完成{msg.data.output ? ` → ${msg.data.output.name}` : ''}
        </Tag>
        <div className='h-px flex-1 bg-[#45475a]' />
      </div>
    )
  }

  return null
}

export const MessageBubble = memo(MessageBubbleInner)
