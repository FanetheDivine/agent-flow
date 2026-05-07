import { useMemo } from 'react'
import type { FC } from 'react'
import { Divider } from 'antd'
import { LoadingOutlined } from '@ant-design/icons'
import { Bubble } from '@ant-design/x'
import type { BubbleItemType } from '@ant-design/x/es/bubble/interface'
import type { AgentSession } from '@/webview/store/flow'
import { toBubbleItems, type BubbleCtx } from './MessageBubble'

type Props = {
  sessions: AgentSession[]
  ctx?: BubbleCtx
  loading?: boolean
}

const roleMap = {
  user: {
    placement: 'end' as const,
    variant: 'filled' as const,
  },
  ai: {
    placement: 'start' as const,
    variant: 'filled' as const,
  },
  system: {
    placement: 'start' as const,
    variant: 'borderless' as const,
  },
}

export const MessageList: FC<Props> = ({ sessions, ctx, loading }) => {
  const items = useMemo<BubbleItemType[]>(() => {
    const result: BubbleItemType[] = []
    const seenToolUseIds = new Set<string>()
    sessions.forEach((session, idx) => {
      if (idx > 0) {
        result.push({
          key: `divider-${session.sessionId}`,
          role: 'divider',
          content: (
            <Divider className='my-1 text-[10px]! text-[#6c7086]!'>第 {idx + 1} 次执行</Divider>
          ),
        })
      }
      toBubbleItems(session.messages, ctx, seenToolUseIds).forEach((item) => {
        result.push({
          key: `${session.sessionId}-${item.key}`,
          role: item.role,
          content: item.content,
        })
      })
    })
    return result
  }, [sessions, ctx])

  const hasAgentComplete = sessions.some((s) => {
    const last = s.messages[s.messages.length - 1]
    return last?.type === 'flow.signal.agentComplete'
  })

  const finalItems = useMemo<BubbleItemType[]>(() => {
    if (!loading || hasAgentComplete) return items
    return [
      ...items,
      {
        key: '__loading__',
        role: 'ai',
        content: null,
        loading: true,
      },
    ]
  }, [items, loading, hasAgentComplete])

  return (
    <Bubble.List
      autoScroll
      role={roleMap}
      items={finalItems}
      className='chat-bubble-compact min-h-0 flex-1 overflow-y-auto px-3 py-2'
    />
  )
}
