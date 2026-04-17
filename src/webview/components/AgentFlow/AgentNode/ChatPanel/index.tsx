import type { FC } from 'react'
import { Button, Tag } from 'antd'
import { PauseCircleOutlined } from '@ant-design/icons'
import { useFlowStore, type AgentSession } from '@/webview/store/flow'
import { ChatInput } from './ChatInput'
import { MessageList } from './MessageList'

type Props = {
  flowId: string
  agentId: string
  agentName: string
}

export const ChatPanel: FC<Props> = ({ flowId, agentId, agentName }) => {
  const flowState = useFlowStore((s) => s.flowStates[flowId])
  const interruptAgent = useFlowStore((s) => s.interruptAgent)

  const sessions: AgentSession[] = flowState?.sessions.filter((s) => s.agentId === agentId) ?? []

  const isCurrentAgent = flowState?.currentAgentId === agentId
  const status = flowState?.status
  const canInput = isCurrentAgent && status === 'waiting-user'
  const canInterrupt = isCurrentAgent && status === 'chatting'

  const statusText =
    status === 'chatting'
      ? '生成中'
      : status === 'waiting-user'
        ? '等待输入'
        : status === 'preparing'
          ? '准备中'
          : status === 'completed'
            ? '已完成'
            : status === 'error'
              ? '出错'
              : '就绪'

  const statusColor =
    status === 'chatting'
      ? 'processing'
      : status === 'waiting-user'
        ? 'warning'
        : status === 'completed'
          ? 'success'
          : status === 'error'
            ? 'error'
            : 'default'

  return (
    <div className='flex h-[450px] w-[380px] flex-col overflow-hidden rounded-lg bg-[#1e1e2e]'>
      {/* Header */}
      <div className='flex items-center justify-between border-b border-[#45475a] px-3 py-2'>
        <div className='flex items-center gap-2'>
          <span className='text-xs font-semibold text-[#cdd6f4]'>{agentName}</span>
          <Tag color={statusColor} className='m-0 text-[10px]'>
            {statusText}
          </Tag>
        </div>
        {canInterrupt && (
          <Button
            type='text'
            size='small'
            danger
            icon={<PauseCircleOutlined />}
            onClick={() => interruptAgent(flowId)}
          >
            中断
          </Button>
        )}
      </div>

      {/* Messages */}
      {sessions.length === 0 ? (
        <div className='flex flex-1 items-center justify-center text-xs text-[#6c7086]'>
          暂无消息
        </div>
      ) : (
        <MessageList sessions={sessions} />
      )}

      {/* Input */}
      <ChatInput flowId={flowId} disabled={!canInput} />
    </div>
  )
}
