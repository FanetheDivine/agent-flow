import { type FC } from 'react'
import { Drawer } from 'antd'
import type { UserMessageType } from '@/common'
import {
  useFlowStore,
  selectAgentPhase,
  selectFlowPhase,
  type AgentPhase,
  type FlowPhase,
} from '@/webview/store/flow'
import { useStartFlow } from '@/webview/hooks/useStartFlow'
import { ChatPanel } from './AgentFlow/AgentNode/ChatPanel'

export const ChatDrawer: FC = () => {
  const chatDrawer = useFlowStore((s) => s.chatDrawer)
  const closeChatDrawer = useFlowStore((s) => s.closeChatDrawer)
  const sendUserMessage = useFlowStore((s) => s.sendUserMessage)
  const startFlow = useStartFlow()
  const agentPhase = useFlowStore((s): AgentPhase => {
    if (!s.chatDrawer) return 'idle'
    return selectAgentPhase(s.chatDrawer.flowId, s.chatDrawer.agentId)(s)
  })
  const flowPhase = useFlowStore((s): FlowPhase => {
    if (!s.chatDrawer) return 'idle'
    return selectFlowPhase(s.chatDrawer.flowId)(s)
  })
  const isActiveAgent = useFlowStore((s) => {
    if (!s.chatDrawer) return false
    const fs = s.flowRunStates[s.chatDrawer.flowId]
    return fs?.sessions[fs.sessions.length - 1]?.agentId === s.chatDrawer.agentId
  })

  const onSend = (content: UserMessageType['message']['content']): boolean | Promise<boolean> => {
    if (!chatDrawer) return false

    const { flowId, agentId } = chatDrawer

    if (agentPhase === 'running' || agentPhase === 'starting') return false

    if (flowPhase === 'idle') {
      return startFlow(flowId, agentId, {
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
      })
    }

    if (
      isActiveAgent &&
      (agentPhase === 'awaiting-message' || agentPhase === 'awaiting-question')
    ) {
      sendUserMessage(flowId, content)
      return true
    }

    // completed / stopped / error / 非活跃agent → 确认清空后重新运行
    return startFlow(flowId, agentId, {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    })
  }

  return (
    <Drawer
      open={!!chatDrawer}
      placement='right'
      mask={false}
      closable={false}
      defaultSize={700}
      resizable
      styles={{
        body: { padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
      }}
      onClose={() => {
        closeChatDrawer()
      }}
    >
      <div className='flex flex-1 flex-col overflow-hidden'>
        {chatDrawer && (
          <ChatPanel
            flowId={chatDrawer.flowId}
            agentId={chatDrawer.agentId}
            agentName={chatDrawer.agentName}
            onSend={onSend}
            onClose={closeChatDrawer}
          />
        )}
      </div>
    </Drawer>
  )
}
