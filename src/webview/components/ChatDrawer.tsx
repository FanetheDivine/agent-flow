import { useCallback, type FC } from 'react'
import { App, Drawer } from 'antd'
import type { UserMessageType } from '@/common'
import { useFlowStore, selectAgentPhase, type AgentPhase } from '@/webview/store/flow'
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

  const { modal } = App.useApp()

  const onSend = useCallback(
    async (text: string, files: File[], references: CodeRef[]) => {
      if (!chatDrawer) return
      const { flowId, agentId } = chatDrawer
      const content = await buildUserMessageContent(text, files, references)

      if (agentPhase === 'awaiting-message' || agentPhase === 'awaiting-question') {
        sendUserMessage(flowId, content)
        return
      }

      const initMessage: UserMessageType = {
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
      }

      if (agentPhase === 'idle') {
        runFlow(flowId, agentId, initMessage)
        return
      }

      modal.confirm({
        title: '确认运行',
        content: '当前工作流数据会被清空，如果想保留数据，可以复制工作流再运行',
        onOk: () => runFlow(flowId, agentId, initMessage),
      })
    },
    [chatDrawer, agentPhase, sendUserMessage, runFlow, modal],
  )

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
