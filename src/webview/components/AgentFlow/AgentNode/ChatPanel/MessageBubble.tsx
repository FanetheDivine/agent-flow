import { memo, type FC, type ReactNode } from 'react'
import { Tag } from 'antd'
import { Bubble, Think } from '@ant-design/x'
import { CheckCircleOutlined, ToolOutlined } from '@ant-design/icons'
import { XMarkdown } from '@ant-design/x-markdown'
import type {
  AskUserQuestionInput,
  AskUserQuestionOutput,
  ExtensionToWebviewMessage,
} from '@/common'
import { AskUserQuestionCard } from './AskUserQuestionCard'

type Props = {
  msg: ExtensionToWebviewMessage
}

export type AnsweredInfo = {
  values: Record<string, string[]>
  byFreeText: boolean
}

export type BubbleCtx = {
  pendingToolUseId?: string
  answeredMap: Map<string, AnsweredInfo>
  onActiveSubmit?: (toolUseId: string, output: AskUserQuestionOutput) => void
  onActiveDismiss?: (toolUseId: string) => void
}

type RenderedBubble = {
  key: string
  role: 'user' | 'ai' | 'system' | 'divider'
  content: ReactNode
}

const Md: FC<{ content: string }> = ({ content }) => (
  <XMarkdown
    className='x-markdown-dark'
    content={content}
    openLinksInNewTab
    escapeRawHtml
  />
)

export function toBubbleItems(
  msgs: ExtensionToWebviewMessage[],
  ctx?: BubbleCtx,
  seenToolUseIds = new Set<string>(),
): RenderedBubble[] {
  const items: RenderedBubble[] = []
  msgs.forEach((msg, mIdx) => {
    if (msg.type === 'flow.signal.aiMessage') {
      const { message } = msg.data
      if (message.type === 'user') {
        if (message.isSynthetic) return
        const rawContent = message.message.content
        // 纯 tool_result 的 user message 属于工具循环内部产物（例如
        // AskUserQuestion 回答后 SDK 发出的 tool_result），UI 不需要单独渲染，
        // 结构化答案已由 AskUserQuestionCard 的历史态展示。
        if (
          Array.isArray(rawContent) &&
          rawContent.every((b) => b && typeof b === 'object' && b.type === 'tool_result')
        ) {
          return
        }
        const content =
          typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent)
        items.push({
          key: `${mIdx}-user`,
          role: 'user',
          content: <Md content={content} />,
        })
        return
      }
      if (message.type === 'assistant') {
        const blocks = message.message.content
        if (!Array.isArray(blocks)) return
        blocks.forEach((block, bIdx) => {
          const key = `${mIdx}-${bIdx}`
          if (block.type === 'text') {
            items.push({
              key,
              role: 'ai',
              content: <Md content={block.text} />,
            })
            return
          }
          if (block.type === 'thinking') {
            items.push({
              key,
              role: 'ai',
              content: (
                <Think title='思考中' defaultExpanded={false}>
                  <Md content={block.thinking} />
                </Think>
              ),
            })
            return
          }
          if (block.type === 'tool_use' || block.type === 'mcp_tool_use') {
            if (seenToolUseIds.has(block.id)) return
            seenToolUseIds.add(block.id)
            if (block.type === 'tool_use' && block.name === 'AskUserQuestion' && ctx) {
              const input = block.input as AskUserQuestionInput | undefined
              if (!input || !Array.isArray(input.questions)) return
              const isPending = ctx.pendingToolUseId === block.id
              const answered = ctx.answeredMap.get(block.id)
              items.push({
                key,
                role: 'system',
                content: isPending ? (
                  <AskUserQuestionCard
                    input={input}
                    mode='active'
                    onSubmit={(output) => ctx.onActiveSubmit?.(block.id, output)}
                    onDismiss={() => ctx.onActiveDismiss?.(block.id)}
                  />
                ) : (
                  <AskUserQuestionCard
                    input={input}
                    mode='historical'
                    answeredValues={answered?.values}
                    answeredByFreeText={answered?.byFreeText}
                  />
                ),
              })
              return
            }
            const toolName =
              'server_name' in block ? `${block.server_name}::${block.name}` : block.name
            items.push({
              key,
              role: 'system',
              content: (
                <span className='text-[10px] text-[#a6adc8]'>
                  <ToolOutlined className='mr-1 text-[#f9e2af]' />
                  {toolName}
                </span>
              ),
            })
            return
          }
          // mcp_tool_result & others — skip (verbose)
        })
        return
      }
      if (message.type === 'result') {
        const isError = 'error' in message && message.error
        items.push({
          key: `${mIdx}-result`,
          role: 'divider',
          content: (
            <span className='text-[10px] text-[#6c7086]'>
              <CheckCircleOutlined className={isError ? 'text-[#f38ba8]' : 'text-[#a6e3a1]'} />
              <span className='ml-1'>{isError ? '执行出错' : '回合结束'}</span>
            </span>
          ),
        })
        return
      }
      // stream_event / system / other — skip
      return
    }

    if (msg.type === 'flow.signal.agentComplete') {
      items.push({
        key: `${mIdx}-complete`,
        role: 'divider',
        content: (
          <Tag color='green' className='m-0 text-[10px]'>
            完成{msg.data.output ? ` → ${msg.data.output.name}` : ''}
          </Tag>
        ),
      })
    }
  })
  return items
}

/**
 * 保留单气泡渲染入口（可用于调试或非列表场景）。
 * 列表场景请直接使用 Bubble.List + toBubbleItems。
 */
const MessageBubbleInner: FC<Props> = ({ msg }) => {
  const items = toBubbleItems([msg])
  if (items.length === 0) return null
  return (
    <div className='flex flex-col gap-1'>
      {items.map((item) => (
        <Bubble
          key={item.key}
          placement={item.role === 'user' ? 'end' : 'start'}
          content={item.content}
          variant={item.role === 'divider' ? 'borderless' : 'filled'}
        />
      ))}
    </div>
  )
}

export const MessageBubble = memo(MessageBubbleInner)
