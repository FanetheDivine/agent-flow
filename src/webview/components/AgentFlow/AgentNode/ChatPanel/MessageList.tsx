import { useEffect, useRef } from 'react'
import type { FC } from 'react'
import { Divider } from 'antd'
import type { AgentSession } from '@/webview/store/flow'
import { MessageBubble } from './MessageBubble'

type Props = {
  sessions: AgentSession[]
}

export const MessageList: FC<Props> = ({ sessions }) => {
  const bottomRef = useRef<HTMLDivElement>(null)

  const totalMessages = sessions.reduce((n, s) => n + s.messages.length, 0)
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [totalMessages])

  return (
    <div className='flex-1 overflow-y-auto px-3 py-2'>
      {sessions.map((session, idx) => (
        <div key={session.sessionId}>
          {idx > 0 && (
            <Divider className='my-2 text-[10px]! text-[#6c7086]!'>第 {idx + 1} 次执行</Divider>
          )}
          <div className='flex flex-col gap-2'>
            {session.messages.map((msg, i) => (
              <MessageBubble key={i} msg={msg} />
            ))}
          </div>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  )
}
