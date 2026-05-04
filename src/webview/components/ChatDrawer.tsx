import { type FC } from 'react'
import { App, Drawer } from 'antd'
import type { UserMessageType } from '@/common'
import {
  useFlowStore,
  selectAgentPhase,
  selectFlowPhase,
  type AgentPhase,
  type FlowPhase,
} from '@/webview/store/flow'
import type { CodeRef } from '@/webview/utils/activeInputRegistry'
import { buildUserMessageContent } from '@/webview/utils/buildUserMessageContent'
import { ChatPanel } from './AgentFlow/AgentNode/ChatPanel'

export const ChatDrawer: FC = () => {
  const chatDrawer = useFlowStore((s) => s.chatDrawer)
  const closeChatDrawer = useFlowStore((s) => s.closeChatDrawer)
  const sendUserMessage = useFlowStore((s) => s.sendUserMessage)
  const runFlow = useFlowStore((s) => s.runFlow)
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
    const fs = s.flowStates[s.chatDrawer.flowId]
    return fs?.currentAgentId === s.chatDrawer.agentId
  })

  const { modal } = App.useApp()

  const onSend = async (text: string, files: File[], references: CodeRef[]) => {
    if (!chatDrawer) return
    if (!text.trim() && files.length === 0 && references.length === 0) return

    const { flowId, agentId } = chatDrawer

    if (agentPhase === 'running' || agentPhase === 'starting') return

    const content = await buildUserMessageContent(text, files, references)

    if (flowPhase === 'idle') {
      runFlow(flowId, agentId, {
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
      })
      return
    }

    if (
      isActiveAgent &&
      (agentPhase === 'awaiting-message' || agentPhase === 'awaiting-question')
    ) {
      sendUserMessage(flowId, content)
      return
    }

    // completed / stopped / error / 非活跃agent → 确认清空后重新运行
    const initMessage: UserMessageType = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    }
    modal.confirm({
      title: '确认运行',
      content: '当前工作流数据会被清空，如果想保留数据，可以复制工作流再运行',
      onOk: () => runFlow(flowId, agentId, initMessage),
    })
  }

  return (
    <Drawer
      open={!!chatDrawer}
      placement='right'
      mask={false}
      closable={false}
      styles={{
        body: { padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
      }}
    >
      <div
        onKeyDown={(e) => {
          if (e.key === 'Escape') return
          e.stopPropagation()
        }}
        onPaste={(e) => e.stopPropagation()}
        className='flex flex-1 flex-col overflow-hidden'
      >
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
