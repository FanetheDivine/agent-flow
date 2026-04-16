import { produce } from 'immer'
import { match, P } from 'ts-pattern'
import { create } from 'zustand'
import type { Flow, ExtensionToWebviewMessage } from '@/common'
import { postMessageToExtension, subscribeExtensionMessage } from '../utils/ExtensionMessage'

export type FlowRunState = {
  runKey: string
  status: 'preparing' | 'chatting' | 'waiting-user' | 'completed' | 'error'
  messages: ExtensionToWebviewMessage[]
  runId?: string
  currentSessionId?: string
  currentAgentName?: string
}

export type FlowState = {
  loading: boolean
  flows: Flow[]
  activeFlowId?: string
  /** flow的state flow->messages */
  flowStates: Record<string, FlowRunState>
}

type FlowStoreType = FlowState & {
  /** 初始化：请求 flows 并订阅 extension 消息，返回 cleanup 函数 */
  init: () => () => void
  setActiveFlowId: (id: string) => void
  runFlow: (flowId: string, agentName: string) => void
  saveFlows: (updateFn: (val: Flow[]) => void) => void
}
export const useFlowStore = create<FlowStoreType>((set, get) => {
  const immerSet = (updateFn: (draft: FlowStoreType) => void) => {
    set(produce(updateFn))
  }
  return {
    loading: true,
    flows: [],
    activeFlowId: undefined,
    flowStates: {},

    init: () => {
      postMessageToExtension({ type: 'requestFlows', data: undefined })
      const onMessage = (msg: ExtensionToWebviewMessage) => {
        immerSet((draft) => {
          if (msg.type === 'error') {
            console.error(msg)
            return
          }
          if (msg.type === 'loadFlows') {
            const { data } = msg
            draft.loading = false
            draft.flows = data.flows
            draft.activeFlowId = data.flows[0]?.id
            return
          }
          const runId = msg.data.runId
          const flowId = msg.data.flowId
          const fs = draft.flowStates[flowId]
          if (!fs) return
          fs.messages.push(msg)
          if (msg.type === 'flow.signal.flowStart') {
            if (fs.runKey !== msg.data.runKey) return
            fs.runId = runId
            fs.status = 'waiting-user'
            fs.currentSessionId = msg.data.sessionId
            fs.currentAgentName = msg.data.agentName
            return
          }
          if (fs.runId !== runId) return
          match(msg)
            .with({ type: 'flow.signal.userMessage' }, () => {})
            .with({ type: 'flow.signal.aiMessage' }, ({ data }) => {
              const { message } = data
              switch (message.type) {
                case 'result': {
                  fs.status = 'waiting-user'
                  break
                }
                default: {
                  fs.status = 'chatting'
                }
              }
            })
            .with({ type: 'flow.signal.agentComplete' }, ({ data }) => {
              if (data.output) {
                fs.currentSessionId = data.output.newSessionId
              } else {
                fs.status = 'completed'
                fs.currentAgentName = undefined
              }
            })
            .with({ type: 'flow.signal.agentInterrupted' }, () => {
              fs.status = 'waiting-user'
            })
            .with({ type: 'flow.signal.agentError' }, () => {
              fs.status = 'error'
            })
            .with({ type: 'flow.signal.error' }, () => {
              fs.status = 'error'
            })
            .exhaustive()
        })
      }

      return subscribeExtensionMessage(onMessage)
    },
    runFlow: (flowId, agentName) => {
      const { flows } = get()
      const flow = flows.find((f) => f.id === flowId)
      if (!flow) return
      const entryAgent = flow.agents?.find((a) => a.agent_name === agentName && a.is_entry)
      if (!entryAgent) return
      const runKey = crypto.randomUUID()
      immerSet((draft) => {
        draft.flowStates[flowId] = {
          runKey,
          status: 'preparing',
          messages: [],
        }
      })
      postMessageToExtension({
        type: 'flow.command.flowStart',
        data: { flowId, runKey, agentName },
      })
    },
    setActiveFlowId: (id) => {
      immerSet((draft) => {
        draft.activeFlowId = id
      })
    },
    saveFlows: (updateFn) => {
      immerSet((draft) => {
        updateFn(draft.flows)
      })
      postMessageToExtension({ type: 'saveFlows', data: get().flows })
    },
  }
})
