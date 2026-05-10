import { RefObject, useCallback, useRef, type FC } from 'react'
import { Drawer } from 'antd'
import type { UserMessageType } from '@/common'
import { useStartFlow } from '@/webview/hooks/useStartFlow'
import {
  agentChatInputState,
  selectAgentPhase,
  useFlowStore,
  type AgentPhase,
} from '@/webview/store/flow'
import { ChatInput } from './ChatInput'
import { ChatPanel } from './ChatPanel'

export const ChatDrawer: FC = () => {
  const chatDrawer = useFlowStore((s) => s.chatDrawer)
  const closeChatDrawer = useFlowStore((s) => s.closeChatDrawer)
  const sendUserMessage = useFlowStore((s) => s.sendUserMessage)
  const interruptAgent = useFlowStore((s) => s.interruptAgent)
  const startFlow = useStartFlow()

  const agentPhase = useFlowStore((s): AgentPhase => {
    if (!s.chatDrawer) return 'idle'
    return selectAgentPhase(s.chatDrawer.flowId, s.chatDrawer.agentId)(s)
  })

  const isActiveAgent = useFlowStore((s) => {
    if (!s.chatDrawer) return false
    const fs = s.flowRunStates[s.chatDrawer.flowId]
    return fs?.sessions[fs.sessions.length - 1]?.agentId === s.chatDrawer.agentId
  })

  const inputState = agentChatInputState(agentPhase)
  const onSend = useCallback(
    async (content: UserMessageType['message']['content']): Promise<boolean> => {
      if (!chatDrawer) return false
      const { flowId, agentId } = chatDrawer

      // disabled / loading 状态不允许发送
      if (inputState === 'disabled' || inputState === 'loading') return false

      // result/interrputed 且仍是当前活跃 agent → 同会话追问，不重启 flow
      if (isActiveAgent && (agentPhase === 'result' || agentPhase === 'interrupted')) {
        sendUserMessage(flowId, content)
        return true
      }

      // ready (idle / 非活跃 agent 的 result) 或 confirm-required → 启动 flow
      // useStartFlow 内部会根据 FlowPhase !== idle 弹窗确认
      return startFlow(flowId, agentId, {
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
      })
    },
    [chatDrawer, inputState, agentPhase, isActiveAgent, startFlow, sendUserMessage],
  )

  return (
    <Drawer
      open={!!chatDrawer}
      placement='right'
      mask={false}
      closable={false}
      defaultSize={700}
      resizable
      forceRender
      styles={{
        body: { padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
      }}
      onClose={() => {
        closeChatDrawer()
      }}
    >
      <div className='flex flex-1 flex-col overflow-hidden bg-[#1e1e2e]'>
        {chatDrawer ? (
          <ChatPanel
            flowId={chatDrawer.flowId}
            agentId={chatDrawer.agentId}
            agentName={chatDrawer.agentName}
            onClose={closeChatDrawer}
          />
        ) : null}
        <ChatInput
          onSend={onSend}
          status={inputState}
          onCancel={() => {
            if (chatDrawer) {
              interruptAgent(chatDrawer.flowId)
            }
          }}
        />
      </div>
    </Drawer>
  )
}
