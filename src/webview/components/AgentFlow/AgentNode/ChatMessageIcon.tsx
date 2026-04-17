import { useState, useEffect, useCallback } from 'react'
import type { FC } from 'react'
import { Popover, Badge } from 'antd'
import { MessageOutlined } from '@ant-design/icons'
import { useFlowStore } from '@/webview/store/flow'
import { ChatPanel } from './ChatPanel'

type Props = {
  flowId: string
  agentId: string
  agentName: string
}

export const ChatMessageIcon: FC<Props> = ({ flowId, agentId, agentName }) => {
  const activeFlowId = useFlowStore((s) => s.activeFlowId)
  const flowState = useFlowStore((s) => s.flowStates[flowId])

  const [open, setOpen] = useState(false)

  const isCurrentAgent = flowState?.currentAgentId === agentId
  const hasSessions = (flowState?.sessions.filter((s) => s.agentId === agentId).length ?? 0) > 0

  // 有新消息到达当前 agent 时自动弹出
  const messageCount = flowState?.sessions
    .filter((s) => s.agentId === agentId)
    .reduce((n, s) => n + s.messages.length, 0) ?? 0

  useEffect(() => {
    if (isCurrentAgent && messageCount > 0) {
      setOpen(true)
    }
  }, [isCurrentAgent, messageCount])

  // agent 不再活跃且无 session 时关闭
  useEffect(() => {
    if (!isCurrentAgent && !hasSessions) {
      setOpen(false)
    }
  }, [isCurrentAgent, hasSessions])

  const handleOpenChange = useCallback((newOpen: boolean) => {
    setOpen(newOpen)
  }, [])

  // 非当前 activeFlow 时隐藏
  if (activeFlowId !== flowId) return null

  return (
    <Popover
      open={open}
      onOpenChange={handleOpenChange}
      content={<ChatPanel flowId={flowId} agentId={agentId} agentName={agentName} />}
      trigger='click'
      placement='rightTop'
      arrow={false}
      overlayInnerStyle={{ padding: 0, overflow: 'hidden' }}
    >
      <span
        className='cursor-pointer text-xs text-[#a6adc8] transition-colors hover:text-[#6366f1]'
        onClick={(e) => e.stopPropagation()}
      >
        <Badge dot={isCurrentAgent} offset={[-2, 2]}>
          <MessageOutlined className='text-xs text-[#a6adc8]' />
        </Badge>
      </span>
    </Popover>
  )
}
